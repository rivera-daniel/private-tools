// Browser check for the PDF Editor: the page and its MuPDF worker load from this origin only, PDFs open,
// pages reorder by keyboard and by dragging, merged output saves with the right pages, passwords work both
// ways, the other modes produce what they promise, signing with a .p12 saves a valid signature, a 200-page file stays responsive, and the layout holds
// at 390 px in light and dark.
// Usage: BASE=http://host:port [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] node tests/browser-pdf-editor.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from '../site/vendor/mupdf/mupdf.js';
import { protectPdf } from '../site/lib/pdf-editor/index.js';
import { readZip } from '../site/lib/zip/index.js';
import { inspectFile } from '../site/lib/metadata/index.js';
import { textPdf, orientedJpeg, photoPdf } from './fixtures/pdf-editor.js';
import { pdf as rawPdf, basic, stream } from './fixtures/pdf.js';
import { jpegWith, exifSegment, tiff } from './fixtures/build.js';
import { makeIdentity, pem } from './fixtures/pdf-sign.js';
import { verifyPdf } from '../site/lib/pdf-editor/sign.js';
import { spawnSync } from 'node:child_process';
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE ?? 'http://127.0.0.1:4176';
const shots = process.env.SHOTS ?? 'test-results';
mkdirSync(shots, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'pdf-editor-'));
writeFileSync(`${dir}/alpha.pdf`, textPdf(3, 'Alpha', { info: { Author: 'Jane Roe' } }));
writeFileSync(`${dir}/bravo.pdf`, textPdf(2, 'Bravo', { size: [792, 612], info: { Author: 'John Roe' } }));
writeFileSync(`${dir}/big.pdf`, textPdf(200, 'Big'));
writeFileSync(`${dir}/locked.pdf`, protectPdf(textPdf(2, 'Locked'), { userPassword: 'letmein' }));
writeFileSync(`${dir}/photo.jpg`, orientedJpeg(6, 80, 60));
writeFileSync(`${dir}/photos.pdf`, photoPdf(1600, 1200));
// A photo whose EXIF the cleaner can read but not rewrite safely (the JPEG is cut short): it is kept.
const truncated = jpegWith(exifSegment(tiff([[0x010f, 2, 'SECRET-OWNER']]))).subarray(0, -50);
writeFileSync(`${dir}/retained.pdf`, rawPdf(basic({ resources: '/XObject << /Im 8 0 R >>', content: 'q 100 0 0 100 0 0 cm /Im Do Q', extra: { 8: stream('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', truncated) } }), { trailer: '/Root 1 0 R' }));
// A tiny file whose page claims to be 100,000 points square.
writeFileSync(`${dir}/huge.pdf`, textPdf(1, 'Huge', { size: [100000, 100000] }));

// A test signing certificate in a .p12 file, made with openssl at run time.
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
let p12 = null;
if (has('openssl')) {
  const id = await makeIdentity('rsa', { cn: 'Editor Test Signer' });
  writeFileSync(`${dir}/key.pem`, pem('PRIVATE KEY', id.key.pkcs8)); writeFileSync(`${dir}/leaf.pem`, pem('CERTIFICATE', id.leaf.der)); writeFileSync(`${dir}/ca.pem`, pem('CERTIFICATE', id.ca.der));
  const r = spawnSync('openssl', ['pkcs12', '-export', '-inkey', `${dir}/key.pem`, '-in', `${dir}/leaf.pem`, '-certfile', `${dir}/ca.pem`, '-out', `${dir}/signer.p12`, '-passout', 'pass:sign-test']);
  if (r.status === 0) p12 = `${dir}/signer.p12`;
}
if (!p12) console.log('skipping the signing checks: openssl is needed to build the test certificate file');
const pdfsig = (path) => (has('pdfsig') ? spawnSync('pdfsig', [path], { encoding: 'utf8' }).stdout : null);

