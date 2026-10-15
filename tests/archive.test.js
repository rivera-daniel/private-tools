import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, readEntry } from '../site/tools/lib/zip/index.js';
import { ZipStreamWriter, openZipBlob, zipEntryChunks, mayNeedZip64, NeedsPassword } from '../site/tools/lib/zip/stream.js';
import { Aes, WinZipCtr, Sha1, HmacSha1, deriveKeys, WrongPassword } from '../site/tools/lib/zip/aes.js';
import { tarStream, readTar } from '../site/tools/lib/archive/tar.js';
import { safePath, uniquePath } from '../site/tools/lib/archive/paths.js';
import { MemorySink, BlobReader, collect, bytesChunks } from '../site/tools/lib/archive/streams.js';
import { createArchive, listArchive, extractEntries, detectFormat, alreadyCompressed, LIMITS } from '../site/tools/lib/archive/index.js';
import { zipCryptoZip, overlappingZip, understatedZip } from './fixtures/archive.js';
import * as fx from './fixtures/build.js';

const enc = new TextEncoder(); const dec = new TextDecoder();
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const fileOf = (name, data, lastModified = Date.UTC(2023, 5, 1, 12)) => new File([data], name, { lastModified });
const tmp = () => mkdtempSync(join(tmpdir(), 'archive-test-'));

async function make(items, options) {
  const out = await createArchive({ items, sink: new MemorySink(), clean: false, ...options });
  return { ...out, bytes: new Uint8Array(await out.result.arrayBuffer()) };
}
async function extractAll(blob, format, options = {}) {
  const listing = await listArchive(blob, format);
  const files = {};
  for await (const { entry, chunks } of extractEntries(blob, listing, listing.entries.map((e) => e.id), options)) files[entry.path] = await collect(chunks);
  return { listing, files };
}

const sample = () => [
  { file: fileOf('readme.txt', 'hello '.repeat(2000)), path: 'project/readme.txt' },
  { file: fileOf('photo.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), path: 'project/images/photo.jpg' },
  { file: fileOf('ü.txt', 'unicode name'), path: 'project/naïve café ü.txt' },
  { file: fileOf('empty.txt', ''), path: 'project/empty.txt' },
  { path: 'project/empty-folder', directory: true },
];

test('AES block cipher, SHA-1 and HMAC-SHA1 match FIPS vectors and WebCrypto', async () => {
  const out = new Uint8Array(16);
  new Aes(Uint8Array.from({ length: 32 }, (_, i) => i)).encryptBlock(Buffer.from('00112233445566778899aabbccddeeff', 'hex'), 0, out, 0);
  assert.equal(Buffer.from(out).toString('hex'), '8ea2b7ca516745bfeafc49904b496089');
  // WinZip's first counter block is 01 00 .. 00. A one-block AES-CBC with a zero IV is plain AES.
  const key = crypto.getRandomValues(new Uint8Array(32));
  const counter = new Uint8Array(16); counter[0] = 1;
  const ck = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const block = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, ck, counter)).subarray(0, 16);
  assert.deepEqual(new WinZipCtr(key).process(new Uint8Array(16)), block);
  const data = crypto.getRandomValues(new Uint8Array(1000));
  assert.deepEqual(new Sha1().update(data.subarray(0, 333)).update(data.subarray(333)).digest(), new Uint8Array(await crypto.subtle.digest('SHA-1', data)));
  const hk = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  assert.deepEqual(new HmacSha1(key).update(data).digest(), new Uint8Array(await crypto.subtle.sign('HMAC', hk, data)));
  const keys = await deriveKeys('password', new Uint8Array(16), 3);
  assert.equal(keys.aesKey.length, 32); assert.equal(keys.macKey.length, 32); assert.equal(keys.verifier.length, 2);
});

