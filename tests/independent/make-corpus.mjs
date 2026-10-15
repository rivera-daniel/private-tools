// Builds the corpus for the independent checks: one or more files per cleanable format, each carrying known
// secrets planted in as many metadata locations as the format has.
//
// Built-in items are generated in code from the fixture builders and are fully deterministic. External
// items are produced at run time with ExifTool, ffmpeg and Python Office libraries when they are installed;
// they are never committed.
//
// Every item: { id, name, format, family, source, data, secrets, policy, options, expect }
//   secrets  strings that must not appear anywhere in the cleaned bytes
//   policy   strings planted where keeping them is a product decision; reported, never failed
//   expect   'clean' (default) or 'refuse'
//
// Run directly to write the corpus to a directory: node tests/independent/make-corpus.mjs <dir>
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base, sample, tiff, segment, jpegWith, exifSegment, xmpSegment, xmpPacket, iptcSegment, chunk, tEXt, zTXt, iTXt, pngWith, webpWith, dms } from '../fixtures/build.js';
import { pdf, update, basic, stream, xmp, utf16, signedData } from '../fixtures/pdf.js';
import { docx, xlsx, pptx, odt, epub, rawZip, unixExtra, timeExtra, ntfsExtra, dos } from '../fixtures/documents.js';
import { mp4, flac, wav, aiff, ogg, mkv, id3v2, id3Text, id3v1, apeTag, lyrics3, mp3Frames, adtsFrames, jpeg, u32, u16, cat, box } from '../fixtures/media.js';
import { readZip, readEntry, writeZip } from '../../site/tools/lib/zip/index.js';
import { run } from './tools.mjs';
import { findSecrets } from './scan.mjs';

// Planted strings are letters and digits only, so no format has to escape them, and each names its location.
export const S = (where) => `PTsec${where}`;
export const GPS = { lat: 30.26715, lon: -97.74306, iso: '+30.2671-097.7430/', decimals: ['30.2671', '97.7430'] };

const id3frame = (id, body) => cat(id, u32(body.length), u16(0), body);
const latin = (s) => Buffer.from(s, 'latin1');

// ---------- photos ----------

const gpsIfd = [[0x0001, 2, 'N'], [0x0002, 5, dms(GPS.lat)], [0x0003, 2, 'W'], [0x0004, 5, dms(-GPS.lon)]];
const thumbJpeg = () => jpegWith(segment(0xfe, latin(S('ThumbComment'))));
function photoExif(prefix, { orientation = 0 } = {}) {
  const ifd0 = [[0x010e, 2, S(`${prefix}ExifDescription`)], [0x010f, 2, S(`${prefix}ExifMake`)], [0x0110, 2, S(`${prefix}ExifModel`)], [0x0131, 2, S(`${prefix}ExifSoftware`)], [0x013b, 2, S(`${prefix}ExifArtist`)], [0x8298, 2, S(`${prefix}ExifCopyright`)]];
  if (orientation) ifd0.push([0x0112, 3, [orientation]]);
  return { data: tiff(ifd0, { exif: [[0xa430, 2, S(`${prefix}ExifOwner`)], [0xa431, 2, S(`${prefix}ExifSerial`)], [0xa435, 2, S(`${prefix}ExifLensSerial`)]], gps: gpsIfd, thumbnail: thumbJpeg() }), secrets: ['ExifDescription', 'ExifMake', 'ExifModel', 'ExifSoftware', 'ExifArtist', 'ExifCopyright', 'ExifOwner', 'ExifSerial', 'ExifLensSerial'].map((k) => S(prefix + k)).concat(S('ThumbComment')) };
}
const photoXmp = (prefix) => ({
  data: xmpPacket(`xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmp:CreatorTool="${S(`${prefix}XmpTool`)}" photoshop:City="${S(`${prefix}XmpCity`)}" exif:GPSLatitude="30,16.029N" exif:GPSLongitude="97,44.584W"><dc:creator><rdf:Seq><rdf:li>${S(`${prefix}XmpCreator`)}</rdf:li></rdf:Seq></dc:creator>`),
  secrets: [S(`${prefix}XmpTool`), S(`${prefix}XmpCity`), S(`${prefix}XmpCreator`), '30,16.029N'],
});

function jpegItem() {
  const exif = photoExif('Jpeg', { orientation: 6 }); const x = photoXmp('Jpeg');
  const iptc = iptcSegment([[80, S('JpegIptcByline')], [120, S('JpegIptcCaption')], [90, S('JpegIptcCity')]]);
  const data = Buffer.concat([jpegWith(exifSegment(exif.data), xmpSegment(x.data), iptc, segment(0xfe, latin(S('JpegComment')))), latin(S('JpegTrailer'))]);
  return { id: 'jpeg-builtin', name: 'photo.jpg', format: 'JPEG', family: 'jpeg', source: 'built-in', data, secrets: [...exif.secrets, ...x.secrets, S('JpegIptcByline'), S('JpegIptcCaption'), S('JpegIptcCity'), S('JpegComment'), S('JpegTrailer')] };
}

function pngItem() {
  const exif = photoExif('Png'); const x = photoXmp('Png');
  const time = chunk('tIME', Buffer.from([7, 233, 1, 2, 3, 4, 5]));
  const data = Buffer.concat([pngWith(tEXt('Author', S('PngTextAuthor')), zTXt('Comment', S('PngZtxtComment')), iTXt('Description', S('PngItxtDescription'), true), iTXt('XML:com.adobe.xmp', x.data), chunk('eXIf', exif.data), time), latin(S('PngTrailer'))]);
  return { id: 'png-builtin', name: 'image.png', format: 'PNG', family: 'png', source: 'built-in', data, secrets: [...exif.secrets, ...x.secrets, S('PngTextAuthor'), S('PngZtxtComment'), S('PngItxtDescription'), S('PngTrailer')] };
}

function webpItem() {
  const exif = photoExif('Webp'); const x = photoXmp('Webp');
  return { id: 'webp-builtin', name: 'image.webp', format: 'WebP', family: 'webp', source: 'built-in', data: webpWith({ EXIF: exif.data, 'XMP ': Buffer.from(x.data) }), secrets: [...exif.secrets, ...x.secrets] };
}

// A 2x2 GIF89a with a comment extension, an XMP application extension and data after the trailer.
export function gif({ comment = '', xmp: xmpText = '', trailer = '' } = {}) {
  const head = Buffer.concat([latin('GIF89a'), Buffer.from([2, 0, 2, 0, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])]);
  const sub = (b) => { const out = []; for (let i = 0; i < b.length; i += 255) { const s = b.subarray(i, i + 255); out.push(Buffer.from([s.length]), s); } out.push(Buffer.from([0])); return Buffer.concat(out); };
  const com = comment ? Buffer.concat([Buffer.from([0x21, 0xfe]), sub(latin(comment))]) : Buffer.alloc(0);
  // XMP is stored raw, followed by the 258-byte "magic trailer" that makes it parse as sub-blocks.
  const magic = Buffer.concat([Buffer.from([1]), Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)), Buffer.from([0])]);
  const app = xmpText ? Buffer.concat([Buffer.from([0x21, 0xff, 11]), latin('XMP DataXMP'), Buffer.from(xmpText), magic]) : Buffer.alloc(0);
  const image = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0]), Buffer.from([2, 2, 0x44, 0x01, 0])]);
  return Buffer.concat([head, com, app, image, Buffer.from([0x3b]), latin(trailer)]);
}

function gifItem() {
  const x = photoXmp('Gif');
  return { id: 'gif-builtin', name: 'image.gif', format: 'GIF', family: 'gif', source: 'built-in', data: gif({ comment: S('GifComment'), xmp: x.data, trailer: S('GifTrailer') }), secrets: [S('GifComment'), S('GifTrailer'), ...x.secrets] };
}

// ---------- PDF ----------

