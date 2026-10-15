// FLAC metadata blocks, and the Vorbis comment and picture structures shared with Ogg.
import { Bytes, latin1, utf8, clean, fmtBytes, hex } from '../bytes.js';
import { parseId3v2, trailingTags } from './id3.js';
import { tag, groupOf, duration, base64, iso6709, addLocation, PICTURE_TYPES } from './common.js';

const BLOCKS = ['STREAMINFO', 'PADDING', 'APPLICATION', 'SEEKTABLE', 'VORBIS_COMMENT', 'CUESHEET', 'PICTURE'];

// Vorbis comment: vendor string and KEY=value fields, little-endian lengths. Returns null when malformed.
export function vorbisComment(u8, r, ctx, source = 'Vorbis comment') {
  const v = new Bytes(u8);
  if (!v.has(0, 4)) return null;
  const vlen = v.u32(0, true); if (!v.has(4, vlen + 4)) return null;
  const vendor = clean(utf8.decode(u8.subarray(4, 4 + vlen)));
  const count = v.u32(4 + vlen, true); let o = 8 + vlen; let n = 0;
  if (vendor) tag(r, source, 'Vendor', vendor, 'Software', 'Encoder');
  for (; n < Math.min(count, 10000) && v.has(o, 4); n++) {
    const len = v.u32(o, true); if (!v.has(o + 4, len)) break;
    const entry = u8.subarray(o + 4, o + 4 + len); o += 4 + len;
    const eq = entry.indexOf(0x3d); if (eq < 1) continue;
    const key = latin1(entry.subarray(0, eq)).toUpperCase(); const raw = entry.subarray(eq + 1);
    if (key === 'METADATA_BLOCK_PICTURE' || key === 'COVERART') {
      const data = base64(latin1(raw));
      if (!data) { r.field(source, key, `${fmtBytes(raw.length)}, malformed base64`); continue; }
      if (key === 'COVERART') ctx.covers.push([data, 'Cover art']);
      else picture(data, r, ctx, source);
      continue;
    }
    const value = clean(utf8.decode(raw));
    tag(r, source, key, value, groupOf(key));
    if (/^(LOCATION|GPS|COORDINATES)/.test(key)) { const p = iso6709(value); if (p) addLocation(r, p.lat, p.lon, p.alt, `${source} ${key}`); }
  }
  return { vendor, count, end: o };
}

// FLAC PICTURE structure (also the payload of METADATA_BLOCK_PICTURE). Returns the image byte range.
export function picture(u8, r, ctx, source) {
  const v = new Bytes(u8);
  try {
    const type = v.u32(0); const ml = v.u32(4); const mime = latin1(v.slice(8, ml)); let o = 8 + ml;
    const dl = v.u32(o); const desc = clean(utf8.decode(v.slice(o + 4, dl))); o += 4 + dl;
    const w = v.u32(o); const h = v.u32(o + 4); const len = v.u32(o + 16); o += 20;
    if (!v.has(o, len)) return null;
    const label = `Cover art (${PICTURE_TYPES[type] ?? `type ${type}`})`;
    r.field(source, label, [mime, w && h ? `${w} × ${h}` : '', fmtBytes(len), desc && `"${desc}"`].filter(Boolean).join(', '));
    if (mime === '-->') return null;
    ctx.covers.push([u8.subarray(o, o + len), label]);
    return [o, len];
  } catch { return null; }
}

