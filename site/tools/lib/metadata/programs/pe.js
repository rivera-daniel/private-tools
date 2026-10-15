// Windows PE (EXE, DLL, SYS, EFI): headers, sections, imports, Rich header, debug record with the PDB
// path, version resource, manifest, Authenticode signer and .NET header. Nothing is executed or verified.
import { fmtBytes, hex, utf8 } from '../bytes.js';
import { entropy } from '../scan/strings.js';
import { pathUser } from '../scan/strings.js';
import { signedData } from '../scan/der.js';

const MACHINES = { 0x14c: 'x86 (32-bit)', 0x8664: 'x86-64', 0x1c0: 'ARM', 0x1c4: 'ARM Thumb-2', 0xaa64: 'ARM64', 0xa641: 'ARM64EC', 0x200: 'Itanium', 0x5064: 'RISC-V 64', 0xebc: 'EFI byte code', 0x0: 'Any' };
const SUBSYSTEMS = { 1: 'Native (driver)', 2: 'Windows GUI', 3: 'Windows console', 5: 'OS/2 console', 7: 'POSIX console', 9: 'Windows CE', 10: 'EFI application', 11: 'EFI boot driver', 12: 'EFI runtime driver', 13: 'EFI ROM', 14: 'Xbox', 16: 'Windows boot application' };
const DLL_FLAGS = [[0x20, 'High-entropy ASLR'], [0x40, 'ASLR'], [0x100, 'DEP'], [0x400, 'No SEH'], [0x4000, 'Control Flow Guard'], [0x8000, 'Terminal Server aware']];
const DEBUG_TYPES = { 1: 'COFF', 2: 'CodeView', 4: 'Misc', 9: 'Borland', 12: 'Visual C++ features', 13: 'Profile-guided optimization', 14: 'Incremental link', 16: 'Reproducible build', 20: 'Extended DLL characteristics' };
const NOTABLE = [[/^(ws2_32|wsock32|wininet|winhttp|urlmon|iphlpapi|dnsapi|netapi32|mpr)\.dll$/i, 'Network access'], [/^(bcrypt|crypt32|ncrypt|advapi32)\.dll$/i, 'Cryptography or security'], [/^(user32|gdi32|comctl32)\.dll$/i, 'Windows interface'], [/^(shell32|shlwapi|ole32|oleaut32)\.dll$/i, 'Shell and COM'], [/^(mscoree)\.dll$/i, '.NET runtime'], [/^(ntdll)\.dll$/i, 'Native system calls'], [/^(dbghelp)\.dll$/i, 'Debugging'], [/^(wtsapi32|secur32|sspicli)\.dll$/i, 'Sessions and sign-in']];
// Visual Studio 2015 and later share these product IDs. The build number tells the release apart.
const RICH_PRODUCTS = { 0x00fd: 'Alias object', 0x00fe: 'Profile-guided optimization converter', 0x00ff: 'Resource converter', 0x0100: 'Export tool', 0x0101: 'Import library tool', 0x0102: 'Linker', 0x0103: 'Assembler (MASM)', 0x0104: 'C compiler', 0x0105: 'C++ compiler', 0x0106: 'C compiler (CIL)', 0x0107: 'C++ compiler (CIL)', 0x0108: 'C compiler (link-time code generation)', 0x0109: 'C++ compiler (link-time code generation)', 0x010a: 'MSIL compiler (link-time code generation)', 0x010b: 'C compiler (profile instrumentation)', 0x010c: 'C++ compiler (profile instrumentation)', 0x010d: 'C compiler (profile optimized)', 0x010e: 'C++ compiler (profile optimized)' };
const vsRelease = (build) => (build < 25000 ? 'Visual Studio 2015' : build < 27500 ? 'Visual Studio 2017' : build < 30700 ? 'Visual Studio 2019' : 'Visual Studio 2022 or later');
const VERSION_KEYS = ['CompanyName', 'ProductName', 'FileDescription', 'FileVersion', 'ProductVersion', 'OriginalFilename', 'InternalName', 'LegalCopyright', 'LegalTrademarks', 'Comments', 'PrivateBuild', 'SpecialBuild'];

