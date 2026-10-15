import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from '../site/vendor/mupdf/mupdf.js';
import {
  openPdf, buildDocument, buildBytes, saveDocument, splitDocument, protectPdf, unlockPdf, encryptOption, permissionValue,
  checkPassword, renderPage, pageImage, imagesToPdf, isSigned, PdfError, LOSSLESS,
} from '../site/lib/pdf-editor/index.js';
import { addWatermark, addPageNumbers, winAnsi, isLatin } from '../site/lib/pdf-editor/stamp.js';
import { downsampleImages } from '../site/lib/pdf-editor/compress.js';
import { fitScale, fitsPixels, pixelSize, RenderSizeError, RENDER_PIXELS, PREVIEW_PIXELS, THUMB_PIXELS, MAX_SIDE } from '../site/lib/pdf-editor/render-guard.js';
import { fromSource, rotatePages, removePages, duplicatePages, insertBlank, pickPages, movePagesTo, movePagesBy, entrySize } from '../site/lib/pdf-editor/plan.js';
import { parseRanges, splitEvery, onePerPage, formatPageLabel, groupLabel, PageRangeError } from '../site/lib/pdf-editor/ranges.js';
import { cleanFile } from '../site/lib/clean/index.js';
import { inspectFile } from '../site/lib/metadata/index.js';
import { textPdf, cornerPng, cornerJpeg, orientedJpeg, bloatedPdf, photoPdf, signedPdf } from './fixtures/pdf-editor.js';

const open = (bytes, password) => { const d = mupdf.Document.openDocument(bytes, 'application/pdf'); if (password) d.authenticatePassword(password); return d; };
const texts = (bytes, password) => {
  const d = open(bytes, password); const out = [];
  for (let i = 0; i < d.countPages(); i++) { const p = d.loadPage(i); out.push(p.toStructuredText().asText().trim().replace(/\s+/g, ' ')); p.destroy(); }
  d.destroy(); return out;
};
const rotations = (bytes) => { const d = open(bytes).asPDF(); const out = []; for (let i = 0; i < d.countPages(); i++) { const r = d.findPage(i).getInheritable('Rotate'); out.push(r.isNumber() ? r.asNumber() : 0); } d.destroy(); return out; };
const sourcesOf = (...files) => new Map(files.map((bytes, i) => [i, openPdf(bytes).source]));
// The colour at a fraction of a rendered page: 'red', 'white' or 'other'.
function colorAt(doc, index, fx, fy) {
  const { width, height, pixels } = renderPage(doc, index, 1);
  const o = (Math.floor(fy * height) * width + Math.floor(fx * width)) * 4;
  const [r, g, b] = pixels.subarray(o, o + 3);
  return r > 180 && g < 90 && b < 90 ? 'red' : r > 230 && g > 230 && b > 230 ? 'white' : 'other';
}

test('ranges: parse, split every N, one per page, labels', () => {
  assert.deepEqual(parseRanges('1-3, 5, 8-', 9), [[0, 1, 2], [4], [7, 8]]);
  assert.deepEqual(parseRanges('2', 3), [[1]]);
  assert.deepEqual(parseRanges('-2', 3), [[0, 1]]);
  for (const bad of ['', '0', '4', '3-2', 'a', '1-2-3']) assert.throws(() => parseRanges(bad, 3), PageRangeError, bad);
  assert.deepEqual(splitEvery(5, 2), [[0, 1], [2, 3], [4]]);
  assert.throws(() => splitEvery(5, 0), PageRangeError);
  assert.deepEqual(onePerPage(3), [[0], [1], [2]]);
  assert.equal(formatPageLabel('Page {n} of {total}', 2, 9), 'Page 2 of 9');
  assert.equal(groupLabel([0, 1, 2]), '1-3');
  assert.equal(groupLabel([4]), '5');
});