test('ZIP: create and extract round trip with UTF-8 names, folders, store for compressed files', async () => {
  const { bytes, entries } = await make(sample(), { format: 'zip' });
  assert.deepEqual(entries.map((e) => e.method), [8, 0, 8, 0, 0]);
  // The shared reader and the streaming reader agree.
  const zip = readZip(bytes);
  assert.deepEqual(zip.entries.map((e) => e.name), ['project/readme.txt', 'project/images/photo.jpg', 'project/naïve café ü.txt', 'project/empty.txt', 'project/empty-folder/']);
  assert.equal(dec.decode(await readEntry(zip, zip.entries[0])), 'hello '.repeat(2000));
  for (const e of zip.entries) { assert.deepEqual(e.extra, []); assert.equal(e.comment, ''); assert.equal(e.modified.toISOString(), '1980-01-01T00:00:00.000Z'); assert.equal(e.versionMadeBy >> 8, 0); }
  const { listing, files } = await extractAll(new Blob([bytes]), 'zip');
  assert.equal(listing.entries.find((e) => e.kind === 'directory').path, 'project/empty-folder');
  assert.equal(dec.decode(files['project/naïve café ü.txt']), 'unicode name');
  assert.equal(files['project/empty.txt'].length, 0);
  assert.equal(await detectFormat(new Blob([bytes])), 'zip');
});

test('ZIP: original dates are kept when asked, as local wall-clock time', async () => {
  const when = new Date(2022, 2, 4, 15, 30, 20).getTime();
  const { bytes } = await make([{ file: fileOf('a.txt', 'a', when), path: 'a.txt' }], { format: 'zip', hideDates: false });
  const d = readZip(bytes).entries[0].modified;
  assert.deepEqual([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()], [2022, 2, 4, 15, 30, 20]);
});

test('ZIP: WinZip AES-256 round trip, wrong password and tampering are refused', async () => {
  const { bytes } = await make(sample(), { format: 'zip', password: 'correct horse' });
  const zip = await openZipBlob(new Blob([bytes]));
  const file = zip.entries[0];
  assert.equal(file.method, 99); assert.equal(file.realMethod, 8); assert.equal(file.aes.strength, 3); assert.equal(file.aes.version, 2); assert.equal(file.crc, 0);
  assert.ok(file.encrypted); assert.ok(!zip.entries[4].encrypted, 'folders are not encrypted');
  const { files } = await extractAll(new Blob([bytes]), 'zip', { password: 'correct horse' });
  assert.equal(dec.decode(files['project/readme.txt']), 'hello '.repeat(2000));
  assert.equal(files['project/empty.txt'].length, 0);
  await assert.rejects(collect(zipEntryChunks(new Blob([bytes]), file, {})), NeedsPassword);
  await assert.rejects(collect(zipEntryChunks(new Blob([bytes]), file, { password: 'wrong' })), WrongPassword);
  const bad = bytes.slice(); bad[file.localOffset + 30 + file.nameBytes.length + 11 + 16 + 2 + 5] ^= 1;
  await assert.rejects(collect(zipEntryChunks(new Blob([bad]), file, { password: 'correct horse' })), /authentication failed/);
});

test('ZIP: ZipCrypto archives are decrypted and flagged as weak', async () => {
  const u8 = await zipCryptoZip('secret.txt', enc.encode('legacy secret'), 'pass');
  const listing = await listArchive(new Blob([u8]), 'zip');
  assert.ok(listing.entries[0].encrypted); assert.ok(listing.entries[0].weak);
  const { files } = await extractAll(new Blob([u8]), 'zip', { password: 'pass' });
  assert.equal(dec.decode(files['secret.txt']), 'legacy secret');
  await assert.rejects(extractAll(new Blob([u8]), 'zip', { password: 'nope' }), /password|checksum/);
});

