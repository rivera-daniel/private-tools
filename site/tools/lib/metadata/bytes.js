// Bounds-checked byte access and text helpers shared by every parser. All input is hostile.

export const LIMITS = {
  maxFileBytes: 200 * 1024 * 1024,
  maxInflateBytes: 8 * 1024 * 1024,
  maxInflateBytesPerFile: 32 * 1024 * 1024,
  // Each decompression costs a round trip through the browser's stream machinery, so thousands of tiny
  // compressed chunks take seconds even when the bytes are few.
  maxInflatesPerFile: 1000,
  maxIfdEntries: 1000,
  maxIfds: 64,
  maxTextChars: 200000,
  maxFieldsPerSource: 3000,
  maxHighlightsPerGroup: 300,
  maxStructure: 3000,
  maxCborDepth: 64,
  maxCborItems: 100000,
  maxXmpChars: 4 * 1024 * 1024,
  maxSvgChars: 10 * 1024 * 1024,
};

export class Bytes {
  constructor(u8) { this.u8 = u8; this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  get length() { return this.u8.length; }
  has(offset, size) { return Number.isInteger(offset) && Number.isFinite(size) && offset >= 0 && size >= 0 && offset + size <= this.u8.length; }
  need(o, n) { if (!this.has(o, n)) throw new RangeError('read past end'); }
  u8at(o) { this.need(o, 1); return this.u8[o]; }
  i8(o) { this.need(o, 1); return this.view.getInt8(o); }
  u16(o, le = false) { this.need(o, 2); return this.view.getUint16(o, le); }
  i16(o, le = false) { this.need(o, 2); return this.view.getInt16(o, le); }
  u24(o, le = false) { this.need(o, 3); return le ? this.u8[o] | (this.u8[o + 1] << 8) | (this.u8[o + 2] << 16) : (this.u8[o] << 16) | (this.u8[o + 1] << 8) | this.u8[o + 2]; }
  u32(o, le = false) { this.need(o, 4); return this.view.getUint32(o, le); }
  i32(o, le = false) { this.need(o, 4); return this.view.getInt32(o, le); }
  u64(o, le = false) { this.need(o, 8); const a = this.view.getUint32(o, le); const b = this.view.getUint32(o + 4, le); return le ? b * 2 ** 32 + a : a * 2 ** 32 + b; }
  f32(o, le = false) { this.need(o, 4); return this.view.getFloat32(o, le); }
  f64(o, le = false) { this.need(o, 8); return this.view.getFloat64(o, le); }
  slice(o, n) { const start = Math.max(0, Math.min(o, this.u8.length)); return this.u8.subarray(start, Math.max(start, Math.min(this.u8.length, o + n))); }
  sub(o, n) { return new Bytes(this.slice(o, n)); }
  ascii(o, n) { return latin1(this.slice(o, n)); }
}

export const utf8 = new TextDecoder('utf-8', { fatal: false });
export const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode(...u8.subarray(i, i + 4096)); return s; };
export const utf16 = (u8, le) => new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(u8);
export const clip = (s) => (s.length > LIMITS.maxTextChars ? s.slice(0, LIMITS.maxTextChars) : s);
export const clean = (s) => clip(String(s).replace(/\0+$/, '').trim());
export const printable = (s) => s.replace(/[^\x20-\x7e]/g, '').trim();
export const startsWith = (u8, sig, at = 0) => sig.length + at <= u8.length && [...sig].every((c, i) => u8[at + i] === c.charCodeAt(0));
export const indexOfZero = (u8, from = 0) => { for (let i = from; i < u8.length; i++) if (u8[i] === 0) return i; return -1; };
export const pad = (n) => String(n).padStart(2, '0');
export const fmtBytes = (n) => `${Number(n).toLocaleString('en-US')} bytes`;
export const hex = (n, w = 4) => `0x${n.toString(16).toUpperCase().padStart(w, '0')}`;

export function hexPreview(u8, max = 32) {
  const shown = [...u8.subarray(0, max)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  return u8.length > max ? `${shown} … (${fmtBytes(u8.length)})` : shown;
}

// Shows bytes as text when they read as text, otherwise as a hex preview.
export function bytesValue(u8) {
  const trimmed = u8.length && u8[u8.length - 1] === 0 ? u8.subarray(0, indexOfZero(u8)) : u8;
  if (trimmed.length && trimmed.length <= LIMITS.maxTextChars) {
    const text = utf8.decode(trimmed);
    if (!text.includes('�') && !/[\x00-\x08\x0e-\x1f]/.test(text)) return text.trim();
  }
  return hexPreview(u8);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
// CRC-32 as used by PNG, ZIP and gzip. Pass the previous result to continue over several chunks.
export function crc32(u8, previous = 0) { let c = ~previous >>> 0; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; }

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function inflate(u8, limit = LIMITS.maxInflateBytes, format = 'deflate') {
  const reader = new Blob([u8]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error(`decompressed data exceeds ${Math.round(limit / 1048576)} MB limit`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concat(chunks);
}