test('plan: rotate, remove, duplicate, insert blank, pick and move', () => {
  const plan = fromSource('a', 4);
  assert.deepEqual(rotatePages(plan, [1], 90)[1].rotate, 90);
  assert.deepEqual(rotatePages(rotatePages(plan, [1], -90), [1], -90)[1].rotate, 180);
  assert.deepEqual(removePages(plan, [0, 2]).map((e) => e.page), [1, 3]);
  const dup = duplicatePages(plan, [1], () => 'k');
  assert.deepEqual(dup.plan.map((e) => e.page), [0, 1, 1, 2, 3]);
  assert.equal(dup.plan[2].key, 'k'); assert.deepEqual(dup.indexes, [2]);
  const blank = insertBlank(plan, 2, [100, 200]);
  assert.deepEqual(blank.plan[2].blank, [100, 200]); assert.equal(blank.index, 2);
  assert.deepEqual(pickPages(plan, [3, 1]).map((e) => e.page), [1, 3]);
  assert.deepEqual(movePagesTo(plan, [0], 4).plan.map((e) => e.page), [1, 2, 3, 0]);
  assert.deepEqual(movePagesTo(plan, [2, 3], 0).plan.map((e) => e.page), [2, 3, 0, 1]);
  const moved = movePagesTo(plan, [0, 1], 3);
  assert.deepEqual(moved.plan.map((e) => e.page), [2, 0, 1, 3]); assert.deepEqual(moved.indexes, [1, 2]);
  assert.deepEqual(movePagesBy(plan, [1], -1).plan.map((e) => e.page), [1, 0, 2, 3]);
  assert.deepEqual(movePagesBy(plan, [2], 1).plan.map((e) => e.page), [0, 1, 3, 2]);
  assert.deepEqual(movePagesBy(plan, [3], 1).plan.map((e) => e.page), [0, 1, 2, 3]);
  assert.deepEqual(entrySize({ rotate: 90 }, [612, 792]), [792, 612]);
});

test('open reports pages, sizes and rejects what is not a PDF', () => {
  const r = openPdf(textPdf(3, 'A', { size: [300, 400], rotate: 90 }));
  assert.equal(r.pageCount, 3);
  assert.deepEqual(r.sizes[0], [400, 300]);
  assert.equal(r.encrypted, false); assert.equal(r.signed, false);
  assert.throws(() => openPdf(new TextEncoder().encode('not a pdf at all')), PdfError);
});

test('reorder, rotate, delete, duplicate and insert blank build the right document', () => {
  const sources = sourcesOf(textPdf(4, 'A'));
  let plan = fromSource(0, 4);
  plan = movePagesTo(plan, [3], 0).plan; // A4 A1 A2 A3
  plan = rotatePages(plan, [1], 90);
  plan = removePages(plan, [2]); // A4 A1 A3
  plan = duplicatePages(plan, [0]).plan; // A4 A4 A1 A3
  plan = insertBlank(plan, 2, [612, 792]).plan; // A4 A4 _ A1 A3
  const out = buildBytes(sources, plan);
  assert.deepEqual(texts(out), ['A 4', 'A 4', '', 'A 1', 'A 3']);
  assert.deepEqual(rotations(out), [0, 0, 0, 90, 0]);
  // The source is never changed by building.
  assert.deepEqual(texts(saveDocument(sources.get(0).doc)), ['A 1', 'A 2', 'A 3', 'A 4']);
});

test('merge keeps page order across files and adds to the page own rotation', () => {
  const sources = sourcesOf(textPdf(2, 'A'), textPdf(3, 'B', { rotate: 90 }));
  const plan = [...fromSource(0, 2), ...fromSource(1, 3)];
  [plan[1], plan[3]] = [plan[3], plan[1]];
  plan[2] = { ...plan[2], rotate: 90 };
  const out = buildBytes(sources, plan);
  assert.deepEqual(texts(out), ['A 1', 'B 2', 'B 1', 'A 2', 'B 3']);
  assert.deepEqual(rotations(out), [0, 90, 180, 0, 90]);
});

test('split by ranges, every N pages and one per page; extract selected pages', () => {
  const sources = sourcesOf(textPdf(5, 'S'));
  const plan = fromSource(0, 5);
  const parts = splitDocument(sources, plan, parseRanges('1-2, 4-', 5));
  assert.deepEqual(parts.map((p) => texts(p)), [['S 1', 'S 2'], ['S 4', 'S 5']]);
  assert.deepEqual(splitDocument(sources, plan, splitEvery(5, 2)).map((p) => texts(p).length), [2, 2, 1]);
  assert.deepEqual(splitDocument(sources, plan, onePerPage(5)).map((p) => texts(p)[0]), ['S 1', 'S 2', 'S 3', 'S 4', 'S 5']);
  assert.deepEqual(texts(buildBytes(sources, pickPages(plan, [4, 1]))), ['S 2', 'S 5']);
});

