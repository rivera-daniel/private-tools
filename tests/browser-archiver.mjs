// Browser check for the Archiver: creates archives offline, downloads and verifies them, opens archives,
// unlocks AES, extracts to a folder and to downloads, and checks hostile archives, layout and console.
// Usage: BASE=http://host:port [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] node tests/browser-archiver.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fx from './fixtures/build.js';
import { readZip, readEntry } from '../site/tools/lib/zip/index.js';
import { openZipBlob, zipEntryChunks } from '../site/tools/lib/zip/stream.js';
import { tarStream } from '../site/tools/lib/archive/tar.js';
import { createArchive } from '../site/tools/lib/archive/index.js';
import { MemorySink, collect } from '../site/tools/lib/archive/streams.js';
import { inspectImage } from '../site/tools/lib/metadata/index.js';
import { LIBARCHIVE_SAMPLES } from './fixtures/archive.js';
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE ?? 'http://127.0.0.1:4176';
const shots = process.env.SHOTS ?? 'test-results';
mkdirSync(shots, { recursive: true });
const dec = new TextDecoder(); const enc = new TextEncoder();
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

const dir = mkdtempSync(join(tmpdir(), 'archiver-'));
const exif = fx.tiff([[0x010f, 2, 'Canon'], [0x0112, 3, [1]]], { gps: [[0x0001, 2, 'N'], [0x0002, 5, fx.dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, fx.dms(97.74306)]] });
writeFileSync(`${dir}/photo.jpg`, fx.jpegWith(fx.exifSegment(exif)));
writeFileSync(`${dir}/notes.txt`, 'meeting notes '.repeat(500));
writeFileSync(`${dir}/data.csv`, 'a,b,c\n'.repeat(200));
mkdirSync(`${dir}/folder/sub`, { recursive: true });
writeFileSync(`${dir}/folder/one.txt`, 'one');
writeFileSync(`${dir}/folder/sub/two.txt`, 'two');

const file = (name, data) => new File([data], name);
const tgz = await createArchive({ items: [{ file: file('a.txt', 'alpha '.repeat(100)), path: 'pkg/a.txt' }, { file: file('b.txt', 'bravo'), path: 'pkg/docs/b.txt' }], format: 'tar.gz', sink: new MemorySink(), clean: false });
writeFileSync(`${dir}/bundle.tar.gz`, new Uint8Array(await tgz.result.arrayBuffer()));
writeFileSync(`${dir}/hostile.tar`, await collect(tarStream([
  { name: '../escape.txt', size: 4, source: [enc.encode('evil')], mtime: 0 },
  { name: 'safe.txt', size: 4, source: [enc.encode('safe')], mtime: 0 },
])));

