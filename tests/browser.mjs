// Browser checks: network boundary, CSP violations, text-only rendering and layout screenshots.
// Usage: BASE=http://host:port [CHROMIUM=/path/to/chromium] [PLAYWRIGHT_CORE=/path/to/playwright-core] node tests/browser.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fx from './fixtures/build.js';
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const base = process.env.BASE ?? 'http://127.0.0.1:4177';
const shots = process.env.SHOTS ?? 'test-results';
const files = await buildInputs();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });

async function run(viewport, label) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  // On production Cloudflare injects its bot-detection script and Web Analytics beacon. The CSP blocks both, which is the intent.
  const expected = (t) => process.env.ALLOW_CF_JSD && /Executing inline script violates the following Content Security Policy|static\.cloudflareinsights\.com\/beacon/.test(t);
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !expected(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/tools/image-inspector/`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${shots}/${label}-empty.png`, fullPage: false });
  assert.equal(await page.isVisible('#results'), false, 'empty results visible before a file is chosen');
  assert.ok(await reachByTab(page), 'file input not reachable by keyboard');
  // Everything after this point runs with the network cut.
  await page.context().setOffline(true);
  const requests = [];
  const methods = [];
  page.on('request', (r) => { requests.push(r.url()); methods.push(r.method()); });
  // Files the offline service worker answers from its cache never reach the network.
  const fromCache = new Set(); page.on('requestfinished', async (r) => { if ((await r.response())?.fromServiceWorker()) fromCache.add(r.url()); });
  const results = {};
  for (const f of ['camera-gps.jpg', 'comfyui.png', 'content-credentials.jpg', 'clean.png', 'xss.png', 'notes.pdf', 'pii.heic', 'pii.tif', 'pii.svg', 'pii.jxl']) {
    await page.setInputFiles('#file', `${files}/${f}`);
    await page.waitForSelector('#results:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('busy').hidden);
    assert.equal(await page.isVisible('#dropzone'), false, 'drop zone still visible beside results');
    assert.equal(await page.isVisible('#busy'), false, 'progress still visible beside results');
    results[f] = await page.evaluate(() => ({
      level: document.getElementById('summary').dataset.level,
      provenance: document.getElementById('provenance').dataset.level,
      fields: document.querySelectorAll('#sources .row').length,
      title: document.getElementById('summary-title').textContent,
      signals: [...document.querySelectorAll('.findings > :not([hidden]) .signal strong')].map((n) => n.textContent),
    }));
    if (['camera-gps.jpg', 'comfyui.png', 'content-credentials.jpg', 'pii.heic', 'pii.svg'].includes(f)) await page.screenshot({ path: `${shots}/${label}-${f}.png`, fullPage: true });
    if (f === 'xss.png') {
      const xss = await page.evaluate(() => ({
        injected: document.querySelectorAll('.findings img, .findings form, .findings script, .findings b').length,
        title: document.title,
        prompt: [...document.querySelectorAll('.row')].find((r) => r.querySelector('dt').textContent === 'Prompt')?.querySelector('dd').textContent,
      }));
      assert.equal(xss.injected, 0, 'extracted HTML became DOM');
      assert.notEqual(xss.title, 'PWNED');
      assert.match(xss.prompt, /^<img src=x onerror=/);
    }
  }
  const external = requests.filter((u) => !u.startsWith('blob:'));
  assert.deepEqual(external, [], `network requests during processing: ${external.join(', ')}`);
  assert.deepEqual(problems, [], `console problems: ${problems.join(' | ')}`);
  assert.equal(results['camera-gps.jpg'].level, 'exposed');
  assert.equal(results['camera-gps.jpg'].provenance, 'camera');
  assert.ok(results['camera-gps.jpg'].signals.includes('Exact location stored'));
  assert.equal(results['comfyui.png'].provenance, 'declared');
  assert.equal(results['content-credentials.jpg'].provenance, 'credentials');
  assert.equal(results['clean.png'].level, 'clean');
  assert.equal(results['clean.png'].provenance, 'none');
  assert.equal(results['xss.png'].provenance, 'declared');
  for (const f of ['pii.heic', 'pii.tif', 'pii.jxl']) { assert.equal(results[f].level, 'exposed', f); assert.ok(results[f].signals.includes('Exact location stored'), f); assert.ok(results[f].fields > 10, f); }
  assert.ok(results['pii.svg'].signals.includes('Active content in SVG'));
  assert.equal(results['notes.pdf'].level, 'error');
  assert.deepEqual(results['notes.pdf'].signals, []);
  assert.equal(new Set(results['comfyui.png'].signals).size, results['comfyui.png'].signals.length);
  // Cancel mid-parse while still offline: the change event posts the job and the click cancels it before
  // the worker can reply. The spare worker must take over without a network fetch.
  const png = [...readFileSync(`${files}/clean.png`)];
  await page.evaluate((bytes) => {
    const input = document.getElementById('file'); const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'cancel-me.png', { type: 'image/png' }));
    input.files = dt.files; input.dispatchEvent(new Event('change'));
    document.getElementById('cancel').click();
  }, png);
  assert.equal(await page.isVisible('#dropzone'), true, 'cancel did not return to the drop zone');
  await page.setInputFiles('#file', `${files}/camera-gps.jpg`);
  await page.waitForSelector('#results:not([hidden])', { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.getElementById('provenance').dataset.level), 'camera');
  // Replacing the spare re-requests only the worker's own code, from the offline cache once it is stored.
  // File data never leaves the page.
  const afterCancel = requests.filter((u) => !u.startsWith('blob:') && !fromCache.has(u) && u !== `${base}/tools/image-inspector/worker.js`);
  assert.deepEqual(afterCancel, [], `unexpected requests after cancel: ${afterCancel.join(', ')}`);
  assert.deepEqual(methods.filter((m) => m !== 'GET'), [], 'a non-GET request was sent');
  await page.close();
  return { label, requestsDuringProcessing: requests.length, external: external.length, results };
}

