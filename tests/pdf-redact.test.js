import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from '../site/tools/vendor/mupdf/mupdf.js';
import { openPdf, findText, redact, checkRedactions, verifyRedaction, normalizeMarks, planRedaction, otherOccurrences, documentInfo, pageInfo, showAllLayers, PRESETS } from '../site/tools/lib/pdf-editor/redact.js';
import * as fx from './fixtures/pdf-redact.js';

mupdf.setLog?.(() => {});

const open = (bytes, password) => openPdf(mupdf, bytes, password);
const pagesText = (bytes) => { const d = open(bytes); showAllLayers(d); const out = []; for (let i = 0; i < d.countPages(); i++) out.push(d.loadPage(i).toStructuredText('preserve-whitespace,clip=no').asText()); return out; };
const allText = (bytes) => pagesText(bytes).join('\n');
// Every object and every decompressed stream, as Latin-1 text.
function everything(bytes) {
  const d = open(bytes); let s = Buffer.from(bytes).toString('latin1');
  for (let i = 1; i < d.countObjects(); i++) {
    const ref = d.newIndirect(i);
    s += `\n${ref.resolve().toString()}`;
    if (ref.isStream()) s += `\n${Buffer.from(ref.readStream().asUint8Array()).toString('latin1')}`;
  }
  return s;
}
// Like the worker: search sees every layer.
const find = (bytes, q, o) => { const d = open(bytes); showAllLayers(d); return findText(d, q, o).matches; };
const markOf = (m) => ({ page: m.page, quads: m.quads, text: m.text });
const images = (bytes, page) => {
  const d = open(bytes); const found = [];
  const dev = new mupdf.Device({ fillImage(img, ctm) { found.push(ctm); } });
  d.loadPage(page).runPageContents(dev, mupdf.Matrix.identity); dev.close();
  return found.length;
};
function pixel(bytes, page, x, y) {
  const pix = open(bytes).loadPage(page).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const o = (Math.round(y) - pix.getY()) * pix.getStride() + (Math.round(x) - pix.getX()) * 3;
  return [...pix.getPixels().slice(o, o + 3)];
}

test('text under a mark is gone from the page text and the decompressed file; other text stays', async () => {
  const src = fx.personal();
  const [ssn] = find(src, '', { preset: 'ssn' });
  const r = await redact(mupdf, src, [markOf(ssn)]);
  assert.ok(r.ok, r.reason);
  const text = allText(r.data);
  assert.ok(!text.includes('123-45-6789'));
  assert.ok(!everything(r.data).includes('123-45-6789'));
  for (const kept of ['SSN', 'on file', 'Public line stays', 'Second page with ordinary text', 'John Secretman']) assert.ok(text.includes(kept), kept);
  assert.equal(open(r.data).countPages(), 2);
  assert.ok(r.verification.ok);
  assert.ok(r.verification.checks.some((c) => /decompressed streams/.test(c)));
  assert.deepEqual(r.removed.filter((x) => x.kind === 'Page text').map((x) => x.text), ['123-45-6789']);
});

test('a drawn rect over part of a word removes only the covered letters', async () => {
  const src = fx.personal();
  const [m] = find(src, 'Secretman');
  const q = m.quads[0];
  const width = q[2] - q[0];
  // Covers roughly "Secr".
  const rect = [q[0] - 1, q[1], q[0] + width * 0.4, q[5]];
  const r = await redact(mupdf, src, [{ page: 0, rect }]);
  assert.ok(r.ok, r.reason);
  const page = pagesText(r.data)[0];
  assert.ok(!page.includes('Secretman'));
  assert.ok(/John/.test(page) && /etman|tman/.test(page), page);
  const gone = r.removed.find((x) => x.kind === 'Page text').text;
  assert.ok(gone.startsWith('Sec'), gone);
});

