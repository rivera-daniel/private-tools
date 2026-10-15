// PKCS #12 (.p12 / .pfx) certificate files: integrity check, decryption and key import into WebCrypto.
// Modern files use PBES2 (PBKDF2 + AES-CBC) with an HMAC-SHA-256 MAC. Older files, such as those Windows
// and OpenSSL 1.x export by default, use the PKCS #12 key derivation with SHA-1, 3DES for the key and 40-bit
// RC2 for the certificates; WebCrypto has neither cipher, so both are implemented below (decryption only).
// The private key is imported as non-extractable, and the decrypted key bytes are overwritten afterwards.
import { parse, oidOf, intOf, octetsOf, stringOf, Asn1Error, compareBytes, seq, oid, nullValue, bits, ecdsaRawToDer, ecdsaDerToRaw } from './asn1.js';
import { parseCertificate, algorithmsFor, checkKeyMatchesAlgorithm } from './cms.js';

export class P12Error extends Error {}

const O = {
  data: '1.2.840.113549.1.7.1', encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1', shroudedKeyBag: '1.2.840.113549.1.12.10.1.2', certBag: '1.2.840.113549.1.12.10.1.3', x509: '1.2.840.113549.1.9.22.1',
  localKeyId: '1.2.840.113549.1.9.21', friendlyName: '1.2.840.113549.1.9.20',
  pbes2: '1.2.840.113549.1.5.13', pbkdf2: '1.2.840.113549.1.5.12', pbmac1: '1.2.840.113549.1.5.14',
  sha3des: '1.2.840.113549.1.12.1.3', sha2des: '1.2.840.113549.1.12.1.4', sha128rc2: '1.2.840.113549.1.12.1.5', sha40rc2: '1.2.840.113549.1.12.1.6',
  rsaEncryption: '1.2.840.113549.1.1.1', ecPublicKey: '1.2.840.10045.2.1',
};
const HASH = { '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512' };
const HMAC = { '1.2.840.113549.2.7': 'SHA-1', '1.2.840.113549.2.9': 'SHA-256', '1.2.840.113549.2.10': 'SHA-384', '1.2.840.113549.2.11': 'SHA-512' };
const AES = { '2.16.840.1.101.3.4.1.2': 16, '2.16.840.1.101.3.4.1.22': 24, '2.16.840.1.101.3.4.1.42': 32 };
const DES_EDE3_CBC = '1.2.840.113549.3.7';
const SIZE = { 'SHA-1': [20, 64], 'SHA-256': [32, 64], 'SHA-384': [48, 128], 'SHA-512': [64, 128] };
const CURVES = { '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384', '1.3.132.0.35': 'P-521' };
const MAX_ITERATIONS = 10000000;

const subtle = () => crypto.subtle;
const utf8 = (s) => new TextEncoder().encode(s);
// The password as a BMPString with a two-byte terminator, as the PKCS #12 key derivation wants it.
function bmp(password) {
  const out = new Uint8Array(password.length * 2 + 2);
  for (let i = 0; i < password.length; i++) { const c = password.charCodeAt(i); out[i * 2] = c >> 8; out[i * 2 + 1] = c & 0xff; }
  return out;
}
const iterationsOf = (node) => { const n = node ? intOf(node) : 1; if (n < 1 || n > MAX_ITERATIONS) throw new P12Error('The file asks for an unreasonable number of key derivation rounds.'); return n; };

/* RFC 7292 appendix B key derivation */

// The derivation hashes thousands of times; SHA-1 and SHA-256 run here synchronously because one awaited
// WebCrypto call per round takes seconds in total. SHA-384 and SHA-512 MACs, which are rare, use WebCrypto.
const K256 = Uint32Array.from('428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'.split(' '), (h) => parseInt(h, 16));
const rotl = (x, n) => (x << n) | (x >>> (32 - n));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function padded(msg) {
  const n = ((msg.length + 9 + 63) >> 6) << 6;
  const b = new Uint8Array(n); b.set(msg); b[msg.length] = 0x80;
  const bitsLen = msg.length * 8;
  b[n - 4] = bitsLen >>> 24; b[n - 3] = bitsLen >>> 16; b[n - 2] = bitsLen >>> 8; b[n - 1] = bitsLen;
  b[n - 5] = Math.floor(bitsLen / 2 ** 32);
  return b;
}
function words(h) { const out = new Uint8Array(h.length * 4); h.forEach((v, i) => { out[i * 4] = v >>> 24; out[i * 4 + 1] = v >>> 16; out[i * 4 + 2] = v >>> 8; out[i * 4 + 3] = v; }); return out; }

