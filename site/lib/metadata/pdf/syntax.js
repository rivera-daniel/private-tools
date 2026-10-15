// PDF object syntax: value types, a tolerant parser and text helpers. All input is hostile.
import { latin1, utf16, utf8, clean } from '../bytes.js';

export class Name { constructor(name) { this.name = name; } }
export class Str { constructor(bytes) { this.bytes = bytes; } }
export class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
export class Keyword { constructor(word) { this.word = word; } }
// Keys are names without the slash.
export class Dict extends Map {}
// raw is a view of the encoded bytes; offset is where the object starts in the file.
export class Stream { constructor(dict, raw, offset = -1) { this.dict = dict; this.raw = raw; this.offset = offset; } }
export class PdfError extends Error {}

export const MAX_DEPTH = 64;
const MAX_ITEMS = 500000;
export const WS = new Uint8Array(256); for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
export const DELIM = new Uint8Array(256); for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const HEX = new Int8Array(256).fill(-1); for (let i = 0; i < 16; i++) HEX['0123456789abcdef'.charCodeAt(i)] = i, HEX['0123456789ABCDEF'.charCodeAt(i)] = i;

export const isName = (v, name) => v instanceof Name && (name === undefined || v.name === name);
export const nameOf = (v) => (v instanceof Name ? v.name : null);
export const isInt = (v) => Number.isInteger(v);

export class Parser {
  constructor(u8, pos = 0, end = u8.length) { this.u8 = u8; this.pos = pos; this.end = end; }

  skip() {
    const u8 = this.u8; const end = this.end; let p = this.pos;
    for (;;) {
      while (p < end && WS[u8[p]]) p++;
      if (p < end && u8[p] === 0x25) { while (p < end && u8[p] !== 10 && u8[p] !== 13) p++; continue; }
      break;
    }
    this.pos = p;
  }

  word() {
    const u8 = this.u8; const s = this.pos; let p = s;
    while (p < this.end && !WS[u8[p]] && !DELIM[u8[p]]) p++;
    this.pos = p;
    return latin1(u8.subarray(s, p));
  }

  // True when the next token is the given keyword; consumes it.
  keyword(word) {
    this.skip(); const at = this.pos;
    if (this.word() === word) return true;
    this.pos = at; return false;
  }

  value(depth = 0) {
    if (depth > MAX_DEPTH) throw new PdfError('objects are nested too deeply');
    this.skip();
    if (this.pos >= this.end) throw new PdfError('unexpected end of data');
    const u8 = this.u8; const c = u8[this.pos];
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literal();
    if (c === 0x3c) return u8[this.pos + 1] === 0x3c ? this.dict(depth) : this.hex();
    if (c === 0x5b) return this.array(depth);
    if (c === 0x3e && u8[this.pos + 1] === 0x3e) { this.pos += 2; return new Keyword('>>'); }
    if (DELIM[c]) { this.pos++; return new Keyword(String.fromCharCode(c)); }
    const w = this.word();
    if (NUMBER.test(w)) return /^\d+$/.test(w) ? this.maybeRef(w) : Number(w);
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Keyword(w);
  }

  maybeRef(w) {
    const n = Number(w); const at = this.pos;
    this.skip();
    const g = this.word();
    if (/^\d+$/.test(g) && g.length < 11) {
      this.skip();
      const u8 = this.u8; const p = this.pos;
      if (u8[p] === 0x52 && (p + 1 >= this.end || WS[u8[p + 1]] || DELIM[u8[p + 1]])) { this.pos = p + 1; return new Ref(n, Number(g)); }
    }
    this.pos = at;
    return n;
  }

  name() {
    const u8 = this.u8; let p = this.pos + 1; const bytes = [];
    while (p < this.end && !WS[u8[p]] && !DELIM[u8[p]]) {
      if (u8[p] === 0x23 && p + 2 < this.end && HEX[u8[p + 1]] >= 0 && HEX[u8[p + 2]] >= 0) { bytes.push(HEX[u8[p + 1]] * 16 + HEX[u8[p + 2]]); p += 3; }
      else bytes.push(u8[p++]);
      if (bytes.length > 4096) throw new PdfError('a name is too long');
    }
    this.pos = p;
    return new Name(String.fromCharCode(...bytes));
  }

