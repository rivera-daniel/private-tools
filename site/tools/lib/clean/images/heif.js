// HEIC, HEIF and AVIF: drops the Exif, XMP and other metadata items, thumbnails and the images that only
// serve them, then writes the item tables again with every remaining offset moved to where its data now
// is. Coded image data is copied byte for byte. Grids, overlays, alpha, depth and gain maps stay.
import { Bytes, concat, latin1 } from '../../metadata/bytes.js';
import { AUX_TYPES, boxes } from '../../metadata/formats/isobmff.js';
import { Refusal } from '../index.js';

const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
// Items that hold metadata rather than pictures.
const META_TYPES = new Set(['Exif', 'mime', 'uri ']);
// References that mean "this item belongs to that one": the item goes when its targets go.
const ATTACHED = new Set(['thmb', 'cdsc', 'auxl']);
// References from an image to the items it is built from or paired with: those items stay with it.
const FOLLOWED = new Set(['dimg', 'base', 'prem']);
const SEQUENCE = new Set(['moov', 'moof', 'mini', 'sidx', 'ssix', 'meco']);
// Auxiliary images by the name the inspector gives their type: [pattern, name, why it stays].
const AUX = [
  [/^Depth/, 'Depth map', 'kept for display. Depth maps can reveal the outline of people in portrait photos'],
  [/matte/i, null, 'kept for display. Mattes trace the outline of people, skin, hair or sky'],
  [/gain map/i, null, 'kept because removing it would flatten the HDR picture'],
  [/^Alpha/, 'Alpha channel', 'part of the picture'],
];
const fail = (message) => { throw new Refusal(`${message}, so the file was left untouched.`); };

