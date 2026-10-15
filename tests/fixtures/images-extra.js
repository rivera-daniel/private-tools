// HEIF/AVIF and TIFF files built in memory for the cleaner tests, and small independent readers that pull
// each image item's or page's coded data back out, so tests can check it survived byte for byte.
// Coded image data is placeholder bytes: nothing here is decoded.

const u16 = (n, le = false) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
const u32 = (n, le = false) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b; };
const u64 = (n, le = false) => { const b = Buffer.alloc(8); le ? b.writeBigUInt64LE(BigInt(n)) : b.writeBigUInt64BE(BigInt(n)); return b; };
const sized = (n, size) => (size === 0 ? Buffer.alloc(0) : size === 4 ? u32(n) : u64(n));

// ---------- HEIF ----------

export const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
export const fullBox = (type, version, flags, ...parts) => box(type, Buffer.from([version, flags >> 16, (flags >> 8) & 255, flags & 255]), ...parts);
export const ispe = (w, h) => fullBox('ispe', 0, 0, u32(w), u32(h));
export const hvcC = () => box('hvcC', Buffer.from([1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0]));
export const av1C = () => box('av1C', Buffer.from([0x81, 0x1f, 0x0c, 0]));
export const irot = (quarterTurns) => box('irot', Buffer.from([quarterTurns & 3]));
export const auxC = (urn) => fullBox('auxC', 0, 0, Buffer.from(`${urn}\0`, 'latin1'));
export const colrNclx = () => box('colr', Buffer.from('nclx', 'latin1'), u16(1), u16(13), u16(6), Buffer.from([0x80]));
export const exifItem = (tiffBytes) => Buffer.concat([u32(0), tiffBytes]);
export const grid = (rows, cols, w, h) => Buffer.from([0, 0, rows - 1, cols - 1, w >> 8, w & 255, h >> 8, h & 255]);

// items: [{ id, type, contentType?, data: Buffer or [Buffer, …] (one per extent), method: 0 (file) or 1 (idat), sameAs? }]
// refs: [[type, from, [to…]]]. props: [Buffer]. assoc: { id: [index or -index for essential] }.
// iloc: { version, off, len, base, idx } field sizes in bytes. meta: extra meta children.
export function heif({ brand = 'heic', items, refs = [], props = [], assoc = {}, primary = 1, iloc = {}, wideIds = false, wideProps = false, metaLast = false, meta = [], top = [] }) {
  const L = { version: 1, off: 4, len: 4, base: 0, idx: 0, ...iloc };
  const w = wideIds ? u32 : u16;
  const extentsOf = (it) => (Array.isArray(it.data) ? it.data : [it.data]);
  const idat = []; let idatSize = 0;
  for (const it of items.filter((x) => x.method === 1)) it.at = extentsOf(it).map((d) => { const at = idatSize; idat.push(d); idatSize += d.length; return at; });
  const mdatParts = []; let mdatSize = 0;
  for (const it of items.filter((x) => !x.method && !x.sameAs)) it.at = extentsOf(it).map((d) => { const at = mdatSize; mdatParts.push(d); mdatSize += d.length; return at; });
  // sameAs: an item whose extents point at another item's bytes.
  for (const it of items.filter((x) => x.sameAs)) { const other = items.find((x) => x.id === it.sameAs); it.at = other.at; it.data = other.data; }

  const build = (mdatStart) => {
    const loc = items.map((it) => {
      const abs = it.at.map((a) => a + (it.method === 1 ? 0 : mdatStart));
      const base = L.base ? abs[0] : 0;
      return Buffer.concat([
        L.version < 2 ? u16(it.id) : u32(it.id), L.version ? u16(it.method ?? 0) : Buffer.alloc(0), u16(0), sized(base, L.base), u16(abs.length),
        ...abs.map((a, k) => Buffer.concat([sized(k, L.idx), sized(a - base, L.off), sized(extentsOf(it)[k].length, L.len)])),
      ]);
    });
    const infe = items.map((it) => fullBox('infe', wideIds ? 3 : 2, 0, w(it.id), u16(0), Buffer.from(it.type, 'latin1'), Buffer.from('\0'), it.contentType ? Buffer.from(`${it.contentType}\0`) : Buffer.alloc(0)));
    const ipma = Object.entries(assoc).map(([id, list]) => Buffer.concat([wideIds ? u32(Number(id)) : u16(Number(id)), Buffer.from([list.length]), ...list.map((i) => (wideProps ? u16((i < 0 ? 0x8000 : 0) | Math.abs(i)) : Buffer.from([(i < 0 ? 0x80 : 0) | Math.abs(i)])))]));
    return fullBox('meta', 0, 0,
      fullBox('hdlr', 0, 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), Buffer.from('\0')),
      fullBox('pitm', wideIds ? 1 : 0, 0, w(primary)),
      fullBox('iinf', 0, 0, u16(items.length), ...infe),
      fullBox('iloc', L.version, 0, Buffer.from([(L.off << 4) | L.len, (L.base << 4) | L.idx]), L.version < 2 ? u16(items.length) : u32(items.length), ...loc),
      ...(refs.length ? [fullBox('iref', wideIds ? 1 : 0, 0, ...refs.map(([t, f, to]) => box(t, w(f), u16(to.length), ...to.map(w))))] : []),
      box('iprp', box('ipco', ...props), fullBox('ipma', wideIds ? 1 : 0, wideProps ? 1 : 0, u32(Object.keys(assoc).length), ...ipma)),
      ...(idat.length ? [box('idat', ...idat)] : []),
      ...meta,
    );
  };
  const ftyp = box('ftyp', Buffer.from(brand, 'latin1'), u32(0), Buffer.from(`mif1${brand}miaf`, 'latin1'));
  const metaSize = build(0).length;
  const topSize = top.reduce((n, x) => n + x.length, 0);
  const mdatStart = ftyp.length + (metaLast ? 0 : metaSize) + topSize + 8;
  const mdat = box('mdat', ...mdatParts);
  return metaLast ? Buffer.concat([ftyp, ...top, mdat, build(mdatStart)]) : Buffer.concat([ftyp, build(mdatStart), ...top, mdat]);
}

