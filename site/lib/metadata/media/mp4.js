// MP4, MOV, M4A and 3GP: ISO base media and QuickTime atoms.
import { Bytes, utf8, latin1, fmtBytes, printable, bytesValue, hexPreview, clean } from '../bytes.js';
import { parseXmp } from '../xmp.js';
import { parseJumbf } from '../c2pa.js';
import { parseId3v2, GENRES } from './id3.js';
import { buildTree, kid, kids, handlerOf, sampleEntry, isTimedMetadata, sampleRanges, timeFields, XMP_UUID, C2PA_UUID, STRUCTURAL_UUIDS, TOP_STRUCTURAL } from './isom.js';
import { text, text16, tag, groupOf, macDate, duration, iso6709, addLocation } from './common.js';

// [label, highlight group] for QuickTime user data and iTunes item atoms.
const ATOMS = {
  '©nam': ['Title', 'Description'], '©ART': ['Artist', 'People'], aART: ['Album artist', 'People'], '©alb': ['Album', 'Description'], '©day': ['Date', 'Dates'],
  '©gen': ['Genre'], gnre: ['Genre'], '©wrt': ['Composer', 'People'], '©com': ['Composer', 'People'], '©too': ['Encoder', 'Software'], '©swr': ['Software', 'Software'],
  '©enc': ['Encoded by', 'People'], '©cmt': ['Comment', 'Comments'], '©des': ['Description', 'Description'], '©inf': ['Information', 'Description'], '©lyr': ['Lyrics', 'Comments'],
  '©grp': ['Grouping'], '©mak': ['Make', 'Camera'], '©mod': ['Model', 'Camera'], '©aut': ['Author', 'People'], '©dir': ['Director', 'People'], '©prd': ['Producer', 'People'],
  '©cpy': ['Copyright', 'People'], '©hst': ['Host computer', 'Camera'], '©src': ['Source credits', 'People'], '©prf': ['Performers', 'People'], '©ope': ['Original artist', 'People'],
  '©key': ['Keywords', 'Description'], '©url': ['URL'], '©req': ['Requirements'], '©fmt': ['Format'], '©dis': ['Disclaimer'], '©wrn': ['Warning'], '©PRD': ['Product'], '©snm': ['Subtitle'],
  '©mal': ['Make and model', 'Camera'], '©edl': ['Edit date', 'Dates'], '©st3': ['Subtitle'], '©xpd': ['Executive producer', 'People'], '©phg': ['Recording copyright', 'People'],
  cprt: ['Copyright', 'People'], desc: ['Description', 'Description'], ldes: ['Long description', 'Description'], sdes: ['Store description'], apID: ['Purchase account', 'People'],
  ownr: ['Owner', 'People'], purd: ['Purchase date', 'Dates'], rldt: ['Release date', 'Dates'], cnID: ['Store catalog ID'], atID: ['Store artist ID'], plID: ['Store playlist ID'],
  geID: ['Store genre ID'], sfID: ['Store country'], akID: ['Store account type'], cmID: ['Store composer ID'], 'xid ': ['Vendor ID'], stik: ['Media kind'], trkn: ['Track'],
  disk: ['Disc'], tmpo: ['Tempo'], cpil: ['Compilation'], tvsh: ['TV show'], tven: ['TV episode ID'], tves: ['TV episode'], tvsn: ['TV season'], tvnn: ['TV network'], purl: ['Podcast URL'],
  egid: ['Episode ID'], catg: ['Category'], keyw: ['Keywords', 'Description'], pcst: ['Podcast'], hdvd: ['HD video'], rtng: ['Rating'], pgap: ['Gapless playback'], soal: ['Album sort'],
  soar: ['Artist sort'], sonm: ['Title sort'], soaa: ['Album artist sort'], soco: ['Composer sort'], sosn: ['Show sort'], covr: ['Cover art'], '©xyz': ['Location', 'Location'],
};
// 3GPP user data: full box, language, string.
const GPP = { auth: ['Author', 'People'], perf: ['Performer', 'People'], titl: ['Title', 'Description'], dscp: ['Description', 'Description'], cprt: ['Copyright', 'People'], gnre: ['Genre'], albm: ['Album', 'Description'], kywd: ['Keywords', 'Description'], rtng: ['Rating'], clsf: ['Classification'] };
const HANDLERS = { vide: 'Video', soun: 'Audio', meta: 'Timed metadata', text: 'Text', sbtl: 'Subtitles', subt: 'Subtitles', clcp: 'Closed captions', tmcd: 'Timecode', hint: 'Hint', camm: 'Camera motion', sdsm: 'Scene description', odsm: 'Object descriptors' };

