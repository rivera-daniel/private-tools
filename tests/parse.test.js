import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { inspectImage } from '../site/lib/metadata/index.js';
import { base, sample, tiff, exifSegment, xmpSegment, xmpPacket, iptcSegment, jpegWith, segment, pngWith, tEXt, zTXt, iTXt, chunk, webpWith, dms } from './fixtures/build.js';

const hl = (report, group, key) => report.highlights.find((g) => g.name === group)?.fields.find((f) => f.key === key)?.value;
const src = (report, source, key) => report.sources.find((g) => g.name === source)?.fields.find((f) => f.key === key)?.value;
const kinds = (report) => report.signals.map((s) => s.kind);
const titles = (report) => report.signals.map((s) => s.title);
const fixture = (path) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url));
const NEVER = /\b(is|was) (definitely |certainly )?(ai[- ]generated|not ai|real|authentic|fake)\b|\bverified\b(?! here)/i;

function assertTruthful(report) {
  const texts = [report.summary.title, report.summary.detail, report.provenance.title, report.provenance.detail, ...report.signals.flatMap((s) => [s.title, s.detail])];
  for (const text of texts) assert.doesNotMatch(text.replace(/not verif(y|ied)/gi, '').replace(/(does not (mean|prove)|not a determination)[^.]*\./gi, ''), NEVER, `overclaiming text: ${text}`);
}

const cameraTiff = () => tiff(
  [[0x010f, 2, 'Canon'], [0x0110, 2, 'Canon EOS R5'], [0x0131, 2, 'Adobe Photoshop 25.0'], [0x013b, 2, 'Jane Doe'], [0xabcd, 2, 'mystery value']],
  {
    exif: [[0x9003, 2, '2026:10:01 09:30:00'], [0xa431, 2, 'SN-0042-7781'], [0x829a, 5, [[1, 250]]], [0x829d, 5, [[28, 10]]], [0x9286, 7, Buffer.concat([Buffer.from('ASCII\0\0\0'), Buffer.from('Family trip')])]],
    gps: [[0x0001, 2, 'N'], [0x0002, 5, dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, dms(97.74306)]],
    thumbnail: Buffer.from(base.jpeg),
  },
);

// ---------- Summary and provenance ----------

test('clean control: no metadata, no provenance evidence, honest limits', async () => {
  const r = await inspectImage(base.png);
  assert.equal(r.format, 'PNG'); assert.equal(r.width, 16); assert.equal(r.height, 12);
  assert.equal(r.summary.level, 'clean');
  assert.equal(r.provenance.level, 'none');
  assert.match(r.provenance.detail, /stripped/); assert.match(r.provenance.detail, /SynthID/);
  assert.deepEqual(r.warnings, []);
  assertTruthful(r);
});

