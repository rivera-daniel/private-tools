// Mach-O (macOS and iOS programs and libraries), thin and universal: CPU, UUID, platform and SDK,
// libraries, run paths, source version and the code signature's identifier, team and signer.
import { fmtBytes, hex, utf8 } from '../bytes.js';
import { pathUser } from '../scan/strings.js';
import { signedData } from '../scan/der.js';

const CPUS = { 7: 'x86', 0x01000007: 'x86-64', 12: 'ARM', 0x0100000c: 'ARM64', 0x0200000c: 'ARM64_32', 18: 'PowerPC', 0x01000012: 'PowerPC 64' };
const FILETYPES = { 1: 'Object file', 2: 'Executable', 3: 'Fixed VM library', 4: 'Core dump', 5: 'Preloaded executable', 6: 'Dynamic library', 7: 'Dynamic linker', 8: 'Bundle', 9: 'Library stub', 10: 'Debug symbols (dSYM)', 11: 'Kernel extension' };
const PLATFORMS = { 1: 'macOS', 2: 'iOS', 3: 'tvOS', 4: 'watchOS', 5: 'bridgeOS', 6: 'Mac Catalyst', 7: 'iOS Simulator', 8: 'tvOS Simulator', 9: 'watchOS Simulator', 10: 'DriverKit', 11: 'visionOS', 12: 'visionOS Simulator' };
const MIN_OS = { 0x24: 'macOS', 0x25: 'iOS', 0x2f: 'tvOS', 0x30: 'watchOS' };
const TOOLS = { 1: 'clang', 2: 'swift', 3: 'ld', 4: 'lld', 1024: 'Metal' };
const SYSTEM_PATH = /^(@executable_path|@loader_path|@rpath|\/usr\/lib|\/System\/|\/Library\/Frameworks|\/usr\/local\/lib)/;
const version = (v) => `${v >>> 16}.${(v >> 8) & 0xff}${v & 0xff ? `.${v & 0xff}` : ''}`;

export async function parseMacho(b, r) {
  r.format = 'Mach-O'; r.category = 'Program';
  const magic = b.u32(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const wide = magic === 0xcafebabf; const n = Math.min(b.u32(4), 16);
    r.field('Mach-O header', 'Kind', `Universal binary with ${n} architecture${n === 1 ? '' : 's'}`);
    r.struct('Universal header', 0, 8 + n * (wide ? 32 : 20));
    const archs = [];
    let end = 8 + n * (wide ? 32 : 20);
    for (let i = 0; i < n; i++) {
      const o = 8 + i * (wide ? 32 : 20);
      const cpu = b.u32(o); const offset = wide ? b.u64(o + 8) : b.u32(o + 8); const size = wide ? b.u64(o + 16) : b.u32(o + 12);
      if (!b.has(offset, size)) { r.warn('A universal binary slice points past the end of the file.'); continue; }
      const name = CPUS[cpu] ?? hex(cpu, 8);
      archs.push(name);
      r.struct(`Slice ${name}`, offset, size);
      end = Math.max(end, offset + size);
      thin(b.sub(offset, size), r, `Mach-O ${name}`, offset);
    }
    r.field('Mach-O header', 'Architectures', archs.join(', '));
    r.add('Program', 'Type', `Mach-O universal binary (${archs.join(', ')})`);
    if (end < b.length && b.length - end > 16) r.block('Trailer', end, b.length - end, { decoded: false, removable: false, note: 'Data after the last slice' });
    return;
  }
  const end = thin(b, r, 'Mach-O', 0);
  if (end < b.length && b.length - end > 16) {
    r.block('Trailer', end, b.length - end, { decoded: false, removable: false, note: 'Data after the program' });
    r.struct('Appended data', end, b.length - end);
  }
}