export function sha1(msg) {
  const b = padded(msg); const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]; const w = new Int32Array(80);
  for (let o = 0; o < b.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (b[o + i * 4] << 24) | (b[o + i * 4 + 1] << 16) | (b[o + i * 4 + 2] << 8) | b[o + i * 4 + 3];
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, bb, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (bb & c) | (~bb & d) : i < 40 ? bb ^ c ^ d : i < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(bb, 30); bb = a; a = t;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
  }
  return words(h);
}

export function sha256(msg) {
  const b = padded(msg); const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]; const w = new Int32Array(64);
  for (let o = 0; o < b.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (b[o + i * 4] << 24) | (b[o + i * 4 + 1] << 16) | (b[o + i * 4 + 2] << 8) | b[o + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3); const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    [a, bb, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
  }
  return words(h);
}

const SYNC = { 'SHA-1': sha1, 'SHA-256': sha256 };
const hashOnce = async (hash, data) => (SYNC[hash] ? SYNC[hash](data) : new Uint8Array(await subtle().digest(hash, data)));

export async function pkcs12Kdf(hash, password, salt, id, iterations, length) {
  const [u, v] = SIZE[hash];
  const fill = (src) => { const n = src.length ? v * Math.ceil(src.length / v) : 0; const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = src[i % src.length]; return out; };
  const S = fill(salt); const P = fill(password);
  const I = new Uint8Array(S.length + P.length); I.set(S); I.set(P, S.length);
  const D = new Uint8Array(v).fill(id);
  const out = new Uint8Array(length);
  for (let done = 0; done < length;) {
    const DI = new Uint8Array(v + I.length); DI.set(D); DI.set(I, v);
    let A = await hashOnce(hash, DI);
    for (let r = 1; r < iterations; r++) A = await hashOnce(hash, A);
    out.set(A.subarray(0, Math.min(u, length - done)), done);
    done += u;
    if (done >= length) break;
    const B = new Uint8Array(v); for (let i = 0; i < v; i++) B[i] = A[i % u];
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) { const x = I[j + k] + B[k] + carry; I[j + k] = x & 0xff; carry = x >> 8; }
    }
  }
  return out;
}

/* DES and 3DES (decryption) */

const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

const toBits = (u8) => Array.from({ length: u8.length * 8 }, (_, i) => (u8[i >> 3] >> (7 - (i & 7))) & 1);
const fromBits = (b) => { const out = new Uint8Array(b.length / 8); b.forEach((x, i) => { out[i >> 3] |= x << (7 - (i & 7)); }); return out; };
const permute = (b, table) => table.map((i) => b[i - 1]);

function desSubkeys(key) {
  let cd = permute(toBits(key), PC1); const out = [];
  let c = cd.slice(0, 28); let d = cd.slice(28);
  for (const s of SHIFTS) { c = [...c.slice(s), ...c.slice(0, s)]; d = [...d.slice(s), ...d.slice(0, s)]; cd = [...c, ...d]; out.push(permute(cd, PC2)); }
  return out;
}

function desBlock(block, subkeys, decrypt) {
  const b = permute(toBits(block), IP); let l = b.slice(0, 32); let r = b.slice(32);
  for (let round = 0; round < 16; round++) {
    const k = subkeys[decrypt ? 15 - round : round];
    const x = permute(r, E).map((bit, i) => bit ^ k[i]);
    const f = [];
    for (let s = 0; s < 8; s++) {
      const six = x.slice(s * 6, s * 6 + 6);
      const v = SBOX[s][((six[0] << 1) | six[5]) * 16 + ((six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4])];
      f.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
    }
    const next = permute(f, P).map((bit, i) => bit ^ l[i]);
    l = r; r = next;
  }
  return fromBits(permute([...r, ...l], FP));
}

function tripleDesDecryptBlock(keys) {
  return (block) => desBlock(desBlock(desBlock(block, keys[2], true), keys[1], false), keys[0], true);
}

/* RC2 (RFC 2268, decryption) */