export function parseFlac(b, r, ctx) {
  r.format = 'FLAC'; r.category = 'Audio';
  let o = 0;
  for (let i = 0; i < 8; i++) { const n = parseId3v2(b, o, r, ctx, { where: ' (before FLAC)' }); if (!n) break; o += n; }
  if (!b.has(o, 4) || b.ascii(o, 4) !== 'fLaC') { r.warn('The FLAC signature is missing. The file is damaged.'); return; }
  r.struct('Signature', o, 4); o += 4;
  for (let i = 0; i < 1000; i++) {
    if (!b.has(o, 4)) { r.warn('FLAC metadata runs past the end of the file.'); return; }
    const head = b.u8at(o); const type = head & 0x7f; const len = b.u24(o + 1); const at = o + 4;
    if (!b.has(at, len)) { r.warn(`The FLAC ${BLOCKS[type] ?? 'metadata'} block runs past the end of the file.`); return; }
    const name = BLOCKS[type] ?? `Block ${type}`;
    r.struct(name, o, len + 4);
    const data = b.slice(at, len); const d = new Bytes(data);
    try {
      if (type === 0 && len >= 34) {
        const rate = (data[10] << 12) | (data[11] << 4) | (data[12] >> 4); const ch = ((data[12] >> 1) & 7) + 1; const bits = (((data[12] & 1) << 4) | (data[13] >> 4)) + 1;
        const total = (data[13] & 15) * 2 ** 32 + d.u32(14);
        r.field('Container', 'Sample rate', `${rate} Hz`); r.field('Container', 'Channels', String(ch)); r.field('Container', 'Bits per sample', String(bits));
        if (rate && total) r.field('Container', 'Duration', duration(total / rate));
        r.field('Container', 'Audio MD5', [...data.subarray(18, 34)].map((x) => x.toString(16).padStart(2, '0')).join(''));
      } else if (type === 1) {
        if (data.some((x) => x)) { r.block('Padding', o, len + 4, { container: 'FLAC PADDING', decoded: false, note: 'Padding holding leftover data' }); r.field('FLAC', 'Leftover data in padding', fmtBytes(len)); }
      } else if (type === 2) {
        const id = latin1(data.subarray(0, 4));
        r.block('Application data', o, len + 4, { container: `FLAC APPLICATION ${id}`, decoded: false, note: id === 'riff' || id === 'aiff' ? 'Foreign metadata kept from the original file' : '' });
        r.field('FLAC', `Application ${id || hex(0)}`, `${fmtBytes(len - 4)}${id === 'riff' || id === 'aiff' ? ` (${id.toUpperCase()} chunks from the original file)` : ''}`);
      } else if (type === 3) r.field('Container', 'Seek points', String(Math.floor(len / 18)));
      else if (type === 4) { const id = r.block('Vorbis comment', o, len + 4, { container: 'FLAC VORBIS_COMMENT' }); r.within(id, () => vorbisComment(data, r, ctx)); }
      else if (type === 5) {
        r.block('Cue sheet', o, len + 4, { container: 'FLAC CUESHEET' });
        const mcn = clean(latin1(data.subarray(0, 128)).replace(/\0.*$/s, ''));
        r.field('FLAC', 'Cue sheet', `${data[395] ?? 0} tracks${mcn ? `, catalog number ${mcn}` : ''}`);
      } else if (type === 6) { r.block('Cover art', o, len + 4, { container: 'FLAC PICTURE' }); picture(data, r, ctx, 'FLAC'); }
      else if (type !== 0) { r.block('Unknown block', o, len + 4, { container: `FLAC block type ${type}`, decoded: false }); r.field('FLAC', `Block type ${type}`, `${fmtBytes(len)}, not decoded`); }
    } catch { r.field('FLAC', name, `${fmtBytes(len)}, could not be decoded`); }
    o = at + len;
    if (head & 0x80) break;
  }
  r.struct('Audio frames', o, b.length - o);
  trailingTags(b, r, ctx, b.length);
}

// Offset of the first audio frame: after the signature and the block marked last.
export function flacAudioStart(b) {
  let o = 0;
  while (b.has(o, 10) && b.ascii(o, 3) === 'ID3') { const s = [6, 7, 8, 9].map((i) => b.u8at(o + i)); o += 10 + ((s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]) + (b.u8at(o + 3) === 4 && b.u8at(o + 5) & 0x10 ? 10 : 0); }
  if (b.ascii(o, 4) !== 'fLaC') return null;
  const signature = o; o += 4; const blocks = [];
  for (let i = 0; i < 1000 && b.has(o, 4); i++) {
    const head = b.u8at(o); const len = b.u24(o + 1);
    if (!b.has(o + 4, len)) return null;
    blocks.push({ type: head & 0x7f, offset: o, length: len + 4 });
    o += 4 + len;
    if (head & 0x80) return { signature, blocks, audio: o };
  }
  return null;
}
