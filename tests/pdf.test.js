import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { inspectFile } from '../site/tools/lib/metadata/index.js';
import { cleanFile } from '../site/tools/lib/clean/index.js';
import { PdfDocument } from '../site/tools/lib/metadata/pdf/document.js';
import { pdf, update, basic, stream, xmp, utf16, signedData } from './fixtures/pdf.js';
import { base, tiff, exifSegment, jpegWith, dms } from './fixtures/build.js';

const src = (r, source, key) => r.sources.find((s) => s.name === source)?.fields.find((f) => f.key === key)?.value;
const hl = (r, group, key) => r.highlights.find((g) => g.name === group)?.fields.find((f) => f.key === key)?.value;
const titles = (r) => r.signals.map((s) => s.title);
const kinds = (r) => r.blocks.map((b) => b.kind);
const has = (u8, s) => Buffer.from(u8).includes(Buffer.from(s, 'latin1'));
const NEVER = /\b(is|was) (definitely |certainly )?(ai[- ]generated|not ai|real|authentic|fake)\b|\bverified\b(?! here)/i;
const truthful = (r) => { for (const s of r.signals) assert.doesNotMatch(`${s.title} ${s.detail}`.replace(/not verif(y|ied)/gi, ''), NEVER); };

// Cleans, then checks what every cleaned PDF must satisfy.
async function cleaned(u8, options) {
  const res = await cleanFile(u8, 'test.pdf', options);
  assert.ok(res.ok, res.reason);
  const after = await inspectFile(res.data, 'test.pdf');
  assert.equal(after.format, 'PDF');
  assert.deepEqual(after.warnings, []);
  const doc = await PdfDocument.open(res.data, { warn: (m) => assert.fail(m) });
  assert.equal(doc.sections.length, 1, 'one revision');
  assert.equal(doc.sections[0].kind, 'table');
  for (const [num, e] of doc.entries) if (e.type === 1) assert.ok(has(res.data.subarray(e.offset, e.offset + 20), `${num} 0 obj`), `xref offset of ${num}`);
  return { res, after, doc };
}

const info = '/Info 6 0 R';
const infoObj = { 6: `<< /Title (Quarterly plan) /Author ${utf16('Jane Doé')} /Creator (Microsoft Word) /Producer (Acme PDF 2.1) /CreationDate (D:20240517134530+02'00') /ModDate (D:20240518090000Z) /Trapped /False /Department (Legal) >>` };

test('detection: header within the first kilobyte, document category', async () => {
  const r = await inspectFile(pdf(basic(), { trailer: '/Root 1 0 R' }));
  assert.equal(r.format, 'PDF'); assert.equal(r.category, 'Document');
  assert.equal(src(r, 'Container', 'Pages'), '1');
  assert.equal(src(r, 'Container', 'Page size'), '612 × 792 pt (Letter)');
  assert.equal(src(r, 'PDF fonts', 'Helvetica'), 'Type 1, not embedded');
  assert.deepEqual(r.warnings, []);
  const late = await inspectFile(pdf(basic(), { trailer: '/Root 1 0 R', prefix: 'x'.repeat(2000) }));
  assert.notEqual(late.format, 'PDF');
  const prefixed = await inspectFile(pdf(basic(), { trailer: '/Root 1 0 R', prefix: 'MIME junk\n'.repeat(20) }));
  assert.equal(prefixed.format, 'PDF');
  assert.ok(kinds(prefixed).includes('Header data'));
  assert.deepEqual(prefixed.warnings, []);
});

test('Info dictionary: values, PDF dates, UTF-16 text, custom keys and highlights', async () => {
  const r = await inspectFile(pdf(basic({ extra: infoObj }), { trailer: `/Root 1 0 R ${info}` }));
  assert.equal(src(r, 'PDF Info', 'Title'), 'Quarterly plan');
  assert.equal(src(r, 'PDF Info', 'Author'), 'Jane Doé');
  assert.equal(src(r, 'PDF Info', 'CreationDate'), '2024-05-17 13:45:30 +02:00');
  assert.equal(src(r, 'PDF Info', 'ModDate'), '2024-05-18 09:00:00 UTC');
  assert.equal(src(r, 'PDF Info', 'Department'), 'Legal');
  assert.equal(hl(r, 'People', 'Author'), 'Jane Doé');
  assert.equal(hl(r, 'Software', 'Producer'), 'Acme PDF 2.1');
  assert.ok(titles(r).includes('Names or ownership stored'));
  assert.ok(kinds(r).includes('Document info'));
  truthful(r);
});