function pdfObjects(tag) {
  const photo = jpegWith(exifSegment(tiff([[0x013b, 2, S(`${tag}ImageArtist`)]], { gps: gpsIfd })));
  return basic({
    catalog: `/Metadata 6 0 R /Names << /JavaScript 8 0 R /EmbeddedFiles 9 0 R >> /OpenAction 12 0 R /PieceInfo << /App << /Private (${S(`${tag}CatalogPieceInfo`)}) >> >>`,
    page: `/Annots [7 0 R] /Metadata 13 0 R /PieceInfo << /App << /Private (${S(`${tag}PagePieceInfo`)}) >> >>`,
    resources: '/XObject << /Im1 17 0 R >>',
    content: 'q 16 0 0 12 72 600 cm /Im1 Do Q BT /F1 12 Tf 72 720 Td (Visible page text) Tj ET',
    extra: {
      6: stream('<< /Type /Metadata /Subtype /XML >>', xmp(`<dc:creator><rdf:Seq><rdf:li>${S(`${tag}XmpCreator`)}</rdf:li></rdf:Seq></dc:creator><xmp:CreatorTool>${S(`${tag}XmpTool`)}</xmp:CreatorTool>`), { flate: true }),
      7: `<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /T (${S(`${tag}AnnotAuthor`)}) /Contents (${S(`${tag}AnnotText`)}) >>`,
      8: '<< /Names [(js1) 10 0 R] >>',
      9: '<< /Names [(notes.txt) 11 0 R] >>',
      10: `<< /S /JavaScript /JS (var x = "${S(`${tag}NamedJs`)}";) >>`,
      11: `<< /Type /Filespec /F (notes.txt) /EF << /F 14 0 R >> /Desc (${S(`${tag}AttachmentDesc`)}) >>`,
      12: `<< /S /JavaScript /JS (var y = "${S(`${tag}OpenJs`)}";) >>`,
      13: stream('<< /Type /Metadata /Subtype /XML >>', xmp(`<xmp:CreatorTool>${S(`${tag}PageXmp`)}</xmp:CreatorTool>`)),
      14: stream('<< /Type /EmbeddedFile >>', S(`${tag}AttachmentBody`), { flate: true }),
      15: `<< /Author (${S(`${tag}InfoAuthor`)}) /Creator (${S(`${tag}InfoCreator`)}) /Producer (${S(`${tag}InfoProducer`)}) /Title (${S(`${tag}InfoTitle`)}) /Subject ${utf16(S(`${tag}InfoSubject`))} /Keywords (${S(`${tag}InfoKeywords`)}) /Custom (${S(`${tag}InfoCustom`)}) /CreationDate (D:20250102030405Z) >>`,
      16: `<< /Unused (${S(`${tag}UnusedObject`)}) >>`,
      17: stream('<< /Type /XObject /Subtype /Image /Width 16 /Height 12 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', photo),
    },
  });
}
const pdfSecrets = (tag) => ['CatalogPieceInfo', 'PagePieceInfo', 'XmpCreator', 'XmpTool', 'AnnotAuthor', 'AnnotText', 'NamedJs', 'AttachmentDesc', 'OpenJs', 'PageXmp', 'AttachmentBody', 'InfoAuthor', 'InfoCreator', 'InfoProducer', 'InfoTitle', 'InfoSubject', 'InfoKeywords', 'InfoCustom', 'UnusedObject', 'ImageArtist'].map((k) => S(tag + k));

