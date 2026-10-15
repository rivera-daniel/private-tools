// PDF digital signatures: signing as an incremental update and checking the signatures in a file.
// Signing appends a revision and never changes earlier bytes, so signatures already in the file stay valid.
// The signature is CMS SignedData with /SubFilter /ETSI.CAdES.detached (PAdES baseline B without a
// timestamp). Checking is offline: no revocation lists, OCSP or timestamps, and trust comes only from root
// certificates the user imports.
import { PdfDocument } from '../metadata/pdf/document.js';
import { Dict, Name, Str, Ref, Stream, Parser, PdfError, isName, isInt, nameOf, text, lastIndexOfBytes } from '../metadata/pdf/syntax.js';
import { serialize } from '../clean/pdf/writer.js';
import { buildSignedData, parseSignedData, verifySignedData, buildChain, readCertificates, parseCertificate, fingerprint, digest, hashFor } from './cms.js';
import { fromHex, toHex, compareBytes } from './asn1.js';

export class SignError extends Error {}
export { readCertificates, parseCertificate };

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const latin = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode(...u8.subarray(i, i + 4096)); return s; };
function concat(parts) { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

// A PDF text string: PDFDocEncoding when plain ASCII, otherwise UTF-16BE with a byte order mark.
function textString(s) {
  s = String(s);
  if (/^[\x20-\x7e]*$/.test(s)) return new Str(ascii(s));
  const out = [0xfe, 0xff];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out.push(c >> 8, c & 0xff); }
  return new Str(Uint8Array.from(out));
}