test('XMP: document metadata with edit history and per-object metadata', async () => {
  const doc = xmp('<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator><pdf:Producer>Acme PDF 2.1</pdf:Producer><xmpMM:DocumentID>uuid:1111</xmpMM:DocumentID><xmpMM:InstanceID>uuid:2222</xmpMM:InstanceID><xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved" stEvt:softwareAgent="Adobe InDesign 18.0" stEvt:when="2024-05-01T10:00:00Z"/></rdf:Seq></xmpMM:History>');
  const img = xmp('<xmp:CreatorTool>Photoshop</xmp:CreatorTool>');
  const objects = basic({ catalog: '/Metadata 7 0 R', page: '/Metadata 8 0 R', extra: { 7: stream('<< /Type /Metadata /Subtype /XML >>', doc), 8: stream('<< /Type /Metadata /Subtype /XML >>', img, { flate: true }) } });
  const r = await inspectFile(pdf(objects, { trailer: '/Root 1 0 R' }));
  assert.equal(src(r, 'XMP dc', 'dc:creator'), 'Jane Doe');
  assert.equal(src(r, 'XMP xmpMM', 'xmpMM:DocumentID'), 'uuid:1111');
  assert.equal(hl(r, 'Software', 'Edit history'), 'Adobe InDesign 18.0');
  assert.equal(hl(r, 'File', 'Instance ID'), 'uuid:2222');
  assert.equal(src(r, 'XMP (page) xmp', 'xmp:CreatorTool'), 'Photoshop');
  assert.equal(r.blocks.filter((b) => b.kind === 'XMP').length, 2);
  const { after, res } = await cleaned(pdf(objects, { trailer: '/Root 1 0 R' }));
  assert.equal(after.blocks.filter((b) => b.removable !== false).length, 0);
  assert.ok(!has(res.data, 'Jane Doe') && !has(res.data, '/Metadata'));
});

test('incremental update: earlier revision, replaced Info values and leftover page content', async () => {
  const v1 = pdf(basic({ extra: { 6: '<< /Author (Original Author) /Title (Draft) >>' }, content: 'BT /F1 12 Tf 72 720 Td (Secret salary 90000) Tj ET' }), { trailer: `/Root 1 0 R ${info}` });
  const v2 = update(v1, { 4: stream('<< >>', 'BT /F1 12 Tf 72 720 Td (Public text) Tj ET'), 6: '<< /Author (Final Author) /Title (Draft) >>' }, `/Root 1 0 R ${info}`);
  const r = await inspectFile(v2);
  assert.equal(src(r, 'PDF history', 'Revisions'), '2');
  assert.ok(titles(r).includes('Earlier versions kept in the file'));
  assert.match(r.signals.find((s) => s.title === 'Earlier versions kept in the file').detail, /1 Info dictionary/);
  assert.match(r.signals.find((s) => s.title === 'Earlier versions kept in the file').detail, /1 content stream/);
  assert.equal(src(r, 'Earlier version 1 Info', 'Author'), 'Original Author');
  assert.equal(src(r, 'Earlier version 1 Info', 'Title'), undefined, 'unchanged values are not repeated');
  assert.equal(src(r, 'PDF Info', 'Author'), 'Final Author');
  const rev = r.blocks.find((b) => b.kind === 'Earlier version');
  assert.equal(rev.offset, 0); assert.equal(rev.length, v1.length);
  assert.deepEqual(r.structure.filter((s) => s.type.startsWith('Revision')).map((s) => [s.offset, s.length]), [[0, v1.length], [v1.length, v2.length - v1.length]]);
  const { res, after } = await cleaned(v2);
  assert.ok(!has(res.data, 'Secret salary') && !has(res.data, 'Original Author') && !has(res.data, 'Final Author'));
  assert.ok(has(res.data, 'Public text'));
  assert.equal(after.cleanable.blocks, 0);
  assert.ok(res.removed.some((b) => b.kind === 'Earlier version'));
});