function pdfItems() {
  const id = '/ID [<0102030405060708090a0b0c0d0e0f10> <0102030405060708090a0b0c0d0e0f10>]';
  const classic = pdf(pdfObjects('Pdf'), { trailer: `/Root 1 0 R /Info 15 0 R ${id}` });
  const revised = update(classic, { 18: `<< /Author (${S('PdfRev2Author')}) /ModDate (D:20250203040506Z) >>` }, `/Root 1 0 R /Info 18 0 R ${id}`);
  const packed = pdf(pdfObjects('PdfObjStm'), { trailer: `/Root 1 0 R /Info 15 0 R ${id}`, xrefStream: true, packed: [7, 10, 11, 12, 15, 16] });
  const der = signedData({ cn: S('PdfSignerName'), org: 'Example Corp', email: 'signer mailbox' });
  const signed = pdf(basic({ catalog: '/AcroForm << /Fields [7 0 R] /SigFlags 3 >>', page: '/Annots [7 0 R]', extra: {
    7: '<< /FT /Sig /T (Signature1) /V 8 0 R /Type /Annot /Subtype /Widget /Rect [0 0 0 0] >>',
    8: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (${S('PdfSigName')}) /Reason (${S('PdfSigReason')}) /Location (${S('PdfSigLocation')}) /M (D:20261001093000Z) /ByteRange [0 100 200 50] /Contents <${der.toString('hex')}${'0'.repeat(64)}> >>`,
  } }), { trailer: '/Root 1 0 R' });
  return [
    { id: 'pdf-builtin', name: 'document.pdf', format: 'PDF', family: 'pdf', source: 'built-in', data: classic, secrets: pdfSecrets('Pdf') },
    { id: 'pdf-revised', name: 'revised.pdf', format: 'PDF', family: 'pdf', source: 'built-in', data: revised, secrets: [...pdfSecrets('Pdf'), S('PdfRev2Author')] },
    { id: 'pdf-objstm', name: 'packed.pdf', format: 'PDF', family: 'pdf', source: 'built-in', data: packed, secrets: pdfSecrets('PdfObjStm') },
    { id: 'pdf-signed', name: 'signed.pdf', format: 'PDF', family: 'pdf', source: 'built-in', data: signed, secrets: [S('PdfSignerName'), S('PdfSigName'), S('PdfSigReason'), S('PdfSigLocation')], options: { removeSignatures: true }, exiftoolControl: false },
  ];
}

// ---------- documents ----------

// The names, comments and identifiers the document fixtures plant in places the cleaner removes. Each
// fixture uses a different subset, so an item gets the ones its input contains (at least three).
const FIXTURE_DOC_SECRETS = ['Jane Doe', 'John Roe', 'jane.doe@example.com', 'Acme Holdings', 'ACME-7781', 'Secret remark', 'Canon EOS R5', 'Floor3-Printer'];
function fixtureSecrets(data) {
  const found = [...new Set(findSecrets(data, FIXTURE_DOC_SECRETS).map((h) => h.secret))];
  if (found.length < 3) throw new Error(`document fixture carries only ${found.length} known secrets`);
  return found;
}

async function unzipEntries(u8) {
  const zip = readZip(u8);
  const out = [];
  for (const e of zip.entries) if (!e.name.endsWith('/')) out.push({ name: e.name, data: await readEntry(zip, e) });
  return out;
}

const OOXML_MAIN = {
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', DOTX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml', DOCM: 'application/vnd.ms-word.document.macroEnabled.main+xml', DOTM: 'application/vnd.ms-word.template.macroEnabledTemplate.main+xml',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', XLTX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml', XLSM: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml', XLTM: 'application/vnd.ms-excel.template.macroEnabled.main+xml',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', PPSX: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml', POTX: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml', PPTM: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml', PPSM: 'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml', POTM: 'application/vnd.ms-powerpoint.template.macroEnabled.main+xml',
};
const ODF_MIME = { ODT: 'application/vnd.oasis.opendocument.text', OTT: 'application/vnd.oasis.opendocument.text-template', ODS: 'application/vnd.oasis.opendocument.spreadsheet', OTS: 'application/vnd.oasis.opendocument.spreadsheet-template', ODP: 'application/vnd.oasis.opendocument.presentation', OTP: 'application/vnd.oasis.opendocument.presentation-template', ODG: 'application/vnd.oasis.opendocument.graphics', OTG: 'application/vnd.oasis.opendocument.graphics-template' };

// ZIP-level metadata planted on every entry: comments, an unknown extra field, Unix ids, extended and NTFS
// times, a 2025 timestamp, an archive comment and bytes after the archive.
function zipWithArchiveMetadata(entries, tag) {
  const when = dos(2025, 3, 4, 17, 30, 10);
  const marker = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(4); h.writeUInt16LE(0xcafe, 0); h.writeUInt16LE(b.length, 2); return Buffer.concat([h, b]); };
  return rawZip(entries.map((e, i) => ({ ...e, ...when, comment: i === 0 ? S(`${tag}ZipEntryComment`) : '', extra: i === 0 || e.name === 'mimetype' ? Buffer.alloc(0) : Buffer.concat([unixExtra(1001, 1001), timeExtra(1741109410), ntfsExtra(1741109410000), marker(S(`${tag}ZipExtra`))]) })), { comment: S(`${tag}ZipArchiveComment`), trailing: latin(S(`${tag}ZipTrailing`)) });
}
const zipMetaSecrets = (tag) => ['ZipEntryComment', 'ZipExtra', 'ZipArchiveComment', 'ZipTrailing'].map((k) => S(tag + k));

async function documentItems() {
  const items = [];
  const d = await docx(); const x = await xlsx(); const p = await pptx(); const o = await odt(); const e = await epub();
  items.push(
    { id: 'docx-fixture', name: 'fixture.docx', format: 'DOCX', family: 'ooxml', source: 'built-in', data: d, secrets: fixtureSecrets(d) },
    { id: 'docx-tracked', name: 'tracked.docx', format: 'DOCX', family: 'ooxml', source: 'built-in', data: await docx({ tracked: true }), secrets: [...fixtureSecrets(d), 'deleted secret'], options: { acceptChanges: true } },
    { id: 'docm-macros', name: 'macros.docm', format: 'DOCM', family: 'ooxml', source: 'built-in', data: await docx({ macros: true }), secrets: fixtureSecrets(d), options: { removeMacros: true } },
    { id: 'xlsx-fixture', name: 'fixture.xlsx', format: 'XLSX', family: 'ooxml', source: 'built-in', data: x, secrets: fixtureSecrets(x) },
    { id: 'pptx-fixture', name: 'fixture.pptx', format: 'PPTX', family: 'ooxml', source: 'built-in', data: p, secrets: fixtureSecrets(p) },
    { id: 'odt-fixture', name: 'fixture.odt', format: 'ODT', family: 'odf', source: 'built-in', data: o, secrets: fixtureSecrets(o) },
    { id: 'odt-tracked', name: 'tracked.odt', format: 'ODT', family: 'odf', source: 'built-in', data: await odt({ tracked: true }), secrets: fixtureSecrets(o), options: { acceptChanges: true } },
    { id: 'epub-fixture', name: 'fixture.epub', format: 'EPUB', family: 'epub', source: 'built-in', data: e, secrets: ['jane.doe@example.com', 'Canon EOS R5', 'calibre_bookmarks', 'Jane Doe'], policy: ['urn:uuid:12345678-90ab-cdef-1234-567890abcdef'] },
  );
  // Every other Office and OpenDocument type: the fixture's parts under that type's main content type or
  // mimetype, repacked with archive metadata.
  const sources = { D: await unzipEntries(d), X: await unzipEntries(x), P: await unzipEntries(p) };
  for (const [format, type] of Object.entries(OOXML_MAIN)) {
    const parts = sources[format[0]].map((en) => en.name === '[Content_Types].xml' ? { ...en, data: Buffer.from(Buffer.from(en.data).toString('utf8').replace(/application\/vnd\.[^"]*\.main\+xml/, type)) } : en);
    const data = zipWithArchiveMetadata(parts, format);
    items.push({ id: `${format.toLowerCase()}-zipmeta`, name: `zipmeta.${format.toLowerCase()}`, format, family: 'ooxml', source: 'built-in', data, secrets: [...fixtureSecrets(data), ...zipMetaSecrets(format)] });
  }
  const odfParts = await unzipEntries(o);
  for (const [format, mime] of Object.entries(ODF_MIME)) {
    const parts = odfParts.map((en) => en.name === 'mimetype' ? { ...en, data: Buffer.from(mime) } : en.name === 'META-INF/manifest.xml' ? { ...en, data: Buffer.from(Buffer.from(en.data).toString('utf8').replace('application/vnd.oasis.opendocument.text"', `${mime}"`)) } : en);
    const data = zipWithArchiveMetadata(parts, format);
    items.push({ id: `${format.toLowerCase()}-zipmeta`, name: `zipmeta.${format.toLowerCase()}`, format, family: 'odf', source: 'built-in', data, secrets: [...fixtureSecrets(data), ...zipMetaSecrets(format)] });
  }
  items.push({ id: 'epub-zipmeta', name: 'zipmeta.epub', format: 'EPUB', family: 'epub', source: 'built-in', data: zipWithArchiveMetadata(await unzipEntries(e), 'Epub'), secrets: ['jane.doe@example.com', 'Canon EOS R5', 'Jane Doe', ...zipMetaSecrets('Epub')], policy: ['urn:uuid:12345678-90ab-cdef-1234-567890abcdef'] });
  // A plain archive: metadata lives in the archive structure and in OS leftovers. File contents are content.
  const files = [{ name: 'readme.txt', data: Buffer.from('visible archive content') }, { name: '.DS_Store', data: latin(S('ZipDsStore')) }, { name: '__MACOSX/._readme.txt', data: latin(S('ZipAppleDouble')) }, { name: 'Thumbs.db', data: latin(S('ZipThumbsDb')) }];
  items.push({ id: 'zip-builtin', name: 'archive.zip', format: 'ZIP', family: 'zip', source: 'built-in', data: zipWithArchiveMetadata(files, 'Zip'), secrets: [...zipMetaSecrets('Zip'), S('ZipDsStore'), S('ZipAppleDouble'), S('ZipThumbsDb')] });
  items.push({ id: 'zip-deflated', name: 'deflated.zip', format: 'ZIP', family: 'zip', source: 'built-in', data: await writeZip([{ name: 'a.txt', data: Buffer.from('content'), comment: S('ZipDeflatedComment'), modified: new Date(Date.UTC(2025, 0, 2)) }], { comment: S('ZipDeflatedArchive') }), secrets: [S('ZipDeflatedComment'), S('ZipDeflatedArchive')] });
  return items;
}

// ---------- audio and video ----------

function mediaItems() {
  const m = (id, name, format, family, data, secrets, policy = []) => ({ id, name, format, family, source: 'built-in', data, secrets, policy });
  const mp3Tags = id3v2([id3Text('TIT2', S('Id3Title')), id3Text('TPE1', S('Id3Artist')), id3frame('COMM', Buffer.concat([Buffer.from([3]), latin('eng'), latin('note\0'), latin(S('Id3Comment'))])), id3frame('TXXX', Buffer.concat([Buffer.from([3]), latin('Where\0'), latin(GPS.iso)])), id3frame('APIC', Buffer.concat([Buffer.from([0]), latin('image/jpeg\0'), Buffer.from([3]), latin('front\0'), jpeg(S('Id3CoverComment'))])), id3frame('PRIV', Buffer.concat([latin('owner\0'), latin(S('Id3Priv'))]))]);
  const id3Secrets = [S('Id3Title'), S('Id3Artist'), S('Id3Comment'), S('Id3CoverComment'), S('Id3Priv'), GPS.iso];
  const v1 = id3v1({ title: S('Id3v1Title'), artist: S('Id3v1Artist') });
  const ape = apeTag([['Title', latin(S('ApeTitle'))], ['Artist', latin(S('ApeArtist'))]]);
  const fx = mp4({ ilst: true, xmpUuid: true, trailer: S('Mp4Trailer'), freeLeftover: S('Mp4FreeLeftover') });
  return [
    m('mp4-fixture', 'clip.mp4', 'MP4', 'mp4', fx.file, ['+37.3317-122.0302', '+40.7128-074.0060', 'iPhone 15 Pro', 'Secret Title', 'buyer-account-7731', 'cover note', 'Premiere', S('Mp4Trailer'), S('Mp4FreeLeftover'), 'LOCATION-SAMPLE']),
    m('mov-gopro', 'gopro.mov', 'MOV', 'mp4', mp4({ gopro: true, brand: 'qt  ', udta: false, mdta: false }).file, ['HERO12 Black', 'C3471325208909']),
    m('mp3-fixture', 'song.mp3', 'MP3', 'mpeg', Buffer.concat([mp3Tags, mp3Frames(), ape, v1]), [...id3Secrets, S('Id3v1Title'), S('Id3v1Artist'), S('ApeTitle'), S('ApeArtist')]),
    m('aac-fixture', 'audio.aac', 'AAC', 'mpeg', Buffer.concat([mp3Tags, adtsFrames(), ape]), [...id3Secrets, S('ApeTitle'), S('ApeArtist')]),
    m('flac-fixture', 'audio.flac', 'FLAC', 'flac', flac({ id3: true, id3end: true }).file, ['Jane Doe', '+48.8584+002.2945', 'flac cover', 'Prepended', 'Old Artist', 'leftover', 'INFOISFT']),
    m('wav-fixture', 'audio.wav', 'WAV', 'wav', wav({ trailer: S('WavTrailer') }).file, ['Jane Doe', 'Recorder 2.1', 'ZOOM H6', 'SN-H6-998877', 'Secret Project', 'Audition', 'Tagged Artist', S('WavTrailer')]),
    m('aiff-fixture', 'audio.aiff', 'AIFF', 'aiff', aiff().file, ['Jane Doe', 'Demo take', 'rough mix', 'Tagged', 'PRO TOOLS SESSION']),
    m('ogg-fixture', 'audio.ogg', 'Ogg', 'ogg', ogg().file, ['Podcast 12', 'Jane Doe', 'ENCODED_BY', 'ogg cover'], ['Xiph.Org libVorbis']),
    m('opus-fixture', 'audio.opus', 'Opus', 'ogg', ogg({ codec: 'Opus' }).file, ['Podcast 12', 'Jane Doe', 'ENCODED_BY', 'ogg cover'], ['libopus 1.4']),
    m('mkv-fixture', 'video.mkv', 'MKV', 'mkv', mkv().file, ['Family dinner', 'Jane Doe', '+51.5007-000.1246', 'the secret', 'attachment note', 'poster.jpg', 'Recorded on Jane'], ['Opening', 'mkvmerge v80.0']),
    m('webm-fixture', 'video.webm', 'WebM', 'mkv', mkv({ webm: true }).file, ['Family dinner', 'Jane Doe', '+51.5007-000.1246', 'the secret', 'Recorded on Jane'], ['mkvmerge v80.0']),
  ];
}

// ---------- text ----------

function textItems() {
  const tags = [...S('TextTag')].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  const body = `﻿Visible​ line one‍\nSecond‮ line ${tags}\u{E007F}\nThird⁦ line︀︁︂︃\n`;
  return [{ id: 'text-builtin', name: 'notes.txt', format: 'Text', family: 'text', source: 'built-in', data: Buffer.from(body, 'utf8'), secrets: [], hiddenText: true }];
}

// ---------- HEIF family and TIFF ----------
// The ExifTool-written fixtures carry EXIF, XMP and GPS. HEIF is the HEIC file with every brand set to mif1.

const PII = ['Jane Doe', 'SN-0042-7781', 'Austin', 'Adobe Firefly', 'Canon EOS R5'];
function heifItems() {
  const heic = Buffer.from(sample('formats/pii.heic'));
  const heif = Buffer.from(heic); const ftypEnd = heif.readUInt32BE(0);
  for (let o = 8; o + 4 <= ftypEnd; o += 4) if (o !== 12) heif.write('mif1', o, 'latin1');
  return [
    { id: 'heic-builtin', name: 'pii.heic', format: 'HEIC', family: 'heif', source: 'built-in', data: heic, secrets: PII },
    { id: 'heif-builtin', name: 'pii.heif', format: 'HEIF', family: 'heif', source: 'built-in', data: heif, secrets: PII },
    { id: 'avif-builtin', name: 'pii.avif', format: 'AVIF', family: 'heif', source: 'built-in', data: sample('formats/pii.avif'), secrets: PII },
    { id: 'tiff-builtin', name: 'pii.tif', format: 'TIFF', family: 'tiff', source: 'built-in', data: sample('formats/pii.tif'), secrets: PII },
  ];
}

// ---------- unusual placements ----------
// Metadata in the places a parser is most likely to miss: extension segments, chunks after the image data,
// unknown chunk types, data around the file, orphaned parts and ZIP local headers that disagree with the
// central directory.

function hostileImages() {
  const xmpExt = Buffer.concat([latin('http://ns.adobe.com/xmp/extension/\0'), latin('0123456789ABCDEF0123456789ABCDEF'), Buffer.from([0, 0, 0, 40, 0, 0, 0, 0]), latin(`<x:xmpmeta>${S('JpegXmpExtended')}</x:xmpmeta>`)]);
  const jfxx = Buffer.concat([latin('JFXX\0'), Buffer.from([0x10]), jpegWith(segment(0xfe, latin(S('JpegJfxxThumb'))))]);
  const jpegData = jpegWith(segment(0xe0 + 1, xmpExt), segment(0xe0, jfxx), segment(0xec, Buffer.concat([latin('Ducky'), Buffer.from([0, 1, 0, 0, 0, 4]), latin(S('JpegDucky'))])), segment(0xe4, latin(S('JpegApp4Unknown'))), segment(0xe2, Buffer.concat([latin('FPXR\0'), latin(S('JpegFlashPix'))])));
  const head = pngWith(chunk('ptSc', latin(S('PngPrivateChunk'))), chunk('caBX', latin(S('PngCaBX'))));
  const iend = head.length - 12;
  const pngData = Buffer.concat([head.subarray(0, iend), tEXt('Comment', S('PngTextAfterIdat')), chunk('eXIf', tiff([[0x013b, 2, S('PngExifAfterIdat')]])), head.subarray(iend)]);
  const webpData = webpWith({ PTSC: latin(S('WebpUnknownChunk')), EXIF: tiff([[0x013b, 2, S('WebpExifArtist')]]) });
  const appExt = Buffer.concat([Buffer.from([0x21, 0xff, 11]), latin('PTSECAPP1.0'), Buffer.from([S('GifAppExtension').length]), latin(S('GifAppExtension')), Buffer.from([0])]);
  const g = gif({ comment: S('GifCommentBefore') });
  const gifData = Buffer.concat([g.subarray(0, 19), appExt, g.subarray(19, g.length - 1), Buffer.from([0x21, 0xfe, S('GifCommentAfter').length]), latin(S('GifCommentAfter')), Buffer.from([0, 0x3b])]);
  // A JFIF header carrying an uncompressed 4x4 RGB preview.
  const preview = Buffer.alloc(48); latin(S('JfifThumbPixels')).copy(preview, 4);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0, 16 + 48]), latin('JFIF\0'), Buffer.from([1, 2, 1, 0, 72, 0, 72, 4, 4]), preview]);
  const jfifData = Buffer.concat([base.jpeg.subarray(0, 2), app0, base.jpeg.subarray(4 + base.jpeg.readUInt16BE(4))]);
  return [
    { id: 'jpeg-jfif-thumbnail', name: 'jfif-thumb.jpg', format: 'JPEG', family: 'jpeg', source: 'built-in', data: jfifData, secrets: [S('JfifThumbPixels')] },
    { id: 'jpeg-hostile', name: 'hostile.jpg', format: 'JPEG', family: 'jpeg', source: 'built-in', data: jpegData, secrets: [S('JpegXmpExtended'), S('JpegJfxxThumb'), S('JpegDucky'), S('JpegFlashPix')], policy: [S('JpegApp4Unknown')] },
    { id: 'png-hostile', name: 'hostile.png', format: 'PNG', family: 'png', source: 'built-in', data: pngData, secrets: [S('PngCaBX'), S('PngTextAfterIdat'), S('PngExifAfterIdat')], policy: [S('PngPrivateChunk')] },
    { id: 'webp-hostile', name: 'hostile.webp', format: 'WebP', family: 'webp', source: 'built-in', data: webpData, secrets: [S('WebpExifArtist')], policy: [S('WebpUnknownChunk')] },
    { id: 'gif-hostile', name: 'hostile.gif', format: 'GIF', family: 'gif', source: 'built-in', data: gifData, secrets: [S('GifCommentBefore'), S('GifCommentAfter')], policy: [S('GifAppExtension')] },
  ];
}