test('JPEG EXIF: every tag listed, key details and privacy summary', async () => {
  const r = await inspectImage(jpegWith(exifSegment(cameraTiff())));
  assert.equal(r.format, 'JPEG'); assert.equal(r.width, 16);
  assert.equal(hl(r, 'Camera', 'Make'), 'Canon');
  assert.equal(hl(r, 'Camera', 'Body serial number'), 'SN-0042-7781');
  assert.equal(hl(r, 'Camera', 'Exposure'), '1/250 s');
  assert.equal(hl(r, 'Camera', 'F-number'), 'f/2.8');
  assert.equal(hl(r, 'Comments', 'User comment'), 'Family trip');
  assert.equal(hl(r, 'Location', 'GPS coordinates'), '30.26715, -97.74306');
  assert.equal(src(r, 'EXIF IFD0', '0xABCD'), 'mystery value', 'unknown tags are listed by ID');
  assert.equal(src(r, 'EXIF GPS', 'GPSLatitudeRef'), 'N');
  assert.match(src(r, 'EXIF GPS', 'GPSLatitude'), /^30° 16'/);
  for (const t of ['Exact location stored', 'Device serial number stored', 'Embedded thumbnail preview', 'Names or ownership stored']) assert.ok(titles(r).includes(t), t);
  assert.equal(r.summary.level, 'exposed');
  assert.match(r.summary.title, /exact location/);
  assert.equal(r.provenance.level, 'camera');
  const exif = r.blocks.find((b) => b.kind === 'EXIF');
  assert.equal(exif.offset, 2, 'EXIF block starts right after SOI');
  assertTruthful(r);
});

test('big-endian TIFF parses the same fields', async () => {
  const r = await inspectImage(jpegWith(exifSegment(tiff([[0x010f, 2, 'Nikon'], [0x0131, 2, 'Midjourney v7']], { le: false }))));
  assert.equal(hl(r, 'Camera', 'Make'), 'Nikon');
  assert.ok(kinds(r).includes('clue'));
  assert.equal(r.provenance.level, 'clues');
});

test('XMP: DigitalSourceType declares AI generation; unknown namespaces are listed', async () => {
  const xml = xmpPacket('xmlns:foo="urn:example:foo" xmp:CreatorTool="Adobe Firefly" foo:Secret="kept" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia">');
  const r = await inspectImage(jpegWith(xmpSegment(xml)));
  assert.equal(hl(r, 'Software', 'Creator tool'), 'Adobe Firefly');
  assert.match(hl(r, 'Provenance', 'Digital source type'), /trainedAlgorithmicMedia$/);
  assert.equal(src(r, 'XMP foo', 'foo:Secret'), 'kept');
  assert.equal(r.provenance.level, 'declared');
  assert.match(r.provenance.detail, /not proof/);
  assertTruthful(r);
});

test('XMP element, rdf:Alt, struct and legacy xap values', async () => {
  const xml = xmpPacket('xmlns:xap="http://ns.adobe.com/xap/1.0/" xmlns:stRef="x" xap:CreatorTool="Old Tool"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">Sunset &amp; sea</rdf:li></rdf:Alt></dc:description><dc:creator><rdf:Seq><rdf:li>Ana</rdf:li></rdf:Seq></dc:creator><xmpMM:DerivedFrom stRef:documentID="doc-1"/>');
  const r = await inspectImage(jpegWith(xmpSegment(xml)));
  assert.equal(hl(r, 'Description', 'Description'), 'Sunset & sea');
  assert.equal(hl(r, 'People', 'Creator'), 'Ana');
  assert.equal(hl(r, 'Software', 'Creator tool'), 'Old Tool');
  assert.equal(src(r, 'XMP xmpMM', 'xmpMM:DerivedFrom › stRef:documentID'), 'doc-1');
});

test('JPEG IPTC (all datasets) and comment segments', async () => {
  const r = await inspectImage(jpegWith(iptcSegment([[80, 'Ana Lopez'], [90, 'Austin'], [120, 'Caption text'], [65, 'DALL-E 3'], [199, 'odd dataset']]), segment(0xfe, Buffer.from('saved by tool'))));
  assert.equal(hl(r, 'People', 'By-line'), 'Ana Lopez');
  assert.equal(hl(r, 'Location', 'City'), 'Austin');
  assert.equal(hl(r, 'Description', 'Caption'), 'Caption text');
  assert.equal(src(r, 'IPTC', 'Application › 2:199'), 'odd dataset');
  assert.equal(hl(r, 'Comments', 'JPEG comment'), 'saved by tool');
  assert.ok(kinds(r).includes('clue'));
});

test('JPEG trailing data, unknown APP segments and structure', async () => {
  const r = await inspectImage(Buffer.concat([jpegWith(segment(0xe9, Buffer.from('VendorX\0payload'))), Buffer.from('hidden payload')]));
  assert.match(src(r, 'File', 'Data after end of image'), /^14 bytes/);
  assert.match(src(r, 'Other segments', 'APP9 (VendorX)'), /not decoded/);
  assert.ok(r.blocks.some((b) => b.kind === 'Application data' && b.decoded === false));
  assert.deepEqual(r.structure.slice(0, 2).map((s) => s.type), ['SOI', 'APP9']);
});

test('Apple maker note is decoded as an IFD; unknown vendors are listed undecoded', async () => {
  const ifd = Buffer.concat([Buffer.from([0, 1]), Buffer.from([0x00, 0x0b, 0, 2, 0, 0, 0, 8, 0, 0, 0, 32]), Buffer.alloc(4), Buffer.from('BURST-42')]);
  const apple = Buffer.concat([Buffer.from('Apple iOS\0\0\x01MM', 'latin1'), ifd]);
  const r = await inspectImage(jpegWith(exifSegment(tiff([[0x010f, 2, 'Apple']], { exif: [[0x927c, 7, apple]] }))));
  assert.equal(src(r, 'Maker notes (Apple)', 'BurstUUID'), 'BURST-42');
  assert.ok(r.blocks.some((b) => b.kind === 'MakerNote' && b.vendor === 'Apple'));
  const leica = await inspectImage(jpegWith(exifSegment(tiff([[0x010f, 2, 'Leica']], { exif: [[0x927c, 7, Buffer.from('LEICA\0\x01\x02 opaque vendor bytes')]] }))));
  assert.match(src(leica, 'EXIF Exif', 'MakerNote'), /not decoded/);
});

test('PNG AUTOMATIC1111 parameters', async () => {
  const params = 'a lighthouse at dusk, oil painting\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 12345, Size: 512x512, Model: sdxl_base';
  const r = await inspectImage(pngWith(tEXt('parameters', params)));
  assert.equal(hl(r, 'Generation data', 'Prompt'), 'a lighthouse at dusk, oil painting');
  assert.equal(hl(r, 'Generation data', 'Seed'), '12345');
  assert.equal(r.provenance.level, 'declared');
  assert.ok(titles(r).includes('Prompt text stored'));
  assertTruthful(r);
});

test('PNG ComfyUI prompt and workflow, including compressed iTXt', async () => {
  const prompt = { 3: { class_type: 'KSampler', inputs: { seed: 1 } }, 4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev.safetensors' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: 'a red fox in snow' } } };
  const r = await inspectImage(pngWith(iTXt('prompt', JSON.stringify(prompt), true), tEXt('workflow', JSON.stringify({ nodes: [] }))));
  assert.equal(hl(r, 'Generation data', 'ComfyUI nodes'), '3');
  assert.equal(hl(r, 'Generation data', 'Models'), 'flux1-dev.safetensors');
  assert.equal(hl(r, 'Generation data', 'Prompt text'), 'a red fox in snow');
  assert.ok(titles(r).includes('ComfyUI workflow embedded'));
});

test('PNG zTXt, eXIf, XMP iTXt, technical chunks and unknown chunks', async () => {
  const xml = xmpPacket('xmp:CreatorTool="GIMP 2.10">');
  const r = await inspectImage(pngWith(zTXt('Comment', 'compressed note'), chunk('eXIf', tiff([[0x010f, 2, 'Apple']])), iTXt('XML:com.adobe.xmp', xml), chunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])), chunk('prVt', Buffer.from('secret'))));
  assert.equal(src(r, 'PNG text', 'Comment'), 'compressed note');
  assert.equal(hl(r, 'Camera', 'Make'), 'Apple');
  assert.equal(hl(r, 'Software', 'Creator tool'), 'GIMP 2.10');
  assert.equal(src(r, 'PNG', 'Pixel density'), '72 × 72 dpi');
  assert.match(src(r, 'Other chunks', 'prVt'), /not decoded/);
  assert.ok(r.sources.find((s) => s.name === 'PNG').technical);
});