export function mp4Format(b, top) {
  const ftyp = top.find((x) => x.type === 'ftyp');
  const major = ftyp && ftyp.end - ftyp.start >= 4 ? b.ascii(ftyp.start, 4) : '';
  if (!ftyp || major === 'qt  ') return 'MOV';
  if (/^(M4A |M4B |M4P |F4A |F4B )$/.test(major)) return 'M4A';
  if (/^3g/.test(major)) return '3GP';
  return 'MP4';
}

export function parseMp4(b, r, ctx) {
  const tree = buildTree(b);
  const top = tree.boxes;
  if (tree.truncated) r.warn('Too many boxes. Inspection stopped early.');
  r.format = mp4Format(b, top);
  const ftyp = top.find((x) => x.type === 'ftyp');
  if (ftyp && ftyp.end - ftyp.start >= 8) {
    r.field('Container', 'Major brand', printable(b.ascii(ftyp.start, 4)));
    const brands = []; for (let o = ftyp.start + 8; o + 4 <= ftyp.end && brands.length < 32; o += 4) brands.push(printable(b.ascii(o, 4)));
    r.field('Container', 'Compatible brands', brands.filter(Boolean).join(', '));
  }
  const moov = top.find((x) => x.type === 'moov');
  Object.assign(ctx, { fragmented: top.some((x) => x.type === 'moof') || !!kid(moov, 'mvex'), times: [], timeBox: null, video: false, audio: false, track: 0 });
  if (ctx.fragmented) r.field('Container', 'Layout', 'Fragmented');
  for (const box of top) {
    r.struct(box.uuid ? `uuid ${box.uuid.slice(0, 8)}` : printable(box.type) || 'box', box.offset, box.size, box.type === 'mdat' ? 'Media data' : '');
    if (box.type === 'moov') moovBox(b, box, r, ctx);
    else if (box.type === 'uuid') uuidBox(b, box, r, 'File');
    else if (box.type === 'meta') metaBox(b, box, r, ctx, 'File');
    else if (box.type === 'udta') udtaBox(b, box, r, ctx, 'File', 'QuickTime user data');
    else if (box.type === 'free' || box.type === 'skip') padding(b, box, r);
    else if (!TOP_STRUCTURAL.has(box.type)) {
      r.block('Unknown box', box.offset, box.size, { container: printable(box.type) || 'box', decoded: false, note: box.type === 'sefd' ? 'Samsung trailer' : '' });
      r.field('Other boxes', printable(box.type) || hexPreview(b.slice(box.offset + 4, 4)), `${fmtBytes(box.size)}, not decoded`);
    }
  }
  if (!top.length) r.warn('The file has no readable boxes.');
  if (!moov && !ctx.fragmented && top.length) r.warn('The file has no movie header (moov box). It may be truncated or still being recorded.');
  if (ctx.times.length) r.block('Dates', ctx.timeBox.offset, ctx.timeBox.size, { container: 'mvhd, tkhd, mdhd', note: 'Creation and modification times' });
  if (moov && !ctx.fragmented) unreferenced(b, top, moov, r);
  r.category = ctx.video ? 'Video' : ctx.audio || r.format === 'M4A' ? 'Audio' : 'Video';
  if (tree.stop < b.length) {
    const rest = b.length - tree.stop;
    const size = rest >= 8 ? b.u32(tree.stop) : 0; const type = rest >= 8 ? b.ascii(tree.stop + 4, 4) : '';
    if ((TOP_STRUCTURAL.has(type) || /^(uuid|meta|udta)$/.test(type)) && (size > rest || (size === 1 && rest >= 16 && b.u64(tree.stop + 8) > rest))) r.warn(`The ${printable(type)} box runs past the end of the file. The file is truncated.`);
    else if (find(b.u8, tree.stop, ['mdat', 'moof', 'moov'])) r.warn('Media boxes follow data that cannot be read as boxes. The file is damaged.');
    else {
      const samsung = rest >= 8 && b.ascii(b.length - 4, 4) === 'SEFT';
      r.struct('Trailing data', tree.stop, rest, samsung ? 'Samsung SEF trailer' : '');
      r.block('Trailer', tree.stop, rest, { decoded: false, note: samsung ? 'Samsung SEF trailer' : 'Data after the last box' });
      r.field('File', 'Data after the last box', `${fmtBytes(rest)}${samsung ? ' (Samsung SEF trailer)' : ''}`, { flag: 'privacy' });
      r.signal('privacy', 'Hidden data after the media', `${fmtBytes(rest)} follow the last box. Players do not show it.`, 'MP4 trailer', 'hidden data after the media');
    }
  }
}