test('images under a mark: covered pixels blanked, or the image removed', async () => {
  const src = fx.withImage();
  // The image covers x 300..400, y 192..292 in page space. Mark its top-left quarter.
  const mark = { page: 0, rect: [290, 182, 350, 242] };
  const blank = await redact(mupdf, src, [mark], { images: 'blank-pixels', fill: false });
  assert.ok(blank.ok, blank.reason);
  assert.equal(images(blank.data, 0), 1, 'the image stays');
  assert.deepEqual(pixel(blank.data, 0, 320, 210), [255, 255, 255], 'covered pixels are blank');
  assert.notDeepEqual(pixel(blank.data, 0, 390, 285), [255, 255, 255], 'the rest of the image is untouched');
  assert.ok(blank.verification.checks.includes('No image shows anything under the marks'));
  assert.ok(blank.removed.some((x) => x.kind === 'Images'));

  const gone = await redact(mupdf, src, [mark], { images: 'remove-overlapping' });
  assert.ok(gone.ok, gone.reason);
  assert.equal(images(gone.data, 0), 0);
  assert.deepEqual(pixel(gone.data, 0, 320, 210), [0, 0, 0], 'black box drawn');

  const kept = await redact(mupdf, src, [mark], { images: 'none', fill: false });
  assert.ok(kept.ok, kept.reason);
  assert.notDeepEqual(pixel(kept.data, 0, 320, 210), [255, 255, 255], 'images: none leaves the image');
});

test('outline titles, form values, structure and marked-content text, page labels, info and XMP lose the secret', async () => {
  const src = fx.leaky();
  const [m] = find(src, 'John Secretman');
  const r = await redact(mupdf, src, [markOf(m)], { label: '[REDACTED]' });
  assert.ok(r.ok, r.reason);
  const all = everything(r.data);
  assert.ok(!/secretman/i.test(all), 'no trace in any object or stream');
  assert.ok(!/secretman/i.test(allText(r.data)));
  const d = open(r.data);
  assert.deepEqual(d.loadOutline().map((o) => o.title), ['Notes about [redacted]', 'Appendix']);
  assert.deepEqual(d.loadPage(0).getWidgets().map((w) => w.getValue()), ['', '']);
  assert.ok(allText(r.data).includes('[REDACTED]'), 'label drawn');
  const kinds = new Set(r.removed.map((x) => x.kind));
  for (const k of ['Title', 'Form field value', 'Alternate text', 'Actual text', 'Marked content text', 'Page label', 'Document info', 'XMP']) assert.ok(kinds.has(k), k);
  assert.ok(!all.includes('Records'), 'document info gone');
  assert.ok(allText(r.data).includes('Public line stays'));
});

test('a scanned page: the OCR word and the pixels under the mark go, and the check passes', async () => {
  const w = 612; const h = 792;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels(); const stride = pix.getStride();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * stride + x * 3; px[o] = 200 + (x % 50); px[o + 1] = 190 + (y % 60); px[o + 2] = (x * y) % 256; }
  const jpeg = pix.asJPEG(75, false).slice();
  const src = fx.scanned(jpeg, w, h);
  const [m] = find(src, 'Scannedname');
  assert.ok(m, 'OCR text is searchable');
  const r = await redact(mupdf, src, [markOf(m)], { images: 'blank-pixels' });
  assert.ok(r.ok, `${r.reason} ${JSON.stringify(r.verification?.leftovers)}`);
  const text = allText(r.data);
  assert.ok(!text.includes('Scannedname'));
  assert.ok(text.includes('Ward seven notes') && text.includes('Patient'));
  assert.ok(r.verification.checks.includes('No image shows anything under the marks'));
  assert.deepEqual(checkRedactions(mupdf, open(r.data)).pages, []);
  const c = [(m.rect[0] + m.rect[2]) / 2, (m.rect[1] + m.rect[3]) / 2];
  assert.deepEqual(pixel(r.data, 0, c[0], c[1]), [0, 0, 0]);
});

test('lines set closer than the font size: matches go, neighbouring lines and punctuation stay', async () => {
  const src = fx.tightLines();
  const words = (bytes) => pagesText(bytes)[0].split(/\s+/).filter(Boolean);
  for (const query of ['Jean-Marc', 'preprocessor']) {
    const ms = find(src, query);
    const r = await redact(mupdf, src, ms.map(markOf));
    assert.ok(r.ok, `${query}: ${r.reason}`);
    const before = words(src).filter((w) => !w.includes(query));
    const after = words(r.data);
    assert.ok(!after.some((w) => w.includes(query)), query);
    assert.deepEqual(before.filter((w) => !after.includes(w)), [], `${query}: nothing else removed`);
    assert.deepEqual(r.removed.filter((x) => x.kind === 'Page text').map((x) => x.text), [query], `${query}: only the match is reported`);
  }
  // A drawn box over a word in the dense lines may clip letters it grazes; it must still verify.
  const [m] = find(src, 'Jean-Marc');
  const drawn = await redact(mupdf, src, [{ page: 0, rect: [m.rect[0] - 2, m.rect[1] - 2, m.rect[2] + 2, m.rect[3] + 2] }]);
  assert.ok(drawn.ok, drawn.reason);
  assert.ok(!allText(drawn.data).includes('Jean-Marc'));
});