test('ZIP64: local headers reserve 64-bit sizes for huge entries, offsets past 4 GB use ZIP64 records', async () => {
  assert.equal(mayNeedZip64(1000), false); assert.equal(mayNeedZip64(0xffffffff - 10), true); assert.equal(mayNeedZip64(4.294e9), true); assert.equal(mayNeedZip64(4.1e9), false);
  // A declared size over 4 GB makes the local header carry ZIP64 sizes; the data here is small.
  const sink = new MemorySink();
  const w = new ZipStreamWriter(sink);
  await w.add({ name: 'huge.bin', size: 5 * 2 ** 30, source: bytesChunks(enc.encode('tiny')), method: 0 });
  const bytes = new Uint8Array(await (await w.finish()).arrayBuffer());
  const v = new DataView(bytes.buffer);
  assert.equal(v.getUint32(18, true), 0xffffffff); assert.equal(v.getUint32(22, true), 0xffffffff);
  assert.equal(v.getUint16(30 + 8, true), 0x0001); assert.equal(v.getUint32(30 + 8 + 4, true), 4); assert.equal(v.getUint32(30 + 8 + 12, true), 4);
  const zip = readZip(bytes);
  assert.equal(dec.decode(await readEntry(zip, zip.entries[0])), 'tiny');
  // Pretend 4 GB were already written: the central record and the end records switch to ZIP64.
  const records = [];
  const far = new ZipStreamWriter({ write: async (c) => records.push(c), patch: async () => {}, close: async () => records, abort: async () => {} });
  far.offset = 2 ** 32 + 100;
  await far.add({ name: 'late.txt', size: 3, source: bytesChunks(enc.encode('abc')), method: 0 });
  await far.finish();
  const central = records.find((r) => r.length >= 46 && new DataView(r.buffer, r.byteOffset).getUint32(0, true) === 0x02014b50);
  const cv = new DataView(central.buffer, central.byteOffset);
  assert.equal(cv.getUint32(42, true), 0xffffffff); assert.equal(cv.getUint16(46 + 8, true), 0x0001); assert.equal(cv.getUint16(46 + 8 + 2, true), 8);
  assert.equal(cv.getUint32(46 + 8 + 4, true) + cv.getUint32(46 + 8 + 8, true) * 2 ** 32, 2 ** 32 + 100);
  assert.ok(records.some((r) => r.length === 56 && new DataView(r.buffer, r.byteOffset).getUint32(0, true) === 0x06064b50), 'ZIP64 end record');
});

test('ZIP64: more than 65,535 entries', async () => {
  const sink = new MemorySink(); const w = new ZipStreamWriter(sink);
  for (let i = 0; i < 65600; i++) await w.add({ name: `f${i}`, size: 0, source: [], method: 0 });
  const blob = await w.finish();
  const zip = await openZipBlob(blob);
  assert.equal(zip.entries.length, 65600); assert.ok(zip.zip64);
  assert.equal(zip.entries.at(-1).name, 'f65599');
  if (has('python3')) {
    const dir = tmp(); writeFileSync(join(dir, 'many.zip'), new Uint8Array(await blob.arrayBuffer()));
    const out = execFileSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(len(z.namelist()), z.testzip())', join(dir, 'many.zip')]).toString().trim();
    assert.equal(out, '65600 None'); rmSync(dir, { recursive: true });
  }
});

test('tar: ustar and PAX names round trip, folders, base-256 free sizes', async () => {
  const long = `${'deep/'.repeat(30)}file.txt`; const longer = 'x'.repeat(180);
  const items = [...sample(), { file: fileOf('l.txt', 'long'), path: long }, { file: fileOf('n.txt', 'no slash'), path: longer }];
  const { bytes } = await make(items, { format: 'tar' });
  assert.equal(bytes.length % 512, 0);
  const { listing, files } = await extractAll(new Blob([bytes]), 'tar');
  assert.deepEqual(listing.entries.map((e) => e.path), ['project/readme.txt', 'project/images/photo.jpg', 'project/naïve café ü.txt', 'project/empty.txt', 'project/empty-folder', long.replace(/\/$/, ''), longer]);
  assert.equal(dec.decode(files[long]), 'long'); assert.equal(dec.decode(files[longer]), 'no slash');
  assert.equal(dec.decode(files['project/naïve café ü.txt']), 'unicode name');
  assert.ok(listing.entries.every((e) => !e.modified || e.modified.getTime() === Date.UTC(1980, 0, 1)));
  assert.equal(await detectFormat(new Blob([bytes])), 'tar');
  for (const tool of ['tar', 'bsdtar'].filter(has)) {
    const dir = tmp(); writeFileSync(join(dir, 'a.tar'), bytes);
    const names = execFileSync(tool, ['-tf', join(dir, 'a.tar')]).toString().trim().split('\n');
    assert.ok(names.includes(long) && names.includes(longer) && names.includes('project/naïve café ü.txt'), `${tool} lists the names`);
    const verbose = execFileSync(tool, ['-tvf', join(dir, 'a.tar')], { env: { ...process.env, TZ: 'UTC' } }).toString();
    assert.match(verbose, /1980-01-01|Jan  1  1980/); assert.doesNotMatch(verbose, /PaxHeader/);
    rmSync(dir, { recursive: true });
  }
});