const two = (n) => String(n).padStart(2, '0');
function pdfDateString(d) {
  return `D:${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
}

function parsePdfDate(s) {
  const m = /^\s*(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:([Zz])|([+-])(\d{2})'?(\d{2})?'?)?/.exec(s ?? '');
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', , sign, zh = '00', zm = '00'] = m;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
  if (sign) t -= (sign === '+' ? 1 : -1) * (Number(zh) * 60 + Number(zm)) * 60000;
  return Number.isFinite(t) ? new Date(t) : null;
}

/* Visible appearance */

// Helvetica advance widths for ASCII 32–126 in 1/1000 em.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const WIN = { 0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f };
// The standard Helvetica font only covers WinAnsi (Western European) characters; others become '?'.
function winAnsi(s) {
  return Uint8Array.from([...s.normalize('NFC')], (ch) => { const c = ch.codePointAt(0); return (c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff) ? c : WIN[c] ?? 0x3f; });
}
const widthOf = (bytes) => bytes.reduce((w, b) => w + (b >= 32 && b <= 126 ? HELV[b - 32] : 556), 0) / 1000;
const pdfLiteral = (bytes) => serialize(new Str(bytes));
const num = (n) => serialize(Math.round(n * 1000) / 1000);

async function deflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Content stream of the appearance: an optional image on the left and lines of text, inside w × h points.
function appearanceContent(w, h, lines, image) {
  const pad = Math.min(4, w / 10, h / 10);
  let out = '';
  let textX = pad; let textW = w - 2 * pad;
  if (image) {
    const boxW = lines.length ? (w - 2 * pad) * 0.4 : w - 2 * pad; const boxH = h - 2 * pad;
    const s = Math.min(boxW / image.width, boxH / image.height);
    const iw = image.width * s; const ih = image.height * s;
    const ix = pad + (boxW - iw) / 2; const iy = pad + (boxH - ih) / 2;
    out += `q ${num(iw)} 0 0 ${num(ih)} ${num(ix)} ${num(iy)} cm /Img Do Q\n`;
    textX = pad * 2 + boxW; textW = w - textX - pad;
  }
  if (lines.length && textW > 0) {
    const encoded = lines.map(winAnsi);
    const widest = Math.max(...encoded.map(widthOf), 0.01);
    const size = Math.max(1, Math.min((h - 2 * pad) / (lines.length * 1.2), textW / widest, 14));
    const lead = size * 1.2;
    const top = h / 2 + (lines.length * lead) / 2 - size;
    out += `q 0 g BT /Helv ${num(size)} Tf ${num(lead)} TL ${num(textX)} ${num(top)} Td\n`;
    encoded.forEach((b, i) => { out += `${i ? 'T* ' : ''}${pdfLiteral(b)} Tj\n`; });
    out += 'ET Q\n';
  }
  return ascii(out);
}

/* Reading the file to sign */

function inherited(doc, pageDict, key) {
  let d = pageDict;
  for (let i = 0; d && i < 64; i++) { if (d.has(key)) return doc.resolve(d.get(key)); d = doc.dict(d.get('Parent')); }
  return undefined;
}

function pageBox(doc, page) {
  const box = (v) => (Array.isArray(v) && v.length === 4 && v.every((x) => typeof doc.resolve(x) === 'number') ? v.map((x) => doc.resolve(x)) : null);
  const b = box(inherited(doc, page, 'CropBox')) ?? box(inherited(doc, page, 'MediaBox')) ?? [0, 0, 612, 792];
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

const rotationOf = (doc, page) => { const r = inherited(doc, page, 'Rotate'); return isInt(r) ? (((r % 360) + 360) % 360) : 0; };

// The page size as a viewer shows it, after /Rotate.
export async function displayedPageSizes(pdfBytes) {
  const doc = await PdfDocument.open(pdfBytes);
  return doc.pages().map((p) => { const [x0, y0, x1, y1] = pageBox(doc, p.dict); const r = rotationOf(doc, p.dict); return r % 180 ? { width: y1 - y0, height: x1 - x0 } : { width: x1 - x0, height: y1 - y0 }; });
}

// Maps a box given in displayed page coordinates (points, origin at the top left) to user space.
function toUserSpace(rect, box, rotate) {
  const [llx, lly, urx, ury] = box;
  const map = (dx, dy) => (rotate === 90 ? [llx + dy, lly + dx] : rotate === 180 ? [urx - dx, lly + dy] : rotate === 270 ? [urx - dy, ury - dx] : [llx + dx, ury - dy]);
  const a = map(rect.x, rect.y); const b = map(rect.x + rect.width, rect.y + rect.height);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
const ROTATE_MATRIX = { 0: null, 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] };

function fieldsOf(doc) {
  const out = []; const seen = new Set();
  const acro = doc.dict(doc.catalog()?.get('AcroForm'));
  const walk = (list, inheritedType, depth) => {
    list = doc.resolve(list);
    if (!Array.isArray(list) || depth > 32) return;
    for (const ref of list) {
      if (ref instanceof Ref) { if (seen.has(ref.num)) continue; seen.add(ref.num); }
      const f = doc.dict(ref); if (!f) continue;
      const type = nameOf(doc.resolve(f.get('FT'))) ?? inheritedType;
      out.push({ ref: ref instanceof Ref ? ref : null, dict: f, type });
      walk(f.get('Kids'), type, depth + 1);
    }
  };
  if (acro) walk(acro.get('Fields'), null, 0);
  return out;
}

function checkDocMdp(doc) {
  const perms = doc.dict(doc.catalog()?.get('Perms'));
  const sig = perms && doc.dict(perms.get('DocMDP'));
  const refs = sig && doc.resolve(sig.get('Reference'));
  if (!Array.isArray(refs)) return;
  for (const r of refs) {
    const d = doc.dict(r); const params = d && doc.dict(d.get('TransformParams'));
    if (d && isName(doc.resolve(d.get('TransformMethod')), 'DocMDP') && params && doc.resolve(params.get('P')) === 1) {
      throw new SignError('The author certified this PDF with no changes allowed, so another signature would invalidate it.');
    }
  }
}

async function openForSigning(pdfBytes) {
  let doc;
  try { doc = await PdfDocument.open(pdfBytes); } catch (error) { if (error instanceof PdfError) throw new SignError(`This file could not be read as a PDF (${error.message}).`); throw error; }
  if (doc.encrypted) throw new SignError('This PDF is password protected. Remove the password first, then sign it.');
  if (doc.recovered || doc.headerOffset !== 0) throw new SignError('This PDF is damaged (its cross-reference data had to be rebuilt). Save it once without signing, then sign the saved copy.');
  const sx = lastIndexOfBytes(pdfBytes, 'startxref');
  const prev = sx >= 0 ? new Parser(pdfBytes, sx + 9).value() : null;
  if (!isInt(prev)) throw new SignError('This PDF has no readable cross-reference offset.');
  return { doc, prev };
}

/* Signing */

// signer: { certificates: [leaf DER, ...chain DER], algorithm: 'RSASSA-PKCS1-v1_5' | 'RSA-PSS' | 'ECDSA-P256' |
// 'ECDSA-P384', sign(digest, signedAttributes) -> Promise<Uint8Array> }. digest is the SHA-256 (SHA-384 for
// ECDSA-P384) of signedAttributes, the DER the signature covers: card signers sign the digest, WebCrypto keys
// sign the DER, since WebCrypto cannot sign a precomputed digest.
// options: { reason, location, contactInfo, name, page (0-based), rect: { x, y, width, height } in displayed
// page points from the top left (omit for an invisible signature), appearance: { lines: [string],
// image: { width, height, rgba: Uint8Array } }, date }.
export async function signPdf(pdfBytes, signer, options = {}) {
  const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const { doc, prev } = await openForSigning(bytes);
  checkDocMdp(doc);
  const hash = hashFor(signer.algorithm);
  const certs = (signer.certificates ?? []).map((c) => new Uint8Array(c));
  if (!certs.length) throw new SignError('The signer has no certificate.');
  const leaf = parseCertificate(certs[0]);

  const pages = doc.pages();
  const pageIndex = options.page ?? 0;
  const page = pages[pageIndex];
  if (!page) throw new SignError(`The document has no page ${pageIndex + 1}.`);
  if (page.num === null) throw new SignError('This PDF stores its pages in a way that cannot be updated. Save it once without signing, then sign the saved copy.');

  let size = 0;
  for (const s of doc.sections) { const v = s.trailer.get('Size'); if (isInt(v)) size = Math.max(size, v); }
  for (const n of doc.entries.keys()) size = Math.max(size, n + 1);
  const alloc = () => size++;
  const genOf = (n) => { const e = doc.entries.get(n); return e?.type === 1 ? e.gen : 0; };
  const objects = []; // { num, gen, body: Uint8Array }
  const put = (n, value) => objects.push({ num: n, gen: genOf(n), body: ascii(serialize(value)) });
  const putStream = (n, dict, data) => { const d = new Dict(dict); d.set('Length', data.length); objects.push({ num: n, gen: 0, body: concat([ascii(`${serialize(d)}\nstream\n`), data, ascii('\nendstream')]) }); };

  const fields = fieldsOf(doc);
  const names = new Set(fields.map((f) => text(doc.resolve(f.dict.get('T')))));
  let k = 1; while (names.has(`Signature${k}`)) k++;
  const sigNum = alloc(); const fieldNum = alloc();

  // Widget and appearance.
  const widget = new Dict([['Type', new Name('Annot')], ['Subtype', new Name('Widget')], ['FT', new Name('Sig')], ['T', textString(`Signature${k}`)], ['V', new Ref(sigNum, 0)], ['F', 132], ['P', new Ref(page.num, genOf(page.num))]]);
  if (options.rect) {
    const { x, y, width, height } = options.rect;
    if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) throw new SignError('The signature box is too small.');
    const box = pageBox(doc, page.dict); const rotate = rotationOf(doc, page.dict);
    const rect = toUserSpace(options.rect, box, rotate);
    widget.set('Rect', rect);
    const apNum = alloc();
    const resources = new Dict([['Font', new Dict([['Helv', new Dict([['Type', new Name('Font')], ['Subtype', new Name('Type1')], ['BaseFont', new Name('Helvetica')], ['Encoding', new Name('WinAnsiEncoding')]])]])]]);
    const image = options.appearance?.image;
    if (image) {
      const { width: iw, height: ih, rgba } = image;
      if (!(iw > 0 && ih > 0 && rgba?.length === iw * ih * 4)) throw new SignError('The signature image is not valid.');
      const rgb = new Uint8Array(iw * ih * 3); const alpha = new Uint8Array(iw * ih); let opaque = true;
      for (let i = 0; i < iw * ih; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; alpha[i] = rgba[i * 4 + 3]; if (alpha[i] !== 255) opaque = false; }
      const imgNum = alloc();
      const imgDict = new Dict([['Type', new Name('XObject')], ['Subtype', new Name('Image')], ['Width', iw], ['Height', ih], ['ColorSpace', new Name('DeviceRGB')], ['BitsPerComponent', 8], ['Filter', new Name('FlateDecode')]]);
      if (!opaque) {
        const maskNum = alloc();
        putStream(maskNum, new Dict([['Type', new Name('XObject')], ['Subtype', new Name('Image')], ['Width', iw], ['Height', ih], ['ColorSpace', new Name('DeviceGray')], ['BitsPerComponent', 8], ['Filter', new Name('FlateDecode')]]), await deflate(alpha));
        imgDict.set('SMask', new Ref(maskNum, 0));
      }
      putStream(imgNum, imgDict, await deflate(rgb));
      resources.set('XObject', new Dict([['Img', new Ref(imgNum, 0)]]));
    }
    const w = width; const h = height;
    const form = new Dict([['Type', new Name('XObject')], ['Subtype', new Name('Form')], ['BBox', [0, 0, w, h]], ['Resources', resources]]);
    if (ROTATE_MATRIX[rotate]) form.set('Matrix', ROTATE_MATRIX[rotate]);
    putStream(apNum, form, appearanceContent(w, h, (options.appearance?.lines ?? []).map(String).filter((l) => l.length), image));
    widget.set('AP', new Dict([['N', new Ref(apNum, 0)]]));
  } else widget.set('Rect', [0, 0, 0, 0]);
  put(fieldNum, widget);
  const fieldRef = new Ref(fieldNum, 0);

  // The page lists the widget among its annotations.
  const annots = page.dict.get('Annots');
  if (annots instanceof Ref && Array.isArray(doc.resolve(annots))) put(annots.num, [...doc.resolve(annots), fieldRef]);
  else { const p = new Dict(page.dict); p.set('Annots', [...(Array.isArray(annots) ? annots : []), fieldRef]); put(page.num, p); }

  // The form lists the field and says the document holds signatures.
  const rootRef = doc.trailer.get('Root');
  const catalog = doc.catalog();
  const acroRef = catalog.get('AcroForm');
  const acro = new Dict(doc.dict(acroRef) ?? []);
  const fieldList = acro.get('Fields');
  if (fieldList instanceof Ref && Array.isArray(doc.resolve(fieldList))) put(fieldList.num, [...doc.resolve(fieldList), fieldRef]);
  else acro.set('Fields', [...(Array.isArray(fieldList) ? fieldList : []), fieldRef]);
  acro.set('SigFlags', 3);
  if (acroRef instanceof Ref) put(acroRef.num, acro);
  else {
    const n = alloc(); put(n, acro);
    const c = new Dict(catalog); c.set('AcroForm', new Ref(n, 0)); put(rootRef.num, c);
  }

  // The signature dictionary, with fixed-width room for /ByteRange and /Contents.
  const reserve = certs.reduce((s, c) => s + c.length, 0) + 4096 + (options.reserve ?? 0);
  const sig = new Dict([['Type', new Name('Sig')], ['Filter', new Name('Adobe.PPKLite')], ['SubFilter', new Name('ETSI.CAdES.detached')]]);
  const M = pdfDateString(options.date ?? new Date());
  const tail = new Dict([['M', new Str(ascii(M))]]);
  const signerName = options.name ?? (leaf.subject.cn || leaf.subject.text);
  if (signerName) tail.set('Name', textString(signerName));
  for (const [key, value] of [['Reason', options.reason], ['Location', options.location], ['ContactInfo', options.contactInfo]]) if (value) tail.set(key, textString(value));
  const BR = '/ByteRange [0 0000000000 0000000000 0000000000]';
  const sigHead = serialize(sig).slice(0, -2);
  const sigBody = `${sigHead}${BR}/Contents <${'0'.repeat(reserve * 2)}>${serialize(tail).slice(2)}`;
  objects.push({ num: sigNum, gen: 0, body: ascii(sigBody) });

  // The update: the objects, then a cross-reference section of the same kind as the last one.
  const parts = []; let at = bytes.length;
  const push = (u8) => { parts.push(u8); at += u8.length; };
  if (bytes[bytes.length - 1] !== 0x0a && bytes[bytes.length - 1] !== 0x0d) push(ascii('\n'));
  const offsets = new Map(); let sigAt = -1;
  objects.sort((a, b) => a.num - b.num);
  for (const o of objects) {
    offsets.set(o.num, [at, o.gen]);
    const head = ascii(`${o.num} ${o.gen} obj\n`);
    if (o.num === sigNum) sigAt = at + head.length;
    push(concat([head, o.body, ascii('\nendobj\n')]));
  }
  const trailer = new Dict();
  const id0 = doc.trailer.get('ID'); const newId = crypto.getRandomValues(new Uint8Array(16));
  const firstId = Array.isArray(id0) && id0[0] instanceof Str ? id0[0] : new Str(newId);
  trailer.set('Root', rootRef);
  if (doc.trailer.get('Info') instanceof Ref) trailer.set('Info', doc.trailer.get('Info'));
  trailer.set('ID', [firstId, new Str(newId)]);
  trailer.set('Prev', prev);
  if (doc.sections[0]?.kind === 'stream') {
    const xrefNum = alloc(); offsets.set(xrefNum, [at, 0]);
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const ow = Math.max(4, Math.ceil(Math.log2(at + 1) / 8));
    const index = []; const rows = [];
    for (const n of nums) {
      if (index.length && index.at(-2) + index.at(-1) === n) index[index.length - 1]++; else index.push(n, 1);
      const [o, g] = offsets.get(n); const row = new Uint8Array(1 + ow + 2); row[0] = 1;
      for (let i = 0, v = o; i < ow; i++, v = Math.floor(v / 256)) row[ow - i] = v & 0xff;
      row[ow + 1] = g >> 8; row[ow + 2] = g & 0xff; rows.push(row);
    }
    const data = concat(rows);
    const d = new Dict([['Type', new Name('XRef')], ['Size', size], ['W', [1, ow, 2]], ['Index', index], ...trailer, ['Length', data.length]]);
    const xrefAt = at;
    push(concat([ascii(`${xrefNum} 0 obj\n${serialize(d)}\nstream\n`), data, ascii(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`)]));
  } else {
    const xrefAt = at; const nums = [...offsets.keys()].sort((a, b) => a - b);
    let table = 'xref\n';
    for (let i = 0; i < nums.length;) {
      let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      table += `${nums[i]} ${j - i + 1}\n`;
      for (let q = i; q <= j; q++) { const [o, g] = offsets.get(nums[q]); table += `${String(o).padStart(10, '0')} ${String(g).padStart(5, '0')} n\r\n`; }
      i = j + 1;
    }
    const t = new Dict([['Size', size], ...trailer]);
    push(ascii(`${table}trailer\n${serialize(t)}\nstartxref\n${xrefAt}\n%%EOF\n`));
  }

  const out = concat([bytes, ...parts]);
  const brAt = sigAt + sigHead.length + '/ByteRange '.length;
  const contentsStart = sigAt + sigHead.length + BR.length + '/Contents '.length;
  const contentsEnd = contentsStart + reserve * 2 + 2;
  const range = [0, contentsStart, contentsEnd, out.length - contentsEnd];
  const brText = `[${range.join(' ')}]`;
  const brWidth = BR.length - '/ByteRange '.length;
  if (brText.length > brWidth) throw new SignError('The file is too large to sign.');
  out.set(ascii(brText.slice(0, -1) + ' '.repeat(brWidth - brText.length) + ']'), brAt);
  if (out[contentsStart] !== 0x3c || out[contentsEnd - 1] !== 0x3e) throw new Error('signature placeholder misplaced');

  const signedBytes = concat([out.subarray(0, contentsStart), out.subarray(contentsEnd)]);
  const cms = await buildSignedData({ ...signer, certificates: certs }, await digest(hash, signedBytes));
  if (cms.length > reserve) throw new SignError('The signature is larger than the space reserved for it.');
  out.set(ascii(toHex(cms)), contentsStart + 1);
  return out;
}