test('PNG chunks after IDAT are still scanned', async () => {
  const iend = base.png.length - 12;
  const r = await inspectImage(Buffer.concat([base.png.subarray(0, iend), tEXt('Software', 'NovelAI'), base.png.subarray(iend)]));
  assert.ok(kinds(r).includes('clue'));
});

test('WebP EXIF and XMP chunks', async () => {
  const xml = xmpPacket('Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia">');
  const r = await inspectImage(webpWith({ EXIF: tiff([[0x010f, 2, 'Google'], [0x0110, 2, 'Pixel 9']]), 'XMP ': Buffer.from(xml) }));
  assert.equal(r.format, 'WebP'); assert.equal(r.width, 16); assert.equal(r.height, 12);
  assert.equal(hl(r, 'Camera', 'Model'), 'Pixel 9');
  assert.ok(titles(r).includes('Composite that includes AI-generated content'));
});

test('real C2PA sample: full manifest listed, signature explicitly unverified', async () => {
  const r = await inspectImage(sample('c2pa-CA.jpg'));
  assert.equal(r.c2pa.length, 1);
  assert.equal(r.c2pa[0].verified, false);
  assert.match(hl(r, 'Provenance', 'Content Credentials'), /Signature not verified/);
  assert.match(hl(r, 'Provenance', 'Claim generator'), /c2pa-rs/);
  const manifest = r.sources.find((s) => s.name.startsWith('Content Credentials'));
  assert.ok(manifest.fields.some((f) => f.key === 'c2pa.actions › actions › 1 › action' && f.value === 'c2pa.color_adjustments'));
  assert.equal(r.provenance.level, 'credentials');
  assert.ok(titles(r).includes('Preview of an earlier version'));
  assertTruthful(r);
});

