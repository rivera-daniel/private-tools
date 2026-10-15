// PDF Editor operations on MuPDF (WebAssembly). Bytes and plain options in, documents or bytes out, so the
// worker and the tests call the same functions. Nothing here touches the network or the page.
// A source is { doc, bytes, password }: the opened document used for reading and rendering, the bytes it
// came from and the password that opened it. Building never changes a source.
import * as mupdf from '../../vendor/mupdf/mupdf.js';
import { cleanImage } from '../clean/index.js';

export { mupdf };
export const LIMITS = { totalBytes: 500 * 1024 * 1024, maxPages: 10000 };
export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
// Lossless rewrite: drop unused and duplicate objects, compress streams, pack objects into object streams.
export const LOSSLESS = 'garbage=deduplicate,compress,objstms,clean';

export class PdfError extends Error {}

// MuPDF reports repairs and oddities through its log. They are kept for the caller instead of printed.
let log = [];
mupdf.setLog({ error: (m) => { log.push(m); if (log.length > 50) log.shift(); }, warning: (m) => { log.push(m); if (log.length > 50) log.shift(); } });
export const takeLog = () => { const out = log; log = []; return out; };

const bytesOf = (buffer) => { try { return buffer.asUint8Array().slice(); } finally { buffer.destroy(); } };
const u8 = (input) => (input instanceof Uint8Array ? input : new Uint8Array(input));

function openRaw(bytes) {
  let doc;
  try { doc = mupdf.Document.openDocument(u8(bytes), 'application/pdf'); }
  catch { throw new PdfError('This file could not be read as a PDF. It may be damaged or not a PDF at all.'); }
  const pdf = doc.asPDF();
  if (!pdf) { doc.destroy(); throw new PdfError('This file is not a PDF.'); }
  return pdf;
}

const ALL_EDITS = ['edit', 'assemble', 'annotate', 'form'];

// Opens a PDF. Returns { needsPassword, wrongPassword, ownerPassword } without a document when a password
// is needed: ownerPassword means the file opens but its author restricted changes, which only the owner
// password lifts. Otherwise { source, pageCount, sizes, encrypted, signed, repaired }.
export function openPdf(bytes, password = null) {
  const data = u8(bytes);
  takeLog();
  const doc = openRaw(data);
  let auth = 1;
  if (doc.needsPassword()) {
    if (!password) { doc.destroy(); return { needsPassword: true }; }
    auth = doc.authenticatePassword(password);
    if (!auth) { doc.destroy(); return { needsPassword: true, wrongPassword: true }; }
  }
  const encryption = doc.getMetaData('encryption') ?? 'None';
  const encrypted = encryption !== 'None';
  if (encrypted && !(auth & 4) && !ALL_EDITS.every((p) => doc.hasPermission(p))) {
    const owner = password ? doc.authenticatePassword(password) : 0;
    if (!(owner & 4)) { doc.destroy(); return { needsPassword: true, ownerPassword: true, wrongPassword: Boolean(password) }; }
  }
  let pageCount;
  try { pageCount = doc.countPages(); } catch { doc.destroy(); throw new PdfError('This PDF is too damaged to read.'); }
  if (!pageCount) { doc.destroy(); throw new PdfError('This PDF has no pages.'); }
  if (pageCount > LIMITS.maxPages) { doc.destroy(); throw new PdfError(`This PDF has more than ${LIMITS.maxPages.toLocaleString('en-US')} pages.`); }
  const sizes = pageSizes(doc);
  return { source: { doc, bytes: data, password }, pageCount, sizes, encrypted, encryption, signed: isSigned(doc), repaired: doc.wasRepaired(), notes: takeLog() };
}

// Displayed size of every page in PDF points, after the page's own rotation.
export function pageSizes(doc) {
  const sizes = [];
  for (let i = 0, n = doc.countPages(); i < n; i++) {
    const page = doc.loadPage(i);
    try { const [x0, y0, x1, y1] = page.getBounds(); sizes.push([round(x1 - x0), round(y1 - y0)]); }
    finally { page.destroy(); }
  }
  return sizes;
}
const round = (n) => Math.round(n * 100) / 100;

// True when a signature field holds a signature.
export function isSigned(doc) {
  const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields');
  if (!fields.isArray()) return false;
  let seen = 0;
  const walk = (list, depth, inherited) => {
    for (let i = 0; i < list.length && seen < 5000; i++) {
      const f = list.get(i); seen++;
      if (!f.isDictionary()) continue;
      const ft = f.get('FT').isName() ? f.get('FT').asName() : inherited;
      if (ft === 'Sig' && f.get('V').isDictionary()) return true;
      if (depth < 20 && f.get('Kids').isArray() && walk(f.get('Kids'), depth + 1, ft)) return true;
    }
    return false;
  };
  return walk(fields, 0, null);
}

function reopen(source) {
  const doc = openRaw(source.bytes);
  if (doc.needsPassword()) doc.authenticatePassword(source.password ?? '');
  return doc;
}