const PITABLE = Uint8Array.from(('d978f9c419ddb5ed28e9fd794aa0d89d' +
  'c67e37832b76538e624c6488448bfba2' +
  '179a59f587b34f1361456d8d09817d32' +
  'bd8f40eb86b77b0bf09521225c6b4e82' +
  '54d66593ce60b21c7356c014a78cf1dc' +
  '1275ca1f3bbee4d1423dd430a33cb626' +
  '6fbf0eda4669075727f21d9bbc944303' +
  'f811c7f690ef3ee706c3d52fc8661ed7' +
  '08e8eade8052eef784aa72ac354d6a2a' +
  '961ad2715a1549744b9fd05e0418a4ec' +
  'c2e0416e0f51cbcc2491af50a1f47039' +
  '997c3a8523b8b47afc02365b25559731' +
  '2d5dfa98e38a92ae05df2910676cbac9' +
  'd300e6cfe19ea82c6316013f58e289a9' +
  '0d38341bab33ffb0bb480c5fb9b1cd2e' +
  'c5f3db47e5a59c770aa62068fe7fc1ad').match(/../g), (h) => parseInt(h, 16));

function rc2Keys(key, effectiveBits) {
  const L = new Uint8Array(128); L.set(key);
  const T = key.length;
  for (let i = T; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  const T8 = Math.ceil(effectiveBits / 8); const TM = 0xff >> (8 * T8 - effectiveBits);
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  return Uint16Array.from({ length: 64 }, (_, i) => L[2 * i] | (L[2 * i + 1] << 8));
}

function rc2DecryptBlock(K) {
  return (block) => {
    const R = [0, 1, 2, 3].map((i) => block[2 * i] | (block[2 * i + 1] << 8));
    let j = 63;
    const S = [1, 2, 3, 5];
    const mix = () => { for (let i = 3; i >= 0; i--) { R[i] = ((R[i] >> S[i]) | (R[i] << (16 - S[i]))) & 0xffff; R[i] = (R[i] - K[j--] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & R[(i + 1) & 3])) & 0xffff; } };
    const mash = () => { for (let i = 3; i >= 0; i--) R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff; };
    for (let n = 0; n < 5; n++) mix();
    mash();
    for (let n = 0; n < 6; n++) mix();
    mash();
    for (let n = 0; n < 5; n++) mix();
    const out = new Uint8Array(8);
    R.forEach((w, i) => { out[2 * i] = w & 0xff; out[2 * i + 1] = w >> 8; });
    return out;
  };
}

// CBC decryption with 8-byte blocks and PKCS #7 padding removal.
function cbcDecrypt(decryptBlock, iv, data) {
  if (!data.length || data.length % 8) throw new P12Error('The password is wrong or the file is damaged.');
  const out = new Uint8Array(data.length); let prev = iv;
  for (let i = 0; i < data.length; i += 8) {
    const block = data.subarray(i, i + 8); const plain = decryptBlock(block);
    for (let k = 0; k < 8; k++) out[i + k] = plain[k] ^ prev[k];
    prev = block;
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 8 || out.subarray(out.length - pad).some((b) => b !== pad)) throw new P12Error('The password is wrong or the file is damaged.');
  return out.subarray(0, out.length - pad);
}

// Exposed for tests.
export const ciphers = { desBlock, desSubkeys, rc2Keys, rc2DecryptBlock };

/* Decryption of encrypted content and keys */