test('ordinary words in captions and photo software are not generator clues', async () => {
  const jpeg = jpegWith(exifSegment(tiff([[0x010e, 2, 'Aurora over Iceland'], [0x0131, 2, 'Aurora HDR 2019']], { exif: [[0x9286, 7, Buffer.concat([Buffer.from('ASCII\0\0\0'), Buffer.from('Imagen de la playa')])]] })));
  const png = pngWith(tEXt('Description', 'Flux capacitor, Runway at dawn, Leonardo statue'), tEXt('Comment', 'Gemini constellation'));
  for (const file of [jpeg, png]) {
    const r = await inspectImage(file);
    assert.notEqual(r.provenance.level, 'clues');
    assert.ok(!kinds(r).includes('clue'), JSON.stringify(r.signals));
  }
});

// ---------- New formats, written by ExifTool ----------

for (const ext of ['jpg', 'png', 'webp', 'heic', 'avif', 'jxl', 'tif', 'psd']) {
  test(`${ext}: location, camera, serial, author and city from an ExifTool-written file`, async () => {
    const r = await inspectImage(fixture(`formats/pii.${ext}`));
    assert.deepEqual(r.warnings, []);
    assert.equal(hl(r, 'Location', 'GPS coordinates'), '30.26715, -97.74306');
    assert.equal(hl(r, 'Camera', 'Make'), 'Canon');
    assert.equal(hl(r, 'Camera', 'Body serial number'), 'SN-0042-7781');
    assert.equal(hl(r, 'People', 'Creator'), 'Jane Doe');
    assert.equal(hl(r, 'Location', 'City'), 'Austin');
    assert.ok(titles(r).includes('Exact location stored'));
    assert.ok(r.blocks.some((b) => b.kind === 'EXIF'));
  });
}

test('HEIC/AVIF formats are named and item tables listed', async () => {
  const heic = await inspectImage(fixture('formats/pii.heic'));
  assert.equal(heic.format, 'HEIC');
  assert.ok(heic.sources.find((s) => s.name === 'Items').fields.some((f) => /^Exif/.test(f.value)));
  assert.equal((await inspectImage(fixture('formats/pii.avif'))).format, 'AVIF');
  const real = await inspectImage(fixture('real/sample1.avif'));
  assert.equal(real.width, 1204); assert.equal(real.height, 800);
});

test('GIF comment and XMP application extension', async () => {
  const r = await inspectImage(fixture('formats/pii.gif'));
  assert.equal(r.format, 'GIF'); assert.equal(r.width, 64);
  assert.equal(hl(r, 'Comments', 'GIF comment'), 'made on my laptop');
  assert.equal(hl(r, 'People', 'Creator'), 'Jane Doe');
});