export function cleanHeif(u8, report, blocks) {
  const b = new Bytes(u8);
  const top = [...boxes(b, 0, b.length)];
  if (top.some((x) => SEQUENCE.has(x.type))) fail('The file holds an image sequence or a compact header this cleaner cannot rewrite');
  const metas = top.filter((x) => x.type === 'meta');
  if (metas.length !== 1) fail('The file does not have exactly one item table');
  const metaBox = metas[0];
  const m = readMeta(b, metaBox);
  const dropTop = new Set(top.filter((x) => x.type === 'uuid' && x.uuid === C2PA_UUID));

  // Items kept: the primary image, grouped images and standalone items, then everything they need.
  const ids = new Set([...m.infos.keys(), ...m.locs.keys()]);
  if (m.primary === null || !ids.has(m.primary)) fail('The file names no primary image');
  const from = (id) => m.refs.filter((r) => r.from === id);
  const isMeta = (id) => META_TYPES.has(m.infos.get(id)?.type);
  const referenced = new Set(m.refs.flatMap((r) => r.to));
  const kept = new Set([m.primary, ...[...m.grouped].filter((id) => ids.has(id))]);
  for (const id of ids) {
    if (isMeta(id)) continue;
    const out = from(id);
    const unknown = out.some((r) => !ATTACHED.has(r.type) && !FOLLOWED.has(r.type));
    if (unknown || (!referenced.has(id) && !out.some((r) => ATTACHED.has(r.type)))) kept.add(id);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const r of m.refs) {
      const add = (id) => { if (ids.has(id) && !kept.has(id)) { kept.add(id); grew = true; } };
      if (kept.has(r.from) && !ATTACHED.has(r.type)) r.to.forEach(add);
      if (r.type === 'auxl' && !isMeta(r.from) && r.to.some((t) => kept.has(t))) add(r.from);
    }
  }
  if ([...kept].some(isMeta)) fail('A metadata item is needed by an image');
  if ([...kept].some((id) => from(id).some((r) => r.type === 'thmb'))) fail('A thumbnail is also used as a picture');
  const removed = new Set([...ids].filter((id) => !kept.has(id)));

  // Every block the inspector listed must be something this rewrite drops.
  const xmlBoxes = new Set(m.children.filter((c) => c.type === 'xml ' || c.type === 'bxml').map((c) => c.offset));
  for (const blk of blocks) {
    const item = /^HEIF item (\d+)$/.exec(blk.container ?? '');
    if (item && removed.has(Number(item[1]))) continue;
    if (blk.container === 'meta xml' && xmlBoxes.has(blk.offset)) continue;
    if (blk.container === 'uuid box' && [...dropTop].some((x) => x.offset === blk.offset)) continue;
    fail(`The cleaner does not know how to remove ${blk.kind} from this file`);
  }

  for (const id of ids) {
    const loc = m.locs.get(id);
    if (!loc) continue;
    if (loc.dri !== 0) fail('An image keeps its data in another file');
    if (loc.extents.some((e) => e.length === 0)) fail('An item extends to the end of the file');
    if (kept.has(id) && loc.method > 1) fail('An image is built from another item\'s data in a way this cleaner cannot adjust');
    if (loc.method === 1 && !m.idat) fail('An item points into a missing data box');
  }
  const extents = (set, method) => [...set].flatMap((id) => { const l = m.locs.get(id); return l && l.method === method ? l.extents.map((e) => [l.base + e.offset, l.base + e.offset + e.length]) : []; });

  // Bytes cut from the item data box and from the media data boxes.
  const idatSize = m.idat ? m.idat.end - m.idat.start : 0;
  const idatCuts = merge(extents(removed, 1));
  const idatKept = extents(kept, 1);
  for (const [s, e] of [...idatCuts, ...idatKept]) if (s < 0 || e > idatSize) fail('An item points outside its data box');
  if (overlaps(idatCuts, idatKept)) fail('Metadata shares bytes with an image');
  const fileCuts = merge(extents(removed, 0));
  const fileKept = extents(kept, 0);
  const mdats = top.filter((x) => x.type === 'mdat');
  const boxOf = (s, e) => top.find((x) => s >= x.start && e <= x.end);
  for (const [s, e] of fileCuts) if (!mdats.some((x) => s >= x.start && e <= x.end)) fail('Metadata is stored outside the media data');
  for (const [s, e] of fileKept) { const x = boxOf(s, e); if (!x || x === metaBox || dropTop.has(x)) fail('An image points outside the file\'s data'); }
  if (overlaps(fileCuts, fileKept)) fail('Metadata shares bytes with an image');

  // The new file: pieces of the old one in order, with the item table and changed box headers rebuilt.
  const pieces = [];
  const copy = (s, e) => { if (e > s) pieces.push({ s, e }); };
  for (const x of top) {
    if (dropTop.has(x)) continue;
    if (x === metaBox) { pieces.push({ meta: true }); continue; }
    const cuts = x.type === 'mdat' ? fileCuts.filter(([s]) => s >= x.start && s < x.end) : [];
    if (!cuts.length) { copy(x.offset, x.end); continue; }
    const cut = cuts.reduce((n, [s, e]) => n + e - s, 0);
    if (cut === x.end - x.start && fileKept.every(([s]) => s < x.start || s >= x.end)) continue;
    const head = new Uint8Array(u8.subarray(x.offset, x.start));
    const hv = new DataView(head.buffer);
    if (hv.getUint32(0) === 1) setU64(hv, 8, x.size - cut);
    else if (hv.getUint32(0) !== 0) hv.setUint32(0, x.size - cut);
    pieces.push({ s: x.offset, e: x.start, bytes: head });
    let at = x.start;
    for (const [s, e] of cuts) { copy(at, s); at = e; }
    copy(at, x.end);
  }
  const lastEnd = top.length ? top.at(-1).end : 0;
  copy(lastEnd, u8.length);

  const same = (v) => v;
  const metaSize = buildMeta(m, kept, removed, same, same).length;
  let pos = 0;
  for (const p of pieces) { p.to = pos; pos += p.meta ? metaSize : p.e - p.s; }
  const mapped = pieces.filter((p) => !p.meta);
  const mapFile = (v) => {
    let lo = 0; let hi = mapped.length - 1; let hit = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (mapped[mid].s <= v) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
    if (hit < 0) return 0;
    const p = mapped[hit];
    return p.to + Math.min(v, p.e) - p.s;
  };
  const mapIdat = (v) => v - idatCuts.reduce((n, [s, e]) => n + (e <= v ? e - s : s < v ? v - s : 0), 0);
  const meta = buildMeta(m, kept, removed, mapFile, mapIdat);
  if (meta.length !== metaSize) fail('The item table could not be rebuilt');
  const data = concat(pieces.map((p) => (p.meta ? meta : p.bytes ?? u8.subarray(p.s, p.e))));

  return { data, removed: removedList(m, blocks, removed), kept: keptList(m, kept, report) };
}

// ---------- Reading the item table ----------

