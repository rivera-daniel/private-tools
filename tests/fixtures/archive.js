// Archive fixtures built in code: ZipCrypto-encrypted, overlapping and mislabelled ZIPs, and tar files with
// hostile names. ZipCrypto encryption exists here only to produce test input; the Archiver never writes it.
import { crc32 } from '../../site/tools/lib/metadata/bytes.js';
import { writeZip, readZip } from '../../site/tools/lib/zip/index.js';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const step = (crc, b) => (CRC[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;

function zipCryptoEncrypt(password, data, checkByte) {
  let k0 = 0x12345678; let k1 = 0x23456789; let k2 = 0x34567890;
  const update = (b) => { k0 = step(k0, b); k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0; k2 = step(k2, k1 >>> 24); };
  for (const b of new TextEncoder().encode(password)) update(b);
  const header = new Uint8Array(12).map((_, i) => (i * 37 + 11) & 0xff); header[11] = checkByte;
  const plain = new Uint8Array(12 + data.length); plain.set(header); plain.set(data, 12);
  const out = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) { const t = (k2 | 2) & 0xffff; out[i] = plain[i] ^ ((Math.imul(t, t ^ 1) >>> 8) & 0xff); update(plain[i]); }
  return out;
}

// A stored ZIP entry encrypted with ZipCrypto.
export async function zipCryptoZip(name, data, password) {
  const crc = crc32(data);
  const zip = readZip(await writeZip([{ name, raw: zipCryptoEncrypt(password, data, crc >>> 24), crc, size: data.length, method: 0 }]));
  const u8 = zip.bytes.slice(); const e = zip.entries[0];
  const set16 = (at, v) => { u8[at] = v & 0xff; u8[at + 1] = v >> 8; };
  set16(e.localOffset + 6, 1); set16(e.centralOffset + 8, 1);
  return u8;
}

// Two central records pointing at the same data: the overlapping-entry zip bomb pattern.
export async function overlappingZip() {
  const one = readZip(await writeZip([{ name: 'a.txt', data: new TextEncoder().encode('x'.repeat(1000)) }]));
  const u8 = one.bytes; const e = one.entries[0];
  const central = u8.subarray(e.centralOffset, e.centralOffset + e.centralLength);
  const end = u8.subarray(one.end);
  const out = new Uint8Array(e.centralOffset + central.length * 2 + end.length);
  out.set(u8.subarray(0, e.centralOffset)); out.set(central, e.centralOffset); out.set(central, e.centralOffset + central.length);
  const tail = end.slice(); const v = new DataView(tail.buffer);
  v.setUint16(8, 2, true); v.setUint16(10, 2, true); v.setUint32(12, central.length * 2, true);
  out.set(tail, e.centralOffset + central.length * 2);
  return out;
}

// A ZIP whose directory understates an entry's size.
export async function understatedZip() {
  const zip = readZip(await writeZip([{ name: 'big.txt', data: new TextEncoder().encode('y'.repeat(5000)) }]));
  const u8 = zip.bytes.slice(); const e = zip.entries[0];
  new DataView(u8.buffer).setUint32(e.centralOffset + 24, 100, true);
  return u8;
}
