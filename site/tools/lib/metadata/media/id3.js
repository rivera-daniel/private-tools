// ID3v2.2–2.4, ID3v1/1.1, APEv2 and Lyrics3 tags (MP3, AAC, FLAC, WAV, AIFF and MP4 ID32).
import { Bytes, latin1, utf8, clean, fmtBytes, bytesValue, hexPreview } from '../bytes.js';
import { text, text16, tag, groupOf, PICTURE_TYPES } from './common.js';

export const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'];

// [label, highlight group]. ID3v2.2 three-letter IDs are mapped to their v2.3 names first.
const FRAMES = {
  TIT1: ['Content group'], TIT2: ['Title', 'Description'], TIT3: ['Subtitle', 'Description'], TALB: ['Album', 'Description'], TOAL: ['Original album'],
  TPE1: ['Artist', 'People'], TPE2: ['Album artist', 'People'], TPE3: ['Conductor', 'People'], TPE4: ['Remixed by', 'People'], TCOM: ['Composer', 'People'],
  TEXT: ['Lyricist', 'People'], TOLY: ['Original lyricist', 'People'], TOPE: ['Original artist', 'People'], TCOP: ['Copyright', 'People'], TPRO: ['Produced', 'People'],
  TPUB: ['Publisher', 'People'], TOWN: ['File owner', 'People'], TENC: ['Encoded by', 'People'], TSSE: ['Encoder settings', 'Software'], TRSN: ['Radio station'], TRSO: ['Radio station owner', 'People'],
  TYER: ['Year', 'Dates'], TDAT: ['Date', 'Dates'], TIME: ['Time', 'Dates'], TDRC: ['Recording time', 'Dates'], TDRL: ['Release time', 'Dates'], TDOR: ['Original release time', 'Dates'], TORY: ['Original release year', 'Dates'],
  TDEN: ['Encoding time', 'Dates'], TDTG: ['Tagging time', 'Dates'], TRDA: ['Recording dates', 'Dates'], TCON: ['Genre'], TRCK: ['Track'], TPOS: ['Disc'], TBPM: ['BPM'], TKEY: ['Key'], TLAN: ['Language'],
  TLEN: ['Length (ms)'], TMED: ['Media type'], TFLT: ['File type'], TOFN: ['Original file name', 'File'], TSRC: ['ISRC'], TSIZ: ['Size'], TCMP: ['Compilation'], TMOO: ['Mood'], TSST: ['Set subtitle'],
  TSOA: ['Album sort'], TSOP: ['Artist sort'], TSOT: ['Title sort'], TSO2: ['Album artist sort'], TSOC: ['Composer sort'], TCAT: ['Podcast category'], TDES: ['Podcast description', 'Description'], TGID: ['Podcast ID'], TKWD: ['Podcast keywords', 'Description'],
  TIPL: ['Involved people', 'People'], TMCL: ['Musicians', 'People'], IPLS: ['Involved people', 'People'], WCOM: ['Commercial URL'], WCOP: ['Copyright URL'], WOAF: ['File URL'], WOAR: ['Artist URL'], WOAS: ['Source URL'], WORS: ['Station URL'], WPAY: ['Payment URL'], WPUB: ['Publisher URL'], WFED: ['Podcast feed URL'],
};
const V22 = { TT1: 'TIT1', TT2: 'TIT2', TT3: 'TIT3', TAL: 'TALB', TOT: 'TOAL', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TP4: 'TPE4', TCM: 'TCOM', TXT: 'TEXT', TOL: 'TOLY', TOA: 'TOPE', TCR: 'TCOP', TPB: 'TPUB', TEN: 'TENC', TSS: 'TSSE', TYE: 'TYER', TDA: 'TDAT', TIM: 'TIME', TRD: 'TRDA', TOR: 'TORY', TCO: 'TCON', TRK: 'TRCK', TPA: 'TPOS', TBP: 'TBPM', TKE: 'TKEY', TLA: 'TLAN', TLE: 'TLEN', TMT: 'TMED', TFT: 'TFLT', TOF: 'TOFN', TRC: 'TSRC', TSI: 'TSIZ', TCP: 'TCMP', TXX: 'TXXX', WXX: 'WXXX', WCM: 'WCOM', WCP: 'WCOP', WAF: 'WOAF', WAR: 'WOAR', WAS: 'WOAS', WPB: 'WPUB', COM: 'COMM', ULT: 'USLT', SLT: 'SYLT', GEO: 'GEOB', UFI: 'UFID', POP: 'POPM', CNT: 'PCNT', IPL: 'IPLS', MCI: 'MCDI', CRM: 'CRM ', CRA: 'AENC', BUF: 'RBUF', ETC: 'ETCO', EQU: 'EQUA', LNK: 'LINK', MLL: 'MLLT', REV: 'RVRB', RVA: 'RVAD', STC: 'SYTC' };
const SRC = 'ID3v2';