const open = (bytes, password) => { const d = mupdf.Document.openDocument(bytes, 'application/pdf'); if (password) d.authenticatePassword(password); return d; };
function texts(bytes, password) {
  const d = open(bytes, password); const out = [];
  for (let i = 0; i < d.countPages(); i++) { const p = d.loadPage(i); out.push(p.toStructuredText().asText().trim().replace(/\s+/g, ' ')); p.destroy(); }
  return out;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  // Until the redaction module ships, opening Redact asks for it and gets a 404.
  const expected = (t) => /redact-ui\.js/.test(t) || (/Failed to load resource/.test(t) && redactAsked) || (process.env.ALLOW_CF_JSD && /Executing inline script violates the following Content Security Policy|static\.cloudflareinsights\.com\/beacon/.test(t));
  let redactAsked = false;
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !expected(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/redact-ui\.js$/.test(r.url())) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  let inflight = 0; page.on('request', () => inflight++); page.on('requestfinished', () => inflight--); page.on('requestfailed', () => inflight--);
  page.on('requestfailed', (r) => { if (!/redact-ui\.js$/.test(r.url())) problems.push(`request failed: ${r.url()}`); });
  const loaded = []; context.on('request', (r) => loaded.push(r.url()));
  await page.goto(`${base}/pdf-editor/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => performance.getEntriesByType('resource').length > 0);
  await page.waitForTimeout(500);
  assert.deepEqual(loaded.filter((u) => !u.startsWith(base)), [], 'requests to other origins');
  assert.ok(loaded.includes(`${base}/pdf-editor/worker.js`), 'worker loaded');
  assert.ok(loaded.includes(`${base}/vendor/mupdf/mupdf-wasm.wasm`), 'MuPDF loaded');
  assert.equal(await page.title(), 'PDF Editor — Private Tools');
  await page.screenshot({ path: `${shots}/pdf-editor-${label}-empty.png`, fullPage: label === 'mobile' });

  const save = async (click) => { const [d] = await Promise.all([page.waitForEvent('download'), click()]); const p = join(dir, `${label}-${d.suggestedFilename()}`); await d.saveAs(p); return { name: d.suggestedFilename(), bytes: readFileSync(p) }; };
  // The live region is cleared and refilled on the next frame, so wait for the text instead of reading it at once.
  const announced = (pattern) => page.waitForFunction(([source, flags]) => new RegExp(source, flags).test(document.getElementById('announce').textContent), [pattern.source, pattern.flags], { timeout: 5000 });
  const labels = () => page.$$eval('#pages li.page', (lis) => lis.map((li) => li.getAttribute('aria-label')));
  const drawn = () => page.$$eval('#pages li.page', (lis) => lis.filter((li) => li.dataset.drawn?.startsWith('b')).length);

  // Open two PDFs: their pages are merged in one grid with a file badge each.
  await page.setInputFiles('#file', [`${dir}/alpha.pdf`, `${dir}/bravo.pdf`]);
  await page.waitForFunction(() => document.querySelectorAll('#pages li.page').length === 5);
  // A new document opens in View; the page grid is one click away.
  await page.waitForSelector('#view-panel .vw-page');
  assert.equal(await page.getAttribute('#tab-view', 'aria-selected'), 'true');
  await page.click('#tab-organize');
  await page.waitForFunction(() => [...document.querySelectorAll('#pages li.page')].every((li) => li.dataset.drawn?.startsWith('b')));
  assert.match(await page.textContent('#doc-facts'), /5 pages · 2 files/);
  assert.equal(await page.$eval('#pages li.page:nth-child(4) .badge', (b) => b.textContent), 'B');
  assert.equal(await page.inputValue('#save-name'), 'alpha-edited');

  // Keyboard: select the first page and move it two places later.
  await page.click('#pages li.page:nth-child(1)');
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');
  assert.match((await labels())[2], /^Page 3, from alpha\.pdf/);
  await announced(/position 3/);
  // Rotate it with R, undo and redo.
  await page.keyboard.press('r');
  assert.match((await labels())[2], /turned 90°/);
  await page.click('#undo');
  assert.doesNotMatch((await labels())[2], /turned/);
  await page.click('#redo');
  assert.match((await labels())[2], /turned 90°/);
  // Drag the last page (Bravo 2) to the front.
  if (label === 'desktop') {
    await page.click('#pages li.page:nth-child(3)'); // clear the selection
    await page.dragAndDrop('#pages li.page:nth-child(5)', '#pages li.page:nth-child(1)', { targetPosition: { x: 5, y: 40 } });
    await page.waitForFunction(() => /from bravo/.test(document.querySelector('#pages li.page')?.getAttribute('aria-label') ?? ''));
  }
  // Redact mode mounts the redaction module or says it is not available. Checked online, since the
  // redaction module is fetched when the tab is first opened.
  redactAsked = true;
  await page.click('#tab-redact');
  await page.waitForFunction(() => document.getElementById('redact-panel').children.length > 0);
  // The redaction panel loads its worker and engine after it appears. Wait for every request to settle.
  await page.waitForFunction(() => performance.getEntriesByType('resource').length > 0);
  for (let quiet = 0, seen = -1; quiet < 4; await page.waitForTimeout(250)) { const n = await page.evaluate(() => performance.getEntriesByType('resource').length); quiet = n === seen && inflight === 0 ? quiet + 1 : 0; seen = n; }
  // The same for the signing module.
  await page.click('#tab-sign');
  await page.waitForSelector('#sign-panel .sg');
  for (let quiet = 0, seen = -1; quiet < 4; await page.waitForTimeout(250)) { const n = await page.evaluate(() => performance.getEntriesByType('resource').length); quiet = n === seen && inflight === 0 ? quiet + 1 : 0; seen = n; }
  assert.equal(await page.isVisible('label.sg-seg:has-text("Smart card")'), false, 'no card option on the hosted site');
  await page.click('#tab-organize');

  // Everything else is loaded: the rest works offline.
  await context.setOffline(true);

  await page.screenshot({ path: `${shots}/pdf-editor-${label}-organize.png`, fullPage: label === 'mobile' });

  // Save the merge with hidden data removed: right pages in the right order, no author left.
  const merged = await save(() => page.click('#save'));
  assert.equal(merged.name, 'alpha-edited.pdf');
  const mergedText = texts(merged.bytes);
  assert.equal(mergedText.length, 5);
  assert.deepEqual(mergedText, label === 'desktop' ? ['Bravo 2', 'Alpha 2', 'Alpha 3', 'Alpha 1', 'Bravo 1'] : ['Alpha 2', 'Alpha 3', 'Alpha 1', 'Bravo 1', 'Bravo 2']);
  assert.equal(open(merged.bytes).getMetaData('info:Author'), undefined);
  assert.ok(!(await inspectFile(merged.bytes, 'a.pdf')).blocks.some((b) => b.kind === 'Document info'));
  await page.waitForSelector('#save-result:not([hidden])');
  assert.match(await page.textContent('#save-report'), /Hidden data removed/);

  // Protect: AES-256 with a password, then verify it.
  await page.click('#tab-protect');
  await page.fill('#pw', 'correct horse'); await page.fill('#pw2', 'correct horse');
  await page.uncheck('#allow-copy');
  assert.match(await page.textContent('#protect-note'), /AES-256, with restrictions/);
  const locked = await save(() => page.click('#save'));
  const ld = open(locked.bytes).asPDF();
  assert.equal(ld.needsPassword(), true);
  assert.equal(ld.getTrailer().get('Encrypt').get('V').asNumber(), 5);
  assert.equal(ld.getTrailer().get('Encrypt').get('R').asNumber(), 6);
  assert.equal(ld.authenticatePassword('correct horse'), 2);
  assert.equal(ld.hasPermission('copy'), false);
  assert.equal(texts(locked.bytes, 'correct horse').length, 5);
  assert.match(await page.textContent('#save-detail'), /AES-256 encrypted/);
  await page.fill('#pw', ''); await page.fill('#pw2', ''); await page.check('#allow-copy');

  if (label === 'desktop') {
    // Split by ranges into a ZIP of two PDFs.
    await page.click('#tab-organize');
    await page.fill('#split-ranges', '1-2, 3-');
    const zip = await save(() => page.click('#split-form button[type=submit]'));
    assert.equal(zip.name, 'alpha-split.zip');
    const parts = readZip(new Uint8Array(zip.bytes)).entries;
    assert.deepEqual(parts.map((e) => e.name), ['alpha-pages-1-2.pdf', 'alpha-pages-3-5.pdf']);

    // Watermark and page numbers end up on every page.
    await page.click('#tab-watermark');
    await page.click('#watermark-form button[type=submit]');
    await page.waitForFunction(() => /watermark/i.test(document.getElementById('announce').textContent));
    await page.click('#numbers-form button[type=submit]');
    await page.waitForFunction(() => /page numbers/i.test(document.getElementById('announce').textContent));
    const stamped = texts((await save(() => page.click('#save'))).bytes);
    stamped.forEach((t, i) => { assert.match(t, /CONFIDENTIAL/); assert.match(t, new RegExp(`Page ${i + 1} of 5`)); });
    await page.screenshot({ path: `${shots}/pdf-editor-${label}-watermark.png` });

    // Pages to images: two selected pages as PNGs in a ZIP.
    await page.click('#tab-convert');
    await page.click('#pages li.page:nth-child(1)'); await page.click('#pages li.page:nth-child(2)');
    const images = await save(() => page.click('#export-images'));
    assert.deepEqual(readZip(new Uint8Array(images.bytes)).entries.map((e) => e.name), ['alpha-page-1.png', 'alpha-page-2.png']);
    // Images to PDF: a phone photo taken sideways becomes a portrait page.
    await page.setInputFiles('#image-files', `${dir}/photo.jpg`);
    await page.waitForFunction(() => document.querySelectorAll('#pages li.page').length === 6);
    await page.click('#select-all'); await page.click('#select-all');
    await page.click('#pages li.page:nth-child(6)');
    await page.click('#tab-organize');
    const photo = await save(() => page.click('#extract'));
    const [, , pw, ph] = open(photo.bytes).loadPage(0).getBounds();
    assert.ok(ph > pw, 'portrait page');

    // Compress: a lossless rewrite of a photo PDF, then lossy downsampling.
    await page.click('#close');
    await page.setInputFiles('#file', `${dir}/photos.pdf`);
    await page.waitForSelector('#pages li.page', { state: 'attached' });
    await page.click('#tab-compress');
    await page.check('#lossy');
    await page.click('#compress-run');
    await page.waitForSelector('#compress-result:not([hidden])');
    assert.match(await page.textContent('#compress-result'), /smaller/);
    await page.screenshot({ path: `${shots}/pdf-editor-${label}-compress.png` });

    // Remove hidden data is on but an image keeps its metadata: save, split and extract list exactly what
    // stays, and nothing is downloaded until that is accepted.
    await page.click('#close');
    await page.setInputFiles('#file', [`${dir}/retained.pdf`, `${dir}/alpha.pdf`]);
    await page.waitForFunction(() => document.querySelectorAll('#pages li.page').length === 4);
    await page.click('#tab-organize');
    let downloads = 0; const counted = () => { downloads++; };
    page.on('download', counted);
    const declined = async (click) => {
      const before = downloads;
      await click();
      await page.waitForSelector('#retained-dialog[open]');
      const listed = await page.textContent('#retained-list');
      await page.click('#retained-cancel');
      await page.waitForSelector('#retained-dialog', { state: 'hidden' });
      await page.waitForTimeout(400);
      assert.equal(downloads, before, 'nothing downloaded before the retained data is accepted');
      await announced(/Nothing was saved/);
      return listed;
    };
    const accepted = (click) => save(async () => { await click(); await page.waitForSelector('#retained-dialog[open]'); await page.click('#retained-accept'); });
    assert.match(await declined(() => page.click('#save')), /1 image with metadata, the image cleaner could not rewrite it/);
    const keptSave = await accepted(() => page.click('#save'));
    assert.ok(keptSave.bytes.includes(Buffer.from('SECRET-OWNER')));
    await page.waitForSelector('#save-result:not([hidden])');
    assert.match(await page.textContent('#save-report'), /Kept: 1 image with metadata/);
    await page.screenshot({ path: `${shots}/pdf-editor-${label}-retained-report.png` });
    // Split: the warning names the file that holds the image, and each file's report is shown.
    await page.fill('#split-ranges', '1, 2-');
    await page.click('#split-form button[type=submit]');
    await page.waitForSelector('#retained-dialog[open]');
    const splitList = await page.textContent('#retained-list');
    assert.match(splitList, /retained-page-1\.pdf: 1 image with metadata/);
    assert.doesNotMatch(splitList, /pages-2-4/);
    await page.screenshot({ path: `${shots}/pdf-editor-${label}-retained-dialog.png` });
    await page.click('#retained-cancel');
    await page.waitForSelector('#retained-dialog', { state: 'hidden' });
    const splitZip = await accepted(() => page.click('#split-form button[type=submit]'));
    assert.deepEqual(readZip(new Uint8Array(splitZip.bytes)).entries.map((e) => e.name), ['retained-page-1.pdf', 'retained-pages-2-4.pdf']);
    assert.match(await page.textContent('#organize-report'), /retained-page-1\.pdf: Kept: 1 image with metadata/);
    // Extract: the same for a single file.
    await page.click('#pages li.page:nth-child(1)');
    assert.match(await declined(() => page.click('#extract')), /1 image with metadata/);
    await accepted(() => page.click('#extract'));
    assert.match(await page.textContent('#organize-report'), /Kept: 1 image with metadata/);
    // Pages without the image need no confirmation.
    await page.click('#pages li.page:nth-child(1)'); await page.click('#pages li.page:nth-child(2)');
    const clean = await save(() => page.click('#extract'));
    assert.ok(!clean.bytes.includes(Buffer.from('SECRET-OWNER')));
    page.off('download', counted);

    // A page claiming 100,000 points square: its thumbnail and view render within the pixel budget, and an
    // image export comes out at a lower resolution, which the page says.
    await page.click('#close');
    await page.setInputFiles('#file', `${dir}/huge.pdf`);
    await page.waitForSelector('#view-panel .vw-page');
    await page.click('#tab-organize');
    await page.waitForFunction(() => document.querySelector('#pages li.page')?.dataset.drawn?.startsWith('b'));
    await page.click('#tab-convert');
    const hugeImage = await save(() => page.click('#export-images'));
    assert.equal(hugeImage.name, 'huge-page-1.png');
    const png = new DataView(hugeImage.bytes.buffer, hugeImage.bytes.byteOffset);
    const [iw, ih] = [png.getUint32(16), png.getUint32(20)];
    assert.ok(iw * ih <= 40e6 && iw <= 16384, `exported ${iw} x ${ih}`);
    await page.waitForSelector('#export-note:not([hidden])');
    assert.match(await page.textContent('#export-note'), /too large to render at 150 dpi/);
  }

  // A password-protected PDF asks for its password; a wrong one is refused.
  await page.click('#close');
  await page.setInputFiles('#file', `${dir}/locked.pdf`);
  await page.waitForSelector('#unlock:not([hidden])');
  await page.fill('#unlock-password', 'nope'); await page.click('#unlock button[type=submit]');
  await page.waitForFunction(() => document.getElementById('unlock').dataset.state === 'wrong');
  await page.fill('#unlock-password', 'letmein'); await page.click('#unlock button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#pages li.page').length === 2);
  assert.match(await page.textContent('#protect-note'), /original password is removed/);
  const unlocked = await save(() => page.click('#save'));
  assert.equal(open(unlocked.bytes).needsPassword(), false);
  assert.deepEqual(texts(unlocked.bytes), ['Locked 1', 'Locked 2']);

  // 200 pages: the grid appears at once and only pages near the view are rendered.
  await page.click('#close');
  const t0 = Date.now();
  await page.setInputFiles('#file', `${dir}/big.pdf`);
  await page.waitForFunction(() => document.querySelectorAll('#pages li.page').length === 200);
  const opened = Date.now() - t0;
  await page.click('#tab-organize');
  const early = await drawn();
  // The page's own thread stays free while thumbnails render: a click is handled within a frame or two.
  await page.waitForFunction(() => document.querySelector('#pages li.page').dataset.drawn?.startsWith('b'));
  const lag = await page.evaluate(async () => {
    let worst = 0;
    for (let i = 0; i < 8; i++) { const t = performance.now(); await new Promise((r) => setTimeout(r, 0)); worst = Math.max(worst, performance.now() - t); await new Promise((r) => setTimeout(r, 60)); }
    return worst;
  });
  const clickMs = await page.evaluate(() => { const li = document.querySelector('#pages li.page:nth-child(2)'); const t = performance.now(); li.click(); return li.getAttribute('aria-selected') === 'true' ? performance.now() - t : Infinity; });
  await page.waitForTimeout(1500);
  const later = await drawn();
  assert.ok(later < 120, `only visible pages render (${later} of 200)`);
  assert.ok(lag < 100 && clickMs < 100, `page answers while rendering (timer ${lag.toFixed(0)} ms, click ${clickMs.toFixed(0)} ms)`);
  await page.$eval('#pages', (l) => { l.scrollTop = l.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('#pages li.page:last-child').dataset.drawn?.startsWith('b'), null, { timeout: 15000 });
  console.log(`${label}: 200 pages listed in ${opened} ms, ${early} then ${later} thumbnails rendered, click handled in ${clickMs.toFixed(1)} ms`);

  // Sign: open one file, sign it with the .p12 in a box, save the signed bytes unchanged.
  if (p12) {
    await page.click('#close');
    await page.setInputFiles('#file', [`${dir}/alpha.pdf`]);
    await page.waitForFunction(() => document.querySelectorAll('#pages li.page').length === 3);
    await page.click('#tab-sign');
    await page.waitForFunction(() => document.querySelector('#sign-panel .sg-sigs')?.textContent.includes('no digital signatures'));
    assert.equal(await page.isVisible('#layout'), false, 'page grid hidden while signing');
    assert.ok(await page.$eval('#save-form', (f) => f.previousElementSibling?.id === 'sign-panel'), 'Save card follows the Sign panel');
    await page.setInputFiles('#sg-p12', p12);
    await page.fill('#sg-password', 'sign-test');
    await page.click('#sign-panel button:has-text("Open")');
    await page.waitForSelector('#sign-panel .sg-cert:not([hidden])');
    await page.click('#sign-panel button:has-text("Place a box")');
    await page.fill('#sg-reason', 'Approved');
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${shots}/pdf-editor-${label}-sign-${scheme}.png`, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.click('#sign-panel .sg-sign');
    await page.click('#sign-panel button:has-text("Confirm signature")');
    await page.waitForSelector('#sign-panel .sg-result:not([hidden])');
    assert.match(await page.textContent('#sign-note'), /Saved exactly as signed/);
    assert.equal(await page.isDisabled('#clean'), true);
    const signedFile = await save(() => page.click('#save'));
    assert.equal(signedFile.name, 'alpha-edited.pdf');
    writeFileSync(join(dir, `${label}-signed.pdf`), signedFile.bytes);
    const v = await verifyPdf(new Uint8Array(signedFile.bytes));
    assert.deepEqual(v.signatures.map((x) => x.status), ['valid']);
    assert.equal(v.signatures[0].signer.commonName, 'Editor Test Signer');
    assert.equal(v.signatures[0].reason, 'Approved');
    assert.equal(texts(signedFile.bytes).length, 3);
    const out = pdfsig(join(dir, `${label}-signed.pdf`));
    if (out !== null) assert.match(out, /Signature is Valid/);
    assert.match(await page.textContent('#save-report'), /Saved exactly as signed/);
    await page.screenshot({ path: `${shots}/pdf-editor-${label}-signed.png`, fullPage: true });
    // Undo leaves the signed state: cleaning applies again.
    await page.click('#undo');
    assert.equal(await page.isDisabled('#clean'), false);
    await page.click('#redo');
    assert.equal(await page.isDisabled('#clean'), true);
    // Rotating a page afterwards rewrites the file, and the editor says the signature goes.
    await page.click('#tab-organize');
    await page.click('#pages li.page:nth-child(1)');
    await page.keyboard.press('r');
    assert.equal(await page.isDisabled('#clean'), false);
    assert.match(await page.textContent('#notes'), /digitally signed/);
    await page.click('#tab-sign');
    // The rotated copy is rebuilt: its earlier signature is either reported as no longer matching or gone.
    await page.waitForFunction(() => /edited after opening|no digital signatures/.test(document.querySelector('#sign-panel .sg-sigs')?.textContent ?? ''));
    assert.doesNotMatch(await page.textContent('#sign-panel .sg-sigs'), /Valid —/);
    await page.click('#tab-organize');
  }

  // Layout: no sideways scrolling, light and dark.
  await page.$eval('#pages', (l) => { l.scrollTop = 0; });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
  await page.click('#close');
  await page.setInputFiles('#file', [`${dir}/alpha.pdf`, `${dir}/bravo.pdf`]);
  await page.waitForSelector('#view-panel .vw-page');
  await page.click('#tab-organize');
  await page.waitForFunction(() => [...document.querySelectorAll('#pages li.page')].length === 5 && [...document.querySelectorAll('#pages li.page')].every((li) => li.dataset.drawn?.startsWith('b')));
  await page.click('#pages li.page:nth-child(2)');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 0, `${scheme} horizontal overflow ${wide}px`);
    await page.screenshot({ path: `${shots}/pdf-editor-${label}-${scheme}.png`, fullPage: true });
  }
  assert.deepEqual(problems, [], 'console errors');
  assert.deepEqual(loaded.filter((u) => !u.startsWith(base) && !u.startsWith('blob:')), [], 'requests to other origins');
  await context.close();
  console.log(`${label}: ok`);
}
// Redact, then sign the redacted result: the signature covers the redacted bytes and stays valid when saved.
if (p12) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/pdf-editor/`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', [`${dir}/alpha.pdf`]);
  await page.waitForFunction(() => document.querySelectorAll('#pages li.page').length === 3);
  await page.click('#tab-redact');
  await page.waitForSelector('#rd-query');
  await page.waitForFunction(() => document.querySelector('.rd-canvas')?.width > 0);
  await page.fill('#rd-query', 'Alpha 2');
  await page.click('#redact-panel button[type=submit]:has-text("Search")');
  await page.click('#redact-panel button:has-text("Mark all")');
  await page.locator('.rd-apply').click({ timeout: 10000 });
  await page.waitForSelector('.rd-result:not([hidden])', { timeout: 60000 });
  assert.equal(await page.getAttribute('.rd-result', 'data-state'), 'ok', await page.textContent('.rd-result'));
  await page.click('#tab-sign');
  await page.waitForSelector('#sign-panel .sg');
  await page.setInputFiles('#sg-p12', p12);
  await page.fill('#sg-password', 'sign-test');
  await page.click('#sign-panel button:has-text("Open")');
  await page.waitForSelector('#sign-panel .sg-cert:not([hidden])');
  await page.click('#sign-panel button:has-text("Place a box")');
  await page.click('#sign-panel .sg-sign');
  await page.click('#sign-panel button:has-text("Confirm signature")');
  await page.waitForSelector('#sign-panel .sg-result:not([hidden])');
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  const path = join(dir, 'redacted-signed.pdf'); await d.saveAs(path);
  const bytes = readFileSync(path);
  assert.deepEqual((await verifyPdf(new Uint8Array(bytes))).signatures.map((x) => x.status), ['valid']);
  const out = pdfsig(path);
  if (out !== null) assert.match(out, /Signature is Valid/);
  const words = texts(bytes).join(' ');
  assert.ok(!words.includes('Alpha 2') && words.includes('Alpha 3'), 'the signed copy is the redacted one');
  assert.deepEqual(problems, [], 'console errors while redacting and signing');
  await context.close();
  console.log('redact then sign: ok');
}
await browser.close();
console.log('pdf editor browser checks passed');