/* Checking */

const SIG_KINDS = { 'ETSI.CAdES.detached': 'PAdES (CAdES detached)', 'adbe.pkcs7.detached': 'PKCS #7 detached', 'adbe.pkcs7.sha1': 'PKCS #7 with SHA-1 digest', 'adbe.x509.rsa_sha1': 'X.509 RSA with SHA-1', 'ETSI.RFC3161': 'Document timestamp' };

function serialized(v) {
  if (v instanceof Stream) return `${serialize(v.dict)}${latin(v.raw)}`;
  try { return serialize(v); } catch { return ''; }
}

// What changed between the bytes a signature covers and the whole file.
async function laterChanges(full, u8, end) {
  let old;
  try { old = await PdfDocument.open(u8.subarray(0, end)); } catch { return { readable: false, kinds: [] }; }
  const changed = [];
  for (const [n, e] of full.entries) {
    if (e.type === 0) continue;
    const before = old.entries.get(n); const v = full.get(n);
    if (before && before.type !== 0) {
      if (before.type === 1 && e.type === 1 && before.offset === e.offset) continue;
      if (serialized(old.get(n)) === serialized(v)) continue;
    }
    changed.push([n, v]);
  }
  const dictOf = (v) => (v instanceof Stream ? v.dict : v instanceof Dict ? v : null);
  const isSigField = (d) => {
    let ft = d.get('FT'); let parent = d;
    for (let i = 0; !ft && parent && i < 32; i++) { parent = full.dict(parent.get('Parent')); ft = parent?.get('FT'); }
    return isName(full.resolve(ft), 'Sig');
  };
  // Appearance streams of signature widgets (and the images and forms they use) belong to the signature.
  const appearance = new Set();
  const walk = (v, depth) => {
    if (depth > 12) return;
    if (v instanceof Ref) { if (appearance.has(v.num)) return; appearance.add(v.num); walk(full.get(v.num), depth + 1); }
    else if (v instanceof Stream) walk(v.dict.get('Resources'), depth + 1);
    else if (v instanceof Dict) for (const x of v.values()) walk(x, depth + 1);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
  };
  for (const [, v] of changed) { const d = dictOf(v); if (d && nameOf(d.get('Subtype')) === 'Widget' && isSigField(d)) walk(d.get('AP'), 0); }
  const without = (x, keys) => { if (!(x instanceof Dict)) return ''; const c = new Dict(x); for (const k of keys) c.delete(k); return serialize(c); };
  const counts = new Map(); const add = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [n, v] of changed) {
    const d = dictOf(v);
    const type = d && nameOf(d.get('Type')); const sub = d && nameOf(d.get('Subtype'));
    if (type === 'XRef' || type === 'ObjStm') continue;
    if (appearance.has(n)) add('signature appearance');
    else if (type === 'Sig' || type === 'DocTimeStamp') add('signature');
    else if (type === 'DSS' || type === 'VRI' || (d && (d.has('OCSPs') || d.has('CRLs') || d.has('Certs')) && !d.has('Type'))) add('validation');
    else if (sub === 'Widget' || d?.has('FT')) add(isSigField(d) ? (d.has('V') ? 'signature' : 'empty signature field') : 'form');
    else if (type === 'Annot' || (d && sub && d.has('Rect'))) add('annotation');
    else if (type === 'Page') add(without(old.get(n), ['Annots']) === without(v, ['Annots']) ? 'page annotations list' : 'page');
    else if (type === 'Pages') add('pages');
    else if (type === 'Catalog') add(without(old.get(n), ['AcroForm', 'DSS']) === without(v, ['AcroForm', 'DSS']) ? 'form list' : 'catalog');
    else if (d?.has('Fields')) add('form list');
    else if (Array.isArray(v) && v.length && v.every((x) => { const xd = full.dict(x); return xd && (xd.has('Subtype') || xd.has('FT') || xd.has('T')); })) add('page annotations list');
    else if (v instanceof Stream) add('content');
    else add('other');
  }
  return { readable: true, kinds: [...counts].map(([kind, count]) => ({ kind, count })) };
}

