// The directory structure of a plain TIFF or BigTIFF file: its pages, every entry with the place its value
// is stored, the image data each directory points at, and the last byte anything refers to. The TIFF block
// report and the Metadata Cleaner's TIFF rewrite share it. Throws on structure it cannot follow.
import { Bytes, LIMITS } from '../bytes.js';

export const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

// Tags a page needs to be decoded and displayed the same way. The cleaner keeps these and drops every other tag.
export const IMAGE_TAGS = new Set([
  0x00fe, 0x00ff, 0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0107, 0x0108, 0x0109, 0x010a, 0x0111, 0x0112, 0x0115, 0x0116, 0x0117,
  0x0118, 0x0119, 0x011a, 0x011b, 0x011c, 0x011e, 0x011f, 0x0122, 0x0123, 0x0124, 0x0125, 0x0128, 0x0129, 0x012d, 0x013d, 0x013e,
  0x013f, 0x0140, 0x0141, 0x0142, 0x0143, 0x0144, 0x0145, 0x014c, 0x014d, 0x014e, 0x0150, 0x0152, 0x0153, 0x0154, 0x0155, 0x015b,
  0x0211, 0x0212, 0x0213, 0x0214, 0x8773,
]);
// Tags whose values point at other directories.
export const SUB_DIRS = { 0x8769: 'Exif', 0x8825: 'GPS', 0xa005: 'Interop', 0x014a: 'SubIFD' };
const MAX_VALUES = 1 << 20;

export function readLayout(u8) {
  const b = new Bytes(u8);
  const order = b.ascii(0, 2);
  if (order !== 'II' && order !== 'MM') throw new Error('not a TIFF file');
  const le = order === 'II';
  const magic = b.u16(2, le);
  if (magic !== 42 && magic !== 43) throw new Error('not a plain TIFF file');
  const big = magic === 43;
  if (big && (b.u16(4, le) !== 8 || b.u16(6, le) !== 0)) throw new Error('unsupported BigTIFF header');
  const ctx = { b, le, big, seen: new Set(), count: 0, end: big ? 16 : 8 };
  const pages = [];
  let next = big ? b.u64(8, le) : b.u32(4, le);
  while (next) {
    const dir = readDir(ctx, next, 0);
    dir.reduced = ((value(ctx, dir.tags.get(0x00fe))?.[0] ?? 0) & 1) === 1 || value(ctx, dir.tags.get(0x00ff))?.[0] === 2;
    pages.push(dir);
    next = dir.next;
  }
  if (!pages.length) throw new Error('no image directory');
  return { le, big, pages, end: ctx.end, entryWidth: big ? 20 : 12 };
}

// One directory with its sub-directories. size covers the entry count, the entries and the next-directory link.
function readDir(ctx, offset, depth) {
  const { b, le, big } = ctx;
  if (!Number.isInteger(offset) || ctx.seen.has(offset)) throw new Error('directory loop');
  if (++ctx.count > LIMITS.maxIfds) throw new Error('too many directories');
  if (depth > 3) throw new Error('directories nested too deeply');
  ctx.seen.add(offset);
  const head = big ? 8 : 2; const width = big ? 20 : 12; const inline = big ? 8 : 4;
  const n = big ? b.u64(offset, le) : b.u16(offset, le);
  if (n > LIMITS.maxIfdEntries) throw new Error('directory too large');
  const size = head + n * width + inline;
  if (!b.has(offset, size)) throw new Error('directory past the end');
  grow(ctx, offset + size);
  const entries = []; const tags = new Map();
  for (let i = 0; i < n; i++) {
    const at = offset + head + i * width;
    const tag = b.u16(at, le); const type = b.u16(at + 2, le); const count = big ? b.u64(at + 4, le) : b.u32(at + 4, le);
    const unit = TYPE_SIZE[type];
    const field = at + (big ? 12 : 8);
    const bytes = unit ? unit * count : 0;
    const isInline = bytes <= inline;
    const valueAt = isInline ? field : (big ? b.u64(field, le) : b.u32(field, le));
    if (!unit && IMAGE_TAGS.has(tag)) throw new Error('unknown value type');
    if (unit && !b.has(valueAt, bytes)) throw new Error('value past the end');
    if (unit && !isInline) grow(ctx, valueAt + bytes);
    const e = { tag, type, count, at, valueAt, size: bytes, inline: isInline };
    entries.push(e);
    if (tags.has(tag)) throw new Error('repeated tag');
    tags.set(tag, e);
  }
  const dir = { offset, size, entries, tags, next: big ? b.u64(offset + head + n * width, le) : b.u32(offset + head + n * width, le), subs: [] };
  for (const e of entries) {
    if (!SUB_DIRS[e.tag] || !TYPE_SIZE[e.type] || ![4, 13, 16, 18].includes(e.type)) continue;
    for (const at of value(ctx, e)) if (at) dir.subs.push({ tag: e.tag, dir: readDir(ctx, at, depth + 1) });
  }
  dir.data = dataRanges(ctx, dir);
  for (const [s, len] of dir.data) grow(ctx, s + len);
  return dir;
}

// Integer values of a SHORT, LONG, LONG8 or IFD entry, every one of them.
export function value(ctx, e) {
  if (!e) return null;
  const { b, le } = ctx;
  if (e.count > MAX_VALUES) throw new Error('too many values');
  const out = [];
  for (let i = 0; i < e.count; i++) {
    if (e.type === 3) out.push(b.u16(e.valueAt + i * 2, le));
    else if (e.type === 4 || e.type === 13) out.push(b.u32(e.valueAt + i * 4, le));
    else if (e.type === 16 || e.type === 18) out.push(b.u64(e.valueAt + i * 8, le));
    else if (e.type === 1) out.push(b.u8at(e.valueAt + i));
    else throw new Error('not an integer entry');
  }
  return out;
}

// [offset, length] pairs of the image data a directory points at: strips, tiles or an old-style JPEG stream.
function dataRanges(ctx, dir) {
  const pairs = [[0x0111, 0x0117], [0x0144, 0x0145], [0x0201, 0x0202]];
  const out = [];
  for (const [o, l] of pairs) {
    const offs = value(ctx, dir.tags.get(o)); const lens = value(ctx, dir.tags.get(l));
    if (!offs && !lens) continue;
    if (!offs || !lens || offs.length !== lens.length) throw new Error('image data offsets and lengths do not match');
    offs.forEach((s, i) => { if (!ctx.b.has(s, lens[i])) throw new Error('image data past the end'); out.push([s, lens[i]]); });
  }
  return out;
}

function grow(ctx, end) { if (end > ctx.end) ctx.end = end; }