test('JavaScript open action that calls home: canary signal, removed by cleaning', async () => {
  const objects = basic({ catalog: '/OpenAction 7 0 R /Names << /JavaScript << /Names [(init) 8 0 R] >> >>', extra: { 7: '<< /S /JavaScript /JS (app.launchURL\\("https://canary.example/t/abc123", false\\);) >>', 8: '<< /S /JavaScript /JS 9 0 R >>', 9: stream('<< >>', 'this.print({bUI: true});', { flate: true }) } });
  const u8 = pdf(objects, { trailer: '/Root 1 0 R' });
  const r = await inspectFile(u8);
  assert.ok(titles(r).includes('Contacts the internet when opened'));
  assert.ok(titles(r).includes('JavaScript inside'));
  assert.match(r.signals.find((s) => s.title === 'Contacts the internet when opened').detail, /canary\.example/);
  assert.equal(r.blocks.filter((b) => b.kind === 'Script').length, 2);
  assert.match(r.sources.find((s) => s.name === 'PDF actions').fields.map((f) => f.value).join(' '), /this\.print/);
  const { res, after } = await cleaned(u8);
  assert.ok(!has(res.data, '/JavaScript') && !has(res.data, '/OpenAction') && !has(res.data, 'canary'));
  assert.ok(!titles(after).includes('JavaScript inside'));
});

test('URI open action, additional actions and submit-form: removed; plain go-to open action kept', async () => {
  const objects = basic({ catalog: '/OpenAction << /S /URI /URI (https://tracker.example/open) >> /AA << /WC << /S /SubmitForm /F (https://tracker.example/close) >> >>', page: '/AA << /O << /S /Launch /F (calc.exe) >> >>' });
  const u8 = pdf(objects, { trailer: '/Root 1 0 R' });
  const r = await inspectFile(u8);
  assert.ok(titles(r).includes('Contacts the internet when opened'));
  assert.ok(titles(r).includes('Launches a program or file'));
  assert.equal(r.blocks.filter((b) => b.kind === 'Action').length, 3);
  const { res } = await cleaned(u8);
  assert.ok(!has(res.data, 'tracker.example') && !has(res.data, 'calc.exe') && !has(res.data, '/AA'));
  const goto = pdf(basic({ catalog: '/OpenAction [3 0 R /Fit]' }), { trailer: '/Root 1 0 R' });
  assert.equal((await inspectFile(goto)).blocks.filter((b) => b.kind === 'Action').length, 0);
});

test('embedded file: name, size, dates and the attachment itself inspected; removed by cleaning', async () => {
  const photo = jpegWith(exifSegment(tiff([[0x010f, 2, 'Canon']], { gps: [[0x0001, 2, 'N'], [0x0002, 5, dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, dms(97.74306)]] })));
  const objects = basic({ catalog: '/Names << /EmbeddedFiles << /Names [(holiday.jpg) 7 0 R] >> >>', extra: {
    7: '<< /Type /Filespec /F (holiday.jpg) /UF (holiday.jpg) /Desc (Beach photo) /EF << /F 8 0 R >> >>',
    8: stream("<< /Type /EmbeddedFile /Subtype /image#2Fjpeg /Params << /Size " + photo.length + " /CreationDate (D:20240101120000Z) >> >>", photo, { flate: true }),
  } });
  const u8 = pdf(objects, { trailer: '/Root 1 0 R' });
  const r = await inspectFile(u8);
  assert.match(src(r, 'PDF attachments', 'holiday.jpg'), /image\/jpeg, created 2024-01-01 12:00:00 UTC, Beach photo/);
  assert.equal(src(r, 'Attachment holiday.jpg', 'Format'), 'JPEG');
  assert.ok(titles(r).includes('Embedded files'));
  assert.ok(titles(r).includes('Exact location stored'), 'GPS inside the attachment is surfaced');
  const { res, after } = await cleaned(u8);
  assert.ok(!has(res.data, 'holiday.jpg') && !has(res.data, '/EmbeddedFile'));
  assert.equal(after.signals.length, 0);
});

