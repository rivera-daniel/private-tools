// Signatures of whole files hidden inside another file (polyglots, droppers, appended archives).
// Each check validates more than the magic bytes so random data rarely matches.
import { startsWith } from '../bytes.js';

const u16 = (u8, o) => u8[o] | (u8[o + 1] << 8);
const u32 = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;

const CHECKS = {
  0x50: (u8, o) => startsWith(u8, 'PK\x03\x04', o) && u16(u8, o + 4) <= 63 && u16(u8, o + 26) > 0 && u16(u8, o + 26) < 1024 && [0, 8, 9, 12, 14, 93, 95, 98, 99].includes(u16(u8, o + 8)) && 'ZIP archive',
  0x25: (u8, o) => (startsWith(u8, '%PDF-1.', o) || startsWith(u8, '%PDF-2.', o)) && 'PDF document',
  0x4d: (u8, o) => {
    if (u8[o + 1] !== 0x5a || o + 0x40 > u8.length) return false;
    const e = u32(u8, o + 0x3c);
    return e >= 0x40 && e < 0x1000 && startsWith(u8, 'PE\0\0', o + e) && 'Windows program';
  },
  0x7f: (u8, o) => startsWith(u8, '\x7fELF', o) && [1, 2].includes(u8[o + 4]) && [1, 2].includes(u8[o + 5]) && u8[o + 6] === 1 && 'ELF program',
  0x37: (u8, o) => startsWith(u8, '7z\xbc\xaf\x27\x1c', o) && '7z archive',
  0x52: (u8, o) => startsWith(u8, 'Rar!\x1a\x07', o) && 'RAR archive',
  0xd0: (u8, o) => startsWith(u8, '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', o) && 'Microsoft compound file',
  0x89: (u8, o) => startsWith(u8, '\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR', o) && 'PNG image',
  0xff: (u8, o) => u8[o + 1] === 0xd8 && u8[o + 2] === 0xff && (u8[o + 3] === 0xe0 || u8[o + 3] === 0xe1 || u8[o + 3] === 0xdb) && (startsWith(u8, 'JFIF', o + 6) || startsWith(u8, 'Exif', o + 6) || u8[o + 3] === 0xdb) && 'JPEG image',
};

// Returns [{ offset, type }] for signatures in [from, to), skipping types in `ignore`. Capped.
export function findEmbedded(u8, ranges, { ignore = new Set(), max = 20, maxBytes = 64 * 1024 * 1024 } = {}) {
  const out = []; let budget = maxBytes;
  for (const [from, to] of ranges) {
    const end = Math.min(to, u8.length, from + budget);
    budget -= end - from;
    for (let o = Math.max(1, from); o < end - 4 && out.length < max; o++) {
      const check = CHECKS[u8[o]];
      if (!check) continue;
      const type = check(u8, o);
      // An archive has a local header per entry. Its first one stands for the whole archive.
      if (!type || ignore.has(type) || (type === 'ZIP archive' && out.some((e) => e.type === type))) continue;
      out.push({ offset: o, type });
    }
    if (budget <= 0 || out.length >= max) break;
  }
  return out;
}
