import { Bytes, utf8, latin1, concat, startsWith, fmtBytes, hex, printable, bytesValue } from '../bytes.js';
import { parseTiff, readIfd } from '../tiff.js';
import { parseXmp } from '../xmp.js';
import { parsePhotoshop } from '../photoshop.js';
import { parseIcc } from '../icc.js';
import { parseJumbf } from '../c2pa.js';

const SOF = { 0xc0: 'Baseline DCT', 0xc1: 'Extended sequential DCT', 0xc2: 'Progressive DCT', 0xc3: 'Lossless', 0xc5: 'Differential sequential', 0xc6: 'Differential progressive', 0xc7: 'Differential lossless', 0xc9: 'Extended sequential (arithmetic)', 0xca: 'Progressive (arithmetic)', 0xcb: 'Lossless (arithmetic)', 0xcd: 'Differential sequential (arithmetic)', 0xce: 'Differential progressive (arithmetic)', 0xcf: 'Differential lossless (arithmetic)' };
const MARKERS = { 0xc4: 'DHT', 0xcc: 'DAC', 0xda: 'SOS', 0xdb: 'DQT', 0xdd: 'DRI', 0xfe: 'COM' };

export async function parseJpeg(b, r) {
  r.format = 'JPEG';
  let o = 2; const icc = []; const jumbf = new Map(); const xmpExt = new Map(); let segments = 0;
  r.struct('SOI', 0, 2);
  while (o + 4 <= b.length) {
    if (b.u8at(o) !== 0xff) { r.warn('Unexpected bytes between JPEG segments.'); break; }
    const marker = b.u8at(o + 1);
    if (marker === 0xff) { o++; continue; }
    if (marker === 0xd9) { r.struct('EOI', o, 2); break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
    const len = b.u16(o + 2);
    if (len < 2 || !b.has(o + 2, len)) { r.warn('A JPEG segment declares a length past the end of the file.'); break; }
    if (++segments > 5000) { r.warn('Too many JPEG segments. Inspection stopped early.'); break; }
    const at = o + 4; const data = b.slice(at, len - 2); const d = new Bytes(data);
    const name = marker >= 0xe0 && marker <= 0xef ? `APP${marker - 0xe0}` : SOF[marker] ? `SOF${marker - 0xc0}` : MARKERS[marker] ?? hex(marker, 2);
    let note = '';
    try {
      if (SOF[marker] && data.length >= 6) {
        r.height = d.u16(1); r.width = d.u16(3);
        const comps = d.u8at(5); const sampling = [];
        for (let i = 0; i < comps && 6 + i * 3 + 2 < data.length; i++) { const s = d.u8at(7 + i * 3); sampling.push(`${s >> 4}x${s & 15}`); }
        r.field('JPEG', 'Encoding', SOF[marker]); r.field('JPEG', 'Bits per sample', String(d.u8at(0))); r.field('JPEG', 'Color components', String(comps));
        if (sampling.length === 3) r.field('JPEG', 'Chroma subsampling', subsampling(sampling));
        note = SOF[marker];
      } else if (marker === 0xe0 && startsWith(data, 'JFIF\0') && data.length >= 14) {
        note = 'JFIF';
        r.field('JFIF', 'Version', `${d.u8at(5)}.${String(d.u8at(6)).padStart(2, '0')}`);
        r.field('JFIF', 'Density', `${d.u16(8)} × ${d.u16(10)} ${['(aspect ratio)', 'dpi', 'dots/cm'][d.u8at(7)] ?? ''}`.trim());
        if (d.u8at(12) && d.u8at(13)) r.field('JFIF', 'Thumbnail', `${d.u8at(12)} × ${d.u8at(13)}`);
      } else if (marker === 0xe0 && startsWith(data, 'JFXX\0')) { note = 'JFIF extension (thumbnail)'; r.block('Thumbnail', o, len + 2, { container: 'APP0 JFXX' }); }
      else if (marker === 0xe1 && startsWith(data, 'Exif\0')) { note = 'EXIF'; r.within(r.block('EXIF', o, len + 2, { container: 'APP1' }), () => parseTiff(d.sub(6, data.length - 6), r, { label: 'EXIF', at: at + 6 })); }
      else if (marker === 0xe1 && startsWith(data, 'http://ns.adobe.com/xap/1.0/\0')) { note = 'XMP'; parseXmp(utf8.decode(data.subarray(29)), r); r.block('XMP', o, len + 2, { container: 'APP1' }); }
      else if (marker === 0xe1 && startsWith(data, 'http://ns.adobe.com/xmp/extension/\0')) {
        note = 'Extended XMP'; const guid = latin1(data.subarray(35, 67));
        const parts = xmpExt.get(guid) ?? []; parts.push({ offset: d.u32(71), data: data.subarray(75) }); xmpExt.set(guid, parts);
        r.block('XMP', o, len + 2, { container: 'APP1 extended' });
      } else if (marker === 0xe2 && startsWith(data, 'ICC_PROFILE\0') && data.length > 14) { note = 'ICC profile'; icc.push({ seq: data[12], data: data.subarray(14) }); r.block('ICC', o, len + 2, { container: 'APP2', removable: false }); }
      else if (marker === 0xe2 && startsWith(data, 'MPF\0')) { note = 'Multi-Picture Format'; parseMpf(d.sub(4, data.length - 4), r, at + 4); r.block('MPF', o, len + 2, { container: 'APP2' }); }
      else if (marker === 0xed && startsWith(data, 'Photoshop 3.0\0')) { note = 'Photoshop resources'; r.within(r.block('Photoshop', o, len + 2, { container: 'APP13' }), () => parsePhotoshop(d.sub(14, data.length - 14), r, { at: at + 14 })); }
      else if (marker === 0xeb && startsWith(data, 'JP') && data.length >= 16) {
        note = 'JUMBF (Content Credentials)';
        r.block('C2PA', o, len + 2, { container: 'APP11' });
        const parts = jumbf.get(d.u16(2)) ?? []; parts.push({ seq: d.u32(4), data: data.subarray(8) }); jumbf.set(d.u16(2), parts);
      } else if (marker === 0xee && startsWith(data, 'Adobe') && data.length >= 12) {
        note = 'Adobe'; r.field('Adobe APP14', 'DCT encode version', String(d.u16(5))); r.field('Adobe APP14', 'Color transform', ['Unknown (RGB or CMYK)', 'YCbCr', 'YCCK'][d.u8at(11)] ?? String(d.u8at(11)));
      } else if (marker === 0xfe) {
        note = 'Comment'; const text = bytesValue(data);
        r.field('JPEG comments', 'Comment', text); r.add('Comments', 'JPEG comment', text); r.block('Comment', o, len + 2, { container: 'COM' });
      } else if (marker === 0xdb) note = 'Quantization tables';
      else if (marker === 0xc4) note = 'Huffman tables';
      else if (marker >= 0xe0 && marker <= 0xef) {
        const id = printable(latin1(data.subarray(0, Math.min(32, data.indexOf(0) < 0 ? 32 : data.indexOf(0)))));
        note = id ? `${id}, not decoded` : 'Not decoded';
        r.field('Other segments', `${name}${id ? ` (${id})` : ''}`, `${fmtBytes(data.length)}, not decoded`);
        r.block('Application data', o, len + 2, { container: name, decoded: false, note: id });
      }
    } catch (error) { r.warn(`${name} segment could not be fully read (${error.message}).`); }
    r.struct(name, o, len + 2, note);
    if (marker === 0xda) {
      const end = scanToEoi(b, o + 2 + len);
      r.struct('Image data', o + 2 + len, end - (o + 2 + len));
      o = end; continue;
    }
    o += 2 + len;
  }
  if (icc.length) parseIcc(new Bytes(concat(icc.sort((a, c) => a.seq - c.seq).map((p) => p.data))), r);
  for (const parts of xmpExt.values()) parseXmp(utf8.decode(concat(parts.sort((a, c) => a.offset - c.offset).map((p) => p.data))), r, 'Extended XMP');
  for (const parts of jumbf.values()) {
    parts.sort((a, c) => a.seq - c.seq);
    // Continuation segments repeat the 8-byte JUMBF box header.
    parseJumbf(new Bytes(concat(parts.map((p, i) => (i === 0 ? p.data : p.data.subarray(8))))), r, { record: false });
  }
  trailer(b, r);
}

function subsampling(s) {
  const [y, cb, cr] = s; if (cb !== cr) return s.join(', ');
  const map = { '1x1': '4:4:4', '2x1': '4:2:2', '2x2': '4:2:0', '4x1': '4:1:1', '1x2': '4:4:0' };
  return cb === '1x1' ? map[y] ?? s.join(', ') : s.join(', ');
}

// Entropy-coded data ends at the first marker that is not a restart or stuffed byte.
function scanToEoi(b, from) {
  const u8 = b.u8;
  for (let i = from; i < u8.length - 1; i++) if (u8[i] === 0xff && u8[i + 1] !== 0 && !(u8[i + 1] >= 0xd0 && u8[i + 1] <= 0xd7) && u8[i + 1] !== 0xff) return i;
  return u8.length;
}

function trailer(b, r) {
  const structEnd = r.structure.findLast((s) => s.type === 'EOI');
  const end = structEnd ? structEnd.offset + 2 : b.length;
  const extra = b.length - end;
  if (extra <= 0) return;
  const tail = b.slice(end, extra);
  const embeddedJpeg = tail[0] === 0xff && tail[1] === 0xd8;
  r.struct('Trailing data', end, extra, embeddedJpeg ? 'Additional JPEG image' : '');
  r.block('Trailer', end, extra, { decoded: false, note: embeddedJpeg ? 'Additional JPEG image' : 'Data after end of image' });
  r.field('File', 'Data after end of image', `${fmtBytes(extra)}${embeddedJpeg ? ', starts with another JPEG image' : ''}`, { flag: 'privacy' });
  r.add('File', 'Data after end of image', fmtBytes(extra), { flag: 'privacy' });
  r.signal('privacy', 'Hidden data after the image', `${fmtBytes(extra)} follow the end-of-image marker${embeddedJpeg ? ', including another JPEG image (often a depth map, HDR gain map or original)' : ''}. Image viewers do not show it.`, 'JPEG trailer', 'hidden data after the image');
}

// Multi-Picture Format: phones store depth maps, HDR gain maps and previews as extra images.
function parseMpf(b, r) {
  if (b.length < 8) return;
  const le = b.ascii(0, 2) === 'II';
  const entries = readIfd(b, b.u32(4, le), le, 0, r, 'MPF');
  if (!entries) return;
  for (const e of entries) {
    if (e.tag === 0xb001) r.field('Multi-Picture', 'Number of images', String(e.value()));
    if (e.tag === 0xb002) {
      const n = Math.min(e.count / 16, 32);
      for (let i = 0; i < n; i++) {
        const at = e.at + i * 16; if (!b.has(at, 16)) break;
        const attr = b.u32(at, le); const size = b.u32(at + 4, le);
        const type = { 0x030000: 'Baseline primary image', 0x010001: 'Large thumbnail (VGA)', 0x010002: 'Large thumbnail (full HD)', 0x020001: 'Multi-frame panorama', 0x020002: 'Multi-frame disparity', 0x020003: 'Multi-frame multi-angle', 0x000000: 'Undefined (often a depth or gain map)' }[attr & 0xffffff] ?? hex(attr & 0xffffff, 6);
        r.field('Multi-Picture', `Image ${i + 1}`, `${type}, ${fmtBytes(size)}`);
      }
    }
  }
}