// One architecture. Returns where its last segment or signature ends.
function thin(b, r, label, base) {
  const magic = b.u32(0);
  const le = magic === 0xcefaedfe || magic === 0xcffaedfe; const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const u32 = (o) => b.u32(o, le);
  const cpu = u32(4); const filetype = u32(12); const ncmds = Math.min(u32(16), 4096); const flags = u32(24);
  const H = `${label} header`; const B = label === 'Mach-O' ? 'Build' : `${label} build`; const L = `${label} libraries`;
  r.field(H, 'CPU', CPUS[cpu] ?? hex(cpu, 8));
  r.field(H, 'Kind', FILETYPES[filetype] ?? String(filetype));
  r.field(H, 'Load commands', String(ncmds));
  r.field(H, 'Position independent', flags & 0x200000 ? 'Yes' : 'No');
  if (label === 'Mach-O') r.add('Program', 'Type', `Mach-O ${(FILETYPES[filetype] ?? 'file').toLowerCase()}, ${CPUS[cpu] ?? hex(cpu, 8)}`);
  r.struct(`${label} header`, base, is64 ? 32 : 28);
  let end = 0;
  const str = (cmd, at, size) => { const o = cmd + u32(at); const s = b.slice(o, cmd + size - o); const z = s.indexOf(0); return utf8.decode(z < 0 ? s : s.subarray(0, z)); };
  const segments = [];
  for (let i = 0, o = is64 ? 32 : 28; i < ncmds && b.has(o, 8); i++) {
    const cmd = u32(o) & 0x7fffffff; const raw = u32(o); const size = u32(o + 4);
    if (size < 8 || !b.has(o, size)) break;
    if (cmd === 0x1 || cmd === 0x19) {
      const name = b.ascii(o + 8, 16).replace(/\0.*$/s, '');
      const fileoff = cmd === 0x19 ? b.u64(o + 40, le) : u32(o + 32); const filesize = cmd === 0x19 ? b.u64(o + 48, le) : u32(o + 36);
      segments.push(name);
      r.field(`${label} segments`, name || '(unnamed)', fmtBytes(filesize));
      end = Math.max(end, fileoff + filesize);
    } else if (cmd === 0x1b) r.field(B, 'UUID', [...b.slice(o + 8, 16)].map((x, j) => `${[4, 6, 8, 10].includes(j) ? '-' : ''}${x.toString(16).toUpperCase().padStart(2, '0')}`).join(''));
    else if (cmd === 0x32) {
      const platform = PLATFORMS[u32(o + 8)] ?? `Platform ${u32(o + 8)}`;
      r.field(B, 'Platform', platform);
      r.field(B, 'Minimum OS', `${platform} ${version(u32(o + 12))}`);
      r.field(B, 'SDK', version(u32(o + 16)));
      const tools = [];
      for (let t = 0; t < Math.min(u32(o + 20), 16); t++) tools.push(`${TOOLS[u32(o + 24 + t * 8)] ?? `Tool ${u32(o + 24 + t * 8)}`} ${version(u32(o + 28 + t * 8))}`);
      if (tools.length) { r.field(B, 'Build tools', tools.join(', ')); r.add('Software', 'Build tools', tools.join(', ')); }
      r.add('Program', 'Platform', `${platform} ${version(u32(o + 12))} or later`);
    } else if (MIN_OS[cmd]) { r.field(B, 'Minimum OS', `${MIN_OS[cmd]} ${version(u32(o + 8))}`); r.field(B, 'SDK', version(u32(o + 12))); }
    else if (cmd === 0x2a) {
      const v = b.u64(o + 8, le);
      const parts = [Math.floor(v / 2 ** 40), Math.floor(v / 2 ** 30) % 1024, Math.floor(v / 2 ** 20) % 1024, Math.floor(v / 2 ** 10) % 1024, v % 1024];
      while (parts.length > 2 && parts.at(-1) === 0) parts.pop();
      r.field(B, 'Source version', parts.join('.'));
    } else if (cmd === 0xc || cmd === 0x18 || cmd === 0x1f || cmd === 0x23) {
      const kind = { 0xc: 'Needed', 0x18: 'Weak', 0x1f: 'Re-exported', 0x23: 'Loaded lazily' }[cmd];
      r.field(L, str(o, o + 8, size), `${kind}, version ${version(u32(o + 16))}`);
    } else if (cmd === 0xd) r.field(B, 'Library name', str(o, o + 8, size));
    else if (raw === 0x8000001c) {
      const path = str(o, o + 8, size);
      const leaky = path.startsWith('/') && !SYSTEM_PATH.test(path);
      r.field(B, 'Run path', path, leaky ? { flag: 'privacy' } : {});
      if (leaky) r.signal('privacy', 'Build path stored', `The library search path points at a folder on the build computer: ${path.slice(0, 200)}.${pathUser(path) ? ` It names the account “${pathUser(path)}”.` : ''}`, `${label} load commands`, 'a build path');
    } else if (cmd === 0x21 || cmd === 0x2c) r.field(B, 'Encrypted (App Store)', u32(o + 16) ? 'Yes' : 'No');
    else if (cmd === 0x1d) {
      const at = u32(o + 8); const length = u32(o + 12);
      end = Math.max(end, at + length);
      r.struct(`${label} code signature`, base + at, length);
      try { signature(b.sub(at, length), r, label === 'Mach-O' ? 'Code signature' : `${label} code signature`); } catch { r.warn('The code signature could not be read completely.'); }
    }
    o += size;
  }
  if (!segments.length && filetype === 1) end = b.length;
  return end || b.length;
}