// Item ID → { type, data } read straight from the item tables.
export function heifItems(u8) {
  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.length);
  const kids = (start, end) => { const out = []; for (let o = start; o + 8 <= end;) { const size = buf.readUInt32BE(o); out.push({ type: buf.toString('latin1', o + 4, o + 8), start: o + 8, end: o + size }); o += size; } return out; };
  const meta = kids(0, buf.length).find((x) => x.type === 'meta');
  const parts = kids(meta.start + 4, meta.end);
  const find = (t) => parts.find((x) => x.type === t);
  const idat = find('idat');
  const items = new Map();
  const iinf = find('iinf');
  for (const infe of kids(iinf.start + 4 + (buf[iinf.start] ? 4 : 2), iinf.end)) {
    const v = buf[infe.start]; const id = v === 2 ? buf.readUInt16BE(infe.start + 4) : buf.readUInt32BE(infe.start + 4);
    items.set(id, { type: buf.toString('latin1', infe.start + (v === 2 ? 8 : 10), infe.start + (v === 2 ? 12 : 14)) });
  }
  const iloc = find('iloc'); const v = buf[iloc.start]; let o = iloc.start + 4;
  const off = buf[o] >> 4; const len = buf[o] & 15; const base = buf[o + 1] >> 4; const idx = v ? buf[o + 1] & 15 : 0; o += 2;
  const rd = (n) => { const x = n === 8 ? Number(buf.readBigUInt64BE(o)) : n === 4 ? buf.readUInt32BE(o) : n === 2 ? buf.readUInt16BE(o) : 0; o += n; return x; };
  const count = rd(v < 2 ? 2 : 4);
  for (let i = 0; i < count; i++) {
    const id = rd(v < 2 ? 2 : 4); const method = v ? rd(2) & 15 : 0; rd(2); const b = rd(base); const n = rd(2);
    const data = [];
    for (let k = 0; k < n; k++) { rd(idx); const at = b + rd(off); const l = rd(len); const from = method === 1 ? idat.start + at : at; data.push(buf.subarray(from, from + l)); }
    items.set(id, { ...items.get(id), data: Buffer.concat(data) });
  }
  return items;
}

// ---------- TIFF ----------

const TYPE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 13: 4, 16: 8 };