test('tar.gz and gz: round trip and detection', async () => {
  const { bytes } = await make(sample(), { format: 'tar.gz' });
  assert.equal(await detectFormat(new Blob([bytes])), 'tar.gz');
  const { files } = await extractAll(new Blob([bytes]), 'tar.gz');
  assert.equal(dec.decode(files['project/readme.txt']), 'hello '.repeat(2000));
  const gz = await make([{ file: fileOf('notes.txt', 'gzip me '.repeat(100)), path: 'notes.txt' }], { format: 'gz' });
  assert.equal(gz.bytes[3] & 0x08, 0, 'no file name in the gzip header');
  assert.equal(await detectFormat(new Blob([gz.bytes])), 'gz');
  const blob = new File([gz.bytes], 'notes.txt.gz');
  const out = await extractAll(blob, 'gz');
  assert.equal(out.listing.entries[0].path, 'notes.txt'); assert.equal(out.listing.entries[0].size, 800);
  assert.equal(dec.decode(out.files['notes.txt']), 'gzip me '.repeat(100));
  await assert.rejects(make(sample(), { format: 'gz' }), /exactly one file/);
  await assert.rejects(make(sample(), { format: 'tar', password: 'x' }), /Only ZIP/);
});

test('paths: traversal is blocked, absolute paths and drive letters are made relative', async () => {
  assert.deepEqual(safePath('../etc/passwd'), { path: null, note: 'traversal' });
  assert.deepEqual(safePath('a/../../b'), { path: null, note: 'traversal' });
  assert.deepEqual(safePath('..\\..\\windows\\system.ini'), { path: null, note: 'traversal' });
  assert.deepEqual(safePath('/etc/passwd'), { path: 'etc/passwd', note: 'absolute' });
  assert.deepEqual(safePath('C:\\Users\\x.txt'), { path: 'Users/x.txt', note: 'absolute' });
  assert.deepEqual(safePath('./a//b/./c'), { path: 'a/b/c', note: null });
  assert.deepEqual(safePath('a\u0007b'), { path: 'a_b', note: 'renamed' });
  assert.deepEqual(safePath('/'), { path: null, note: 'empty' });
  const taken = new Set(); assert.equal(uniquePath('a.txt', taken), 'a.txt'); assert.equal(uniquePath('A.txt', taken), 'A (2).txt');
  // A tar with hostile names lists them and extracts only the safe ones. Links are never followed.
  const hostile = await collect(tarStream([
    { name: '../evil.sh', size: 4, source: [enc.encode('evil')], mtime: 0 },
    { name: '/abs.txt', size: 3, source: [enc.encode('abs')], mtime: 0 },
    { name: 'ok.txt', size: 2, source: [enc.encode('ok')], mtime: 0 },
  ]));
  // Turn ok.txt into a symlink by rewriting its type flag and checksum.
  const at = 512 * 4; const link = new Uint8Array([...hostile.subarray(0, at + 512), ...hostile.subarray(at + 1024)]); link[at + 156] = 0x32; link.set(enc.encode('/etc/passwd'), at + 157); link.set(enc.encode('00000000000\0'), at + 124);
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : link[at + i];
  link.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), at + 148);
  const { listing, files } = await extractAll(new Blob([link]), 'tar');
  assert.deepEqual(listing.entries.map((e) => [e.path, e.note, e.kind]), [[null, 'traversal', 'file'], ['abs.txt', 'absolute', 'file'], ['ok.txt', null, 'symlink']]);
  assert.deepEqual(Object.keys(files), ['abs.txt']);
});