test('images to PDF: fit, A4 and Letter with margins; JPEG embedded as is without its metadata', async () => {
  const fit = await imagesToPdf([{ bytes: cornerPng(40, 30), name: 'a.png' }, { bytes: cornerJpeg(40, 30), name: 'b.jpg' }], { pageSize: 'fit' });
  assert.equal(fit.doc.countPages(), 2);
  const [, , fw, fh] = fit.doc.loadPage(0).getBounds();
  assert.equal(fw / fh, 40 / 30, 'page has the image proportions');
  assert.equal(colorAt(fit.doc, 0, 0.1, 0.1), 'red'); assert.equal(colorAt(fit.doc, 0, 0.9, 0.9), 'white');
  const bytes = saveDocument(fit.doc);
  const filters = []; const d = open(bytes).asPDF();
  for (let n = 1; n < d.countObjects(); n++) { const o = d.newIndirect(n).resolve(); if (o.isDictionary() && o.get('Subtype').isName() && o.get('Subtype').asName() === 'Image') filters.push(o.get('Filter').toString()); }
  assert.ok(filters.includes('/DCTDecode'), 'JPEG kept as DCT');
  const a4 = await imagesToPdf([{ bytes: cornerPng(40, 30), name: 'a.png' }], { pageSize: 'a4', margin: 36 });
  const [, , w, h] = a4.doc.loadPage(0).getBounds();
  assert.deepEqual([Math.round(w), Math.round(h)], [842, 595], 'landscape image turns the page');
  assert.equal(colorAt(a4.doc, 0, 0.02, 0.5), 'white', 'margin');
  const letter = await imagesToPdf([{ bytes: cornerPng(30, 40), name: 'p.png' }], { pageSize: 'letter' });
  assert.deepEqual(letter.doc.loadPage(0).getBounds(), [0, 0, 612, 792]);
  await assert.rejects(imagesToPdf([]), PdfError);
});

test('images to PDF: EXIF orientation is applied and location is removed', async () => {
  const six = await imagesToPdf([{ bytes: orientedJpeg(6, 40, 30), name: 'phone.jpg' }]);
  const [, , w, h] = six.doc.loadPage(0).getBounds();
  assert.equal(w / h, 30 / 40, 'portrait page');
  // Orientation 6 turns the image clockwise: its red top-left corner ends up top-right.
  assert.equal(colorAt(six.doc, 0, 0.85, 0.15), 'red');
  assert.equal(colorAt(six.doc, 0, 0.15, 0.15), 'white');
  const eight = await imagesToPdf([{ bytes: orientedJpeg(8, 40, 30), name: 'phone.jpg' }]);
  assert.equal(colorAt(eight.doc, 0, 0.15, 0.85), 'red');
  const bytes = saveDocument(six.doc);
  assert.ok(!Buffer.from(bytes).includes(Buffer.from('Canon')), 'EXIF removed from the embedded JPEG');
});

