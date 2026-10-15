// Stream filters. Image codecs are not decoded: decoding stops there and reports which codec remains.
import { concat } from '../bytes.js';
import { Dict, nameOf } from './syntax.js';

const ALIASES = { Fl: 'FlateDecode', LZW: 'LZWDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', RL: 'RunLengthDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode' };
export const IMAGE_CODECS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);

// A shared allowance of decompressed bytes. Each stream is also capped on its own.
export class Budget {
  constructor(total, perStream) { this.left = total; this.perStream = perStream; }
  take(n) { this.left -= n; }
}

export function filtersOf(dict, resolve = (v) => v) {
  const f = resolve(dict.get('Filter')); const p = resolve(dict.get('DecodeParms') ?? dict.get('DP'));
  const names = (Array.isArray(f) ? f : f ? [f] : []).map((x) => { const n = nameOf(resolve(x)) ?? ''; return ALIASES[n] ?? n; });
  const parms = Array.isArray(p) ? p.map((x) => resolve(x)) : [resolve(p)];
  return names.map((name, i) => ({ name, parms: parms[i] instanceof Dict ? parms[i] : null }));
}

// Inflates zlib data, keeping whatever came out before an error: PDF writers often leave streams unterminated.
export async function inflate(u8, limit) {
  const run = async (format, data) => {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    const chunks = []; let total = 0; let error = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) throw new RangeError(`decompressed data exceeds ${Math.round(limit / 1048576)} MB limit`);
        chunks.push(value);
      }
    } catch (e) { if (e instanceof RangeError) throw e; error = e; }
    finally { await reader.cancel().catch(() => {}); }
    return { data: concat(chunks), error };
  };
  const zlib = u8.length >= 2 && (u8[0] & 0x0f) === 8 && ((u8[0] << 8) | u8[1]) % 31 === 0;
  let r = await run(zlib ? 'deflate' : 'deflate-raw', u8);
  if (zlib && r.error && !r.data.length) r = await run('deflate-raw', u8.subarray(2));
  if (r.error && !r.data.length) throw new Error('not valid compressed data');
  return r.data;
}

// Decodes through the filter chain. Returns { data, codec } where codec names an image codec left undecoded.
export async function decode(raw, dict, { resolve = (v) => v, budget }) {
  let data = raw;
  for (const { name, parms } of filtersOf(dict, resolve)) {
    if (IMAGE_CODECS.has(name)) return { data, codec: name };
    const limit = Math.min(budget.perStream, budget.left);
    if (limit <= 0) throw new RangeError('the decompression allowance for this file is used up');
    if (name === 'FlateDecode') data = unpredict(await inflate(data, limit), parms, resolve);
    else if (name === 'LZWDecode') data = unpredict(lzw(data, limit, num(resolve(parms?.get('EarlyChange')), 1)), parms, resolve);
    else if (name === 'ASCIIHexDecode') data = asciiHex(data, limit);
    else if (name === 'ASCII85Decode') data = ascii85(data, limit);
    else if (name === 'RunLengthDecode') data = runLength(data, limit);
    else if (name === 'Crypt') { if (nameOf(resolve(parms?.get('Name'))) && nameOf(resolve(parms.get('Name'))) !== 'Identity') throw new Error('encrypted stream'); }
    else throw new Error(`unsupported filter ${name || '(unnamed)'}`);
    if (data.length > limit) throw new RangeError('decompressed data exceeds the limit');
    budget.take(data.length);
  }
  return { data, codec: null };
}

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

