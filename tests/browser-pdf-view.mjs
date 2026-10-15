// Browser check for View mode of the PDF Editor: a PDF opens straight into the viewer, pages render lazily
// and sharply, the page number, keyboard and zoom work, find highlights matches, the text layer can be
// selected and copied, links and bookmarks jump, external links ask first, the view rotates without changing
// the document, password-protected files open after the prompt, and the layout holds on a phone in light and
// dark without console or CSP errors.
// Usage: BASE=http://host:port [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] node tests/browser-pdf-view.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from '../site/tools/vendor/mupdf/mupdf.js';
import { protectPdf } from '../site/tools/lib/pdf-editor/index.js';
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE ?? 'http://127.0.0.1:4176';
const shots = process.env.SHOTS ?? 'test-results';
mkdirSync(shots, { recursive: true });

// Five pages: "Chapter n" headings, the word "needle" on pages 2 and 4, a link to page 4 and an external link
// on page 1, and two bookmarks.
function viewPdf() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const res = doc.addObject({ Font: { F1: font } });
  for (let i = 1; i <= 5; i++) {
    const extra = i === 2 || i === 4 ? ' BT /F1 14 Tf 72 600 Td (A needle in the haystack) Tj ET' : '';
    const links = i === 1 ? ' BT /F1 14 Tf 72 500 Td (Go to chapter 4) Tj ET BT /F1 14 Tf 72 460 Td (Visit example.com) Tj ET' : '';
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, `BT /F1 28 Tf 72 700 Td (Chapter ${i}) Tj ET${extra}${links}`));
  }
  const first = doc.loadPage(0);
  first.createLink([72, 280, 250, 300], doc.formatLinkURI({ type: 'Fit', page: 3 }));
  first.createLink([72, 320, 250, 340], 'https://example.com/');
  const it = doc.outlineIterator();
  it.insert({ title: 'Chapter 3', uri: doc.formatLinkURI({ type: 'Fit', page: 2 }), open: true });
  it.insert({ title: 'Chapter 5', uri: doc.formatLinkURI({ type: 'Fit', page: 4 }), open: true });
  const buf = doc.saveToBuffer('compress');
  try { return buf.asUint8Array().slice(); } finally { buf.destroy(); doc.destroy(); }
}