// Whether any of the four-character codes appears after `from`.
export function find(u8, from, codes) {
  const firsts = new Set(codes.map((c) => c.charCodeAt(0)));
  for (let i = from; i + 4 <= u8.length; i++) if (firsts.has(u8[i]) && codes.some((c) => u8[i + 1] === c.charCodeAt(1) && u8[i + 2] === c.charCodeAt(2) && u8[i + 3] === c.charCodeAt(3))) return true;
  return false;
}

// Media data that no track's sample table points at is never played: leftovers, or the samples of a track
// whose tables were damaged. Non-zero stretches are reported so the cleaner zeroes them. Skipped when a
// track's samples cannot be located, since its data would look unused.
function unreferenced(b, top, moov, r) {
  const mdats = top.filter((x) => x.type === 'mdat');
  if (!mdats.length) return;
  const ranges = [];
  for (const trak of kids(moov, 'trak')) {
    const list = sampleRanges(b, trak);
    const stsz = kid(kid(kid(kid(trak, 'mdia'), 'minf'), 'stbl'), 'stsz');
    if (!list.length && (!stsz || !b.has(stsz.start, 12) || b.u32(stsz.start + 8) > 0)) return;
    ranges.push(...list);
  }
  ranges.sort((a, c) => a[0] - c[0]);
  let n = 0;
  for (const m of mdats) {
    let at = m.start; const gaps = [];
    for (const [s, e] of ranges) { if (e <= m.start || s >= m.end) continue; if (s > at) gaps.push([at, s]); at = Math.max(at, e); }
    if (at < m.end) gaps.push([at, m.end]);
    for (const [s, e] of gaps) {
      if (!b.u8.subarray(s, Math.min(e, b.length)).some((x) => x)) continue;
      if (++n > 256) { r.warn('Too many unused stretches in the media data. Inspection stopped early.'); return; }
      r.block('Unreferenced data', s, Math.min(e, b.length) - s, { container: 'mdat', decoded: false, note: 'Media data no track uses' });
    }
  }
}

function padding(b, box, r) {
  const u8 = b.u8.subarray(box.start, box.end);
  if (u8.every((x) => x === 0)) return;
  r.block('Padding', box.offset, box.size, { container: box.type, decoded: false, note: 'Unused space holding leftover data' });
  r.field('File', `Leftover data in ${box.type} box`, bytesValue(u8.subarray(0, 64)).slice(0, 200));
}

function moovBox(b, moov, r, ctx) {
  const mvhd = kid(moov, 'mvhd');
  if (mvhd && b.has(mvhd.start, 32)) {
    const v1 = b.u8at(mvhd.start) === 1; const o = mvhd.start + 4 + (v1 ? 16 : 8);
    const scale = b.u32(o); const dur = v1 ? b.u64(o + 4) : b.u32(o + 4);
    if (scale) r.field('Container', 'Duration', duration(dur / scale));
    times(b, mvhd, r, ctx, 'Movie');
  }
  for (const c of moov.children ?? []) {
    if (c.type === 'trak') trakBox(b, c, r, ctx);
    else if (c.type === 'udta') udtaBox(b, c, r, ctx, 'Movie', 'QuickTime user data');
    else if (c.type === 'meta') metaBox(b, c, r, ctx, 'Movie');
    else if (c.type === 'uuid') uuidBox(b, c, r, 'Movie');
    else if (c.type === 'free' || c.type === 'skip') padding(b, c, r);
  }
}

function times(b, box, r, ctx, who) {
  const list = timeFields(b, box);
  if (!list.length) return;
  if (!ctx.timeBox) ctx.timeBox = box;
  ctx.times.push(...list);
  const v1 = b.u8at(box.start) === 1; const read = (o) => (v1 ? b.u64(o) : b.u32(o));
  const created = read(box.start + 4); const modified = read(box.start + (v1 ? 12 : 8));
  const top = who === 'Movie';
  if (created) tag(r, 'QuickTime headers', `${who} created`, macDate(created), top ? 'Dates' : null, 'Created');
  if (modified) tag(r, 'QuickTime headers', `${who} modified`, macDate(modified), top ? 'Dates' : null, 'Modified');
}

