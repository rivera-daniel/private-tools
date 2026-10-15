// PDF file structure: cross-reference tables and streams, /Prev chains, object streams, incremental
// updates, and a scan that rebuilds the object map when the cross-reference data is missing or wrong.
import { latin1, startsWith } from '../bytes.js';
import { Parser, Dict, Stream, Ref, Keyword, PdfError, isName, isInt, nameOf, indexOfBytes, lastIndexOfBytes, WS, DELIM } from './syntax.js';
import { decode, Budget } from './filters.js';

const MAX_OBJECTS = 4000000;
const MAX_SECTIONS = 256;
const MAX_PAGES = 100000;
const MAX_STM_OBJECTS = 200000;
const TRAILER_SKIP = new Set(['Prev', 'XRefStm', 'Type', 'W', 'Index', 'Length', 'Filter', 'DecodeParms', 'Size', 'First', 'N', 'Extends']);

export class PdfDocument {
  constructor(u8, { warn = () => {} } = {}) {
    this.u8 = u8; this.warn = warn;
    this.entries = new Map(); this.sections = []; this.trailer = new Dict();
    this.cache = new Map(); this.spans = new Map(); this.loading = new Set(); this.objstms = new Map();
    // Cross-reference and object streams have their own allowance, apart from the metadata budget.
    this.budget = new Budget(128 * 1048576, 32 * 1048576);
    this.headerOffset = -1; this.version = null; this.recovered = false; this.scanned = null;
    this.repairedLengths = 0; this.misplaced = 0; this.unreadable = 0; this.encrypted = false;
  }

  static async open(u8, options) { const doc = new PdfDocument(u8, options); await doc.load(); return doc; }

  async load() {
    const u8 = this.u8;
    this.headerOffset = indexOfBytes(u8, '%PDF-', 0, Math.min(u8.length, 1029));
    if (this.headerOffset >= 0) this.version = /^%PDF-(\d\.\d{1,2})/.exec(latin1(u8.subarray(this.headerOffset, this.headerOffset + 12)))?.[1] ?? null;
    let ok = false;
    const sx = lastIndexOfBytes(u8, 'startxref');
    if (sx >= 0) {
      try {
        const off = new Parser(u8, sx + 9).value();
        if (isInt(off)) { await this.readChain(off); ok = this.trailer.get('Root') instanceof Ref; }
      } catch (error) { if (!(error instanceof PdfError) && !(error instanceof RangeError)) throw error; ok = false; }
    }
    this.encrypted = this.trailer.has('Encrypt');
    if (ok) { await this.loadObjectStreams(); ok = this.catalog() instanceof Dict; }
    if (!ok) await this.rebuild();
    this.encrypted = this.trailer.has('Encrypt');
  }

  async readChain(start) {
    const seen = new Set(); const sections = []; let off = start;
    while (isInt(off)) {
      if (seen.has(off)) { this.warn('The cross-reference chain loops back on itself. The loop was ignored.'); break; }
      if (sections.length >= MAX_SECTIONS) { this.warn(`The file has more than ${MAX_SECTIONS} cross-reference sections. Older ones were ignored.`); break; }
      seen.add(off);
      const section = await this.readSection(off);
      sections.push(section);
      const xs = section.trailer.get('XRefStm');
      if (isInt(xs) && !seen.has(xs)) {
        seen.add(xs);
        try { const extra = await this.readSection(xs); for (const [n, e] of extra.entries) if (!section.entries.has(n)) section.entries.set(n, e); section.hybrid = true; }
        catch (error) { if (!(error instanceof PdfError)) throw error; }
      }
      off = section.trailer.get('Prev');
    }
    for (const s of sections) for (const [n, e] of s.entries) if (!this.entries.has(n)) this.entries.set(n, e);
    for (const s of sections) for (const [k, v] of s.trailer) if (!this.trailer.has(k) && !TRAILER_SKIP.has(k)) this.trailer.set(k, v);
    this.sections = sections;
  }

