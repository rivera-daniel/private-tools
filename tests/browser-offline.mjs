// Browser check for offline use: every page is opened once online, then reloads and does its job with the
// network cut. Then a new deploy is simulated and must replace the old version on the next reload.
// The check serves its own copy of site/ so it can change files without touching the repository.
// Usage: [OFFLINE_PORT=4193] [CHROMIUM=/path] [PLAYWRIGHT_CORE=/path] node tests/browser-offline.mjs
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from './fixtures/build.js';
import { LIBARCHIVE_SAMPLES } from './fixtures/archive.js';
import { textPdf } from './fixtures/pdf-editor.js';
import { writeZip } from '../site/tools/lib/zip/index.js';
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const repo = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.OFFLINE_PORT ?? 4193);
const base = `http://127.0.0.1:${port}`;

const dir = mkdtempSync(join(tmpdir(), 'offline-'));
cpSync(join(repo, 'site'), join(dir, 'site'), { recursive: true });
const build = () => assert.equal(spawnSync('node', [join(repo, 'scripts/build-sw-manifest.mjs'), join(dir, 'site')], { stdio: 'ignore' }).status, 0, 'manifest build failed');
const version = () => JSON.parse(readFileSync(join(dir, 'site/tools/sw-manifest.json'), 'utf8')).version;
build();
const server = spawn('node', [join(repo, 'server.js')], { cwd: dir, env: { ...process.env, PORT: String(port + 1), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.once('data', resolve));
// A logging proxy in front of the server records every request that reaches the network, the service
// worker's own included.
const served = [];
const proxy = http.createServer((req, res) => {
  served.push(req.url);
  const upstream = http.request({ host: '127.0.0.1', port: port + 1, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(port, '127.0.0.1', resolve));

const exif = fx.tiff([[0x010f, 2, 'Canon']], { gps: [[0x0001, 2, 'N'], [0x0002, 5, fx.dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, fx.dms(97.74306)]] });
writeFileSync(`${dir}/photo.jpg`, fx.jpegWith(fx.exifSegment(exif)));
writeFileSync(`${dir}/notes.zip`, await writeZip([{ name: 'notes.txt', data: new TextEncoder().encode('offline notes') }]));
writeFileSync(`${dir}/hello.rar`, LIBARCHIVE_SAMPLES.rar5);
writeFileSync(`${dir}/alpha.pdf`, textPdf(3, 'Alpha'));

const PAGES = ['/tools/', '/tools/image-inspector/', '/tools/file-inspector/', '/tools/metadata-cleaner/', '/tools/archiver/', '/tools/pdf-editor/'];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/sbin/chromium' });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${page.url()}: ${m.text()} [${m.location().url}]`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  context.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  const requests = [];
  context.on('request', (r) => requests.push(r.url()));
  const cacheNames = () => page.evaluate(() => caches.keys());
  const cachedPaths = () => page.evaluate(async () => {
    const [name] = await caches.keys();
    return (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
  });
  // Runs an async check in the page until it returns true.
  const poll = (check, arg) => page.evaluate(async ({ source, arg }) => {
    const fn = (0, eval)(source);
    for (const end = Date.now() + 60000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await fn(arg)) return;
    throw new Error('timed out');
  }, { source: check.toString(), arg });
  const indicator = () => page.$eval('.offline-status', (n) => (n.hidden ? null : `${n.dataset.state}: ${n.textContent}`)).catch(() => null);

  // Online: each page registers the worker and reports when its files are stored.
  for (const path of PAGES) {
    await page.goto(base + path);
    await page.waitForSelector('html[data-offline-ready]', { timeout: 60000 });
    assert.equal(await indicator(), 'ready: Available offline', `${path} indicator online`);
  }
  const v1 = version();
  assert.deepEqual(await cacheNames(), [`private-tools-${v1}`]);
  const manifest = JSON.parse(readFileSync(join(dir, 'site/tools/sw-manifest.json'), 'utf8'));
  const stored = new Set(await cachedPaths());
  for (const path of [...manifest.shell, ...Object.values(manifest.tools).flat()]) assert.ok(stored.has(`/tools/${path}`), `${path} not stored`);
  assert.ok(stored.size <= Object.keys(manifest.files).length + 1, 'only listed files are stored');
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), `${base}/tools/sw.js`);

  // Offline: a URL that was never stored fails, which proves the cut reaches the worker too.
  await context.setOffline(true);
  const probe = await context.newPage();
  await assert.rejects(probe.goto(`${base}/tools/assets/fonts/INTER-LICENSE.txt`), 'unstored file loaded offline');
  await probe.close();

  for (const path of PAGES) {
    await page.goto(base + path);
    // Pages created during Chromium's offline emulation still start with navigator.onLine true, so toggle
    // the emulation to send the offline event the page listens for.
    await context.setOffline(false); await context.setOffline(true);
    assert.equal(await indicator(), 'offline: Offline', `${path} indicator offline`);
  }
  await page.goto(`${base}/tools/`);
  await page.reload();
  assert.ok(await page.$$eval('.card', (c) => c.length) > 0, 'catalog renders offline');

  await page.goto(`${base}/tools/image-inspector/`);
  await page.reload();
  await page.setInputFiles('#file', `${dir}/photo.jpg`);
  await page.waitForSelector('#results:not([hidden])', { timeout: 15000 });
  assert.equal(await page.$eval('#summary', (n) => n.dataset.level), 'exposed', 'image inspector offline');

  await page.goto(`${base}/tools/file-inspector/`);
  await page.reload();
  await page.setInputFiles('#file', `${dir}/photo.jpg`);
  await page.waitForSelector('#results:not([hidden])', { timeout: 15000 });
  assert.equal(await page.$eval('#summary', (n) => n.dataset.level), 'exposed', 'file inspector offline');

  await page.goto(`${base}/tools/metadata-cleaner/`);
  await page.reload();
  await page.setInputFiles('#file', `${dir}/photo.jpg`);
  await page.waitForFunction(() => ['done', 'error'].includes(document.querySelector('.job')?.dataset.state), null, { timeout: 15000 });
  assert.equal(await page.$eval('.job', (n) => n.dataset.state), 'done', 'cleaner offline');

  await page.goto(`${base}/tools/archiver/`);
  await page.reload();
  await page.click('#tab-open');
  await page.setInputFiles('#open-file', `${dir}/notes.zip`);
  await page.waitForSelector('#open-panel:not([hidden]), #open-error:not([hidden])', { timeout: 15000 });
  assert.match(await page.textContent('#archive-facts'), /^ZIP archive/);
  await page.click('#open-another');
  await page.setInputFiles('#open-file', `${dir}/hello.rar`);
  await page.waitForFunction(() => /^RAR 5 archive/.test(document.getElementById('archive-facts').textContent), null, { timeout: 15000 });

  await page.goto(`${base}/tools/pdf-editor/`);
  await page.reload();
  await page.setInputFiles('#file', `${dir}/alpha.pdf`);
  await page.waitForFunction(() => [...document.querySelectorAll('#pages li.page')].filter((li) => li.dataset.drawn?.startsWith('b')).length === 3, null, { timeout: 30000 });
  // Redact mode loads its module and engine on first use: those come from the cache too.
  await page.click('#tab-redact');
  await page.waitForFunction(() => document.getElementById('redact-panel').children.length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(1000);

  // A new deploy: a changed stylesheet gives a new version.
  await context.setOffline(false);
  appendFileSync(join(dir, 'site/tools/assets/site.css'), '\n.sw-update-check{display:none}\n');
  build();
  const v2 = version();
  assert.notEqual(v2, v1);
  const before = served.length;
  // The browser checks sw.js on navigation and installs the new version beside the old one. Once it is
  // installed, the next load with one tab open hands over and reloads once. The install usually finishes
  // while this first page is still loading, so the switch can happen on this load or on the next.
  const updated = () => page.waitForFunction(() => [...document.styleSheets].some((s) => [...s.cssRules].some((r) => r.selectorText === '.sw-update-check')), null, { timeout: 15000 });
  let navigations = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
  await page.goto(`${base}/tools/pdf-editor/`);
  if (!(await updated().then(() => true, () => false))) { await page.reload(); await updated(); }
  assert.ok(navigations <= 3, `${navigations} navigations to reach the new version`);
  await poll(async (name) => { const k = await caches.keys(); return k.length === 1 && k[0] === name; }, `private-tools-${v2}`);
  // Unchanged files were copied from the old cache: the MuPDF engine was not downloaded again.
  const fetched = served.slice(before);
  assert.ok(!fetched.includes('/tools/vendor/mupdf/mupdf-wasm.wasm'), 'engine downloaded again on update');
  assert.ok(fetched.includes('/tools/assets/site.css'), 'changed file fetched on update');
  // Every tool stays available offline in the new version.
  const after = new Set(await cachedPaths());
  for (const path of Object.values(manifest.tools).flat()) assert.ok(after.has(`/tools/${path}`), `${path} lost in update`);
  await context.setOffline(true);
  await page.goto(`${base}/tools/archiver/`);
  await page.click('#tab-open');
  await page.setInputFiles('#open-file', `${dir}/notes.zip`);
  await page.waitForSelector('#open-panel:not([hidden])', { timeout: 15000 });
  await context.setOffline(false);

  // With a second tab open, a newer deploy installs but waits, so neither tab mixes two versions.
  appendFileSync(join(dir, 'site/tools/assets/site.css'), '\n.sw-update-check-2{display:none}\n');
  build();
  const v3 = version();
  const second = await context.newPage();
  await second.goto(`${base}/tools/`);
  await page.goto(`${base}/tools/image-inspector/`);
  await poll(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
  await page.reload();
  await page.waitForSelector('html[data-offline-ready]', { state: 'attached' });
  const hasRule = (name) => page.evaluate((n) => [...document.styleSheets].some((s) => [...s.cssRules].some((r) => r.selectorText === n)), name);
  assert.equal(await hasRule('.sw-update-check-2'), false, 'switched with two tabs open');
  assert.deepEqual((await cacheNames()).sort(), [`private-tools-${v2}`, `private-tools-${v3}`].sort());
  await second.close();
  await page.reload();
  await page.waitForFunction(() => [...document.styleSheets].some((s) => [...s.cssRules].some((r) => r.selectorText === '.sw-update-check-2')), null, { timeout: 15000 });
  await poll(async (name) => { const k = await caches.keys(); return k.length === 1 && k[0] === name; }, `private-tools-${v3}`);

  const foreign = requests.filter((u) => !u.startsWith(base) && !/^(blob|data):/.test(u));
  assert.deepEqual(foreign, [], 'requests to other origins');
  assert.deepEqual(problems, [], `console problems: ${problems.join(' | ')}`);
  console.log(`offline: ${PAGES.length} pages work offline, update ${v1} -> ${v2} applied on one reload, ${v3} held while two tabs were open`);
} finally {
  await browser.close();
  server.kill();
  proxy.close();
  rmSync(dir, { recursive: true, force: true });
}
