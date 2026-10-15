// ASN.1 for certificates, CMS and PKCS #12: a DER encoder and a reader that also accepts the BER
// indefinite lengths some PKCS #12 writers use. All input is hostile: lengths are checked against the data
// and nesting and node counts are capped.

export class Asn1Error extends Error {}

const MAX_DEPTH = 40;
const MAX_NODES = 200000;

/* Reading */

export class Node {
  constructor(u8, tag, headerStart, start, end, next, budget, depth) {
    this.u8 = u8; this.tag = tag; this.headerStart = headerStart; this.start = start; this.end = end; this.next = next;
    this.budget = budget; this.depth = depth; this.kids = null;
  }

  get constructed() { return (this.tag & 0x20) !== 0; }
  get cls() { return this.tag >> 6; }
  // The tag number of a context-specific tag such as [0].
  get number() { return this.tag & 0x1f; }
  get content() { return this.u8.subarray(this.start, this.end); }
  // The whole encoding, header included. Exact for DER input.
  get der() { return this.u8.subarray(this.headerStart, this.next); }

  get children() {
    if (this.kids) return this.kids;
    if (!this.constructed) throw new Asn1Error('expected a constructed value');
    const out = []; let p = this.start;
    while (p < this.end) { const n = readNode(this.u8, p, this.end, this.depth + 1, this.budget); out.push(n); p = n.next; }
    this.kids = out;
    return out;
  }

  child(i) { const c = this.children[i]; if (!c) throw new Asn1Error('a value is missing'); return c; }
  // The [n] context-specific child, or null.
  tagged(n) { return this.children.find((c) => c.tag === (0xa0 | n) || c.tag === (0x80 | n)) ?? null; }
  expect(tag, what = 'value') { if (this.tag !== tag) throw new Asn1Error(`unexpected ${what}`); return this; }
}

function readNode(u8, pos, end, depth, budget) {
  if (depth > MAX_DEPTH) throw new Asn1Error('values are nested too deeply');
  if (--budget.n < 0) throw new Asn1Error('too many values');
  if (pos + 2 > end) throw new Asn1Error('truncated value');
  const tag = u8[pos]; let p = pos + 1;
  if ((tag & 0x1f) === 0x1f) throw new Asn1Error('unsupported tag');
  let len = u8[p++];
  if (len === 0x80) {
    if (!(tag & 0x20)) throw new Asn1Error('indefinite length on a primitive value');
    const start = p; let q = p;
    for (;;) {
      if (q + 2 > end) throw new Asn1Error('unterminated value');
      if (u8[q] === 0 && u8[q + 1] === 0) break;
      q = readNode(u8, q, end, depth + 1, budget).next;
    }
    return new Node(u8, tag, pos, start, q, q + 2, budget, depth);
  }
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > end) throw new Asn1Error('bad length');
    len = 0; for (let i = 0; i < n; i++) len = len * 256 + u8[p++];
  }
  if (p + len > end) throw new Asn1Error('truncated value');
  return new Node(u8, tag, pos, p, p + len, p + len, budget, depth);
}

// Reads one value. With trailing allowed, bytes after it are ignored (PDF /Contents is zero padded).
export function parse(u8, { trailing = false } = {}) {
  const n = readNode(u8, 0, u8.length, 0, { n: MAX_NODES });
  if (!trailing && n.next !== u8.length) throw new Asn1Error('data after the value');
  return n;
}

export function oidOf(node) {
  node.expect(0x06, 'object identifier');
  const b = node.content; if (!b.length || b.length > 64) throw new Asn1Error('bad object identifier');
  const parts = []; let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      if (!parts.length) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80); else parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

export function bigIntOf(node) {
  node.expect(0x02, 'integer');
  let v = 0n; for (const b of node.content) v = (v << 8n) | BigInt(b);
  if (node.content.length && node.content[0] & 0x80) v -= 1n << BigInt(node.content.length * 8);
  return v;
}

export function intOf(node) {
  const v = bigIntOf(node);
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Asn1Error('integer too large');
  return Number(v);
}

// The unsigned magnitude of an INTEGER, without the sign byte.
export function uintBytes(node) {
  node.expect(0x02, 'integer');
  let b = node.content; while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  return b;
}

export function bitsOf(node) {
  node.expect(0x03, 'bit string');
  if (!node.content.length) throw new Asn1Error('empty bit string');
  return node.content.subarray(1);
}

// Concatenates a possibly constructed (BER) OCTET STRING.
export function octetsOf(node) {
  return node.constructed ? concat(node.children.map(octetsOf)) : node.content;
}