async function decrypt(algNode, data, password) {
  const id = oidOf(algNode.child(0)); const params = algNode.children[1];
  if (id === O.pbes2) {
    const kdf = params.child(0); const scheme = params.child(1);
    if (oidOf(kdf.child(0)) !== O.pbkdf2) throw new P12Error('The file uses a key derivation this tool does not support.');
    const kp = kdf.child(1); const salt = octetsOf(kp.child(0)); const iterations = iterationsOf(kp.child(1));
    let prf = 'SHA-1';
    for (const n of kp.children.slice(2)) if (n.tag === 0x30) { prf = HMAC[oidOf(n.child(0))]; if (!prf) throw new P12Error('The file uses a key derivation digest this tool does not support.'); }
    const encId = oidOf(scheme.child(0)); const iv = octetsOf(scheme.child(1));
    const keyLength = AES[encId] ?? (encId === DES_EDE3_CBC ? 24 : 0);
    if (!keyLength) throw new P12Error('The file is encrypted with a cipher this tool does not support.');
    const base = await subtle().importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
    const key = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', salt, iterations, hash: prf }, base, keyLength * 8));
    if (encId === DES_EDE3_CBC) return cbcDecrypt(tripleDesDecryptBlock([0, 8, 16].map((o) => desSubkeys(key.subarray(o, o + 8)))), iv, data);
    if (keyLength === 24) throw new P12Error('The file is encrypted with AES-192, which browsers do not support. Export it again with AES-256.');
    try {
      const aes = await subtle().importKey('raw', key, 'AES-CBC', false, ['decrypt']);
      return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, aes, data));
    } catch { throw new P12Error('The password is wrong or the file is damaged.'); }
  }
  if (id === O.sha3des || id === O.sha2des || id === O.sha40rc2 || id === O.sha128rc2) {
    const salt = octetsOf(params.child(0)); const iterations = iterationsOf(params.child(1)); const pw = bmp(password);
    if (id === O.sha3des || id === O.sha2des) {
      const key = await pkcs12Kdf('SHA-1', pw, salt, 1, iterations, id === O.sha3des ? 24 : 16);
      const iv = await pkcs12Kdf('SHA-1', pw, salt, 2, iterations, 8);
      const parts = id === O.sha3des ? [0, 8, 16] : [0, 8, 0];
      return cbcDecrypt(tripleDesDecryptBlock(parts.map((o) => desSubkeys(key.subarray(o, o + 8)))), iv, data);
    }
    const bitsLen = id === O.sha40rc2 ? 40 : 128;
    const key = await pkcs12Kdf('SHA-1', pw, salt, 1, iterations, bitsLen / 8);
    const iv = await pkcs12Kdf('SHA-1', pw, salt, 2, iterations, 8);
    return cbcDecrypt(rc2DecryptBlock(rc2Keys(key, bitsLen)), iv, data);
  }
  throw new P12Error('The file is encrypted with a method this tool does not support (for example RC4). Export it again with AES-256.');
}

async function verifyMac(macData, authSafe, password) {
  const mac = macData.child(0); const algId = mac.child(0); const expected = octetsOf(mac.child(1));
  const algOid = oidOf(algId.child(0));
  let hash; let key;
  if (algOid === O.pbmac1) {
    const params = algId.child(1); const kdf = params.child(0); const scheme = params.child(1);
    if (oidOf(kdf.child(0)) !== O.pbkdf2) throw new P12Error('The file uses a MAC this tool does not support.');
    hash = HMAC[oidOf(scheme.child(0))];
    const kp = kdf.child(1); const salt = octetsOf(kp.child(0)); const iterations = iterationsOf(kp.child(1));
    const keyLength = kp.children[2]?.tag === 0x02 ? intOf(kp.children[2]) : SIZE[hash]?.[0];
    let prf = 'SHA-1'; for (const n of kp.children.slice(2)) if (n.tag === 0x30) prf = HMAC[oidOf(n.child(0))];
    if (!hash || !prf || !keyLength) throw new P12Error('The file uses a MAC this tool does not support.');
    const base = await subtle().importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
    key = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', salt, iterations, hash: prf }, base, keyLength * 8));
  } else {
    hash = HASH[algOid];
    if (!hash) throw new P12Error('The file uses a MAC this tool does not support.');
    const salt = octetsOf(macData.child(1)); const iterations = iterationsOf(macData.children[2]);
    key = await pkcs12Kdf(hash, bmp(password), salt, 3, iterations, SIZE[hash][0]);
  }
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']);
  const actual = new Uint8Array(await subtle().sign('HMAC', k, authSafe));
  return compareBytes(actual, expected) === 0;
}

/* Reading the file */

function bagAttributes(bag) {
  const out = { localKeyId: null, friendlyName: '' };
  const attrs = bag.children[2];
  if (attrs?.tag === 0x31) for (const a of attrs.children) {
    const type = oidOf(a.child(0)); const v = a.child(1).children[0];
    if (!v) continue;
    if (type === O.localKeyId) out.localKeyId = octetsOf(v);
    else if (type === O.friendlyName) { try { out.friendlyName = stringOf(v); } catch { /* ignore */ } }
  }
  return out;
}