test('password: AES-256 (V 5, R 6), reopen with password, permissions, remove password', () => {
  const plain = textPdf(2, 'Secret');
  const locked = protectPdf(plain, { userPassword: 'open sesame', allow: { print: true, copy: false, edit: false } });
  const d = open(locked).asPDF();
  assert.equal(d.needsPassword(), true);
  const enc = d.getTrailer().get('Encrypt');
  assert.equal(enc.get('V').asNumber(), 5); assert.equal(enc.get('R').asNumber(), 6);
  assert.equal(d.authenticatePassword('wrong'), 0);
  assert.equal(d.authenticatePassword('open sesame'), 2, 'user, not owner: the owner password is random');
  assert.equal(d.hasPermission('print'), true); assert.equal(d.hasPermission('copy'), false); assert.equal(d.hasPermission('edit'), false);
  d.destroy();
  assert.deepEqual(texts(locked, 'open sesame'), ['Secret 1', 'Secret 2']);
  // A restricted file asks for the owner password before it can be edited.
  assert.equal(openPdf(locked).needsPassword, true);
  assert.equal(openPdf(locked, 'open sesame').ownerPassword, true);
  // Print and copy restrictions also need the owner password, with or without a user password.
  assert.equal(openPdf(protectPdf(plain, { userPassword: 'u', allow: { copy: false } }), 'u').ownerPassword, true);
  const src = open(plain).asPDF();
  const ownerOnly = src.saveToBuffer(`encrypt=aes-256,owner-password=o,permissions=${permissionValue({ print: false })}`).asUint8Array().slice();
  assert.equal(open(ownerOnly).needsPassword(), false, 'opens without a password');
  assert.equal(openPdf(ownerOnly).ownerPassword, true);
  assert.equal(openPdf(ownerOnly, 'wrong').wrongPassword, true);
  assert.equal(openPdf(ownerOnly, 'o').pageCount, 2);
  // With every permission allowed the user password also owns the file.
  const open2 = protectPdf(plain, { userPassword: 'pw' });
  assert.equal(open(open2).authenticatePassword('pw') & 4, 4);
  const opened = openPdf(open2, 'pw');
  assert.equal(opened.encrypted, true); assert.equal(opened.pageCount, 2);
  const unlocked = unlockPdf(open2, 'pw');
  assert.equal(open(unlocked).needsPassword(), false);
  assert.equal(open(unlocked).getMetaData('encryption'), 'None');
  assert.throws(() => unlockPdf(open2, 'nope'), PdfError);
  const owned = protectPdf(plain, { userPassword: 'u', ownerPassword: 'o', allow: { edit: false } });
  assert.deepEqual(texts(unlockPdf(owned, 'o')), ['Secret 1', 'Secret 2']);
  // Building from an encrypted source never keeps its encryption.
  const built = buildBytes(new Map([[0, opened.source]]), fromSource(0, 2));
  assert.equal(open(built).needsPassword(), false);
});

test('passwords MuPDF cannot carry are refused with a reason', () => {
  assert.throws(() => checkPassword('a,b'), /comma/);
  assert.throws(() => checkPassword(''), /empty/);
  assert.throws(() => encryptOption({ userPassword: 'x'.repeat(200) }), /127/);
  assert.equal(permissionValue() & 4, 4);
  assert.equal(permissionValue({ print: false }) & 4, 0);
  assert.ok(permissionValue({ print: false, copy: false, edit: false }) < 0, 'high bits set');
});

test('lossless compression shrinks a bloated file and keeps its pages', () => {
  const bloated = bloatedPdf();
  const sources = sourcesOf(bloated);
  const out = buildBytes(sources, fromSource(0, 4), { compress: true });
  assert.ok(out.length < bloated.length / 4, `${bloated.length} -> ${out.length}`);
  assert.deepEqual(texts(out), texts(bloated));
  assert.match(LOSSLESS, /garbage=deduplicate/);
});

test('image downsampling replaces oversized images with smaller JPEGs, the right way up', () => {
  const photo = photoPdf(1600, 1200);
  const doc = open(photo).asPDF();
  const before = colorAt(doc, 0, 0.5, 0.1);
  assert.equal(before, 'red');
  const result = downsampleImages(doc, { dpi: 72, quality: 70 });
  assert.equal(result.replaced, 1);
  assert.ok(result.after < result.before);
  const out = saveDocument(doc);
  assert.ok(out.length < photo.length, `${photo.length} -> ${out.length}`);
  const again = open(out).asPDF();
  assert.equal(colorAt(again, 0, 0.5, 0.1), 'red', 'top half still on top');
  assert.notEqual(colorAt(again, 0, 0.5, 0.9), 'red');
  const image = again.loadImage(again.loadPage(0).getObject().get('Resources', 'XObject', 'Im0'));
  assert.ok(image.getWidth() <= 400 && image.getHeight() <= 400, `${image.getWidth()}x${image.getHeight()}`);
  // Already small images are left alone.
  assert.equal(downsampleImages(open(textPdf(1)).asPDF(), { dpi: 72 }).replaced, 0);
});