const lookup = (sources, id) => {
  const s = sources instanceof Map ? sources.get(id) : sources[id];
  if (!s) throw new PdfError('A page refers to a file that is no longer open.');
  return s;
};

// Builds a new document from a plan (see plan.js). The first source in the plan is reopened from its bytes
// so its outline, links, form and structure survive; its pages are rearranged in place. Pages from other
// sources and repeated pages are copied in, which keeps their content but not their links, comments or
// form fields.
export function buildDocument(sources, plan) {
  if (!plan.length) throw new PdfError('There are no pages left.');
  const first = plan.find((e) => !e.blank);
  let out;
  if (first) {
    out = reopen(lookup(sources, first.src));
    const seen = new Set(); const keep = [];
    for (const e of plan) if (!e.blank && e.src === first.src && !seen.has(e.page)) { seen.add(e.page); keep.push(e.page); }
    out.rearrangePages(keep);
  } else out = new mupdf.PDFDocument();
  const maps = new Map(); const placed = new Set();
  plan.forEach((e, at) => {
    if (e.blank) { out.insertPage(at, out.addPage([0, 0, e.blank[0], e.blank[1]], 0, {}, '')); return; }
    if (first && e.src === first.src && !placed.has(e.page)) { placed.add(e.page); return; }
    let map = maps.get(e.src);
    if (!map) { map = out.newGraftMap(); maps.set(e.src, map); }
    map.graftPage(at, lookup(sources, e.src).doc, e.page);
  });
  for (const map of maps.values()) map.destroy();
  plan.forEach((e, at) => {
    if (!e.rotate) return;
    const page = out.findPage(at); const own = page.getInheritable('Rotate');
    page.put('Rotate', ((((own.isNumber() ? own.asNumber() : 0) + e.rotate) % 360) + 360) % 360);
  });
  return out;
}

// Encryption is never kept by accident: every save states it, and 'none' removes it.
export function writeOptions({ compress = true, encrypt = null } = {}) {
  return [compress ? LOSSLESS : 'garbage=compact', encrypt ?? 'encrypt=none'].join(',');
}

export function saveDocument(doc, options = {}) { return bytesOf(doc.saveToBuffer(writeOptions(options))); }

export const buildBytes = (sources, plan, options = {}) => {
  const doc = buildDocument(sources, plan);
  try { return saveDocument(doc, options); } finally { doc.destroy(); }
};

// Splits the plan into groups of plan indexes and builds one PDF per group.
export function splitDocument(sources, plan, groups, options = {}) {
  return groups.map((group) => buildBytes(sources, group.map((i) => plan[i]), options));
}

/* Passwords */

// Standard security handler permission bits (PDF 2.0, table 22). Bits 7, 8 and 13-32 must be set.
const P_BASE = 0xfffff0c0 | 0;
const P = { print: 4 | 2048, edit: 8 | 32 | 256 | 1024, copy: 16, accessibility: 512 };

export function permissionValue({ print = true, copy = true, edit = true } = {}) {
  return P_BASE | P.accessibility | (print ? P.print : 0) | (copy ? P.copy : 0) | (edit ? P.edit : 0);
}

// MuPDF reads write options as a comma-separated list, so a password cannot contain a comma.
export function checkPassword(password, label = 'Password') {
  if (!password) throw new PdfError(`${label} is empty.`);
  if (password.includes(',')) throw new PdfError(`${label} cannot contain a comma.`);
  if (/[\0-\x1f]/.test(password)) throw new PdfError(`${label} cannot contain control characters.`);
  if (new TextEncoder().encode(password).length > 127) throw new PdfError(`${label} is longer than 127 bytes.`);
}

// A random owner password, for files whose restrictions nobody should be able to lift.
export function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// AES-256 (revision 6). With no owner password and every permission allowed, the owner password is the
// user password. With restrictions and no owner password, a random one is used so they cannot be lifted.
export function encryptOption({ userPassword, ownerPassword = '', allow = {} }) {
  checkPassword(userPassword, 'The password');
  const all = allow.print !== false && allow.copy !== false && allow.edit !== false;
  const owner = ownerPassword || (all ? userPassword : randomPassword());
  checkPassword(owner, 'The owner password');
  return `encrypt=aes-256,user-password=${userPassword},owner-password=${owner},permissions=${permissionValue(allow)}`;
}

export function protectPdf(bytes, protection, { compress = true } = {}) {
  const doc = openRaw(bytes);
  try {
    if (doc.needsPassword()) throw new PdfError('Remove the existing password before adding a new one.');
    return saveDocument(doc, { compress, encrypt: encryptOption(protection) });
  } finally { doc.destroy(); }
}

// Removes the password from a PDF whose password the user knows. Restricted files need the owner password.
export function unlockPdf(bytes, password, { compress = true } = {}) {
  const opened = openPdf(bytes, password);
  if (opened.needsPassword) throw new PdfError(opened.ownerPassword ? 'This PDF restricts changes. Enter its owner password to remove it.' : 'That password is not correct.');
  try { return saveDocument(opened.source.doc, { compress }); } finally { opened.source.doc.destroy(); }
}