// Formats read through libarchive. 7z and tar.xz come from the 7z/7zz, bsdtar or xz tools when installed;
// encrypted 7z and RAR come from libarchive's own test archives.
const sevenZip = ['7zz', '7z'].find(has);
const tool = (cmd, args) => cmd && spawnSync(cmd, args, { cwd: dir }).status === 0;
const have7z = tool(sevenZip, ['a', '-bso0', 'files.7z', 'notes.txt', 'folder']) || tool(has('bsdtar') && 'bsdtar', ['--format', '7zip', '-cf', 'files.7z', 'notes.txt', 'folder']);
const plainTar = await collect(tarStream([{ name: 'xz/inside.txt', size: 9, source: [enc.encode('xz inside')], mtime: 0 }]));
writeFileSync(`${dir}/plain.tar`, plainTar);
const haveXz = tool(has('xz') && 'xz', ['-kf', 'plain.tar']);
// A tar.xz whose only header claims 50 GB: listing must stop with the bomb message, not decompress.
const bomb = (await collect(tarStream([{ name: 'huge.bin', size: 4, source: [enc.encode('tiny')], mtime: 0 }]))).slice();
bomb.set(enc.encode(`${(50 * 2 ** 30).toString(8).padStart(11, '0')}\0`), 124);
let bombSum = 0; for (let i = 0; i < 512; i++) bombSum += i >= 148 && i < 156 ? 32 : bomb[i];
bomb.set(enc.encode(`${bombSum.toString(8).padStart(6, '0')}\0 `), 148);
writeFileSync(`${dir}/bomb.tar`, bomb);
const haveBomb = tool(has('xz') && 'xz', ['-kf', 'bomb.tar']);
for (const [name, bytes] of Object.entries(LIBARCHIVE_SAMPLES)) writeFileSync(`${dir}/${name}`, bytes);
if (!have7z || !haveXz) console.log(`skipping ${[!have7z && '7z', !haveXz && 'tar.xz'].filter(Boolean).join(' and ')} fixtures: no tool installed`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 800 }]]) {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  const problems = [];
  const expected = (t) => process.env.ALLOW_CF_JSD && /Executing inline script violates the following Content Security Policy|static\.cloudflareinsights\.com\/beacon/.test(t);
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !expected(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const loaded = []; page.on('request', (r) => loaded.push(r.url()));
  await page.goto(`${base}/tools/archiver/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  // Everything, the WebAssembly archive reader included, comes from this origin.
  assert.deepEqual(loaded.filter((u) => !u.startsWith(base)), [], 'requests to other origins');
  assert.ok(loaded.includes(`${base}/tools/vendor/libarchive/libarchive.wasm`), 'libarchive preloaded');
  await page.screenshot({ path: `${shots}/archiver-${label}-empty.png` });
  await page.context().setOffline(true);
  const requests = []; page.on('request', (r) => requests.push(r.url()));
  const save = async (click) => { const [d] = await Promise.all([page.waitForEvent('download'), click()]); const p = join(dir, `${label}-${d.suggestedFilename()}`); await d.saveAs(p); return { name: d.suggestedFilename(), bytes: readFileSync(p), path: p }; };

  // Create a ZIP from files and a folder with hidden data removed.
  await page.setInputFiles('#create-files', ['photo.jpg', 'notes.txt', 'data.csv'].map((f) => `${dir}/${f}`));
  await page.setInputFiles('#create-folder', `${dir}/folder`);
  await page.waitForSelector('#create-panel:not([hidden])');
  const rows = await page.$$eval('#create-list tr', (trs) => trs.map((t) => t.querySelector('.name span').textContent));
  assert.deepEqual(rows, ['data.csv', 'folder/one.txt', 'folder/sub/two.txt', 'notes.txt', 'photo.jpg']);
  await page.screenshot({ path: `${shots}/archiver-${label}-create.png`, fullPage: true });
  await page.click('#create-run');
  await page.waitForSelector('#create-result:not([hidden])', { timeout: 20000 });
  await page.screenshot({ path: `${shots}/archiver-${label}-created.png`, fullPage: true });
  const plain = await save(() => page.click('#result-save'));
  assert.equal(plain.name, 'archive.zip');
  const zip = readZip(plain.bytes);
  assert.deepEqual(zip.entries.map((e) => e.name), ['data.csv', 'folder/one.txt', 'folder/sub/two.txt', 'notes.txt', 'photo.jpg']);
  assert.equal(dec.decode(await readEntry(zip, zip.entries[2])), 'two');
  assert.ok(zip.entries.every((e) => e.modified.toISOString() === '1980-01-01T00:00:00.000Z' && !e.extra.length));
  const photo = await inspectImage(await readEntry(zip, zip.entries[4]));
  assert.equal(photo.sources.find((s) => s.name === 'EXIF GPS'), undefined, 'GPS removed from the photo');
  assert.equal(zip.entries[4].method, 0, 'JPEG stored, not deflated'); assert.equal(zip.entries[3].method, 8);
  assert.match(await page.textContent('#result-report'), /Hidden data removed from 1 file/);

  // The same files as an AES-256 ZIP.
  await page.click('#result-back');
  await page.fill('#password', 'browser secret');
  await page.fill('#archive-name', 'locked');
  await page.click('#create-run');
  await page.waitForSelector('#create-result:not([hidden])', { timeout: 20000 });
  const locked = await save(() => page.click('#result-save'));
  assert.equal(locked.name, 'locked.zip');
  const lz = await openZipBlob(new Blob([locked.bytes]));
  assert.ok(lz.entries.every((e) => e.method === 99 && e.aes.strength === 3));
  assert.equal(dec.decode(await collect(zipEntryChunks(new Blob([locked.bytes]), lz.entries[1], { password: 'browser secret' }))), 'one');
  if (has('bsdtar')) assert.equal(spawnSync('bsdtar', ['-xOf', locked.path, '--passphrase', 'browser secret', 'folder/sub/two.txt']).stdout.toString(), 'two');

  // tar.gz with original dates.
  await page.click('#result-back');
  await page.fill('#password', '');
  await page.click('#format label:has(input[value="tar.gz"]) span');
  await page.uncheck('#hide-dates');
  await page.click('#create-run');
  await page.waitForSelector('#create-result:not([hidden])', { timeout: 20000 });
  const tarball = await save(() => page.click('#result-save'));
  assert.equal(tarball.name, 'locked.tar.gz');
  if (has('tar')) assert.match(spawnSync('tar', ['-tzf', tarball.path]).stdout.toString(), /folder\/sub\/two\.txt/);

  // Open the AES ZIP: wrong password, right password, save one file, inspect another.
  await page.click('#tab-open');
  await page.setInputFiles('#open-file', locked.path);
  await page.waitForSelector('#open-panel:not([hidden])');
  assert.equal(await page.isVisible('#unlock'), true);
  await page.fill('#unlock-password', 'wrong');
  await page.click('#unlock button[type=submit]');
  await page.waitForSelector('#unlock[data-state=wrong]');
  await page.fill('#unlock-password', 'browser secret');
  await page.click('#unlock button[type=submit]');
  await page.waitForSelector('#unlock', { state: 'hidden' });
  await page.screenshot({ path: `${shots}/archiver-${label}-open.png`, fullPage: true });
  const one = await save(() => page.click('button[aria-label="Save folder/sub/two.txt"]'));
  assert.equal(one.name, 'two.txt'); assert.equal(one.bytes.toString(), 'two');

  // Download selected entries as a plain ZIP.
  await page.click('#select-all'); // none
  await page.check('input[aria-label="Select notes.txt"]');
  await page.check('input[aria-label="Select data.csv"]');
  const repacked = await save(() => page.click('#extract-zip'));
  const rz = readZip(repacked.bytes);
  assert.deepEqual(rz.entries.map((e) => e.name), ['data.csv', 'notes.txt']);
  assert.equal(rz.entries.some((e) => e.encrypted), false);

  // tar.gz to a folder (the folder picker is answered with the origin's private file system).
  await page.click('#open-another');
  await page.setInputFiles('#open-file', `${dir}/bundle.tar.gz`);
  await page.waitForSelector('#open-panel:not([hidden])');
  assert.match(await page.textContent('#archive-facts'), /tar\.gz archive · 2 files/);
  await page.evaluate(() => { window.showDirectoryPicker = async () => { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle('out', { create: true }); }; });
  await page.click('#extract-folder');
  await page.waitForSelector('#open-done:not([hidden])');
  assert.match(await page.textContent('#open-done'), /Extracted 2 files to out/);
  const written = await page.evaluate(async () => {
    const out = await (await navigator.storage.getDirectory()).getDirectoryHandle('out');
    const pkg = await out.getDirectoryHandle('pkg'); const docs = await pkg.getDirectoryHandle('docs');
    const text = async (d, n) => (await (await d.getFileHandle(n)).getFile()).text();
    const result = [await text(pkg, 'a.txt'), await text(docs, 'b.txt')];
    await (await navigator.storage.getDirectory()).removeEntry('out', { recursive: true });
    return result;
  });
  assert.deepEqual(written, ['alpha '.repeat(100), 'bravo']);

  // A tar that tries to escape the folder: the entry is listed, blocked and never extracted.
  await page.click('#open-another');
  await page.setInputFiles('#open-file', `${dir}/hostile.tar`);
  await page.waitForSelector('#open-panel:not([hidden])');
  assert.match(await page.textContent('#open-warnings'), /outside the chosen folder/);
  assert.equal(await page.$('input[aria-label="Select ../escape.txt"]'), null);
  assert.match(await page.textContent('#open-list tr.blocked'), /Blocked/);
  await page.screenshot({ path: `${shots}/archiver-${label}-hostile.png`, fullPage: true });

  // 7z, tar.xz, encrypted 7z (data, and data plus names), RAR 5, all through libarchive.
  const openAndWait = async (path) => { await page.click('#open-another').catch(() => {}); await page.setInputFiles('#open-file', path); await page.waitForSelector('#open-panel:not([hidden]), #open-error:not([hidden])'); assert.equal(await page.isVisible('#open-error'), false, await page.textContent('#open-error')); };
  if (have7z) {
    await openAndWait(`${dir}/files.7z`);
    assert.match(await page.textContent('#archive-facts'), /^7z archive · 3 files/);
    const two = await save(() => page.click('button[aria-label="Save folder/sub/two.txt"]'));
    assert.equal(two.bytes.toString(), 'two');
    await page.screenshot({ path: `${shots}/archiver-${label}-7z.png`, fullPage: true });
  }
  if (haveXz) {
    await openAndWait(`${dir}/plain.tar.xz`);
    assert.match(await page.textContent('#archive-facts'), /^tar\.xz archive · 1 file/);
    const inside = await save(() => page.click('button[aria-label="Save xz/inside.txt"]'));
    assert.equal(inside.bytes.toString(), 'xz inside');
  }
  if (haveBomb) {
    await page.click('#open-another').catch(() => {});
    await page.setInputFiles('#open-file', `${dir}/bomb.tar.xz`);
    await page.waitForSelector('#open-error:not([hidden])', { timeout: 10000 });
    assert.match(await page.textContent('#open-error'), /zip bombs/);
  }
  await openAndWait(`${dir}/sevenZipEncrypted`);
  assert.match(await page.textContent('#archive-facts'), /7z archive · 1 file .* AES encrypted/);
  await page.fill('#unlock-password', 'not it'); await page.click('#unlock button[type=submit]');
  await page.waitForSelector('#unlock[data-state=wrong]');
  await page.fill('#unlock-password', '12345678'); await page.click('#unlock button[type=submit]');
  await page.waitForSelector('#unlock', { state: 'hidden' });
  assert.equal((await save(() => page.click('button[aria-label="Save bar.txt"]'))).bytes.toString(), 'foo\n');
  await page.click('#open-another'); await page.setInputFiles('#open-file', `${dir}/sevenZipEncryptedHeader`);
  await page.waitForSelector('#unlock:not([hidden])');
  assert.match(await page.textContent('#archive-facts'), /file names are hidden/);
  await page.screenshot({ path: `${shots}/archiver-${label}-7z-locked.png` });
  await page.fill('#unlock-password', '12345678'); await page.click('#unlock button[type=submit]');
  await page.waitForSelector('#list-card:not([hidden])');
  assert.equal((await save(() => page.click('button[aria-label="Save bar.txt"]'))).bytes.toString(), 'foo\n');
  await openAndWait(`${dir}/rar5`);
  assert.match(await page.textContent('#archive-facts'), /^RAR 5 archive/);
  assert.equal((await save(() => page.click('button[aria-label="Save helloworld.txt"]'))).bytes.toString(), 'hello libarchive test suite!\n');
  await openAndWait(`${dir}/rar4`);
  assert.match(await page.textContent('#open-warnings'), /1 link/);

  // Create a 7z archive.
  await page.click('#tab-create');
  await page.click('#result-new');
  await page.setInputFiles('#create-files', ['notes.txt', 'data.csv'].map((f) => `${dir}/${f}`));
  await page.click('#format label:has(input[value="7z"]) span');
  assert.equal(await page.isDisabled('#password'), true);
  await page.click('#create-run');
  await page.waitForSelector('#create-result:not([hidden])', { timeout: 20000 });
  const made = await save(() => page.click('#result-save'));
  assert.equal(made.name, 'archive.7z');
  assert.deepEqual([...made.bytes.subarray(0, 6)], [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  if (has('bsdtar')) assert.equal(spawnSync('bsdtar', ['-xOf', made.path, 'data.csv']).stdout.toString(), 'a,b,c\n'.repeat(200));
  if (sevenZip) assert.match(spawnSync(sevenZip, ['t', made.path]).stdout.toString(), /Everything is Ok/);
  await page.click('#tab-open');

  // Inspect contents of the plain ZIP's photo, then hand it to the File Inspector.
  await page.click('#open-another');
  await page.setInputFiles('#open-file', plain.path);
  await page.waitForSelector('#open-panel:not([hidden])');
  await page.click('button[aria-label="Inspect photo.jpg"]');
  await page.waitForSelector('#inspect-dialog[open]');
  assert.match(await page.textContent('#inspect-format'), /JPEG/);
  await page.screenshot({ path: `${shots}/archiver-${label}-inspect.png` });

  assert.deepEqual(requests.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:')), [], 'the archiver made network requests');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `horizontal overflow at ${label} width`);
  assert.deepEqual(problems, [], 'console problems');

  await page.context().setOffline(false);
  // The File Inspector is its own page; a stand-in answers here so only the handoff is tested.
  await page.route(`${base}/tools/file-inspector/`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>File Inspector</title>' }));
  await Promise.all([page.waitForURL(`${base}/tools/file-inspector/#from-inspector`), page.click('#inspect-open')]);
  await page.unroute(`${base}/tools/file-inspector/`);
  // The stored copy is encrypted; read it the way the File Inspector does.
  const handed = await page.evaluate(async () => (await (await import('/tools/lib/handoff.js')).takeFile())?.name ?? null);
  assert.equal(handed, 'photo.jpg', 'photo handed to the File Inspector');

  // Dark theme screenshots.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${base}/tools/archiver/`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#create-files', ['photo.jpg', 'notes.txt'].map((f) => `${dir}/${f}`));
  await page.waitForSelector('#create-panel:not([hidden])');
  await page.screenshot({ path: `${shots}/archiver-${label}-dark-create.png`, fullPage: true });
  await page.click('#tab-open');
  await page.setInputFiles('#open-file', locked.path);
  await page.waitForSelector('#open-panel:not([hidden])');
  await page.screenshot({ path: `${shots}/archiver-${label}-dark-open.png`, fullPage: true });
  console.log(`${label}: ok`);
  await page.close();
}
await browser.close();