// Code signature super blob (big-endian): CodeDirectory identifier and team, entitlements, CMS signer.
function signature(b, r, S) {
  if (b.u32(0) !== 0xfade0cc0) return;
  const count = Math.min(b.u32(8), 64);
  r.field(S, 'Signed', 'Yes');
  for (let i = 0; i < count; i++) {
    const type = b.u32(12 + i * 8); const at = b.u32(16 + i * 8);
    const magic = b.u32(at); const length = b.u32(at + 4);
    if (magic === 0xfade0c02 && (type === 0 || type === 0x1000)) {
      const ver = b.u32(at + 8); const flags = b.u32(at + 12);
      const cstr = (o) => { const s = b.slice(at + o, 256); const z = s.indexOf(0); return utf8.decode(z < 0 ? s : s.subarray(0, z)); };
      if (type === 0) {
        r.field(S, 'Identifier', cstr(b.u32(at + 20)));
        if (ver >= 0x20200 && b.u32(at + 48)) { const team = cstr(b.u32(at + 48)); r.field(S, 'Team ID', team); r.add('Program', 'Team ID', team); }
        r.field(S, 'Kind', flags & 0x2 ? 'Ad hoc (no certificate)' : 'Certificate');
        if (flags & 0x10000) r.field(S, 'Hardened runtime', 'Yes');
        r.add('Program', 'Identifier', cstr(b.u32(at + 20)));
      }
    } else if (magic === 0xfade7171) {
      const xml = utf8.decode(b.slice(at + 8, Math.min(length - 8, 262144)));
      const keys = [...xml.matchAll(/<key>([^<]{1,200})<\/key>/g)].map((m) => m[1]);
      r.field(S, 'Entitlements', keys.length ? keys.join('\n') : xml.trim());
    } else if (magic === 0xfade0b01 && length > 8) {
      const sd = signedData(b.slice(at + 8, length - 8));
      const s = sd?.signer;
      if (s) {
        r.field(S, 'Signer', s.subject.CN ?? s.subject.line);
        if (s.subject.O) r.field(S, 'Organization', s.subject.O);
        r.field(S, 'Issued by', s.issuer.CN ?? s.issuer.line);
        r.field(S, 'Certificate valid', `${s.notBefore} to ${s.notAfter}`);
        r.add('Program', 'Signed by', s.subject.CN ?? s.subject.line);
        // Development certificates carry a person's name and are not meant for distribution.
        if (/^(Apple Development|Mac Developer|iPhone Developer):/.test(s.subject.CN ?? '')) r.signal('privacy', 'Signed with a personal developer certificate', `The signature names “${s.subject.CN}”. Development certificates identify the person who built the file.`, S, 'a developer’s name');
      }
      r.field(S, 'Verification', 'Not verified here. A signature shows who signed the file, not that it is safe.');
    }
  }
}