function trakBox(b, trak, r, ctx) {
  const n = ++ctx.track; const who = `Track ${n}`;
  const handler = handlerOf(b, trak); const entry = sampleEntry(b, trak);
  const tkhd = kid(trak, 'tkhd'); const mdia = kid(trak, 'mdia'); const mdhd = kid(mdia, 'mdhd'); const hdlr = kid(mdia, 'hdlr');
  const desc = [HANDLERS[handler] ?? printable(handler), entry && printable(entry.format)];
  if (handler === 'vide' && entry && b.has(entry.start + 28, 4)) {
    let w = b.u16(entry.start + 24); let h = b.u16(entry.start + 26);
    if (tkhd && tkhd.size >= 92) { const tw = b.u32(tkhd.end - 8) >>> 16; const th = b.u32(tkhd.end - 4) >>> 16; if (tw && th) { w = tw; h = th; } }
    desc.push(`${w} × ${h}`);
    if (b.has(entry.start + 42, 32) && b.u8at(entry.start + 42) <= 31) { const name = text(b.slice(entry.start + 43, b.u8at(entry.start + 42))); if (name) r.field('Container', `${who} compressor`, name); }
    if (!ctx.video) { r.width = w; r.height = h; }
    ctx.video = true;
  }
  if (handler === 'soun') {
    ctx.audio = true;
    if (entry && b.has(entry.start + 24, 4)) desc.push(`${b.u16(entry.start + 16)} ch`, `${b.u16(entry.start + 24)} Hz`);
  }
  if (mdhd && b.has(mdhd.start, 24)) {
    const v1 = b.u8at(mdhd.start) === 1; const lang = b.u16(mdhd.start + 4 + (v1 ? 28 : 16)) & 0x7fff;
    const code = lang ? String.fromCharCode(((lang >> 10) & 31) + 0x60, ((lang >> 5) & 31) + 0x60, (lang & 31) + 0x60) : '';
    if (/^[a-z]{3}$/.test(code) && code !== 'und') desc.push(code);
    times(b, mdhd, r, ctx, `${who} media`);
  }
  if (tkhd) times(b, tkhd, r, ctx, who);
  r.field('Container', who, desc.filter(Boolean).join(' · '));
  if (hdlr && b.has(hdlr.start + 24, 1)) {
    const raw = b.slice(hdlr.start + 24, hdlr.end - hdlr.start - 24);
    const name = raw.length && raw[0] === raw.length - 1 ? text(raw.subarray(1)) : text(raw);
    if (name) r.field('Container', `${who} handler name`, name);
  }
  let id = -1;
  if (isTimedMetadata(b, trak)) {
    const keys = entry ? mebxKeys(b, entry) : [];
    id = r.block('Metadata track', trak.offset, trak.size, { container: `trak ${n} (${printable(entry?.format ?? handler)})`, note: keys.length ? keys.slice(0, 8).join(', ') : HANDLERS[handler] ?? '', ...(ctx.fragmented ? { removable: false } : {}) });
    r.field('Timed metadata', who, `${printable(entry?.format ?? handler)} samples${keys.length ? `: ${keys.join(', ')}` : ''}`);
    if (keys.some((k) => /location|gps/i.test(k)) || entry?.format === 'camm') r.signal('privacy', 'Location recorded over time', `${who} is a timed metadata track that can record where the video was filmed as it moves.`, `MP4 ${who}`, 'a location track');
    if (keys.some((k) => /face/i.test(k))) r.field('Timed metadata', `${who} faces`, 'Detected face regions are recorded', { flag: 'privacy' });
    if (entry?.format === 'gpmd') r.within(id, () => { const first = sampleRanges(b, trak)[0]; if (first && b.has(first[0], first[1] - first[0])) gpmf(b, first[0], first[1], r, 'GoPro telemetry', { n: 0 }, 0); });
  }
  r.within(id, () => {
    for (const c of trak.children ?? []) {
      if (c.type === 'udta') udtaBox(b, c, r, ctx, who, `${who} user data`);
      else if (c.type === 'meta') metaBox(b, c, r, ctx, who);
      else if (c.type === 'uuid') uuidBox(b, c, r, who);
    }
    const dref = kid(kid(kid(mdia, 'minf'), 'dinf'), 'dref');
    for (const e of dref?.children ?? []) {
      if (e.end - e.start <= 4) continue;
      const self = b.u24(e.start + 1) & 1; const data = b.slice(e.start + 4, e.end - e.start - 4);
      const runs = (latin1(data).match(/[\x20-\x7e]{3,}/g) ?? []).slice(0, 8).join(' · ');
      r.field('Data references', `${who} ${printable(e.type)}`, `${runs || fmtBytes(data.length)}${self ? '' : ' (media stored in another file)'}`, { flag: 'privacy' });
      if (self) r.block('Data reference', e.start + 4, e.end - e.start - 4, { container: `dref ${printable(e.type)}`, note: 'Original file reference' });
    }
  });
}

