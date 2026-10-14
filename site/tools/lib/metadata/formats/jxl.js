// JPEG XL: either a bare codestream or an ISOBMFF-style container with Exif, xml and jumb boxes.
import { Bytes, utf8, fmtBytes, printable } from '../bytes.js';
import { parseTiff } from '../tiff.js';
import { parseXmp } from '../xmp.js';
import { parseJumbf } from '../c2pa.js';
import { boxes } from './isobmff.js';

export async function parseJxl(b, r) {
  r.format = 'JPEG XL';
  if (b.u8at(0) === 0xff && b.u8at(1) === 0x0a) {
    r.field('JPEG XL', 'Container', 'Bare codestream (no metadata boxes)');
    r.struct('Codestream', 0, b.length);
    readSize(b.sub(2, 64), r);
    return;
  }
  r.field('JPEG XL', 'Container', 'ISO BMFF container');
  let codestreamSeen = false;
  for (const box of boxes(b, 0, b.length)) {
    const data = () => b.sub(box.start, box.end - box.start);
    let note = '';
    try {
      if ((box.type === 'jxlc' || box.type === 'jxlp') && !codestreamSeen) {
        const d = data(); const skip = box.type === 'jxlp' ? 4 : 0;
        if (d.u8at(skip) === 0xff && d.u8at(skip + 1) === 0x0a) { readSize(d.sub(skip + 2, 64), r); codestreamSeen = true; }
        note = 'Codestream';
      } else if (box.type === 'Exif') { note = 'EXIF'; const d = data(); const skip = 4 + d.u32(0); r.within(r.block('EXIF', box.offset, box.size, { container: 'Exif box' }), () => parseTiff(d.sub(skip, d.length - skip), r, { label: 'EXIF', at: box.start + skip })); }
      else if (box.type === 'xml ') { note = 'XMP'; parseXmp(utf8.decode(data().u8), r); r.block('XMP', box.offset, box.size, { container: 'xml box' }); }
      else if (box.type === 'jumb') { note = 'JUMBF'; parseJumbf(new Bytes(b.slice(box.offset, box.size)), r, { at: box.offset }); }
      else if (box.type === 'brob') {
        const inner = printable(b.ascii(box.start, 4));
        note = `Brotli-compressed ${inner} box, not decoded`;
        r.field('JPEG XL', `Compressed ${inner} box`, `${fmtBytes(box.size)}. Brotli decompression is not available in browsers, so its contents are not shown.`);
        r.block(inner === 'Exif' ? 'EXIF' : inner === 'xml ' ? 'XMP' : 'Compressed metadata', box.offset, box.size, { container: 'brob', decoded: false, note: inner });
      } else if (box.type === 'jbrd') { note = 'JPEG reconstruction data'; r.field('JPEG XL', 'JPEG reconstruction', `Present (${fmtBytes(box.size)}). The original JPEG, including its metadata, can be rebuilt.`); }
      else if (box.type === 'ftyp') r.field('JPEG XL', 'Brand', printable(b.ascii(box.start, 4)));
      else if (box.type === 'jxll') r.field('JPEG XL', 'Conformance level', String(b.u8at(box.start)));
      else if (!['JXL ', 'jxlc', 'jxlp', 'ftyp'].includes(box.type)) { note = 'Not decoded'; r.field('Other boxes', box.type, `${fmtBytes(box.size)}, not decoded`); }
    } catch (error) { r.warn(`JPEG XL ${box.type} box could not be fully read (${error.message}).`); }
    r.struct(box.type, box.offset, box.size, note);
  }
}

// SizeHeader from the codestream, read least-significant bit first.
function readSize(b, r) {
  let bit = 0;
  const u = (n) => { let v = 0; for (let i = 0; i < n; i++) { const byte = b.u8at(bit >> 3); v |= ((byte >> (bit & 7)) & 1) << i; bit++; } return v >>> 0; };
  const u32 = () => { const sel = u(2); return [() => 1 + u(9), () => 1 + u(13), () => 1 + u(18), () => 1 + u(30)][sel](); };
  try {
    const small = u(1);
    const height = small ? (u(5) + 1) * 8 : u32();
    const ratio = u(3);
    const ratios = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];
    const width = ratio ? Math.floor((height * ratios[ratio][0]) / ratios[ratio][1]) : small ? (u(5) + 1) * 8 : u32();
    r.width = width; r.height = height;
  } catch { r.warn('JPEG XL image size could not be read.'); }
}
