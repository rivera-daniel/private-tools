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
import { planExtraction, portableName, freshFolderName, keepBothName, nameKey, foldersToScan, archiveBase } from '../site/tools/lib/archive/destination.js';
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
  const out = await createArchive({ items: [{ file: fileOf('photo.jpg', jpeg), path: 'photo.jpg' }, { file: fileOf('notes.txt', 'plain'), path: 'notes.txt' }, { file: fileOf('data.bin', new Uint8Array([0x13, 0x37, 0, 1, 2, 3, 0xfe, 0xed])), path: 'data.bin' }], format: 'zip', sink: new MemorySink(), clean: true });
  // Plain text the cleaner reads but finds nothing in is neither cleaned nor listed as kept.
  assert.deepEqual(out.cleaned.map((c) => c.path), ['photo.jpg']);
  assert.deepEqual(out.kept.map((k) => k.path), ['data.bin']);
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

// Hand-built tar headers, for PAX and GNU records the writer never produces.
function rawHeader(name, size, type) {
  const h = new Uint8Array(512); const put = (at, text) => h.set(enc.encode(text), at);
  put(0, name); put(100, '0000644\0'); put(108, '0000000\0'); put(116, '0000000\0');
  put(124, `${size.toString(8).padStart(11, '0')}\0`); put(136, '00000000000\0'); h[156] = type.charCodeAt(0);
  put(257, 'ustar\0'); put(263, '00');
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}
const block = (bytes) => { const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512); out.set(bytes); return out; };
// records: [[type, body bytes]] placed before one file entry called name holding data.
function rawTar(records, name = 'header-name.txt', data = 'x') {
  const parts = [];
  for (const [type, body] of records) parts.push(rawHeader(type === 'x' ? 'PaxHeader' : '././@LongLink', body.length, type), block(body));
  parts.push(rawHeader(name, enc.encode(data).length, '0'), block(enc.encode(data)), new Uint8Array(1024));
  return new Blob(parts);
}
// A correct PAX record: the length counts bytes, its own digits included.
function paxRec(key, value) {
  const body = enc.encode(` ${key}=${value}\n`).length;
  let length = body + 1; while (String(length).length + body !== length) length = String(length).length + body;
  return `${length} ${key}=${value}\n`;
}
async function tarNames(blob) { const names = []; for await (const e of readTar(new BlobReader(blob))) names.push(e.name); return names; }

test('tar PAX: records are cut by their byte length, so names keep newlines and cannot inject attributes', async () => {
  const tricky = 'harmless\n20 path=report.txt\n尾.txt';
  const names = [tricky, 'line\nbreak.txt', '日本語/ファイル名 ü é.txt', 'emoji 🙂\n.txt', `${'長'.repeat(120)}.txt`];
  const bytes = await collect(tarStream(names.map((name) => ({ name, size: 1, source: [enc.encode('x')], mtime: 0 }))));
  assert.deepEqual(await tarNames(new Blob([bytes])), names, 'raw names are read exactly');
  const listing = await listArchive(new Blob([bytes]), 'tar');
  assert.deepEqual(listing.entries.map((e) => e.name), names);
  assert.equal(listing.entries[0].path, 'harmless_20 path=report.txt_尾.txt', 'control characters are replaced only in the path used on disk');
  assert.ok(!listing.entries.some((e) => e.path === 'report.txt'));
  if (has('python3')) {
    const dir = tmp(); writeFileSync(join(dir, 'n.tar'), bytes);
    const out = JSON.parse(execFileSync('python3', ['-c', 'import tarfile,sys,json;print(json.dumps([m.name for m in tarfile.open(sys.argv[1])]))', join(dir, 'n.tar')]).toString());
    assert.deepEqual(out, names, 'Python reads the same names');
    rmSync(dir, { recursive: true });
  }
});

test('tar PAX: duplicate keys keep the last value, empty values remove the attribute, NUL padding is allowed', async () => {
  assert.deepEqual(await tarNames(rawTar([['x', enc.encode(paxRec('path', 'first.txt') + paxRec('path', 'second.txt'))]])), ['second.txt']);
  assert.deepEqual(await tarNames(rawTar([['x', enc.encode(paxRec('path', 'a.txt'))], ['x', enc.encode(paxRec('path', 'b.txt'))]])), ['b.txt']);
  assert.deepEqual(await tarNames(rawTar([['x', enc.encode(paxRec('path', ''))]])), ['header-name.txt']);
  const padded = new Uint8Array(enc.encode(paxRec('path', 'padded.txt')).length + 7); padded.set(enc.encode(paxRec('path', 'padded.txt')));
  assert.deepEqual(await tarNames(rawTar([['x', padded]])), ['padded.txt']);
  assert.equal(paxRec('path', 'ü'), '11 path=ü\n', 'lengths count UTF-8 bytes');
  assert.deepEqual(await tarNames(rawTar([['x', enc.encode(paxRec('path', 'naïve ü.txt'))]])), ['naïve ü.txt']);
});