  async readSection(off) {
    const u8 = this.u8;
    for (const at of new Set([off, off + Math.max(0, this.headerOffset)])) {
      if (!(at >= 0 && at < u8.length)) continue;
      const p = new Parser(u8, at); p.skip();
      if (startsWith(u8, 'xref', p.pos)) return this.readTable(p.pos);
      let obj = null;
      try { obj = this.parseAt(p.pos); } catch (error) { if (!(error instanceof PdfError)) throw error; }
      if (obj?.value instanceof Stream && isName(obj.value.dict.get('Type'), 'XRef')) return this.readXrefStream(obj.value, p.pos);
    }
    throw new PdfError('no cross-reference section at the offset given');
  }

  readTable(at) {
    const p = new Parser(this.u8, at + 4); const entries = new Map(); let trailer = null;
    for (;;) {
      p.skip();
      if (p.pos >= p.end) break;
      const w = p.word();
      if (w === 'trailer') { trailer = p.value(); break; }
      if (!/^\d+$/.test(w)) throw new PdfError('unreadable cross-reference table');
      let first = Number(w); p.skip(); const count = Number(p.word());
      if (!isInt(count) || count < 0 || entries.size + count > MAX_OBJECTS) throw new PdfError('unreadable cross-reference subsection');
      for (let i = 0; i < count; i++) {
        p.skip(); const o = p.word(); p.skip(); const g = p.word(); p.skip(); const t = p.word();
        if (!/^\d{1,10}$/.test(o) || !/^\d{1,5}$/.test(g) || (t !== 'n' && t !== 'f')) throw new PdfError('unreadable cross-reference entry');
        // Some writers number the first subsection from 1 although it starts with the object 0 entry.
        if (i === 0 && first === 1 && t === 'f' && g === '65535') first = 0;
        const num = first + i;
        if (!entries.has(num)) entries.set(num, t === 'n' && Number(o) > 0 ? { type: 1, offset: Number(o), gen: Number(g) } : { type: 0 });
      }
    }
    if (!(trailer instanceof Dict)) throw new PdfError('cross-reference table without a trailer');
    return { offset: at, entries, trailer, kind: 'table' };
  }

  async readXrefStream(stream, at) {
    const d = stream.dict; const W = d.get('W');
    if (!Array.isArray(W) || W.length < 3 || !W.slice(0, 3).every((w) => isInt(w) && w >= 0 && w <= 8)) throw new PdfError('cross-reference stream with bad field widths');
    const size = d.get('Size');
    let index = d.get('Index'); if (!Array.isArray(index)) index = [0, isInt(size) ? size : 0];
    let data;
    try { ({ data } = await decode(stream.raw, d, { budget: this.budget })); } catch (error) { throw new PdfError(`cross-reference stream could not be decoded (${error.message})`); }
    const row = W[0] + W[1] + W[2];
    if (!row) throw new PdfError('cross-reference stream with empty rows');
    const field = (pos, w) => { let v = 0; for (let j = 0; j < w; j++) v = v * 256 + data[pos + j]; return v; };
    const entries = new Map(); let pos = 0;
    for (let k = 0; k + 1 < index.length; k += 2) {
      const first = index[k]; const count = index[k + 1];
      if (!isInt(first) || !isInt(count) || first < 0 || count < 0 || entries.size + count > MAX_OBJECTS) throw new PdfError('cross-reference stream with a bad index');
      for (let i = 0; i < count && pos + row <= data.length; i++, pos += row) {
        const type = W[0] ? field(pos, W[0]) : 1; const a = field(pos + W[0], W[1]); const b = field(pos + W[0] + W[1], W[2]);
        const num = first + i;
        if (entries.has(num)) continue;
        entries.set(num, type === 1 && a > 0 ? { type: 1, offset: a, gen: b } : type === 2 ? { type: 2, stm: a, index: b } : { type: 0 });
      }
    }
    return { offset: at, entries, trailer: d, kind: 'stream' };
  }

