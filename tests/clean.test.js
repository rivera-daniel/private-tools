import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanImage } from '../site/lib/clean/index.js';
import { inspectImage } from '../site/lib/metadata/index.js';
import { base, tiff, exifSegment, xmpSegment, xmpPacket, segment, jpegWith, pngWith, tEXt, iTXt, chunk, webpWith, dms } from './fixtures/build.js';

const gps = [[0x0001, 2, 'N'], [0x0002, 5, dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, dms(97.74306)]];
const exifFor = (extra = []) => tiff([[0x010f, 2, 'Canon'], [0x0110, 2, 'Canon EOS R5'], ...extra], { exif: [[0xa431, 2, 'SN-0042-7781']], gps, thumbnail: Buffer.from(base.jpeg) });
const orientation = (n) => [0x0112, 3, [n]];
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
// Everything from the start of the scan to the end of the file.
const scanOnward = (u8) => Buffer.from(u8).subarray(Buffer.from(u8).indexOf(Buffer.from([0xff, 0xda])));

test('JPEG: location, serial, XMP, comment and trailer removed; image data identical', async () => {
  const original = Buffer.concat([jpegWith(exifSegment(exifFor()), xmpSegment(xmpPacket('xmp:CreatorTool="Midjourney v7">')), segment(0xfe, Buffer.from('secret note'))), Buffer.from('HIDDEN-TRAILER')]);
  const r = await cleanImage(original);
  assert.ok(r.ok, r.reason);
  const after = await inspectImage(r.data);
  assert.equal(after.cleanable.blocks, 0);
  assert.equal(after.sources.filter((s) => !s.technical).length, 0);
  assert.equal(after.signals.filter((s) => s.kind === 'privacy').length, 0);
  assert.equal(after.width, 16); assert.equal(after.height, 12);
  assert.ok(same(scanOnward(r.data), scanOnward(base.jpeg)), 'scan data and end marker unchanged');
  assert.ok(r.bytesAfter < r.bytesBefore);
  assert.ok(r.exposures.length > 0);
  assert.equal(r.orientation, 1);
});

test('JPEG: orientation survives alone', async () => {
  const r = await cleanImage(jpegWith(exifSegment(exifFor([orientation(6)]))));
  assert.ok(r.ok, r.reason);
  const after = await inspectImage(r.data);
  const ifd0 = after.sources.find((s) => s.name === 'EXIF IFD0');
  assert.deepEqual(ifd0.fields.map((f) => f.key), ['Orientation']);
  assert.equal(ifd0.fields[0].value, 'Rotate 90 CW');
  assert.equal(after.sources.find((s) => s.name === 'EXIF GPS'), undefined);
  assert.ok(r.kept[0].startsWith('Orientation'));
});

test('JPEG: an already clean file comes back byte for byte', async () => {
  const r = await cleanImage(base.jpeg);
  assert.ok(r.ok, r.reason);
  assert.ok(same(r.data, base.jpeg));
  assert.deepEqual(r.removed, []);
});

test('PNG: text, XMP, eXIf and time chunks removed; image chunks untouched', async () => {
  const original = pngWith(tEXt('parameters', 'a secret prompt'), iTXt('XML:com.adobe.xmp', xmpPacket('xmp:CreatorTool="Firefly">')), chunk('eXIf', exifFor([orientation(1)])), chunk('tIME', Buffer.from([7, 234, 10, 1, 9, 30, 0])));
  const r = await cleanImage(original);
  assert.ok(r.ok, r.reason);
  assert.ok(same(r.data, base.png));
  assert.equal((await inspectImage(r.data)).cleanable.blocks, 0);
});

test('PNG: orientation is written back as a valid eXIf chunk', async () => {
  const r = await cleanImage(pngWith(chunk('eXIf', exifFor([orientation(8)])), tEXt('Author', 'Jane')));
  assert.ok(r.ok, r.reason);
  const after = await inspectImage(r.data);
  const ifd0 = after.sources.find((s) => s.name === 'EXIF IFD0');
  assert.equal(ifd0.fields.length, 1);
  assert.equal(ifd0.fields[0].value, 'Rotate 270 CW');
  assert.equal(after.sources.find((s) => s.name === 'PNG text'), undefined);
  assert.deepEqual(after.warnings, []);
});