// Apple timed metadata sample entries list the keys their samples carry.
function mebxKeys(b, entry) {
  const out = [];
  const keys = [...readChildren(b, entry.start + 8, entry.end)].find((c) => c.type === 'keys');
  if (!keys) return out;
  for (const k of readChildren(b, keys.start, keys.end)) {
    for (const d of readChildren(b, k.start, k.end)) if (d.type === 'keyd' && d.end - d.start > 4) out.push(text(b.slice(d.start + 4, d.end - d.start - 4)).replace(/^com\.apple\.quicktime\./, ''));
    if (out.length >= 64) break;
  }
  return out;
}

function* readChildren(b, start, end) {
  let o = start;
  for (let i = 0; o + 8 <= end && i < 1000; i++) { const size = b.u32(o); if (size < 8 || o + size > end) return; yield { type: b.ascii(o + 4, 4), offset: o, start: o + 8, end: o + size }; o += size; }
}

function uuidBox(b, box, r, where) {
  if (STRUCTURAL_UUIDS.has(box.uuid)) return;
  if (box.uuid === XMP_UUID) { r.block('XMP', box.offset, box.size, { container: `${where} uuid XMP` }); parseXmp(utf8.decode(b.slice(box.start, box.end - box.start)), r); return; }
  if (box.uuid === C2PA_UUID) {
    r.block('C2PA', box.offset, box.size, { container: `${where} uuid C2PA` });
    let o = box.start + 4; const s = b.slice(o, box.end - o); const z = s.indexOf(0); const purpose = latin1(s.subarray(0, z < 0 ? 0 : z)); o += z + 1;
    if (purpose === 'manifest') o += 8;
    if (z >= 0 && (purpose === 'manifest' || purpose === 'original')) parseJumbf(new Bytes(b.slice(o, box.end - o)), r, { record: false });
    return;
  }
  const preview = (latin1(b.slice(box.start, Math.min(4096, box.end - box.start))).match(/[\x20-\x7e]{4,}/g) ?? []).slice(0, 6).join(' · ');
  r.block('Vendor data', box.offset, box.size, { container: `${where} uuid ${box.uuid}`, decoded: false });
  r.field('Vendor boxes', `uuid ${box.uuid}`, `${fmtBytes(box.size)}${preview ? `: ${preview}` : ''}`);
}

function metaBox(b, meta, r, ctx, where) {
  const handler = handlerOf(b, meta);
  const pict = handler === 'pict';
  const id = r.block('Metadata', meta.offset, meta.size, { container: `${where} meta${handler ? ` (${printable(handler)})` : ''}`, ...(pict ? { removable: false } : {}) });
  if (pict) { r.field('Container', `${where} image items`, `${fmtBytes(meta.size)}, not decoded`); return; }
  r.within(id, () => {
    const keysBox = kid(meta, 'keys'); const keys = [];
    if (keysBox && b.has(keysBox.start, 8)) {
      let o = keysBox.start + 8; const count = Math.min(b.u32(keysBox.start + 4), 4096);
      for (let i = 0; i < count && o + 8 <= keysBox.end; i++) { const size = b.u32(o); if (size < 8 || o + size > keysBox.end) break; keys.push(text(b.slice(o + 8, size - 8))); o += size; }
    }
    for (const c of meta.children ?? []) {
      if (c.type === 'ilst') ilst(b, c, r, ctx, keys, where === 'Movie' && keys.length ? 'QuickTime keys' : 'iTunes metadata');
      else if (c.type === 'ID32' && c.end - c.start > 6) parseId3v2(new Bytes(b.slice(c.start + 6, c.end - c.start - 6)), 0, r, ctx, { record: false });
      else if (c.type === 'xml ') parseXmp(utf8.decode(b.slice(c.start + 4, c.end - c.start - 4)), r);
      else if (!['hdlr', 'keys', 'free', 'skip'].includes(c.type)) r.field('Other boxes', `meta ${printable(c.type)}`, `${fmtBytes(c.size)}, not decoded`);
    }
  });
}