const HARMLESS = new Set(['signature', 'signature appearance', 'validation', 'page annotations list', 'form list', 'empty signature field']);
const CHANGE_TEXT = {
  signature: 'a later signature or timestamp', 'signature appearance': 'the appearance of a later signature', validation: 'validation data (certificates, OCSP or CRLs)', 'empty signature field': 'an empty signature field',
  form: 'form fields or their values', annotation: 'comments or other annotations', page: 'page content or page properties', pages: 'pages added, removed or reordered',
  'page annotations list': "a page's list of annotations", catalog: 'the document catalog', 'form list': 'the list of form fields', content: 'content streams (page content, images or fonts)', other: 'other objects',
};
export const describeChange = (kind) => CHANGE_TEXT[kind] ?? kind;

// trusted: root certificates (parsed, see readCertificates) the user chose to trust.
export async function verifyPdf(pdfBytes, { trusted = [], now = new Date() } = {}) {
  const u8 = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  let doc;
  try { doc = await PdfDocument.open(u8); } catch (error) { if (error instanceof PdfError) return { signatures: [], problem: `The file could not be read as a PDF (${error.message}).` }; throw error; }
  if (doc.encrypted) return { signatures: [], encrypted: true, problem: 'This PDF is password protected, so its signatures cannot be checked here. Remove the password first.' };
  const out = [];
  for (const f of fieldsOf(doc)) {
    if (f.type !== 'Sig') continue;
    const v = doc.dict(f.dict.get('V'));
    if (!v) continue;
    out.push(await checkSignature(doc, u8, f, v, trusted, now));
  }
  return { signatures: out };
}