function readMeta(b, box) {
  const children = [...boxes(b, box.start + 4, box.end)];
  if ((children.at(-1)?.end ?? box.start + 4) !== box.end) fail('The item table is damaged');
  const m = { source: b.u8, head: b.slice(box.start, 4), children, infos: new Map(), locs: new Map(), refs: [], props: [], ipmas: [], grouped: new Set(), primary: null, idat: null };
  for (const c of children) {
    const version = b.u8at(c.start); const body = c.start + 4;
    if (c.type === 'pitm') m.primary = version ? b.u32(body) : b.u16(body);
    else if (c.type === 'iinf') readIinf(b, c, m);
    else if (c.type === 'iloc') readIloc(b, c, m);
    else if (c.type === 'iref') readIref(b, c, m);
    else if (c.type === 'iprp') readIprp(b, c, m);
    else if (c.type === 'idat') m.idat = c;
    else if (c.type === 'grpl') for (const g of boxes(b, c.start, c.end)) { const n = b.u32(g.start + 8); for (let i = 0; i < Math.min(n, 10000); i++) m.grouped.add(b.u32(g.start + 12 + i * 4)); }
  }
  if (!m.iinf || !m.iloc) fail('The file has no item table');
  return m;
}

function readIinf(b, c, m) {
  const version = b.u8at(c.start);
  m.iinf = { version, head: b.slice(c.start, 4) };
  for (const infe of boxes(b, c.start + 4 + (version ? 4 : 2), c.end)) {
    if (infe.type !== 'infe') continue;
    const v = b.u8at(infe.start);
    if (v < 2) fail('The item table uses an old layout');
    let o = infe.start + 4;
    const id = v === 2 ? b.u16(o) : b.u32(o); o += (v === 2 ? 2 : 4) + 2;
    const type = b.ascii(o, 4);
    m.infos.set(id, { type, box: infe });
    if (m.infos.size > 10000) fail('The file has too many items');
  }
}

function readIloc(b, c, m) {
  const version = b.u8at(c.start);
  if (version > 2) fail('The item locations use an unknown layout');
  let o = c.start + 4;
  const s1 = b.u8at(o); const s2 = b.u8at(o + 1); o += 2;
  const sizes = { off: s1 >> 4, len: s1 & 15, base: s2 >> 4, idx: version ? s2 & 15 : 0 };
  if (Object.values(sizes).some((n) => ![0, 4, 8].includes(n))) fail('The item locations use field sizes this cleaner cannot write');
  const read = (n) => { const v = n === 8 ? b.u64(o) : n === 4 ? b.u32(o) : n === 2 ? b.u16(o) : 0; o += n; return v; };
  const count = read(version < 2 ? 2 : 4);
  if (count > 10000) fail('The file has too many items');
  for (let i = 0; i < count; i++) {
    const id = read(version < 2 ? 2 : 4);
    const field = version ? read(2) : 0;
    const dri = read(2); const base = read(sizes.base); const n = read(2);
    if (n > 10000) fail('An item has too many parts');
    const extents = [];
    for (let k = 0; k < n; k++) extents.push({ index: read(sizes.idx), offset: read(sizes.off), length: read(sizes.len) });
    if (m.locs.has(id)) fail('An item is located twice');
    m.locs.set(id, { field, method: field & 15, dri, base, extents });
  }
  if (o > c.end) fail('The item locations are damaged');
  m.iloc = { version, sizes, head: b.slice(c.start, 6) };
}

function readIref(b, c, m) {
  const version = b.u8at(c.start); const w = version ? 4 : 2;
  m.iref = { version, head: b.slice(c.start, 4) };
  for (const ref of boxes(b, c.start + 4, c.end)) {
    let o = ref.start; const rd = () => { const v = w === 4 ? b.u32(o) : b.u16(o); o += w; return v; };
    const fromId = rd(); const n = b.u16(o); o += 2;
    const to = []; for (let i = 0; i < n; i++) to.push(rd());
    if (o > ref.end) fail('The item references are damaged');
    m.refs.push({ type: ref.type, from: fromId, to });
    if (m.refs.length > 10000) fail('The file has too many item references');
  }
}

function readIprp(b, c, m) {
  m.iprp = { box: c, children: [...boxes(b, c.start, c.end)] };
  for (const x of m.iprp.children) {
    if (x.type === 'ipco') m.props = [...boxes(b, x.start, x.end)].map((p) => ({ type: p.type, bytes: b.slice(p.offset, p.size), box: p }));
    else if (x.type === 'ipma') {
      const version = b.u8at(x.start); const flags = b.u24(x.start + 1); const wide = flags & 1;
      let o = x.start + 4; const n = b.u32(o); o += 4;
      if (n > 10000) fail('The file has too many property links');
      const entries = [];
      for (let i = 0; i < n; i++) {
        const id = version < 1 ? b.u16(o) : b.u32(o); o += version < 1 ? 2 : 4;
        const k = b.u8at(o++); const assoc = [];
        for (let j = 0; j < k; j++) {
          if (wide) { const v = b.u16(o); o += 2; assoc.push({ essential: v >> 15, index: v & 0x7fff }); } else { const v = b.u8at(o++); assoc.push({ essential: v >> 7, index: v & 0x7f }); }
        }
        entries.push({ id, assoc });
      }
      if (o > x.end) fail('The property links are damaged');
      m.ipmas.push({ box: x, version, flags, wide, entries, head: b.slice(x.start, 4) });
    }
  }
}

