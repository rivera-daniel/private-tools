import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectFile } from '../site/tools/lib/metadata/index.js';
import { cleanFile } from '../site/tools/lib/clean/index.js';
import * as fx from './fixtures/programs.js';

const src = (r, source, key) => r.sources.find((s) => s.name === source)?.fields.find((f) => f.key === key)?.value;
const hl = (r, group, key) => r.highlights.find((g) => g.name === group)?.fields.find((f) => f.key === key)?.value;
const titles = (r) => r.signals.map((s) => s.title);
const technical = (r, name) => r.sources.find((s) => s.name === name)?.technical;

test('PE: headers, compile time, toolchain, imports and overlay', async () => {
  const r = await inspectFile(fx.pe(), 'widget.exe');
  assert.equal(r.format, 'EXE'); assert.equal(r.category, 'Program');
  assert.equal(r.provenance, null);
  assert.equal(src(r, 'PE header', 'Machine'), 'x86-64');
  assert.equal(src(r, 'PE header', 'Subsystem'), 'Windows GUI');
  assert.equal(src(r, 'PE header', 'Linker version'), '14.36');
  assert.equal(src(r, 'Build', 'Compile time'), '2026-01-01 00:00:00 UTC');
  assert.equal(hl(r, 'Dates', 'Compiled'), '2026-01-01 00:00:00 UTC');
  assert.match(src(r, 'Build', 'Toolchain'), /^C\+\+ compiler \(Visual Studio 2022 or later, build 33145\) × 120\nC compiler .* × 12\nLinker .* × 1\nAssembler \(MASM\) .* × 3\nResource converter .* × 1$/);
  assert.equal(src(r, 'Build', 'Rich header key'), '0x5A5AA5A5');
  assert.equal(src(r, 'PE imports', 'WS2_32.dll'), '2 functions');
  assert.match(hl(r, 'Program', 'Uses'), /Network access/);
  for (const name of ['PE header', 'PE sections', 'PE imports', 'File type']) assert.equal(technical(r, name), true, name);
  const overlay = r.blocks.find((b) => b.kind === 'Trailer');
  assert.equal(overlay.removable, false); assert.equal(overlay.length, 48);
  assert.equal(r.cleanable.blocks, 0);
});

test('PE: the PDB path names the build account', async () => {
  const r = await inspectFile(fx.pe(), 'widget.exe');
  assert.equal(src(r, 'Build', 'Debug symbols path (PDB)'), fx.PDB_PATH);
  assert.equal(src(r, 'Build', 'PDB GUID'), '3DE8368D-531A-4541-85A5-44D4A7DA394D, age 1');
  assert.ok(titles(r).includes('Build path stored'));
  assert.match(r.signals.find((s) => s.title === 'Build path stored').detail, /“jroe”/);
  assert.equal(r.summary.level, 'exposed');
});

test('PE: version resource, manifest and Authenticode signer', async () => {
  const r = await inspectFile(fx.pe(), 'widget.exe');
  for (const [k, v] of Object.entries(fx.PE_STRINGS)) assert.equal(src(r, 'Version information', k), v, k);
  assert.equal(src(r, 'Version information', 'File version (numeric)'), '2.4.1.0');
  assert.equal(hl(r, 'Program', 'Company'), 'Roe Labs');
  assert.equal(src(r, 'Manifest', 'Requested privileges'), 'Administrator');
  assert.equal(src(r, 'Manifest', 'Assembly name'), 'RoeLabs.Widget');
  assert.equal(src(r, 'Signature', 'Signer'), 'Roe Labs LLC');
  assert.equal(src(r, 'Signature', 'Issued by'), 'Example Code Signing CA');
  assert.equal(src(r, 'Signature', 'Certificates included'), '2');
  assert.match(src(r, 'Signature', 'Verification'), /Not verified/);
  assert.equal(hl(r, 'Program', 'Signed by'), 'Roe Labs LLC');
});

test('PE: a reproducible build stamp is not shown as a date', async () => {
  const r = await inspectFile(fx.pe({ repro: true, overlay: false, signed: false }), 'widget.dll');
  assert.match(src(r, 'Build', 'Compile time'), /reproducible-build hash/);
  assert.equal(hl(r, 'Dates', 'Compiled'), undefined);
  assert.equal(r.blocks.find((b) => b.kind === 'Trailer'), undefined);
  assert.equal(src(r, 'Signature', 'Signed'), undefined);
});

