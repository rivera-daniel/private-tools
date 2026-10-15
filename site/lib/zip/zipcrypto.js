// Traditional PKWARE encryption ("ZipCrypto"). It is broken and only decrypted here, never written.
import { WrongPassword } from './aes.js';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const step = (crc, b) => (CRC[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;

class Keys {
  constructor(password) { this.k0 = 0x12345678; this.k1 = 0x23456789; this.k2 = 0x34567890; for (const b of password) this.update(b); }
  update(b) {
    this.k0 = step(this.k0, b);
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = step(this.k2, this.k1 >>> 24);
  }
  decrypt(data) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) { const t = (this.k2 | 2) & 0xffff; const b = data[i] ^ ((Math.imul(t, t ^ 1) >>> 8) & 0xff); out[i] = b; this.update(b); }
    return out;
  }
}

// header: the 12-byte encryption header. check: the byte the header must end with (the high byte of the
// CRC, or of the DOS time when sizes follow the data). Decrypts with the password's UTF-8 bytes and, failing
// that, its Latin-1 bytes, which is what older Windows tools used.
export async function* zipCryptoDecrypt(source, { password, header, check }) {
  let keys = null;
  const latin = [...password].every((c) => c.charCodeAt(0) < 256) ? Uint8Array.from([...password].map((c) => c.charCodeAt(0))) : null;
  for (const bytes of [new TextEncoder().encode(password), latin]) {
    if (!bytes) continue;
    const k = new Keys(bytes);
    if (k.decrypt(header)[11] === check) { keys = k; break; }
  }
  if (!keys) throw new WrongPassword();
  for await (const chunk of source) yield keys.decrypt(chunk);
}