test('annotations: comment authors found, comments removed, links and redaction marks kept', async () => {
  const objects = basic({ page: '/Annots 9 0 R', extra: {
    9: '[7 0 R 8 0 R << /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://example.org/) >> >> 10 0 R 11 0 R]',
    7: '<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /T (Bob Reviewer) /Contents (Please remove the salary table) /M (D:20240601100000Z) /Popup 8 0 R >>',
    8: '<< /Type /Annot /Subtype /Popup /Rect [30 30 90 90] /Parent 7 0 R >>',
    10: '<< /Type /Annot /Subtype /Highlight /Rect [0 0 50 10] /QuadPoints [0 10 50 10 0 0 50 0] /T (Carol) >>',
    11: '<< /Type /Annot /Subtype /Redact /Rect [100 100 200 120] /T (Eve) >>',
  } });
  const u8 = pdf(objects, { trailer: '/Root 1 0 R' });
  const r = await inspectFile(u8);
  assert.match(src(r, 'PDF comments', 'Page 1 sticky note'), /^Bob Reviewer: Please remove the salary table \(2024-06-01 10:00:00 UTC\)$/);
  assert.equal(hl(r, 'People', 'Comment author'), 'Bob Reviewer');
  assert.equal(hl(r, 'People', 'Redaction mark author'), 'Eve');
  assert.equal(src(r, 'PDF links', 'Page 1'), 'https://example.org/');
  assert.ok(titles(r).includes('Comments and markup'));
  assert.ok(titles(r).includes('Redaction marked but not applied'));
  assert.equal(r.blocks.filter((b) => b.kind === 'Comment').length, 2);
  const { res, after } = await cleaned(u8);
  assert.ok(!has(res.data, 'Bob Reviewer') && !has(res.data, 'Carol') && !has(res.data, '/Popup'));
  assert.ok(has(res.data, 'https://example.org/') && has(res.data, '/Redact') && !has(res.data, 'Eve'));
  assert.equal(after.blocks.filter((b) => b.kind === 'Link').length, 1);
  assert.ok(res.kept.includes('1 link, still clickable') && res.kept.some((k) => /redaction/.test(k)));
});

test('form fields: values reported and kept by default, cleared on request', async () => {
  const objects = basic({ catalog: '/AcroForm << /Fields [7 0 R 8 0 R] >>', page: '/Annots [7 0 R 8 0 R]', extra: {
    7: '<< /FT /Tx /T (fullname) /V (Jane Q. Public) /Type /Annot /Subtype /Widget /Rect [72 600 300 620] /AP << /N 9 0 R >> >>',
    8: '<< /FT /Btn /T (agree) /V /Yes /AS /Yes /Type /Annot /Subtype /Widget /Rect [72 560 90 578] >>',
    9: stream('<< /Type /XObject /Subtype /Form /BBox [0 0 228 20] >>', 'BT /F1 12 Tf 2 5 Td (Jane Q. Public) Tj ET'),
  } });
  const u8 = pdf(objects, { trailer: '/Root 1 0 R' });
  const r = await inspectFile(u8);
  assert.equal(src(r, 'PDF form', 'fullname'), 'Jane Q. Public');
  assert.equal(src(r, 'PDF form', 'agree'), 'Yes');
  assert.ok(titles(r).includes('Filled-in form data'));
  const kept = await cleaned(u8);
  assert.ok(has(kept.res.data, 'Jane Q. Public'));
  assert.ok(kept.res.kept.some((k) => /form/.test(k)));
  const cleared = await cleaned(u8, { clearForms: true });
  assert.ok(!has(cleared.res.data, 'Jane Q. Public'));
  assert.ok(has(cleared.res.data, '/NeedAppearances true'));
  assert.equal(cleared.after.blocks.filter((b) => b.kind === 'Form data').length, 0);
});

