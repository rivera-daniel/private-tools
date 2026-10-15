import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanFile, cleanImage } from '../site/tools/lib/clean/index.js';
import { inspectFile } from '../site/tools/lib/metadata/index.js';
import { tiff, xmpPacket, dms } from './fixtures/build.js';
import { heif, heifItems, box, fullBox, ispe, hvcC, av1C, irot, auxC, colrNclx, exifItem, grid, tiffFile, tiffPages } from './fixtures/images-extra.js';

const fixture = (path) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url));
const gps = [[0x0001, 2, 'N'], [0x0002, 5, dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, dms(97.74306)]];
const exifTiff = (extra = []) => tiff([[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15 Pro'], ...extra], { exif: [[0xa431, 2, 'SN-0042-7781']], gps });
const xmp = Buffer.from(xmpPacket('xmp:CreatorTool="Firefly" dc:creator="Jane Doe">'));
const coded = (label, n = 64) => Buffer.from(label.padEnd(n, '.'));
const METADATA_SOURCES = /^(EXIF|XMP|IPTC|Photoshop|Maker notes)/;

// The cleaned file has no metadata, the same size and format, and every kept item's bytes unchanged.
async function cleanHeifAndCheck(input, name = 'photo.heic') {
  const before = await inspectFile(input, name);
  const r = await cleanFile(input, name);
  assert.ok(r.ok, r.reason);
  const after = await inspectFile(r.data, name);
  assert.equal(after.cleanable.blocks, 0);
  assert.deepEqual(after.warnings, []);
  assert.equal(after.format, before.format); assert.equal(after.width, before.width); assert.equal(after.height, before.height);
  assert.equal(after.sources.filter((s) => METADATA_SOURCES.test(s.name)).length, 0);
  assert.ok(!after.signals.some((s) => s.title === 'Exact location stored' || s.title === 'Embedded thumbnail preview'));
  const old = heifItems(input); const now = heifItems(r.data);
  for (const [id, it] of now) assert.ok(Buffer.compare(it.data ?? Buffer.alloc(0), old.get(id).data ?? Buffer.alloc(0)) === 0, `item ${id} bytes unchanged`);
  return { r, after, items: now };
}

// An iPhone-style photo: a grid of four tiles whose layout lives in idat, a thumbnail with its own alpha,
// Exif and XMP items, a depth map and an HDR gain map.
function iphone({ rotation = 1 } = {}) {
  const props = [ispe(128, 96), hvcC(), ispe(64, 48), irot(rotation), ispe(32, 24), auxC('urn:mpeg:hevc:2015:auxid:2'), auxC('urn:com:apple:photo:2020:aux:hdrgainmap'), auxC('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha'), colrNclx()];
  return heif({
    items: [
      { id: 1, type: 'grid', data: grid(2, 2, 128, 96), method: 1 },
      ...[2, 3, 4, 5].map((id) => ({ id, type: 'hvc1', data: coded(`TILE-${id}`) })),
      { id: 6, type: 'hvc1', data: coded('THUMBNAIL', 40) },
      { id: 7, type: 'Exif', data: exifItem(exifTiff([[0x0112, 3, [6]]])) },
      { id: 8, type: 'mime', contentType: 'application/rdf+xml', data: xmp },
      { id: 9, type: 'hvc1', data: coded('DEPTH', 48) },
      { id: 10, type: 'hvc1', data: coded('GAINMAP', 48) },
      { id: 11, type: 'hvc1', data: coded('THUMB-ALPHA', 24) },
    ],
    refs: [['dimg', 1, [2, 3, 4, 5]], ['thmb', 6, [1]], ['cdsc', 7, [1]], ['cdsc', 8, [1]], ['auxl', 9, [1]], ['auxl', 10, [1]], ['auxl', 11, [6]]],
    props,
    assoc: { 1: [1, -4, 9], 2: [-2, 3], 3: [-2, 3], 4: [-2, 3], 5: [-2, 3], 6: [-2, 5, 9], 9: [-2, 3, -6], 10: [-2, 3, -7], 11: [-2, 5, -8] },
  });
}

test('HEIC: grid photo loses Exif, XMP and the thumbnail; tiles, depth map and gain map stay', async () => {
  const input = iphone({ rotation: 1 });
  const { r, items } = await cleanHeifAndCheck(input);
  assert.deepEqual([...items.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 9, 10]);
  assert.deepEqual(r.removed.map((x) => x.kind).sort(), ['EXIF', 'Thumbnail', 'Thumbnail', 'XMP']);
  assert.ok(r.kept.some((k) => /^Depth map/.test(k) && /outline of people/.test(k)));
  assert.ok(r.kept.some((k) => /^HDR gain map \(Apple\)/.test(k) && /flatten/.test(k)));
  assert.ok(r.kept.some((k) => k === 'Rotation (90° counter-clockwise)'));
  const out = Buffer.from(r.data);
  assert.equal(out.indexOf('auxiliary:alpha'), -1, 'the thumbnail alpha property went with it');
  assert.equal(out.indexOf('thmb'), -1);
  assert.equal(out.indexOf('SN-0042'), -1);
  assert.ok(r.bytesAfter < r.bytesBefore);
});

test('HEIC: EXIF orientation without a container rotation is noted, and cleaning again changes nothing', async () => {
  const input = heif({
    items: [{ id: 1, type: 'hvc1', data: coded('IMAGE') }, { id: 2, type: 'Exif', data: exifItem(exifTiff([[0x0112, 3, [6]]])) }],
    refs: [['cdsc', 2, [1]]], props: [ispe(64, 48), hvcC()], assoc: { 1: [1, -2] },
  });
  const { r } = await cleanHeifAndCheck(input);
  assert.ok(r.kept.some((k) => /Rotate 90 CW/.test(k) && /HEIF viewers follow/.test(k)));
  const again = await cleanFile(r.data, 'photo.heic');
  assert.ok(again.ok);
  assert.deepEqual(again.removed, []);
  assert.ok(Buffer.compare(Buffer.from(again.data), Buffer.from(r.data)) === 0);
});

test('AVIF: iloc version 2 with 32-bit IDs, base offsets, extent indexes and split Exif', async () => {
  const exif = exifItem(exifTiff());
  const input = heif({
    brand: 'avif', wideIds: true, wideProps: true, primary: 70001,
    iloc: { version: 2, off: 8, len: 4, base: 8, idx: 4 },
    items: [
      { id: 70001, type: 'av01', data: [coded('AV1-PART-A', 50), coded('AV1-PART-B', 30)] },
      { id: 70002, type: 'Exif', data: [exif.subarray(0, 40), exif.subarray(40)] },
      { id: 70003, type: 'mime', contentType: 'application/rdf+xml', data: xmp },
      { id: 70004, type: 'av01', data: coded('AV1-ALPHA', 20) },
    ],
    refs: [['cdsc', 70002, [70001]], ['cdsc', 70003, [70001]], ['auxl', 70004, [70001]]],
    props: [ispe(64, 48), av1C(), auxC('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha')], assoc: { 70001: [1, -2], 70004: [1, -2, -3] },
  });
  const { r, items } = await cleanHeifAndCheck(input, 'photo.avif');
  assert.deepEqual([...items.keys()].sort(), [70001, 70004]);
  assert.ok(r.kept.some((k) => /^Alpha channel/.test(k)));
});

test('HEIF: Exif stored in idat, an XMP box in meta, iloc version 1 with base offsets', async () => {
  const input = heif({
    iloc: { version: 1, off: 4, len: 4, base: 4, idx: 0 },
    items: [{ id: 1, type: 'hvc1', data: coded('IMAGE', 80) }, { id: 2, type: 'Exif', data: exifItem(exifTiff()), method: 1 }, { id: 3, type: 'hvc1', data: coded('IDAT-IMAGE', 16), method: 1 }],
    refs: [['cdsc', 2, [1]], ['dimg', 1, [3]]],
    props: [ispe(64, 48), hvcC()], assoc: { 1: [1, -2], 3: [1, -2] },
    meta: [fullBox('xml ', 0, 0, xmp)],
  });
  const { r, items } = await cleanHeifAndCheck(input);
  assert.deepEqual([...items.keys()].sort(), [1, 3]);
  assert.ok(r.removed.some((x) => x.kind === 'XMP' && x.container === 'meta xml'));
});

test('HEIF: iloc version 0 with the item table after the media data, and a Content Credentials box', async () => {
  const c2pa = box('uuid', Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex'), Buffer.from([0, 0, 0, 0]), Buffer.from('manifest\0'), Buffer.alloc(8), box('jumb', box('jumd', Buffer.from('c2pa'))));
  const input = heif({
    iloc: { version: 0, off: 4, len: 4, base: 0 }, metaLast: true, top: [c2pa],
    items: [{ id: 1, type: 'hvc1', data: coded('IMAGE', 70) }, { id: 2, type: 'Exif', data: exifItem(exifTiff()) }],
    refs: [['cdsc', 2, [1]]], props: [ispe(64, 48), hvcC()], assoc: { 1: [1, -2] },
  });
  const { r } = await cleanHeifAndCheck(input);
  assert.ok(r.removed.some((x) => x.kind === 'C2PA'));
});

test('HEIF: metadata items listed after hundreds of tiles are still found and removed', async () => {
  const tiles = Array.from({ length: 210 }, (_, i) => ({ id: i + 2, type: 'hvc1', data: coded(`T${i}`, 16) }));
  const input = heif({
    items: [{ id: 1, type: 'grid', data: grid(14, 15, 1680, 1120), method: 1 }, ...tiles, { id: 300, type: 'Exif', data: exifItem(exifTiff()) }, { id: 301, type: 'mime', contentType: 'application/rdf+xml', data: xmp }],
    refs: [['dimg', 1, tiles.map((t) => t.id)], ['cdsc', 300, [1]], ['cdsc', 301, [1]]],
    props: [ispe(1680, 1120), hvcC(), ispe(120, 80)], assoc: Object.fromEntries([[1, [1]], ...tiles.map((t) => [t.id, [-2, 3]])]),
  });
  const { r, items } = await cleanHeifAndCheck(input);
  assert.equal(items.size, 211);
  assert.deepEqual(r.removed.map((x) => x.kind).sort(), ['EXIF', 'XMP']);
});

test('HEIF: real files clean losslessly', async () => {
  for (const path of ['formats/pii.heic', 'formats/pii.avif', 'real/sample1.heif']) {
    const { r } = await cleanHeifAndCheck(fixture(path), path);
    assert.ok(r.removed.length > 0, path);
  }
});

test('HEIF: image sequences, shared bytes and external data are refused untouched', async () => {
  const base = { items: [{ id: 1, type: 'hvc1', data: coded('IMAGE') }, { id: 2, type: 'Exif', data: exifItem(exifTiff()) }], refs: [['cdsc', 2, [1]]], props: [ispe(64, 48), hvcC()], assoc: { 1: [1, -2] } };
  const seq = heif({ ...base, top: [box('moov', box('mvhd', Buffer.alloc(100)))] });
  const r1 = await cleanFile(seq, 'a.heic');
  assert.equal(r1.ok, false); assert.match(r1.reason, /sequence/);
  // An Exif item pointing at the image's own bytes.
  const shared = heif({ ...base, items: [base.items[0], { id: 2, type: 'Exif', sameAs: 1 }] });
  const r2 = await cleanFile(shared, 'a.heic');
  assert.equal(r2.ok, false); assert.match(r2.reason, /shares bytes/);
});

// ---------- TIFF ----------

const RGB = (w, h) => [[0x0100, 3, [w]], [0x0101, 3, [h]], [0x0102, 3, [8, 8, 8]], [0x0103, 3, [1]], [0x0106, 3, [2]], [0x0115, 3, [3]], [0x0116, 3, [h]], [0x011c, 3, [1]]];
const PRIVATE_TEXT = [[0x010d, 2, 'invoice-scan.tif'], [0x010e, 2, 'Our house'], [0x010f, 2, 'Canon'], [0x0110, 2, 'Canon EOS R5'], [0x011d, 2, 'Page A'], [0x0131, 2, 'Adobe Photoshop 25.0'], [0x0132, 2, '2026:10:01 09:30:00'], [0x013b, 2, 'Jane Doe'], [0x013c, 2, 'janes-laptop'], [0x8298, 2, '(c) Jane Doe']];
const iptc = Buffer.from([0x1c, 2, 80, 0, 8, ...Buffer.from('Jane Doe')]);
const photoshop = Buffer.concat([Buffer.from('8BIM'), Buffer.from([4, 4, 0, 0]), Buffer.from([0, 0, 0, iptc.length]), iptc]);
const icc = (() => { const p = Buffer.alloc(132); p.writeUInt32BE(132, 0); p.write('mntrRGB XYZ ', 12, 'latin1'); p.write('acsp', 36, 'latin1'); return p; })();
const strip = (label, n) => Buffer.from(label.repeat(Math.ceil(n / label.length)).slice(0, n));

function fullTiff(opts) {
  return tiffFile([{
    tags: [...RGB(8, 4), ...PRIVATE_TEXT, [0x0112, 3, [6]], [0x011a, 5, [[300, 1]]], [0x011b, 5, [[300, 1]]], [0x0128, 3, [2]], [0x02bc, 7, xmp], [0x83bb, 7, iptc], [0x8649, 7, photoshop], [0x8773, 7, icc], [0x87af, 3, [1, 1, 0, 0]]],
    strips: [strip('ROW-A', 48), strip('ROW-B', 48)],
    exif: { tags: [[0xa431, 2, 'SN-0042-7781'], [0x927c, 7, Buffer.from('Nikon\0\x02\x00\x00\x00opaque maker data')]] },
    gps: { tags: gps },
  }], { trailer: Buffer.from('HIDDEN TRAILING DATA AFTER THE IMAGE'), ...opts });
}

async function cleanTiffAndCheck(input, name = 'scan.tif') {
  const before = await inspectFile(input, name);
  const r = await cleanFile(input, name);
  assert.ok(r.ok, r.reason);
  const after = await inspectFile(r.data, name);
  assert.equal(after.cleanable.blocks, 0);
  assert.deepEqual(after.warnings, []);
  assert.equal(after.format, 'TIFF'); assert.equal(after.width, before.width); assert.equal(after.height, before.height);
  assert.equal(after.signals.filter((s) => s.kind === 'privacy').length, 0, JSON.stringify(after.signals));
  assert.ok(!after.sources.some((s) => /^(TIFF (Exif|GPS)|XMP|IPTC|Photoshop|Maker notes)/.test(s.name)));
  return { r, after, before };
}

for (const [label, opts] of [['little-endian', { le: true }], ['big-endian', { le: false }], ['BigTIFF', { big: true }], ['big-endian BigTIFF', { big: true, le: false }], ['SHORT strip offsets', { offsetType: 3 }]]) {
  test(`TIFF ${label}: text tags, EXIF, GPS, XMP, IPTC, Photoshop, GeoTIFF and trailer removed; strips, ICC and orientation kept`, async () => {
    const input = fullTiff(opts);
    const { r, after } = await cleanTiffAndCheck(input);
    const out = Buffer.from(r.data);
    for (const secret of ['Jane Doe', 'janes-laptop', 'SN-0042', 'Our house', 'HIDDEN TRAILING', 'opaque maker', 'Firefly', 'Canon']) assert.equal(out.indexOf(secret), -1, secret);
    const [page] = tiffPages(r.data);
    assert.ok(Buffer.compare(page.data, tiffPages(input)[0].data) === 0, 'strips unchanged');
    assert.equal(page.tags.get(0x0112)[0], 6);
    assert.ok(page.tags.has(0x8773));
    assert.ok(!page.tags.has(0x87af) && !page.tags.has(0x8769) && !page.tags.has(0x8825));
    assert.ok(r.kept.includes('ICC color profile'));
    assert.ok(r.kept.some((k) => /^Orientation \(Rotate 90 CW\)/.test(k)));
    for (const kind of ['XMP', 'IPTC', 'Text tag', 'EXIF', 'Location', 'Trailer']) assert.ok(r.removed.some((x) => x.kind === kind), kind);
    assert.equal(after.sources.find((s) => s.name === 'TIFF IFD0').fields.find((f) => f.key === 'Orientation').value, 'Rotate 90 CW');
    const again = await cleanFile(r.data, 'scan.tif');
    assert.ok(again.ok); assert.deepEqual(again.removed, []);
    assert.ok(Buffer.compare(Buffer.from(again.data), out) === 0, 'cleaning again changes nothing');
  });
}

test('TIFF multi-page: tiles and pages kept, reduced-resolution page and SubIFD previews removed, page numbers rewritten', async () => {
  const page = (label, extra = []) => ({ tags: [...RGB(8, 4).filter(([t]) => t !== 0x0116), [0x0142, 3, [16]], [0x0143, 3, [16]], [0x0129, 3, [0, 3]], ...extra], tiles: [strip(`${label}-T1`, 768), strip(`${label}-T2`, 768)] });
  const preview = { tags: [[0x00fe, 4, [1]], ...RGB(4, 2)], strips: [strip('PREVIEW', 24)] };
  const input = tiffFile([
    { ...page('P1', [[0x0131, 2, 'Scanner 3000']]), subIfds: [preview] },
    { ...page('P2-REDUCED', [[0x00fe, 4, [1]]]) },
    page('P3', [[0x013b, 2, 'Jane Doe']]),
  ], { le: true });
  const before = tiffPages(input);
  const { r } = await cleanTiffAndCheck(input);
  const pages = tiffPages(r.data);
  assert.equal(pages.length, 2);
  assert.ok(Buffer.compare(pages[0].data, before[0].data) === 0);
  assert.ok(Buffer.compare(pages[1].data, before[2].data) === 0);
  assert.deepEqual(pages.map((p) => p.tags.get(0x0129)), [[0, 2], [1, 2]]);
  assert.ok(!pages[0].tags.has(0x014a));
  assert.equal(Buffer.from(r.data).indexOf('PREVIEW'), -1);
  assert.equal(r.removed.filter((x) => x.kind === 'Thumbnail').length, 2);
  assert.equal(r.kept[0], '2 pages with their image data unchanged');
});

test('TIFF: real files clean with every page\'s image data unchanged', async () => {
  for (const path of ['formats/pii.tif', 'real/test.tiff', 'real/MultiPage.tif']) {
    const input = fixture(path);
    const r = await cleanFile(input, path);
    assert.ok(r.ok, `${path}: ${r.reason}`);
    const after = await inspectFile(r.data, path);
    assert.equal(after.cleanable.blocks, 0, path);
    const a = tiffPages(input); const b = tiffPages(r.data);
    assert.equal(b.length, a.length, path);
    a.forEach((p, i) => assert.ok(Buffer.compare(p.data, b[i].data) === 0, `${path} page ${i}`));
  }
});

test('TIFF: DNG and other raw data, old-style JPEG and larger sub-images are refused untouched', async () => {
  const dng = tiffFile([{ tags: [...RGB(8, 4), [0xc612, 1, Buffer.from([1, 4, 0, 0])], [0x010f, 2, 'Canon']], strips: [strip('RAW', 96)] }]);
  const r1 = await cleanFile(dng, 'photo.dng');
  assert.equal(r1.ok, false); assert.match(r1.reason, /DNG files cannot be cleaned yet/);
  const r1b = await cleanImage(dng);
  assert.equal(r1b.ok, false); assert.match(r1b.reason, /Supported image formats: .*HEIC.*TIFF/);
  const cfa = tiffFile([{ tags: [...RGB(8, 4).map((e) => (e[0] === 0x0106 ? [0x0106, 3, [32803]] : e)), [0x013b, 2, 'Jane']], strips: [strip('CFA', 96)] }]);
  const r2 = await cleanFile(cfa, 'raw.tif');
  assert.equal(r2.ok, false); assert.match(r2.reason, /raw/);
  const ojpeg = tiffFile([{ tags: [...RGB(8, 4).map((e) => (e[0] === 0x0103 ? [0x0103, 3, [6]] : e)), [0x013b, 2, 'Jane']], strips: [strip('JPEG', 96)] }]);
  const r3 = await cleanFile(ojpeg, 'old.tif');
  assert.equal(r3.ok, false); assert.match(r3.reason, /old-style JPEG/);
  const hidden = tiffFile([{ tags: [...RGB(8, 4), [0x013b, 2, 'Jane']], strips: [strip('SMALL', 96)], subIfds: [{ tags: RGB(64, 48), strips: [strip('BIG', 9216)] }] }]);
  const r4 = await cleanFile(hidden, 'odd.tif');
  assert.equal(r4.ok, false); assert.match(r4.reason, /larger image/);
});

test('TIFF: a damaged directory is reported and the file refused, not passed through as clean', async () => {
  const input = tiffFile([{ tags: [...RGB(8, 4), [0x013b, 2, 'Jane Doe'], [0xc4a5, 7, Buffer.alloc(40, 7)]], strips: [strip('ROW', 96)], gps: { tags: gps } }]);
  // Point the PrintIM value past the end of the file.
  const entry = input.indexOf(Buffer.from([0xa5, 0xc4, 7, 0]));
  input.writeUInt32LE(input.length + 100, entry + 8);
  const report = await inspectFile(input, 'scan.tif');
  assert.ok(report.warnings.some((w) => /damaged/.test(w)));
  const r = await cleanFile(input, 'scan.tif');
  assert.equal(r.ok, false); assert.match(r.reason, /damaged/);
});

test('TIFF and HEIF go through cleanImage too', async () => {
  const r = await cleanImage(fullTiff({}));
  assert.ok(r.ok, r.reason);
  assert.equal(r.format, 'TIFF');
  const h = await cleanImage(iphone());
  assert.ok(h.ok, h.reason);
  assert.equal(h.format, 'HEIC');
});