const latin = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode(...u8.subarray(i, i + 4096)); return s; };

export function stringOf(node) {
  const b = node.content;
  switch (node.tag) {
    case 0x0c: return new TextDecoder('utf-8').decode(b);
    case 0x1e: return new TextDecoder('utf-16be').decode(b);
    case 0x1c: { let s = ''; for (let i = 0; i + 3 < b.length; i += 4) s += String.fromCodePoint(((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0); return s; }
    case 0x13: case 0x16: case 0x14: case 0x1a: case 0x12: return latin(b);
    default: throw new Asn1Error('expected a string');
  }
}

// UTCTime or GeneralizedTime as a Date.
export function timeOf(node) {
  const s = latin(node.content);
  const m = node.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s) : node.tag === 0x18 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s) : null;
  if (!m) throw new Asn1Error('bad time');
  let year = Number(m[1]); if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

/* Writing (DER) */

export function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function lengthBytes(n) {
  if (n < 0x80) return [n];
  const b = []; while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return [0x80 | b.length, ...b];
}

export function tlv(tag, content) {
  const len = lengthBytes(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag; out.set(len, 1); out.set(content, 1 + len.length);
  return out;
}

export const seq = (...items) => tlv(0x30, concat(items.filter(Boolean)));
// DER SET OF: elements sorted by their encodings.
export const set = (...items) => tlv(0x31, concat(items.filter(Boolean).sort(compareBytes)));
export const octets = (u8) => tlv(0x04, u8);
export const nullValue = () => new Uint8Array([0x05, 0x00]);
export const bits = (u8) => tlv(0x03, concat([new Uint8Array([0]), u8]));
export const bool = (v) => new Uint8Array([0x01, 0x01, v ? 0xff : 0]);
export const utf8String = (s) => tlv(0x0c, new TextEncoder().encode(s));
export const printableString = (s) => tlv(0x13, Uint8Array.from(s, (c) => c.charCodeAt(0)));
// [n] EXPLICIT wraps a whole value; [n] IMPLICIT replaces the tag of a constructed value.
export const explicit = (n, value) => tlv(0xa0 | n, value);
export const implicit = (n, value, constructed = true) => { const out = value.slice(); out[0] = (constructed ? 0xa0 : 0x80) | n; return out; };

export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function oid(s) {
  const parts = s.split('.').map(Number);
  const out = [];
  const push = (v) => { const b = [v & 0x7f]; v = Math.floor(v / 128); while (v > 0) { b.unshift(0x80 | (v & 0x7f)); v = Math.floor(v / 128); } out.push(...b); };
  push(parts[0] * 40 + parts[1]);
  for (const p of parts.slice(2)) push(p);
  return tlv(0x06, Uint8Array.from(out));
}

// An INTEGER from a number, bigint or unsigned big-endian bytes.
export function int(v) {
  let b;
  if (v instanceof Uint8Array) { b = v; let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); if (!b.length) b = new Uint8Array([0]); if (b[0] & 0x80) b = concat([new Uint8Array([0]), b]); }
  else {
    let x = BigInt(v); const out = [];
    if (x === 0n) out.push(0);
    while (x > 0n) { out.unshift(Number(x & 0xffn)); x >>= 8n; }
    if (out[0] & 0x80) out.unshift(0);
    b = Uint8Array.from(out);
  }
  return tlv(0x02, b);
}

const two = (n) => String(n).padStart(2, '0');
// UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires.
export function time(date) {
  const y = date.getUTCFullYear();
  const rest = `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  const s = y < 2050 && y >= 1950 ? `${two(y % 100)}${rest}` : `${y}${rest}`;
  return tlv(y < 2050 && y >= 1950 ? 0x17 : 0x18, Uint8Array.from(s, (c) => c.charCodeAt(0)));
}

/* ECDSA signature formats: WebCrypto uses r||s, CMS and X.509 use SEQUENCE { r INTEGER, s INTEGER }. */

export function ecdsaRawToDer(raw) {
  const half = raw.length / 2;
  return seq(int(raw.subarray(0, half)), int(raw.subarray(half)));
}

export function ecdsaDerToRaw(der, size) {
  const n = parse(der).expect(0x30, 'signature');
  const out = new Uint8Array(size * 2);
  [0, 1].forEach((i) => {
    const v = uintBytes(n.child(i));
    if (v.length > size) throw new Asn1Error('bad ECDSA signature');
    out.set(v, size * (i + 1) - v.length);
  });
  return out;
}

export const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export function fromHex(s) {
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Asn1Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