test('bombs: overlapping entries, understated sizes, ratio and total caps', async () => {
  await assert.rejects(openZipBlob(new Blob([await overlappingZip()])), /overlap/);
  await assert.rejects(extractAll(new Blob([await understatedZip()]), 'zip'), /more data than the archive declares/);
  const zeros = await make([{ file: fileOf('zeros.bin', new Uint8Array(4 * 1024 * 1024)), path: 'zeros.bin' }], { format: 'zip' });
  const saved = { ...LIMITS };
  try {
    Object.assign(LIMITS, { ratioFloor: 1024 * 1024, maxRatio: 100 });
    await assert.rejects(extractAll(new Blob([zeros.bytes]), 'zip'), /expands more than 100 times/);
    Object.assign(LIMITS, saved);
    await assert.rejects(extractAll(new Blob([zeros.bytes]), 'zip', { cap: 1024 * 1024 }), /Extraction stopped at/);
  } finally { Object.assign(LIMITS, saved); }
  assert.equal((await extractAll(new Blob([zeros.bytes]), 'zip')).files['zeros.bin'].length, 4 * 1024 * 1024);
});

test('remove hidden data: files the cleaner supports are cleaned, others are listed and kept', async () => {
  const exif = fx.tiff([[0x010f, 2, 'Canon']], { gps: [[0x0001, 2, 'N'], [0x0002, 5, fx.dms(30.26715)]] });
  const jpeg = fx.jpegWith(fx.exifSegment(exif));
  const out = await createArchive({ items: [{ file: fileOf('photo.jpg', jpeg), path: 'photo.jpg' }, { file: fileOf('notes.txt', 'plain'), path: 'notes.txt' }], format: 'zip', sink: new MemorySink(), clean: true });
  assert.deepEqual(out.cleaned.map((c) => c.path), ['photo.jpg']);
  assert.deepEqual(out.kept.map((k) => k.path), ['notes.txt']);
  const zip = readZip(new Uint8Array(await out.result.arrayBuffer()));
  const photo = await readEntry(zip, zip.entries[0]);
  assert.ok(photo.length < jpeg.length);
  assert.equal(dec.decode(photo).includes('Canon'), false);
});

test('already-compressed detection', () => {
  assert.ok(alreadyCompressed('a.JPG', new Uint8Array(4)));
  assert.ok(alreadyCompressed('noext', new Uint8Array([0x50, 0x4b, 3, 4])));
  assert.ok(alreadyCompressed('movie', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])));
  assert.equal(alreadyCompressed('notes.txt', enc.encode('hello')), false);
});

test('streams: BlobReader and tar reader skip data without reading it', async () => {
  const bytes = await collect(tarStream([{ name: 'a', size: 3000, source: [new Uint8Array(3000)], mtime: 0 }, { name: 'b', size: 1, source: [enc.encode('b')], mtime: 0 }]));
  const seen = [];
  for await (const e of readTar(new BlobReader(new Blob([bytes])))) { seen.push(e.name); if (e.name === 'b') assert.equal(dec.decode(await collect(e.chunks())), 'b'); }
  assert.deepEqual(seen, ['a', 'b']);
});