test('xref stream with predictor and object stream parse like the classic layout', async () => {
  const objects = basic({ extra: infoObj });
  const classic = await inspectFile(pdf(objects, { trailer: `/Root 1 0 R ${info}` }));
  const packed = pdf(objects, { trailer: `/Root 1 0 R ${info}`, xrefStream: true, packed: [1, 2, 3, 5, 6] });
  const r = await inspectFile(packed);
  assert.deepEqual(r.warnings, []);
  assert.equal(src(r, 'Container', 'Cross-reference'), 'Stream');
  assert.equal(src(r, 'Container', 'Object streams'), '1');
  for (const k of ['Title', 'Author', 'CreationDate']) assert.equal(src(r, 'PDF Info', k), src(classic, 'PDF Info', k));
  assert.equal(src(r, 'Container', 'Pages'), '1');
  assert.equal(r.blocks.filter((b) => b.kind === 'Unused objects').length, 0, 'xref and object streams are not leftovers');
  const { res } = await cleaned(packed);
  assert.ok(!has(res.data, 'Quarterly plan'));
});

test('hybrid file: objects the table lists as free are found through /XRefStm', async () => {
  const u8 = pdf(basic({ extra: infoObj }), { trailer: `/Root 1 0 R ${info}`, hybrid: true, packed: [2, 3, 6] });
  const r = await inspectFile(u8);
  assert.deepEqual(r.warnings, []);
  assert.equal(src(r, 'Container', 'Cross-reference'), 'Table with stream (hybrid)');
  assert.equal(src(r, 'Container', 'Pages'), '1');
  assert.equal(src(r, 'PDF Info', 'Title'), 'Quarterly plan');
  await cleaned(u8);
});

test('encrypted PDF with object streams: reported from the trailer, never treated as damaged', async () => {
  const enc = '<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 >> >> /StmF /StdCF /StrF /StdCF /P -4 /O <00> /U <00> >>';
  const u8 = pdf(basic({ extra: { 9: enc } }), { trailer: '/Root 1 0 R /Encrypt 9 0 R /ID [<0102> <0102>]', xrefStream: true, packed: [1, 2, 3, 5] });
  const r = await inspectFile(u8);
  assert.equal(src(r, 'PDF encryption', 'Method'), 'AES-256, password');
  assert.equal(src(r, 'Container', 'Pages'), 'Unknown (encrypted)');
  assert.ok(!r.warnings.some((w) => /damaged|scanning/.test(w)));
  assert.ok(!kinds(r).includes('Unused objects'));
  const res = await cleanFile(u8, 'x.pdf');
  assert.equal(res.ok, false); assert.match(res.reason, /encrypted/);
});

test('encrypted PDF: method and permissions reported, cleaning refused', async () => {
  const objects = basic({ extra: { 6: '<< /Author <8f3a11c2> >>', 9: '<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen >> >> /StmF /StdCF /StrF /StdCF /P -3132 /O <00> /U <00> >>' } });
  const u8 = pdf(objects, { trailer: `/Root 1 0 R ${info} /Encrypt 9 0 R /ID [<0102> <0102>]` });
  const r = await inspectFile(u8);
  assert.equal(src(r, 'PDF encryption', 'Method'), 'AES-128, password');
  assert.equal(src(r, 'PDF encryption', 'Allowed'), 'Print, Fill in forms, Extract for accessibility');
  assert.match(src(r, 'PDF encryption', 'Not allowed'), /Copy text and images/);
  assert.equal(src(r, 'PDF Info', 'Author'), '(encrypted)');
  const res = await cleanFile(u8, 'x.pdf');
  assert.equal(res.ok, false); assert.match(res.reason, /encrypted/);
});

