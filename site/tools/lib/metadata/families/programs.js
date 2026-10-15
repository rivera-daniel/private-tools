// Programs and libraries: Windows PE, ELF and Mach-O. Inspected only, never cleaned: rewriting a program
// breaks its signature and can break the program.
import { startsWith } from '../bytes.js';
import { parsePe } from '../programs/pe.js';
import { parseElf } from '../programs/elf.js';
import { parseMacho } from '../programs/macho.js';

const be32 = (u8, o = 0) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;

export function detect(u8) {
  if (u8.length >= 0x40 && u8[0] === 0x4d && u8[1] === 0x5a) {
    const e = u8[0x3c] | (u8[0x3d] << 8) | (u8[0x3e] << 16) | (u8[0x3f] << 24);
    if (e >= 0x40 && e < 0x10000 && startsWith(u8, 'PE\0\0', e)) return parsePe;
  }
  if (u8.length >= 52 && startsWith(u8, '\x7fELF') && (u8[4] === 1 || u8[4] === 2) && (u8[5] === 1 || u8[5] === 2)) return parseElf;
  const magic = be32(u8);
  if (u8.length >= 28 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return parseMacho;
  // 0xCAFEBABE is also a Java class. A universal binary has a small architecture count there instead of a class version.
  if (u8.length >= 28 && (magic === 0xcafebabe || magic === 0xcafebabf) && be32(u8, 4) > 0 && be32(u8, 4) < 30) return parseMacho;
  return null;
}