// A directory: { tags: [[tag, type, values]], strips: [Buffer] or tiles: [Buffer], exif, gps: directory,
// subIfds: [directory] }. Strings are ASCII, Buffers UNDEFINED or BYTE, rationals [num, den] pairs.
// pages: the IFD chain. offsetType: type of StripOffsets/TileOffsets (3, 4 or 16).
export function tiffFile(pages, { le = true, big = false, offsetType = big ? 16 : 4, trailer = null } = {}) {
  const dirs = [];
  const add = (d) => { dirs.push(d); for (const s of [d.exif, d.gps, ...(d.subIfds ?? [])].filter(Boolean)) add(s); };
  pages.forEach(add);
  const enc = (type, v) => {
    if (type === 2) return Buffer.from(`${v}\0`, 'latin1');
    if (type === 1 || type === 7) return Buffer.from(v);
    return Buffer.concat(v.map((x) => (type === 3 ? u16(x, le) : type === 4 || type === 13 ? u32(x, le) : type === 16 ? u64(x, le) : Buffer.concat([u32(x[0], le), u32(x[1], le)]))));
  };
  const count = (type, v) => (type === 2 ? Buffer.byteLength(`${v}\0`, 'latin1') : v.length);
  const head = big ? 8 : 2; const width = big ? 20 : 12; const inline = big ? 8 : 4;
  // Entries with placeholders for pointers, so sizes are known before positions.
  for (const d of dirs) {
    const data = d.strips ?? d.tiles ?? [];
    const [o, l] = d.tiles ? [0x0144, 0x0145] : [0x0111, 0x0117];
    d.list = [...d.tags.map(([t, type, v]) => ({ t, type, v })),
      ...(data.length ? [{ t: o, type: offsetType, v: data.map(() => 0), data: true }, { t: l, type: 4, v: data.map((x) => x.length) }] : []),
      ...(d.exif ? [{ t: 0x8769, type: 4, v: [0], ptr: [d.exif] }] : []),
      ...(d.gps ? [{ t: 0x8825, type: 4, v: [0], ptr: [d.gps] }] : []),
      ...(d.subIfds ? [{ t: 0x014a, type: 4, v: d.subIfds.map(() => 0), ptr: d.subIfds }] : []),
    ].sort((a, b) => a.t - b.t);
  }
  let pos = big ? 16 : 8;
  for (const d of dirs) {
    pos += pos & 1; d.at = pos; pos += head + d.list.length * width + inline;
    for (const e of d.list) { e.size = TYPE[e.type] * count(e.type, e.v); if (e.size > inline) { pos += pos & 1; e.at = pos; pos += e.size; } }
    d.dataAt = (d.strips ?? d.tiles ?? []).map((x) => { const at = pos; pos += x.length; return at; });
  }
  const out = Buffer.alloc(pos);
  out.write(le ? 'II' : 'MM', 0, 'latin1');
  const w16 = (o, v) => (le ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o));
  const w32 = (o, v) => (le ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o));
  const wOff = (o, v) => (big ? (le ? out.writeBigUInt64LE(BigInt(v), o) : out.writeBigUInt64BE(BigInt(v), o)) : w32(o, v));
  w16(2, big ? 43 : 42);
  if (big) { w16(4, 8); w16(6, 0); }
  wOff(big ? 8 : 4, pages[0].at);
  for (const d of dirs) {
    big ? wOff(d.at, d.list.length) : w16(d.at, d.list.length);
    d.list.forEach((e, i) => {
      const o = d.at + head + i * width;
      if (e.data) e.v = d.dataAt;
      if (e.ptr) e.v = e.ptr.map((p) => p.at);
      const bytes = enc(e.type, e.v);
      w16(o, e.t); w16(o + 2, e.type); big ? wOff(o + 4, count(e.type, e.v)) : w32(o + 4, count(e.type, e.v));
      if (e.size > inline) { wOff(o + (big ? 12 : 8), e.at); bytes.copy(out, e.at); } else bytes.copy(out, o + (big ? 12 : 8));
    });
    const page = pages.indexOf(d);
    wOff(d.at + head + d.list.length * width, page >= 0 && pages[page + 1] ? pages[page + 1].at : 0);
    (d.strips ?? d.tiles ?? []).forEach((x, i) => x.copy(out, d.dataAt[i]));
  }
  return trailer ? Buffer.concat([out, trailer]) : out;
}

// Each page's strips or tiles, concatenated in order, read straight from the IFD chain.
export function tiffPages(u8) {
  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.length);
  const le = buf.toString('latin1', 0, 2) === 'II';
  const big = (le ? buf.readUInt16LE(2) : buf.readUInt16BE(2)) === 43;
  const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const r64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const pages = [];
  for (let at = big ? r64(8) : r32(4); at; ) {
    const n = big ? r64(at) : r16(at); const tags = new Map();
    for (let i = 0; i < n; i++) {
      const e = at + (big ? 8 : 2) + i * (big ? 20 : 12);
      const type = r16(e + 2); const c = big ? r64(e + 4) : r32(e + 4); const unit = TYPE[type] ?? 1;
      const v = c * unit <= (big ? 8 : 4) ? e + (big ? 12 : 8) : (big ? r64(e + 12) : r32(e + 8));
      tags.set(r16(e), Array.from({ length: c }, (_, k) => (type === 3 ? r16(v + k * 2) : type === 4 || type === 13 ? r32(v + k * 4) : type === 16 ? r64(v + k * 8) : buf[v + k])));
    }
    const offs = tags.get(0x0111) ?? tags.get(0x0144); const lens = tags.get(0x0117) ?? tags.get(0x0145);
    pages.push({ tags, data: Buffer.concat(offs.map((o, i) => buf.subarray(o, o + lens[i]))) });
    at = big ? r64(at + 8 + n * 20) : r32(at + 2 + n * 12);
  }
  return pages;
}
