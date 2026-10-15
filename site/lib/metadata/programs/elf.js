// ELF (Linux and other Unix programs, libraries, objects and core dumps): headers, interpreter,
// build ID, compiler notes, needed libraries, run paths, debug link and source file names.
import { fmtBytes, hex, utf8 } from '../bytes.js';
import { pathUser } from '../scan/strings.js';

const MACHINES = { 2: 'SPARC', 3: 'x86 (32-bit)', 8: 'MIPS', 20: 'PowerPC', 21: 'PowerPC 64', 22: 'IBM S/390', 40: 'ARM', 42: 'SuperH', 43: 'SPARC V9', 50: 'Itanium', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V', 247: 'eBPF', 258: 'LoongArch' };
const TYPES = { 1: 'Relocatable object', 2: 'Executable', 3: 'Shared object', 4: 'Core dump' };
const ABIS = { 0: 'System V', 3: 'Linux', 6: 'Solaris', 9: 'FreeBSD', 12: 'OpenBSD', 2: 'NetBSD', 97: 'ARM', 255: 'Standalone' };
const SOURCE = /(^|\/)[\w.+-]+\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|rs|go|zig|m|mm|swift|s|S|asm|f90|d|nim|cu)$/;
const SYSTEM_PATH = /^(\/usr|\/lib|\/lib64|\/opt|\/bin|\/sbin|\$ORIGIN|\$\{ORIGIN\})/;