  // Parses "num gen obj … endobj" at an offset.
  parseAt(offset) {
    const u8 = this.u8; const p = new Parser(u8, offset);
    const num = p.value(); const gen = p.value();
    if (!isInt(num) || !isInt(gen) || !p.keyword('obj')) throw new PdfError('no object at the offset given');
    let value = p.value();
    if (value instanceof Keyword) value = null;
    p.skip();
    let end = p.pos;
    if (value instanceof Dict && startsWith(u8, 'stream', p.pos)) { const s = this.readStream(value, p.pos + 6, offset); value = s.stream; end = s.end; }
    const e = indexOfBytes(u8, 'endobj', end, Math.min(u8.length, end + 64));
    return { num, gen, value, start: offset, end: e >= 0 ? e + 6 : end };
  }

  readStream(dict, at, offset) {
    const u8 = this.u8; let start = at;
    if (u8[start] === 0x0d && u8[start + 1] === 0x0a) start += 2; else if (u8[start] === 0x0a || u8[start] === 0x0d) start += 1;
    const len = this.resolve(dict.get('Length'));
    let end = isInt(len) && len >= 0 && start + len <= u8.length ? start + len : -1;
    if (end >= 0) { let q = end; while (q < u8.length && WS[u8[q]]) q++; if (!startsWith(u8, 'endstream', q)) end = -1; }
    if (end < 0) {
      const e = indexOfBytes(u8, 'endstream', start);
      end = e < 0 ? u8.length : e;
      if (e >= 0) { if (u8[end - 1] === 0x0a) end--; if (u8[end - 1] === 0x0d) end--; }
      if (end < start) end = start;
      this.repairedLengths++;
    }
    const e = indexOfBytes(u8, 'endstream', end, Math.min(u8.length, end + 64));
    return { stream: new Stream(dict, u8.subarray(start, end), offset), end: e >= 0 ? e + 9 : end };
  }

  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const e = this.entries.get(num);
    if (!e || e.type === 0 || this.loading.has(num) || this.loading.size > 32) return null;
    this.loading.add(num);
    let value = null;
    try { value = e.type === 1 ? this.direct(num, e) : this.fromStm(num, e); }
    catch (error) {
      if (!(error instanceof PdfError) && !(error instanceof RangeError)) throw error;
      if (!this.unreadable++) this.warn('Some objects could not be read and were skipped.');
    } finally { this.loading.delete(num); }
    this.cache.set(num, value);
    return value;
  }

  direct(num, e) {
    const tries = [e.offset]; if (this.headerOffset > 0) tries.push(e.offset + this.headerOffset);
    for (const at of tries) {
      if (!(at >= 0 && at < this.u8.length)) continue;
      try { const o = this.parseAt(at); if (o.num === num) { this.spans.set(num, [o.start, o.end - o.start]); return o.value; } }
      catch (error) { if (!(error instanceof PdfError)) throw error; }
    }
    const at = this.scan().found.get(num);
    if (at === undefined || tries.includes(at)) throw new PdfError('object not found');
    if (!this.misplaced++) this.warn('Some cross-reference entries point to the wrong place. Those objects were found by scanning the file.');
    const o = this.parseAt(at);
    this.spans.set(num, [o.start, o.end - o.start]);
    return o.value;
  }

  fromStm(num, e) {
    const s = this.objstms.get(e.stm);
    const off = s?.offsets.get(num);
    if (off === undefined) return null;
    const span = this.spans.get(e.stm); if (span) this.spans.set(num, span);
    const v = new Parser(s.data, s.first + off).value();
    return v instanceof Keyword ? null : v;
  }

  async loadObjectStreams() {
    if (this.encrypted) return;
    const nums = new Set();
    for (const e of this.entries.values()) if (e.type === 2) nums.add(e.stm);
    for (const n of nums) await this.loadObjStm(n);
  }

  async loadObjStm(n) {
    const s = this.get(n);
    if (!(s instanceof Stream) || !isName(s.dict.get('Type'), 'ObjStm') || this.objstms.has(n)) return;
    const first = this.resolve(s.dict.get('First')); const count = this.resolve(s.dict.get('N'));
    if (!isInt(first) || !isInt(count) || first < 0 || count < 0) return;
    let data;
    try { ({ data } = await decode(s.raw, s.dict, { resolve: (v) => this.resolve(v), budget: this.budget })); }
    catch { this.warn('An object stream could not be decompressed. Objects inside it were skipped.'); return; }
    const offsets = new Map(); const p = new Parser(data, 0, Math.min(first, data.length));
    try {
      for (let i = 0; i < Math.min(count, MAX_STM_OBJECTS); i++) {
        const a = p.value(); const b = p.value();
        if (!isInt(a) || !isInt(b)) break;
        if (!offsets.has(a)) offsets.set(a, b);
      }
    } catch (error) { if (!(error instanceof PdfError)) throw error; }
    this.objstms.set(n, { data, first, offsets });
  }

  // Finds every "num gen obj". A later definition of the same number wins, as in an incremental update.
  scan() {
    if (this.scanned) return this.scanned;
    const u8 = this.u8; const found = new Map(); const order = [];
    for (let i = indexOfBytes(u8, 'obj'); i >= 0; i = indexOfBytes(u8, 'obj', i + 3)) {
      if (i + 3 < u8.length && !WS[u8[i + 3]] && !DELIM[u8[i + 3]]) continue;
      let j = i - 1;
      if (j < 0 || !WS[u8[j]]) continue;
      while (j >= 0 && WS[u8[j]]) j--;
      const g = j; while (j >= 0 && u8[j] >= 0x30 && u8[j] <= 0x39) j--;
      if (j === g || g - j > 5 || j < 0 || !WS[u8[j]]) continue;
      while (j >= 0 && WS[u8[j]]) j--;
      const ne = j; while (j >= 0 && u8[j] >= 0x30 && u8[j] <= 0x39) j--;
      if (j === ne || ne - j > 10 || (j >= 0 && !WS[u8[j]] && !DELIM[u8[j]])) continue;
      const num = Number(latin1(u8.subarray(j + 1, ne + 1)));
      found.set(num, j + 1); order.push([num, j + 1]);
      if (order.length > MAX_OBJECTS) break;
    }
    this.scanned = { found, order };
    return this.scanned;
  }

  async rebuild() {
    const u8 = this.u8;
    this.recovered = true; this.entries = new Map(); this.cache.clear(); this.spans.clear(); this.sections = []; this.objstms.clear(); this.trailer = new Dict();
    const { found } = this.scan();
    for (const [num, offset] of found) this.entries.set(num, { type: 1, offset, gen: 0 });
    const trailers = [];
    for (let i = indexOfBytes(u8, 'trailer'); i >= 0; i = indexOfBytes(u8, 'trailer', i + 7)) {
      try { const t = new Parser(u8, i + 7).value(); if (t instanceof Dict) trailers.push([i, t]); } catch (error) { if (!(error instanceof PdfError)) throw error; }
    }
    const stms = [];
    for (const [num, offset] of found) {
      const v = this.get(num);
      if (!(v instanceof Stream)) continue;
      const type = nameOf(v.dict.get('Type'));
      if (type === 'XRef') trailers.push([offset, v.dict]); else if (type === 'ObjStm') stms.push(num);
    }
    trailers.sort((a, b) => a[0] - b[0]);
    for (const [, t] of trailers) for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (t.has(k)) this.trailer.set(k, t.get(k));
    this.encrypted = this.trailer.has('Encrypt');
    if (!this.encrypted) {
      for (const n of stms) {
        await this.loadObjStm(n);
        const s = this.objstms.get(n);
        if (s) for (const [num, index] of s.offsets) if (!this.entries.has(num)) this.entries.set(num, { type: 2, stm: n, index });
      }
    }
    if (!(this.catalog() instanceof Dict)) {
      this.trailer.delete('Root');
      let best = null;
      for (const num of this.entries.keys()) { const v = this.get(num); if (v instanceof Dict && isName(v.get('Type'), 'Catalog') && v.has('Pages')) best = num; }
      if (best === null) throw new PdfError('no document catalog found');
      this.trailer.set('Root', new Ref(best, 0));
    }
    this.warn('The cross-reference table is missing or broken. Objects were found by scanning the file.');
  }

  resolve(v) {
    for (let i = 0; v instanceof Ref && i < 8; i++) v = this.get(v.num);
    return v instanceof Ref ? null : v;
  }

  // The dictionary of a dictionary or stream value.
  dict(v) { v = this.resolve(v); return v instanceof Stream ? v.dict : v instanceof Dict ? v : null; }

  catalog() { const c = this.resolve(this.trailer.get('Root')); return c instanceof Dict ? c : null; }

  span(num) { return this.spans.get(num) ?? null; }

  pages() {
    if (this.pageList) return this.pageList;
    const out = []; const seen = new Set();
    const walk = (node, inherited, depth) => {
      if (depth > 64 || out.length >= MAX_PAGES) return;
      let num = null;
      if (node instanceof Ref) { num = node.num; if (seen.has(num)) return; seen.add(num); }
      const d = this.resolve(node);
      if (!(d instanceof Dict)) return;
      const inh = { ...inherited };
      for (const k of ['MediaBox', 'CropBox', 'Resources', 'Rotate']) if (d.has(k)) inh[k] = d.get(k);
      const kids = this.resolve(d.get('Kids'));
      if (Array.isArray(kids) && !isName(d.get('Type'), 'Page')) { for (const k of kids) walk(k, inh, depth + 1); }
      else if (!Array.isArray(kids)) out.push({ dict: d, num, inherited: inh });
    };
    walk(this.catalog()?.get('Pages'), {}, 0);
    this.pageList = out;
    return out;
  }

  // Object numbers reachable from the trailer.
  reachable() {
    if (this.reach) return this.reach;
    const seen = new Set(); const queue = [];
    const visit = (v, depth) => {
      if (depth > 200) return;
      if (v instanceof Ref) { if (!seen.has(v.num) && this.entries.has(v.num)) { seen.add(v.num); queue.push(v.num); } }
      else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
      else if (v instanceof Dict) for (const x of v.values()) visit(x, depth + 1);
      else if (v instanceof Stream) visit(v.dict, depth + 1);
    };
    for (const k of ['Root', 'Info', 'Encrypt', 'ID']) visit(this.trailer.get(k), 0);
    for (let i = 0; i < queue.length; i++) visit(this.get(queue[i]), 0);
    this.reach = seen;
    return seen;
  }

  linearized() {
    if (this.headerOffset < 0) return null;
    try {
      const p = new Parser(this.u8, this.headerOffset); p.skip();
      const o = this.parseAt(p.pos);
      return o.value instanceof Dict && o.value.has('Linearized') ? o.value : null;
    } catch (error) { if (error instanceof PdfError || error instanceof RangeError) return null; throw error; }
  }

  // Each revision is a cross-reference section of the /Prev chain with the bytes up to its %%EOF.
  // The first-page section of a linearized file is not a revision.
  revisions() {
    const u8 = this.u8;
    const lin = this.linearized(); const firstPageEnd = isInt(lin?.get('E')) ? lin.get('E') : -1;
    let sections = this.sections.filter((s) => !(lin && s.offset < firstPageEnd));
    if (!sections.length) sections = this.sections.slice(0, 1);
    sections = [...sections].sort((a, b) => a.offset - b.offset);
    const out = []; let start = 0;
    for (const s of sections) {
      const eof = indexOfBytes(u8, '%%EOF', s.offset);
      let end = eof < 0 ? u8.length : eof + 5;
      while (end < u8.length && (u8[end] === 0x0d || u8[end] === 0x0a)) end++;
      if (end <= start) continue;
      out.push({ start, end, section: s });
      start = end;
    }
    if (!out.length) out.push({ start: 0, end: u8.length, section: null });
    return out;
  }

  // Objects an earlier section defines that a later one replaced or deleted.
  superseded() {
    const out = [];
    this.sections.forEach((s, age) => {
      if (age === 0) return;
      for (const [num, e] of s.entries) {
        if (e.type === 0) continue;
        const now = this.entries.get(num);
        if (now === e || (now?.type === 1 && e.type === 1 && now.offset === e.offset)) continue;
        out.push({ num, entry: e, section: s, deleted: !now || now.type === 0 });
      }
    });
    return out;
  }

  // Reads an object as an earlier section defined it.
  readOld(entry) {
    try { return entry.type === 1 ? this.parseAt(entry.offset).value : null; } catch (error) { if (error instanceof PdfError || error instanceof RangeError) return null; throw error; }
  }
}