// Returns { keys: [{ pkcs8, localKeyId, friendlyName }], certs: [{ der, localKeyId, friendlyName }] }.
export async function readPkcs12(fileBytes, password) {
  const u8 = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
  let pfx;
  try {
    pfx = parse(u8);
    if (intOf(pfx.child(0)) !== 3) throw new P12Error('This is not a PKCS #12 version 3 file.');
  } catch (error) {
    if (error instanceof P12Error) throw error;
    if (error instanceof Asn1Error) throw new P12Error('This is not a .p12 or .pfx certificate file.');
    throw error;
  }
  try {
    const authSafe = pfx.child(1);
    if (oidOf(authSafe.child(0)) !== O.data) throw new P12Error('This file is protected with a public key instead of a password, which this tool does not support.');
    const content = octetsOf(authSafe.child(1).child(0));
    if (pfx.children[2]) {
      let ok = await verifyMac(pfx.children[2], content, password);
      // Some writers derive the MAC key from an empty password with no terminator; try that for blank passwords.
      if (!ok && password === '') ok = await verifyMac(pfx.children[2], content, '\0').catch(() => false);
      if (!ok) throw new P12Error('The password is wrong.');
    }
    const keys = []; const certs = [];
    const readBags = async (safeContents, depth = 0) => {
      for (const bag of parse(safeContents).children) {
        const type = oidOf(bag.child(0)); const value = bag.child(1).child(0); const attrs = bagAttributes(bag);
        if (type === O.keyBag) keys.push({ pkcs8: value.der.slice(), ...attrs });
        else if (type === O.shroudedKeyBag) keys.push({ pkcs8: await decrypt(value.child(0), octetsOf(value.child(1)), password), ...attrs });
        else if (type === O.certBag && oidOf(value.child(0)) === O.x509) certs.push({ der: octetsOf(value.child(1).child(0)).slice(), ...attrs });
        else if (type === '1.2.840.113549.1.12.10.1.6' && depth < 4) await readBags(value.der, depth + 1);
      }
    };
    for (const ci of parse(content).children) {
      const type = oidOf(ci.child(0));
      if (type === O.data) await readBags(octetsOf(ci.child(1).child(0)));
      else if (type === O.encryptedData) {
        const eci = ci.child(1).child(0).child(1);
        const encrypted = eci.children[2]; if (!encrypted) continue;
        await readBags(await decrypt(eci.child(1), octetsOf(encrypted), password));
      } else throw new P12Error('Part of this file is encrypted with a public key, which this tool does not support.');
    }
    return { keys, certs };
  } catch (error) {
    if (error instanceof P12Error) throw error;
    if (error instanceof Asn1Error) throw new P12Error('The password is wrong or the file is damaged.');
    throw error;
  }
}

/* Import into WebCrypto */

function keyInfo(pkcs8) {
  const pki = parse(pkcs8); const alg = pki.child(1); const id = oidOf(alg.child(0));
  if (id === O.rsaEncryption) return { type: 'RSA' };
  if (id === O.ecPublicKey) {
    let curve = alg.children[1]?.tag === 0x06 ? CURVES[oidOf(alg.children[1])] : null;
    if (!curve) { const ec = parse(octetsOf(pki.child(2))); const p = ec.tagged(0); if (p) curve = CURVES[oidOf(p.child(0))]; }
    if (curve !== 'P-256' && curve !== 'P-384') throw new P12Error(`The key uses the ${curve ?? 'unknown'} curve; only P-256 and P-384 are supported.`);
    return { type: 'EC', curve };
  }
  throw new P12Error('The private key type is not supported. RSA and ECDSA keys are.');
}

// Imported non-extractable. RSA keys are imported once for PKCS #1 v1.5 and once for PSS.
async function importKey(pkcs8, info) {
  if (info.type === 'RSA') {
    return {
      'RSASSA-PKCS1-v1_5': await subtle().importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']),
      'RSA-PSS': await subtle().importKey('pkcs8', pkcs8, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']),
    };
  }
  const k = await subtle().importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: info.curve }, false, ['sign']);
  return { [info.curve === 'P-256' ? 'ECDSA-P256' : 'ECDSA-P384']: k };
}

async function webSign(keys, algorithm, data) {
  const key = keys[algorithm];
  if (!key) throw new Error(`This key cannot make ${algorithm} signatures.`);
  if (algorithm === 'RSA-PSS') return new Uint8Array(await subtle().sign({ name: 'RSA-PSS', saltLength: 32 }, key, data));
  if (algorithm.startsWith('ECDSA')) return ecdsaRawToDer(new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: algorithm === 'ECDSA-P384' ? 'SHA-384' : 'SHA-256' }, key, data)));
  return new Uint8Array(await subtle().sign({ name: algorithm }, key, data));
}