export async function parseElf(b, r) {
  const is64 = b.u8at(4) === 2; const le = b.u8at(5) === 1;
  const u16 = (o) => b.u16(o, le); const u32 = (o) => b.u32(o, le);
  const word = (o) => (is64 ? b.u64(o, le) : b.u32(o, le));
  const type = u16(16); const machine = u16(18);
  const phoff = word(is64 ? 32 : 28); const shoff = word(is64 ? 40 : 32);
  const phentsize = u16(is64 ? 54 : 42); const phnum = Math.min(u16(is64 ? 56 : 44), 512);
  const shentsize = u16(is64 ? 58 : 46); const shnum = Math.min(u16(is64 ? 60 : 48), 4096); const shstrndx = u16(is64 ? 62 : 50);
  r.format = 'ELF'; r.category = 'Program';
  const H = 'ELF header';

  const segments = [];
  for (let i = 0; i < phnum && phoff; i++) {
    const o = phoff + i * phentsize;
    if (!b.has(o, is64 ? 56 : 32)) break;
    segments.push(is64 ? { type: u32(o), offset: b.u64(o + 8, le), vaddr: b.u64(o + 16, le), filesz: b.u64(o + 32, le) } : { type: u32(o), offset: u32(o + 4), vaddr: u32(o + 8), filesz: u32(o + 16) });
  }
  const sections = [];
  for (let i = 0; i < shnum && shoff; i++) {
    const o = shoff + i * shentsize;
    if (!b.has(o, is64 ? 64 : 40)) break;
    sections.push(is64 ? { nameAt: u32(o), type: u32(o + 4), offset: b.u64(o + 24, le), size: b.u64(o + 32, le), link: u32(o + 40), entsize: b.u64(o + 56, le) } : { nameAt: u32(o), type: u32(o + 4), offset: u32(o + 16), size: u32(o + 20), link: u32(o + 24), entsize: u32(o + 36) });
  }
  const names = sections[shstrndx];
  for (const s of sections) s.name = names ? cstr(b, names.offset + s.nameAt, 128) : '';
  const section = (n) => sections.find((s) => s.name === n && s.type !== 8);
  const pie = segments.some((s) => s.type === 3);
  const kind = type === 3 ? (pie ? 'Position-independent executable' : 'Shared library') : TYPES[type] ?? `Type ${type}`;

  r.field(H, 'Class', is64 ? '64-bit' : '32-bit');
  r.field(H, 'Byte order', le ? 'Little-endian' : 'Big-endian');
  r.field(H, 'Machine', MACHINES[machine] ?? String(machine));
  r.field(H, 'Kind', kind);
  r.field(H, 'OS ABI', ABIS[b.u8at(7)] ?? String(b.u8at(7)));
  r.field(H, 'Entry point', hex(word(24), is64 ? 16 : 8));
  r.field(H, 'Sections', String(sections.length));
  r.add('Program', 'Type', `ELF ${kind.toLowerCase()}, ${MACHINES[machine] ?? machine}`);
  r.struct('ELF header', 0, is64 ? 64 : 52);
  for (const s of sections.slice(0, 200)) if (s.name && s.type !== 8) r.field('ELF sections', s.name, fmtBytes(s.size));
  const SEG = { 1: 'Load', 2: 'Dynamic', 3: 'Interpreter', 4: 'Note', 6: 'Program header', 7: 'Thread-local storage', 0x6474e550: 'Exception frames', 0x6474e551: 'Stack', 0x6474e552: 'Read-only after relocation', 0x6474e553: 'GNU properties' };
  segments.slice(0, 64).forEach((s, i) => r.field('ELF segments', `${i}: ${SEG[s.type] ?? hex(s.type, 8)}`, `${fmtBytes(s.filesz)} at ${hex(s.offset, 6)}`));

  const fileOf = (vaddr) => { for (const s of segments) if (s.type === 1 && vaddr >= s.vaddr && vaddr < s.vaddr + s.filesz) return s.offset + vaddr - s.vaddr; return -1; };
  const B = 'Build';
  const interp = segments.find((s) => s.type === 3);
  if (interp) r.field(B, 'Interpreter', cstr(b, interp.offset, Math.min(interp.filesz, 512)));

  // Notes from sections, or from segments when section headers were stripped.
  const noteRanges = sections.some((s) => s.type === 7) ? sections.filter((s) => s.type === 7) : segments.filter((s) => s.type === 4).map((s) => ({ offset: s.offset, size: s.filesz }));
  for (const n of noteRanges.slice(0, 32)) notes(b, r, n.offset, n.size, le, type === 4, is64);

  const comment = section('.comment');
  if (comment) {
    const list = [...new Set(utf8.decode(b.slice(comment.offset, Math.min(comment.size, 65536))).split('\0').map((x) => x.trim()).filter(Boolean))];
    if (list.length) { r.field(B, 'Compiler', list.slice(0, 10).join('\n')); r.add('Software', 'Compiler', list[0]); }
  }

  // Dynamic section: needed libraries, library name and run paths.
  const dynSec = section('.dynamic'); const dynSeg = segments.find((s) => s.type === 2);
  const dyn = dynSec ? { offset: dynSec.offset, size: dynSec.size } : dynSeg ? { offset: dynSeg.offset, size: dynSeg.filesz } : null;
  if (dyn) {
    const entries = []; const step = is64 ? 16 : 8;
    for (let o = dyn.offset; o + step <= dyn.offset + dyn.size && entries.length < 4096 && b.has(o, step); o += step) {
      const tag = is64 ? b.u64(o, le) : u32(o); if (tag === 0) break;
      entries.push([tag, is64 ? b.u64(o + 8, le) : u32(o + 4)]);
    }
    const strtabVaddr = entries.find(([t]) => t === 5)?.[1];
    const strtab = dynSec && sections[dynSec.link] ? sections[dynSec.link].offset : strtabVaddr !== undefined ? fileOf(strtabVaddr) : -1;
    const str = (v) => (strtab >= 0 ? cstr(b, strtab + v, 4096) : '');
    const needed = entries.filter(([t]) => t === 1).map(([, v]) => str(v)).filter(Boolean);
    needed.slice(0, 300).forEach((lib) => r.field('ELF libraries', lib, 'Needed'));
    if (needed.length) r.field(H, 'Needed libraries', String(needed.length));
    const soname = entries.find(([t]) => t === 14);
    if (soname) r.field(B, 'Library name', str(soname[1]));
    for (const [tag, label] of [[15, 'Run path (RPATH)'], [29, 'Run path (RUNPATH)']]) {
      for (const [, v] of entries.filter(([t]) => t === tag)) {
        const value = str(v); if (!value) continue;
        const leaky = value.split(':').filter((p) => p.startsWith('/') && !SYSTEM_PATH.test(p));
        r.field(B, label, value, leaky.length ? { flag: 'privacy' } : {});
        if (leaky.length) r.signal('privacy', 'Build path stored', `The library search path points at a folder on the build computer: ${leaky[0].slice(0, 200)}.${pathUser(leaky[0]) ? ` It names the account “${pathUser(leaky[0])}”.` : ''}`, 'ELF dynamic section', 'a build path');
      }
    }
  }

  const link = section('.gnu_debuglink');
  if (link) r.field(B, 'Debug symbols file', cstr(b, link.offset, Math.min(link.size, 512)));
  const symtab = sections.find((s) => s.type === 2);
  r.field(H, 'Symbols', symtab ? 'Present (not stripped)' : 'Stripped');
  const debugInfo = sections.some((s) => s.name.startsWith('.debug_info') || s.name.startsWith('.zdebug_info'));
  if (debugInfo) r.field(H, 'Debug information', 'Included');

  // Source file names: STT_FILE symbols and DWARF string tables.
  const files = new Set();
  if (symtab && sections[symtab.link]) {
    const strOff = sections[symtab.link].offset; const step = is64 ? 24 : 16;
    for (let o = symtab.offset, n = 0; o + step <= symtab.offset + symtab.size && n < 200000 && b.has(o, step); o += step, n++) {
      const info = b.u8at(o + (is64 ? 4 : 12));
      if ((info & 0xf) === 4) { const name = cstr(b, strOff + u32(o), 1024); if (name) files.add(name); }
    }
  }
  for (const n of ['.debug_str', '.debug_line_str']) {
    const s = section(n); if (!s) continue;
    for (const part of utf8.decode(b.slice(s.offset, Math.min(s.size, 8 * 1048576))).split('\0')) if (part.length < 1024 && (SOURCE.test(part) || /^\/(home|Users|build|tmp|src|work)\//.test(part))) files.add(part);
  }
  if (files.size) {
    const list = [...files];
    const dirs = [...new Set(list.filter((f) => f.startsWith('/')).map((f) => f.replace(/\/[^/]*$/, '')))];
    r.field(B, 'Source files named', `${list.length.toLocaleString('en-US')}, such as ${list.filter((f) => SOURCE.test(f)).slice(0, 8).join(', ') || list.slice(0, 8).join(', ')}`);
    if (dirs.length) {
      const user = dirs.map(pathUser).find(Boolean);
      r.field(B, 'Build folders', dirs.slice(0, 10).join('\n'), { flag: 'privacy' });
      r.signal('privacy', 'Build path stored', `Debug data names folders on the build computer, such as ${dirs[0].slice(0, 200)}.${user ? ` It names the account “${user}”.` : ''}`, 'ELF debug data', 'a build path');
    }
  }
  // Data after every section, segment and header table belongs to no part of the program.
  let end = Math.max(is64 ? 64 : 52, phoff + segments.length * phentsize, shoff + sections.length * shentsize);
  for (const s of sections) if (s.type !== 8) end = Math.max(end, s.offset + s.size);
  for (const s of segments) end = Math.max(end, s.offset + s.filesz);
  if (end < b.length && b.length - end > 16) {
    r.block('Trailer', end, b.length - end, { decoded: false, removable: false, note: 'Data after the program' });
    r.struct('Appended data', end, b.length - end, 'After the last section');
  }
  if (type === 4) r.signal('privacy', 'Memory dump', 'A core dump holds a copy of a program’s memory, which can include passwords, keys and open documents.', 'ELF header', 'a memory dump');
}

function cstr(b, o, max) { if (o < 0 || o >= b.length) return ''; const s = b.slice(o, max); const z = s.indexOf(0); return utf8.decode(z < 0 ? s : s.subarray(0, z)); }

function notes(b, r, start, size, le, core, is64) {
  const B = 'Build';
  for (let o = start, n = 0; o + 12 <= start + size && n < 256 && b.has(o, 12); n++) {
    const nameSize = b.u32(o, le); const descSize = b.u32(o + 4, le); const type = b.u32(o + 8, le);
    if (nameSize > 256 || descSize > 1048576) break;
    const name = cstr(b, o + 12, nameSize);
    const desc = o + 12 + ((nameSize + 3) & ~3);
    if (name === 'GNU' && type === 3) r.field(B, 'Build ID', [...b.slice(desc, descSize)].map((x) => x.toString(16).padStart(2, '0')).join(''));
    if (name === 'GNU' && type === 1 && descSize >= 16) r.field(B, 'Minimum kernel', `${['Linux', 'GNU Hurd', 'Solaris', 'FreeBSD'][b.u32(desc, le)] ?? 'OS'} ${b.u32(desc + 4, le)}.${b.u32(desc + 8, le)}.${b.u32(desc + 12, le)}`);
    if (name === 'Go' && type === 4) r.field(B, 'Go build ID', utf8.decode(b.slice(desc, Math.min(descSize, 512))));
    // Core dumps: the process name and its command line.
    if (core && type === 3 && name === 'CORE') {
      const fname = cstr(b, desc + (is64 ? 40 : 28), 16); const args = cstr(b, desc + (is64 ? 56 : 44), 80);
      if (fname) r.field('Core dump', 'Program', fname);
      if (args) r.field('Core dump', 'Command line', args, { flag: 'privacy' });
    }
    o = desc + ((descSize + 3) & ~3);
  }
}