test('tar PAX and GNU: malformed records refuse the archive', async () => {
  const good = paxRec('path', 'report.txt');
  const bad = {
    'length too long': good.replace(/^\d+/, (n) => String(Number(n) + 1)),
    'length too short': good.replace(/^\d+/, (n) => String(Number(n) - 1)),
    'length past the end': `99 path=report.txt\n`,
    'zero length': `0 path=x\n`,
    'not a number': `ab path=report.txt\n`,
    'no space': `${good.length}path=report.txt\n`.replace(/^\d+/, (n) => String(Number(n) - 1)),
    'no equals sign': paxRec('pathreport.txt', '').replace('=', ' '),
    'empty key': paxRec('', 'report.txt'),
    'counted in characters, not bytes': `16 path=ü.txt\n`.replace('16', String(' path=ü.txt\n'.length + 2)),
    'length lands inside the next record': `${good.length + 5}${good.slice(String(good.length).length)}${paxRec('mtime', '1')}`,
  };
  for (const [label, body] of Object.entries(bad)) await assert.rejects(tarNames(rawTar([['x', enc.encode(body)]])), /extended header is damaged/, label);
  await assert.rejects(tarNames(rawTar([['x', enc.encode(paxRec('size', '12abc'))]])), /invalid size/);
  await assert.rejects(tarNames(rawTar([['L', enc.encode('real.txt\0hidden.txt\0')]])), /long name record is damaged/);
  await assert.rejects(tarNames(rawTar([['L', enc.encode('\0')]])), /long name record is damaged/);
  assert.deepEqual(await tarNames(rawTar([['L', enc.encode('gnu/long name.txt\0\0\0')]])), ['gnu/long name.txt']);
  assert.deepEqual(await tarNames(rawTar([['L', enc.encode('no-terminator.txt')]])), ['no-terminator.txt']);
});

test('destination: names are made portable and compared by case and Unicode normalization', () => {
  assert.equal(portableName('CON'), '_CON'); assert.equal(portableName('nul.txt'), '_nul.txt'); assert.equal(portableName('com1.tar.gz'), '_com1.tar.gz');
  assert.equal(portableName('CON .txt'), '_CON .txt'); assert.equal(portableName('nul.'), '_nul');
  assert.equal(portableName('report. . '), 'report'); assert.equal(portableName('...'), '_'); assert.equal(portableName(' '), '_');
  assert.equal(portableName('a:b?c*.txt'), 'a_b_c_.txt'); assert.equal(portableName('console.txt'), 'console.txt');
  assert.equal(portableName('é.txt'), 'é.txt');
  assert.equal(nameKey('RéPORT.TXT'), nameKey('réport.txt'));
  assert.equal(archiveBase('report.tar.gz'), 'report'); assert.equal(archiveBase('.zip'), 'archive');
  assert.equal(freshFolderName('report.zip', new Set()), 'report (extracted)');
  assert.equal(freshFolderName('report.zip', new Set(['report (extracted)', 'report (extracted) 2'])), 'report (extracted) 3');
  assert.equal(freshFolderName('CON.zip', new Set()), '_CON (extracted)');
  assert.equal(keepBothName('report.txt', new Set(['report.txt'])), 'report (1).txt');
  assert.equal(keepBothName('report.txt', new Set(['report.txt', 'report (1).txt'])), 'report (2).txt');
  assert.equal(keepBothName('.env', new Set()), '.env (1)'); assert.equal(keepBothName('README', new Set()), 'README (1)');
});

const existingOf = (tree) => new Map(Object.entries(tree).map(([dir, names]) => [dir, new Map(Object.entries(names).map(([name, kind]) => [nameKey(name), { name, kind }]))]));

test('destination: entries that clash inside the archive get unique names, folders keep theirs', () => {
  const plan = planExtraction([
    { id: 1, path: 'Report.txt', kind: 'file' },
    { id: 2, path: 'report.txt', kind: 'file' },
    { id: 3, path: 'résumé.txt', kind: 'file' },
    { id: 4, path: 'résumé.txt', kind: 'file' },
    { id: 5, path: 'a', kind: 'file' },
    { id: 6, path: 'a/b.txt', kind: 'file' },
    { id: 7, path: 'Docs/one.txt', kind: 'file' },
    { id: 8, path: 'docs/two.txt', kind: 'file' },
    { id: 9, path: 'CON', kind: 'file' },
    { id: 10, path: 'notes.', kind: 'file' },
    { id: 11, path: 'notes', kind: 'file' },
  ]);
  assert.deepEqual(plan.files.map((f) => [f.id, f.path]), [[1, 'Report.txt'], [2, 'report (1).txt'], [3, 'résumé.txt'], [4, 'résumé (1).txt'], [5, 'a (1)'], [6, 'a/b.txt'], [7, 'Docs/one.txt'], [8, 'Docs/two.txt'], [9, '_CON'], [10, 'notes'], [11, 'notes (1)']]);
  assert.deepEqual(plan.directories, ['a', 'Docs']);
  assert.ok(plan.files.every((f) => !f.replace)); assert.deepEqual(plan.collisions, []);
  assert.deepEqual(plan.renamed.map((r) => [r.id, r.reason]), [[2, 'duplicate'], [4, 'duplicate'], [5, 'duplicate'], [9, 'portable'], [10, 'portable'], [11, 'duplicate']]);
  const keys = plan.files.map((f) => nameKey(f.path));
  assert.equal(new Set(keys).size, keys.length, 'no two files share a name on any disk');
});

