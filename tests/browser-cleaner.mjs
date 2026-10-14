// Browser check for the Metadata Cleaner: runs offline, saves the cleaned files and re-inspects them.
// Usage: BASE=http://host:port [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] node tests/browser-cleaner.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fx from './fixtures/build.js';
import { inspectImage } from '../site/tools/lib/metadata/index.js';
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE ?? 'http://127.0.0.1:4176';
const shots = process.env.SHOTS ?? 'test-results';
mkdirSync(shots, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'cleaner-'));
const exif = fx.tiff([[0x010f, 2, 'Canon'], [0x0112, 3, [6]]], { gps: [[0x0001, 2, 'N'], [0x0002, 5, fx.dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, fx.dms(97.74306)]] });
writeFileSync(`${dir}/photo.jpg`, fx.jpegWith(fx.exifSegment(exif), fx.segment(0xfe, Buffer.from('private note'))));
writeFileSync(`${dir}/prompt.png`, fx.pngWith(fx.tEXt('parameters', 'a secret prompt')));
writeFileSync(`${dir}/notes.pdf`, '%PDF-1.4 not an image');
writeFileSync(`${dir}/scan.tif`, readFileSync(new URL('./fixtures/formats/pii.tif', import.meta.url)));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 800 }]]) {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/tools/metadata-cleaner/`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${shots}/cleaner-${label}-empty.png` });
  await page.context().setOffline(true);
  const requests = []; page.on('request', (r) => requests.push(r.url()));

  await page.setInputFiles('#file', ['photo.jpg', 'prompt.png', 'notes.pdf', 'scan.tif'].map((f) => `${dir}/${f}`));
  await page.waitForFunction(() => document.querySelectorAll('.job').length === 4 && [...document.querySelectorAll('.job')].every((j) => ['done', 'error'].includes(j.dataset.state)), null, { timeout: 15000 });
  await page.screenshot({ path: `${shots}/cleaner-${label}-done.png`, fullPage: true });
  const states = await page.$$eval('.job', (jobs) => jobs.map((j) => j.dataset.state));
  assert.deepEqual(states, ['done', 'done', 'error', 'error']);

  const saved = {};
  for (const name of ['photo.jpg', 'prompt.png']) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click(`a.save[aria-label="Save cleaned ${name}"]`)]);
    assert.equal(download.suggestedFilename(), name.replace('.', '-clean.'));
    const path = join(dir, download.suggestedFilename()); await download.saveAs(path); saved[name] = readFileSync(path);
  }
  const photo = await inspectImage(saved['photo.jpg']);
  assert.deepEqual(photo.blocks.filter((b) => b.removable !== false).map((b) => b.kind), ['EXIF'], 'only the orientation EXIF remains');
  assert.equal(photo.sources.find((s) => s.name === 'EXIF GPS'), undefined);
  assert.equal(photo.sources.find((s) => s.name === 'EXIF IFD0').fields[0].value, 'Rotate 90 CW');
  assert.equal((await inspectImage(saved['prompt.png'])).cleanable.blocks, 0);
  assert.deepEqual(requests.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:')), [], 'cleaning made network requests');
  assert.deepEqual(problems, [], 'console problems');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `horizontal overflow at ${label} width`);
  console.log(`${label}: ok`);
  await page.close();
}
await browser.close();