function unpredict(data, parms, resolve) {
  if (!parms) return data;
  const predictor = num(resolve(parms.get('Predictor')), 1);
  if (predictor < 2) return data;
  const colors = Math.min(Math.max(num(resolve(parms.get('Colors')), 1), 1), 32);
  const bpc = [1, 2, 4, 8, 16].includes(resolve(parms.get('BitsPerComponent'))) ? resolve(parms.get('BitsPerComponent')) : 8;
  const columns = Math.min(Math.max(num(resolve(parms.get('Columns')), 1), 1), 1 << 24);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return data;
    const out = data.slice();
    for (let row = 0; row < out.length; row += rowLen) for (let i = row + bpp; i < Math.min(row + rowLen, out.length); i++) out[i] = (out[i] + out[i - bpp]) & 0xff;
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]; const src = r * (rowLen + 1) + 1; const at = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i]; const a = i >= bpp ? out[at + i - bpp] : 0; const b = r ? out[at - rowLen + i] : 0; const c = r && i >= bpp ? out[at - rowLen + i - bpp] : 0;
      let v = x;
      if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[at + i] = v & 0xff;
    }
  }
  return out;
}

// A growing byte buffer that refuses to pass its limit, checked before every append.
class Output {
  constructor(limit) { this.limit = limit; this.buf = new Uint8Array(Math.max(16, Math.min(limit, 4096))); this.n = 0; }
  room(k) {
    if (this.n + k > this.limit) throw new RangeError('decompressed data exceeds the limit');
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2; while (size < this.n + k) size *= 2;
    const b = new Uint8Array(Math.min(size, this.limit)); b.set(this.buf.subarray(0, this.n)); this.buf = b;
  }
  push(x) { this.room(1); this.buf[this.n++] = x; }
  append(bytes) { this.room(bytes.length); this.buf.set(bytes, this.n); this.n += bytes.length; }
  fill(x, k) { this.room(k); this.buf.fill(x, this.n, this.n + k); this.n += k; }
  bytes() { return this.buf.slice(0, this.n); }
}

function asciiHex(data, limit) {
  const out = new Output(limit); let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return out.bytes();
}

function ascii85(data, limit) {
  const out = new Output(limit); const group = [];
  let i = data[0] === 0x3c && data[1] === 0x7e ? 2 : 0;
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break;
    if (c === 0x7a && !group.length) { out.fill(0, 4); continue; }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 33);
    if (group.length === 5) { push85(group, 4, out); group.length = 0; }
  }
  if (group.length > 1) { const n = group.length - 1; while (group.length < 5) group.push(84); push85(group, n, out); }
  return out.bytes();
}

function push85(g, n, out) {
  const v = (((g[0] * 85 + g[1]) * 85 + g[2]) * 85 + g[3]) * 85 + g[4];
  const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  for (let k = 0; k < n; k++) out.push(bytes[k]);
}

function runLength(data, limit) {
  const out = new Output(limit); let i = 0;
  while (i < data.length) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) { const end = Math.min(data.length, i + n + 1); out.append(data.subarray(i, end)); i = end; }
    else { const b = data[i++]; out.fill(b, 257 - n); }
  }
  return out.bytes();
}

function lzw(data, limit, early) {
  const out = new Output(limit); let dict = []; let width = 9; let prev = null; let bits = 0; let acc = 0;
  const reset = () => { dict = Array.from({ length: 258 }, (_, i) => (i < 256 ? Uint8Array.of(i) : null)); width = 9; prev = null; };
  const extend = (a, x) => { const e = new Uint8Array(a.length + 1); e.set(a); e[a.length] = x; return e; };
  reset();
  for (const byte of data) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= width) {
      const code = (acc >>> (bits - width)) & ((1 << width) - 1); bits -= width; acc &= (1 << bits) - 1;
      if (code === 256) { reset(); continue; }
      if (code === 257) return out.bytes();
      let entry = dict[code];
      if (!entry) { if (!prev || code !== dict.length) return out.bytes(); entry = extend(prev, prev[0]); }
      out.append(entry);
      if (prev && dict.length < 4096) dict.push(extend(prev, entry[0]));
      prev = entry;
      if (dict.length + early >= 1 << width && width < 12) width++;
    }
  }
  return out.bytes();
}
