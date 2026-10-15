// Browser check for the Metadata Cleaner: runs offline, saves the cleaned files and re-inspects them.
// Assertions cover the formats this branch cleans (JPEG, PNG, plain text) and a file nothing can read, so
// they stay true as other formats become cleanable.
// Usage: BASE=http://host:port [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] node tests/browser-cleaner.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fx from './fixtures/build.js';
import { inspectFile, inspectImage } from '../site/tools/lib/metadata/index.js';
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE ?? 'http://127.0.0.1:4176';
const shots = process.env.SHOTS ?? 'test-results';
mkdirSync(shots, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'cleaner-'));
const exif = fx.tiff([[0x010f, 2, 'Canon'], [0x0112, 3, [6]]], { gps: [[0x0001, 2, 'N'], [0x0002, 5, fx.dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, fx.dms(97.74306)]] });
writeFileSync(`${dir}/photo.jpg`, fx.jpegWith(fx.exifSegment(exif), fx.segment(0xfe, Buffer.from('private note'))));
writeFileSync(`${dir}/prompt.png`, fx.pngWith(fx.tEXt('parameters', 'a secret prompt')));
// Binary garbage with no signature: no family claims it, so it must be refused, never altered.
writeFileSync(`${dir}/notes.pdf`, Uint8Array.from({ length: 600 }, (_, i) => (i * 2654435761) >>> 24 || 1).map((x, i) => (i % 5 ? x : 0)));
writeFileSync(`${dir}/hidden.txt`, 'Hello\u200b team\u202e, see you\u{E0041}\u{E0042} soon.\n');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 800 }]]) {
  const page = await browser.newPage({ viewport, acceptDownloads: true });
  const problems = [];
  // On production Cloudflare injects its bot-detection script and Web Analytics beacon. The CSP blocks both, which is the intent.
  const expected = (t) => process.env.ALLOW_CF_JSD && /Executing inline script violates the following Content Security Policy|static\.cloudflareinsights\.com\/beacon/.test(t);
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !expected(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/tools/metadata-cleaner/`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${shots}/cleaner-${label}-empty.png` });
  await page.context().setOffline(true);
  const requests = []; page.on('request', (r) => requests.push(r.url()));

  await page.setInputFiles('#file', ['photo.jpg', 'prompt.png', 'notes.pdf', 'hidden.txt'].map((f) => `${dir}/${f}`));
  await page.waitForFunction(() => document.querySelectorAll('.job').length === 4 && [...document.querySelectorAll('.job')].every((j) => ['done', 'error'].includes(j.dataset.state)), null, { timeout: 15000 });
  await page.screenshot({ path: `${shots}/cleaner-${label}-done.png`, fullPage: true });
  const states = await page.$$eval('.job', (jobs) => jobs.map((j) => j.dataset.state));
  assert.deepEqual(states, ['done', 'done', 'error', 'done']);
  assert.equal(await page.$eval('.job:nth-child(3) .state', (n) => n.textContent), 'Not cleaned');

  const saved = {};
  for (const name of ['photo.jpg', 'prompt.png', 'hidden.txt']) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click(`a.save[aria-label="Save cleaned ${name}"]`)]);
    assert.equal(download.suggestedFilename(), name.replace('.', '-clean.'));
    const path = join(dir, download.suggestedFilename()); await download.saveAs(path); saved[name] = readFileSync(path);
  }
  const photo = await inspectImage(saved['photo.jpg']);
  assert.deepEqual(photo.blocks.filter((b) => b.removable !== false).map((b) => b.kind), ['EXIF'], 'only the orientation EXIF remains');
  assert.equal(photo.sources.find((s) => s.name === 'EXIF GPS'), undefined);
  assert.equal(photo.sources.find((s) => s.name === 'EXIF IFD0').fields[0].value, 'Rotate 90 CW');
  assert.equal((await inspectImage(saved['prompt.png'])).cleanable.blocks, 0);
  assert.equal(saved['hidden.txt'].toString('utf8'), 'Hello team, see you soon.\n');
  assert.equal((await inspectFile(saved['hidden.txt'], 'hidden.txt')).cleanable.blocks, 0);

  // Options open and close, and the summary counts what is on.
  await page.click('#options summary');
  await page.check('[data-option=acceptChanges]');
  assert.equal(await page.textContent('#options-state'), '1 on');
  await page.screenshot({ path: `${shots}/cleaner-${label}-options.png`, fullPage: true });
  await page.uncheck('[data-option=acceptChanges]');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${shots}/cleaner-${label}-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  assert.deepEqual(requests.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:')), [], 'cleaning made network requests');
  assert.deepEqual(problems, [], 'console problems');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `horizontal overflow at ${label} width`);

  // The inspector's cleaner card opens the cleaner with the inspected image queued, then the stored copy is gone.
  await page.context().setOffline(false);
  await page.goto(`${base}/tools/image-inspector/`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', `${dir}/photo.jpg`);
  await page.waitForSelector('#cleaner:not([hidden])');
  await Promise.all([page.waitForURL(`${base}/tools/metadata-cleaner/`), page.click('#cleaner')]);
  await page.waitForFunction(() => document.querySelector('.job')?.dataset.state === 'done', null, { timeout: 15000 });
  assert.equal(await page.$eval('.job strong', (n) => n.textContent), 'photo.jpg');
  const leftover = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open('private-tools'); r.onsuccess = () => { const g = r.result.transaction('handoff').objectStore('handoff').count(); g.onsuccess = () => resolve(g.result); }; }));
  assert.equal(leftover, 0, 'handed-off file left in IndexedDB');
  assert.deepEqual(problems, [], 'console problems after handoff');
  await page.close();

  // A refusal that an option can lift offers a retry with that option. No cleaner refuses for these
  // reasons on its own here, so a stand-in worker refuses .docx files until acceptChanges is set.
  const retryPage = await browser.newPage({ viewport });
  await retryPage.addInitScript(() => {
    const Real = window.Worker;
    window.Worker = class extends Real {
      postMessage(message, ...rest) {
        if (message?.file?.name?.endsWith('.docx')) {
          const done = { id: message.id, ok: true, data: new Uint8Array([1]), removed: [{ kind: 'Tracked changes' }], kept: [], bytesBefore: 2, bytesAfter: 1, offer: message.options?.removeMacros ? [] : ['removeMacros'] };
          const reply = message.options?.acceptChanges ? done : { id: message.id, ok: false, reason: 'This document has tracked changes.', option: 'acceptChanges' };
          setTimeout(() => this.onmessage?.({ data: reply }), 10);
          return;
        }
        super.postMessage(message, ...rest);
      }
    };
  });
  await retryPage.goto(`${base}/tools/metadata-cleaner/`, { waitUntil: 'networkidle' });
  writeFileSync(`${dir}/report.docx`, 'not really a document');
  await retryPage.setInputFiles('#file', `${dir}/report.docx`);
  await retryPage.waitForSelector('.job .retry');
  assert.match(await retryPage.textContent('.job-body p'), /Turn on “Accept tracked changes in documents” to clean it\./);
  await retryPage.screenshot({ path: `${shots}/cleaner-${label}-retry.png`, fullPage: true });
  await retryPage.click('.job .retry');
  await retryPage.waitForFunction(() => document.querySelector('.job')?.dataset.state === 'done');
  assert.equal(await retryPage.getAttribute('.job .save', 'download'), 'report-clean.docx');
  // Kept macros are offered for removal with one more click.
  assert.match(await retryPage.textContent('.job .offer'), /Macros kept\. Enable “Remove macros” to strip them\./);
  await retryPage.screenshot({ path: `${shots}/cleaner-${label}-offer.png`, fullPage: true });
  await retryPage.click('.job .offer .link-button');
  await retryPage.waitForFunction(() => document.querySelector('.job')?.dataset.state === 'done' && !document.querySelector('.job .offer'));
  await retryPage.close();
  console.log(`${label}: ok`);
}
await browser.close();