test('WebP: EXIF and XMP chunks removed, size and flags rewritten', async () => {
  const r = await cleanImage(webpWith({ EXIF: exifFor(), 'XMP ': Buffer.from(xmpPacket('xmp:CreatorTool="Firefly">')) }));
  assert.ok(r.ok, r.reason);
  assert.equal(new DataView(r.data.buffer, r.data.byteOffset).getUint32(4, true), r.data.length - 8);
  assert.equal(r.data[20] & 0x0c, 0);
  const after = await inspectImage(r.data);
  assert.equal(after.cleanable.blocks, 0);
  assert.equal(after.width, 16);
});

test('WebP: orientation kept and flagged in VP8X', async () => {
  const r = await cleanImage(webpWith({ EXIF: exifFor([orientation(3)]) }));
  assert.ok(r.ok, r.reason);
  assert.equal(r.data[20] & 0x08, 0x08);
  const after = await inspectImage(r.data);
  assert.equal(after.sources.find((s) => s.name === 'EXIF IFD0').fields[0].value, 'Rotate 180');
  assert.deepEqual(after.warnings, []);
});

test('GIF: comment and application extensions removed', async () => {
  const gif = readFileSync(new URL('./fixtures/formats/pii.gif', import.meta.url));
  const before = await inspectImage(gif);
  assert.ok(before.cleanable.blocks > 0);
  const r = await cleanImage(gif);
  assert.ok(r.ok, r.reason);
  const after = await inspectImage(r.data);
  assert.equal(after.cleanable.blocks, 0);
  assert.equal(after.width, before.width);
});

test('unsupported, damaged and non-image input is refused with a reason', async () => {
  const jxl = await cleanImage(readFileSync(new URL('./fixtures/formats/pii.jxl', import.meta.url)));
  assert.equal(jxl.ok, false); assert.match(jxl.reason, /cannot be cleaned yet/);
  assert.equal((await cleanImage(Buffer.from('not an image at all'))).ok, false);
  assert.equal((await cleanImage(pngWith(tEXt('a', 'b')).subarray(0, 60))).ok, false);
});

test('JPEG: a JFXX thumbnail segment is removed whole', async () => {
  const jfxx = segment(0xe0, Buffer.concat([Buffer.from('JFXX\0', 'latin1'), Buffer.from([0x10]), Buffer.from(base.jpeg)]));
  const r = await cleanImage(jpegWith(jfxx));
  assert.ok(r.ok, r.reason);
  assert.ok(r.removed.some((b) => b.kind === 'Thumbnail'));
  const after = await inspectImage(r.data);
  assert.deepEqual(after.warnings, []);
  assert.equal(after.cleanable.blocks, 0);
});

test('PNG: unknown critical chunks are kept, unknown ancillary chunks removed', async () => {
  const r = await cleanImage(pngWith(chunk('prVt', Buffer.from('private ancillary')), chunk('CRit', Buffer.from('critical'))));
  assert.ok(r.ok, r.reason);
  const types = (await inspectImage(r.data)).structure.map((s) => s.type);
  assert.ok(types.includes('CRit'), 'critical chunk kept');
  assert.ok(!types.includes('prVt'), 'ancillary chunk removed');
});

test('JPEG: a JFIF thumbnail is reported and removed, the JFIF header stays', async () => {
  const thumb = Buffer.alloc(48, 0x40); Buffer.from('preview pixels').copy(thumb, 3);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0, 16 + 48]), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 2, 1, 0, 72, 0, 72, 4, 4]), thumb]);
  const original = Buffer.concat([base.jpeg.subarray(0, 2), app0, base.jpeg.subarray(4 + base.jpeg.readUInt16BE(4))]);
  const before = await inspectImage(original);
  assert.ok(before.signals.some((s) => s.title === 'Embedded thumbnail preview'));
  assert.deepEqual(before.blocks.map((b) => b.kind), ['Thumbnail']);
  const r = await cleanImage(original);
  assert.ok(r.ok, r.reason);
  assert.ok(!Buffer.from(r.data).includes(Buffer.from('preview pixels')));
  assert.deepEqual([...r.data.subarray(0, 20)], [0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 0, 0]);
  const after = await inspectImage(r.data);
  assert.equal(after.cleanable.blocks, 0);
  assert.equal(after.width, 16);
});