test('ELF: interpreter, build ID, compiler, libraries, run path and source names', async () => {
  const r = await inspectFile(fx.elf(), 'widget');
  assert.equal(r.format, 'ELF'); assert.equal(r.category, 'Program');
  assert.equal(src(r, 'ELF header', 'Kind'), 'Position-independent executable');
  assert.equal(src(r, 'ELF header', 'Machine'), 'x86-64');
  assert.equal(src(r, 'ELF header', 'Symbols'), 'Present (not stripped)');
  assert.equal(src(r, 'Build', 'Interpreter'), '/lib64/ld-linux-x86-64.so.2');
  assert.equal(src(r, 'Build', 'Build ID'), fx.ELF_BUILD_ID);
  assert.equal(src(r, 'Build', 'Compiler'), 'GCC: (GNU) 13.2.1 20230801');
  assert.equal(src(r, 'Build', 'Debug symbols file'), 'widget.debug');
  assert.equal(src(r, 'Build', 'Run path (RUNPATH)'), fx.ELF_RUNPATH);
  assert.deepEqual(r.sources.find((s) => s.name === 'ELF libraries').fields.map((f) => f.key), ['libc.so.6', 'libssl.so.3']);
  assert.match(src(r, 'Build', 'Source files named'), /^3, such as widget\.c, util\.c/);
  assert.equal(src(r, 'Build', 'Build folders'), '/home/jroe/dev/widget');
  assert.ok(titles(r).includes('Build path stored'));
  assert.ok(titles(r).includes('User names in file paths'));
});

test('ELF core dump: process name and command line, flagged as a memory dump', async () => {
  const r = await inspectFile(fx.elf({ core: true }), 'core');
  assert.equal(src(r, 'ELF header', 'Kind'), 'Core dump');
  assert.equal(src(r, 'Core dump', 'Program'), 'backup-tool');
  assert.match(src(r, 'Core dump', 'Command line'), /--password/);
  assert.ok(titles(r).includes('Memory dump'));
});

test('Mach-O: UUID, platform, run path, source version and code signature', async () => {
  const r = await inspectFile(fx.macho(), 'Widget');
  assert.equal(r.format, 'Mach-O');
  assert.equal(src(r, 'Mach-O header', 'CPU'), 'ARM64');
  assert.equal(src(r, 'Build', 'UUID'), '7A6F6E7A-EC5C-3ACD-93B7-3E51524DE8F4');
  assert.equal(src(r, 'Build', 'Minimum OS'), 'macOS 13.0');
  assert.equal(src(r, 'Build', 'SDK'), '14.2');
  assert.equal(src(r, 'Build', 'Build tools'), 'ld 1015.7');
  assert.equal(src(r, 'Build', 'Source version'), '1.2.3');
  assert.equal(src(r, 'Build', 'Run path'), fx.MACHO_RPATH);
  assert.equal(src(r, 'Mach-O libraries', '/usr/lib/libSystem.B.dylib'), 'Needed, version 1.0');
  assert.equal(src(r, 'Code signature', 'Identifier'), 'com.roelabs.widget');
  assert.equal(src(r, 'Code signature', 'Team ID'), fx.MACHO_TEAM);
  assert.equal(src(r, 'Code signature', 'Hardened runtime'), 'Yes');
  assert.match(src(r, 'Code signature', 'Entitlements'), /network\.client/);
  assert.equal(src(r, 'Code signature', 'Signer'), 'Apple Development: Jane Roe (XYZ9876543)');
  for (const t of ['Build path stored', 'Signed with a personal developer certificate']) assert.ok(titles(r).includes(t), t);
});

test('Mach-O universal binary: every slice is read', async () => {
  const r = await inspectFile(fx.universal(), 'Widget');
  assert.equal(src(r, 'Mach-O header', 'Architectures'), 'x86-64, ARM64');
  assert.equal(src(r, 'Mach-O x86-64 header', 'CPU'), 'x86-64');
  assert.equal(src(r, 'Mach-O ARM64 code signature', 'Team ID'), fx.MACHO_TEAM);
  assert.equal(r.blocks.find((b) => b.kind === 'Trailer'), undefined);
});

test('programs are inspected, never cleaned', async () => {
  const r = await cleanFile(fx.pe(), 'widget.exe');
  assert.equal(r.ok, false);
  assert.match(r.reason, /EXE files cannot be cleaned/);
});

test('hostile program headers stop with a warning, never a crash', async () => {
  const pe = fx.pe(); pe.fill(0xff, 0x118 + 240, 0x118 + 240 + 120);
  const r = await inspectFile(pe, 'broken.exe');
  assert.equal(r.category, 'Program');
  const elf = fx.elf().slice(0, 80);
  const re = await inspectFile(elf, 'cut');
  assert.equal(re.format, 'ELF');
  const mach = fx.macho(); mach.fill(0xff, 32, 64);
  assert.equal((await inspectFile(mach, 'm')).format, 'Mach-O');
  for (let n = 0; n < 200; n++) {
    const bytes = fx.pe(); for (let k = 0; k < 40; k++) bytes[(n * 7919 + k * 104729) % bytes.length] ^= 0x5a;
    await inspectFile(bytes, 'fuzz.exe');
  }
});