test('JPEG XL bare codestream size and BMP header', async () => {
  const jxl = await inspectImage(fixture('formats/plain-codestream.jxl'));
  assert.equal(jxl.format, 'JPEG XL'); assert.equal(jxl.width, 64); assert.equal(jxl.height, 48);
  const real = await inspectImage(fixture('real/sample1.jxl'));
  assert.equal(real.width, 896); assert.equal(real.height, 1080);
  const bmp = await inspectImage(fixture('formats/plain.bmp'));
  assert.equal(bmp.format, 'BMP'); assert.equal(bmp.width, 64); assert.equal(bmp.height, 48);
});

test('SVG: active content, external references, editor paths, title and metadata', async () => {
  const r = await inspectImage(fixture('formats/pii.svg'));
  assert.equal(r.format, 'SVG'); assert.equal(r.width, 64);
  for (const t of ['Active content in SVG', 'External references', 'File path stored']) assert.ok(titles(r).includes(t), t);
  assert.equal(hl(r, 'Description', 'SVG title'), 'Acme logo draft');
  assert.equal(hl(r, 'People', 'Creator'), 'Jane Doe');
  assert.match(hl(r, 'Software', 'Generator'), /Adobe Illustrator/);
  assert.equal(src(r, 'SVG external references', 'Reference 1'), 'https://tracker.example/pixel.gif');
});

test('multi-page TIFF lists every page and PSD reads its resources', async () => {
  const tif = await inspectImage(fixture('real/MultiPage.tif'));
  assert.equal(tif.format, 'TIFF');
  assert.ok(tif.sources.some((s) => s.name === 'TIFF IFD4'));
  const psd = await inspectImage(fixture('real/purple-square.psd'));
  assert.equal(psd.format, 'PSD'); assert.equal(psd.width, 200);
  assert.match(src(psd, 'Photoshop', '0x0421 Version info'), /Writer: Adobe Photoshop/);
});

// ---------- ExifTool cross-check ----------

test('every metadata group ExifTool reads is present, with at least as many fields', async () => {
  const reference = JSON.parse(fixture('exiftool-reference.json'));
  const MAP = { IFD0: ['EXIF IFD0', 'TIFF IFD0'], ExifIFD: ['EXIF Exif', 'TIFF Exif'], GPS: ['EXIF GPS', 'TIFF GPS'], IFD1: ['EXIF IFD1', 'TIFF IFD1'], IPTC: ['IPTC'] };
  for (const entry of reference) {
    const r = await inspectImage(fixture(entry.SourceFile));
    const counts = {};
    for (const [k, v] of Object.entries(entry)) { if (!k.includes(':') || v === '') continue; const g = k.split(':')[0]; counts[g] = (counts[g] ?? 0) + 1; }
    for (const [group, theirs] of Object.entries(counts)) {
      if (MAP[group]) {
        const ours = MAP[group].map((name) => r.sources.find((s) => s.name === name)?.fields.length).find((n) => n !== undefined) ?? 0;
        assert.ok(ours >= theirs, `${entry.SourceFile} ${group}: ExifTool ${theirs}, ours ${ours}`);
      } else if (group.startsWith('XMP-') && group !== 'XMP-x') {
        const ns = group.slice(4).replace(/^iptcCore$/, 'Iptc4xmpCore').replace(/^iptcExt$/, 'Iptc4xmpExt');
        assert.ok(r.sources.some((s) => s.name === `XMP ${ns}` && s.fields.length), `${entry.SourceFile} ${group} missing`);
      }
    }
  }
});

// ---------- Metadata blocks (the cleaner's input) ----------