function ilst(b, box, r, ctx, keys, source) {
  for (const item of box.children ?? []) {
    let name = item.type;
    const index = b.u32(item.offset + 4);
    if (keys.length && index >= 1 && index <= keys.length) name = keys[index - 1];
    if (name === '----') {
      const mean = kid(item, 'mean'); const nm = kid(item, 'name');
      name = nm ? text(b.slice(nm.start + 4, nm.end - nm.start - 4)) : 'freeform';
      if (mean) name = `${text(b.slice(mean.start + 4, mean.end - mean.start - 4)).replace(/^com\.apple\.iTunes$/, 'iTunes')}:${name}`;
    }
    for (const data of kids(item, 'data').slice(0, 16)) {
      if (data.end - data.start < 8) continue;
      const type = b.u32(data.start) & 0xffffff; const p = b.slice(data.start + 8, data.end - data.start - 8);
      if (name === 'covr' || type === 13 || type === 14 || type === 27) {
        r.block('Cover art', data.start + 8, p.length, { container: `${source} ${printable(name) || 'covr'}`, note: { 13: 'image/jpeg', 14: 'image/png', 27: 'image/bmp' }[type] ?? '' });
        ctx.covers.push([p, 'Cover art']);
        continue;
      }
      item_(r, source, name, dataValue(p, type, name));
    }
  }
}

function dataValue(p, type, name) {
  const v = new Bytes(p);
  const int = (signed) => { if (![1, 2, 3, 4, 8].includes(p.length)) return hexPreview(p); let n = 0; for (const x of p) n = n * 256 + x; if (signed && p[0] & 0x80) n -= 2 ** (8 * p.length); return String(n); };
  switch (type) {
    case 1: case 4: return text(p);
    case 2: case 5: return text16(p);
    case 21: return int(true);
    case 22: return int(false);
    case 23: return p.length === 4 ? String(Math.round(v.f32(0) * 1e6) / 1e6) : hexPreview(p);
    case 24: return p.length === 8 ? String(v.f64(0)) : hexPreview(p);
    case 0:
      if ((name === 'trkn' || name === 'disk') && p.length >= 6) return `${v.u16(2)}${v.u16(4) ? ` of ${v.u16(4)}` : ''}`;
      if (name === 'gnre' && p.length >= 2) return GENRES[v.u16(0) - 1] ?? String(v.u16(0));
      if (p.length <= 8 && p.length) return int(false);
      return bytesValue(p);
    default: return bytesValue(p);
  }
}

// One metadata item from udta, ilst or Apple keys.
function item_(r, source, name, value) {
  if (!value) return;
  const key = String(name);
  if (key === '©xyz' || /location\.ISO6709$/i.test(key)) {
    tag(r, source, key === '©xyz' ? 'Location' : key.replace(/^com\.apple\.quicktime\./, ''), value);
    const p = iso6709(value); if (p) addLocation(r, p.lat, p.lon, p.alt, `${source} ${key}`);
    return;
  }
  const atom = ATOMS[key];
  if (atom) {
    tag(r, source, atom[0], value, atom[1] ?? null);
    if (key === 'apID') r.signal('privacy', 'Purchase account stored', `The store account that bought this file (${value}) is stored in it.`, `${source} apID`, 'a purchase account');
    return;
  }
  const label = key.replace(/^com\.apple\.quicktime\./, '').replace(/^com\.android\./, 'android.');
  const group = /location/i.test(key) ? 'Location' : groupOf(key);
  tag(r, source, label, value, group);
}

function udtaBox(b, udta, r, ctx, where, source) {
  const id = r.block('User data', udta.offset, udta.size, { container: `${where} udta` });
  r.within(id, () => {
    for (const c of udta.children ?? []) {
      try { udtaAtom(b, c, r, ctx, source); } catch { r.field(source, printable(c.type), `${fmtBytes(c.size)}, could not be decoded`); }
    }
  });
}