  literal() {
    const u8 = this.u8; const end = this.end; let p = this.pos + 1; let depth = 1;
    let out = new Uint8Array(64); let n = 0;
    const put = (b) => { if (n === out.length) { const g = new Uint8Array(n * 2); g.set(out); out = g; } out[n++] = b; };
    while (p < end) {
      const c = u8[p++];
      if (c === 0x5c) {
        if (p >= end) break;
        const e = u8[p++];
        if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && p < end && u8[p] >= 0x30 && u8[p] <= 0x37; k++) v = v * 8 + u8[p++] - 0x30;
          put(v & 0xff);
        } else if (e === 0x0d) { if (u8[p] === 0x0a) p++; }
        else if (e !== 0x0a) put({ 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }[e] ?? e);
      } else if (c === 0x28) { depth++; put(c); }
      else if (c === 0x29) { if (--depth === 0) break; put(c); }
      else if (c === 0x0d) { put(10); if (u8[p] === 0x0a) p++; }
      else put(c);
    }
    this.pos = p;
    return new Str(out.slice(0, n));
  }

  hex() {
    const u8 = this.u8; let p = this.pos + 1; const out = []; let hi = -1;
    while (p < this.end && u8[p] !== 0x3e) {
      const v = HEX[u8[p++]];
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    this.pos = p + 1;
    return new Str(Uint8Array.from(out));
  }

  array(depth) {
    this.pos++;
    const list = [];
    for (;;) {
      this.skip();
      if (this.pos >= this.end) throw new PdfError('an array is not closed');
      if (this.u8[this.pos] === 0x5d) { this.pos++; return list; }
      const at = this.pos;
      const v = this.value(depth + 1);
      if (v instanceof Keyword) {
        if (v.word === 'R') continue;
        if (/^(endobj|obj|stream|endstream|trailer|xref|startxref)$/.test(v.word)) { this.pos = at; return list; }
        continue;
      }
      if (list.length >= MAX_ITEMS) throw new PdfError('an array holds too many items');
      list.push(v);
    }
  }

  dict(depth) {
    this.pos += 2;
    const d = new Dict();
    for (;;) {
      this.skip();
      if (this.pos >= this.end) throw new PdfError('a dictionary is not closed');
      const u8 = this.u8;
      if (u8[this.pos] === 0x3e && u8[this.pos + 1] === 0x3e) { this.pos += 2; return d; }
      const at = this.pos;
      const key = this.value(depth + 1);
      if (!(key instanceof Name)) {
        if (key instanceof Keyword && /^(endobj|obj|stream|endstream|trailer|xref|startxref)$/.test(key.word)) { this.pos = at; return d; }
        continue;
      }
      this.skip();
      if (u8[this.pos] === 0x3e && u8[this.pos + 1] === 0x3e) { this.pos += 2; return d; }
      const vat = this.pos;
      const v = this.value(depth + 1);
      if (v instanceof Keyword) {
        if (/^(endobj|obj|stream|endstream|trailer|xref|startxref)$/.test(v.word)) { this.pos = vat; return d; }
        continue;
      }
      if (d.size >= MAX_ITEMS) throw new PdfError('a dictionary holds too many entries');
      if (v !== null) d.set(key.name, v);
    }
  }
}

// PDFDocEncoding differs from Latin-1 in 0x18–0x1F and 0x80–0xA0.
const PDFDOC = { 0x18: 0x2d8, 0x19: 0x2c7, 0x1a: 0x2c6, 0x1b: 0x2d9, 0x1c: 0x2dd, 0x1d: 0x2db, 0x1e: 0x2da, 0x1f: 0x2dc, 0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x192, 0x87: 0x2044, 0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018, 0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x141, 0x96: 0x152, 0x97: 0x160, 0x98: 0x178, 0x99: 0x17d, 0x9a: 0x131, 0x9b: 0x142, 0x9c: 0x153, 0x9d: 0x161, 0x9e: 0x17e, 0xa0: 0x20ac };

// A PDF text string: UTF-16 or UTF-8 with a byte order mark, otherwise PDFDocEncoding.
export function decodeText(bytes) {
  let s;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) s = utf16(bytes.subarray(2), false);
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) s = utf16(bytes.subarray(2), true);
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) s = utf8.decode(bytes.subarray(3));
  else { s = ''; for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...Array.from(bytes.subarray(i, i + 4096), (b) => PDFDOC[b] ?? b)); }
  // Language tags are wrapped in ESC characters.
  return clean(s.replace(/\x1b[^\x1b]*\x1b/g, '').replace(/[\0-\x08\x0b\x0e-\x1f]/g, ''));
}

// Any value as display text.
export function text(v) {
  if (v instanceof Str) return decodeText(v.bytes);
  if (v instanceof Name) return v.name;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

const DATE = /^\s*(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*([Zz+-])?\s*(\d{2})?'?(\d{2})?'?/;
export function pdfDate(s) {
  const m = DATE.exec(s);
  if (!m) return s;
  const [, y, mo = '01', d = '01', h, mi, se, z, zh, zm] = m;
  let out = `${y}-${mo}-${d}`;
  if (h) out += ` ${h}:${mi ?? '00'}:${se ?? '00'}`;
  if (z === 'Z' || z === 'z') out += ' UTC';
  else if (z && zh) out += ` ${z}${zh}:${zm ?? '00'}`;
  return out;
}

export function indexOfBytes(u8, pattern, from = 0, to = u8.length) {
  const first = pattern.charCodeAt(0); const n = pattern.length;
  for (let i = u8.indexOf(first, from); i >= 0 && i + n <= to; i = u8.indexOf(first, i + 1)) {
    let k = 1; while (k < n && u8[i + k] === pattern.charCodeAt(k)) k++;
    if (k === n) return i;
  }
  return -1;
}

export function lastIndexOfBytes(u8, pattern, from = u8.length - pattern.length) {
  const first = pattern.charCodeAt(0); const n = pattern.length;
  for (let i = u8.lastIndexOf(first, from); i >= 0; i = i > 0 ? u8.lastIndexOf(first, i - 1) : -1) {
    let k = 1; while (k < n && u8[i + k] === pattern.charCodeAt(k)) k++;
    if (k === n) return i;
  }
  return -1;
}