test('cleanable blocks: located, non-overlapping, within the file and matching their container', async () => {
  const reference = JSON.parse(fixture('exiftool-reference.json'));
  const files = [...reference.map((e) => e.SourceFile), 'c2pa-CA.jpg', 'camera-no-manifest.jpg'];
  for (const path of files) {
    const bytes = fixture(path);
    const r = await inspectImage(bytes);
    const top = cleanableBlocks(r);
    assert.equal(r.cleanable.blocks, top.length, path);
    if (r.format === 'SVG') continue; // SVG metadata is text without byte-addressed blocks.
    let end = -1;
    for (const b of [...top].sort((x, y) => x.offset - y.offset)) {
      assert.ok(Number.isInteger(b.offset), `${path} ${b.kind} has no offset`);
      assert.ok(b.offset >= end, `${path} ${b.kind} at ${b.offset} overlaps the previous block`);
      assert.ok(b.offset + b.length <= bytes.length, `${path} ${b.kind} runs past the end`);
      end = b.offset + b.length;
      if (r.format === 'JPEG' && b.kind !== 'Trailer') assert.equal(bytes[b.offset], 0xff, `${path} ${b.kind} is not a JPEG marker`);
      if (r.format === 'PNG' && b.kind !== 'Trailer') assert.ok(/^[A-Za-z]{4}$/.test(bytes.toString('latin1', b.offset + 4, b.offset + 8)), `${path} ${b.kind} is not a PNG chunk`);
      if (r.format === 'WebP' && b.kind !== 'Trailer') assert.equal(bytes.toString('latin1', b.offset, b.offset + 4), b.container.split(' ')[0].padEnd(4), `${path} ${b.kind}`);
    }
    assert.ok(top.reduce((n, b) => n + b.length, 0) <= bytes.length, path);
  }
});

test('nested blocks are not counted twice', async () => {
  const r = await inspectImage(fixture('real/P1000827.jpg'));
  const iptc = r.blocks.find((b) => b.kind === 'IPTC');
  assert.equal(r.blocks[iptc.parent].kind, 'Photoshop');
  assert.ok(!cleanableBlocks(r).includes(iptc));
  const tif = await inspectImage(fixture('real/test.tiff'));
  assert.ok(cleanableBlocks(tif).some((b) => b.kind === 'XMP'), 'removable blocks inside a non-removable TIFF container count');
});

// ---------- Hostile input ----------

test('truncated files warn instead of throwing, in every format', async () => {
  for (const path of ['formats/pii.jpg', 'formats/pii.png', 'formats/pii.webp', 'formats/pii.heic', 'formats/pii.avif', 'formats/pii.jxl', 'formats/pii.gif', 'formats/pii.tif', 'formats/pii.psd', 'formats/plain.bmp', 'formats/pii.svg']) {
    const bytes = fixture(path);
    for (const cut of [40, Math.floor(bytes.length / 2)]) {
      const r = await inspectImage(bytes.subarray(0, cut));
      assert.ok(r, `${path} cut at ${cut}`);
    }
  }
});

test('bogus segment and chunk lengths are contained', async () => {
  const badJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.from('Exif\0\0')]);
  assert.ok((await inspectImage(badJpeg)).warnings.length > 0);
  const badPng = Buffer.concat([base.png.subarray(0, 33), Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('tEXt')]);
  assert.ok((await inspectImage(badPng)).warnings.length > 0);
});

test('IFD loop is detected and skipped', async () => {
  const t = Buffer.concat([Buffer.from('II'), Buffer.from([42, 0, 8, 0, 0, 0]), Buffer.from([1, 0]), Buffer.from([0x0f, 0x01, 2, 0, 4, 0, 0, 0]), Buffer.from('ACME'), Buffer.from([8, 0, 0, 0])]);
  const r = await inspectImage(jpegWith(exifSegment(t)));
  assert.equal(hl(r, 'Camera', 'Make'), 'ACME');
  assert.ok(r.warnings.some((w) => /loop/.test(w)));
  const tif = await inspectImage(t);
  assert.ok(tif.warnings.some((w) => /loop/.test(w)));
});