function udtaAtom(b, c, r, ctx, source) {
  const t = c.type; const payload = b.slice(c.start, c.end - c.start);
  if (t === 'meta') return metaBox(b, c, r, ctx, source.replace(/ user data$/, '').replace('QuickTime', 'Movie'));
  if (t === 'XMP_') return parseXmp(utf8.decode(payload), r);
  if (t.charCodeAt(0) === 0xa9) {
    // QuickTime text atoms: entries of 16-bit length, 16-bit language, text. iTunes style uses data boxes.
    if (payload.length >= 16 && latin1(payload.subarray(4, 8)) === 'data') { const p = payload.subarray(16); return item_(r, source, t, dataValue(p, new Bytes(payload).u32(8) & 0xffffff, t)); }
    const v = new Bytes(payload); const values = []; let o = 0;
    while (o + 4 <= payload.length && values.length < 16) { const len = v.u16(o); if (!len || o + 4 + len > payload.length) break; values.push(text(payload.subarray(o + 4, o + 4 + len))); o += 4 + len; }
    return item_(r, source, t, (values.length ? values : [text(payload)]).filter(Boolean).join('; '));
  }
  if (t === 'loci' && payload.length > 6) {
    const v = new Bytes(payload); let o = 6; const name = str3gpp(payload, o); o = name.next;
    const lon = v.i32(o + 1) / 65536; const lat = v.i32(o + 5) / 65536; const alt = v.i32(o + 9) / 65536;
    tag(r, source, 'Location name', name.text, 'Location');
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) { r.field(source, 'Location', `${lat.toFixed(5)}, ${lon.toFixed(5)}, ${Math.round(alt * 10) / 10} m`, { flag: 'privacy' }); addLocation(r, lat, lon, alt, `${source} loci`); }
    const body = str3gpp(payload, o + 13); const notes = str3gpp(payload, body.next);
    if (body.text && body.text !== 'earth') r.field(source, 'Astronomical body', body.text);
    tag(r, source, 'Location notes', notes.text, 'Location');
    return;
  }
  if (t === 'yrrc' && payload.length >= 6) return tag(r, source, 'Recording year', String(new Bytes(payload).u16(4)), 'Dates');
  if (GPP[t] && payload.length > 6) {
    const skip = t === 'rtng' || t === 'clsf' ? (t === 'rtng' ? 14 : 12) : 6;
    if (t === 'kywd') { const words = []; let o = 7; for (let i = 0; i < payload[6] && o < payload.length; i++) { const n = payload[o]; words.push(text16or8(payload.subarray(o + 1, o + 1 + n))); o += 1 + n; } return tag(r, source, 'Keywords', words.join('; '), 'Description'); }
    return tag(r, source, GPP[t][0], str3gpp(payload, skip).text, GPP[t][1] ?? null);
  }
  if (t === 'name') return tag(r, source, 'Track name', text(payload), 'Description');
  if (t === 'chpl' && payload.length > 9) {
    const v = new Bytes(payload); const count = payload[8]; let o = 9; const titles = [];
    for (let i = 0; i < count && o + 9 <= payload.length; i++) { const n = payload[o + 8]; titles.push(text(payload.subarray(o + 9, o + 9 + n))); o += 9 + n; }
    if (v.u8at(0) === 0 && !titles.length) return;
    return r.field(source, 'Chapters', titles.join('; '));
  }
  if (t === 'GPMF') return gpmf(b, c.start, c.end, r, 'GoPro device data', { n: 0 }, 0);
  if (t === 'Xtra') return xtra(payload, r, source);
  if (t === 'hnti' || t === 'hinf') return r.field('Container', `Streaming hint ${t}`, fmtBytes(c.size));
  const shown = bytesValue(payload.subarray(0, 512));
  r.field(source, printable(t) || hexPreview(b.slice(c.offset + 4, 4)), /^[0-9a-f ]+( …|$)/.test(shown) ? `${fmtBytes(payload.length)}, not decoded` : shown);
  if (t === 'smta') r.field(source, 'Samsung metadata', fmtBytes(payload.length));
}