function hostilePdf() {
  const objects = basic({
    page: `/Thumb 6 0 R /AA << /O 7 0 R >>`,
    resources: '/XObject << /Im1 8 0 R >>',
    content: 'q 16 0 0 12 72 600 cm /Im1 Do Q BT /F1 12 Tf 72 720 Td (Visible page text) Tj ET',
    extra: {
      6: stream('<< /Width 16 /Height 12 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', jpegWith(segment(0xfe, latin(S('PdfThumbComment'))))),
      7: `<< /S /JavaScript /JS (var z = "${S('PdfPageOpenJs')}";) >>`,
      8: stream('<< /Type /XObject /Subtype /Image /Width 16 /Height 12 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Metadata 9 0 R >>', base.jpeg),
      9: stream('<< /Type /Metadata /Subtype /XML >>', xmp(`<xmp:CreatorTool>${S('PdfImageXmp')}</xmp:CreatorTool>`)),
      10: `% ${S('PdfComment')}\n<< /Unrelated true >>`,
    },
  });
  const data = Buffer.concat([pdf(objects, { trailer: '/Root 1 0 R', prefix: `${S('PdfPrefix')}\n` }), latin(`${S('PdfAfterEof')}\n`)]);
  // A signed widget on a page with no form field list pointing at it.
  const sigOnly = pdf(basic({ page: '/Annots [7 0 R]', extra: {
    7: '<< /FT /Sig /T (Signature1) /V 8 0 R /Type /Annot /Subtype /Widget /Rect [0 0 0 0] >>',
    8: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (${S('PdfOrphanSigName')}) /Reason (${S('PdfOrphanSigReason')}) /M (D:20261001093000Z) /ByteRange [0 100 200 50] /Contents <00> >>`,
  } }), { trailer: '/Root 1 0 R' });
  return [{ id: 'pdf-sig-no-form', name: 'sig-no-form.pdf', format: 'PDF', family: 'pdf', source: 'built-in', data: sigOnly, secrets: [S('PdfOrphanSigName'), S('PdfOrphanSigReason')], options: { removeSignatures: true }, exiftoolControl: false },
    { id: 'pdf-hostile', name: 'hostile.pdf', format: 'PDF', family: 'pdf', source: 'built-in', data, secrets: [S('PdfThumbComment'), S('PdfPageOpenJs'), S('PdfImageXmp'), S('PdfComment'), S('PdfPrefix'), S('PdfAfterEof')], exiftoolControl: false }];
}

async function hostileDocuments() {
  const parts = await unzipEntries(await docx());
  const label = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{11111111-2222-3333-4444-555555555555}" enabled="1" method="Standard" siteId="{${S('DocxLabelTenant')}}" removed="0"/></clbl:labelList>`;
  const withLabel = parts.map((p) => {
    const t = () => Buffer.from(p.data).toString('utf8');
    if (p.name === '_rels/.rels') return { ...p, data: Buffer.from(t().replace('</Relationships>', '<Relationship Id="rIdLabel" Type="http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels" Target="docMetadata/LabelInfo.xml"/></Relationships>')) };
    if (p.name === '[Content_Types].xml') return { ...p, data: Buffer.from(t().replace('</Types>', '<Override PartName="/docMetadata/LabelInfo.xml" ContentType="application/vnd.ms-office.classificationlabels+xml"/></Types>')) };
    return p;
  });
  withLabel.push({ name: 'docMetadata/LabelInfo.xml', data: Buffer.from(label) }, { name: 'word/orphan-notes.xml', data: Buffer.from(`<notes>${S('DocxOrphanPart')}</notes>`) });
  const docxData = await writeZip(withLabel);
  // ZIP whose local headers disagree with the central directory: a different name and an extra field that
  // only the local header carries, plus an entry no central record points at.
  const zipData = Buffer.from(rawZip([{ name: 'PTsecZipCentralNm.txt', data: Buffer.from('visible content') }, { name: 'b.txt', data: Buffer.from('more content') }]));
  zipData.write(S('ZipLocalName'), 30, 'latin1'); // same length as the central name, so offsets stay valid
  const orphan = rawZip([{ name: 'hidden.txt', data: latin(S('ZipOrphanLocal')) }]);
  const orphanLocal = orphan.subarray(0, orphan.indexOf(Buffer.from([0x50, 0x4b, 1, 2])));
  const cd = zipData.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
  const eocd = zipData.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const shifted = Buffer.concat([zipData.subarray(0, cd), orphanLocal, zipData.subarray(cd)]);
  shifted.writeUInt32LE(cd + orphanLocal.length, eocd + orphanLocal.length + 16);
  return [
    { id: 'docx-hostile', name: 'hostile.docx', format: 'DOCX', family: 'ooxml', source: 'built-in', data: docxData, secrets: [...fixtureSecrets(docxData), S('DocxLabelTenant')], policy: [S('DocxOrphanPart')] },
    { id: 'zip-hostile', name: 'hostile.zip', format: 'ZIP', family: 'zip', source: 'built-in', data: shifted, secrets: [S('ZipOrphanLocal'), S('ZipLocalName')] },
  ];
}

// Top-level boxes after moov, an EBML Void at the end of a Matroska segment, extra RIFF chunks, a FLAC
// application block and tags at the end of an MP3.
function hostileMedia(made) {
  const out = [];
  const pick = (id) => made.find((i) => i.id === id);
  const m4 = pick('mov-ffmpeg-udta');
  if (m4) {
    const extra = Buffer.concat([box('free', latin(S('Mp4TopFree'))), box('skip', latin(S('Mp4TopSkip'))), box('uuid', Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'), latin(`<x:xmpmeta>${S('Mp4TopXmp')}</x:xmpmeta>`)), box('udta', box('\xa9nam', u16(S('Mp4TopUdta').length), u16(0), latin(S('Mp4TopUdta'))))]);
    out.push({ ...m4, id: 'mov-hostile', name: 'hostile.mov', data: Buffer.concat([m4.data, extra]), secrets: [S('Mp4TopFree'), S('Mp4TopSkip'), S('Mp4TopXmp'), S('Mp4TopUdta')], policy: [] });
  }
  const mk = pick('mkv-ffmpeg');
  if (mk) {
    const b = Buffer.from(mk.data); const at = b.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
    const v = latin(S('MkvVoid')); const voidEl = Buffer.concat([Buffer.from([0xec, 0x80 | v.length]), v]);
    if (at > 0 && b[at + 4] === 0x01) {
      const size = b.readBigUInt64BE(at + 4) & 0x00ffffffffffffffn; const nb = Buffer.from(b);
      nb.writeBigUInt64BE((size + BigInt(voidEl.length)) | 0x0100000000000000n, at + 4);
      out.push({ ...mk, id: 'mkv-hostile', name: 'hostile.mkv', data: Buffer.concat([nb, voidEl]), secrets: [S('MkvVoid')], policy: [S('MediaChapterTitle'), 'Lavf'] });
    }
  }
  const wv = pick('wav-ffmpeg');
  if (wv) {
    const rc = (id, body) => Buffer.concat([latin(id), u32(body.length, true), body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    const extra = Buffer.concat([rc('LIST', Buffer.concat([latin('adtl'), rc('labl', Buffer.concat([u32(1, true), latin(`${S('WavCueLabel')}\0`)]))])), rc('cart', Buffer.concat([latin('0101'), latin(S('WavCart').padEnd(64, '\0'))])), rc('pTsc', latin(S('WavUnknownChunk')))]);
    const nb = Buffer.concat([Buffer.from(wv.data), extra]); nb.writeUInt32LE(nb.length - 8, 4);
    out.push({ ...wv, id: 'wav-hostile', name: 'hostile.wav', data: nb, secrets: [S('WavCueLabel'), S('WavCart')], policy: [S('WavUnknownChunk')] });
  }
  const fl = pick('flac-ffmpeg');
  if (fl) {
    const b = Buffer.from(fl.data); const app = Buffer.concat([latin('PTSC'), latin(S('FlacApplication'))]);
    const block = Buffer.concat([Buffer.from([2, app.length >> 16, (app.length >> 8) & 255, app.length & 255]), app]);
    out.push({ ...fl, id: 'flac-hostile', name: 'hostile.flac', data: Buffer.concat([b.subarray(0, 42), block, b.subarray(42)]), secrets: [S('FlacApplication')], policy: ['Lavf'] });
  }
  const mp = pick('mp3-ffmpeg');
  if (mp) {
    const b = Buffer.from(mp.data); const v1 = b.subarray(b.length - 128);
    const tag24 = id3v2([id3Text('TIT2', S('Mp3AppendedId3'), 4)], { version: 4, flags: 0x10 });
    const footer = Buffer.concat([latin('3DI'), tag24.subarray(3, 10)]);
    // ffmpeg reads tags appended after ID3v1-less audio as part of the last frame, so packets are compared
    // with the file before they were appended.
    out.push({ ...mp, packetReference: mp.data, id: 'mp3-hostile', name: 'hostile.mp3', data: Buffer.concat([b.subarray(0, b.length - 128), tag24, footer, lyrics3([['LYR', S('Mp3Lyrics3')]]), v1]), secrets: [S('Mp3AppendedId3'), S('Mp3Lyrics3')], policy: ['LAME'] });
  }
  return out;
}

// ---------- external generators ----------

function exiftoolItems(tools, dir) {
  if (!tools.exiftool) return { items: [], skipped: ['ExifTool-written photos and PDF (ExifTool not found)'] };
  const et = tools.exiftool.cmd;
  const items = [];
  const tagArgs = (p) => [
    `-EXIF:Artist=${S(`${p}EtArtist`)}`, `-EXIF:Copyright=${S(`${p}EtCopyright`)}`, `-EXIF:ImageDescription=${S(`${p}EtDescription`)}`, `-EXIF:Make=${S(`${p}EtMake`)}`, `-EXIF:Model=${S(`${p}EtModel`)}`,
    `-EXIF:SerialNumber=${S(`${p}EtSerial`)}`, `-EXIF:OwnerName=${S(`${p}EtOwner`)}`, `-EXIF:UserComment=${S(`${p}EtUserComment`)}`, `-EXIF:DateTimeOriginal=2025:01:02 03:04:05`,
    `-GPSLatitude=${GPS.lat}`, '-GPSLatitudeRef=N', `-GPSLongitude=${-GPS.lon}`, '-GPSLongitudeRef=W', '-GPSAltitude=150',
    `-XMP-dc:Creator=${S(`${p}EtXmpCreator`)}`, `-XMP-dc:Description=${S(`${p}EtXmpDescription`)}`, `-XMP-photoshop:City=${S(`${p}EtXmpCity`)}`, `-XMP-xmp:CreatorTool=${S(`${p}EtXmpTool`)}`,
    `-XMP-iptcCore:CreatorWorkEmail=${S(`${p}EtXmpEmail`)}`, `-XMP-exif:GPSLatitude=${GPS.lat}`, `-XMP-exif:GPSLongitude=${GPS.lon}`,
  ];
  const baseSecrets = (p) => ['EtArtist', 'EtCopyright', 'EtDescription', 'EtMake', 'EtModel', 'EtSerial', 'EtOwner', 'EtUserComment', 'EtXmpCreator', 'EtXmpDescription', 'EtXmpCity', 'EtXmpTool', 'EtXmpEmail'].map((k) => S(p + k));
  const write = (id, name, format, family, input, args, secrets) => {
    const src = join(dir, `in-${name}`); const out = join(dir, name);
    writeFileSync(src, input);
    const r = run(et[0], [...et.slice(1), '-q', '-q', '-m', ...args, '-o', out, src]);
    if (r.status !== 0) return;
    items.push({ id, name, format, family, source: 'exiftool', data: readFileSync(out), secrets });
  };
  write('jpeg-exiftool', 'et.jpg', 'JPEG', 'jpeg', base.jpeg, [...tagArgs('Jpeg'), `-IPTC:By-line=${S('JpegEtIptcByline')}`, `-IPTC:Caption-Abstract=${S('JpegEtIptcCaption')}`, `-IPTC:City=${S('JpegEtIptcCity')}`, `-Comment=${S('JpegEtComment')}`],
    [...baseSecrets('Jpeg'), S('JpegEtIptcByline'), S('JpegEtIptcCaption'), S('JpegEtIptcCity'), S('JpegEtComment')]);
  write('png-exiftool', 'et.png', 'PNG', 'png', base.png, [...tagArgs('Png'), `-PNG:Author=${S('PngEtAuthor')}`, `-PNG:Comment=${S('PngEtComment')}`, `-PNG:Title=${S('PngEtTitle')}`, '-PNG:CreationTime=2025:01:02 03:04:05'],
    [...baseSecrets('Png'), S('PngEtAuthor'), S('PngEtComment'), S('PngEtTitle')]);
  write('webp-exiftool', 'et.webp', 'WebP', 'webp', base.webp, tagArgs('Webp'), baseSecrets('Webp'));
  write('gif-exiftool', 'et.gif', 'GIF', 'gif', gif(), [`-Comment=${S('GifEtComment')}`, `-XMP-dc:Creator=${S('GifEtXmpCreator')}`, `-XMP-photoshop:City=${S('GifEtXmpCity')}`], [S('GifEtComment'), S('GifEtXmpCreator'), S('GifEtXmpCity')]);
  const plainPdf = pdf(basic(), { trailer: '/Root 1 0 R' });
  write('pdf-exiftool', 'et.pdf', 'PDF', 'pdf', plainPdf, [`-PDF:Author=${S('PdfEtAuthor')}`, `-PDF:Title=${S('PdfEtTitle')}`, `-PDF:Subject=${S('PdfEtSubject')}`, `-PDF:Keywords=${S('PdfEtKeywords')}`, `-PDF:Creator=${S('PdfEtCreator')}`, `-PDF:Producer=${S('PdfEtProducer')}`, `-XMP-dc:Creator=${S('PdfEtXmpCreator')}`, `-XMP-pdf:Producer=${S('PdfEtXmpProducer')}`, `-XMP-xmpMM:DocumentID=${S('PdfEtXmpDocId')}`],
    ['PdfEtAuthor', 'PdfEtTitle', 'PdfEtSubject', 'PdfEtKeywords', 'PdfEtCreator', 'PdfEtProducer', 'PdfEtXmpCreator', 'PdfEtXmpProducer', 'PdfEtXmpDocId'].map(S));
  return { items, skipped: [] };
}

function ffmpegItems(tools, dir) {
  if (!tools.ffmpeg) return { items: [], skipped: ['ffmpeg-made audio and video (ffmpeg not found)'] };
  const ff = tools.ffmpeg.cmd[0];
  const items = []; const skipped = [];
  const cover = join(dir, 'cover.jpg'); writeFileSync(cover, jpegWith(segment(0xfe, latin(S('MediaCoverComment'))), exifSegment(tiff([[0x013b, 2, S('MediaCoverArtist')]]))));
  const chapters = join(dir, 'chapters.txt');
  writeFileSync(chapters, `;FFMETADATA1\ntitle=${S('MediaFfmetaTitle')}\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=250\ntitle=${S('MediaChapterTitle')}\n`);
  const V = ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=0.5'];
  const A = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=0.5'];
  const tags = (p) => ['-metadata', `title=${S(`${p}Title`)}`, '-metadata', `artist=${S(`${p}Artist`)}`, '-metadata', `comment=${S(`${p}Comment`)}`, '-metadata', `album=${S(`${p}Album`)}`, '-metadata', `copyright=${S(`${p}Copyright`)}`, '-metadata', `description=${S(`${p}Description`)}`, '-metadata', 'creation_time=2025-01-02T03:04:05Z'];
  const tagSecrets = (p) => ['Title', 'Artist', 'Comment', 'Album', 'Copyright', 'Description'].map((k) => S(p + k));
  const gen = (id, name, format, family, args, secrets, policy = [], post = null) => {
    const out = join(dir, name);
    const r = run(ff, ['-v', 'error', '-y', ...args, out], { timeout: 120000 });
    if (r.status !== 0) { skipped.push(`${id} (ffmpeg: ${r.stderr.trim().split('\n').at(-1)})`); return; }
    let data = readFileSync(out);
    if (post) data = post(data);
    items.push({ id, name, format, family, source: 'ffmpeg', data, secrets, policy });
  };
  const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast'];
  const coverIn = ['-i', cover];
  const coverMap = (n) => ['-map', `${n}:v`, `-disposition:v:${n === 2 ? 1 : 0}`, 'attached_pic', '-c:v:' + (n === 2 ? 1 : 0), 'copy'];
  const coverSecrets = [S('MediaCoverComment'), S('MediaCoverArtist')];
  const streamTitle = (p) => ['-metadata:s:a:0', `title=${S(`${p}StreamTitle`)}`, '-metadata:s:a:0', `handler_name=${S(`${p}Handler`)}`];
  const chapterIn = ['-i', chapters];
  // MP4 family: iTunes-style tags, QuickTime ©xyz location, chapters, cover art and stream handler names.
  gen('mp4-ffmpeg', 'ff.mp4', 'MP4', 'mp4', [...V, ...A, ...coverIn, ...chapterIn, '-map', '0:v', '-map', '1:a', '-map', '2:v', '-map_chapters', '3', '-map_metadata', '3', ...H264, '-c:a', 'aac', '-c:v:1', 'copy', '-disposition:v:1', 'attached_pic', ...tags('Mp4Ff'), '-metadata', `location=${GPS.iso}`, ...streamTitle('Mp4Ff')],
    [...tagSecrets('Mp4Ff'), ...coverSecrets, S('Mp4FfStreamTitle')], [S('Mp4FfHandler'), S('MediaChapterTitle')]);
  gen('mov-ffmpeg', 'ff.mov', 'MOV', 'mp4', [...V, ...A, '-map', '0:v', '-map', '1:a', ...H264, '-c:a', 'aac', '-movflags', 'use_metadata_tags', ...tags('MovFf'), '-metadata', `com.apple.quicktime.location.ISO6709=${GPS.iso}`, '-metadata', `com.apple.quicktime.make=${S('MovFfMake')}`, '-metadata', `com.apple.quicktime.model=${S('MovFfModel')}`, '-metadata', `com.apple.quicktime.software=${S('MovFfSoftware')}`, '-metadata', `com.apple.quicktime.author=${S('MovFfAuthor')}`],
    [...tagSecrets('MovFf'), GPS.iso, S('MovFfMake'), S('MovFfModel'), S('MovFfSoftware'), S('MovFfAuthor')]);
  gen('mov-ffmpeg-udta', 'ff-udta.mov', 'MOV', 'mp4', [...V, ...A, '-map', '0:v', '-map', '1:a', ...H264, '-c:a', 'aac', ...tags('MovUdta'), '-metadata', `location=${GPS.iso}`], [...tagSecrets('MovUdta').filter((s) => !s.endsWith('Description')), GPS.iso]);
  gen('m4a-ffmpeg', 'ff.m4a', 'M4A', 'mp4', [...A, ...coverIn, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', ...tags('M4aFf'), ...streamTitle('M4aFf')], [...tagSecrets('M4aFf'), ...coverSecrets], [S('M4aFfHandler')]);
  gen('3gp-ffmpeg', 'ff.3gp', '3GP', 'mp4', [...V, ...A, '-map', '0:v', '-map', '1:a', ...H264, '-c:a', 'aac', '-ac', '1', '-ar', '8000', ...tags('ThreeGpFf'), '-f', '3gp'], tagSecrets('ThreeGpFf').filter((s) => !s.endsWith('Description')));
  // MPEG audio: ID3v2 and ID3v1 with cover art. MP2 and ADTS get tags prepended and appended in code.
  gen('mp3-ffmpeg', 'ff.mp3', 'MP3', 'mpeg', [...A, ...coverIn, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'copy', '-id3v2_version', '3', '-write_id3v1', '1', ...tags('Mp3Ff')], [...tagSecrets('Mp3Ff'), ...coverSecrets], ['LAME']);
  const id3 = id3v2([id3Text('TIT2', S('Mp2FfId3Title')), id3Text('TPE1', S('Mp2FfId3Artist'))]);
  gen('mp2-ffmpeg', 'ff.mp2', 'MP2', 'mpeg', [...A, '-c:a', 'mp2', '-f', 'mp2'], [S('Mp2FfId3Title'), S('Mp2FfId3Artist'), S('Mp2FfV1Title')], [], (b) => Buffer.concat([id3, b, id3v1({ title: S('Mp2FfV1Title') })]));
  const ape = apeTag([['Title', latin(S('AacFfApeTitle'))]]);
  gen('aac-ffmpeg', 'ff.aac', 'AAC', 'mpeg', [...A, '-c:a', 'aac', '-f', 'adts'], [S('AacFfId3Title'), S('AacFfApeTitle')], [], (b) => Buffer.concat([id3v2([id3Text('TIT2', S('AacFfId3Title'))]), b, ape]));
  // WAV: LIST INFO and a broadcast extension chunk. AIFF: an ID3 chunk.
  gen('wav-ffmpeg', 'ff.wav', 'WAV', 'wav', [...A, ...tags('WavFf'), '-write_bext', '1', '-metadata', `originator=${S('WavFfOriginator')}`, '-metadata', `originator_reference=${S('WavFfOrigRef')}`, '-metadata', `coding_history=${S('WavFfHistory')}`], [S('WavFfTitle'), S('WavFfArtist'), S('WavFfComment'), S('WavFfCopyright'), S('WavFfOriginator'), S('WavFfOrigRef'), S('WavFfHistory')]);
  gen('aiff-ffmpeg', 'ff.aiff', 'AIFF', 'aiff', [...A, '-write_id3v2', '1', ...tags('AiffFf')], tagSecrets('AiffFf'));
  // FLAC, Ogg Vorbis and Opus: Vorbis comments and pictures.
  gen('flac-ffmpeg', 'ff.flac', 'FLAC', 'flac', [...A, ...coverIn, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', ...tags('FlacFf')], [...tagSecrets('FlacFf'), ...coverSecrets], ['Lavf']);
  gen('ogg-ffmpeg', 'ff.ogg', 'Ogg', 'ogg', [...A, '-c:a', 'libvorbis', ...tags('OggFf')], tagSecrets('OggFf'), ['Lavf']);
  gen('opus-ffmpeg', 'ff.opus', 'Opus', 'ogg', [...A, '-c:a', 'libopus', ...tags('OpusFf')], tagSecrets('OpusFf'), ['Lavf']);
  // Matroska and WebM: tags, chapters, attachments, segment and track titles.
  gen('mkv-ffmpeg', 'ff.mkv', 'MKV', 'mkv', [...V, ...A, ...chapterIn, '-map', '0:v', '-map', '1:a', '-map_chapters', '2', ...H264, '-c:a', 'aac', ...tags('MkvFf'), '-metadata:s:v:0', `title=${S('MkvFfTrackName')}`, '-attach', cover, '-metadata:s:t', 'mimetype=image/jpeg'],
    [...tagSecrets('MkvFf'), ...coverSecrets, S('MkvFfTrackName')], [S('MediaChapterTitle'), 'Lavf']);
  gen('webm-ffmpeg', 'ff.webm', 'WebM', 'mkv', [...V, ...A, ...chapterIn, '-map', '0:v', '-map', '1:a', '-map_chapters', '2', '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', ...tags('WebmFf')], tagSecrets('WebmFf'), [S('MediaChapterTitle'), 'Lavf']);
  return { items, skipped };
}

const PY_DOCS = String.raw`
import sys, datetime
out = sys.argv[1]
S = lambda k: 'PTsec' + k
made = []
when = datetime.datetime(2025, 1, 2, 3, 4, 5)
try:
    import docx
    d = docx.Document()
    p = d.add_paragraph('Visible python-docx body')
    cp = d.core_properties
    cp.author = S('PyDocxAuthor'); cp.last_modified_by = S('PyDocxEditor'); cp.title = S('PyDocxTitle'); cp.subject = S('PyDocxSubject')
    cp.keywords = S('PyDocxKeywords'); cp.comments = S('PyDocxComments'); cp.category = S('PyDocxCategory'); cp.content_status = S('PyDocxStatus')
    cp.identifier = S('PyDocxIdentifier'); cp.created = when; cp.modified = when; cp.last_printed = when
    if hasattr(d, 'add_comment'):
        d.add_comment(p.runs, text=S('PyDocxCommentText'), author=S('PyDocxCommentAuthor'), initials='PT')
        made.append('docx-comment')
    d.save(out + '/py.docx'); made.append('docx')
except ImportError:
    pass
try:
    import openpyxl
    from openpyxl.comments import Comment
    wb = openpyxl.Workbook(); ws = wb.active; ws['A1'] = 'Visible openpyxl cell'
    ws['A1'].comment = Comment(S('PyXlsxCommentText'), S('PyXlsxCommentAuthor'))
    pr = wb.properties
    pr.creator = S('PyXlsxCreator'); pr.lastModifiedBy = S('PyXlsxEditor'); pr.title = S('PyXlsxTitle'); pr.subject = S('PyXlsxSubject')
    pr.keywords = S('PyXlsxKeywords'); pr.description = S('PyXlsxDescription'); pr.category = S('PyXlsxCategory'); pr.created = when; pr.modified = when
    wb.save(out + '/py.xlsx'); made.append('xlsx')
except ImportError:
    pass
try:
    import pptx
    pr = pptx.Presentation(); slide = pr.slides.add_slide(pr.slide_layouts[5]); slide.shapes.title.text = 'Visible python-pptx title'
    cp = pr.core_properties
    cp.author = S('PyPptxAuthor'); cp.last_modified_by = S('PyPptxEditor'); cp.title = S('PyPptxTitle'); cp.subject = S('PyPptxSubject')
    cp.keywords = S('PyPptxKeywords'); cp.comments = S('PyPptxComments'); cp.category = S('PyPptxCategory'); cp.created = when; cp.modified = when
    pr.save(out + '/py.pptx'); made.append('pptx')
except ImportError:
    pass
try:
    from odf.opendocument import OpenDocumentText, OpenDocumentSpreadsheet
    from odf import meta, dc, text, office, table
    def fill(doc, p):
        doc.meta.addElement(meta.InitialCreator(text=S(p + 'InitialCreator')))
        doc.meta.addElement(dc.Creator(text=S(p + 'Creator')))
        doc.meta.addElement(dc.Title(text=S(p + 'Title')))
        doc.meta.addElement(dc.Description(text=S(p + 'Description')))
        doc.meta.addElement(dc.Subject(text=S(p + 'Subject')))
        doc.meta.addElement(meta.Keyword(text=S(p + 'Keyword')))
        doc.meta.addElement(meta.PrintedBy(text=S(p + 'PrintedBy')))
        doc.meta.addElement(meta.UserDefined(name='Client', text=S(p + 'UserDefined')))
        doc.meta.addElement(meta.CreationDate(text='2025-01-02T03:04:05'))
    t = OpenDocumentText(); fill(t, 'PyOdt')
    para = text.P(text='Visible odfpy paragraph')
    ann = office.Annotation(); ann.addElement(dc.Creator(text=S('PyOdtAnnotationAuthor'))); ann.addElement(text.P(text=S('PyOdtAnnotationText')))
    para.addElement(ann)
    t.text.addElement(para)
    t.save(out + '/py.odt'); made.append('odt')
    s = OpenDocumentSpreadsheet(); fill(s, 'PyOds')
    tb = table.Table(name='Sheet1'); row = table.TableRow(); cell = table.TableCell(); cell.addElement(text.P(text='Visible odfpy cell')); row.addElement(cell); tb.addElement(row)
    s.spreadsheet.addElement(tb)
    s.save(out + '/py.ods'); made.append('ods')
except ImportError:
    pass
print(' '.join(made))
`;

function pythonItems(tools, dir) {
  if (!tools.python) return { items: [], skipped: ['Python-made Office and ODF files (Python not found)'] };
  const missing = Object.entries(tools.python.modules ?? {}).filter(([, ok]) => !ok).map(([m]) => m);
  const script = join(dir, 'make-docs.py'); writeFileSync(script, PY_DOCS);
  const r = run(tools.python.cmd[0], [script, dir], { timeout: 120000 });
  const made = new Set(r.stdout.toString().trim().split(/\s+/).filter(Boolean));
  const items = []; const skipped = missing.length ? [`Python-made files needing ${missing.join(', ')} (not installed)`] : [];
  const add = (key, name, format, family, secrets) => { if (made.has(key)) items.push({ id: `${key}-python`, name, format, family, source: 'python', data: readFileSync(join(dir, name)), secrets }); };
  add('docx', 'py.docx', 'DOCX', 'ooxml', ['Author', 'Editor', 'Title', 'Subject', 'Keywords', 'Comments', 'Category', 'Status', 'Identifier', ...(made.has('docx-comment') ? ['CommentText', 'CommentAuthor'] : [])].map((k) => S(`PyDocx${k}`)));
  add('xlsx', 'py.xlsx', 'XLSX', 'ooxml', ['CommentText', 'CommentAuthor', 'Creator', 'Editor', 'Title', 'Subject', 'Keywords', 'Description', 'Category'].map((k) => S(`PyXlsx${k}`)));
  add('pptx', 'py.pptx', 'PPTX', 'ooxml', ['Author', 'Editor', 'Title', 'Subject', 'Keywords', 'Comments', 'Category'].map((k) => S(`PyPptx${k}`)));
  const odf = (p) => ['InitialCreator', 'Creator', 'Title', 'Description', 'Subject', 'Keyword', 'PrintedBy', 'UserDefined'].map((k) => S(p + k));
  add('odt', 'py.odt', 'ODT', 'odf', [...odf('PyOdt'), S('PyOdtAnnotationAuthor'), S('PyOdtAnnotationText')]);
  add('ods', 'py.ods', 'ODS', 'odf', odf('PyOds'));
  return { items, skipped };
}

export async function makeCorpus(tools = {}, { external = true } = {}) {
  const items = [jpegItem(), pngItem(), webpItem(), gifItem(), ...pdfItems(), ...(await documentItems()), ...mediaItems(), ...textItems(), ...heifItems(), ...hostileImages(), ...hostilePdf(), ...(await hostileDocuments())];
  const skipped = [];
  if (external) {
    const dir = mkdtempSync(join(tmpdir(), 'pt-corpus-'));
    try {
      for (const make of [exiftoolItems, ffmpegItems, pythonItems]) { const r = make(tools, dir); items.push(...r.items); skipped.push(...r.skipped); }
      items.push(...hostileMedia(items));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  for (const it of items) { it.data = new Uint8Array(it.data); it.policy ??= []; it.options ??= {}; it.expect ??= 'clean'; }
  return { items, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { findTools } = await import('./tools.mjs');
  const out = process.argv[2];
  if (!out) { console.error('usage: node tests/independent/make-corpus.mjs <output-dir>'); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const { items, skipped } = await makeCorpus(findTools());
  for (const it of items) writeFileSync(join(out, `${it.id}-${it.name}`), it.data);
  console.log(`${items.length} files written to ${out}`);
  for (const s of skipped) console.log(`skipped: ${s}`);
}
