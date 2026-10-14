// TIFF and BigTIFF, the camera raw formats built on TIFF (DNG, CR2, NEF, ARW, ORF, RW2, PEF), and Fujifilm RAF.
import { fmtBytes } from '../bytes.js';
import { parseTiff } from '../tiff.js';
import { parseJpeg } from './jpeg.js';

const RAW = { 0x4f52: 'ORF', 0x5352: 'ORF', 0x55: 'RW2' };

export async function parseTiffFile(b, r) {
  const le = b.ascii(0, 2) === 'II';
  const magic = b.u16(2, le);
  r.format = RAW[magic] ?? (b.ascii(8, 2) === 'CR' ? 'CR2' : 'TIFF');
  r.struct('TIFF header', 0, magic === 43 ? 16 : 8);
  r.within(r.block('EXIF', 0, b.length, { container: 'TIFF directories', removable: false, note: 'Metadata is interleaved with image directories' }), () => parseTiff(b, r, { label: 'TIFF', at: 0 }));
  const ifd0 = r.sources.get('TIFF IFD0') ?? [];
  const get = (k) => ifd0.find((f) => f.key === k)?.value;
  if (r.format === 'TIFF') {
    if (get('DNGVersion')) r.format = 'DNG';
    else if (/^NIKON/i.test(get('Make') ?? '')) r.format = 'NEF';
    else if (/^SONY/i.test(get('Make') ?? '') && hasSubIfd(r)) r.format = 'ARW';
    else if (/^(PENTAX|RICOH)/i.test(get('Make') ?? '') && hasSubIfd(r)) r.format = 'PEF';
  }
  // The full-resolution image is the largest directory; IFD0 is often a preview.
  let best = 0;
  for (const [name, fields] of r.sources) {
    if (!/^TIFF (IFD\d+|SubIFD\d*)$/.test(name)) continue;
    const w = Number(fields.find((f) => f.key === 'ImageWidth')?.value); const h = Number(fields.find((f) => f.key === 'ImageLength')?.value);
    if (w * h > best) { best = w * h; r.width = w; r.height = h; }
  }
  // Panasonic RW2 stores sensor size in its own IFD0 tags.
  if (r.format === 'RW2') { const w = Number(get('0x0002')); const h = Number(get('0x0003')); if (w && h) { r.width = w; r.height = h; } }
  const pages = [...r.sources.keys()].filter((k) => /^TIFF IFD\d+$/.test(k)).length;
  if (pages > 1) r.field('TIFF', 'Pages or sub-images', String(pages));
  if (r.embeddedJpeg) await parseEmbeddedJpeg(b, r, r.embeddedJpeg.at, r.embeddedJpeg.size, 'Embedded JPEG (JpgFromRaw)');
}

const hasSubIfd = (r) => [...r.sources.keys()].some((k) => k.startsWith('TIFF SubIFD'));

// Parses a JPEG stored inside another file and shifts its offsets to file positions.
async function parseEmbeddedJpeg(b, r, at, length, label) {
  if (!b.has(at, length)) { r.warn(`The ${label.toLowerCase()} is out of range.`); return; }
  const { format, width, height } = r;
  const blocksBefore = r.blocks.length; const structBefore = r.structure.length;
  r.struct(label, at, length);
  await parseJpeg(b.sub(at, length), r);
  for (const x of [...r.blocks.slice(blocksBefore), ...r.structure.slice(structBefore + 1)]) if (x.offset !== undefined) x.offset += at;
  r.format = format;
  if (width) { r.width = width; r.height = height; }
}

// RAF: a Fujifilm header pointing at an embedded JPEG preview that carries the EXIF, plus a raw directory.
export async function parseRaf(b, r) {
  r.format = 'RAF';
  r.field('RAF', 'Camera', b.ascii(28, 32).replace(/\0.*$/, ''));
  r.struct('RAF header', 0, 100);
  const jpegAt = b.u32(84); const jpegLen = b.u32(88);
  await parseEmbeddedJpeg(b, r, jpegAt, jpegLen, 'Embedded JPEG preview');
  r.width = null; r.height = null;
  try {
    const dirAt = b.u32(92); const count = Math.min(b.u32(dirAt), 500); let o = dirAt + 4;
    for (let i = 0; i < count && b.has(o, 4); i++) {
      const tag = b.u16(o); const size = b.u16(o + 2);
      if (tag === 0x0100 && size >= 4) { r.height = b.u16(o + 4); r.width = b.u16(o + 6); }
      o += 4 + size;
    }
  } catch { r.warn('The RAF raw directory could not be read.'); }
  r.field('RAF', 'Preview', `${fmtBytes(jpegLen)} JPEG; its metadata is listed below`);
}
