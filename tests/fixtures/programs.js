// Synthetic programs built in memory: a Windows PE with a Rich header, debug record, version resource,
// manifest, imports and an Authenticode certificate list; ELF executables and a core dump; Mach-O thin
// and universal binaries with a code signature. They parse, they do not run.

const le16 = (n) => [n & 255, (n >> 8) & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le64 = (n) => [...le32(n % 2 ** 32), ...le32(Math.floor(n / 2 ** 32))];
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const z = (s) => [...new TextEncoder().encode(s), 0];
const u16z = (s) => [...s].flatMap((c) => le16(c.charCodeAt(0))).concat([0, 0]);
const pad = (a, n) => { while (a.length % n) a.push(0); return a; };
const put = (buf, at, bytes) => { buf.set(bytes, at); return at + bytes.length; };

// ---------- DER ----------
const len = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
export const der = (tag, ...parts) => { const body = parts.flat(); return [tag, ...len(body.length), ...body]; };
const oid = (s) => {
  const p = s.split('.').map(Number); const out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) { const enc = [v & 127]; for (let x = Math.floor(v / 128); x; x = Math.floor(x / 128)) enc.unshift((x & 127) | 128); out.push(...enc); }
  return der(0x06, out);
};
const utf8s = (s) => der(0x0c, [...new TextEncoder().encode(s)]);
const name = (pairs) => der(0x30, ...pairs.map(([o, v]) => der(0x31, der(0x30, oid(o), utf8s(v)))));
const CN = '2.5.4.3'; const O = '2.5.4.10'; const C = '2.5.4.6'; const OU = '2.5.4.11';

export function certificate({ serial, subject, issuer }) {
  const alg = der(0x30, oid('1.2.840.113549.1.1.11'), [0x05, 0x00]);
  const tbs = der(0x30, der(0xa0, der(0x02, [2])), der(0x02, serial), alg, name(issuer),
    der(0x30, der(0x17, ascii('250101000000Z')), der(0x17, ascii('280101000000Z'))), name(subject),
    der(0x30, der(0x30, oid('1.2.840.113549.1.1.1'), [0x05, 0x00]), der(0x03, [0, 1, 2, 3])));
  return der(0x30, tbs, alg, der(0x03, [0, 9, 9, 9]));
}

// PKCS#7 SignedData with a leaf and an issuing certificate. The signer info points at the leaf.
export function signedData(leafSubject, { ca = [[CN, 'Example Code Signing CA'], [O, 'Example Trust'], [C, 'US']] } = {}) {
  const leaf = certificate({ serial: [0x1f, 0x42], subject: leafSubject, issuer: ca });
  const root = certificate({ serial: [0x01], subject: ca, issuer: ca });
  const signer = der(0x30, der(0x02, [1]), der(0x30, name(ca), der(0x02, [0x1f, 0x42])), der(0x30, oid('2.16.840.1.101.3.4.2.1')), der(0x30, oid('1.2.840.113549.1.1.1')), der(0x04, [1, 2, 3]));
  const sd = der(0x30, der(0x02, [1]), der(0x31, der(0x30, oid('2.16.840.1.101.3.4.2.1'))), der(0x30, oid('1.2.840.113549.1.7.1')), der(0xa0, root, leaf), der(0x31, signer));
  return der(0x30, oid('1.2.840.113549.1.7.2'), der(0xa0, sd));
}

// ---------- Windows PE ----------
// VS_VERSIONINFO block: header, UTF-16 key, value, children, each aligned to 4 bytes.
function vblock(key, value, children = [], text = true) {
  const head = [0, 0, ...le16(0), ...le16(text ? 1 : 0), ...u16z(key)]; pad(head, 4);
  const valueBytes = value === null ? [] : typeof value === 'string' ? u16z(value) : value;
  const out = [...head, ...valueBytes]; pad(out, 4);
  for (const c of children) { out.push(...c); pad(out, 4); }
  out.splice(0, 4, ...le16(out.length), ...le16(value === null ? 0 : typeof value === 'string' ? valueBytes.length / 2 : valueBytes.length));
  return out;
}