test('watermark text is extractable on every page, including rotated pages', () => {
  const doc = open(textPdf(3, 'W', { rotate: 90 })).asPDF();
  assert.equal(addWatermark(doc, { text: 'CONFIDENTIAL', opacity: 0.3, rotation: 45, position: 'center' }), 3);
  const out = saveDocument(doc);
  for (const t of texts(out)) assert.match(t, /CONFIDENTIAL/);
  assert.match(texts(out)[0], /W 1/, 'original content kept');
  // Positioned and only on chosen pages.
  const doc2 = open(textPdf(3, 'W')).asPDF();
  addWatermark(doc2, { text: 'DRAFT', size: 30, rotation: 0, position: 'top-left', pages: [1] });
  const t2 = texts(saveDocument(doc2));
  assert.doesNotMatch(t2[0], /DRAFT/); assert.match(t2[1], /DRAFT/); assert.doesNotMatch(t2[2], /DRAFT/);
  const page = open(saveDocument(doc2)).loadPage(1);
  const hits = page.search('DRAFT');
  assert.ok(hits.length && hits[0][0][0] < 120 && hits[0][0][1] < 120, 'top-left');
  assert.throws(() => addWatermark(doc2, { text: '  ' }), PdfError);
});

test('page numbers with a format, start number and first page', () => {
  const doc = open(textPdf(4, 'N')).asPDF();
  addPageNumbers(doc, { format: 'Page {n} of {total}', position: 'bottom-right', start: 1 });
  const t = texts(saveDocument(doc));
  t.forEach((s, i) => assert.match(s, new RegExp(`Page ${i + 1} of 4`)));
  const page = open(saveDocument(doc)).loadPage(0);
  const q = page.search('Page 1 of 4')[0][0];
  assert.ok(q[0] > 400 && q[1] > 700, 'bottom right');
  const doc2 = open(textPdf(4, 'N')).asPDF();
  addPageNumbers(doc2, { format: '{n}', position: 'top-center', start: 10, from: 2 });
  const t2 = texts(saveDocument(doc2));
  assert.equal(t2[0], 'N 1'); assert.match(t2[1], /\b10\b/); assert.match(t2[3], /\b12\b/);
});

test('stamped text uses WinAnsi and flags characters it cannot show', () => {
  assert.deepEqual(winAnsi('A€é').codes, [0x41, 0x80, 0xe9]);
  assert.equal(winAnsi('日本').shown, '??');
  assert.equal(isLatin('Café – “ok”'), true); assert.equal(isLatin('Ωmega'), false);
});

test('rendering: thumbnails and page images', () => {
  const doc = open(textPdf(1, 'R', { size: [200, 100] })).asPDF();
  const t = renderPage(doc, 0, 0.5);
  assert.deepEqual([t.width, t.height, t.pixels.length], [100, 50, 100 * 50 * 4]);
  const turned = renderPage(doc, 0, 0.5, 90);
  assert.deepEqual([turned.width, turned.height], [50, 100]);
  const png = pageImage(doc, 0, { format: 'png', scale: 2 });
  assert.equal(png.data[0], 0x89); assert.equal(png.clamped, false); assert.equal(png.scale, 2);
  const jpg = pageImage(doc, 0, { format: 'jpeg', scale: 1, quality: 80 });
  assert.deepEqual([...jpg.data.subarray(0, 2)], [0xff, 0xd8]);
});