async function checkSignature(doc, u8, field, sig, trusted, now) {
  const r = (k) => doc.resolve(sig.get(k));
  const res = {
    field: text(doc.resolve(field.dict.get('T'))) || 'Unnamed signature', subFilter: nameOf(r('SubFilter')) ?? '', kind: '',
    name: text(r('Name')), reason: text(r('Reason')), location: text(r('Location')), contactInfo: text(r('ContactInfo')),
    claimedTime: r('M') instanceof Str ? parsePdfDate(text(r('M'))) : null,
    status: 'invalid', coversWholeFile: false, digestOk: false, signatureOk: false, signer: null, chain: [], trust: 'not-checked', problems: [], laterChanges: null,
  };
  res.kind = SIG_KINDS[res.subFilter] ?? (res.subFilter || 'unknown');
  const br = r('ByteRange');
  if (!Array.isArray(br) || br.length !== 4 || !br.every((x) => isInt(x) && x >= 0)) { res.problems.push('The byte range is missing or malformed.'); return res; }
  const [a, b, c, d] = br;
  if (a !== 0 || b <= 0 || c <= b || c + d > u8.length) { res.problems.push('The byte range does not describe this file.'); return res; }
  if (u8[b] !== 0x3c || u8[c - 1] !== 0x3e) { res.problems.push('The byte range does not leave out exactly the signature value.'); return res; }
  res.signedLength = c + d; res.fileLength = u8.length;
  let tail = c + d; while (tail < u8.length && (u8[tail] === 0x0a || u8[tail] === 0x0d || u8[tail] === 0x20 || u8[tail] === 0)) tail++;
  res.coversWholeFile = tail === u8.length;
  if (res.subFilter === 'adbe.x509.rsa_sha1' || res.subFilter === 'ETSI.RFC3161') { res.status = 'unsupported'; res.problems.push(`${res.kind} signatures are not checked by this tool.`); return res; }
  let cmsBytes;
  try { cmsBytes = fromHex(latin(u8.subarray(b + 1, c - 1)).replace(/[\s]/g, '')); } catch { res.problems.push('The signature value is not hexadecimal.'); return res; }
  const fromDict = r('Contents');
  if (fromDict instanceof Str && compareBytes(fromDict.bytes, cmsBytes) !== 0) res.problems.push('The /Contents value differs from the bytes the byte range leaves out.');
  let sd;
  try { sd = parseSignedData(cmsBytes); } catch (error) { res.problems.push(`The signature value could not be read (${error.message}).`); return res; }
  const signed = concat([u8.subarray(0, b), u8.subarray(c, c + d)]);
  let content = signed;
  if (sd.eContent) {
    if (res.subFilter !== 'adbe.pkcs7.sha1') res.problems.push('The signature encapsulates content although its type says detached.');
    const sha1 = await digest('SHA-1', signed);
    if (compareBytes(sha1, sd.eContent) !== 0) { res.problems.push('The SHA-1 digest inside the signature does not match the document.'); res.digestMismatch = true; }
    content = sd.eContent;
  }
  const v = await verifySignedData(sd, content);
  res.digestOk = v.digestOk && !res.digestMismatch; res.signatureOk = v.signatureOk; res.hash = v.hash; res.timestamped = v.timestamped;
  res.problems.push(...v.problems);
  if (v.signingTime) res.signingTime = v.signingTime;
  if (v.signer) {
    const cert = v.signer;
    res.signer = await certInfo(cert, res.claimedTime ?? v.signingTime ?? null, now);
    const built = await buildChain(cert, sd.certificates, trusted);
    res.chain = await Promise.all(built.chain.map(async (l) => ({ ...(await certInfo(l.cert, null, now)), signedByNext: l.signedByNext, selfSigned: Boolean(l.selfSigned) })));
    res.trust = built.trust; res.chainComplete = built.complete;
  }
  if (!res.coversWholeFile) res.laterChanges = await laterChanges(doc, u8, c + d);
  if (!res.digestOk) res.problems.unshift('The document was changed after it was signed: the digest does not match.');
  if (!res.signatureOk && v.signer) res.problems.unshift('The cryptographic signature is not valid for the signed data.');
  if (v.signingCertOk === false) res.signatureOk = false;
  const ok = res.digestOk && res.signatureOk;
  if (!ok) res.status = 'invalid';
  else if (res.coversWholeFile) res.status = 'valid';
  else if (res.laterChanges?.readable && res.laterChanges.kinds.every((x) => HARMLESS.has(x.kind))) res.status = 'valid-later-signed';
  else res.status = 'valid-later-changed';
  return res;
}

async function certInfo(cert, at, now) {
  return {
    subject: cert.subject.text, commonName: cert.subject.cn, organization: cert.subject.o, issuer: cert.issuer.text, issuerCommonName: cert.issuer.cn,
    serial: cert.serialHex.toUpperCase(), notBefore: cert.notBefore, notAfter: cert.notAfter,
    expired: now > cert.notAfter, notYetValid: now < cert.notBefore,
    validAtSigning: at ? at >= cert.notBefore && at <= cert.notAfter : null,
    keyUsage: cert.keyUsage, extKeyUsage: cert.extKeyUsage, ca: cert.ca,
    key: cert.key.type === 'EC' ? `ECDSA ${cert.key.curve || 'unknown curve'}` : cert.key.type === 'RSA' ? `RSA ${cert.key.bits}-bit` : cert.key.type,
    fingerprint: await fingerprint(cert), der: cert.der,
  };
}

