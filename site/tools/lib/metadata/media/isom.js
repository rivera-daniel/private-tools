// ISO base media and QuickTime box tree, shared by the MP4 inspector and cleaner.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'mfra', 'tref', 'gmhd', 'udta']);
export const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
export const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
// PIFF and Smooth Streaming boxes that playback needs (encryption, fragment timing).
export const STRUCTURAL_UUIDS = new Set(['a2394f525a9b4f14a2446c427c648df4', '8974dbce7be74c5184f97148f9882554', 'd08a4f1810f34a82b6c832d8aba183d3', '6d1d9b0542d544e680e2141daff757b2', 'd4807ef2ca3946958e5426cb9e46a79f']);
// Top-level boxes that belong to the presentation itself.
export const TOP_STRUCTURAL = new Set(['ftyp', 'moov', 'mdat', 'moof', 'mfra', 'sidx', 'ssix', 'styp', 'emsg', 'prft', 'pdin', 'wide', 'free', 'skip', 'pnot', 'PICT', 'jp2h', 'meco', 'bloc']);
export const TIMED_METADATA = new Set(['gpmd', 'mebx', 'camm', 'mett', 'metx', 'urim', 'rtmd']);
export const LIMIT = { boxes: 100000, depth: 16, samples: 5000000 };

// end bounds the walk. Inside containers a zero size ends the list (QuickTime udta terminator); at the top
// level it means "to the end of the file".
export function readBoxes(b, start, end, top = false) {
  const list = []; let o = start;
  while (o + 8 <= end && list.length < 20000) {
    let size = b.u32(o); const type = b.ascii(o + 4, 4); let header = 8;
    if (size === 1) { if (o + 16 > end) break; size = b.u64(o + 8); header = 16; }
    else if (size === 0) { if (!top) break; size = end - o; }
    if (size < header || o + size > end) break;
    let uuid = '';
    if (type === 'uuid') { if (size < header + 16) break; uuid = [...b.slice(o + header, 16)].map((x) => x.toString(16).padStart(2, '0')).join(''); header += 16; }
    list.push({ type, uuid, offset: o, size, header, start: o + header, end: o + size, toEnd: b.u32(o) === 0 });
    o += size;
  }
  return { list, stop: o };
}

// QuickTime meta (Apple mdta) has no version and flags; ISO meta is a full box.
const metaStart = (b, box) => (b.has(box.start + 4, 4) && /^(hdlr|keys|ilst)$/.test(b.ascii(box.start + 4, 4)) ? box.start : box.start + 4);

export function buildTree(b) {
  const budget = { n: 0 };
  const { list, stop } = readBoxes(b, 0, b.length, true);
  for (const box of list) expand(b, box, null, 0, budget);
  return { boxes: list, stop, truncated: budget.n > LIMIT.boxes };
}

function expand(b, box, parent, depth, budget) {
  box.parent = parent;
  if (depth > LIMIT.depth || ++budget.n > LIMIT.boxes) return;
  let from = -1;
  if (CONTAINERS.has(box.type)) from = box.start;
  else if (box.type === 'meta') from = metaStart(b, box);
  else if (box.type === 'dref') from = box.start + 8;
  else if (box.type === 'ilst' || parent?.type === 'ilst') from = box.start;
  if (from < 0) return;
  box.children = readBoxes(b, from, box.end).list;
  for (const c of box.children) expand(b, c, box, depth + 1, budget);
}

export const kids = (box, type) => (box?.children ?? []).filter((c) => c.type === type);
export const kid = (box, type) => (box?.children ?? []).find((c) => c.type === type) ?? null;

// Handler type of a trak (mdia/hdlr) or meta box (hdlr). Full box: version/flags, pre_defined, handler.
export function handlerOf(b, box) {
  const hdlr = box.type === 'trak' ? kid(kid(box, 'mdia'), 'hdlr') : kid(box, 'hdlr');
  return hdlr && b.has(hdlr.start + 8, 4) ? b.ascii(hdlr.start + 8, 4) : '';
}

export function sampleEntry(b, trak) {
  const stsd = kid(kid(kid(kid(trak, 'mdia'), 'minf'), 'stbl'), 'stsd');
  if (!stsd || !b.has(stsd.start + 8, 8)) return null;
  const at = stsd.start + 8; const size = b.u32(at);
  if (size < 8 || at + size > stsd.end) return null;
  return { format: b.ascii(at + 4, 4), offset: at, start: at + 8, end: at + size };
}

// A track whose samples are timed metadata (GoPro telemetry, Apple location and face tracks, camera motion).
export function isTimedMetadata(b, trak) {
  const handler = handlerOf(b, trak);
  return handler === 'meta' || handler === 'camm' || TIMED_METADATA.has(sampleEntry(b, trak)?.format ?? '');
}

// Byte ranges of every sample in a trak, from its sample-to-chunk, size and chunk offset tables.
export function sampleRanges(b, trak) {
  const stbl = kid(kid(kid(trak, 'mdia'), 'minf'), 'stbl');
  if (!stbl) return [];
  const stsc = kid(stbl, 'stsc'); const stsz = kid(stbl, 'stsz'); const stco = kid(stbl, 'stco') ?? kid(stbl, 'co64');
  if (!stsc || !stsz || !stco) return [];
  const wide = stco.type === 'co64';
  const chunks = Math.min(b.u32(stco.start + 4), (stco.end - stco.start - 8) / (wide ? 8 : 4)) | 0;
  const runs = Math.min(b.u32(stsc.start + 4), (stsc.end - stsc.start - 8) / 12) | 0;
  const fixed = b.u32(stsz.start + 4); const count = Math.min(b.u32(stsz.start + 8), LIMIT.samples);
  if (!fixed && stsz.start + 12 + count * 4 > stsz.end) return [];
  const out = []; let sample = 0;
  for (let r = 0; r < runs; r++) {
    const first = b.u32(stsc.start + 8 + r * 12); const per = b.u32(stsc.start + 12 + r * 12);
    const next = r + 1 < runs ? b.u32(stsc.start + 8 + (r + 1) * 12) : chunks + 1;
    for (let c = first; c < next && c <= chunks; c++) {
      let at = wide ? b.u64(stco.start + 8 + (c - 1) * 8) : b.u32(stco.start + 8 + (c - 1) * 4);
      for (let k = 0; k < per && sample < count; k++, sample++) {
        const size = fixed || b.u32(stsz.start + 12 + sample * 4);
        out.push([at, at + size]); at += size;
        if (out.length > LIMIT.samples) return out;
      }
    }
  }
  return out;
}

// Creation and modification times in mvhd, tkhd and mdhd: [offset, width] of each non-zero value.
export function timeFields(b, box) {
  if (!b.has(box.start, 20)) return [];
  const v1 = b.u8at(box.start) === 1; const w = v1 ? 8 : 4; const at = box.start + 4;
  return [[at, w], [at + w, w]].filter(([o]) => (w === 8 ? b.u64(o) : b.u32(o)) !== 0);
}
