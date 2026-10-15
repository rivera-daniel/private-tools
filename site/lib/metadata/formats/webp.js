import { utf8, startsWith, fmtBytes } from '../bytes.js';
import { parseTiff } from '../tiff.js';
import { parseXmp } from '../xmp.js';
import { parseIcc } from '../icc.js';
import { parseJumbf } from '../c2pa.js';

export async function parseWebp(b, r) {
  r.format = 'WebP';
  r.struct('RIFF header', 0, 12);
  let o = 12; let chunks = 0; let frames = 0;
  const end = Math.min(b.length, 8 + b.u32(4, true));
  while (o + 8 <= end) {
    const type = b.ascii(o, 4); const len = b.u32(o + 4, true);
    if (!b.has(o + 8, len)) { r.warn(`WebP chunk ${JSON.stringify(type)} declares a length past the end of the file.`); break; }
    if (++chunks > 10000) break;
    const d = b.sub(o + 8, len); const at = o + 8; let note = '';
    try {
      if (type === 'VP8X' && len >= 10) {
        const f = d.u8at(0);
        r.width = 1 + d.u24(4, true); r.height = 1 + d.u24(7, true);
        r.field('WebP', 'Features', [f & 0x20 && 'ICC profile', f & 0x10 && 'alpha', f & 0x08 && 'EXIF', f & 0x04 && 'XMP', f & 0x02 && 'animation'].filter(Boolean).join(', ') || 'None');
      } else if (type === 'VP8 ' && len >= 10) { if (r.width === null) { r.width = d.u16(6, true) & 0x3fff; r.height = d.u16(8, true) & 0x3fff; } r.field('WebP', 'Compression', 'Lossy (VP8)'); }
      else if (type === 'VP8L' && len >= 5) { if (r.width === null) { const bits = d.u32(1, true); r.width = (bits & 0x3fff) + 1; r.height = ((bits >> 14) & 0x3fff) + 1; } r.field('WebP', 'Compression', 'Lossless (VP8L)'); }
      else if (type === 'ANIM' && len >= 6) r.field('WebP', 'Animation loops', d.u16(4, true) ? String(d.u16(4, true)) : 'Forever');
      else if (type === 'ANMF') frames++;
      else if (type === 'EXIF') { note = 'EXIF'; const skip = startsWith(d.u8, 'Exif\0\0') ? 6 : 0; r.within(r.block('EXIF', o, len + 8 + (len & 1), { container: 'EXIF chunk' }), () => parseTiff(d.sub(skip, len - skip), r, { label: 'EXIF', at: at + skip })); }
      else if (type === 'XMP ') { note = 'XMP'; parseXmp(utf8.decode(d.u8), r); r.block('XMP', o, len + 8 + (len & 1), { container: 'XMP chunk' }); }
      else if (type === 'ICCP') { note = 'ICC profile'; parseIcc(d, r); r.block('ICC', o, len + 8 + (len & 1), { container: 'ICCP chunk', removable: false }); }
      else if (type === 'C2PA') { note = 'Content Credentials'; r.block('C2PA', o, len + 8 + (len & 1), { container: 'C2PA chunk' }); parseJumbf(d, r, { record: false }); }
      else if (!['ALPH', 'VP8 ', 'VP8L', 'VP8X', 'ANIM', 'ANMF'].includes(type)) {
        note = 'Not decoded'; r.field('Other chunks', type, `${fmtBytes(len)}, not decoded`);
        r.block('Unknown chunk', o, len + 8 + (len & 1), { container: type, decoded: false });
      }
    } catch (error) { r.warn(`WebP ${type} chunk could not be fully read (${error.message}).`); }
    r.struct(type, o, len + 8 + (len & 1), note);
    o += 8 + len + (len & 1);
  }
  if (frames) r.field('WebP', 'Animation frames', String(frames));
  if (b.length > end) {
    r.struct('Trailing data', end, b.length - end);
    r.block('Trailer', end, b.length - end, { decoded: false, note: 'Data after end of image' });
    r.signal('privacy', 'Hidden data after the image', `${fmtBytes(b.length - end)} follow the end of the WebP container. Image viewers do not show it.`, 'WebP trailer', 'hidden data after the image');
  }
}