test('a file the inspector could not fully read is refused rather than passed as clean', async () => {
  const { cleanFile } = await import('../site/lib/clean/index.js');
  const { readZip, readEntry, writeZip } = await import('../site/lib/zip/index.js');
  const { epub } = await import('./fixtures/documents.js');
  const zip = readZip(await epub()); const entries = [];
  for (const e of zip.entries) {
    const data = await readEntry(zip, e);
    // Break the package document: the inspector can no longer see its creator and identifiers.
    entries.push({ name: e.name, data: e.name.endsWith('content.opf') ? Buffer.from(Buffer.from(data).toString('utf8').replace('<metadata', '<metadata <')) : data, method: e.name === 'mimetype' ? 0 : 8 });
  }
  const r = await cleanFile(await writeZip(entries), 'book.epub');
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be (read|fully checked)/);
});

test('PNG: thousands of compressed text chunks stop at the decompression count and are refused', async () => {
  const { zTXt } = await import('./fixtures/build.js');
  const file = pngWith(...Array.from({ length: 1200 }, (_, i) => zTXt('Comment', `note ${i}`)));
  const before = await inspectImage(file);
  assert.ok(before.warnings.some((w) => /Too many compressed metadata blocks/.test(w)));
  assert.equal((await cleanImage(file)).ok, false);
});

test('HEIC: a file cut off inside a box is refused, not passed through with its metadata', async () => {
  const { cleanFile } = await import('../site/lib/clean/index.js');
  const { inspectFile } = await import('../site/lib/metadata/index.js');
  const heic = readFileSync(new URL('./fixtures/formats/pii.heic', import.meta.url));
  const cut = heic.subarray(0, 734);
  assert.ok((await inspectFile(cut, 'a.heic')).warnings.some((w) => /truncated/.test(w)));
  const r = await cleanFile(cut, 'a.heic');
  assert.equal(r.ok, false);
});

test('a cleaner that trips over a malformed structure refuses instead of throwing', async () => {
  const { cleanFile } = await import('../site/lib/clean/index.js');
  const avif = Buffer.from(readFileSync(new URL('./fixtures/formats/pii.avif', import.meta.url)));
  avif[276] = 16; // an item reference box that claims more entries than it holds
  const r = await cleanFile(avif, 'a.avif');
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be rewritten safely/);
});

// ---------- rulings on what is kept, replaced or refused ----------

test('a ZIP with Office or OpenDocument metadata parts that is no longer such a file is refused', async () => {
  const { cleanFile } = await import('../site/lib/clean/index.js');
  const { rawZip } = await import('./fixtures/documents.js');
  for (const name of ['docProps/core.xml', 'meta.xml']) {
    const zip = rawZip([{ name, data: Buffer.from('<x><creator>Jane Doe</creator></x>') }, { name: 'readme.txt', data: Buffer.from('hi') }]);
    const r = await cleanFile(zip, 'broken.zip');
    assert.equal(r.ok, false, name);
    assert.match(r.reason, /Office or OpenDocument/);
  }
});

test('EPUB: the package identifier, and toc.ncx with it, get a fresh urn:uuid on every clean', async () => {
  const { cleanFile } = await import('../site/lib/clean/index.js');
  const { readZip, readEntry } = await import('../site/lib/zip/index.js');
  const { epub } = await import('./fixtures/documents.js');
  const book = await epub();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await cleanFile(book, 'book.epub');
    assert.ok(r.ok, r.reason);
    assert.ok(r.removed.some((x) => x.kind === 'Book identifier'));
    const zip = readZip(r.data); const read = async (n) => Buffer.from(await readEntry(zip, zip.entries.find((e) => e.name === n))).toString('utf8');
    const opf = await read('OEBPS/content.opf'); const ncx = await read('OEBPS/toc.ncx');
    const id = /<dc:identifier id="uid">([^<]+)</.exec(opf)[1];
    assert.match(id, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.ok(!opf.includes('12345678-90ab-cdef') && !ncx.includes('12345678-90ab-cdef'));
    assert.ok(ncx.includes(`content="${id}"`));
    ids.push(id);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('JPEG: a kept color profile names its text in the kept list', async () => {
  const r = await cleanImage(readFileSync(new URL('./fixtures/camera-no-manifest.jpg', import.meta.url)));
  assert.ok(r.ok, r.reason);
  assert.ok(r.kept.some((k) => /^Color profile text: .*Description "sRGB IEC61966-2.1"/.test(k)), JSON.stringify(r.kept));
});