async function reachByTab(page) {
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 15; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(() => document.activeElement?.id === 'file')) return true; }
  return false;
}


mkdirSync(shots, { recursive: true });

try {
  for (const [vp, label] of [[{ width: 1440, height: 1000 }, 'desktop'], [{ width: 390, height: 844 }, 'mobile']]) console.log(JSON.stringify(await run(vp, label)));
  // Catalog card links to the tool.
  const page = await browser.newPage();
  await page.goto(`${base}/tools/`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: /Image Inspector/ }).first().click();
  await page.waitForURL(/\/tools\/image-inspector\/$/);
  console.log('catalog link ok');
  console.log('browser checks passed');
} finally {
  await browser.close();
}

// Writes the browser inputs to a temporary directory from the committed fixtures.
async function buildInputs() {
  const dir = mkdtempSync(join(tmpdir(), 'private-tools-browser-'));
  const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
  const camera = fx.tiff([[0x010f, 2, 'Canon'], [0x0110, 2, 'Canon EOS R5'], [0x0131, 2, 'Adobe Photoshop 25.0'], [0x013b, 2, 'Jane Doe']], {
    exif: [[0x9003, 2, '2026:10:01 09:30:00'], [0xa431, 2, 'SN-0042-7781'], [0x829a, 5, [[1, 250]]], [0x829d, 5, [[28, 10]]]],
    gps: [[1, 2, 'N'], [2, 5, fx.dms(30.26715)], [3, 2, 'W'], [4, 5, fx.dms(97.74306)]],
    thumbnail: Buffer.from(fx.base.jpeg),
  });
  writeFileSync(join(dir, 'camera-gps.jpg'), fx.jpegWith(fx.exifSegment(camera)));
  const prompt = { 3: { class_type: 'KSampler', inputs: { seed: 1 } }, 4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev.safetensors' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: 'a red fox standing in fresh snow, golden hour, 35mm photo' } } };
  writeFileSync(join(dir, 'comfyui.png'), fx.pngWith(fx.tEXt('prompt', JSON.stringify(prompt)), fx.tEXt('workflow', JSON.stringify({ nodes: Array.from({ length: 40 }, (_, i) => ({ id: i, type: `Node${i}` })) }))));
  writeFileSync(join(dir, 'xss.png'), fx.pngWith(fx.tEXt('parameters', `<img src=x onerror="document.title='PWNED'"><form action="//evil"><b>bold</b>\nSteps: 20, Sampler: Euler a, Seed: 42`), fx.tEXt('Software', '<script>alert(1)</script>')));
  writeFileSync(join(dir, 'clean.png'), fx.base.png);
  writeFileSync(join(dir, 'notes.pdf'), Buffer.from('%PDF-1.7 not an image'));
  copyFileSync(fixture('c2pa-CA.jpg'), join(dir, 'content-credentials.jpg'));
  for (const ext of ['heic', 'tif', 'svg', 'jxl']) copyFileSync(fixture(`formats/pii.${ext}`), join(dir, `pii.${ext}`));
  return dir;
}