test('ISOBMFF with oversized boxes and absurd item tables is contained', async () => {
  const box = (type, body) => Buffer.concat([u32(body.length + 8), Buffer.from(type), body]);
  const ftyp = box('ftyp', Buffer.from('heic\0\0\0\0mif1heic'));
  const iloc = box('iloc', Buffer.concat([Buffer.from([1, 0, 0, 0, 0x44, 0x40]), Buffer.from([0xff, 0xff]), Buffer.alloc(16)]));
  const meta = box('meta', Buffer.concat([Buffer.alloc(4), iloc, Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('iinf')]));
  const r = await inspectImage(Buffer.concat([ftyp, meta]));
  assert.equal(r.format, 'HEIC');
  assert.ok(r.warnings.length > 0);
});

test('SVG and XMP scans stay linear on hostile input', async () => {
  const started = Date.now();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${'a:b="'.repeat(300000)}><metadata>${'<x:y '.repeat(200000)}</metadata><style>${'<style>'.repeat(50000)}</svg>`);
  await inspectImage(svg);
  const xmp = xmpPacket(`${'foo:bar'.repeat(200000)} ${'<dc:a>'.repeat(100000)}>`);
  await inspectImage(jpegWith(...chunkedXmp(xmp)));
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test('zTXt decompression bomb is capped', async () => {
  const bomb = chunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), deflateSync(Buffer.alloc(64 * 1024 * 1024))]));
  const started = Date.now();
  const r = await inspectImage(pngWith(bomb));
  assert.ok(r.warnings.some((w) => /exceeds/.test(w)));
  assert.ok(Date.now() - started < 5000);
});

test('many small decompression bombs share one per-file budget', async () => {
  const one = zTXt('Comment', Buffer.alloc(1024 * 1024));
  const started = Date.now();
  const r = await inspectImage(pngWith(...Array.from({ length: 200 }, () => one)));
  assert.ok(r.warnings.some((w) => /32 MB limit/.test(w)));
  assert.ok(Date.now() - started < 10000);
  assert.ok(r.sources.every((s) => s.fields.length <= 3000));
});

test('malformed C2PA CBOR is contained', async () => {
  const jumd = (label) => { const d = Buffer.concat([Buffer.alloc(16), Buffer.from([3]), Buffer.from(`${label}\0`)]); return Buffer.concat([u32(d.length + 8), Buffer.from('jumd'), d]); };
  const box = (type, ...kids) => { const body = Buffer.concat(kids); return Buffer.concat([u32(body.length + 8), Buffer.from(type), body]); };
  const claim = box('jumb', jumd('c2pa.claim'), box('cbor', Buffer.from([0xbf, 0x61])));
  const store = box('jumb', jumd('c2pa'), box('jumb', jumd('urn:uuid:x'), claim));
  const r = await inspectImage(pngWith(chunk('caBX', store)));
  assert.ok(r.warnings.some((w) => /could not be decoded/.test(w)));
  assert.equal(r.c2pa[0].verified, false);
});

test('non-images are rejected with a message', async () => {
  assert.match((await inspectImage(Buffer.from('%PDF-1.7 not an image'))).warnings[0], /not a supported image/);
  assert.match((await inspectImage(Buffer.from('\0\0\0\x1cftypisom\0\0\0\0isom'))).warnings[0], /video/);
  assert.equal((await inspectImage(new Uint8Array())).summary.level, 'clean');
});

test('extracted strings are returned verbatim for text-only rendering', async () => {
  const payload = '<img src=x onerror="alert(1)"><form action="//evil">';
  const r = await inspectImage(pngWith(tEXt('parameters', `${payload}\nSteps: 1, Seed: 2`)));
  assert.equal(hl(r, 'Generation data', 'Prompt'), payload);
});

function cleanableBlocks(r) {
  const removableAncestor = (b) => { for (let p = b.parent; p !== null && p !== undefined; p = r.blocks[p]?.parent) if (r.blocks[p]?.removable !== false) return true; return false; };
  return r.blocks.filter((b) => b.removable !== false && !removableAncestor(b));
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
// A large XMP packet split across standard APP1 segments is still one packet to the parser; keep it under one segment.
function chunkedXmp(xml) { return [xmpSegment(xml.slice(0, 60000))]; }
