// Plain TIFF and BigTIFF: writes a new file holding each full page's image tags and its strips or tiles
// copied byte for byte. Metadata tags, metadata directories, reduced-resolution copies, sub-images and
// unreferenced bytes are left behind. Camera raw files are refused: their sub-images hold the photo.
import { Bytes } from '../../metadata/bytes.js';
import { enumValue } from '../../metadata/tags.js';
import { IMAGE_TAGS, TYPE_SIZE, readLayout, value } from '../../metadata/formats/tiff-layout.js';
import { Refusal } from '../index.js';

const OFFSETS = { 0x0111: 0x0117, 0x0144: 0x0145 };
const RAW_PHOTOMETRIC = new Set([32803, 34892]);

export function cleanTiff(u8, report, blocks) {
  let layout;
  try { layout = readLayout(u8); } catch { throw new Refusal('The TIFF directories could not be followed safely, so the file was left untouched.'); }
  const { le, big, pages } = layout;
  const ctx = { b: new Bytes(u8), le };
  const ints = (e) => { try { return value(ctx, e); } catch { throw new Refusal('A TIFF tag has a value this cleaner cannot read, so the file was left untouched.'); } };

  const all = []; const walk = (d) => { all.push(d); for (const s of d.subs) walk(s.dir); }; pages.forEach(walk);
  if (all.some((d) => d.tags.has(0xc612))) throw new Refusal('This is a DNG camera raw file. Raw files are not cleaned yet, so it was left untouched.');
  const kept = pages.filter((p, i) => i === 0 || !p.reduced);
  const area = (d) => (ints(d.tags.get(0x0100))?.[0] ?? 0) * (ints(d.tags.get(0x0101))?.[0] ?? 0);
  const keptArea = Math.max(...kept.map(area));
  if (all.filter((d) => !kept.includes(d)).some((d) => area(d) > keptArea)) throw new Refusal('This TIFF keeps a larger image in a sub-directory, as camera raw files do, so it was left untouched.');
  for (const page of kept) {
    const photometric = ints(page.tags.get(0x0106))?.[0];
    if (RAW_PHOTOMETRIC.has(photometric)) throw new Refusal('This TIFF holds camera raw sensor data. Raw files are not cleaned yet, so it was left untouched.');
    if (ints(page.tags.get(0x0103))?.[0] === 6) throw new Refusal('This TIFF uses old-style JPEG compression, which this cleaner cannot rewrite safely, so it was left untouched.');
    const strips = page.tags.has(0x0111); const tiles = page.tags.has(0x0144);
    if (strips === tiles || !page.tags.has(strips ? 0x0117 : 0x0145)) throw new Refusal('A TIFF page does not say where its image data is, so the file was left untouched.');
  }

  // Directories first get their entries, then each page is laid out as directory, values, image data.
  const renumber = kept.length < pages.length;
  const width = big ? 20 : 12; const head = big ? 8 : 2; const inline = big ? 8 : 4;
  const offsetType = big ? 16 : 4;
  let pos = big ? 16 : 8;
  const plan = kept.map((page, index) => {
    const entries = page.entries.filter((e) => IMAGE_TAGS.has(e.tag)).sort((a, c) => a.tag - c.tag).map((e) => {
      if (OFFSETS[e.tag]) return { tag: e.tag, type: offsetType, count: e.count, offsets: ints(e), lengths: ints(page.tags.get(OFFSETS[e.tag])) };
      if (e.tag === 0x0129 && renumber && e.type === 3 && e.count === 2) return { tag: e.tag, type: 3, count: 2, bytes: shorts([index, kept.length], le) };
      return { tag: e.tag, type: e.type, count: e.count, bytes: u8.subarray(e.valueAt, e.valueAt + e.size) };
    });
    pos += pos & 1;
    const at = pos; pos += head + entries.length * width + inline;
    for (const e of entries) {
      e.size = TYPE_SIZE[e.type] * e.count;
      if (e.size > inline) { pos += pos & 1; e.at = pos; pos += e.size; }
    }
    // Strips or tiles stored once and shared by several entries stay shared.
    const placed = new Map();
    for (const e of entries.filter((x) => x.offsets)) {
      e.moved = e.offsets.map((o, i) => {
        const key = `${o}:${e.lengths[i]}`;
        if (!placed.has(key)) { pos += pos & 1; placed.set(key, { from: o, length: e.lengths[i], to: pos }); pos += e.lengths[i]; }
        return placed.get(key).to;
      });
    }
    return { at, entries, data: [...placed.values()] };
  });
  if (!big && pos > 0xffffffff) throw new Refusal('The rewritten TIFF would be too large, so the file was left untouched.');

  const out = new Uint8Array(pos); const dv = view(out);
  const put = (o, v, size) => { if (size === 2) dv.setUint16(o, v, le); else if (size === 4) dv.setUint32(o, v, le); else setU64(dv, o, v, le); };
  out.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  put(2, big ? 43 : 42, 2);
  if (big) { put(4, 8, 2); put(6, 0, 2); put(8, plan[0].at, 8); } else put(4, plan[0].at, 4);
  plan.forEach((page, i) => {
    put(page.at, page.entries.length, big ? 8 : 2);
    page.entries.forEach((e, k) => {
      const o = page.at + head + k * width;
      put(o, e.tag, 2); put(o + 2, e.type, 2); put(o + 4, e.count, big ? 8 : 4);
      const field = o + (big ? 12 : 8);
      const target = e.size > inline ? e.at : field;
      if (e.size > inline) put(field, e.at, big ? 8 : 4);
      if (e.moved) e.moved.forEach((v, n) => put(target + n * TYPE_SIZE[e.type], v, TYPE_SIZE[e.type]));
      else out.set(e.bytes, target);
    });
    put(page.at + head + page.entries.length * width, plan[i + 1]?.at ?? 0, big ? 8 : 4);
    for (const d of page.data) out.set(u8.subarray(d.from, d.from + d.length), d.to);
  });

  const first = pages[0];
  const orientation = ints(first.tags.get(0x0112))?.[0] ?? 1;
  return {
    data: out,
    removed: blocks.map((x) => ({ kind: x.kind, container: x.container ?? '', bytes: x.length })),
    kept: [
      `${kept.length} page${kept.length === 1 ? '' : 's'} with ${kept.length === 1 ? 'its' : 'their'} image data unchanged`,
      ...(orientation > 1 ? [`Orientation (${enumValue('Orientation', orientation) ?? orientation})`] : []),
      ...(kept.some((p) => p.tags.has(0x8773)) ? ['ICC color profile'] : []),
    ],
  };
}

const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
function setU64(dv, o, v, le) { const hi = Math.floor(v / 2 ** 32); const lo = v >>> 0; dv.setUint32(o, le ? lo : hi, le); dv.setUint32(o + 4, le ? hi : lo, le); }
function shorts(list, le) { const out = new Uint8Array(list.length * 2); list.forEach((v, i) => view(out).setUint16(i * 2, v, le)); return out; }