const synchsafe = (b, o) => { const a = [0, 1, 2, 3].map((i) => b.u8at(o + i)); return a.some((x) => x & 0x80) ? -1 : (a[0] << 21) | (a[1] << 14) | (a[2] << 7) | a[3]; };
// Unsynchronisation inserts 0x00 after every 0xFF.
function deunsync(u8) { const out = new Uint8Array(u8.length); let n = 0; for (let i = 0; i < u8.length; i++) { out[n++] = u8[i]; if (u8[i] === 0xff && u8[i + 1] === 0) i++; } return out.subarray(0, n); }

const decode = (u8, enc) => (enc === 1 ? text16(u8) : enc === 2 ? clean(new TextDecoder('utf-16be').decode(u8)) : enc === 3 ? clean(utf8.decode(u8)) : clean(latin1(u8)));
// A terminated string at o: one zero byte for Latin-1 and UTF-8, two aligned zero bytes for UTF-16.
function term(d, o, enc) {
  if (enc === 1 || enc === 2) { let i = o; while (i + 1 < d.length && !(d[i] === 0 && d[i + 1] === 0)) i += 2; return [decode(d.subarray(o, Math.min(i, d.length)), enc), Math.min(i + 2, d.length)]; }
  let i = d.indexOf(0, o); if (i < 0) i = d.length;
  return [decode(d.subarray(o, i), enc), i + 1];
}
function textValues(d) {
  const enc = d[0]; const out = []; let o = 1;
  while (o < d.length && out.length < 64) { const [s, next] = term(d, o, enc); if (s) out.push(s); if (next <= o) break; o = next; }
  return out;
}
const genre = (v) => v.replace(/^\((\d+)\)(.*)$/, (m, n, rest) => rest || GENRES[n] || m).replace(/^(\d+)$/, (m, n) => GENRES[n] ?? m);

// Parses the ID3v2 tag at `at`. Returns its length in bytes, footer included, or 0 when there is none.
// record: false when the caller already recorded the enclosing block (a RIFF or AIFF chunk, an MP4 box).
export function parseId3v2(b, at, r, ctx, { record = true, where = '' } = {}) {
  if (!b.has(at, 10) || b.ascii(at, 3) !== 'ID3') return 0;
  const major = b.u8at(at + 3); const flags = b.u8at(at + 5); const size = synchsafe(b, at + 6);
  if (size < 0 || major === 0xff) return 0;
  const total = 10 + size + (major === 4 && flags & 0x10 ? 10 : 0);
  const available = Math.min(total, b.length - at);
  if (available < total) r.warn('An ID3v2 tag declares a size past the end of the file.');
  const id = record ? r.block('ID3v2', at, available, { container: `ID3v2.${major}${where}` }) : -1;
  r.field(SRC, 'Version', `2.${major}.${b.u8at(at + 4)}`);
  if (major < 2 || major > 4) { r.field(SRC, 'Contents', `${fmtBytes(size)}, version not decoded`); return available; }
  const whole = !!(flags & 0x80) && major < 4;
  const body = whole ? deunsync(b.slice(at + 10, size)) : b.slice(at + 10, size);
  let o = 0;
  try {
    if (flags & 0x40) { const v = new Bytes(body); o = major === 3 ? 4 + v.u32(0) : major === 4 ? Math.max(6, synchsafe(v, 0)) : 0; }
  } catch { o = body.length; }
  const exact = !whole;
  r.within(id, () => frames(body, o, major, flags, r, ctx, exact ? at + 10 : null));
  return available;
}

