// PDF Editor fixtures, generated in code with MuPDF: text PDFs, an image whose top-left corner is red so
// orientation mistakes show, a JPEG that asks to be rotated, a bloated PDF and a signed one.
import * as mupdf from '../../site/tools/vendor/mupdf/mupdf.js';
import { tiff, exifSegment } from './build.js';

const bytesOf = (buffer) => { try { return buffer.asUint8Array().slice(); } finally { buffer.destroy(); } };

// n pages, each showing "<tag> <number>". size in points, rotate the pages' own /Rotate.
export function textPdf(n, tag = 'Page', { size = [612, 792], rotate = 0, info = null } = {}) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const res = doc.addObject({ Font: { F1: font } });
  for (let i = 0; i < n; i++) doc.insertPage(-1, doc.addPage([0, 0, size[0], size[1]], rotate, res, `BT /F1 24 Tf 72 ${size[1] - 100} Td (${tag} ${i + 1}) Tj ET`));
  if (info) for (const [k, v] of Object.entries(info)) doc.setMetaData(`info:${k}`, v);
  try { return bytesOf(doc.saveToBuffer('compress')); } finally { doc.destroy(); }
}

// w x h RGB pixels, white with a red block in the top-left quarter.
export function cornerPixmap(w = 40, h = 30) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels(); const stride = pix.getStride();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const red = x < w / 2 && y < h / 2; const o = y * stride + x * 3;
    px[o] = red ? 220 : 255; px[o + 1] = red ? 20 : 255; px[o + 2] = red ? 30 : 255;
  }
  return pix;
}
export const cornerPng = (w, h) => { const p = cornerPixmap(w, h); try { return p.asPNG(); } finally { p.destroy(); } };
export const cornerJpeg = (w, h) => { const p = cornerPixmap(w, h); try { return p.asJPEG(95); } finally { p.destroy(); } };

// A JPEG with an EXIF block holding an orientation and a GPS position, inserted after SOI.
export function orientedJpeg(orientation, w = 40, h = 30) {
  const jpeg = Buffer.from(cornerJpeg(w, h));
  const exif = exifSegment(tiff([[0x010f, 2, 'Canon'], [0x0112, 3, [orientation]]], { gps: [[0x0001, 2, 'N'], [0x0002, 5, [[30, 1], [16, 1], [0, 1]]]] }));
  return new Uint8Array(Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]));
}

// Uncompressed, with the same large stream stored many times and objects nothing uses.
export function bloatedPdf() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const filler = Array.from({ length: 400 }, (_, i) => `BT /F1 10 Tf 40 ${780 - (i % 70) * 11} Td (Line ${i % 70} of repeated filler text) Tj ET`).join('\n');
  for (let i = 0; i < 4; i++) {
    const res = doc.addObject({ Font: { F1: font } });
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, filler));
  }
  for (let i = 0; i < 20; i++) doc.addStream(filler, {});
  try { return bytesOf(doc.saveToBuffer('')); } finally { doc.destroy(); }
}

// One page filled by a large, smooth (photo-like) image stored losslessly.
export function photoPdf(w = 1600, h = 1200) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels(); const stride = pix.getStride();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * stride + x * 3;
    const top = y < h / 2;
    px[o] = top ? 200 : (x * 255) / w; px[o + 1] = top ? 30 : (y * 255) / h; px[o + 2] = top ? 40 : 128 + 60 * Math.sin(x / 40);
  }
  const doc = new mupdf.PDFDocument();
  const image = new mupdf.Image(pix);
  const ref = doc.addImage(image);
  doc.insertPage(-1, doc.addPage([0, 0, 400, 300], 0, { XObject: { Im0: ref } }, 'q 400 0 0 300 0 0 cm /Im0 Do Q'));
  try { return bytesOf(doc.saveToBuffer('compress')); } finally { doc.destroy(); image.destroy(); pix.destroy(); }
}

// A PDF whose signature field holds a (fake) signature value.
export function signedPdf() {
  const doc = mupdf.Document.openDocument(textPdf(2, 'Signed'), 'application/pdf').asPDF();
  const sig = doc.addObject({ Type: doc.newName('Sig'), Filter: doc.newName('Adobe.PPKLite'), SubFilter: doc.newName('adbe.pkcs7.detached'), ByteRange: [0, 10, 20, 30], Contents: doc.newByteString(new Uint8Array(64)) });
  const field = doc.addObject({ FT: doc.newName('Sig'), T: doc.newString('Signature1'), V: sig, Type: doc.newName('Annot'), Subtype: doc.newName('Widget'), Rect: [0, 0, 0, 0], F: 132 });
  const page = doc.findPage(0);
  field.put('P', page);
  page.put('Annots', [field]);
  doc.getTrailer().get('Root').put('AcroForm', { Fields: [field], SigFlags: 3 });
  try { return bytesOf(doc.saveToBuffer('')); } finally { doc.destroy(); }
}
