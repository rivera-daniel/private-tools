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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 800 }]]) {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  const problems = [];
  const expected = (t) => process.env.ALLOW_CF_JSD && /Executing inline script violates the following Content Security Policy|static\.cloudflareinsights\.com\/beacon/.test(t);
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !expected(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/tools/archiver/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
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
  await Promise.all([page.waitForURL(`${base}/tools/file-inspector/#from-inspector`), page.click('#inspect-open')]);
  const handed = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open('private-tools'); r.onsuccess = () => { const g = r.result.transaction('handoff').objectStore('handoff').get('file'); g.onsuccess = () => resolve(g.result?.file?.name ?? null); }; }));
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
