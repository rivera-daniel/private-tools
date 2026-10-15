// TIFF and BigTIFF, the camera raw formats built on TIFF (DNG, CR2, NEF, ARW, ORF, RW2, PEF), and Fujifilm RAF.
import { fmtBytes, hex } from '../bytes.js';
import { parseTiff } from '../tiff.js';
import { TIFF_TAGS } from '../tags.js';
import { parseJpeg } from './jpeg.js';
import { IMAGE_TAGS, SUB_DIRS, readLayout } from './tiff-layout.js';

const RAW = { 0x4f52: 'ORF', 0x5352: 'ORF', 0x55: 'RW2' };

export async function parseTiffFile(b, r) {
  const le = b.ascii(0, 2) === 'II';
  const magic = b.u16(2, le);
  r.format = RAW[magic] ?? (b.ascii(8, 2) === 'CR' ? 'CR2' : 'TIFF');
  r.struct('TIFF header', 0, magic === 43 ? 16 : 8);
  const dirs = r.block('EXIF', 0, b.length, { container: 'TIFF directories', removable: false, note: 'Metadata is interleaved with image directories' });
  r.within(dirs, () => parseTiff(b, r, { label: 'TIFF', at: 0 }));
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
  if (r.format === 'TIFF') r.within(dirs, () => tiffBlocks(b, r));
}

const KIND_BY_TAG = { 0x02bc: 'XMP', 0x83bb: 'IPTC', 0x8649: 'Photoshop', 0x935c: 'Photoshop', 0x927c: 'MakerNote', 0x8769: 'EXIF', 0x8825: 'EXIF', 0x014a: 'Thumbnail' };
const GEO_TAGS = new Set([0x830e, 0x8482, 0x85d8, 0x87af, 0x87b0, 0x87b1]);

// A plain TIFF's metadata is a set of tags among the image tags. Each tag outside the image tags, each
// metadata or preview directory and any data after the last referenced byte is a removable block, so the
// report says what the cleaner's rewrite drops.
function tiffBlocks(b, r) {
  let layout;
  // The cleaner cannot follow what this cannot read, so a damaged layout is reported as such and the file is refused.
  try { layout = readLayout(b.u8); } catch (error) { r.warn(`The TIFF directories are damaged (${error.message}).`); return; }
  const taken = r.blocks.filter((x) => x.removable !== false && Number.isInteger(x.offset)).map((x) => [x.offset, x.offset + x.length]);
  const add = (kind, at, length, container) => {
    if (!length || taken.some(([s, e]) => at < e && at + length > s)) return;
    taken.push([at, at + length]); r.block(kind, at, length, { container });
  };
  layout.pages.forEach((page, i) => {
    if (i > 0 && page.reduced) { add('Thumbnail', page.offset, page.size, `TIFF IFD${i} (reduced-resolution copy)`); return; }
    for (const e of page.entries) {
      if (IMAGE_TAGS.has(e.tag)) continue;
      const name = TIFF_TAGS[e.tag] ?? hex(e.tag);
      if (SUB_DIRS[e.tag]) { for (const s of page.subs.filter((x) => x.tag === e.tag)) add(KIND_BY_TAG[e.tag] ?? 'Tag', s.dir.offset, s.dir.size, `TIFF ${SUB_DIRS[e.tag]} directory`); continue; }
      const kind = KIND_BY_TAG[e.tag] ?? (GEO_TAGS.has(e.tag) ? 'Location' : e.type === 2 ? 'Text tag' : 'Tag');
      add(kind, e.inline ? e.at : e.valueAt, e.inline ? layout.entryWidth : e.size, `TIFF IFD${i} ${name}`);
    }
  });
  const tail = b.u8.subarray(layout.end);
  if (tail.length > 16 || tail.some((x) => x !== 0)) add('Trailer', layout.end, tail.length, 'TIFF data after the last referenced byte');
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
