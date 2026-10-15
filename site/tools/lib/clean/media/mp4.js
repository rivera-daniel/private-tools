// MP4, MOV, M4A and 3GP: drops metadata boxes and timed metadata tracks, zeroes header times and leftover
// free-space bytes, then fixes every box size and chunk offset the removals moved. Samples are never touched,
// except that the samples of a removed metadata track are overwritten with zeros.
import { Bytes, concat } from '../../metadata/bytes.js';
import { buildTree, sampleRanges, timeFields } from '../../metadata/media/isom.js';
import { Refusal } from '../index.js';

const BOX_KINDS = new Set(['User data', 'Metadata', 'XMP', 'C2PA', 'Vendor data', 'Unknown box']);

export function cleanMp4(u8, report, blocks) {
  const b = new Bytes(u8);
  const tree = buildTree(b);
  if (tree.truncated) throw new Refusal('The file has too many boxes to rewrite safely, so it was left untouched.');
  const all = []; const walk = (list) => { for (const x of list) { all.push(x); if (x.children) walk(x.children); } }; walk(tree.boxes);
  const at = new Map(all.map((x) => [x.offset, x]));
  const mdats = tree.boxes.filter((x) => x.type === 'mdat');
  const removes = []; const zeros = []; const dropped = new Set(); let dates = false; let trailer = null;

  for (const blk of blocks) {
    const box = at.get(blk.offset);
    if (blk.kind === 'Dates') dates = true;
    else if (blk.kind === 'Trailer') trailer = [blk.offset, u8.length];
    else if (blk.kind === 'Padding') { if (!box) throw locate(); zeros.push([box.start, box.end]); }
    else if (blk.kind === 'Data reference') removes.push([blk.offset, blk.offset + blk.length]);
    else if (blk.kind === 'Metadata track') {
      if (!box || box.type !== 'trak') throw locate();
      dropped.add(box); removes.push([box.offset, box.end]);
      for (const [s, e] of sampleRanges(b, box)) {
        if (e <= s) continue;
        if (!mdats.some((m) => s >= m.start && e <= m.end)) throw new Refusal('A metadata track stores samples outside the media data, so the file was left untouched.');
        zeros.push([s, e]);
      }
    } else if (BOX_KINDS.has(blk.kind)) { if (!box || box.size !== blk.length) throw locate(); removes.push([box.offset, box.end]); }
    else throw new Refusal(`The cleaner does not know how to remove ${blk.kind} from this file, so it was left untouched.`);
  }

  // References from kept tracks to removed ones go too, and a track reference box left empty goes with them.
  const idOf = (trak) => { const t = trak.children?.find((c) => c.type === 'tkhd'); return t && b.has(t.start, 24) ? b.u32(t.start + (b.u8at(t.start) === 1 ? 20 : 12)) : -1; };
  const droppedIds = new Set([...dropped].map(idOf));
  for (const trak of all.filter((x) => x.type === 'trak' && !dropped.has(x))) {
    const tref = trak.children?.find((c) => c.type === 'tref');
    if (!tref || !droppedIds.size) continue;
    const stale = (tref.children ?? []).filter((ref) => { for (let o = ref.start; o + 4 <= ref.end; o += 4) if (droppedIds.has(b.u32(o))) return true; return false; });
    if (stale.length === tref.children.length) removes.push([tref.offset, tref.end]);
    else for (const ref of stale) removes.push([ref.offset, ref.end]);
  }

  // The trailer stays a cut of its own: merged with a box that ends where it starts, its bytes would hide
  // that box's removal from the parent's size.
  const cuts = [...merge(removes), ...(trailer ? [trailer] : [])];
  const inCut = (o) => cuts.some(([s, e]) => o >= s && o < e);
  const kept = all.filter((x) => !inCut(x.offset));
  const before = prefix(cuts);
  const trailing = cuts.length && cuts.at(-1)[1] === u8.length && cuts.at(-1)[0] >= tree.stop ? cuts.at(-1)[0] : Infinity;
  const inner = cuts.filter(([s]) => s < trailing);

  // Absolute offsets this rewrite cannot follow.
  if (inner.length) {
    const lastData = Math.max(0, ...mdats.map((m) => m.end));
    if (kept.some((x) => x.type === 'saio' && x.parent?.type === 'stbl') && inner.some(([s]) => s < lastData)) throw new Refusal('The file uses encryption offsets this cleaner cannot adjust, so it was left untouched.');
    if (kept.some((x) => x.type === 'iloc')) throw new Refusal('The file holds image items whose offsets this cleaner cannot adjust, so it was left untouched.');
    const sidx = kept.find((x) => x.type === 'sidx' && !x.parent);
    if (sidx && inner.some(([s]) => s > sidx.offset)) throw new Refusal('The file has a segment index that removing boxes would invalidate, so it was left untouched.');
  }

  const out = new Uint8Array(u8); const view = new DataView(out.buffer);
  for (const [s, e] of zeros) out.fill(0, s, e);
  if (dates) for (const x of kept) if (['mvhd', 'tkhd', 'mdhd'].includes(x.type)) for (const [o, w] of timeFields(b, x)) out.fill(0, o, o + w);

  // Box sizes: every kept box shrinks by the bytes cut from inside it.
  for (const x of kept) {
    const inside = cuts.reduce((n, [s, e]) => n + (s >= x.offset && e <= x.end && !(s === x.offset && e === x.end) ? e - s : 0), 0);
    if (!inside || x.toEnd) continue;
    if (x.header >= 16 && view.getUint32(x.offset) === 1) setU64(view, x.offset + 8, x.size - inside);
    else view.setUint32(x.offset, x.size - inside);
  }

  // File offsets: chunk offset tables, absolute fragment base offsets and fragment random access entries.
  // Runs even when only a trailer goes: a chunk offset inside any cut means the cut holds media data.
  const move = (v) => { if (inCut(v)) throw new Refusal('Media data would have been removed, so the file was left untouched.'); return v - shift(before, v); };
  const inData = (v) => mdats.some((m) => v >= m.start && v < m.end);
  // Offsets into another file (external data references) or outside the media data cannot be moved safely.
  for (const x of kept) if (x.parent?.type === 'dref' && !(b.u24(x.start + 1) & 1)) throw new Refusal('A track keeps its media in another file, so this file was left untouched.');
  // Every kept sample must sit wholly inside the media data, or its tables are damaged.
  for (const trak of kept.filter((x) => x.type === 'trak')) for (const [s, e] of sampleRanges(b, trak)) if (!mdats.some((m) => s >= m.start && e <= m.end)) throw new Refusal('A sample table points outside the media data, so the file was left untouched.');
  {
    for (const x of kept) {
      if (x.type === 'stco' || x.type === 'co64') {
        const wide = x.type === 'co64'; const n = b.u32(x.start + 4);
        if (x.start + 8 + n * (wide ? 8 : 4) > x.end) throw new Refusal('A chunk offset table is malformed, so the file was left untouched.');
        for (let i = 0; i < n; i++) {
          const o = x.start + 8 + i * (wide ? 8 : 4); const v = wide ? b.u64(o) : b.u32(o);
          if (!inData(v)) throw new Refusal('A chunk offset points outside the media data, so the file was left untouched.');
          if (wide) setU64(view, o, move(v)); else view.setUint32(o, move(v));
        }
      } else if (x.type === 'tfhd' && b.u24(x.start + 1) & 1) setU64(view, x.start + 8, move(b.u64(x.start + 8)));
      else if (x.type === 'tfra') {
        const v1 = b.u8at(x.start) === 1; const sizes = b.u32(x.start + 8); const n = b.u32(x.start + 12);
        const rest = (((sizes >> 4) & 3) + 1) + (((sizes >> 2) & 3) + 1) + ((sizes & 3) + 1); const step = (v1 ? 16 : 8) + rest;
        if (x.start + 16 + n * step > x.end) throw new Refusal('A fragment index is malformed, so the file was left untouched.');
        for (let i = 0; i < n; i++) { const o = x.start + 16 + i * step + (v1 ? 8 : 4); if (v1) setU64(view, o, move(b.u64(o))); else view.setUint32(o, move(b.u32(o))); }
      }
    }
  }

  const parts = []; let from = 0;
  for (const [s, e] of cuts) { parts.push(out.subarray(from, s)); from = e; }
  parts.push(out.subarray(from));
  return { data: concat(parts), removed: blocks.map((blk) => ({ kind: blk.kind, container: blk.container ?? '', bytes: blk.kind === 'Dates' || blk.kind === 'Padding' ? 0 : blk.length })), kept: [...keptList(b, kept, dropped), ...report.blocks.filter((x) => x.kind === 'Metadata track' && x.removable === false).map((x) => `${x.container}: timed metadata${x.note ? ` (${x.note})` : ''}, kept because the file is fragmented`)] };
}

function keptList(b, kept, dropped) {
  const tracks = kept.filter((x) => x.type === 'trak' && !dropped.has(x)).length;
  return [`${tracks} track${tracks === 1 ? '' : 's'} with their samples unchanged`, 'Track and codec descriptions'];
}

const locate = () => new Refusal('A metadata block could not be located safely, so the file was left untouched.');
function merge(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, c) => a[0] - c[0]); const out = [];
  for (const r of sorted) { const last = out.at(-1); if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r]); }
  return out;
}
function prefix(cuts) { let n = 0; return cuts.map(([s, e]) => { n += e - s; return [s, n]; }); }
// Bytes removed before offset v (v itself is not inside a cut).
function shift(before, v) { let lo = 0; let hi = before.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (before[mid][0] < v) lo = mid + 1; else hi = mid; } return lo ? before[lo - 1][1] : 0; }
function setU64(view, o, v) { view.setUint32(o, Math.floor(v / 2 ** 32)); view.setUint32(o + 4, v >>> 0); }