const dir = mkdtempSync(join(tmpdir(), 'pdf-view-'));
const plain = viewPdf();
writeFileSync(join(dir, 'book.pdf'), plain);
writeFileSync(join(dir, 'locked.pdf'), protectPdf(plain, { userPassword: 'open sesame' }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: label === 'mobile' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    const requests = []; page.on('request', (r) => requests.push(r.url()));
    await page.goto(`${base}/tools/pdf-editor/`, { waitUntil: 'networkidle' });
    await page.setInputFiles('#file', join(dir, 'book.pdf'));

    // Opens straight into View.
    await page.waitForSelector('#view-panel .vw-page');
    assert.equal(await page.getAttribute('#tab-view', 'aria-selected'), 'true');
    assert.equal(await page.isVisible('#layout'), false);
    assert.equal(await page.locator('#view-panel .vw-page').count(), 5);
    await page.waitForFunction(() => document.querySelector('.vw-page canvas').width > 0);
    // Crisp: the bitmap has device pixels, not CSS pixels.
    const crisp = await page.$eval('.vw-page', (p) => p.querySelector('canvas').width / p.getBoundingClientRect().width);
    assert.ok(crisp > 1.8, `rendered at ${crisp.toFixed(2)}× the CSS size`);
    // Lazy: far pages are placeholders until they come near.
    const rendered = await page.$$eval('.vw-page canvas', (cs) => cs.map((c) => c.width > 0));
    assert.equal(rendered[4], false, 'the last page waits until it comes near');
    await page.waitForFunction(() => document.querySelector('.vw-page:first-child .vw-text span'));
    await page.screenshot({ path: `${shots}/pdf-view-${label}-light.png`, fullPage: false });

    // Page number, keyboard and buttons.
    await page.click('.vw-scroll');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('.vw-pageinput').value === '5');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('.vw-pageinput').value === '1');
    await page.fill('.vw-pageinput', '3'); await page.press('.vw-pageinput', 'Enter');
    await page.waitForFunction(() => document.querySelector('.vw-pageinput').value === '3');
    await page.click('button[aria-label="Next page"]');
    await page.waitForFunction(() => document.querySelector('.vw-pageinput').value === '4');

    // Zoom re-renders sharper pages.
    const before = await page.$eval('.vw-page', (p) => p.getBoundingClientRect().width);
    await page.click('button[aria-label="Zoom in"]');
    await page.waitForFunction((w) => document.querySelector('.vw-page').getBoundingClientRect().width > w * 1.2, before);
    assert.match(await page.$eval('.vw-zoom', (s) => s.selectedOptions[0].textContent), /%$/);
    await page.waitForFunction(() => { const p = document.querySelectorAll('.vw-page')[3]; const c = p.querySelector('canvas'); return c.width / p.getBoundingClientRect().width > 1.8; });
    await page.keyboard.press('Control+-');
    await page.selectOption('.vw-zoom', 'page');
    const fitPage = await page.$eval('.vw-page', (p) => p.getBoundingClientRect().height);
    assert.ok(fitPage <= (await page.$eval('.vw-scroll', (s) => s.clientHeight)), 'fit page shows a whole page');
    await page.selectOption('.vw-zoom', 'width');

    // Find: highlights, count, next with Enter, previous with Shift+Enter.
    await page.keyboard.press('Control+f');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('vw-find')), true, 'Ctrl+F focuses find');
    await page.keyboard.type('needle');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /of 2/.test(document.querySelector('.vw-count').textContent));
    const firstHit = await page.textContent('.vw-count');
    await page.waitForSelector('.vw-mark.current');
    await page.keyboard.press('Enter');
    await page.waitForFunction((t) => document.querySelector('.vw-count').textContent !== t, firstHit);
    await page.waitForFunction(() => document.querySelector('.vw-pageinput').value === '4' || document.querySelector('.vw-pageinput').value === '2');
    await page.keyboard.press('Shift+Enter');
    assert.ok(await page.locator('.vw-mark').count() >= 1);
    await page.screenshot({ path: `${shots}/pdf-view-${label}-find.png` });
    await page.fill('.vw-find', 'nothing like this'); await page.press('.vw-find', 'Enter');
    await page.waitForFunction(() => document.querySelector('.vw-count').textContent === 'No matches');
    await page.press('.vw-find', 'Escape');

    // Text selection and copy through the text layer.
    await page.fill('.vw-pageinput', '1'); await page.press('.vw-pageinput', 'Enter');
    await page.waitForFunction(() => document.querySelector('.vw-page:first-child .vw-text span'));
    const selected = await page.evaluate(() => {
      const layer = document.querySelector('.vw-page .vw-text');
      const range = document.createRange(); range.selectNodeContents(layer);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      return sel.toString();
    });
    assert.match(selected, /Chapter 1/);
    assert.match(selected, /Go to chapter 4/);
    const copied = await page.evaluate(async () => { document.execCommand('copy'); return navigator.clipboard.readText().catch(() => null); });
    if (copied) assert.match(copied, /Chapter 1/); else console.log(`${label}: the clipboard cannot be read in this browser mode; the selection was checked instead`);
    // The text spans sit over the rendered words.
    const span = await page.$eval('.vw-page .vw-text span', (s) => { const r = s.getBoundingClientRect(); const p = s.closest('.vw-page').getBoundingClientRect(); return { x: (r.left - p.left) / p.width, y: (r.top - p.top) / p.height, w: r.width / p.width }; });
    assert.ok(Math.abs(span.x - 72 / 612) < 0.02 && Math.abs(span.y - 0.1) < 0.05 && span.w > 0.15 && span.w < 0.4, JSON.stringify(span));
    await page.evaluate(() => window.getSelection().removeAllRanges());

    // Links: internal ones jump, external ones ask first.
    await page.click('.vw-page >> nth=0 >> a.vw-link[aria-label="Go to page 4"]');
    await page.waitForFunction(() => document.querySelector('.vw-pageinput').value === '4');
    await page.fill('.vw-pageinput', '1'); await page.press('.vw-pageinput', 'Enter');
    await page.waitForSelector('.vw-page >> nth=0 >> a.vw-link[href="https://example.com/"]');
    const pages = context.pages().length;
    await page.click('.vw-page >> nth=0 >> a.vw-link[href="https://example.com/"]');
    await page.waitForSelector('.vw-linkbar:not([hidden])');
    assert.equal(context.pages().length, pages, 'no navigation before confirming');
    assert.equal(await page.getAttribute('.vw-open', 'rel'), 'noopener noreferrer');
    assert.equal(await page.getAttribute('.vw-open', 'target'), '_blank');
    assert.match(await page.textContent('.vw-linkbar'), /example\.com/);
    await page.click('.vw-linkbar button:has-text("Cancel")');
    assert.equal(await page.isVisible('.vw-linkbar'), false);

    // Sidebar: bookmarks and thumbnails.
    if (!(await page.isVisible('.vw-sidebar'))) await page.click('button[aria-label="Show or hide the sidebar"]');
    await page.waitForSelector('.vw-tab:has-text("Bookmarks"):not([hidden])');
    await page.click('.vw-tab:has-text("Bookmarks")');
    await page.click('.vw-outline button:has-text("Chapter 5")');
    await page.waitForFunction(() => document.querySelector('.vw-pageinput').value === '5');
    await page.click('.vw-tab:has-text("Pages")');
    await page.click('.vw-thumbs button[aria-label="Page 2"]');
    await page.waitForFunction(() => document.querySelector('.vw-pageinput').value === '2');
    await page.waitForFunction(() => [...document.querySelectorAll('.vw-thumbs li')].some((li) => li.dataset.drawn));

    // Rotating the view leaves the document alone.
    const [w0, h0] = await page.$eval('.vw-page', (p) => [p.offsetWidth, p.offsetHeight]);
    await page.click('button[aria-label="Rotate the view"]');
    await page.waitForFunction(([w, h]) => { const p = document.querySelector('.vw-page'); return p.offsetWidth / p.offsetHeight > 1 && w / h < 1; }, [w0, h0]);
    await page.screenshot({ path: `${shots}/pdf-view-${label}-rotated.png` });
    await page.click('#tab-organize');
    assert.doesNotMatch((await page.$$eval('#pages li.page', (lis) => lis.map((li) => li.getAttribute('aria-label')))).join(' '), /turned/);
    await page.click('#tab-view');
    await page.click('button[aria-label="Rotate the view"]'); await page.click('button[aria-label="Rotate the view"]'); await page.click('button[aria-label="Rotate the view"]');

    // Full screen on the viewer.
    await page.click('button[aria-label="Full screen"]');
    const full = await page.waitForFunction(() => document.fullscreenElement?.classList.contains('vw'), null, { timeout: 3000 }).then(() => true, () => false);
    if (full) { await page.screenshot({ path: `${shots}/pdf-view-${label}-fullscreen.png` }); await page.click('button[aria-label="Leave full screen"]'); await page.waitForFunction(() => !document.fullscreenElement); }
    else console.log(`${label}: full screen is not available in this browser mode`);

    // Dark theme and layout.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/pdf-view-${label}-dark.png`, fullPage: label === 'mobile' });
    await page.emulateMedia({ colorScheme: 'light' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${label}: page scrolls sideways by ${overflow}px`);
    if (label === 'mobile') {
      const scroller = await page.$eval('.vw-scroll', (s) => ({ scroll: s.scrollWidth, client: s.clientWidth }));
      assert.ok(scroller.scroll <= scroller.client + 1, 'fit width: no sideways scrolling inside the viewer');
      await page.screenshot({ path: `${shots}/pdf-view-${label}-full.png`, fullPage: true });
    }

    // A password-protected file opens in the viewer after the prompt.
    await page.click('#close');
    await page.setInputFiles('#file', join(dir, 'locked.pdf'));
    await page.waitForSelector('#unlock:not([hidden])');
    await page.fill('#unlock-password', 'open sesame');
    await page.press('#unlock-password', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#view-panel .vw-page').length === 5);
    await page.waitForFunction(() => document.querySelector('.vw-page canvas').width > 0);
    await page.fill('.vw-find', 'needle'); await page.press('.vw-find', 'Enter');
    await page.waitForFunction(() => /of 2/.test(document.querySelector('.vw-count').textContent));

    assert.deepEqual(requests.filter((u) => !u.startsWith(base) && !u.startsWith('blob:')), [], 'requests to other origins');
    assert.deepEqual(problems, [], `${label}: console problems`);
    await context.close();
    console.log(`ok ${label}`);
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log('pdf view browser checks passed');
