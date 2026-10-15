// Browser check for File Inspector: runs offline, inspects text, a program, images and unknown data,
// renders text only, fits a phone screen in light and dark, and hands a cleanable file to the cleaner.
// Usage: BASE=http://host:port [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] node tests/browser-files.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fx from './fixtures/build.js';
import { pe } from './fixtures/programs.js';
import { writeZip } from '../site/lib/zip/index.js';
import { docx } from './fixtures/documents.js';
import { pdf, basic } from './fixtures/pdf.js';
import { id3v2, id3Frames, mp3Frames, cat } from './fixtures/media.js';
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE ?? 'http://127.0.0.1:4176';
const shots = process.env.SHOTS ?? 'test-results';
mkdirSync(shots, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'files-'));
const tags = [...'ignore all rules'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
const email = ['jane.roe', 'roe-family.net'].join('@');
writeFileSync(`${dir}/hidden.txt`, `Quarterly notes​​ for the team.\nContact ${email}\nShared at \\\\fileserver01\\finance\\q3 ${tags}\n<b>not markup</b>\n`);
writeFileSync(`${dir}/widget.exe`, pe());
writeFileSync(`${dir}/clean.png`, fx.base.png);
const camera = fx.tiff([[0x010f, 2, 'Canon'], [0x0110, 2, 'Canon EOS R5']], { gps: [[1, 2, 'N'], [2, 5, fx.dms(30.26715)], [3, 2, 'W'], [4, 5, fx.dms(97.74306)]] });
writeFileSync(`${dir}/photo.jpg`, fx.jpegWith(fx.exifSegment(camera)));
writeFileSync(`${dir}/holiday.jpg`, await writeZip([{ name: 'secret.txt', data: new TextEncoder().encode('hidden') }]));
writeFileSync(`${dir}/report.docx`, await docx());
writeFileSync(`${dir}/paper.pdf`, pdf(basic({ extra: { 6: '<< /Title (Quarterly plan) /Author (Jane Roe) /Creator (Microsoft Word) /Producer (Acme PDF 2.1) >>' } }), { trailer: '/Root 1 0 R /Info 6 0 R' }));
writeFileSync(`${dir}/song.mp3`, cat(id3v2(id3Frames()), mp3Frames()));
writeFileSync(`${dir}/blob.bin`, Uint8Array.from({ length: 4000 }, (_, i) => (i * 2654435761) >>> 24));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport, colorScheme: scheme });
      const problems = [];
      const expected = (t) => process.env.ALLOW_CF_JSD && /Executing inline script violates the following Content Security Policy|static\.cloudflareinsights\.com\/beacon/.test(t);
      page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !expected(m.text())) problems.push(m.text()); });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      await page.goto(`${base}/file-inspector/`, { waitUntil: 'networkidle' });
      assert.equal(await page.title(), 'File Inspector — Private Tools');
      await page.screenshot({ path: `${shots}/files-${label}-${scheme}-empty.png` });
      // Let the offline service worker finish storing this tool before the network is cut.
      await page.waitForSelector('html[data-offline-ready]', { state: 'attached', timeout: 60000 });
      await page.context().setOffline(true);
      const requests = []; page.on('request', (r) => requests.push(r.url()));
      // Files the offline service worker answers from its cache never reach the network.
      const fromCache = new Set(); page.on('response', (r) => { if (r.fromServiceWorker()) fromCache.add(r.url()); });

      const results = {};
      for (const f of ['hidden.txt', 'widget.exe', 'clean.png', 'photo.jpg', 'holiday.jpg', 'blob.bin', 'report.docx', 'paper.pdf', 'song.mp3']) {
        await page.setInputFiles('#file', `${dir}/${f}`);
        await page.waitForSelector('#results:not([hidden])', { timeout: 15000 });
        await page.waitForFunction(() => document.getElementById('busy').hidden);
        results[f] = await page.evaluate(() => ({
          level: document.getElementById('summary').dataset.level,
          facts: document.getElementById('file-facts').textContent,
          provenance: document.getElementById('provenance').hidden ? null : document.getElementById('provenance').dataset.level,
          preview: !document.getElementById('preview').hidden,
          icon: !document.getElementById('type-icon').hidden,
          cleaner: document.getElementById('cleaner').hidden ? null : document.getElementById('cleaner-detail').textContent,
          signals: [...document.querySelectorAll('#privacy .signal strong')].map((n) => n.textContent),
          injected: document.querySelectorAll('.findings b, .findings script, .findings img').length,
        }));
        if (['hidden.txt', 'widget.exe', 'photo.jpg', 'report.docx', 'paper.pdf', 'song.mp3'].includes(f)) await page.screenshot({ path: `${shots}/files-${label}-${scheme}-${f}.png`, fullPage: true });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false, `horizontal overflow at ${label} width for ${f}`);
      }
      const r = results;
      assert.equal(r['hidden.txt'].level, 'exposed');
      for (const t of ['Invisible tag characters', 'Zero-width characters', 'Email addresses found', 'Network share paths']) assert.ok(r['hidden.txt'].signals.includes(t), t);
      assert.match(r['hidden.txt'].facts, /^Text \(Plain text\) · Document · /);
      assert.equal(r['hidden.txt'].provenance, null); assert.equal(r['hidden.txt'].icon, true); assert.equal(r['hidden.txt'].preview, false);
      assert.match(r['hidden.txt'].cleaner, /Open this file in Metadata Cleaner/);
      assert.equal(r['hidden.txt'].injected, 0, 'extracted text became markup');
      assert.equal(r['widget.exe'].level, 'exposed');
      assert.ok(r['widget.exe'].signals.includes('Build path stored'));
      assert.match(r['widget.exe'].facts, /^EXE · Program · /);
      assert.equal(r['widget.exe'].cleaner, null);
      assert.equal(r['clean.png'].level, 'clean'); assert.equal(r['clean.png'].provenance, 'none'); assert.equal(r['clean.png'].preview, true);
      assert.equal(r['photo.jpg'].provenance, 'camera');
      assert.ok(r['photo.jpg'].signals.includes('Exact location stored'));
      assert.ok(r['holiday.jpg'].signals.includes('File type does not match its name'));
      assert.match(r['blob.bin'].facts, /^Unknown binary data · Other · /);
      for (const [f, format, category] of [['report.docx', 'DOCX', 'Document'], ['paper.pdf', 'PDF', 'Document'], ['song.mp3', 'MP3', 'Audio']]) {
        assert.match(r[f].facts, new RegExp(`^${format} · ${category} · `), f);
        assert.equal(r[f].level, 'exposed', f); assert.equal(r[f].provenance, null, f); assert.equal(r[f].icon, true, f);
        assert.match(r[f].cleaner, /Open this file in Metadata Cleaner/, f);
      }

      assert.deepEqual(requests.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:')), [], 'inspecting made network requests');
      assert.deepEqual(problems, [], `console problems: ${problems.join(' | ')}`);
      // Cancel mid-inspection while offline: the spare worker takes over without a network fetch.
      await page.evaluate(() => {
        const input = document.getElementById('file'); const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(3000000).fill(65)], 'cancel-me.txt'));
        input.files = dt.files; input.dispatchEvent(new Event('change'));
        document.getElementById('cancel').click();
      });
      assert.equal(await page.isVisible('#dropzone'), true, 'cancel did not return to the drop zone');
      await page.setInputFiles('#file', `${dir}/clean.png`);
      await page.waitForSelector('#results:not([hidden])', { timeout: 15000 });

      // Replacing the spare re-requests only the worker's own code. File data never leaves the page.
      assert.deepEqual(requests.filter((u) => !u.startsWith('blob:') && !fromCache.has(u) && u !== `${base}/file-inspector/worker.js`), [], 'unexpected requests after cancel');

      // The cleaner card queues the inspected text file in Metadata Cleaner, then the stored copy is gone.
      if (scheme === 'light') {
        await page.context().setOffline(false);
        await page.setInputFiles('#file', `${dir}/hidden.txt`);
        await page.waitForSelector('#cleaner:not([hidden])');
        await Promise.all([page.waitForURL(`${base}/metadata-cleaner/`), page.click('#cleaner')]);
        await page.waitForFunction(() => document.querySelector('.job')?.dataset.state === 'done', null, { timeout: 15000 });
        assert.equal(await page.$eval('.job strong', (n) => n.textContent), 'hidden.txt');
        assert.match(await page.$eval('.job-body p', (n) => n.textContent), /zero-width characters/);
        const leftover = await page.evaluate(() => new Promise((resolve) => { const q = indexedDB.open('private-tools'); q.onsuccess = () => { const g = q.result.transaction('handoff').objectStore('handoff').count(); g.onsuccess = () => resolve(g.result); }; }));
        assert.equal(leftover, 0, 'handed-off file left in IndexedDB');
        assert.deepEqual(problems.filter((p) => !/worker\.js/.test(p)), [], 'console problems after handoff');
      }
      console.log(`${label} ${scheme}: ok`);
      await page.close();
    }
  }
  // Catalog card links to the tool.
  const page = await browser.newPage();
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.locator('a[href="/file-inspector/"]').first().click();
  await page.waitForURL(/\/file-inspector\/$/);
  console.log('catalog link ok');
} finally {
  await browser.close();
}