// ---------- Writing the item table ----------

function buildMeta(m, kept, removed, mapFile, mapIdat) {
  const parts = [];
  for (const c of m.children) {
    if (c.type === 'xml ' || c.type === 'bxml') continue;
    if (c.type === 'iinf') parts.push(buildIinf(m, kept));
    else if (c.type === 'iloc') parts.push(buildIloc(m, kept, mapFile, mapIdat));
    else if (c.type === 'iref') { const r = buildIref(m, removed); if (r) parts.push(r); }
    else if (c.type === 'iprp') parts.push(buildIprp(m, kept));
    else if (c.type === 'idat') { const d = buildIdat(m, removed); if (d) parts.push(d); }
    else parts.push(raw(m, c));
  }
  return box('meta', m.head, ...parts);
}

const raw = (m, c) => m.source.subarray(c.offset, c.end);

function buildIinf(m, kept) {
  const list = [...m.infos].filter(([id]) => kept.has(id)).map(([, it]) => m.source.subarray(it.box.offset, it.box.end));
  const count = m.iinf.version ? u32(list.length) : u16(list.length);
  if (!m.iinf.version && list.length > 0xffff) fail('The item table is too large');
  return box('iinf', m.iinf.head, count, ...list);
}

function buildIloc(m, kept, mapFile, mapIdat) {
  const { version, sizes } = m.iloc;
  const out = [m.iloc.head];
  const items = [...m.locs].filter(([id]) => kept.has(id));
  out.push(version < 2 ? u16(items.length) : u32(items.length));
  for (const [id, loc] of items) {
    out.push(version < 2 ? u16(id) : u32(id));
    if (version) out.push(u16(loc.field));
    out.push(u16(loc.dri));
    const map = loc.method === 1 ? mapIdat : mapFile;
    const base = sizes.base ? map(loc.base) : 0;
    out.push(field(sizes.base, base), u16(loc.extents.length));
    for (const e of loc.extents) {
      const start = map(loc.base + e.offset);
      if (map(loc.base + e.offset + e.length) - start !== e.length) fail('An image would have lost data');
      out.push(field(sizes.idx, e.index), field(sizes.off, start - base), field(sizes.len, e.length));
    }
  }
  return box('iloc', ...out);
}

function buildIref(m, removed) {
  const w = m.iref.version ? u32 : u16;
  const refs = m.refs.filter((r) => !removed.has(r.from)).map((r) => ({ ...r, to: r.to.filter((t) => !removed.has(t)) })).filter((r) => r.to.length);
  if (!refs.length) return null;
  return box('iref', m.iref.head, ...refs.map((r) => box(r.type, w(r.from), u16(r.to.length), ...r.to.map(w))));
}

function buildIprp(m, kept) {
  const used = new Set();
  for (const ipma of m.ipmas) for (const e of ipma.entries) if (kept.has(e.id)) for (const a of e.assoc) if (a.index) used.add(a.index);
  const renumber = new Map(); let n = 0;
  m.props.forEach((p, i) => { if (used.has(i + 1)) renumber.set(i + 1, ++n); });
  const parts = m.iprp.children.map((x) => {
    if (x.type === 'ipco') return box('ipco', ...m.props.filter((p, i) => used.has(i + 1)).map((p) => p.bytes));
    if (x.type !== 'ipma') return raw(m, x);
    const ipma = m.ipmas.find((y) => y.box === x);
    const entries = ipma.entries.filter((e) => kept.has(e.id));
    return box('ipma', ipma.head, u32(entries.length), ...entries.map((e) => concat([
      ipma.version < 1 ? u16(e.id) : u32(e.id), Uint8Array.of(e.assoc.length),
      ...e.assoc.map((a) => { const index = a.index ? renumber.get(a.index) ?? fail('A property link is damaged') : 0; return ipma.wide ? u16((a.essential << 15) | index) : Uint8Array.of((a.essential << 7) | index); }),
    ])));
  });
  return box('iprp', ...parts);
}

