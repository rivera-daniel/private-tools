// WinZip AES encryption for ZIP entries (AE-1 and AE-2, method 99, extra field 0x9901).
// Key derivation uses the browser's PBKDF2. AES and HMAC-SHA1 run here in plain JavaScript because
// WinZip's counter mode is little-endian (WebCrypto's AES-CTR counts big-endian) and WebCrypto's HMAC
// cannot be fed a stream. Both are checked against WebCrypto and published test vectors in the tests.

const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256); const T1 = new Uint32Array(256); const T2 = new Uint32Array(256); const T3 = new Uint32Array(256);
(() => {
  const exp = new Uint8Array(256); const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 256; i++) { exp[i] = x; log[x] = i; x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0); x &= 0xff; }
  for (let i = 0; i < 256; i++) {
    let s = i === 0 ? 0 : exp[255 - log[i]];
    s ^= ((s << 1) | (s >> 7)) ^ ((s << 2) | (s >> 6)) ^ ((s << 3) | (s >> 5)) ^ ((s << 4) | (s >> 4)) ^ 0x63;
    SBOX[i] = s & 0xff;
  }
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i]; const s2 = ((s << 1) ^ (s & 0x80 ? 0x11b : 0)) & 0xff; const s3 = s2 ^ s;
    T0[i] = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T1[i] = ((s3 << 24) | (s2 << 16) | (s << 8) | s) >>> 0;
    T2[i] = ((s << 24) | (s3 << 16) | (s2 << 8) | s) >>> 0;
    T3[i] = ((s << 24) | (s << 16) | (s3 << 8) | s2) >>> 0;
  }
})();

// AES block encryption (FIPS-197) for 128, 192 and 256-bit keys.
export class Aes {
  constructor(key) {
    if (![16, 24, 32].includes(key.length)) throw new Error('AES key must be 16, 24 or 32 bytes');
    const nk = key.length / 4; this.rounds = nk + 6;
    const w = new Uint32Array(4 * (this.rounds + 1));
    for (let i = 0; i < nk; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    for (let i = nk, rcon = 1; i < w.length; i++) {
      let t = w[i - 1];
      if (i % nk === 0) {
        t = ((SBOX[(t >>> 16) & 0xff] << 24) | (SBOX[(t >>> 8) & 0xff] << 16) | (SBOX[t & 0xff] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
        rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
      } else if (nk > 6 && i % nk === 4) {
        t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff];
      }
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    this.w = w;
  }

  // Encrypts the 16 bytes at input[i..] into output[o..].
  encryptBlock(input, i, output, o) {
    const w = this.w;
    let s0 = ((input[i] << 24) | (input[i + 1] << 16) | (input[i + 2] << 8) | input[i + 3]) ^ w[0];
    let s1 = ((input[i + 4] << 24) | (input[i + 5] << 16) | (input[i + 6] << 8) | input[i + 7]) ^ w[1];
    let s2 = ((input[i + 8] << 24) | (input[i + 9] << 16) | (input[i + 10] << 8) | input[i + 11]) ^ w[2];
    let s3 = ((input[i + 12] << 24) | (input[i + 13] << 16) | (input[i + 14] << 8) | input[i + 15]) ^ w[3];
    let k = 4;
    for (let r = 1; r < this.rounds; r++, k += 4) {
      const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ w[k];
      const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ w[k + 1];
      const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ w[k + 2];
      const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ w[k + 3];
      s0 = t0; s1 = t1; s2 = t2; s3 = t3;
    }
    const last = (a, b, c, d, key) => ((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 0xff] << 16) | (SBOX[(c >>> 8) & 0xff] << 8) | SBOX[d & 0xff]) ^ key;
    const r0 = last(s0, s1, s2, s3, w[k]); const r1 = last(s1, s2, s3, s0, w[k + 1]);
    const r2 = last(s2, s3, s0, s1, w[k + 2]); const r3 = last(s3, s0, s1, s2, w[k + 3]);
    output[o] = r0 >>> 24; output[o + 1] = r0 >>> 16; output[o + 2] = r0 >>> 8; output[o + 3] = r0;
    output[o + 4] = r1 >>> 24; output[o + 5] = r1 >>> 16; output[o + 6] = r1 >>> 8; output[o + 7] = r1;
    output[o + 8] = r2 >>> 24; output[o + 9] = r2 >>> 16; output[o + 10] = r2 >>> 8; output[o + 11] = r2;
    output[o + 12] = r3 >>> 24; output[o + 13] = r3 >>> 16; output[o + 14] = r3 >>> 8; output[o + 15] = r3;
  }
}

// AES in counter mode with WinZip's counter: a 16-byte little-endian integer starting at 1.
// The same call encrypts and decrypts. Keystream position carries over between calls.
export class WinZipCtr {
  constructor(key) { this.aes = new Aes(key); this.counter = new Uint8Array(16); this.stream = new Uint8Array(16); this.used = 16; }
  process(data) {
    const out = new Uint8Array(data.length);
    const { counter, stream } = this;
    for (let i = 0; i < data.length; i++) {
      if (this.used === 16) {
        for (let j = 0; j < 16 && ++counter[j] === 256; j++) counter[j] = 0;
        this.aes.encryptBlock(counter, 0, stream, 0); this.used = 0;
      }
      out[i] = data[i] ^ stream[this.used++];
    }
    return out;
  }
}

// SHA-1 (FIPS 180-4), fed in pieces.
export class Sha1 {
  constructor() { this.h = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]); this.buf = new Uint8Array(64); this.fill = 0; this.total = 0; this.w = new Int32Array(80); }
  update(data) {
    let i = 0; this.total += data.length;
    if (this.fill) {
      const take = Math.min(64 - this.fill, data.length);
      this.buf.set(data.subarray(0, take), this.fill); this.fill += take; i = take;
      if (this.fill < 64) return this;
      this.block(this.buf, 0); this.fill = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) { this.buf.set(data.subarray(i), 0); this.fill = data.length - i; }
    return this;
  }
  block(d, o) {
    const w = this.w;
    for (let t = 0; t < 16; t++, o += 4) w[t] = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
    for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
    let [a, b, c, e, f] = this.h;
    for (let t = 0; t < 80; t++) {
      const k = t < 20 ? ((b & c) | (~b & e)) + 0x5a827999 : t < 40 ? (b ^ c ^ e) + 0x6ed9eba1 : t < 60 ? ((b & c) | (b & e) | (c & e)) + 0x8f1bbcdc : (b ^ c ^ e) + 0xca62c1d6;
      const temp = (((a << 5) | (a >>> 27)) + k + f + w[t]) | 0;
      f = e; e = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    const h = this.h; h[0] += a; h[1] += b; h[2] += c; h[3] += e; h[4] += f;
  }
  digest() {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.fill < 56 ? 56 : 120) - this.fill) + 8); pad[0] = 0x80;
    const v = new DataView(pad.buffer); v.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32)); v.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    const out = new Uint8Array(20); const ov = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) ov.setInt32(i * 4, this.h[i]);
    return out;
  }
}

