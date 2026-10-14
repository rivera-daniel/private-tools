import { Bytes, utf8, latin1, clean, indexOfZero, fmtBytes, pad } from '../bytes.js';
import { parseTiff } from '../tiff.js';
import { parseXmp } from '../xmp.js';
import { parseIcc } from '../icc.js';
import { parseJumbf } from '../c2pa.js';
import { textEntry } from '../generation.js';

const COLOR_TYPES = { 0: 'Grayscale', 2: 'RGB', 3: 'Palette', 4: 'Grayscale with alpha', 6: 'RGB with alpha' };
const IMAGE_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'fdAT', 'fcTL']);

export async function parsePng(b, r) {
  r.format = 'PNG';
  r.struct('Signature', 0, 8);
  let o = 8; let chunks = 0; let sawIend = false; let idat = 0; let idatBytes = 0;
  while (o + 8 <= b.length) {
    const len = b.u32(o); const type = b.ascii(o + 4, 4);
    if (!b.has(o + 8, len)) { r.warn(`PNG chunk ${JSON.stringify(type)} declares a length past the end of the file.`); break; }
    if (++chunks > 10000) { r.warn('Too many PNG chunks. Inspection stopped early.'); break; }
    const d = b.sub(o + 8, len); const data = d.u8;
    let note = '';
    try {
      if (type === 'IDAT') { idat++; idatBytes += len; }
      else if (type === 'IHDR' && len >= 13) {
        r.width = d.u32(0); r.height = d.u32(4);
        r.field('PNG', 'Bit depth', String(d.u8at(8))); r.field('PNG', 'Color type', COLOR_TYPES[d.u8at(9)] ?? String(d.u8at(9)));
        r.field('PNG', 'Interlace', d.u8at(12) ? 'Adam7' : 'None');
      } else if (type === 'tEXt') { const z = indexOfZero(data); note = keyword(data); textEntry(r, 'PNG text', note, clean(latin1(data.subarray(z + 1)))); r.block('Text', o, len + 12, { container: `tEXt ${note}` }); }
      else if (type === 'zTXt') {
        const z = indexOfZero(data); note = keyword(data);
        if (z > 0) textEntry(r, 'PNG text', note, clean(latin1(await r.inflate(data.subarray(z + 2), 'a zTXt chunk'))));
        r.block('Text', o, len + 12, { container: `zTXt ${note}` });
      } else if (type === 'iTXt') { note = await itxt(data, r); r.block(note === 'XML:com.adobe.xmp' ? 'XMP' : 'Text', o, len + 12, { container: `iTXt ${note}` }); }
      else if (type === 'eXIf') r.within(r.block('EXIF', o, len + 12, { container: 'eXIf' }), () => parseTiff(d, r, { label: 'EXIF', at: o + 8 }));
      else if (type === 'iCCP') {
        const z = indexOfZero(data); note = keyword(data);
        if (z > 0) { r.field('PNG', 'ICC profile name', note); parseIcc(new Bytes(await r.inflate(data.subarray(z + 2), 'the iCCP chunk')), r); }
        r.block('ICC', o, len + 12, { container: 'iCCP', removable: false });
      } else if (type === 'caBX') { note = 'Content Credentials'; r.block('C2PA', o, len + 12, { container: 'caBX' }); parseJumbf(d, r, { record: false }); }
      else if (type === 'tIME' && len >= 7) { const t = `${d.u16(0)}-${pad(d.u8at(2))}-${pad(d.u8at(3))} ${pad(d.u8at(4))}:${pad(d.u8at(5))}:${pad(d.u8at(6))} UTC`; r.field('PNG', 'Last modified', t); r.add('Dates', 'PNG modified', t); r.block('Time', o, len + 12, { container: 'tIME' }); }
      else if (type === 'pHYs' && len >= 9) { const unit = d.u8at(8); r.field('PNG', 'Pixel density', unit === 1 ? `${Math.round(d.u32(0) * 0.0254)} × ${Math.round(d.u32(4) * 0.0254)} dpi` : `${d.u32(0)} × ${d.u32(4)} (aspect ratio)`); }
      else if (type === 'gAMA' && len >= 4) r.field('PNG', 'Gamma', String(d.u32(0) / 100000));
      else if (type === 'sRGB' && len >= 1) r.field('PNG', 'sRGB rendering intent', ['Perceptual', 'Relative colorimetric', 'Saturation', 'Absolute colorimetric'][d.u8at(0)] ?? String(d.u8at(0)));
      else if (type === 'cHRM' && len >= 32) r.field('PNG', 'Chromaticities', Array.from({ length: 8 }, (_, i) => d.u32(i * 4) / 100000).join(', '));
      else if (type === 'cICP' && len >= 4) r.field('PNG', 'Coding-independent code points', [0, 1, 2, 3].map((i) => d.u8at(i)).join(', '));
      else if (type === 'sBIT') r.field('PNG', 'Significant bits', [...data].join(', '));
      else if (type === 'bKGD') r.field('PNG', 'Background color', [...data].join(', '));
      else if (type === 'acTL' && len >= 8) { r.field('PNG', 'Animation', `${d.u32(0)} frames, ${d.u32(4) ? `${d.u32(4)} loops` : 'loops forever'}`); }
      else if (type === 'oFFs' && len >= 9) r.field('PNG', 'Image offset', `${d.i32(0)}, ${d.i32(4)}`);
      else if (type === 'sTER') r.field('PNG', 'Stereo image', 'Yes');
      else if (type === 'IEND') { sawIend = true; }
      else if (!IMAGE_CHUNKS.has(type)) {
        const ancillaryPrivate = type.charCodeAt(1) & 0x20 ? 'private ' : '';
        note = `${ancillaryPrivate}chunk, not decoded`;
        r.field('Other chunks', type, `${fmtBytes(len)}, not decoded`);
        // A critical chunk (uppercase first letter) is needed to display the image, so it is never removable.
        const critical = !(type.charCodeAt(0) & 0x20);
        r.block('Unknown chunk', o, len + 12, { container: type, decoded: false, ...(critical ? { removable: false } : {}) });
      }
    } catch (error) { r.warn(`PNG ${type} chunk could not be fully read (${error.message}).`); }
    if (type !== 'IDAT') r.struct(type, o, len + 12, note);
    o += 12 + len;
    if (sawIend) break;
  }
  if (idat) r.struct('IDAT', 0, idatBytes, `${idat} image data chunk${idat === 1 ? '' : 's'}, ${fmtBytes(idatBytes)}`);
  if (!sawIend) r.warn('The PNG ends without an IEND chunk. It may be truncated.');
  else if (b.length > o) {
    const extra = b.length - o;
    r.struct('Trailing data', o, extra);
    r.block('Trailer', o, extra, { decoded: false, note: 'Data after end of image' });
    r.field('File', 'Data after end of image', fmtBytes(extra), { flag: 'privacy' });
    r.signal('privacy', 'Hidden data after the image', `${fmtBytes(extra)} follow the PNG end marker. Image viewers do not show it.`, 'PNG trailer', 'hidden data after the image');
  }
}

const keyword = (data) => { const z = indexOfZero(data); return clean(latin1(data.subarray(0, z < 0 ? Math.min(79, data.length) : z))); };

async function itxt(data, r) {
  const z = indexOfZero(data); if (z < 0 || z + 3 > data.length) return '';
  const key = clean(latin1(data.subarray(0, z)));
  const compressed = data[z + 1] === 1;
  const langEnd = indexOfZero(data, z + 3); if (langEnd < 0) return key;
  const transEnd = indexOfZero(data, langEnd + 1); if (transEnd < 0) return key;
  let text = data.subarray(transEnd + 1);
  if (compressed) text = await r.inflate(text, 'an iTXt chunk');
  const value = utf8.decode(text);
  if (key === 'XML:com.adobe.xmp') parseXmp(value, r);
  else textEntry(r, 'PNG text', key, clean(value));
  return key;
}