test('rendering: the pixel budget is applied from the page bounds before anything is allocated', () => {
  assert.deepEqual(pixelSize([0, 0, 200, 100], [0.5, 0, 0, 0.5, 0, 0]), { width: 100, height: 50 });
  assert.deepEqual(pixelSize([0, 0, 200, 100], [0, 0.5, -0.5, 0, 0, 0]), { width: 50, height: 100 });
  const huge = fitScale([0, 0, 100000, 100000], 0.25);
  assert.equal(huge.clamped, true);
  assert.ok(huge.width * huge.height <= RENDER_PIXELS && huge.width <= MAX_SIDE && huge.height <= MAX_SIDE);
  const thumb = fitScale([0, 0, 100000, 100000], 0.25, { maxPixels: THUMB_PIXELS });
  assert.ok(thumb.width * thumb.height <= THUMB_PIXELS);
  const strip = fitScale([0, 0, 1e9, 10], 1);
  assert.ok(strip.width <= MAX_SIDE && strip.height >= 1);
  assert.equal(fitScale([0, 0, 612, 792], 2).clamped, false);
  for (const bad of [[0, 0, NaN, 10], [0, 0, Infinity, 10], [0, 0, 0, 10], [10, 0, 0, 10], null]) assert.throws(() => fitScale(bad, 1), RenderSizeError);
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => fitScale([0, 0, 10, 10], bad), RenderSizeError);
  assert.equal(fitsPixels(8000, 6000), false); assert.equal(fitsPixels(4000, 3000), true); assert.equal(fitsPixels(NaN, 1), false);

  // A tiny file whose page claims 100,000 points square: the pixmap requested is within budget.
  const doc = open(textPdf(1, 'R')).asPDF();
  doc.findPage(0).put('MediaBox', [0, 0, 100000, 100000]);
  const real = mupdf.PDFPage.prototype.toPixmap;
  const asked = [];
  mupdf.PDFPage.prototype.toPixmap = function (matrix, ...rest) {
    const size = pixelSize(this.getBounds(), matrix);
    asked.push(size);
    if (size.width * size.height > RENDER_PIXELS) throw new Error('over budget');
    return real.call(this, matrix, ...rest);
  };
  try {
    const preview = renderPage(doc, 0, 0.25);
    assert.equal(preview.clamped, true);
    assert.ok(preview.width * preview.height <= PREVIEW_PIXELS);
    const image = pageImage(doc, 0, { format: 'png', scale: 0.25 });
    assert.equal(image.clamped, true); assert.ok(image.scale < 0.25);
    assert.ok(asked.length === 2 && asked.every((a) => a.width * a.height <= RENDER_PIXELS));
  } finally { mupdf.PDFPage.prototype.toPixmap = real; }
});

test('signed PDFs are detected', () => {
  const r = openPdf(signedPdf());
  assert.equal(r.signed, true);
  assert.equal(isSigned(open(textPdf(1)).asPDF()), false);
});

test('save pipeline: edits, then hidden data removed, then encryption; nothing comes back after re-saving', async () => {
  const sources = sourcesOf(textPdf(2, 'C', { info: { Author: 'Jane Roe', Title: 'Private plans' } }));
  const edited = buildBytes(sources, fromSource(0, 2));
  assert.ok((await inspectFile(edited, 'a.pdf')).blocks.some((b) => b.kind === 'Document info'));
  const cleaned = await cleanFile(edited, 'a.pdf', { removeSignatures: true });
  assert.ok(cleaned.ok, cleaned.reason);
  // Re-saved through MuPDF to compress again: no document info or XMP reappears.
  const resaved = saveDocument(open(cleaned.data).asPDF());
  const report = await inspectFile(resaved, 'a.pdf');
  assert.ok(!report.blocks.some((b) => /Document info|XMP/.test(b.kind)), report.blocks.map((b) => b.kind).join(', '));
  const locked = protectPdf(cleaned.data, { userPassword: 'pw' });
  assert.deepEqual(texts(locked, 'pw'), ['C 1', 'C 2']);
  assert.equal(open(locked, 'pw').getMetaData('info:Author'), undefined);
  // The cleaner refuses encrypted output, which is why cleaning comes first.
  const refused = await cleanFile(locked, 'a.pdf');
  assert.equal(refused.ok, false);
  // A signed source can be cleaned, dropping its signature, which the rewrite invalidated anyway.
  const signed = buildBytes(sourcesOf(signedPdf()), fromSource(0, 2));
  assert.equal((await cleanFile(signed, 'a.pdf', { removeSignatures: true })).ok, true);
});

test('building with no pages or a missing source fails with a reason', () => {
  assert.throws(() => buildDocument(new Map(), []), PdfError);
  assert.throws(() => buildDocument(new Map(), [{ src: 9, page: 0, rotate: 0 }]), PdfError);
});