export class HmacSha1 {
  constructor(key) {
    const k = new Uint8Array(64); k.set(key.length > 64 ? new Sha1().update(key).digest() : key);
    this.inner = new Sha1().update(k.map((b) => b ^ 0x36)); this.outerKey = k.map((b) => b ^ 0x5c);
  }
  update(data) { this.inner.update(data); return this; }
  digest() { return new Sha1().update(this.outerKey).update(this.inner.digest()).digest(); }
}

export const AES_STRENGTH = { 1: { key: 16, salt: 8 }, 2: { key: 24, salt: 12 }, 3: { key: 32, salt: 16 } };
export const AES_MAC_BYTES = 10;

// Derives the AES key, the HMAC key and the 2-byte password verification value.
export async function deriveKeys(password, salt, strength = 3) {
  const { key: n } = AES_STRENGTH[strength];
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-1', salt, iterations: 1000 }, material, (2 * n + 2) * 8));
  return { aesKey: bits.subarray(0, n), macKey: bits.subarray(n, 2 * n), verifier: bits.subarray(2 * n, 2 * n + 2) };
}

// The 0x9901 extra field: vendor version (1 = AE-1, 2 = AE-2), vendor "AE", strength, real method.
export function aesExtra(method, strength = 3, version = 2) {
  const out = new Uint8Array(11); const v = new DataView(out.buffer);
  v.setUint16(0, 0x9901, true); v.setUint16(2, 7, true); v.setUint16(4, version, true);
  out[6] = 0x41; out[7] = 0x45; out[8] = strength; v.setUint16(9, method, true);
  return out;
}

export function parseAesExtra(data) {
  if (data.length < 7 || data[2] !== 0x41 || data[3] !== 0x45) return null;
  const strength = data[4];
  if (!AES_STRENGTH[strength]) return null;
  return { version: data[0] | (data[1] << 8), strength, method: data[5] | (data[6] << 8) };
}

// Encrypts a stream of compressed bytes. Yields salt and verifier first, the MAC last.
export async function* aesEncrypt(source, password, strength = 3) {
  const salt = crypto.getRandomValues(new Uint8Array(AES_STRENGTH[strength].salt));
  const { aesKey, macKey, verifier } = await deriveKeys(password, salt, strength);
  const ctr = new WinZipCtr(aesKey); const mac = new HmacSha1(macKey);
  const head = new Uint8Array(salt.length + 2); head.set(salt); head.set(verifier, salt.length);
  yield head;
  for await (const chunk of source) { const enc = ctr.process(chunk); mac.update(enc); yield enc; }
  yield mac.digest().subarray(0, AES_MAC_BYTES);
}

export const aesOverhead = (strength = 3) => AES_STRENGTH[strength].salt + 2 + AES_MAC_BYTES;

export class WrongPassword extends Error { constructor(message = 'The password is not correct.') { super(message); this.name = 'WrongPassword'; } }

// Decrypts ciphertext (without salt, verifier and MAC) after checking the verifier. The MAC is checked
// when the stream ends and a mismatch throws, so the consumer must discard everything it received.
export async function* aesDecrypt(source, { password, salt, verifier, mac: expected, strength }) {
  const keys = await deriveKeys(password, salt, strength);
  if (keys.verifier[0] !== verifier[0] || keys.verifier[1] !== verifier[1]) throw new WrongPassword();
  const ctr = new WinZipCtr(keys.aesKey); const mac = new HmacSha1(keys.macKey);
  for await (const chunk of source) { mac.update(chunk); yield ctr.process(chunk); }
  const got = mac.digest();
  for (let i = 0; i < AES_MAC_BYTES; i++) if (got[i] !== expected[i]) throw new Error('authentication failed: the encrypted data was altered or damaged');
}