test('earlier revisions holding the secret are gone', async () => {
  const src = fx.revised();
  assert.ok(Buffer.from(src).toString('latin1').includes('Draft note'));
  const [m] = find(src, 'ACCT-99-SECRET');
  const r = await redact(mupdf, src, [markOf(m)]);
  assert.ok(r.ok, r.reason);
  const all = everything(r.data);
  assert.ok(!all.includes('ACCT-99-SECRET'));
  assert.ok(!all.includes('Draft note'), 'earlier revision dropped');
  assert.ok(allText(r.data).includes('Final wording here'));
  assert.equal((Buffer.from(r.data).toString('latin1').match(/startxref/g) ?? []).length, 1);
});

test('rasterize: marked pages become images with the boxes burned in; other pages keep their text', async () => {
  const src = fx.leaky();
  const [m] = find(src, 'John Secretman');
  const r = await redact(mupdf, src, [markOf(m)], { mode: 'rasterize', dpi: 100 });
  assert.ok(r.ok, r.reason);
  const [p1, p2] = pagesText(r.data);
  assert.equal(p1.trim(), '');
  assert.ok(p2.includes('Second page with ordinary text'));
  assert.ok(!/secretman/i.test(everything(r.data)));
  const c = [(m.rect[0] + m.rect[2]) / 2, (m.rect[1] + m.rect[3]) / 2];
  assert.ok(pixel(r.data, 0, c[0], c[1]).every((v) => v < 30), 'box burned in');
  assert.equal(images(r.data, 0), 1);
  const d = open(r.data);
  assert.equal(d.loadPage(0).getWidgets().length, 0, 'form fields on the page went into the image');
  assert.ok(!everything(r.data).includes('(overlay)'), 'field names gone');
  assert.ok(r.verification.checks.includes('The rasterized pages show only the boxes under the marks'));
});

test('presets find the right strings and skip lookalikes', () => {
  const src = fx.personal();
  const got = Object.fromEntries(PRESETS.map((p) => [p.id, find(src, '', { preset: p.id }).map((m) => m.text)]));
  assert.deepEqual(got.ssn, ['123-45-6789']);
  assert.deepEqual(got.email, ['jane.doe@example.org']);
  assert.deepEqual(got.card, ['4111 1111 1111 1111'], 'the number failing the Luhn check is skipped');
  assert.deepEqual(got.iban, ['GB82 WEST 1234 5698 7654 32']);
  assert.deepEqual(got.date, ['1984-03-07']);
  assert.deepEqual(got.phone, ['+1 512-555-0143']);
});

test('search options: case, whole word, regex, and matches across words', () => {
  const src = fx.personal();
  assert.equal(find(src, 'john secretman').length, 1);
  assert.equal(find(src, 'john secretman', { caseSensitive: true }).length, 0);
  assert.equal(find(src, 'Secret', { wholeWord: true }).length, 0);
  assert.equal(find(src, 'Secret').length, 1);
  assert.deepEqual(find(src, 'Pub\\w+ line', { regex: true }).map((m) => m.text), ['Public line']);
  assert.throws(() => findText(open(src), '(', { regex: true }), /not a valid regular expression/);
  assert.throws(() => findText(open(src), '   '), /Enter something/);
  const m = find(src, 'ordinary');
  assert.equal(m[0].page, 1);
  assert.equal(find(src, '\\b', { regex: true }).length, 0, 'empty matches are skipped');
});