export const PE_STRINGS = {
  CompanyName: 'Roe Labs', ProductName: 'Widget', FileDescription: 'Widget desktop app', FileVersion: '2.4.1.0',
  OriginalFilename: 'widget.exe', InternalName: 'widget', LegalCopyright: 'Copyright 2026 Roe Labs',
};
export const PDB_PATH = 'C:\\Users\\jroe\\source\\repos\\Widget\\x64\\Release\\Widget.pdb';
export const PE_STAMP = 1767225600; // 2026-01-01 00:00:00 UTC

export function pe({ repro = false, overlay = true, signed = true } = {}) {
  const buf = new Uint8Array(0x1400);
  put(buf, 0, ascii('MZ')); put(buf, 0x3c, le32(0x100));
  // Rich header: DanS, three padding words, (comp id, count) pairs, Rich, key. Everything but Rich and the key is XORed.
  const key = 0x5a5aa5a5;
  const entries = [[0x0105, 33145, 120], [0x0104, 33145, 12], [0x0102, 33145, 1], [0x0103, 33145, 3], [0x00ff, 33145, 1]];
  const words = [0x536e6144, 0, 0, 0, ...entries.flatMap(([p, b, c]) => [((p << 16) | b) >>> 0, c])].map((w) => (w ^ key) >>> 0);
  let o = put(buf, 0x80, words.flatMap(le32)); o = put(buf, o, ascii('Rich')); put(buf, o, le32(key));
  // COFF and PE32+ optional header.
  put(buf, 0x100, [...ascii('PE\0\0'), ...le16(0x8664), ...le16(3), ...le32(PE_STAMP), ...le32(0), ...le32(0), ...le16(240), ...le16(0x22)]);
  const opt = 0x118;
  put(buf, opt, [...le16(0x20b), 14, 36]);
  put(buf, opt + 16, le32(0x400)); put(buf, opt + 24, le64(0x140000000)); put(buf, opt + 40, [...le16(6), ...le16(0)]);
  put(buf, opt + 60, le32(0x400)); put(buf, opt + 68, [...le16(2), ...le16(0x8160)]); put(buf, opt + 108, le32(16));
  const dir = (i, rva, size) => put(buf, opt + 112 + i * 8, [...le32(rva), ...le32(size)]);
  // Sections: file offset equals virtual address, so RVAs are file offsets.
  const sec = (i, nm, at, size, flags) => put(buf, opt + 240 + i * 40, [...pad(ascii(nm), 8).slice(0, 8), ...le32(size), ...le32(at), ...le32(size), ...le32(at), ...le32(0), ...le32(0), 0, 0, 0, 0, ...le32(flags)]);
  sec(0, '.text', 0x400, 0x200, 0x60000020); sec(1, '.rdata', 0x600, 0x400, 0x40000040); sec(2, '.rsrc', 0xa00, 0x800, 0x40000040);
  buf.fill(0xcc, 0x400, 0x600);
  // Imports: two descriptors, thunks, names.
  put(buf, 0x600, [...le32(0x680), 0, 0, 0, 0, 0, 0, 0, 0, ...le32(0x6c0), ...le32(0x680)]);
  put(buf, 0x614, [...le32(0x690), 0, 0, 0, 0, 0, 0, 0, 0, ...le32(0x6d0), ...le32(0x690)]);
  put(buf, 0x680, [...le64(0x6e0), ...le64(0)]); put(buf, 0x690, [...le64(0x6f0), ...le64(0x6e0), ...le64(0)].slice(0, 16));
  put(buf, 0x6c0, z('KERNEL32.dll')); put(buf, 0x6d0, z('WS2_32.dll')); put(buf, 0x6e0, [0, 0, ...z('Sleep')]); put(buf, 0x6f0, [0, 0, ...z('send')]);
  dir(1, 0x600, 40);
  // Debug directory: CodeView RSDS record, plus a reproducible-build entry when asked.
  const rsds = [...ascii('RSDS'), ...le32(0x3de8368d), ...le16(0x531a), ...le16(0x4541), 0x85, 0xa5, 0x44, 0xd4, 0xa7, 0xda, 0x39, 0x4d, ...le32(1), ...z(PDB_PATH)];
  const debugEntry = (type, size, at) => [...le32(0), ...le32(PE_STAMP), 0, 0, 0, 0, ...le32(type), ...le32(size), ...le32(at), ...le32(at)];
  put(buf, 0x700, [...debugEntry(2, rsds.length, 0x740), ...(repro ? debugEntry(16, 0, 0) : [])]);
  put(buf, 0x740, rsds);
  dir(6, 0x700, repro ? 56 : 28);
  // Resources: version (type 16) and manifest (type 24), each type -> name -> language -> data entry.
  const base = 0xa00;
  const rdir = (at, entryId, target) => put(buf, base + at, [...new Array(12).fill(0), 0, 0, ...le16(1), ...le32(entryId), ...le32(target)]);
  put(buf, base, [...new Array(12).fill(0), 0, 0, ...le16(2), ...le32(16), ...le32(0x80000020), ...le32(24), ...le32(0x80000050)]);
  rdir(0x20, 1, 0x80000038); rdir(0x38, 0x409, 0x100); rdir(0x50, 1, 0x80000068); rdir(0x68, 0x409, 0x110);
  const fixed = [...le32(0xfeef04bd), ...le32(0x10000), ...le32(0x20004), ...le32(0x10000), ...le32(0x20004), ...le32(0), ...le32(0x3f), ...le32(0), ...le32(0x40004), ...le32(1), ...le32(0), ...le32(0), ...le32(0)];
  const strings = Object.entries(PE_STRINGS).map(([k, v]) => vblock(k, v));
  const version = vblock('VS_VERSION_INFO', fixed, [vblock('StringFileInfo', null, [vblock('040904B0', null, strings)]), vblock('VarFileInfo', null, [vblock('Translation', [0x09, 0x04, 0xb0, 0x04], [], false)])], false);
  const manifest = new TextEncoder().encode('<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity name="RoeLabs.Widget" version="2.4.1.0"/><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="requireAdministrator" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>');
  put(buf, base + 0x100, [...le32(base + 0x140), ...le32(version.length), 0, 0, 0, 0, 0, 0, 0, 0]);
  const manifestAt = base + 0x140 + version.length + 16 & ~15;
  put(buf, base + 0x110, [...le32(manifestAt), ...le32(manifest.length), 0, 0, 0, 0, 0, 0, 0, 0]);
  put(buf, base + 0x140, version); put(buf, manifestAt, manifest);
  dir(2, base, 0x800);
  let end = 0x1200;
  const parts = [buf.subarray(0, end)];
  if (signed) {
    const sd = signedData([[CN, 'Roe Labs LLC'], [O, 'Roe Labs LLC'], [C, 'US']]);
    const cert = pad([...le32(8 + sd.length), ...le16(0x200), ...le16(2), ...sd], 8);
    dir(4, end, cert.length); parts.push(Uint8Array.from(cert)); end += cert.length;
  }
  if (overlay) parts.push(new TextEncoder().encode('OVERLAY:installer payload follows here..........'));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- ELF (64-bit, little-endian) ----------
export const ELF_RUNPATH = '/home/jroe/dev/widget/build/lib:$ORIGIN/../lib';
export const ELF_BUILD_ID = '6b1e3f0c2a9d4e7f8a1b2c3d4e5f60718293a4b5';

export function elf({ core = false } = {}) {
  const buf = new Uint8Array(0x1000);
  const addStr = (list, s) => { const at = list.length; list.push(...z(s)); return at; };
  const shstr = [0]; const dynstr = [0]; const symstr = [0];
  // Contents at fixed offsets.
  const interpAt = 0x200; put(buf, interpAt, z('/lib64/ld-linux-x86-64.so.2'));
  const noteAt = 0x240;
  const buildId = ELF_BUILD_ID.match(/../g).map((h) => parseInt(h, 16));
  let note = [...le32(4), ...le32(buildId.length), ...le32(3), ...ascii('GNU\0'), ...buildId];
  if (core) {
    const ps = new Uint8Array(136); put(ps, 40, z('backup-tool')); put(ps, 56, z('backup-tool --password hunter2 /home/jroe/taxes'));
    note = [...le32(5), ...le32(ps.length), ...le32(3), ...ascii('CORE\0\0\0\0'), ...ps];
  }
  put(buf, noteAt, note);
  const needed1 = addStr(dynstr, 'libc.so.6'); const needed2 = addStr(dynstr, 'libssl.so.3'); const runpath = addStr(dynstr, ELF_RUNPATH);
  const dynstrAt = 0x300; put(buf, dynstrAt, dynstr);
  const dynAt = 0x380; const dyn = [[1, needed1], [1, needed2], [29, runpath], [5, dynstrAt], [0, 0]];
  put(buf, dynAt, dyn.flatMap(([t, v]) => [...le64(t), ...le64(v)]));
  const commentAt = 0x400; const comment = z('GCC: (GNU) 13.2.1 20230801'); put(buf, commentAt, comment);
  const linkAt = 0x440; const link = pad([...z('widget.debug')], 4).concat(le32(0x12345678)); put(buf, linkAt, link);
  const f1 = addStr(symstr, 'widget.c'); const f2 = addStr(symstr, 'util.c');
  const symAt = 0x480; const sym = (nm, info) => [...le32(nm), info, 0, ...le16(0xfff1), ...le64(0), ...le64(0)];
  put(buf, symAt, [...sym(0, 0), ...sym(f1, 4), ...sym(f2, 4)]);
  const symstrAt = 0x500; put(buf, symstrAt, symstr);
  const debugStrAt = 0x540; const debugStr = [...z('/home/jroe/dev/widget/src'), ...z('widget.c'), ...z('GNU C17 13.2.1')]; put(buf, debugStrAt, debugStr);
  const sections = [
    ['', 0, 0, 0, 0, 0], ['.interp', 1, interpAt, 28, 0, 0], ['.note.gnu.build-id', 7, noteAt, note.length, 0, 0], ['.dynstr', 3, dynstrAt, dynstr.length, 0, 0],
    ['.dynamic', 6, dynAt, dyn.length * 16, 3, 16], ['.comment', 1, commentAt, comment.length, 0, 1], ['.gnu_debuglink', 1, linkAt, link.length, 0, 0],
    ['.symtab', 2, symAt, 72, 8, 24], ['.strtab', 3, symstrAt, symstr.length, 0, 0], ['.debug_str', 1, debugStrAt, debugStr.length, 0, 1], ['.shstrtab', 3, 0x600, 0, 0, 0],
  ];
  if (core) sections.splice(1, sections.length - 2);
  for (const s of sections) s.push(s[0] ? addStr(shstr, s[0]) : 0);
  const shstrSec = sections.find((s) => s[0] === '.shstrtab'); shstrSec[3] = shstr.length; put(buf, 0x600, shstr);
  const shoff = 0x700;
  sections.forEach(([, type, offset, size, link2, entsize, nm], i) => put(buf, shoff + i * 64, [...le32(nm), ...le32(type), ...le64(0), ...le64(offset), ...le64(offset), ...le64(size), ...le32(link2), ...le32(0), ...le64(1), ...le64(entsize)]));
  // Program headers: interpreter, one load segment covering the file, dynamic, note.
  const ph = core ? [[4, noteAt, note.length]] : [[3, interpAt, 28], [1, 0, 0x1000], [2, dynAt, dyn.length * 16], [4, noteAt, note.length]];
  ph.forEach(([type, offset, size], i) => put(buf, 64 + i * 56, [...le32(type), ...le32(4), ...le64(offset), ...le64(offset), ...le64(offset), ...le64(size), ...le64(size), ...le64(8)]));
  put(buf, 0, [0x7f, ...ascii('ELF'), 2, 1, 1, 0, ...new Array(8).fill(0), ...le16(core ? 4 : 3), ...le16(62), ...le32(1), ...le64(0x1040), ...le64(64), ...le64(shoff), ...le32(0), ...le16(64), ...le16(56), ...le16(ph.length), ...le16(64), ...le16(sections.length), ...le16(sections.length - 1)]);
  return buf.subarray(0, shoff + sections.length * 64);
}

// ---------- Mach-O ----------
export const MACHO_TEAM = 'ABCDE12345';
export const MACHO_RPATH = '/Users/jroe/Developer/Widget/build/Release';

function codeSignature() {
  const ident = z('com.roelabs.widget'); const team = z(MACHO_TEAM);
  const cdHead = 52; const cd = [...be32(0xfade0c02), ...be32(0), ...be32(0x20400), ...be32(0x10000), ...be32(cdHead + ident.length + team.length), ...be32(cdHead), ...be32(0), ...be32(0), ...be32(0), 32, 2, 0, 12, ...be32(0), ...be32(0), ...be32(cdHead + ident.length)];
  cd.push(...ident, ...team); cd.splice(4, 4, ...be32(cd.length));
  const cms = signedData([[CN, 'Apple Development: Jane Roe (XYZ9876543)'], [OU, MACHO_TEAM], [O, 'Jane Roe']], { ca: [[CN, 'Apple Worldwide Developer Relations Certification Authority'], [O, 'Apple Inc.'], [C, 'US']] });
  const cmsBlob = [...be32(0xfade0b01), ...be32(8 + cms.length), ...cms];
  const ent = new TextEncoder().encode('<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.network.client</key><true/></dict></plist>');
  const entBlob = [...be32(0xfade7171), ...be32(8 + ent.length), ...ent];
  const header = 12 + 3 * 8;
  const blob = [...be32(0xfade0cc0), 0, 0, 0, 0, ...be32(3), ...be32(0), ...be32(header), ...be32(5), ...be32(header + cd.length), ...be32(0x10000), ...be32(header + cd.length + entBlob.length), ...cd, ...entBlob, ...cmsBlob];
  blob.splice(4, 4, ...be32(blob.length));
  return blob;
}

export function macho({ cpu = 0x0100000c } = {}) {
  const sig = codeSignature();
  const cmds = [];
  const cmd = (id, body) => { const c = [...le32(id), 0, 0, 0, 0, ...body]; pad(c, 8); c.splice(4, 4, ...le32(c.length)); cmds.push(c); };
  const textSize = 0x1000;
  cmd(0x19, [...pad(ascii('__TEXT'), 16).slice(0, 16), ...le64(0x100000000), ...le64(textSize), ...le64(0), ...le64(textSize), ...le32(5), ...le32(5), ...le32(0), ...le32(0)]);
  cmd(0x1b, [0x7a, 0x6f, 0x6e, 0x7a, 0xec, 0x5c, 0x3a, 0xcd, 0x93, 0xb7, 0x3e, 0x51, 0x52, 0x4d, 0xe8, 0xf4]);
  cmd(0x32, [...le32(1), ...le32(0x0d0000), ...le32(0x0e0200), ...le32(1), ...le32(3), ...le32((1015 << 16) | (7 << 8))]);
  cmd(0x2a, le64(((1 * 1024 + 2) * 1024 + 3) * 2 ** 20));
  cmd(0xc, [...le32(24), ...le32(2), ...le32(0x10000), ...le32(0x10000), ...z('/usr/lib/libSystem.B.dylib')]);
  cmd(0x8000001c, [...le32(12), ...z(MACHO_RPATH)]);
  const sigAt = textSize;
  cmd(0x1d, [...le32(sigAt), ...le32(sig.length)]);
  const sizeofcmds = cmds.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(sigAt + sig.length);
  put(out, 0, [...le32(0xfeedfacf), ...le32(cpu), ...le32(0), ...le32(2), ...le32(cmds.length), ...le32(sizeofcmds), ...le32(0x200085), ...le32(0)]);
  let at = 32; for (const c of cmds) at = put(out, at, c);
  put(out, sigAt, sig);
  return out;
}

export function universal() {
  const a = macho({ cpu: 0x01000007 }); const b = macho({ cpu: 0x0100000c });
  const aAt = 0x1000; const bAt = aAt + Math.ceil(a.length / 0x1000) * 0x1000;
  const out = new Uint8Array(bAt + b.length);
  put(out, 0, [...be32(0xcafebabe), ...be32(2), ...be32(0x01000007), ...be32(3), ...be32(aAt), ...be32(a.length), ...be32(12), ...be32(0x0100000c), ...be32(0), ...be32(bAt), ...be32(b.length), ...be32(14)]);
  out.set(a, aAt); out.set(b, bAt);
  return out;
}