const text16or8 = (u8) => (u8[0] === 0xfe && u8[1] === 0xff ? text16(u8) : text(u8));
function str3gpp(u8, o) {
  if (u8[o] === 0xfe && u8[o + 1] === 0xff) { let i = o + 2; while (i + 1 < u8.length && (u8[i] || u8[i + 1])) i += 2; return { text: text16(u8.subarray(o, i)), next: i + 2 }; }
  let i = u8.indexOf(0, o); if (i < 0) i = u8.length;
  return { text: text(u8.subarray(o, i)), next: i + 1 };
}

// Windows Media attributes (WM/EncodingTime, WM/Publisher…).
function xtra(u8, r, source) {
  const v = new Bytes(u8); let o = 0;
  for (let i = 0; o + 8 <= u8.length && i < 64; i++) {
    const size = v.u32(o); const nameLen = v.u32(o + 4);
    if (size < 8 || o + size > u8.length || 8 + nameLen + 2 > size) break;
    const name = latin1(u8.subarray(o + 8, o + 8 + nameLen)); let p = o + 8 + nameLen; const count = v.u16(p); p += 2; const values = [];
    for (let k = 0; k < count && p + 6 <= o + size; k++) {
      const len = v.u32(p); const type = v.u16(p + 4); const d = u8.subarray(p + 6, p + len);
      if (len < 6 || p + len > o + size) break;
      values.push(type === 8 ? text16(d, true) : type === 21 && d.length === 8 ? macDateFromFiletime(new Bytes(d)) : type === 19 && d.length === 8 ? String(new Bytes(d).u64(0, true)) : bytesValue(d));
      p += len;
    }
    tag(r, source, name, values.join('; '), groupOf(name.replace(/^WM\//, '')));
    o += size;
  }
}
const macDateFromFiletime = (v) => { const t = v.u64(0, true) / 1e4 - 11644473600000; return Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : ''; };

// GoPro GPMF key-length-value data: device names, serial numbers and the first GPS fix.
const GPMF_KEYS = { DVNM: ['Device name', 'Camera'], MINF: ['Model', 'Camera'], CASN: ['Serial number', 'Camera'], FIRM: ['Firmware', 'Software'], LINF: ['Lens', 'Camera'], CINF: ['Camera ID', 'Camera'], MUID: ['Media ID'], STNM: ['Stream'], GPSU: ['GPS time', 'Dates'] };
function gpmf(b, start, end, r, source, state, depth) {
  let o = start;
  while (o + 8 <= end && state.n++ < 5000 && depth < 8) {
    const key = b.ascii(o, 4); const type = b.u8at(o + 4); const size = b.u8at(o + 5); const repeat = b.u16(o + 6);
    const len = size * repeat; const body = o + 8; const next = body + ((len + 3) & ~3);
    if (!/^[A-Z0-9 ]{4}$/.test(key) || body + len > end) break;
    if (type === 0) gpmf(b, body, body + len, r, source, state, depth + 1);
    else {
      const chars = type === 0x63 || type === 0x55;
      const width = { 98: 1, 66: 1, 115: 2, 83: 2, 108: 4, 76: 4, 102: 4, 100: 8, 106: 8, 74: 8 }[type] ?? 0;
      const read = (k) => { const at = body + k * width; return { 98: () => b.i8(at), 66: () => b.u8at(at), 115: () => b.i16(at), 83: () => b.u16(at), 108: () => b.i32(at), 76: () => b.u32(at), 102: () => b.f32(at), 100: () => b.f64(at), 106: () => b.u64(at), 74: () => b.u64(at) }[type](); };
      if (key === 'SCAL' && width) state.scal = Array.from({ length: Math.min(len / width, 16) }, (_, k) => read(k));
      else if (key === 'GPS5' && width === 4 && !state.gps && len >= 12) {
        const s = (k) => state.scal?.[k] ?? state.scal?.[0] ?? 1;
        const lat = read(0) / s(0); const lon = read(1) / s(1); const alt = read(2) / s(2);
        if ((lat || lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { state.gps = true; addLocation(r, lat, lon, alt, `${source} GPS5`); }
      } else if (GPMF_KEYS[key]) {
        const value = chars ? clean(latin1(b.slice(body, len)).replace(/\0+/g, ' ')) : width ? Array.from({ length: Math.min(len / width, 8) }, (_, k) => read(k)).join(', ') : hexPreview(b.slice(body, len));
        tag(r, source, GPMF_KEYS[key][0], value, GPMF_KEYS[key][1] ?? null);
      }
    }
    o = next;
  }
}