/* Rendering */

// RGBA pixels of a page at scale (1 = 72 dpi), turned by `rotate` degrees on top of its own rotation.
export function renderPage(doc, index, scale = 1, rotate = 0) {
  const page = doc.loadPage(index);
  try {
    const pix = page.toPixmap(mupdf.Matrix.concat(mupdf.Matrix.scale(scale, scale), mupdf.Matrix.rotate(rotate)), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const width = pix.getWidth(); const height = pix.getHeight(); const stride = pix.getStride(); const src = pix.getPixels();
      const out = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        let s = y * stride; let d = y * width * 4;
        for (let x = 0; x < width; x++, s += 3, d += 4) { out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255; }
      }
      return { width, height, pixels: out };
    } finally { pix.destroy(); }
  } finally { page.destroy(); }
}

// One page as PNG or JPEG bytes.
export function pageImage(doc, index, { format = 'png', scale = 2, quality = 85, rotate = 0 } = {}) {
  const page = doc.loadPage(index);
  try {
    const pix = page.toPixmap(mupdf.Matrix.concat(mupdf.Matrix.scale(scale, scale), mupdf.Matrix.rotate(rotate)), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      pix.setResolution(Math.round(72 * scale), Math.round(72 * scale));
      return format === 'jpeg' ? pix.asJPEG(quality) : pix.asPNG();
    } finally { pix.destroy(); }
  } finally { page.destroy(); }
}

/* Images to PDF */

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
export const imageKind = (b) => (isJpeg(b) ? 'jpeg' : isPng(b) ? 'png' : b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 ? 'webp' : null);

// Placement of the image unit square in a w x h box at (x, y), undoing EXIF orientation 1-8.
function orientedMatrix(o, w, h, x, y) {
  switch (o) {
    case 2: return [-w, 0, 0, h, x + w, y];
    case 3: return [-w, 0, 0, -h, x + w, y + h];
    case 4: return [w, 0, 0, -h, x, y + h];
    case 5: return [0, -h, -w, 0, x + w, y + h];
    case 6: return [0, -h, w, 0, x, y + h];
    case 7: return [0, h, w, 0, x, y];
    case 8: return [0, h, -w, 0, x + w, y];
    default: return [w, 0, 0, h, x, y];
  }
}

// images: [{ bytes, name }] holding JPEG or PNG (the worker turns WebP into PNG first). JPEG is embedded as
// is after its metadata is removed losslessly, keeping only its orientation, which is applied here.
// pageSize: 'fit' (the page is the image at its resolution), 'a4' or 'letter' (turned to match the image).
// margin in points.
export async function imagesToPdf(images, { pageSize = 'fit', margin = 0 } = {}) {
  if (!images.length) throw new PdfError('Choose at least one image.');
  const doc = new mupdf.PDFDocument();
  const skipped = [];
  for (const { bytes, name } of images) {
    let data = u8(bytes); let orientation = 1;
    const kind = imageKind(data);
    if (kind !== 'jpeg' && kind !== 'png') { skipped.push({ name, reason: 'Not a JPEG, PNG or WebP image.' }); continue; }
    if (kind === 'jpeg') {
      const cleaned = await cleanImage(data);
      if (cleaned.ok) { data = cleaned.data; orientation = cleaned.orientation ?? 1; }
    }
    let image;
    try { image = new mupdf.Image(data); } catch { skipped.push({ name, reason: 'The image could not be decoded.' }); continue; }
    const pw = image.getWidth(); const ph = image.getHeight();
    const turned = orientation >= 5;
    const iw = turned ? ph : pw; const ih = turned ? pw : ph;
    const res = image.getXResolution();
    const dpi = res >= 72 && res <= 1200 ? res : 72;
    let w; let h; let box;
    if (pageSize === 'fit') {
      let pts = 72 / dpi; const largest = Math.max(iw, ih) * pts;
      if (largest > 14400) pts *= 14400 / largest; // PDF pages stop at 200 inches.
      w = iw * pts + margin * 2; h = ih * pts + margin * 2;
      box = [margin, margin, iw * pts, ih * pts];
    } else {
      const [a, b] = PAGE_SIZES[pageSize] ?? PAGE_SIZES.a4;
      [w, h] = iw > ih ? [b, a] : [a, b];
      const room = [Math.max(1, w - margin * 2), Math.max(1, h - margin * 2)];
      const s = Math.min(room[0] / iw, room[1] / ih);
      box = [(w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s];
    }
    const ref = doc.addImage(image);
    const m = orientedMatrix(orientation, box[2], box[3], box[0], box[1]).map((n) => Number(n.toFixed(4)));
    const page = doc.addPage([0, 0, Number(w.toFixed(2)), Number(h.toFixed(2))], 0, { XObject: { Im0: ref } }, `q ${m.join(' ')} cm /Im0 Do Q`);
    doc.insertPage(-1, page);
    image.destroy();
  }
  if (!doc.countPages()) { doc.destroy(); throw new PdfError(skipped[0]?.reason ?? 'No image could be added.'); }
  return { doc, skipped };
}