test('fake redactions: text under a black box is reported with the hidden text; real redactions are not', async () => {
  const src = fx.fakeRedaction();
  const found = checkRedactions(mupdf, open(src));
  assert.equal(found.pages.length, 1);
  assert.equal(found.pages[0].page, 0);
  assert.equal(found.pages[0].boxes.length, 1);
  assert.match(found.pages[0].text, /Hiddenname/);
  const box = found.pages[0].boxes[0];
  // Redacting the reported box for real removes the hidden text.
  const r = await redact(mupdf, src, [{ page: 0, rect: box.rect, text: box.text }]);
  assert.ok(r.ok, r.reason);
  assert.ok(!allText(r.data).includes('Hiddenname'));
  assert.deepEqual(checkRedactions(mupdf, open(r.data)).pages, [], 'own output reads as clean');

  const img = await redact(mupdf, fx.withImage(), [{ page: 0, rect: [290, 182, 350, 242] }], { images: 'blank-pixels' });
  assert.deepEqual(checkRedactions(mupdf, open(img.data)).pages, [], 'blanked image under a box hides nothing');
  assert.deepEqual(checkRedactions(mupdf, open(fx.personal())).pages, []);
});

test('verification refuses: a mark that misses its text, and an output that still holds it', async () => {
  const src = fx.personal();
  const [m] = find(src, '', { preset: 'ssn' });
  const shifted = { page: 0, quads: m.quads.map((q) => q.map((v, i) => (i % 2 ? v + 40 : v))), text: m.text };
  const r = await redact(mupdf, src, [shifted]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'miss');
  assert.equal(r.data, undefined);
  assert.match(r.reason, /does not cover/);

  const doc = open(src); showAllLayers(doc);
  const marks = normalizeMarks([markOf(m)], pageInfo(doc));
  const plan = planRedaction(doc, marks);
  const v = verifyRedaction(mupdf, src, { pages: 2, marks, plan });
  assert.equal(v.ok, false);
  assert.ok(v.leftovers.some((l) => l.kind === 'Page text' && l.text === '123-45-6789'));
  assert.ok(v.leftovers.some((l) => /revision/.test(l.kind)) === false);
  const rev = verifyRedaction(mupdf, fx.revised(), { pages: 2, marks: [], plan: { strings: [] } });
  assert.ok(rev.leftovers.some((l) => /earlier revisions/.test(l.kind)));
});

test('other occurrences of the redacted text are reported', async () => {
  const src = fx.personal({ lines: ['BT /F1 12 Tf 72 720 Td (Name: John Secretman) Tj ET', 'BT /F1 12 Tf 72 600 Td (Signed by John Secretman) Tj ET'].join('\n') });
  const doc = open(src);
  const [first] = findText(doc, 'John Secretman').matches;
  const marks = normalizeMarks([markOf(first)], pageInfo(doc));
  const plan = planRedaction(doc, marks);
  const other = otherOccurrences(doc, marks, plan);
  assert.equal(other.length, 1);
  assert.equal(other[0].count, 1);
  const r = await redact(mupdf, src, [markOf(first)]);
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.verification.elsewhere, [{ text: 'John Secretman', count: 1 }]);
});

test('rotated pages and crop boxes with an offset', async () => {
  for (const page of ['/Rotate 90', '/CropBox [40 80 500 760]', '/Rotate 270 /CropBox [40 80 500 760]']) {
    const src = fx.rotated(page);
    const info = documentInfo(open(src));
    const [m] = find(src, 'ROT-4421');
    assert.ok(m, page);
    const b = info.pages[0].bounds;
    assert.ok(m.rect[0] >= b[0] && m.rect[2] <= b[2] && m.rect[1] >= b[1] && m.rect[3] <= b[3], `${page}: match inside the page bounds`);
    const r = await redact(mupdf, src, [markOf(m)], { label: 'X' });
    assert.ok(r.ok, `${page}: ${r.reason}`);
    assert.ok(!everything(r.data).includes('ROT-4421'), page);
    assert.ok(allText(r.data).includes('Public line stays'), page);
    const rect = { page: 0, rect: m.rect };
    const r2 = await redact(mupdf, src, [rect], { mode: 'rasterize', dpi: 72 });
    assert.ok(r2.ok, `${page}: ${r2.reason}`);
    const c = [(m.rect[0] + m.rect[2]) / 2, (m.rect[1] + m.rect[3]) / 2];
    assert.ok(pixel(r2.data, 0, c[0], c[1]).every((v) => v < 30), `${page}: box burned where the text was`);
  }
});