// Cross-checks with other implementations, when they are installed.
test('cross-check: other tools read our archives and we read theirs', { skip: !has('bsdtar') && !has('python3') }, async () => {
  const dir = tmp();
  try {
    const plain = await make(sample(), { format: 'zip' });
    writeFileSync(join(dir, 'plain.zip'), plain.bytes);
    if (has('python3')) assert.equal(execFileSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(z.read("project/naïve café ü.txt").decode())', join(dir, 'plain.zip')]).toString(), 'None\nunicode name\n');
    if (has('unzip')) assert.match(execFileSync('unzip', ['-t', join(dir, 'plain.zip')]).toString(), /No errors detected/);
    if (has('bsdtar')) {
      const aes = await make(sample(), { format: 'zip', password: 'secret pw' });
      writeFileSync(join(dir, 'aes.zip'), aes.bytes);
      mkdirSync(join(dir, 'out'));
      execFileSync('bsdtar', ['-xf', join(dir, 'aes.zip'), '--passphrase', 'secret pw', '-C', join(dir, 'out')]);
      assert.equal(readFileSync(join(dir, 'out/project/readme.txt'), 'utf8'), 'hello '.repeat(2000));
      assert.equal(readFileSync(join(dir, 'out/project/images/photo.jpg')).length, 7);
      assert.notEqual(spawnSync('bsdtar', ['-xf', join(dir, 'aes.zip'), '--passphrase', 'wrong', '-C', join(dir, 'out')]).status, 0);
      // An AES-256 ZIP made by libarchive opens here.
      writeFileSync(join(dir, 'in.txt'), 'made by bsdtar '.repeat(50));
      execFileSync('bsdtar', ['--format', 'zip', '--options', 'zip:encryption=aes256', '--passphrase', 'pw2', '-cf', join(dir, 'theirs.zip'), '-C', dir, 'in.txt']);
      const theirs = new Blob([readFileSync(join(dir, 'theirs.zip'))]);
      const { files } = await extractAll(theirs, 'zip', { password: 'pw2' });
      assert.equal(dec.decode(files['in.txt']), 'made by bsdtar '.repeat(50));
      execFileSync('bsdtar', ['--format', 'zip', '--options', 'zip:encryption=zipcrypt', '--passphrase', 'pw3', '-cf', join(dir, 'zc.zip'), '-C', dir, 'in.txt']);
      const zc = await extractAll(new Blob([readFileSync(join(dir, 'zc.zip'))]), 'zip', { password: 'pw3' });
      assert.ok(zc.listing.entries[0].weak); assert.equal(dec.decode(zc.files['in.txt']), 'made by bsdtar '.repeat(50));
      execFileSync('bsdtar', ['-czf', join(dir, 'theirs.tgz'), '-C', dir, 'in.txt']);
      const tgz = new Blob([readFileSync(join(dir, 'theirs.tgz'))]);
      assert.equal(await detectFormat(tgz), 'tar.gz');
      assert.equal(dec.decode((await extractAll(tgz, 'tar.gz')).files['in.txt']), 'made by bsdtar '.repeat(50));
    }
    const sevenZip = ['7zz', '7z'].find(has);
    if (sevenZip) {
      // 7-Zip reads our AES-256 ZIP and makes one we read.
      const aes = await make(sample(), { format: 'zip', password: 'seven pw' });
      writeFileSync(join(dir, 'aes7.zip'), aes.bytes);
      assert.match(execFileSync(sevenZip, ['t', '-pseven pw', join(dir, 'aes7.zip')]).toString(), /Everything is Ok/);
      assert.notEqual(spawnSync(sevenZip, ['t', '-pwrong', join(dir, 'aes7.zip')]).status, 0);
      writeFileSync(join(dir, 'in7.txt'), 'made by 7-Zip '.repeat(5000));
      execFileSync(sevenZip, ['a', '-bso0', '-tzip', '-mem=AES256', '-pzz top', join(dir, 'theirs7.zip'), join(dir, 'in7.txt')]);
      const t7 = await extractAll(new Blob([readFileSync(join(dir, 'theirs7.zip'))]), 'zip', { password: 'zz top' });
      assert.equal(dec.decode(t7.files['in7.txt']), 'made by 7-Zip '.repeat(5000));
    }
    if (has('zip')) {
      writeFileSync(join(dir, 'z.txt'), 'info-zip text');
      execFileSync('zip', ['-q', '-P', 'izpw', join(dir, 'iz.zip'), 'z.txt'], { cwd: dir });
      const iz = await extractAll(new Blob([readFileSync(join(dir, 'iz.zip'))]), 'zip', { password: 'izpw' });
      assert.equal(dec.decode(iz.files['z.txt']), 'info-zip text');
    }
  } finally { rmSync(dir, { recursive: true }); }
});