function frames(body, o, major, tagFlags, r, ctx, base) {
  const v = new Bytes(body); const idLen = major === 2 ? 3 : 4; const hdr = major === 2 ? 6 : 10;
  for (let count = 0; o + hdr <= body.length && count < 5000; count++) {
    const raw = v.ascii(o, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(raw)) break;
    let size = major === 2 ? v.u24(o + 3) : major === 3 ? v.u32(o + 4) : synchsafe(v, o + 4);
    // Some writers store plain sizes in ID3v2.4. Prefer the reading that lands on the next frame.
    if (major === 4) { const plain = v.u32(o + 4); const ok = (n) => n >= 0 && (o + hdr + n === body.length || (o + hdr + n + 4 <= body.length && /^[A-Z0-9]{4}$|^\0/.test(v.ascii(o + hdr + n, 4)))); if (!ok(size) && ok(plain)) size = plain; }
    if (size < 0 || o + hdr + size > body.length) break;
    const fflags = major === 2 ? 0 : v.u16(o + 8);
    let data = body.subarray(o + hdr, o + hdr + size); let at = base === null ? null : base + o + hdr;
    let compressed = false;
    if (major === 3) { if (fflags & 0x40) { r.field(SRC, raw, `${fmtBytes(size)}, encrypted`); o += hdr + size; continue; } if (fflags & 0x80) { data = data.subarray(4); compressed = true; at = null; } if (fflags & 0x20) { data = data.subarray(1); if (at !== null) at++; } }
    if (major === 4) {
      if (fflags & 0x04) { r.field(SRC, raw, `${fmtBytes(size)}, encrypted`); o += hdr + size; continue; }
      if (fflags & 0x40) { data = data.subarray(1); if (at !== null) at++; }
      if (fflags & 0x01) { data = data.subarray(4); if (at !== null) at += 4; }
      if (fflags & 0x02 || tagFlags & 0x80) { data = deunsync(data); at = null; }
      if (fflags & 0x08) { compressed = true; at = null; }
    }
    const fid = major === 2 ? V22[raw] ?? raw : raw;
    if (compressed) { const z = data; ctx.pending.push(async () => { const out = await r.inflate(z, 'an ID3 frame'); if (out.length) try { frame(fid, out, r, ctx, null, 0); } catch { /* malformed frame */ } }); }
    else try { frame(fid, data, r, ctx, at, 0); } catch { /* malformed frame */ }
    o += hdr + size;
  }
}