test('signature: signer and certificate subject read; refused unless signatures may go', async () => {
  const der = signedData({ cn: 'Jane Signer', org: 'Example Corp', email: 'jane.signer mailbox' });
  const contents = `<${der.toString('hex')}${'0'.repeat(64)}>`;
  const objects = basic({ catalog: '/AcroForm << /Fields [7 0 R] /SigFlags 3 >>', page: '/Annots [7 0 R]', extra: {
    7: '<< /FT /Sig /T (Signature1) /V 8 0 R /Type /Annot /Subtype /Widget /Rect [0 0 0 0] >>',
    8: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Jane Signer) /Reason (I approve) /Location (Austin, TX) /M (D:20261001093000Z) /ByteRange [0 100 200 50] /Contents ${contents} >>`,
  } });
  const u8 = pdf(objects, { trailer: '/Root 1 0 R' });
  const r = await inspectFile(u8);
  assert.equal(src(r, 'PDF signatures', 'Signature1 signer name'), 'Jane Signer');
  assert.equal(src(r, 'PDF signatures', 'Signature1 certificate'), 'CN=Jane Signer, O=Example Corp, Email=jane.signer mailbox');
  assert.equal(src(r, 'PDF signatures', 'Signature1 issued by'), 'CN=Example CA');
  assert.equal(src(r, 'PDF signatures', 'Signature1 signing time (signed attribute)'), '2026-10-01 09:30:00 UTC');
  assert.match(src(r, 'PDF signatures', 'Signature1 covers'), /Changes were added after this signature/);
  assert.equal(hl(r, 'People', 'Signer email'), 'jane.signer mailbox');
  assert.ok(titles(r).includes('Digitally signed'));
  truthful(r);
  const refused = await cleanFile(u8, 'x.pdf');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'This PDF is digitally signed. Cleaning would invalidate the signature.');
  const { res } = await cleaned(u8, { removeSignatures: true });
  assert.ok(!has(res.data, 'Jane Signer') && !has(res.data, '/Sig'));
});

test('JPEG image with GPS inside the PDF: found, then stripped with the stream length updated', async () => {
  const photo = jpegWith(exifSegment(tiff([[0x010f, 2, 'Canon'], [0x0110, 2, 'Canon EOS R5']], { gps: [[0x0001, 2, 'N'], [0x0002, 5, dms(30.26715)], [0x0003, 2, 'W'], [0x0004, 5, dms(97.74306)]] })));
  const objects = basic({ resources: '/XObject << /Im1 7 0 R >>', content: 'q 160 0 0 120 72 600 cm /Im1 Do Q', extra: { 7: stream('<< /Type /XObject /Subtype /Image /Width 16 /Height 12 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', photo) } });
  const u8 = pdf(objects, { trailer: '/Root 1 0 R' });
  const r = await inspectFile(u8);
  assert.ok(titles(r).includes('Exact location stored'));
  assert.equal(hl(r, 'Camera', 'Model'), 'Canon EOS R5');
  assert.ok(kinds(r).includes('Image metadata'));
  const { res, after, doc } = await cleaned(u8);
  assert.ok(!has(res.data, 'Canon'));
  assert.equal(after.signals.length, 0);
  const img = [...doc.entries.keys()].map((n) => doc.get(n)).find((v) => v?.dict?.get('Subtype')?.name === 'Image');
  assert.equal(img.dict.get('Length'), img.raw.length);
  assert.ok(Buffer.from(img.raw).subarray(img.raw.length - 2).equals(Buffer.from([0xff, 0xd9])));
});

test('rotated JPEG inside the PDF: the orientation the image cleaner keeps does not block cleaning', async () => {
  const photo = jpegWith(exifSegment(tiff([[0x0112, 3, [6]], [0x010f, 2, 'Canon']])));
  const objects = basic({ resources: '/XObject << /Im1 7 0 R >>', content: 'q 16 0 0 12 72 600 cm /Im1 Do Q', extra: { 7: stream('<< /Subtype /Image /Width 16 /Height 12 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', photo) } });
  const { after } = await cleaned(pdf(objects, { trailer: '/Root 1 0 R' }));
  assert.equal(after.blocks.filter((b) => b.kind === 'Image metadata').length, 0);
});

test('thumbnails, application data, hidden layers and trailing data', async () => {
  const objects = basic({ catalog: '/OCProperties << /OCGs [8 0 R 9 0 R] /D << /OFF [9 0 R] >> >>', page: '/Thumb 7 0 R /PieceInfo << /Illustrator << /Private 10 0 R /LastModified (D:20240101) >> >> /LastModified (D:20240101)', extra: {
    7: stream('<< /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', '\0\0\0\0'),
    8: '<< /Type /OCG /Name (Visible art) >>', 9: '<< /Type /OCG /Name (Old pricing) >>', 10: stream('<< >>', 'AI private data'),
  } });
  const u8 = Buffer.concat([pdf(objects, { trailer: '/Root 1 0 R' }), Buffer.from('APPENDED SECRET')]);
  const r = await inspectFile(u8);
  assert.equal(src(r, 'PDF layers', 'Old pricing'), 'Hidden by default');
  assert.equal(src(r, 'PDF application data', 'Illustrator'), 'Private data on 1 object');
  assert.ok(titles(r).includes('Hidden layers') && titles(r).includes('Hidden data after the document'));
  for (const k of ['Thumbnail', 'Application data', 'Trailer']) assert.ok(kinds(r).includes(k), k);
  assert.equal(r.blocks.find((b) => b.kind === 'Hidden layer').removable, false);
  const { res } = await cleaned(u8);
  assert.ok(!has(res.data, 'APPENDED') && !has(res.data, 'AI private') && !has(res.data, '/Thumb'));
  assert.ok(has(res.data, 'Old pricing'));
});

test('redaction clue: text drawn and then covered by a black box', async () => {
  const content = 'BT /F1 12 Tf 72 700 Td (SSN 123-45-6789) Tj ET 0 g 70 695 120 16 re f BT /F1 12 Tf 72 650 Td (Visible line) Tj ET';
  const r = await inspectFile(pdf(basic({ content }), { trailer: '/Root 1 0 R' }));
  assert.ok(titles(r).includes('Content may be hidden under black boxes'));
  assert.match(src(r, 'PDF redaction clues', 'Page 1'), /SSN 123-45-6789/);
  assert.doesNotMatch(src(r, 'PDF redaction clues', 'Page 1'), /Visible line/);
  truthful(r);
  const plain = await inspectFile(pdf(basic({ content: '0 g 70 695 120 16 re f BT /F1 12 Tf 72 700 Td (On top) Tj ET' }), { trailer: '/Root 1 0 R' }));
  assert.ok(!titles(plain).includes('Content may be hidden under black boxes'), 'text drawn over a box is not hidden');
});

test('indirect /Annots array and struct-tree references to removed comments', async () => {
  const objects = basic({ catalog: '/StructTreeRoot 10 0 R /MarkInfo << /Marked true >>', page: '/Annots 9 0 R', extra: {
    9: '[7 0 R]', 7: '<< /Type /Annot /Subtype /FreeText /Rect [0 0 50 50] /T (Dave) /Contents (internal note) >>',
    10: '<< /Type /StructTreeRoot /K 11 0 R >>', 11: '<< /Type /StructElem /S /Annot /P 10 0 R /K [<< /Type /OBJR /Obj 7 0 R >>] >>',
  } });
  const { res } = await cleaned(pdf(objects, { trailer: '/Root 1 0 R' }));
  assert.ok(!has(res.data, 'Dave') && !has(res.data, 'internal note') && !has(res.data, '/OBJR'));
});

test('broken cross-reference: objects found by scanning and the cleaned file is sound', async () => {
  const good = pdf(basic({ extra: infoObj }), { trailer: `/Root 1 0 R ${info}` });
  const broken = Buffer.from(good.toString('latin1').replace(/startxref\n\d+/, 'startxref\n999999'), 'latin1');
  const r = await inspectFile(broken);
  assert.equal(src(r, 'Container', 'Cross-reference'), 'Rebuilt by scanning the file');
  assert.equal(src(r, 'PDF Info', 'Author'), 'Jane Doé');
  assert.ok(r.warnings.some((w) => /scanning/.test(w)));
  const shifted = Buffer.from(good.toString('latin1').replace(/(\d{10}) 00000 n/g, (m, o) => `${String(Number(o) + 3).padStart(10, '0')} 00000 n`), 'latin1');
  assert.equal(src(await inspectFile(shifted), 'PDF Info', 'Title'), 'Quarterly plan');
  const { res } = await cleaned(broken);
  assert.ok(!has(res.data, 'Quarterly'));
});

test('idempotent: cleaning a cleaned PDF removes nothing more', async () => {
  const u8 = pdf(basic({ extra: infoObj }), { trailer: `/Root 1 0 R ${info} /ID [<AABB> <CCDD>]` });
  const first = await cleaned(u8);
  assert.ok(first.res.removed.some((b) => b.kind === 'Document ID'));
  assert.equal(first.after.cleanable.blocks, 0);
  const second = await cleanFile(first.res.data, 'test.pdf');
  assert.ok(second.ok);
  assert.deepEqual(second.removed, []);
  assert.ok(Buffer.from(second.data).equals(Buffer.from(first.res.data)));
  assert.notEqual(src(first.after, 'PDF document', 'Document ID'), 'AABB');
});

test('real-number and name output stays valid PDF syntax', async () => {
  const objects = basic({ page: '/UserUnit 0.0000001 /Rotate -0 /Matrix [1.5 -2.25 1e3]', extra: { ...infoObj, 7: '<< /Odd#20Name (a\\(b\\)c\\\\) >>' }, catalog: '/Extra 7 0 R' });
  const { res, doc } = await cleaned(pdf(objects, { trailer: `/Root 1 0 R ${info}` }));
  assert.ok(!/\de-?\d|-0\b/.test(Buffer.from(res.data).toString('latin1').split('\nxref\n')[0].replace(/stream[\s\S]*?endstream/g, '')));
  assert.ok(has(res.data, '/Odd#20Name'));
  const odd = doc.dict(doc.catalog().get('Extra'));
  assert.equal(Buffer.from(odd.get('Odd Name').bytes).toString('latin1'), 'a(b)c\\');
});

// ---------- Hostile input ----------

test('hostile: /Prev cycles and self-referencing lengths end quickly', async () => {
  const good = pdf(basic(), { trailer: '/Root 1 0 R' });
  const xref = Number(/startxref\n(\d+)/.exec(good.toString('latin1'))[1]);
  const loop = Buffer.from(good.toString('latin1').replace('/Root 1 0 R', `/Root 1 0 R /Prev ${xref}`), 'latin1');
  const r = await inspectFile(loop);
  assert.equal(r.format, 'PDF');
  assert.ok(r.warnings.some((w) => /loops/.test(w)));
  const selfLen = pdf({ ...basic(), 4: '<< /Length 4 0 R >>\nstream\nBT ET\nendstream' }, { trailer: '/Root 1 0 R' });
  assert.equal((await inspectFile(selfLen)).format, 'PDF');
});

test('hostile: deep nesting, huge stream lengths and an object stream that contains itself', async () => {
  const deep = pdf(basic({ extra: { 6: `${'['.repeat(5000)}${']'.repeat(5000)}` } }), { trailer: '/Root 1 0 R /Info 6 0 R' });
  const r = await inspectFile(deep);
  assert.equal(r.format, 'PDF');
  const huge = pdf({ ...basic(), 4: '<< /Length 99999999999 >>\nstream\nBT ET\nendstream' }, { trailer: '/Root 1 0 R' });
  const h = await inspectFile(huge);
  assert.equal(src(h, 'Container', 'Stream lengths corrected'), '1');
  await cleaned(huge);
  const self = pdf(basic({ extra: infoObj }), { trailer: `/Root 1 0 R ${info}`, xrefStream: true, packed: [6] });
  const tampered = Buffer.from(self.toString('latin1').replace('/Type /ObjStm', '/Type /ObjStm /Extends 7 0 R'), 'latin1');
  assert.equal((await inspectFile(tampered)).format, 'PDF');
});

test('hostile: a decompression bomb in a metadata stream is capped', async () => {
  const bomb = deflateSync(Buffer.alloc(20 * 1048576));
  const objects = basic({ catalog: '/Metadata 7 0 R', extra: { 7: stream('<< /Type /Metadata /Subtype /XML /Filter /FlateDecode >>', bomb) } });
  const fixed = pdf(objects, { trailer: '/Root 1 0 R' });
  const t = Date.now();
  const r = await inspectFile(fixed);
  assert.ok(Date.now() - t < 5000);
  assert.ok(r.warnings.some((w) => /exceeds 8 MB/.test(w)));
  assert.ok(kinds(r).includes('XMP'));
  await cleaned(fixed);
});

test('hostile: garbage after the header and truncated files do not throw', async () => {
  for (const u8 of [Buffer.from('%PDF-1.7\n'), Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog'), pdf(basic(), { trailer: '/Root 1 0 R' }).subarray(0, 200), Buffer.concat([Buffer.from('%PDF-1.5\n'), Buffer.from(base.jpeg)])]) {
    const r = await inspectFile(u8);
    assert.equal(r.format, 'PDF');
    const res = await cleanFile(u8, 'x.pdf');
    if (res.ok && res.data !== u8) assert.equal((await inspectFile(res.data)).warnings.length, 0);
  }
});