test('text on a hidden layer and inside form XObjects is redacted too', async () => {
  const hidden = fx.hiddenLayer();
  const [m] = find(hidden, 'LayerSecret-5531');
  assert.ok(m, 'search sees hidden layers');
  const r = await redact(mupdf, hidden, [markOf(m)]);
  assert.ok(r.ok, r.reason);
  assert.ok(!everything(r.data).includes('LayerSecret'));
  assert.ok(everything(r.data).includes('/OFF'), 'the layer stays hidden');

  const form = fx.withForm();
  const [f] = find(form, 'PASSPORT-X7781');
  const r2 = await redact(mupdf, form, [markOf(f)]);
  assert.ok(r2.ok, r2.reason);
  assert.ok(!everything(r2.data).includes('PASSPORT-X7781'));
  assert.ok(allText(r2.data).includes('Inside form'));
});

test('encrypted PDFs need the password and come out unencrypted; signed PDFs need consent', async () => {
  const d = open(fx.personal());
  const locked = d.saveToBuffer('encrypt=aes-256,user-password=open sesame,owner-password=owner').asUint8Array().slice();
  const [m] = find(fx.personal(), '', { preset: 'ssn' });
  assert.equal((await redact(mupdf, locked, [markOf(m)])).code, 'password');
  assert.equal((await redact(mupdf, locked, [markOf(m)], { password: 'nope' })).code, 'wrong-password');
  const r = await redact(mupdf, locked, [markOf(m)], { password: 'open sesame' });
  assert.ok(r.ok, r.reason);
  assert.ok(!Buffer.from(r.data).toString('latin1').includes('/Encrypt'));
  assert.ok(r.removed.some((x) => x.kind === 'Encryption'));
  assert.ok(!allText(r.data).includes('123-45-6789'));

  const sig = fx.signed();
  assert.equal(documentInfo(open(sig)).signed, true);
  const refused = await redact(mupdf, sig, [markOf(m)]);
  assert.equal(refused.code, 'signed');
  const done = await redact(mupdf, sig, [markOf(m)], { allowSignatureLoss: true });
  assert.ok(done.ok, done.reason);
  assert.ok(!/\/Sig\b/.test(everything(done.data)));
});

test('hostile and odd input is refused cleanly', async () => {
  const src = fx.personal();
  const cases = [
    [new Uint8Array(0), [{ page: 0, rect: [0, 0, 10, 10] }], 'not-pdf'],
    [new TextEncoder().encode('not a pdf at all'), [{ page: 0, rect: [0, 0, 10, 10] }], 'not-pdf'],
    [src, [], 'marks'],
    [src, [{ page: 5, rect: [0, 0, 10, 10] }], 'marks'],
    [src, [{ page: 0, rect: [0, 0, NaN, 10] }], 'marks'],
    [src, [{ page: 0, rect: [-50, -50, -10, -10] }], 'marks'],
    [src, [{ page: 0 }], 'marks'],
    [src, [{ page: '0', rect: [0, 0, 10, 10] }], 'marks'],
    [src, Array.from({ length: 6000 }, () => ({ page: 0, rect: [0, 0, 10, 10] })), 'marks'],
    [src, [{ page: 0, rect: [0, 0, 10, 10] }], 'bad-options', { mode: 'shred' }],
  ];
  for (const [bytes, marks, code, options] of cases) {
    const r = await redact(mupdf, bytes, marks, options);
    assert.equal(r.ok, false);
    assert.equal(r.code, code, r.reason);
    assert.equal(r.data, undefined);
  }
  // A truncated file is repaired by MuPDF or refused, never a crash.
  const cut = src.subarray(0, Math.floor(src.length * 0.7));
  const r = await redact(mupdf, cut, [{ page: 0, rect: [60, 50, 300, 80] }]);
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) assert.ok(r.verification.ok);
  // A mark over empty space is fine and changes nothing visible.
  const empty = await redact(mupdf, src, [{ page: 1, rect: [300, 400, 400, 500] }]);
  assert.ok(empty.ok, empty.reason);
  assert.ok(allText(empty.data).includes('123-45-6789'));
});