function frame(fid, d, r, ctx, at, depth) {
  if (!d.length) return;
  const known = FRAMES[fid];
  if (fid === 'TXXX') { const enc = d[0]; const [desc, next] = term(d, 1, enc); const value = decode(d.subarray(next), enc).replace(/\0/g, '; '); tag(r, SRC, `TXXX ${desc}`, value, groupOf(desc), desc); return; }
  if (fid[0] === 'T') { const values = textValues(d).map((x) => (fid === 'TCON' ? genre(x) : x)); tag(r, SRC, known?.[0] ?? fid, values.join('; '), known?.[1] ?? null); return; }
  if (fid === 'WXXX') { const enc = d[0]; const [desc, next] = term(d, 1, enc); tag(r, SRC, `URL ${desc}`.trim(), clean(latin1(d.subarray(next)))); return; }
  if (fid[0] === 'W') { tag(r, SRC, known?.[0] ?? fid, clean(latin1(d))); return; }
  if (fid === 'COMM' || fid === 'USLT') {
    const enc = d[0]; const lang = clean(latin1(d.subarray(1, 4))); const [desc, next] = term(d, 4, enc); const value = decode(d.subarray(next), enc);
    const label = fid === 'COMM' ? `Comment${desc ? ` ${desc}` : ''}` : `Lyrics${desc ? ` ${desc}` : ''}`;
    tag(r, SRC, lang && lang !== 'XXX' && lang !== 'xxx' ? `${label} (${lang})` : label, value, /^iTun/.test(desc) ? null : 'Comments', label);
    return;
  }
  if (fid === 'APIC') {
    const enc = d[0]; const [mime, o] = term(d, 1, 0); const type = d[o]; const [desc, next] = term(d, o + 1, enc);
    picture(d.subarray(next), mime, type, desc, r, ctx, at === null ? null : at + next);
    return;
  }
  if (fid === 'PIC') {
    const enc = d[0]; const fmt = latin1(d.subarray(1, 4)); const type = d[4]; const [desc, next] = term(d, 5, enc);
    picture(d.subarray(next), fmt === '-->' ? fmt : `image/${fmt.toLowerCase()}`, type, desc, r, ctx, at === null ? null : at + next);
    return;
  }
  if (fid === 'PRIV') {
    const [owner, next] = term(d, 0, 0); const value = d.subarray(next);
    r.field(SRC, `Private frame ${owner}`, bytesValue(value), { flag: 'privacy' });
    r.signal('privacy', 'Private identifiers stored', `ID3 private frames from ${owner || 'an unnamed application'} hold data that players do not show, such as store or library identifiers.`, 'ID3v2 PRIV', 'private identifiers');
    return;
  }
  if (fid === 'UFID') { const [owner, next] = term(d, 0, 0); tag(r, SRC, `Unique file ID ${owner}`, bytesValue(d.subarray(next))); return; }
  if (fid === 'GEOB') {
    const enc = d[0]; const [mime, a] = term(d, 1, 0); const [file, c] = term(d, a, enc); const [desc, e] = term(d, c, enc); const data = d.subarray(e);
    r.field(SRC, `Embedded file${desc ? ` ${desc}` : ''}`, `${file || 'unnamed'}${mime ? ` (${mime})` : ''}, ${fmtBytes(data.length)}`, { flag: 'privacy' });
    r.signal('privacy', 'Embedded file stored', `The ID3 tag carries an embedded file${file ? ` named "${file}"` : ''}.`, 'ID3v2 GEOB', 'an embedded file');
    if (/^image\//i.test(mime)) ctx.covers.push([data, `Embedded file ${file || desc || ''}`.trim()]);
    return;
  }
  if (fid === 'POPM') {
    const [email, next] = term(d, 0, 0); const rating = d[next];
    r.field(SRC, 'Rating', `${rating ?? 0} of 255${email ? ` by ${email}` : ''}`, email ? { flag: 'privacy' } : {});
    if (email) r.add('People', 'Rating by', email, { flag: 'privacy' });
    return;
  }
  if (fid === 'PCNT') { r.field(SRC, 'Play count', String([...d.subarray(0, 8)].reduce((n, x) => n * 256 + x, 0))); return; }
  if (fid === 'OWNE') { const [price, next] = term(d, 1, 0); const date = latin1(d.subarray(next, next + 8)); const seller = decode(d.subarray(next + 8), d[0]); tag(r, SRC, 'Ownership', [seller, price, date].filter(Boolean).join(' · '), 'People'); return; }
  if (fid === 'COMR' || fid === 'USER') { tag(r, SRC, fid === 'COMR' ? 'Commercial frame' : 'Terms of use', bytesValue(d.subarray(fid === 'USER' ? 4 : 1))); return; }
  if (fid === 'SYLT') {
    const enc = d[0]; let [, o] = term(d, 6, enc); const lines = [];
    while (o < d.length && lines.length < 500) { const [s, next] = term(d, o, enc); if (s) lines.push(s); o = next + 4; }
    tag(r, SRC, 'Synchronised lyrics', lines.join(' / '), 'Comments');
    return;
  }
  if ((fid === 'CHAP' || fid === 'CTOC') && depth < 4) {
    const [element, next] = term(d, 0, 0); let o = next + 16;
    if (fid === 'CTOC') { const n = d[next + 1] ?? 0; o = next + 2; for (let i = 0; i < n && o < d.length; i++) o = term(d, o, 0)[1]; }
    r.field(SRC, fid === 'CHAP' ? 'Chapter' : 'Table of contents', element);
    const sub = new Bytes(d);
    for (let count = 0; o + 10 <= d.length && count < 64; count++) {
      const id = sub.ascii(o, 4); const size = sub.u32(o + 4);
      if (!/^[A-Z0-9]{4}$/.test(id) || o + 10 + size > d.length) break;
      try { frame(id, d.subarray(o + 10, o + 10 + size), r, ctx, null, depth + 1); } catch { /* malformed */ }
      o += 10 + size;
    }
    return;
  }
  r.field(SRC, fid, `${fmtBytes(d.length)}, not decoded`);
}

function picture(data, mime, type, desc, r, ctx, at) {
  const label = `Cover art (${PICTURE_TYPES[type] ?? `type ${type}`})`;
  if (mime === '-->') { r.field(SRC, label, `Link: ${clean(latin1(data))}`); return; }
  if (desc) r.field(SRC, `${label} description`, desc);
  if (at !== null) r.block('Cover art', at, data.length, { container: 'ID3v2 APIC', note: mime });
  ctx.covers.push([data, label]);
}

// Tags appended at the end of the file, outermost last: ID3v1 (with the TAG+ extension), APEv2, Lyrics3 and
// an appended ID3v2.4 tag with a footer. Returns where the audio ends.
export function trailingTags(b, r, ctx, end = b.length) {
  for (let pass = 0; pass < 8; pass++) {
    if (end >= 128 && b.ascii(end - 128, 3) === 'TAG') {
      id3v1(b, end - 128, r);
      end -= 128;
      if (end >= 227 && b.ascii(end - 227, 4) === 'TAG+') { r.block('ID3v1', end - 227, 227, { container: 'ID3v1 extended (TAG+)' }); tag(r, 'ID3v1', 'Extended title', clean(latin1(b.slice(end - 223, 60))), 'Description'); end -= 227; }
      continue;
    }
    if (end >= 32 && b.ascii(end - 32, 8) === 'APETAGEX') { const start = ape(b, end - 32, r, ctx); if (start < 0) break; end = start; continue; }
    if (end >= 15 && b.ascii(end - 9, 9) === 'LYRICS200') {
      const size = Number(b.ascii(end - 15, 6)); const start = end - 15 - size;
      if (!Number.isInteger(size) || start < 0 || b.ascii(start, 11) !== 'LYRICSBEGIN') break;
      lyrics3(b, start, end, r, true); end = start; continue;
    }
    if (end >= 20 && b.ascii(end - 9, 9) === 'LYRICSEND') {
      const from = Math.max(0, end - 5100 - 20); const hay = b.ascii(from, end - from); const i = hay.lastIndexOf('LYRICSBEGIN');
      if (i < 0) break;
      lyrics3(b, from + i, end, r, false); end = from + i; continue;
    }
    if (end >= 20 && b.ascii(end - 10, 3) === '3DI') {
      const size = synchsafe(b, end - 4); const start = end - 20 - size;
      if (size < 0 || start < 0 || b.ascii(start, 3) !== 'ID3') break;
      parseId3v2(b, start, r, ctx, { where: ' (appended)' }); end = start; continue;
    }
    break;
  }
  return end;
}

function id3v1(b, at, r) {
  r.block('ID3v1', at, 128, { container: 'ID3v1' });
  const s = (o, n) => clean(latin1(b.slice(at + o, n)).replace(/\0.*$/s, ''));
  tag(r, 'ID3v1', 'Title', s(3, 30), 'Description'); tag(r, 'ID3v1', 'Artist', s(33, 30), 'People'); tag(r, 'ID3v1', 'Album', s(63, 30), 'Description');
  tag(r, 'ID3v1', 'Year', s(93, 4), 'Dates');
  const v11 = b.u8at(at + 125) === 0 && b.u8at(at + 126) !== 0;
  tag(r, 'ID3v1', 'Comment', s(97, v11 ? 28 : 30), 'Comments');
  if (v11) r.field('ID3v1', 'Track', String(b.u8at(at + 126)));
  const g = b.u8at(at + 127); if (g !== 255) r.field('ID3v1', 'Genre', GENRES[g] ?? String(g));
}

// APEv2 (and APEv1) from its 32-byte footer. Returns the tag's start, header included, or -1.
function ape(b, footer, r, ctx) {
  const size = b.u32(footer + 12, true); const count = b.u32(footer + 16, true); const flags = b.u32(footer + 20, true);
  const header = flags & 0x80000000 ? 32 : 0; const items = footer + 32 - size; const start = items - header;
  if (size < 32 || start < 0) return -1;
  const id = r.block('APE', start, footer + 32 - start, { container: `APEv${b.u32(footer + 8, true) >= 2000 ? 2 : 1}` });
  r.within(id, () => {
    let o = items;
    for (let i = 0; i < Math.min(count, 1000) && o + 8 < footer; i++) {
      const len = b.u32(o, true); const iflags = b.u32(o + 4, true); let k = o + 8;
      while (k < footer && k - o < 263 && b.u8at(k) !== 0) k++;
      const key = clean(latin1(b.slice(o + 8, k - o - 8))); const value = k + 1;
      if (value + len > footer) break;
      const data = b.slice(value, len); const kind = (iflags >> 1) & 3;
      if (kind === 1 && /cover art/i.test(key)) {
        const z = data.indexOf(0); const img = data.subarray(z + 1);
        r.block('Cover art', value + z + 1, img.length, { container: `APE ${key}` });
        ctx.covers.push([img, `Cover art (APE ${key})`]);
        if (z > 0) r.field('APE', `${key} file name`, clean(latin1(data.subarray(0, z))), { flag: 'privacy' });
      } else tag(r, 'APE', key, kind === 1 ? hexPreview(data) : clean(utf8.decode(data)).replace(/\0/g, '; '), kind === 1 ? null : groupOf(key));
      o = value + len;
    }
  });
  return start;
}

const LYRICS3 = { IND: 'Indicators', LYR: 'Lyrics', INF: 'Information', AUT: 'Author', EAL: 'Album', EAR: 'Artist', ETT: 'Title', IMG: 'Image links' };
function lyrics3(b, start, end, r, v2) {
  r.block('Lyrics3', start, end - start, { container: v2 ? 'Lyrics3v2' : 'Lyrics3' });
  if (!v2) { tag(r, 'Lyrics3', 'Lyrics', text(b.slice(start + 11, end - start - 20)), 'Comments'); return; }
  let o = start + 11; const stop = end - 15;
  for (let i = 0; o + 8 <= stop && i < 64; i++) {
    const id = b.ascii(o, 3); const n = Number(b.ascii(o + 3, 5));
    if (!/^[A-Z]{3}$/.test(id) || !Number.isInteger(n) || o + 8 + n > stop) break;
    const value = text(b.slice(o + 8, n));
    tag(r, 'Lyrics3', LYRICS3[id] ?? id, value, id === 'AUT' || id === 'EAR' ? 'People' : id === 'LYR' ? 'Comments' : id === 'ETT' || id === 'EAL' ? 'Description' : null);
    o += 8 + n;
  }
}
