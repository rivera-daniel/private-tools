// PDF documents for the redaction tests, built in memory.
import { pdf, stream, update, utf16 } from './pdf.js';

const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
const line = (y, text, size = 12) => `BT /F1 ${size} Tf 72 ${y} Td (${text}) Tj ET`;

// A two-page document with personal data on page 1 and a page of ordinary text.
export function personal({ catalog = '', page1 = '', resources = '', extra = {}, trailer = '', lines = null } = {}) {
  const text = lines ?? [
    line(720, 'Name: John Secretman'),
    line(700, 'SSN 123-45-6789 on file'),
    line(680, 'Email jane.doe@example.org today'),
    line(660, 'Card 4111 1111 1111 1111 and 4111 1111 1111 1112'),
    line(640, 'Public line stays'),
    line(620, 'Born 1984-03-07 in Austin, call +1 512-555-0143'),
    line(600, 'IBAN GB82 WEST 1234 5698 7654 32 for payroll'),
  ].join('\n');
  return pdf({
    1: `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    2: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> ${resources} >> /Contents 4 0 R ${page1} >>`,
    4: stream('<< >>', text),
    5: FONT,
    6: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    7: stream('<< >>', line(720, 'Second page with ordinary text')),
    ...extra,
  }, { trailer: `/Root 1 0 R ${trailer}` });
}

// The same name in an outline title, a form field (one under the mark, one elsewhere), structure tree
// alternate and actual text, an inline marked-content property list, page labels, document info and XMP.
export function leaky() {
  const content = [
    line(720, 'Name: John Secretman'),
    '/Span <</ActualText (John Secretman) /Alt (Photo of John Secretman)>> BDC',
    line(560, 'JS'),
    'EMC',
    line(640, 'Public line stays'),
  ].join('\n');
  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>John Secretman</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  return personal({
    lines: content,
    catalog: '/Outlines 8 0 R /AcroForm << /Fields [10 0 R 11 0 R] /DA (/Helv 10 Tf 0 g) >> /StructTreeRoot 12 0 R /MarkInfo << /Marked true >> /PageLabels << /Nums [0 << /S /D /P (John Secretman-) >>] >> /Metadata 14 0 R',
    page1: '/Annots [10 0 R 11 0 R] /StructParents 0',
    extra: {
      8: '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>',
      9: '<< /Title (Notes about John Secretman) /Parent 8 0 R /Dest [3 0 R /Fit] >>',
      // Under the mark at the name.
      10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (overlay) /V (John Secretman) /Rect [300 715 500 731] /P 3 0 R /DA (/Helv 10 Tf 0 g) >>',
      // Elsewhere on the page.
      11: `<< /Type /Annot /Subtype /Widget /FT /Tx /T (contact) /TU (Contact for John Secretman) /V ${utf16('John Secretman ✓')} /Rect [72 400 300 420] /P 3 0 R /DA (/Helv 10 Tf 0 g) >>`,
      12: '<< /Type /StructTreeRoot /K 13 0 R >>',
      13: '<< /Type /StructElem /S /Figure /P 12 0 R /Alt (Portrait of John Secretman) /ActualText (John Secretman) /Pg 3 0 R >>',
      14: stream('<< /Type /Metadata /Subtype /XML >>', xmp),
    },
    trailer: '/Info << /Title (File on John Secretman) /Author (Records) >>',
  });
}

// Revision 1 shows a secret account number; revision 2 (an incremental update) still shows it on page 1.
export function revised() {
  const base = personal({ lines: [line(720, 'Account ACCT-99-SECRET'), line(700, 'Draft note: rename later')].join('\n') });
  return update(base, { 4: stream('<< >>', [line(720, 'Account ACCT-99-SECRET'), line(700, 'Final wording here')].join('\n')) }, '/Root 1 0 R');
}

// An 8 by 8 gray image drawn at 300,500 (PDF space), 100 points square, under a mark in part.
export function withImage() {
  const px = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) px[i] = (i * 37) % 200;
  return personal({
    lines: ['q 100 0 0 100 300 500 cm /Im1 Do Q', line(720, 'Photo below')].join('\n'),
    resources: '/XObject << /Im1 8 0 R >>',
    extra: { 8: stream('<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', px) },
  });
}

// The secret is drawn inside a form XObject.
export function withForm() {
  return personal({
    lines: ['q /Fx1 Do Q', line(640, 'Public line stays')].join('\n'),
    resources: '/XObject << /Fx1 8 0 R >>',
    extra: { 8: stream('<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>', line(720, 'Inside form PASSPORT-X7781')) },
  });
}

// Text painted and then covered with a black rectangle: a redaction that hides nothing.
export function fakeRedaction() {
  return personal({
    lines: [line(720, 'Witness: Maria Hiddenname'), '0 g 128 714 120 20 re f', line(640, 'Public line stays')].join('\n'),
  });
}

// Pages that are rotated, or whose crop box does not start at the origin.
export function rotated(page) {
  return personal({ page1: page, lines: [line(600, 'Rotated secret ROT-4421 here', 16), line(500, 'Public line stays')].join('\n') });
}

// Text on a hidden layer under the mark.
export function hiddenLayer() {
  return personal({
    lines: ['/OC /L1 BDC', line(720, 'LayerSecret-5531'), 'EMC', line(700, 'Visible text here')].join('\n'),
    resources: '/Properties << /L1 8 0 R >>',
    catalog: '/OCProperties << /OCGs [8 0 R] /D << /OFF [8 0 R] >> >>',
    extra: { 8: '<< /Type /OCG /Name (Notes) >>' },
  });
}

// A signed form: a signature field with a value.
export function signed() {
  return personal({
    catalog: '/AcroForm << /Fields [8 0 R] /SigFlags 3 >>',
    page1: '/Annots [8 0 R]',
    extra: {
      8: '<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /V 9 0 R /Rect [0 0 0 0] /P 3 0 R >>',
      9: '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 0 0 0] /Contents <00> >>',
    },
  });
}