function buildIdat(m, removed) {
  const cuts = merge([...removed].flatMap((id) => { const l = m.locs.get(id); return l?.method === 1 ? l.extents.map((e) => [l.base + e.offset, l.base + e.offset + e.length]) : []; }));
  const data = m.source.subarray(m.idat.start, m.idat.end);
  const parts = []; let at = 0;
  for (const [s, e] of cuts) { parts.push(data.subarray(at, s)); at = e; }
  parts.push(data.subarray(at));
  const left = concat(parts);
  const used = [...m.locs].some(([id, l]) => !removed.has(id) && l.method === 1);
  return left.length || used ? box('idat', left) : null;
}

// ---------- What the result says ----------

function removedList(m, blocks, removed) {
  const listed = new Set(blocks.map((x) => /^HEIF item (\d+)$/.exec(x.container ?? '')?.[1]).filter(Boolean).map(Number));
  const extra = [...removed].filter((id) => !listed.has(id)).map((id) => {
    const bytes = m.locs.get(id)?.extents.reduce((n, e) => n + e.length, 0) ?? 0;
    const describes = m.refs.some((r) => r.from === id && r.type === 'cdsc');
    return { kind: describes ? 'Item data' : 'Thumbnail', container: `HEIF item ${id}`, bytes };
  });
  return [...blocks.map((x) => ({ kind: x.kind, container: x.container ?? '', bytes: x.length })), ...extra];
}

function keptList(m, kept, report) {
  const propsOf = (id) => m.ipmas.flatMap((x) => x.entries.filter((e) => e.id === id).flatMap((e) => e.assoc.map((a) => m.props[a.index - 1]).filter(Boolean)));
  const images = [...kept].filter((id) => m.infos.has(id)).length;
  const list = [`${images} image item${images === 1 ? '' : 's'} with ${images === 1 ? 'its' : 'their'} coded data unchanged`];
  const primary = propsOf(m.primary);
  const irot = primary.find((p) => p.type === 'irot');
  if (irot) list.push(`Rotation (${(p8(irot) & 3) * 90}° counter-clockwise)`);
  if (primary.some((p) => p.type === 'imir')) list.push('Mirroring');
  if ([...kept].some((id) => propsOf(id).some((p) => p.type === 'colr' && /^(prof|rICC)$/.test(latin1(p.bytes.subarray(8, 12)))))) list.push('ICC color profile');
  for (const id of kept) {
    const auxC = propsOf(id).find((p) => p.type === 'auxC');
    if (!auxC) continue;
    const urn = latin1(auxC.bytes.subarray(12)).replace(/\0[\s\S]*$/, '');
    const known = AUX_TYPES[urn] ?? urn;
    const [, name, note] = AUX.find(([re]) => re.test(known)) ?? [null, 'Auxiliary image', `kept (${urn || 'unnamed type'})`];
    list.push(`${name ?? known} (item ${id}, ${note})`);
  }
  const orientation = report.sources.find((s) => s.name === 'EXIF IFD0')?.fields.find((f) => f.key === 'Orientation')?.value;
  if (orientation && !/^Horizontal|^1$/.test(orientation) && !irot && !primary.some((p) => p.type === 'imir')) {
    list.push(`Display unchanged: the removed EXIF said "${orientation}", but HEIF viewers follow the file's own rotation, which this file does not set`);
  }
  return list;
}

const p8 = (p) => p.bytes[p.box.start - p.box.offset];

// ---------- Bytes ----------

function box(type, ...parts) {
  const body = concat(parts);
  const head = new Uint8Array(8); new DataView(head.buffer).setUint32(0, 8 + body.length);
  head.set([...type].map((c) => c.charCodeAt(0)), 4);
  return concat([head, body]);
}
function u16(v) { const o = new Uint8Array(2); new DataView(o.buffer).setUint16(0, v); return o; }
function u32(v) { const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, v); return o; }
function field(size, v) {
  if (v < 0 || (size === 0 && v !== 0) || (size === 4 && v > 0xffffffff)) fail('A moved offset does not fit its field');
  if (size === 0) return new Uint8Array();
  if (size === 4) return u32(v);
  const o = new Uint8Array(8); setU64(new DataView(o.buffer), 0, v); return o;
}
function setU64(view, o, v) { view.setUint32(o, Math.floor(v / 2 ** 32)); view.setUint32(o + 4, v >>> 0); }
function merge(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, c) => a[0] - c[0]); const out = [];
  for (const r of sorted) { const last = out.at(-1); if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r]); }
  return out;
}
const overlaps = (a, c) => a.some(([s, e]) => c.some(([s2, e2]) => s < e2 && s2 < e));
