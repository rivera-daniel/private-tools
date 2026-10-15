// Browser check for Redact mode of the PDF Editor. The editor page is not needed: a small harness page is
// written into site/tools/pdf-editor/ for the run (so it gets that directory's CSP) and deleted afterwards.
// It mounts the panel, searches with a preset, draws boxes with the mouse and the keyboard, takes up the
// fake-redaction banner, applies, checks the result, and looks at console, network and the mobile layout.
// Usage: BASE=http://host:port [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] node tests/browser-pdf-redact.mjs
// The server must serve this checkout's site/ directory.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as mupdf from '../site/tools/vendor/mupdf/mupdf.js';
import * as fx from './fixtures/pdf-redact.js';

mupdf.setLog(() => {});
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE ?? 'http://127.0.0.1:4176';
const shots = process.env.SHOTS ?? 'test-results';
mkdirSync(shots, { recursive: true });

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'tools', 'pdf-editor');
const files = { html: join(dir, 'redact-harness.html'), js: join(dir, 'redact-harness.js') };
for (const f of Object.values(files)) if (existsSync(f)) throw new Error(`${f} already exists; remove it first.`);

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redact harness</title><link rel="icon" href="/tools/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/tools/assets/site.css"><script src="/tools/assets/theme.js"></script><script type="module" src="/tools/pdf-editor/redact-harness.js"></script></head>
<body><main class="wrap"><section id="redact-panel"></section></main></body></html>
`;
// The editor's side of the contract, with its own MuPDF worker for rendering.
const JS = `import { mountRedact } from '/tools/lib/pdf-editor/redact-ui.js';
let bytes = null; const sets = []; let seq = 0; const waiting = new Map();
const engine = new Worker('/tools/pdf-editor/redact-worker.js', { type: 'module' });
engine.onmessage = ({ data }) => { const w = waiting.get(data.id); waiting.delete(data.id); data.ok ? w.resolve(data.result) : w.reject(new Error(data.error.message)); };
const ask = (op, extra = {}) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); engine.postMessage({ id, op, ...extra }); });
let pages = [];
const ctx = {
  getBytes: async () => bytes.slice(),
  setBytes: async (u8, label) => { bytes = u8.slice(); sets.push({ label, size: u8.length }); const info = await ask('open', { bytes: bytes.slice() }); pages = info.pages; },
  pageCount: () => pages.length,
  pageSize: (i) => ({ width: pages[i].width, height: pages[i].height }),
  renderPage: (i, scale) => ask('render', { page: i, scale }),
};
let mounted = null;
window.harness = {
  async load(list) { bytes = Uint8Array.from(list); try { pages = (await ask('open', { bytes: bytes.slice() })).pages; } catch { pages = []; } mounted?.unmount(); mounted = mountRedact(document.getElementById('redact-panel'), ctx); },
  bytes: () => Array.from(bytes), sets: () => sets, unmount: () => { mounted?.unmount(); mounted = null; },
};
document.documentElement.dataset.ready = '1';
`;

const fake = '0 g 122 494 126 20 re f';
const source = fx.personal({ lines: [
  'BT /F1 12 Tf 72 720 Td (Name: John Secretman) Tj ET',
  'BT /F1 12 Tf 72 700 Td (SSN 123-45-6789 on file) Tj ET',
  'BT /F1 12 Tf 72 680 Td (Email jane.doe@example.org today) Tj ET',
  'BT /F1 12 Tf 72 640 Td (Public line stays) Tj ET',
  'BT /F1 12 Tf 72 500 Td (Witness: Maria Hiddenname) Tj ET', fake,
].join('\n') });

const textOf = (u8) => { const d = mupdf.Document.openDocument(u8, 'application/pdf'); let s = ''; for (let i = 0; i < d.countPages(); i++) s += d.loadPage(i).toStructuredText('preserve-whitespace').asText(); return s; };

writeFileSync(files.html, HTML);
writeFileSync(files.js, JS);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
try {
  for (const [label, viewport, scheme] of [['desktop', { width: 1400, height: 1000 }, 'light'], ['dark', { width: 1400, height: 1000 }, 'dark'], ['mobile', { width: 390, height: 844 }, 'light']]) {
    const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: label === 'mobile' ? 2 : 1, hasTouch: label === 'mobile', isMobile: label === 'mobile' });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    const requests = []; page.on('request', (r) => requests.push(r.url()));
    await page.goto(`${base}/tools/pdf-editor/redact-harness.html`);
    await page.waitForSelector('html[data-ready="1"]');
    await page.evaluate((list) => window.harness.load(list), Array.from(source));
    await page.waitForSelector('.rd-layout:not([hidden])');
    await page.waitForFunction(() => document.querySelector('.rd-canvas')?.width > 0);
    // The fake-redaction banner.
    await page.waitForSelector('.rd-banner.alert');
    assert.match(await page.textContent('.rd-banner.alert'), /hide nothing.*Maria Hiddenname/s);
    assert.ok((await page.textContent('.rd-pagenum')).includes('Page 1 of 2'));
    if (label === 'desktop') await page.screenshot({ path: `${shots}/redact-${label}-open.png`, fullPage: true });

    // Preset search and Mark all.
    await page.click('.rd-chip[data-preset="ssn"]');
    await page.waitForFunction(() => /1 match/.test(document.querySelector('.rd-card[aria-label="Search results"] .rd-card-title')?.textContent ?? ''));
    assert.equal(await page.locator('.rd-hit').count(), 1, 'match highlighted on the page');
    await page.click('text=Mark all');
    await page.waitForFunction(() => document.querySelectorAll('.rd-side .rd-card[aria-label="Marked for redaction"] .rd-item').length === 1);
    assert.match(await page.textContent('.rd-card[aria-label="Marked for redaction"]'), /123-45-6789/);

    // A literal search, marked from its row.
    await page.fill('#rd-query', 'jane.doe');
    await page.press('#rd-query', 'Enter');
    await page.waitForFunction(() => /1 match for “jane.doe”/.test(document.querySelector('.rd-card[aria-label="Search results"] .rd-card-title')?.textContent ?? ''));
    await page.click('.rd-list[aria-label="Matches"] button:has-text("Mark")');
    await page.waitForFunction(() => document.querySelectorAll('.rd-card[aria-label="Marked for redaction"] .rd-item').length === 2);

    // Draw with the pointer (desktop) and remove it again; draw with the keyboard.
    if (label !== 'mobile') {
      await page.locator('.rd-stage').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const box = await page.locator('.rd-overlay').boundingBox();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 4 });
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelectorAll('.rd-card[aria-label="Marked for redaction"] .rd-item').length === 3);
      await page.click('.rd-card[aria-label="Marked for redaction"] button[aria-label^="Remove"][aria-label*="Area"]');
      await page.waitForFunction(() => document.querySelectorAll('.rd-card[aria-label="Marked for redaction"] .rd-item').length === 2);
    }
    await page.focus('.rd-overlay');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.rd-card[aria-label="Marked for redaction"] .rd-item').length === 3);

    // The banner's own action marks the fake box for real redaction.
    await page.click('.rd-banner.alert button');
    await page.waitForFunction(() => document.querySelectorAll('.rd-card[aria-label="Marked for redaction"] .rd-item').length === 4);
    assert.ok(await page.locator('.rd-box').count() >= 3, 'marks drawn on the page');
    await page.screenshot({ path: `${shots}/redact-${label}-marked.png`, fullPage: true });

    await page.fill('#rd-label', '[REDACTED]');
    await page.locator('.rd-apply').click({ timeout: 10000 }).catch(async (e) => { await page.screenshot({ path: `${shots}/redact-${label}-failure.png`, fullPage: true }); throw e; });
    await page.waitForSelector('.rd-result:not([hidden])', { timeout: 60000 });
    assert.equal(await page.getAttribute('.rd-result', 'data-state'), 'ok', await page.textContent('.rd-result'));
    assert.match(await page.textContent('.rd-result h3'), /Verified: none of the redacted text remains/);
    assert.match(await page.textContent('.rd-result'), /one revision/);
    const sets = await page.evaluate(() => window.harness.sets());
    assert.deepEqual(sets.map((s) => s.label), ['Redacted']);
    const out = Uint8Array.from(await page.evaluate(() => window.harness.bytes()));
    const text = textOf(out);
    for (const gone of ['123-45-6789', 'jane.doe@example.org', 'Hiddenname']) assert.ok(!text.includes(gone), gone);
    assert.ok(text.includes('Public line stays') && text.includes('[REDACTED]'));
    // After applying, the panel holds the redacted document and reports no fake boxes.
    await page.waitForFunction(() => document.querySelectorAll('.rd-card[aria-label="Marked for redaction"] .rd-item').length === 0);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.rd-banner.alert').count(), 0, 'no fake-redaction banner on the redacted file');
    await page.screenshot({ path: `${shots}/redact-${label}-done.png`, fullPage: true });

    // Layout: nothing wider than the viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${label}: page scrolls sideways by ${overflow}px`);
    if (label === 'mobile') {
      const side = await page.locator('.rd-side').boundingBox(); const viewer = await page.locator('.rd-viewer').boundingBox();
      assert.ok(side.y > viewer.y, 'mobile: panel below the page view');
      assert.ok(viewer.width <= 390, 'mobile: page view fits');
    }
    await page.evaluate(() => window.harness.unmount());
    assert.deepEqual(requests.filter((u) => !u.startsWith(base)), [], 'requests to other origins');
    assert.deepEqual(problems, [], `${label}: console problems`);
    await context.close();
    console.log(`ok ${label}`);
  }

  // A password-protected PDF asks for the password before anything else.
  const locked = mupdf.Document.openDocument(source, 'application/pdf').asPDF().saveToBuffer('encrypt=aes-256,user-password=letmein,owner-password=x').asUint8Array().slice();
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const problems = []; page.on('pageerror', (e) => problems.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  await page.goto(`${base}/tools/pdf-editor/redact-harness.html`);
  await page.waitForSelector('html[data-ready="1"]');
  await page.evaluate((list) => window.harness.load(list).catch(() => {}), Array.from(locked));
  await page.waitForSelector('.rd-password:not([hidden])');
  await page.fill('#rd-password', 'wrong');
  await page.click('.rd-password button');
  await page.waitForFunction(() => /not correct/.test(document.querySelector('.rd-password .rd-error')?.textContent ?? ''));
  await page.fill('#rd-password', 'letmein');
  await page.click('.rd-password button');
  await page.waitForSelector('.rd-layout:not([hidden])');
  await page.waitForSelector('.rd-banner.quiet');
  assert.match(await page.textContent('.rd-banner.quiet'), /without a password/);
  assert.deepEqual(problems.filter((p) => !/protected|password/i.test(p)), []);
  await context.close();
  console.log('ok password');
} finally {
  await browser.close();
  for (const f of Object.values(files)) rmSync(f, { force: true });
}
console.log('browser redact check passed');