test('destination: existing names are kept unless Replace is chosen, and folders are never replaced', () => {
  const entries = [
    { id: 1, path: 'report.txt', kind: 'file' }, { id: 2, path: 'new.txt', kind: 'file' }, { id: 3, path: 'Photos/a.jpg', kind: 'file' },
    { id: 4, path: 'Photos/b.jpg', kind: 'file' }, { id: 5, path: 'data/x.csv', kind: 'file' }, { id: 6, path: 'music', kind: 'file' },
  ];
  const existing = existingOf({ '': { 'Report.TXT': 'file', 'report (1).txt': 'file', photos: 'directory', data: 'file', Music: 'directory' }, photos: { 'A.JPG': 'file' } });
  const plain = planExtraction(entries, { existing });
  assert.deepEqual(plain.files.map((f) => [f.id, f.path, f.replace]), [[1, 'report (2).txt', false], [2, 'new.txt', false], [3, 'photos/a (1).jpg', false], [4, 'photos/b.jpg', false], [5, 'data (1)/x.csv', false], [6, 'music (1)', false]]);
  assert.deepEqual(plain.collisions.map((c) => [c.path, c.existing, c.wanted, c.replaceable, c.choice]), [['data', 'file', 'directory', false, 'keep'], ['Report.TXT', 'file', 'file', true, 'keep'], ['photos/A.JPG', 'file', 'file', true, 'keep'], ['Music', 'directory', 'file', false, 'keep']]);
  assert.deepEqual(plain.directories, ['photos', 'data (1)'], 'the existing folder is reused under its own spelling');

  const replace = planExtraction(entries, { existing, choices: { 'Report.TXT': 'replace', 'photos/A.JPG': 'skip', data: 'replace', Music: 'replace' } });
  assert.deepEqual(replace.files.map((f) => [f.id, f.path, f.replace]), [[1, 'Report.TXT', true], [2, 'new.txt', false], [4, 'photos/b.jpg', false], [5, 'data (1)/x.csv', false], [6, 'music (1)', false]]);
  assert.deepEqual(replace.skipped.map((s) => s.id), [3]);
  const skipFolder = planExtraction(entries, { existing, choices: { data: 'skip' } });
  assert.deepEqual(skipFolder.skipped.map((s) => s.id), [5], 'skipping a folder skips everything in it');
  assert.equal(skipFolder.files.filter((f) => f.replace).length, 0, 'nothing is replaced without a choice');
});

test('destination: only folders that will be written into are scanned', () => {
  const tree = foldersToScan([{ id: 1, path: 'A/b/c.txt', kind: 'file' }, { id: 2, path: 'top.txt', kind: 'file' }, { id: 3, path: 'empty', kind: 'directory' }]);
  assert.deepEqual([...tree.keys()], ['a', 'empty']); assert.deepEqual([...tree.get('a').keys()], ['b']); assert.equal(tree.get('a').get('b').size, 0);
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
    // PAX and GNU tar archives with long, Unicode and newline names, written by other tools, read the same.
    const odd = ['line\nbreak.txt', `${'ü'.repeat(70)}/${'名'.repeat(60)}.txt`, `${'long/'.repeat(40)}end.txt`];
    if (has('python3')) {
      for (const format of ['PAX_FORMAT', 'GNU_FORMAT']) {
        const out = join(dir, `py-${format}.tar`);
        execFileSync('python3', ['-c', `import tarfile,sys,io,json\nwith tarfile.open(sys.argv[1],'w',format=tarfile.${format}) as t:\n  for n in json.loads(sys.argv[2]):\n    i=tarfile.TarInfo(n);i.size=1;i.mtime=1700000000;t.addfile(i,io.BytesIO(b'x'))`, out, JSON.stringify(odd)]);
        assert.deepEqual(await tarNames(new Blob([readFileSync(out)])), odd, format);
      }
    }
    for (const [tool, args] of [['bsdtar', ['--format', 'pax']], ['tar', ['--format=pax']], ['tar', ['--format=gnu']]].filter(([t]) => has(t))) {
      const src = join(dir, `src-${args.join('')}`); const name = `${'ü'.repeat(70)}/${'名'.repeat(60)}.txt`;
      mkdirSync(join(src, 'ü'.repeat(70)), { recursive: true }); writeFileSync(join(src, name), 'x');
      execFileSync(tool, [...args, '-cf', join(src, '..', `${tool}${args.join('')}.tar`), '-C', src, name]);
      const names = await tarNames(new Blob([readFileSync(join(src, '..', `${tool}${args.join('')}.tar`))]));
      assert.ok(names.includes(name), `${tool} ${args.join(' ')}: ${JSON.stringify(names)}`);
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
