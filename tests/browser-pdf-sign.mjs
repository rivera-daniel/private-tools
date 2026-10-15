// Browser check for the Sign mode of the PDF Editor. The module is mounted on a temporary harness page under
// /pdf-editor/ (so the editor's Content Security Policy applies), which this script writes into site/
// and always removes again. The harness renders with MuPDF and, like the editor, rebuilds the document in
// getBytes() while originalBytes() returns the untouched bytes.
// Signs with a .p12 file, countersigns, checks the result with the module's verifier and pdfsig, checks that
// the smart card option stays hidden on the hosted site, and the layout on desktop and phone.
// With SIGNER_PIN set and BASE pointing at the local card signer (local/signer/e2e.sh does this), it also
// signs with the card.
// Usage: BASE=http://host:port [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] [SIGNER_PIN=pin] node tests/browser-pdf-sign.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIdentity, classicPdf, pem } from './fixtures/pdf-sign.js';
import { verifyPdf, readCertificates } from '../site/lib/pdf-editor/sign.js';
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const base = process.env.BASE ?? 'http://127.0.0.1:4176';
const shots = process.env.SHOTS ?? 'test-results';
const pin = process.env.SIGNER_PIN ?? '';
mkdirSync(shots, { recursive: true });
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
if (!has('openssl')) { console.log('skipping: openssl is needed to build the test certificate file'); process.exit(0); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'pdf-editor');
const harnessDir = join(root, '__sign-harness__');
const editorDirExisted = existsSync(root);
const cleanup = () => { rmSync(harnessDir, { recursive: true, force: true }); if (!editorDirExisted) rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

mkdirSync(harnessDir, { recursive: true });
writeFileSync(join(harnessDir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign harness</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css"><script src="/assets/theme.js"></script></head>
<body><main class="wrap"><input type="file" id="doc" accept="application/pdf"><button type="button" id="edit">Simulate an edit</button>
<section id="sign-panel"></section></main><script type="module" src="./harness.js"></script></body></html>
`);
writeFileSync(join(harnessDir, 'harness.js'), `import * as mupdf from '/vendor/mupdf/mupdf.js';
import { mountSign } from '/lib/pdf-editor/sign-ui.js';
let bytes = null; let doc = null; let pristine = true; let handle = null;
window.__labels = []; window.__events = 0;
const open = (u8) => { doc?.destroy(); bytes = u8; doc = mupdf.Document.openDocument(u8.slice(), 'application/pdf'); };
const ctx = {
  getBytes: async () => { const out = doc.saveToBuffer('garbage'); try { return out.asUint8Array().slice(); } finally { out.destroy(); } },
  originalBytes: async () => (pristine ? bytes : null),
  setBytes: async (u8, label) => { open(u8); pristine = true; window.__labels.push(label); },
  pageCount: () => (doc ? doc.countPages() : 0),
  pageSize: (i) => { const p = doc.loadPage(i); try { const [x0, y0, x1, y1] = p.getBounds(); return { width: x1 - x0, height: y1 - y0 }; } finally { p.destroy(); } },
  renderPage: async (i, scale) => {
    const p = doc.loadPage(i);
    try {
      const pix = p.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true, true);
      try { return await createImageBitmap(new ImageData(new Uint8ClampedArray(pix.getPixels()), pix.getWidth(), pix.getHeight())); } finally { pix.destroy(); }
    } finally { p.destroy(); }
  },
};
const panel = document.getElementById('sign-panel');
panel.addEventListener('pdf-signed', () => { window.__events++; });
document.getElementById('doc').addEventListener('change', async (e) => {
  open(new Uint8Array(await e.target.files[0].arrayBuffer())); pristine = true; e.target.value = '';
  if (handle) await handle.refresh(); else handle = mountSign(panel, ctx);
  window.__handle = handle; document.body.dataset.ready = '1';
});
document.getElementById('edit').addEventListener('click', async () => { pristine = false; await handle.refresh(); });
window.__bytes = () => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); };
window.__signedMatches = () => { const s = handle.signedBytes(); return Boolean(s) && s.length === bytes.length && s.every((b, i) => b === bytes[i]); };
`);

const dir = mkdtempSync(join(tmpdir(), 'sign-ui-'));
const id = await makeIdentity('rsa', { cn: 'Browser Test Signer' });
writeFileSync(join(dir, 'key.pem'), pem('PRIVATE KEY', id.key.pkcs8));
writeFileSync(join(dir, 'leaf.pem'), pem('CERTIFICATE', id.leaf.der));
writeFileSync(join(dir, 'ca.pem'), pem('CERTIFICATE', id.ca.der));
writeFileSync(join(dir, 'ca.cer'), id.ca.der);
const p12 = spawnSync('openssl', ['pkcs12', '-export', '-inkey', join(dir, 'key.pem'), '-in', join(dir, 'leaf.pem'), '-certfile', join(dir, 'ca.pem'), '-out', join(dir, 'signer.p12'), '-passout', 'pass:test-password']);
assert.equal(p12.status, 0, String(p12.stderr));
writeFileSync(join(dir, 'document.pdf'), classicPdf());
const pdfsig = (path) => (has('pdfsig') ? spawnSync('pdfsig', [path], { encoding: 'utf8' }).stdout : null);
const trusted = readCertificates(readFileSync(join(dir, 'ca.pem')));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const problems = []; const requests = []; const allowed = [];
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !allowed.some((re) => re.test(m.text()))) problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(`${base}/pdf-editor/__sign-harness__/`, { waitUntil: 'networkidle' });
    const cardServed = await page.locator('meta[name="local-signer-token"]').count() > 0;
    await page.setInputFiles('#doc', join(dir, 'document.pdf'));
    await page.waitForSelector('body[data-ready="1"]');
    await page.waitForSelector('.sg-canvas');
    await page.waitForFunction(() => document.querySelector('.sg-sigs')?.textContent.includes('no digital signatures'));
    const cardOption = page.locator('label.sg-seg', { hasText: 'Smart card or USB token' });
    if (!cardServed) {
      assert.equal(await cardOption.isVisible(), false, 'card option hidden without the local signer');
      assert.deepEqual(requests.filter((u) => u.includes('/local-signer/')), [], 'no probe on the hosted site');
    }
    assert.ok(await page.locator('.sg-sign').isDisabled());
    assert.match(await page.locator('.sg-notes').textContent(), /Adobe shows the signer as unknown unless it trusts your certificate/);
    assert.match(await page.locator('.sg-notes').textContent(), /sign last/);
    await page.screenshot({ path: `${shots}/pdf-sign-${label}-empty.png`, fullPage: true });

    // A wrong password, then the right one.
    await page.setInputFiles('#sg-p12', join(dir, 'signer.p12'));
    await page.fill('#sg-password', 'nope');
    await page.click('button:has-text("Open")');
    await page.waitForSelector('.sg-pane .sg-error:not([hidden])');
    assert.match(await page.locator('.sg-pane .sg-error:not([hidden])').textContent(), /password is wrong/);
    await page.fill('#sg-password', 'test-password');
    await page.click('button:has-text("Open")');
    await page.waitForSelector('.sg-cert:not([hidden])');
    assert.match(await page.locator('.sg-cert').textContent(), /Browser Test Signer/);
    assert.match(await page.locator('.sg-cert').textContent(), /Test Root CA rsa/);
    assert.equal(await page.inputValue('#sg-password'), '', 'password cleared after opening');

    // Draw the box on page 2 (rotated by 90 degrees).
    await page.click('button[aria-label="Next page"]');
    await page.waitForFunction(() => document.querySelector('.sg-pagenum').textContent === 'Page 2 of 2');
    await page.waitForTimeout(150);
    const box = await page.locator('.sg-overlay').boundingBox();
    await page.locator('.sg-overlay').scrollIntoViewIfNeeded();
    const ob = await page.locator('.sg-overlay').boundingBox();
    await page.mouse.move(ob.x + ob.width * 0.1, ob.y + ob.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(ob.x + ob.width * 0.35, ob.y + ob.height * 0.25, { steps: 6 });
    await page.mouse.move(ob.x + ob.width * 0.45, ob.y + ob.height * 0.32, { steps: 6 });
    await page.mouse.up();
    assert.ok(box);
    assert.match(await page.locator('.sg-viewer .sg-hint').textContent(), /Signature box on page 2/);
    await page.fill('#sg-reason', 'Approved for release');
    await page.fill('#sg-location', 'Austin, Texas');
    await page.click('.sg-sign');
    await page.waitForSelector('.sg-confirm:not([hidden])');
    assert.match(await page.locator('.sg-confirm').textContent(), /Browser Test Signer adds a visible signature on page 2/);
    await page.screenshot({ path: `${shots}/pdf-sign-${label}-confirm.png`, fullPage: true });
    await page.click('button:has-text("Confirm signature")');
    await page.waitForSelector('.sg-result:not([hidden])');
    await page.waitForFunction(() => document.querySelector('.sg-sigs').textContent.includes('Valid'));
    assert.deepEqual(await page.evaluate(() => window.__labels), ['Signed']);
    assert.equal(await page.evaluate(() => window.__events), 1);
    assert.ok(await page.evaluate(() => window.__signedMatches()), 'signedBytes() is the working document');
    const once = Buffer.from(await page.evaluate(() => window.__bytes()), 'base64');
    writeFileSync(join(dir, `${label}-once.pdf`), once);
    const v1 = await verifyPdf(once, { trusted });
    assert.equal(v1.signatures.length, 1);
    assert.equal(v1.signatures[0].status, 'valid');
    assert.equal(v1.signatures[0].trust, 'trusted');
    assert.equal(v1.signatures[0].reason, 'Approved for release');
    const sig1 = pdfsig(join(dir, `${label}-once.pdf`));
    if (sig1 !== null) assert.match(sig1, /Signature is Valid/);
    await page.screenshot({ path: `${shots}/pdf-sign-${label}-signed.png`, fullPage: true });

    // An invisible countersignature keeps the first one valid because the exact bytes are signed.
    await page.check('input[name="sg-visible"][value="invisible"]');
    await page.click('.sg-sign');
    await page.click('button:has-text("Confirm signature")');
    await page.waitForFunction(() => document.querySelectorAll('.sg-sig').length === 2);
    const twice = Buffer.from(await page.evaluate(() => window.__bytes()), 'base64');
    writeFileSync(join(dir, `${label}-twice.pdf`), twice);
    const v2 = await verifyPdf(twice);
    assert.deepEqual(v2.signatures.map((s) => s.status), ['valid-later-signed', 'valid']);
    const sig2 = pdfsig(join(dir, `${label}-twice.pdf`));
    if (sig2 !== null) assert.equal((sig2.match(/Signature is Valid/g) ?? []).length, 2, sig2);

    // Trusting the root shows in the panel.
    await page.setInputFiles('#sg-trust', join(dir, 'ca.cer'));
    await page.waitForFunction(() => document.querySelector('.sg-sigs').textContent.includes('Chains to a root certificate you imported'));
    assert.match(await page.locator('.sg-trusted').textContent(), /Test Root CA rsa/);

    // After an edit the editor rebuilds the file: the panel says the results describe the edited copy.
    await page.click('#edit');
    await page.waitForFunction(() => document.querySelector('.sg-sigs').textContent.includes('edited after opening'));
    assert.equal(await page.evaluate(() => window.__handle.signedBytes()), null);
    // Signing the rebuilt copy works; the earlier signatures no longer match it.
    await page.click('.sg-sign');
    await page.click('button:has-text("Confirm signature")');
    await page.waitForFunction(() => document.querySelectorAll('.sg-sig').length === 3);
    const rebuilt = Buffer.from(await page.evaluate(() => window.__bytes()), 'base64');
    writeFileSync(join(dir, `${label}-rebuilt.pdf`), rebuilt);
    const v3 = await verifyPdf(rebuilt);
    assert.equal(v3.signatures.at(-1).status, 'valid');
    assert.ok(v3.signatures.slice(0, -1).every((s) => s.status === 'invalid'));
    const sig3 = pdfsig(join(dir, `${label}-rebuilt.pdf`));
    if (sig3 !== null) assert.ok((sig3.match(/Signature is Valid/g) ?? []).length >= 1, sig3);

    if (cardServed && pin) {
      await cardOption.waitFor({ state: 'visible' });
      await page.setInputFiles('#doc', join(dir, 'document.pdf'));
      await page.waitForFunction(() => document.querySelector('.sg-sigs')?.textContent.includes('no digital signatures'));
      await cardOption.click();
      await page.waitForSelector('.sg-cert:not([hidden])');
      const cards = await page.locator('#sg-card-cert option').allTextContents();
      assert.ok(cards.length >= 1, 'certificates listed from the card');
      for (const value of await page.locator('#sg-card-cert option').evaluateAll((os) => os.map((o) => o.value))) {
        await page.selectOption('#sg-card-cert', value);
        await page.check('input[name="sg-visible"][value="visible"]');
        await page.click('button:has-text("Place a box")');
        await page.fill('#sg-pin', pin);
        await page.click('.sg-sign');
        await page.click('button:has-text("Confirm signature")');
        await page.waitForSelector('.sg-result:not([hidden]), .sg-side > .sg-error:not([hidden])');
        const err = await page.locator('.sg-side > .sg-error:not([hidden])').count();
        assert.equal(err, 0, err ? await page.locator('.sg-side > .sg-error').textContent() : '');
        await page.waitForSelector('.sg-result:not([hidden])');
      }
      const carded = Buffer.from(await page.evaluate(() => window.__bytes()), 'base64');
      writeFileSync(join(dir, `${label}-card.pdf`), carded);
      const vc = await verifyPdf(carded);
      assert.ok(vc.signatures.length >= 1);
      assert.ok(vc.signatures.every((s) => s.status.startsWith('valid')), JSON.stringify(vc.signatures.map((s) => [s.status, s.problems])));
      const sc = pdfsig(join(dir, `${label}-card.pdf`));
      if (sc !== null) assert.equal((sc.match(/Signature is Valid/g) ?? []).length, vc.signatures.length, sc);
      // A wrong PIN is refused with the card signer's message (the browser logs the 401 response).
      allowed.push(/status of 401/);
      await page.fill('#sg-pin', '000000');
      await page.click('button:has-text("Place a box")');
      await page.click('.sg-sign');
      await page.click('button:has-text("Confirm signature")');
      await page.waitForSelector('.sg-side > .sg-error:not([hidden])');
      console.log(`card (${label}): signed with ${cards.length} certificate(s); wrong PIN: ${await page.locator('.sg-side > .sg-error').textContent()}`);
      await page.screenshot({ path: `${shots}/pdf-sign-${label}-card.png`, fullPage: true });
    }

    assert.deepEqual(requests.filter((u) => !u.startsWith(base) && !u.startsWith('blob:') && !u.startsWith('data:')), [], 'requests to other origins');
    assert.deepEqual(problems, [], `console problems on ${label}`);
    // Nothing overflows the phone viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px on ${label}`);
    await page.close();
    console.log(`ok ${label}${cardServed ? ' (card signer)' : ''}`);
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
}