async function keyMatches(keys, algorithm, cert) {
  try {
    const probe = utf8('Private Tools key check');
    const sig = await webSign(keys, algorithm, probe);
    const spki = cert.key.type === 'RSA' ? seq(seq(oid(O.rsaEncryption), nullValue()), bits(parse(cert.key.spki).child(1).content.subarray(1))) : cert.key.spki;
    if (algorithm.startsWith('ECDSA')) {
      const pub = await subtle().importKey('spki', spki, { name: 'ECDSA', namedCurve: cert.key.curve }, false, ['verify']);
      const size = cert.key.curve === 'P-256' ? 32 : 48;
      return subtle().verify({ name: 'ECDSA', hash: algorithm === 'ECDSA-P384' ? 'SHA-384' : 'SHA-256' }, pub, ecdsaDerToRaw(sig, size), probe);
    }
    const pub = await subtle().importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return subtle().verify({ name: 'RSASSA-PKCS1-v1_5' }, pub, sig, probe);
  } catch { return false; }
}

// Orders the chain from the leaf up through issuers found among the other certificates.
function chainFrom(leaf, others) {
  const chain = [leaf]; const rest = others.filter((c) => c !== leaf);
  for (let cur = leaf; chain.length < 10 && !cur.selfIssued;) {
    const next = rest.find((c) => !chain.includes(c) && compareBytes(c.subject.der, cur.issuer.der) === 0);
    if (!next) break;
    chain.push(next); cur = next;
  }
  return chain;
}

// A signer for signPdf from a .p12/.pfx file. options.algorithm picks RSA-PSS instead of PKCS #1 v1.5 for
// RSA keys; ECDSA keys use their curve. The returned object also describes the certificate.
export async function p12Signer(fileBytes, password, { algorithm } = {}) {
  const { keys, certs } = await readPkcs12(fileBytes, password);
  if (!keys.length) throw new P12Error('The file holds no private key. Export the certificate together with its private key.');
  if (!certs.length) throw new P12Error('The file holds no certificate.');
  const parsed = certs.map((c) => { try { return { ...c, cert: parseCertificate(c.der) }; } catch { return null; } }).filter(Boolean);
  if (keys.length > 1) {
    // The key with a matching certificate wins; others are ignored.
    keys.sort((a, b) => Number(parsed.some((c) => c.localKeyId && b.localKeyId && compareBytes(c.localKeyId, b.localKeyId) === 0)) - Number(parsed.some((c) => c.localKeyId && a.localKeyId && compareBytes(c.localKeyId, a.localKeyId) === 0)));
  }
  const entry = keys[0];
  const info = keyInfo(entry.pkcs8);
  const cryptoKeys = await importKey(entry.pkcs8, info);
  for (const k of keys) k.pkcs8.fill(0);
  const defaultAlg = info.type === 'RSA' ? 'RSASSA-PKCS1-v1_5' : info.curve === 'P-256' ? 'ECDSA-P256' : 'ECDSA-P384';
  let leafEntry = entry.localKeyId ? parsed.find((c) => c.localKeyId && compareBytes(c.localKeyId, entry.localKeyId) === 0) : null;
  if (!leafEntry || !(await keyMatches(cryptoKeys, defaultAlg, leafEntry.cert))) {
    leafEntry = null;
    for (const c of parsed) if (await keyMatches(cryptoKeys, defaultAlg, c.cert)) { leafEntry = c; break; }
  }
  if (!leafEntry) throw new P12Error('None of the certificates in the file belongs to its private key.');
  const leaf = leafEntry.cert;
  const chain = chainFrom(leaf, parsed.map((c) => c.cert));
  const alg = algorithm ?? defaultAlg;
  checkKeyMatchesAlgorithm(leaf, alg);
  return {
    certificates: chain.map((c) => c.der), algorithm: alg, algorithms: algorithmsFor(leaf),
    certificate: leaf, chain, friendlyName: leafEntry.friendlyName || entry.friendlyName,
    sign: (digest, signedAttributes) => webSign(cryptoKeys, alg, signedAttributes),
    withAlgorithm(next) { checkKeyMatchesAlgorithm(leaf, next); return { ...this, algorithm: next, sign: (d, attrs) => webSign(cryptoKeys, next, attrs) }; },
  };
}
