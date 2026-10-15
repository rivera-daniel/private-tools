// HEIC, HEIF, AVIF and Canon CR3: ISO base media file format boxes.
import { Bytes, utf8, concat, indexOfZero, fmtBytes, printable } from '../bytes.js';
import { parseTiff } from '../tiff.js';
import { parseXmp } from '../xmp.js';
import { parseIcc } from '../icc.js';
import { parseJumbf } from '../c2pa.js';

const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
const CANON_UUID = '85c0b687820f11e08111f4ce462b6a48';
export const AUX_TYPES = { 'urn:mpeg:hevc:2015:auxid:1': 'Alpha', 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha': 'Alpha', 'urn:mpeg:hevc:2015:auxid:2': 'Depth', 'urn:mpeg:mpegB:cicp:systems:auxiliary:depth': 'Depth', 'urn:com:apple:photo:2020:aux:hdrgainmap': 'HDR gain map (Apple)', 'urn:com:apple:photo:2018:aux:portraiteffectsmatte': 'Portrait matte (Apple)', 'urn:com:apple:photo:2019:aux:semanticskinmatte': 'Skin matte (Apple)', 'urn:com:apple:photo:2019:aux:semantichairmatte': 'Hair matte (Apple)', 'urn:com:apple:photo:2019:aux:semanticteethmatte': 'Teeth matte (Apple)', 'urn:com:apple:photo:2020:aux:semanticskymatte': 'Sky matte (Apple)' };

export function* boxes(b, start, end, depthGuard = { n: 0 }) {
  let o = start;
  while (o + 8 <= end) {
    if (++depthGuard.n > 20000) return;
    let size = b.u32(o); const type = b.ascii(o + 4, 4); let header = 8;
    if (size === 1) { if (!b.has(o + 8, 8)) return; size = b.u64(o + 8); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    let uuid = '';
    if (type === 'uuid') { if (size < header + 16) return; uuid = [...b.slice(o + header, 16)].map((x) => x.toString(16).padStart(2, '0')).join(''); header += 16; }
    yield { type, uuid, offset: o, size, start: o + header, end: o + size };
    o += size;
  }
}

const child = (b, box, type) => { for (const c of boxes(b, box.start, box.end)) if (c.type === type) return c; return null; };
const fullBox = (b, box) => ({ version: b.u8at(box.start), flags: b.u24(box.start + 1), body: box.start + 4 });
const cstr = (b, at, end) => { const s = b.slice(at, end - at); const z = indexOfZero(s); return { text: utf8.decode(z < 0 ? s : s.subarray(0, z)), next: at + (z < 0 ? s.length : z + 1) }; };

export async function parseIsobmff(b, r) {
  const top = [...boxes(b, 0, b.length)];
  const ftyp = top.find((x) => x.type === 'ftyp');
  let major = ''; let brands = [];
  if (ftyp && ftyp.end - ftyp.start >= 8) {
    major = b.ascii(ftyp.start, 4);
    for (let o = ftyp.start + 8; o + 4 <= ftyp.end && brands.length < 32; o += 4) brands.push(b.ascii(o, 4));
  }
  const all = [major, ...brands];
  r.format = major === 'crx ' ? 'CR3' : all.some((x) => ['avif', 'avis'].includes(x)) ? 'AVIF' : all.some((x) => ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx'].includes(x)) ? 'HEIC' : 'HEIF';
  r.field('Container', 'Major brand', printable(major));
  r.field('Container', 'Compatible brands', brands.map(printable).filter(Boolean).join(', '));
  for (const box of top) {
    r.struct(box.uuid ? `uuid ${box.uuid.slice(0, 8)}` : box.type, box.offset, box.size, box.type === 'mdat' ? 'Media data' : '');
    if (box.type === 'meta') parseMeta(b, box, r);
    else if (box.type === 'uuid' && box.uuid === C2PA_UUID) parseC2paBox(b, box, r);
    else if (box.type === 'moov') parseMoov(b, box, r);
    else if (!['ftyp', 'mdat', 'free', 'skip', 'meta', 'moov', 'uuid'].includes(box.type)) r.field('Other boxes', box.type, `${fmtBytes(box.size)}, not decoded`);
  }
  if (!top.length) r.warn('The file has no readable boxes.');
}

function parseMeta(b, meta, r) {
  const fb = fullBox(b, meta);
  const m = { start: fb.body, end: meta.end };
  const items = new Map(); const props = []; const assoc = new Map(); const refs = [];
  let primary = null; let idat = null;
  for (const c of boxes(b, m.start, m.end)) {
    if (c.type === 'hdlr') r.field('Container', 'Handler', printable(b.ascii(c.start + 8, 4)));
    else if (c.type === 'pitm') { const f = fullBox(b, c); primary = f.version ? b.u32(f.body) : b.u16(f.body); }
    else if (c.type === 'iinf') parseIinf(b, c, items);
    else if (c.type === 'iloc') parseIloc(b, c, items, r);
    else if (c.type === 'idat') idat = c;
    else if (c.type === 'iref') parseIref(b, c, refs);
    else if (c.type === 'iprp') {
      const ipco = child(b, c, 'ipco');
      if (ipco) for (const p of boxes(b, ipco.start, ipco.end)) props.push(p);
      for (const ipma of boxes(b, c.start, c.end)) if (ipma.type === 'ipma') parseIpma(b, ipma, assoc);
    } else if (c.type === 'xml ') { const f = fullBox(b, c); parseXmp(utf8.decode(b.slice(f.body, c.end - f.body)), r); r.block('XMP', c.offset, c.size, { container: 'meta xml' }); }
  }
  const propOf = (id, type) => (assoc.get(id) ?? []).map((i) => props[i - 1]).find((p) => p?.type === type);
  // Dimensions come from the primary item's spatial extent property.
  const ispe = propOf(primary, 'ispe') ?? props.find((p) => p.type === 'ispe');
  if (ispe) { const f = fullBox(b, ispe); r.width = b.u32(f.body); r.height = b.u32(f.body + 4); }
  const rot = propOf(primary, 'irot');
  if (rot) r.field('Container', 'Rotation', `${(b.u8at(rot.start) & 3) * 90}° counter-clockwise`);
  const colr = propOf(primary, 'colr') ?? props.find((p) => p.type === 'colr');
  if (colr) describeColr(b, colr, r);
  const codec = propOf(primary, 'hvcC') ?? propOf(primary, 'av1C') ?? props.find((p) => p.type === 'hvcC' || p.type === 'av1C');
  if (codec) describeCodec(b, codec, r);
  const pixi = propOf(primary, 'pixi');
  if (pixi) { const f = fullBox(b, pixi); const n = b.u8at(f.body); r.field('Container', 'Bits per channel', Array.from({ length: Math.min(n, 8) }, (_, k) => b.u8at(f.body + 1 + k)).join(', ')); }
  r.field('Container', 'Primary item', primary === null ? 'None' : String(primary));
  r.field('Container', 'Items', String(items.size));
  const refsFrom = new Map();
  for (const x of refs) { if (!refsFrom.has(x.from)) refsFrom.set(x.from, []); refsFrom.get(x.from).push(x); }
  // Only the first 200 items are listed, but every item's metadata is reported, so the cleaner sees it all.
  let listed = 0;
  for (const [id, it] of items) {
    const aux = propOf(id, 'auxC');
    const auxType = aux ? cstr(b, fullBox(b, aux).body, aux.end).text : '';
    const extent = it.extents?.reduce((n, e) => n + e.length, 0) ?? 0;
    const relations = (refsFrom.get(id) ?? []).map((x) => `${x.type} → ${x.to.join(', ')}`);
    const desc = [it.type, id === primary && 'primary', it.contentType, auxType && (AUX_TYPES[auxType] ?? auxType), it.name && `"${it.name}"`, extent && fmtBytes(extent), ...relations].filter(Boolean).join(' · ');
    if (listed++ < 200) r.field('Items', `Item ${id}`, desc);
    if (auxType && /depth|matte|gainmap/i.test(auxType)) r.signal('privacy', 'Hidden auxiliary images', `The file contains ${AUX_TYPES[auxType] ?? auxType} images that viewers do not show. Depth maps and mattes can reveal the shape of people and scenes.`, 'HEIF items', 'hidden auxiliary images');
    const data = () => readItem(b, it, idat);
    if ((refsFrom.get(id) ?? []).some((x) => x.type === 'thmb')) {
      for (const e of it.extents ?? []) r.block('Thumbnail', it.method === 0 ? e.offset : undefined, e.length, { container: `HEIF item ${id}` });
      r.signal('privacy', 'Embedded thumbnail preview', 'A small copy of the image is stored in the file. After cropping or editing, it can still show the original picture.', `HEIF item ${id}`, 'an embedded thumbnail');
    } else if (it.type === 'Exif') {
      const bytes = data(); if (!bytes) continue;
      const skip = bytes.length >= 4 ? 4 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) : 0;
      const ids = (it.extents ?? []).map((e) => r.block('EXIF', it.method === 0 ? e.offset : undefined, e.length, { container: `HEIF item ${id}` }));
      r.within(ids[0] ?? -1, () => parseTiff(new Bytes(bytes.subarray(skip)), r, { label: 'EXIF', at: it.extents?.length === 1 && it.method === 0 ? it.extents[0].offset + skip : undefined }));
    } else if (it.type === 'mime' && /rdf\+xml|xmp/i.test(it.contentType ?? '')) {
      const bytes = data(); if (!bytes) continue;
      parseXmp(utf8.decode(bytes), r);
      for (const e of it.extents ?? []) r.block('XMP', it.method === 0 ? e.offset : undefined, e.length, { container: `HEIF item ${id}` });
    } else if (it.type === 'mime' && /c2pa/i.test(it.contentType ?? '')) {
      for (const e of it.extents ?? []) r.block('C2PA', it.method === 0 ? e.offset : undefined, e.length, { container: `HEIF item ${id}` });
      const bytes = data(); if (bytes) parseJumbf(new Bytes(bytes), r, { record: false });
    } else if (it.type === 'mime' || it.type === 'uri ') {
      for (const e of it.extents ?? []) r.block('Item data', it.method === 0 ? e.offset : undefined, e.length, { container: `HEIF item ${id}`, decoded: false, note: it.contentType });
    }
  }
}

function parseIinf(b, box, items) {
  const f = fullBox(b, box);
  const start = f.body + (f.version ? 4 : 2);
  for (const infe of boxes(b, start, box.end)) {
    if (infe.type !== 'infe') continue;
    const g = fullBox(b, infe); if (g.version < 2) continue;
    let o = g.body;
    const id = g.version === 2 ? b.u16(o) : b.u32(o); o += g.version === 2 ? 2 : 4;
    o += 2;
    const type = b.ascii(o, 4); o += 4;
    const name = cstr(b, o, infe.end); o = name.next;
    const it = items.get(id) ?? {}; it.type = type; it.name = name.text;
    if (type === 'mime' && o < infe.end) it.contentType = cstr(b, o, infe.end).text;
    if (type === 'uri ' && o < infe.end) it.contentType = cstr(b, o, infe.end).text;
    items.set(id, it);
    if (items.size > 10000) break;
  }
}

function parseIloc(b, box, items, r) {
  const f = fullBox(b, box); let o = f.body;
  const sizes = b.u8at(o); const sizes2 = b.u8at(o + 1); o += 2;
  const offSize = sizes >> 4; const lenSize = sizes & 15; const baseSize = sizes2 >> 4; const idxSize = f.version > 0 ? sizes2 & 15 : 0;
  const read = (n) => { let v = 0; if (n === 4) v = b.u32(o); else if (n === 8) v = b.u64(o); else if (n === 2) v = b.u16(o); else if (n !== 0) throw new Error('bad iloc field size'); o += n; return v; };
  const count = f.version < 2 ? read(2) : read(4);
  if (count > 10000) { r.warn('HEIF item location table is too large.'); return; }
  for (let i = 0; i < count; i++) {
    const id = f.version < 2 ? read(2) : read(4);
    const method = f.version > 0 ? read(2) & 15 : 0;
    read(2);
    const base = read(baseSize);
    const n = read(2);
    if (n > 1000) throw new Error('too many extents');
    const extents = [];
    for (let k = 0; k < n; k++) { if (idxSize) read(idxSize); const off = read(offSize); const len = read(lenSize); extents.push({ offset: base + off, length: len }); }
    const it = items.get(id) ?? {}; it.method = method; it.extents = extents; items.set(id, it);
  }
}

function parseIpma(b, box, assoc) {
  const f = fullBox(b, box); let o = f.body;
  const count = Math.min(b.u32(o), 10000); o += 4;
  for (let i = 0; i < count; i++) {
    const id = f.version < 1 ? b.u16(o) : b.u32(o); o += f.version < 1 ? 2 : 4;
    const n = b.u8at(o++); const list = [];
    for (let k = 0; k < n; k++) { if (f.flags & 1) { list.push(b.u16(o) & 0x7fff); o += 2; } else { list.push(b.u8at(o) & 0x7f); o += 1; } }
    assoc.set(id, list);
  }
}

function parseIref(b, box, refs) {
  const f = fullBox(b, box);
  for (const ref of boxes(b, f.body, box.end)) {
    let o = ref.start; const w = f.version ? 4 : 2; const rd = () => { const v = w === 4 ? b.u32(o) : b.u16(o); o += w; return v; };
    const from = rd(); const n = Math.min(b.u16(o), 1000); o += 2;
    const to = []; for (let i = 0; i < n; i++) to.push(rd());
    refs.push({ type: ref.type, from, to });
    if (refs.length > 10000) break;
  }
}

function readItem(b, it, idat) {
  if (!it.extents?.length) return null;
  const parts = [];
  for (const e of it.extents) {
    const at = it.method === 1 ? (idat ? idat.start + e.offset : -1) : e.offset;
    const len = e.length || (b.length - at);
    if (!b.has(at, len) || len > 64 * 1024 * 1024) return null;
    parts.push(b.slice(at, len));
  }
  return concat(parts);
}

function describeColr(b, box, r) {
  const type = b.ascii(box.start, 4);
  if (type === 'nclx' && box.end - box.start >= 11) r.field('Container', 'Color', `nclx primaries ${b.u16(box.start + 4)}, transfer ${b.u16(box.start + 6)}, matrix ${b.u16(box.start + 8)}, ${b.u8at(box.start + 10) & 0x80 ? 'full' : 'limited'} range`);
  else if (type === 'prof' || type === 'rICC') { parseIcc(new Bytes(b.slice(box.start + 4, box.end - box.start - 4)), r); }
}

function describeCodec(b, box, r) {
  const s = box.start;
  if (box.type === 'hvcC' && box.end - s >= 23) {
    r.field('Container', 'Codec', 'HEVC');
    r.field('Container', 'Chroma format', ['Monochrome', '4:2:0', '4:2:2', '4:4:4'][b.u8at(s + 16) & 3]);
    r.field('Container', 'Bit depth', `${(b.u8at(s + 17) & 7) + 8} luma, ${(b.u8at(s + 18) & 7) + 8} chroma`);
  } else if (box.type === 'av1C' && box.end - s >= 4) {
    const p = b.u8at(s + 1); const f = b.u8at(s + 2);
    const depth = f & 0x40 ? (f & 0x20 ? 12 : 10) : 8;
    r.field('Container', 'Codec', `AV1, profile ${p >> 5}`);
    r.field('Container', 'Chroma format', f & 0x10 ? 'Monochrome' : f & 0x08 ? (f & 0x04 ? '4:2:0' : '4:2:2') : '4:4:4');
    r.field('Container', 'Bit depth', String(depth));
  }
}

function parseC2paBox(b, box, r) {
  let o = box.start + 4;
  const purpose = cstr(b, o, box.end); o = purpose.next;
  if (purpose.text === 'manifest') o += 8;
  if (purpose.text === 'manifest' || purpose.text === 'original') { r.block('C2PA', box.offset, box.size, { container: 'uuid box' }); parseJumbf(new Bytes(b.slice(o, box.end - o)), r, { record: false }); }
  else r.field('Other boxes', 'C2PA', `${purpose.text} box, ${fmtBytes(box.size)}`);
}

// Canon CR3 keeps TIFF-format metadata in CMT boxes inside a Canon uuid box in moov.
function parseMoov(b, moov, r) {
  for (const c of boxes(b, moov.start, moov.end)) {
    if (c.type !== 'uuid' || c.uuid !== CANON_UUID) continue;
    for (const cmt of boxes(b, c.start, c.end)) {
      const view = new Bytes(b.slice(cmt.start, cmt.end - cmt.start));
      const opts = { CMT1: { label: 'EXIF' }, CMT2: { label: 'EXIF', rootDir: 'Exif' }, CMT3: { label: '', rootDir: 'Maker notes (Canon)' }, CMT4: { label: 'EXIF', rootDir: 'GPS' } }[cmt.type];
      if (opts) r.within(r.block('EXIF', cmt.offset, cmt.size, { container: `CR3 ${cmt.type}` }), () => parseTiff(view, r, { ...opts, at: cmt.start }));
      else if (cmt.type === 'THMB') { r.block('Thumbnail', cmt.offset, cmt.size, { container: 'CR3 THMB' }); r.field('Container', 'Thumbnail', fmtBytes(cmt.size)); }
    }
  }
}