const utcDate = (sec) => new Date(sec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const cstr = (b, o, max = 1024) => { const s = b.slice(o, max); const z = s.indexOf(0); return utf8.decode(z < 0 ? s : s.subarray(0, z)); };
const guid = (b, o) => {
  const h = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
  const tail = [...b.slice(o + 8, 8)].map((x) => h(x, 2)).join('');
  return `${h(b.u32(o, true), 8)}-${h(b.u16(o + 4, true), 4)}-${h(b.u16(o + 6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
};

export async function parsePe(b, r) {
  const e = b.u32(0x3c, true); const coff = e + 4;
  const machine = b.u16(coff, true); const nsec = Math.min(b.u16(coff + 2, true), 96);
  const stamp = b.u32(coff + 4, true); const optSize = b.u16(coff + 16, true); const chars = b.u16(coff + 18, true);
  const opt = coff + 20; const magic = b.u16(opt, true); const plus = magic === 0x20b;
  if (magic !== 0x10b && magic !== 0x20b) throw new RangeError('unknown optional header');
  const subsystem = b.u16(opt + 68, true); const dllFlags = b.u16(opt + 70, true);
  const dll = Boolean(chars & 0x2000);
  r.format = subsystem >= 10 && subsystem <= 13 ? 'EFI' : dll ? 'DLL' : subsystem === 1 ? 'SYS' : 'EXE';
  r.category = 'Program';
  const H = 'PE header';
  r.field(H, 'Machine', MACHINES[machine] ?? hex(machine));
  r.field(H, 'Format', plus ? 'PE32+ (64-bit)' : 'PE32');
  r.field(H, 'Kind', dll ? 'Library (DLL)' : 'Executable');
  r.field(H, 'Subsystem', SUBSYSTEMS[subsystem] ?? String(subsystem));
  r.field(H, 'Linker version', `${b.u8at(opt + 2)}.${String(b.u8at(opt + 3)).padStart(2, '0')}`);
  r.field(H, 'Minimum Windows version', `${b.u16(opt + 40, true)}.${b.u16(opt + 42, true)}`);
  r.field(H, 'Entry point', hex(b.u32(opt + 16, true), 8));
  r.field(H, 'Security features', DLL_FLAGS.filter(([bit]) => dllFlags & bit).map(([, n]) => n).join(', ') || 'None');
  r.struct('DOS header', 0, 64);
  r.struct('PE header', e, 24 + optSize);

  const sections = [];
  const secAt = opt + optSize;
  for (let i = 0; i < nsec; i++) {
    const o = secAt + i * 40;
    sections.push({ name: b.ascii(o, 8).replace(/\0.*$/s, ''), vsize: b.u32(o + 8, true), va: b.u32(o + 12, true), rawSize: b.u32(o + 16, true), raw: b.u32(o + 20, true), flags: b.u32(o + 36, true) });
  }
  const off = (rva) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize) && rva - s.va < s.rawSize) return s.raw + rva - s.va;
    return rva < (sections[0]?.va ?? 0x1000) && rva < b.length ? rva : -1;
  };
  for (const s of sections) {
    const end = Math.min(b.length, s.raw + s.rawSize);
    const h = s.rawSize && end > s.raw ? entropy(b.u8, s.raw, end) : 0;
    const traits = [s.flags & 0x20000000 && 'code', s.flags & 0x80000000 && 'writable', h > 7.2 && 'packed or encrypted'].filter(Boolean);
    r.field('PE sections', s.name || '(unnamed)', `${fmtBytes(s.rawSize)}, entropy ${h.toFixed(2)}${traits.length ? `, ${traits.join(', ')}` : ''}`);
    r.struct(`Section ${s.name}`, s.raw, s.rawSize, `Entropy ${h.toFixed(2)}`);
  }
  if (sections.some((s) => /^UPX\d$/.test(s.name))) r.add('Program', 'Packer', 'UPX');

  const dirCount = Math.min(b.u32(opt + (plus ? 108 : 92), true), 16);
  const dirAt = opt + (plus ? 112 : 96);
  const dir = (i) => (i < dirCount ? { rva: b.u32(dirAt + i * 8, true), size: b.u32(dirAt + i * 8 + 4, true) } : { rva: 0, size: 0 });

  const B = 'Build';
  let repro = false;
  const attempt = (label, fn) => { try { fn(); } catch { r.warn(`The ${label} could not be read completely.`); } };
  attempt('debug directory', () => { repro = debug(b, r, dir(6), off); });
  r.field(B, 'Compile time', repro ? `Not a date: ${hex(stamp, 8)} is a reproducible-build hash` : stamp ? utcDate(stamp) : 'Not set');
  if (!repro && stamp) r.add('Dates', 'Compiled', utcDate(stamp));
  r.add('Program', 'Type', `${r.format}, ${MACHINES[machine] ?? hex(machine)}`);
  attempt('Rich header', () => rich(b, r, e));
  attempt('import table', () => imports(b, r, dir(1), off, plus));
  attempt('export table', () => exports(b, r, dir(0), off));
  attempt('resources', () => resources(b, r, dir(2), off));
  attempt('signature', () => authenticode(b, r, dir(4)));
  attempt('.NET header', () => clr(b, r, dir(14), off));

  // Overlay: anything after the last section, the signature and the COFF symbol table.
  let end = b.u32(opt + 60, true);
  for (const s of sections) if (s.rawSize) end = Math.max(end, s.raw + s.rawSize);
  const cert = dir(4); if (cert.rva && cert.size) end = Math.max(end, cert.rva + cert.size);
  const sym = b.u32(coff + 8, true);
  if (sym && sym < b.length) { const strings = sym + b.u32(coff + 12, true) * 18; end = Math.max(end, strings + (b.has(strings, 4) ? b.u32(strings, true) : 0)); }
  end = Math.ceil(end / 8) * 8;
  if (end < b.length && b.length - end > 8) {
    r.block('Trailer', end, b.length - end, { decoded: false, removable: false, note: 'Data after the program (overlay)' });
    r.struct('Overlay', end, b.length - end, 'Installers and self-extracting archives keep their payload here');
  }
}

function debug(b, r, d, off) {
  if (!d.rva || !d.size) return false;
  const at = off(d.rva); let repro = false;
  if (at < 0) return false;
  const types = [];
  for (let i = 0; i < Math.min(d.size / 28, 32); i++) {
    const o = at + i * 28; const type = b.u32(o + 12, true); const size = b.u32(o + 16, true); const ptr = b.u32(o + 24, true);
    types.push(DEBUG_TYPES[type] ?? `Type ${type}`);
    if (type === 16) repro = true;
    if (type === 2 && size >= 24 && b.has(ptr, 24)) {
      const sig = b.ascii(ptr, 4);
      let path = '';
      if (sig === 'RSDS') { r.field('Build', 'PDB GUID', `${guid(b, ptr + 4)}, age ${b.u32(ptr + 20, true)}`); path = cstr(b, ptr + 24, Math.min(size - 24, 1024)); }
      else if (sig === 'NB10') path = cstr(b, ptr + 16, Math.min(size - 16, 1024));
      if (path) {
        const user = pathUser(path); const absolute = /^[A-Za-z]:\\|^\\\\|^\//.test(path);
        r.field('Build', 'Debug symbols path (PDB)', path, absolute ? { flag: 'privacy' } : {});
        r.add('Program', 'Debug symbols path', path, absolute ? { flag: 'privacy' } : {});
        if (absolute) r.signal('privacy', 'Build path stored', `The program records where its debug symbols were written: ${path.slice(0, 200)}.${user ? ` It names the account “${user}”.` : ''}`, 'PE debug directory', 'a build path');
      }
    }
  }
  r.field('Build', 'Debug records', [...new Set(types)].join(', '));
  return repro;
}

function rich(b, r, e) {
  let rich = -1;
  for (let o = 0x80; o + 8 <= Math.min(e, 0x1000); o += 4) if (b.ascii(o, 4) === 'Rich') { rich = o; break; }
  if (rich < 0) return;
  const key = b.u32(rich + 4, true);
  let start = -1;
  for (let o = rich - 4; o >= 0x40; o -= 4) if ((b.u32(o, true) ^ key) === 0x536e6144) { start = o; break; }
  if (start < 0) return;
  r.struct('Rich header', start, rich + 8 - start, 'Build toolchain record');
  r.field('Build', 'Rich header key', hex(key, 8));
  const tools = []; let newest = 0;
  for (let o = start + 16; o + 8 <= rich; o += 8) {
    const id = b.u32(o, true) ^ key; const count = b.u32(o + 4, true) ^ key;
    const product = id >>> 16; const build = id & 0xffff;
    if (product === 0 || product === 1) continue;
    const label = RICH_PRODUCTS[product] ? `${RICH_PRODUCTS[product]} (${vsRelease(build)}, build ${build})` : `Product ${hex(product)}, build ${build}`;
    if (RICH_PRODUCTS[product]) newest = Math.max(newest, build);
    tools.push(`${label} × ${count}`);
  }
  if (tools.length) r.field('Build', 'Toolchain', tools.slice(0, 40).join('\n'));
  if (newest) { r.add('Software', 'Toolchain', `Microsoft Visual C++, ${vsRelease(newest)} (build ${newest})`); r.field('Build', 'Compiler', `Microsoft Visual C++, ${vsRelease(newest)}`); }
}

function imports(b, r, d, off, plus) {
  if (!d.rva) return;
  let at = off(d.rva); if (at < 0) return;
  const libs = []; let functions = 0;
  for (let n = 0; n < 1000 && b.has(at, 20); n++, at += 20) {
    const thunk = b.u32(at, true) || b.u32(at + 16, true); const nameRva = b.u32(at + 12, true);
    if (!nameRva && !thunk) break;
    const nameAt = off(nameRva); const name = nameAt >= 0 ? cstr(b, nameAt, 256) : '?';
    let count = 0; const t = off(thunk);
    if (t >= 0) for (let p = t; count < 10000 && b.has(p, plus ? 8 : 4) && (plus ? b.u64(p, true) : b.u32(p, true)); p += plus ? 8 : 4) count++;
    functions += count; libs.push([name, count]);
  }
  for (const [name, count] of libs.slice(0, 300)) r.field('PE imports', name, `${count.toLocaleString('en-US')} function${count === 1 ? '' : 's'}`);
  r.field('PE header', 'Imported libraries', `${libs.length} libraries, ${functions.toLocaleString('en-US')} functions`);
  const uses = [...new Set(libs.flatMap(([name]) => NOTABLE.filter(([re]) => re.test(name)).map(([, label]) => label)))];
  if (uses.length) r.add('Program', 'Uses', uses.join(', '));
}

function exports(b, r, d, off) {
  if (!d.rva) return;
  const at = off(d.rva); if (at < 0) return;
  const nameAt = off(b.u32(at + 12, true));
  if (nameAt >= 0) r.field('Build', 'Library name', cstr(b, nameAt, 256));
  r.field('PE header', 'Exported functions', String(b.u32(at + 24, true)));
}

function resources(b, r, d, off) {
  if (!d.rva) return;
  const base = off(d.rva); if (base < 0) return;
  const entries = (o) => { const n = Math.min(b.u16(o + 12, true) + b.u16(o + 14, true), 512); return Array.from({ length: n }, (_, i) => ({ id: b.u32(o + 16 + i * 8, true), to: b.u32(o + 20 + i * 8, true) })); };
  // First leaf below a type: type -> name -> language -> data entry.
  const leaf = (to, depth = 0) => {
    if (depth > 3) return null;
    if (to & 0x80000000) { const sub = entries(base + (to & 0x7fffffff))[0]; return sub ? leaf(sub.to, depth + 1) : null; }
    const at = off(b.u32(base + to, true)); return at >= 0 ? { at, size: Math.min(b.u32(base + to + 4, true), 1048576) } : null;
  };
  const types = entries(base);
  r.field('PE header', 'Resource types', String(types.length));
  const find = (id) => { const t = types.find((x) => x.id === id); return t ? leaf(t.to) : null; };
  const version = find(16);
  if (version) versionInfo(b, r, version.at, version.at + version.size);
  const manifest = find(24);
  if (manifest) {
    const xml = utf8.decode(b.slice(manifest.at, manifest.size));
    r.field('Manifest', 'Manifest', xml.trim());
    const level = /requestedExecutionLevel[^>]*level=["']([^"']+)/.exec(xml)?.[1];
    if (level) r.field('Manifest', 'Requested privileges', { asInvoker: 'Same as the user', highestAvailable: 'Highest available', requireAdministrator: 'Administrator' }[level] ?? level);
    const name = /<assemblyIdentity[^>]*\sname=["']([^"']+)/.exec(xml)?.[1];
    if (name) r.field('Manifest', 'Assembly name', name);
  }
}

// VS_VERSIONINFO: nested blocks of { length, value length, type, UTF-16 key, value, children }.
function versionInfo(b, r, start, end) {
  const strings = [];
  const block = (o, limit, depth) => {
    const len = b.u16(o, true); const valueLen = b.u16(o + 2, true); const text = b.u16(o + 4, true) === 1;
    if (len < 6 || o + len > limit) return o + Math.max(len, 6);
    let p = o + 6; let key = '';
    while (p + 1 < o + len && b.u16(p, true)) { key += String.fromCharCode(b.u16(p, true)); p += 2; }
    p = (p + 2 + 3) & ~3;
    const valueBytes = text ? valueLen * 2 : valueLen;
    if (depth === 0 && valueLen >= 52 && b.u32(p, true) === 0xfeef04bd) {
      const v = (ms, ls) => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
      r.field('Version information', 'File version (numeric)', v(b.u32(p + 8, true), b.u32(p + 12, true)));
      r.field('Version information', 'Product version (numeric)', v(b.u32(p + 16, true), b.u32(p + 20, true)));
    }
    if (depth === 3 && text) {
      let value = ''; for (let q = p; q + 1 < Math.min(p + valueBytes, o + len) && b.u16(q, true); q += 2) value += String.fromCharCode(b.u16(q, true));
      strings.push([key, value.trim()]);
    }
    if (depth === 2 && /^[0-9a-f]{8}$/i.test(key)) r.field('Version information', 'Language', key.toUpperCase());
    let c = (p + valueBytes + 3) & ~3;
    if (depth < 3) for (let n = 0; c + 6 <= o + len && n < 200; n++) c = (block(c, o + len, depth + 1) + 3) & ~3;
    return o + len;
  };
  block(start, end, 0);
  const order = (k) => { const i = VERSION_KEYS.indexOf(k); return i < 0 ? 99 : i; };
  for (const [k, v] of strings.sort((a, c) => order(a[0]) - order(c[0]))) r.field('Version information', k, v);
  const get = (k) => strings.find(([key]) => key === k)?.[1];
  for (const [k, label] of [['CompanyName', 'Company'], ['ProductName', 'Product'], ['FileDescription', 'Description'], ['FileVersion', 'Version'], ['OriginalFilename', 'Original file name'], ['LegalCopyright', 'Copyright']]) if (get(k)) r.add('Program', label, get(k));
}

function authenticode(b, r, d) {
  if (!d.rva || !d.size || !b.has(d.rva, 8)) return;
  const length = b.u32(d.rva, true); const type = b.u16(d.rva + 6, true);
  r.block('Signature', d.rva, Math.min(d.size, b.length - d.rva), { removable: false, note: 'Authenticode signature' });
  r.struct('Authenticode signature', d.rva, d.size);
  const S = 'Signature';
  r.field(S, 'Signed', type === 2 ? 'Yes, Authenticode (PKCS#7)' : `Certificate type ${type}`);
  if (type !== 2) return;
  const sd = signedData(b.slice(d.rva + 8, Math.min(length, d.size) - 8));
  if (!sd) return;
  const s = sd.signer;
  if (s) {
    r.field(S, 'Signer', s.subject.CN ?? s.subject.line);
    if (s.subject.O && s.subject.O !== s.subject.CN) r.field(S, 'Organization', s.subject.O);
    if (s.subject.L || s.subject.ST || s.subject.C) r.field(S, 'Signer location', [s.subject.L, s.subject.ST, s.subject.C].filter(Boolean).join(', '));
    if (s.subject.E) r.field(S, 'Signer email', s.subject.E, { flag: 'privacy' });
    r.field(S, 'Issued by', s.issuer.CN ?? s.issuer.line);
    r.field(S, 'Certificate valid', `${s.notBefore} to ${s.notAfter}`);
    r.add('Program', 'Signed by', s.subject.O ?? s.subject.CN ?? s.subject.line);
  }
  r.field(S, 'Certificates included', String(sd.certs.length));
  r.field(S, 'Verification', 'Not verified here. A signature shows who signed the file, not that it is safe.');
}

function clr(b, r, d, off) {
  if (!d.rva) return;
  const at = off(d.rva); if (at < 0) return;
  const flags = b.u32(at + 16, true);
  r.field('Build', '.NET', `Runtime header ${b.u16(at + 4, true)}.${b.u16(at + 6, true)}${flags & 1 ? ', IL only' : ''}${flags & 8 ? ', strong-name signed' : ''}`);
  const meta = off(b.u32(at + 8, true));
  if (meta >= 0 && b.u32(meta, true) === 0x424a5342) {
    const version = cstr(b, meta + 16, Math.min(b.u32(meta + 12, true), 255));
    r.field('Build', '.NET runtime version', version);
    r.add('Software', 'Runtime', `.NET (${version})`);
  }
}
