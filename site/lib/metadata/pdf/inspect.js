// PDF inspection: document metadata, earlier revisions, scripts and actions, attachments, comments, form
// data, signatures, hidden layers, fonts and the metadata of embedded JPEG images.
import { LIMITS, fmtBytes, crc32, utf8 } from '../bytes.js';
import { Report } from '../report.js';
import { parseXmp } from '../xmp.js';
import { PdfDocument } from './document.js';
import { Dict, Stream, Ref, Str, isName, nameOf, isInt, text, decodeText, pdfDate, WS } from './syntax.js';
import { decode, Budget } from './filters.js';
import { MARKUP, REMOVE_ACTIONS, actionType, openActionKept, cleanableJpeg, fieldType, filledValue } from './rules.js';
import { parseSignedData } from './der.js';
import { coveredContent, snippet } from './content.js';

const AUTO = new Set(['O', 'C', 'PO', 'PC', 'PV', 'PI', 'WC', 'WS', 'DS', 'WP', 'DP']);
const TRIGGERS = { O: 'when a page opens', C: 'when a page closes or a field recalculates', PO: 'when a page opens', PC: 'when a page closes', PV: 'when a page becomes visible', PI: 'when a page is hidden', WC: 'before the document closes', WS: 'before the document is saved', DS: 'after the document is saved', WP: 'before printing', DP: 'after printing', E: 'when the pointer enters', X: 'when the pointer leaves', D: 'on mouse down', U: 'on mouse up', Fo: 'on focus', Bl: 'when focus leaves', K: 'on each keystroke', F: 'when a field is formatted', V: 'when a field is validated' };
const NETWORK_JS = /\b(launchURL|submitForm|getURL|SOAP\s*\.|Net\s*\.\s*(HTTP|SOAP|Discovery)|openDoc|importDataObject|mailDoc|mailForm|mailMsg|Collab\s*\.|RSS\s*\.|exportAsFDF|exportXFAData)\b|https?:\/\//i;
const REMOTE = /^(https?|ftp|file|smb):\/\/|^\\\\|^\/\/[^/]/i;
const PATH = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\/:*?"<>|\r\n]+|\/Users\/[^/\s]+|\/home\/[^/\s]+|\\\\[A-Za-z0-9._$-]+\\[^\\\s]+/;
const DEVICE = /\b(scan(ner)?|ScanSnap|Xerox|Ricoh|Konica|Minolta|bizhub|Kyocera|TASKalfa|Brother|Epson|Lexmark|Sharp MX|e-STUDIO|HP Digital Sending|HP Scan|Officejet|LaserJet|imageRUNNER|WorkCentre|Fiery|PaperStream|NAPS2|Genius Scan|CamScanner|Adobe Scan|Office Lens|Microsoft Lens|vFlat|TurboScan|Scanbot)\b/i;
const INFO = { Title: ['Description', 'Title'], Subject: ['Description', 'Subject'], Keywords: ['Description', 'Keywords'], Author: ['People', 'Author'], Creator: ['Software', 'Creator'], Producer: ['Software', 'Producer'], CreationDate: ['Dates', 'Created'], ModDate: ['Dates', 'Modified'] };
const STANDARD_INFO = new Set([...Object.keys(INFO), 'Trapped']);
const ANNOT_LABELS = { Text: 'Sticky note', FreeText: 'Text box', StrikeOut: 'Strikethrough', Ink: 'Drawing', FileAttachment: 'File attachment', RichMedia: 'Rich media', PolyLine: 'Polyline' };
const FONT_LABELS = { Type1: 'Type 1', MMType1: 'Multiple master', TrueType: 'TrueType', Type0: 'Composite', Type3: 'Type 3', CIDFontType0: 'CID Type 0', CIDFontType2: 'CID TrueType' };
const SIZES = { '612x792': 'Letter', '612x1008': 'Legal', '595x842': 'A4', '842x1191': 'A3', '420x595': 'A5', '792x1224': 'Tabloid', '499x709': 'B5' };
const MAX_IMAGES = 300;
const MAX_FILES = 100;
const MAX_EMBEDDED_INSPECT = 8 * 1048576;

// Embedded PDFs can hold embedded PDFs. Only two levels are opened.
let nesting = 0;

export async function inspectPdf(b, r) {
  r.format = 'PDF'; r.category = 'Document';
  const doc = new PdfDocument(b.u8, { warn: (m) => r.warn(m) });
  await doc.load();
  const I = { doc, r, cat: doc.catalog(), enc: doc.encrypted };
  I.t = (v) => { v = doc.resolve(v); return I.enc && v instanceof Str ? '' : text(v); };
  I.where = (num) => (num !== null && num !== undefined && doc.span(num)) || [Math.max(0, doc.sections[0]?.offset ?? 0), 0];
  structure(I);
  encryption(I);
  info(I);
  ids(I);
  const found = walk(I);
  pageDetails(I);
  forms(I);
  catalogDetails(I);
  await metadataStreams(I, found);
  await actions(I, found.actions);
  objectDetails(I, found);
  await history(I);
  await xfa(I);
  await embeddedFiles(I, found.files);
  await images(I, found.images);
  await redactions(I);
  finalSignals(I);
}

function structure(I) {
  const { doc, r } = I;
  r.field('Container', 'PDF version', doc.version ?? 'Unknown');
  const declared = nameOf(I.cat?.get('Version'));
  if (declared && declared !== doc.version) r.field('Container', 'Version in the catalog', declared);
  if (doc.headerOffset > 0) {
    r.struct('Data before header', 0, doc.headerOffset);
    r.field('Container', 'Data before the PDF header', fmtBytes(doc.headerOffset), { flag: 'privacy' });
    r.block('Header data', 0, doc.headerOffset, { decoded: false, container: 'before %PDF-', note: 'Data before the PDF header' });
  }
  r.struct('Header', Math.max(0, doc.headerOffset), 8, `PDF ${doc.version ?? ''}`.trim());
  const kinds = [...new Set(doc.sections.map((s) => (s.hybrid ? 'Table with stream (hybrid)' : s.kind === 'table' ? 'Table' : 'Stream')))];
  r.field('Container', 'Cross-reference', doc.recovered ? 'Rebuilt by scanning the file' : kinds.join(', '));
  r.field('Container', 'Objects', String([...doc.entries.values()].filter((e) => e.type !== 0).length));
  if (doc.objstms.size) r.field('Container', 'Object streams', String(doc.objstms.size));
  if (doc.linearized()) r.field('Container', 'Linearized', 'Yes (fast web view)');
}

function encryption(I) {
  const { doc, r } = I;
  const ref = doc.trailer.get('Encrypt'); const e = doc.dict(ref);
  if (!doc.trailer.has('Encrypt')) return;
  const src = 'PDF encryption';
  if (!e) { r.field(src, 'Encryption', 'Declared, but the encryption dictionary is unreadable'); return; }
  const filter = nameOf(e.get('Filter')) ?? ''; const v = e.get('V'); const rev = e.get('R'); const len = e.get('Length');
  const cf = doc.dict(doc.dict(e.get('CF'))?.get(nameOf(e.get('StmF')) ?? 'StdCF'));
  const cfm = nameOf(cf?.get('CFM'));
  const method = v === 5 || cfm === 'AESV3' ? 'AES-256' : cfm === 'AESV2' ? 'AES-128' : v === 1 ? 'RC4 40-bit' : `RC4 ${isInt(len) ? len : 40}-bit`;
  r.field(src, 'Method', filter === 'Standard' ? `${method}, password` : filter === 'Adobe.PubSec' ? `${method}, certificate (public key)` : `${method}${filter ? `, ${filter}` : ''}`);
  if (isInt(v)) r.field(src, 'Version', `V${v}${isInt(rev) ? ` R${rev}` : ''}`);
  const p = e.get('P');
  if (isInt(p)) {
    const bit = (n) => ((p >>> (n - 1)) & 1) === 1;
    const perms = [['Print', 3], ['Change the document', 4], ['Copy text and images', 5], ['Add or change comments', 6], ['Fill in forms', 9], ['Extract for accessibility', 10], ['Assemble pages', 11], ['Print at high quality', 12]];
    r.field(src, 'Allowed', perms.filter(([, n]) => bit(n)).map(([s]) => s).join(', ') || 'Nothing beyond viewing');
    const denied = perms.filter(([, n]) => !bit(n)).map(([s]) => s);
    if (denied.length) r.field(src, 'Not allowed', denied.join(', '));
  }
  if (e.get('EncryptMetadata') === false) r.field(src, 'Metadata', 'Left unencrypted');
  // Marked removable so that cleaning always reaches the cleaner, which refuses encrypted files with a reason.
  r.block('Encryption', ...I.where(ref instanceof Ref ? ref.num : null), { container: 'trailer /Encrypt', note: 'Encrypted PDFs are not cleaned' });
  r.warn('This PDF is encrypted. Text values and streams cannot be read without the password, so some details are not shown.');
}

function info(I) {
  const { doc, r } = I;
  const ref = doc.trailer.get('Info'); const d = doc.dict(ref);
  if (!d) return;
  let n = 0;
  for (const [k, raw] of d) {
    const v = doc.resolve(raw);
    let value = I.enc && v instanceof Str ? '(encrypted)' : text(v);
    if (!value) continue;
    if ((k === 'CreationDate' || k === 'ModDate') && !I.enc) value = pdfDate(value);
    const flag = k === 'Author' || !STANDARD_INFO.has(k) ? 'privacy' : undefined;
    r.field('PDF Info', k, value, { flag });
    if (INFO[k] && !I.enc) r.add(INFO[k][0], INFO[k][1], value, { flag });
    n++;
  }
  if (n) r.block('Document info', ...I.where(ref instanceof Ref ? ref.num : null), { container: 'Info dictionary', note: `${n} entr${n === 1 ? 'y' : 'ies'}` });
}

const hexOf = (u8) => [...u8].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

function ids(I) {
  const { doc, r } = I;
  const id = doc.resolve(doc.trailer.get('ID'));
  if (!Array.isArray(id) || !(id[0] instanceof Str)) return;
  const a = hexOf(id[0].bytes); const b = id[1] instanceof Str ? hexOf(id[1].bytes) : a;
  r.field('PDF document', 'Document ID', a);
  r.add('File', 'Document ID', a);
  if (b !== a) r.field('PDF document', 'Revision ID', `${b} (differs from the document ID, so the file was changed after it was first saved)`);
  r.block('Document ID', ...I.where(null), { removable: false, container: 'trailer /ID', note: 'Replaced with a fresh random ID when cleaned' });
}

// How an object was reached decides what its actions do: open actions and additional actions run on
// their own, /A runs when clicked.
function child(I, ctx, d, k) {
  if (ctx.key === 'AA') return { key: 'trigger', trigger: TRIGGERS[k] ?? `on the ${k} event`, auto: AUTO.has(k), gone: true };
  if (ctx.key === 'JSTree' && (k === 'Kids' || k === 'Names')) return ctx;
  if (k === 'AA') return { key: 'AA' };
  if (k === 'OpenAction') return { key: 'OpenAction', trigger: 'when the document opens', auto: true, gone: !openActionKept(I.doc, d.get(k)) };
  if (k === 'JavaScript' && ctx.key === 'Names') return { key: 'JSTree', trigger: 'when the document opens', auto: true, gone: true };
  if (k === 'Next') return { ...ctx, key: 'Next' };
  if (k === 'A') return { key: 'A', trigger: 'when clicked', auto: false, gone: false };
  return { key: k };
}

function walk(I) {
  const { doc } = I;
  const found = { actions: [], xmp: [], piece: [], thumbs: [], files: [], images: [], fonts: new Map(), modified: 0 };
  const seen = new Set(); const queue = [];
  const visit = (v, ctx, owner, depth) => {
    if (depth > 64) return;
    if (v instanceof Ref) { if (!seen.has(v.num) && doc.entries.has(v.num)) { seen.add(v.num); queue.push([v.num, ctx]); } return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, ctx, owner, depth + 1); return; }
    const d = v instanceof Stream ? v.dict : v;
    if (!(d instanceof Dict)) return;
    examine(I, found, v, d, ctx, owner);
    for (const [k, x] of d) visit(x, child(I, ctx, d, k), owner, depth + 1);
  };
  for (const k of ['Root', 'Info', 'ID']) visit(doc.trailer.get(k), { key: k }, null, 0);
  for (let i = 0; i < queue.length; i++) visit(doc.get(queue[i][0]), queue[i][1], queue[i][0], 0);
  I.reach = seen;
  return found;
}

function examine(I, found, v, d, ctx, owner) {
  const { doc } = I;
  const type = actionType(d);
  if (type !== null) found.actions.push({ d, type, ctx, owner });
  if (d.has('Metadata')) { const m = d.get('Metadata'); const s = doc.resolve(m); if (s instanceof Stream) found.xmp.push({ num: m instanceof Ref ? m.num : owner, stream: s, top: d === I.cat, owner: d }); }
  if (d.has('PieceInfo')) found.piece.push({ owner, d: doc.dict(d.get('PieceInfo')), parent: d });
  if (d.has('Thumb')) { const th = d.get('Thumb'); found.thumbs.push(th instanceof Ref ? th.num : owner); }
  if (d.has('LastModified')) found.modified++;
  if (d.has('EF')) found.files.push({ d, owner });
  if (v instanceof Stream && isName(d.get('Subtype'), 'Image')) found.images.push({ s: v, num: owner });
  if (isName(d.get('Type'), 'Font') && d.has('Subtype') && found.fonts.size < 500) font(I, found, d);
}

function font(I, found, d) {
  const { doc } = I;
  const sub = nameOf(d.get('Subtype')) ?? '';
  if (sub.startsWith('CIDFont')) return;
  const name = nameOf(doc.resolve(d.get('BaseFont'))) ?? (sub === 'Type3' ? 'Type 3 font' : '(unnamed)');
  let fd = doc.dict(d.get('FontDescriptor'));
  if (sub === 'Type0') { const df = doc.resolve(d.get('DescendantFonts')); fd = doc.dict(doc.dict(Array.isArray(df) ? df[0] : null)?.get('FontDescriptor')); }
  const embedded = fd && (fd.has('FontFile') || fd.has('FontFile2') || fd.has('FontFile3'));
  const how = sub === 'Type3' ? 'glyphs drawn in the file' : embedded ? (/^[A-Z]{6}\+/.test(name) ? 'embedded subset' : 'embedded') : 'not embedded';
  found.fonts.set(name.replace(/^[A-Z]{6}\+/, ''), `${FONT_LABELS[sub] ?? sub}, ${how}`);
}

const ownerLabel = (d) => {
  if (!(d instanceof Dict)) return 'object';
  const type = nameOf(d.get('Type')); const sub = nameOf(d.get('Subtype'));
  if (type === 'Page') return 'page'; if (sub === 'Image') return 'image'; if (sub === 'Form') return 'form'; if (type === 'Annot' || d.has('Rect')) return 'annotation';
  if (type === 'Font' || type === 'FontDescriptor') return 'font';
  return 'object';
};

// Decodes a stream that holds metadata, counting toward the file's decompression allowance.
async function streamData(I, s, label, { image = false } = {}) {
  if (I.enc || !(s instanceof Stream)) return null;
  const { r } = I;
  const left = LIMITS.maxInflateBytesPerFile - r.inflated;
  if (left <= 0) { r.warn('The file holds more compressed metadata than the 32 MB limit. The rest was skipped.'); return null; }
  const budget = new Budget(left, LIMITS.maxInflateBytes);
  try {
    const { data, codec } = await decode(s.raw, s.dict, { resolve: (v) => I.doc.resolve(v), budget });
    if (image) return codec === 'DCTDecode' ? data : null;
    return codec ? null : data;
  } catch (error) { r.warn(`Could not decompress ${label}: ${error.message}.`); return null; }
  finally { r.inflated += left - budget.left; }
}

const xmlText = (u8) => (u8[0] === 0xfe || u8[0] === 0xff || (u8[0] === 0 && u8[1] === 0x3c) || (u8[1] === 0 && u8[0] === 0x3c) ? decodeText(u8[0] === 0 ? Uint8Array.from([0xfe, 0xff, ...u8]) : u8[1] === 0 && u8[0] === 0x3c ? Uint8Array.from([0xff, 0xfe, ...u8]) : u8) : utf8.decode(u8));

async function metadataStreams(I, found) {
  const { r } = I; const done = new Set();
  for (const x of found.xmp) {
    if (done.has(x.num) || done.size >= 200) continue;
    done.add(x.num);
    const where = x.top ? 'document' : ownerLabel(x.owner);
    const data = await streamData(I, x.stream, 'an XMP metadata stream');
    if (data) {
      const label = x.top ? 'XMP' : `XMP (${where})`;
      parseXmp(xmlText(data), r, label);
      if (x.top) {
        const get = (src, key) => r.sources.get(`XMP ${src}`)?.find((f) => f.key === key)?.value;
        r.add('Software', 'Producer', get('pdf', 'pdf:Producer'));
        r.add('Software', 'Edit history', get('xmpMM', 'xmpMM:History › stEvt:softwareAgent'));
        r.add('File', 'Instance ID', get('xmpMM', 'xmpMM:InstanceID'));
      }
    }
    r.block('XMP', ...I.where(x.num), { container: x.top ? 'Document metadata stream' : `Metadata stream (${where})` });
  }
}

function target(I, v) {
  const d = I.doc.resolve(v);
  if (d instanceof Str) return I.t(d);
  if (d instanceof Dict) {
    for (const k of ['UF', 'F', 'Unix', 'DOS', 'Mac']) { const s = I.t(d.get(k)); if (s) return s; }
    const win = I.doc.dict(d.get('Win')); if (win) return [I.t(win.get('F')), I.t(win.get('P'))].filter(Boolean).join(' ');
  }
  return '';
}

async function script(I, v) {
  const s = I.doc.resolve(v);
  if (s instanceof Str) return I.enc ? '' : decodeText(s.bytes);
  const data = await streamData(I, s, 'a script');
  return data ? decodeText(data) : '';
}

async function actions(I, list) {
  const { r } = I; const seen = new Set(); const network = []; const scripts = []; const launches = [];
  for (const a of list) {
    if (seen.has(a.d) || seen.size >= 1000) continue;
    seen.add(a.d);
    const { d, type, ctx } = a;
    const gone = !!ctx.gone || REMOVE_ACTIONS.has(type);
    const trigger = ctx.trigger ?? 'when activated';
    let detail = ''; let remote = false;
    if (type === 'JavaScript' || type === 'ECMAScript') {
      const code = await script(I, d.get('JS'));
      remote = NETWORK_JS.test(code);
      const urls = [...new Set(code.match(/https?:\/\/[^\s'"\\)<>]+/g) ?? [])].slice(0, 5);
      detail = `${code.replace(/\s+/g, ' ').trim().slice(0, 300)}${urls.length ? ` (addresses: ${urls.join(', ')})` : ''}`;
      scripts.push(trigger);
    } else if (type === 'URI') { detail = I.t(d.get('URI')); remote = true; }
    else if (type === 'SubmitForm') { detail = target(I, d.get('F')); remote = true; }
    else if (type === 'GoToR' || type === 'Launch' || type === 'GoToE' || type === 'ImportData') {
      detail = target(I, d.get('F')) || target(I, d);
      remote = REMOTE.test(detail);
      if (type === 'Launch') launches.push(detail || 'a program');
    } else if (type === 'Named') detail = nameOf(d.get('N')) ?? '';
    if (!gone && !remote && !ctx.auto) continue;
    if (ctx.key === 'A' && type === 'URI') continue;
    r.field('PDF actions', `${type || 'Action'} ${trigger}`, detail || type, { flag: remote ? 'privacy' : undefined });
    if (gone) r.block(type === 'JavaScript' || type === 'ECMAScript' ? 'Script' : 'Action', ...I.where(a.owner), { container: `${type || 'Unknown'} action ${trigger}` });
    if (remote && ctx.auto) network.push(`${type} ${trigger}${detail ? ` (${detail.slice(0, 120)})` : ''}`);
  }
  if (network.length) r.signal('privacy', 'Contacts the internet when opened', `The PDF asks the reader to reach out to the network without a click: ${network.slice(0, 3).join('; ')}. This is how PDF tracking and canary tokens report that a file was opened. Many readers block or ask first.`, 'PDF actions', 'contacts the internet when opened');
  if (scripts.length) r.signal('privacy', 'JavaScript inside', `${scripts.length} script${scripts.length === 1 ? '' : 's'}, run ${[...new Set(scripts)].slice(0, 3).join(', ')}.`, 'PDF actions', 'JavaScript');
  if (launches.length) r.signal('privacy', 'Launches a program or file', `A launch action opens ${launches.slice(0, 2).join(', ')}.`, 'PDF actions', 'a launch action');
}

function objectDetails(I, found) {
  const { r } = I;
  const apps = new Map();
  for (const p of found.piece) {
    const names = p.d ? [...p.d.keys()] : [];
    for (const n of names) apps.set(n, (apps.get(n) ?? 0) + 1);
    r.block('Application data', ...I.where(p.owner), { container: `PieceInfo on ${ownerLabel(p.parent)} (${names.join(', ') || 'empty'})` });
  }
  for (const [name, n] of apps) { r.field('PDF application data', name, `Private data on ${n} object${n === 1 ? '' : 's'}`); r.add('Software', 'Application data', name); }
  for (const num of new Set(found.thumbs)) r.block('Thumbnail', ...I.where(num), { container: 'Page thumbnail' });
  if (found.thumbs.length) r.field('PDF document', 'Page thumbnails', String(new Set(found.thumbs).size));
  if (found.modified) r.field('PDF document', 'Objects with a last-modified date', String(found.modified));
  for (const [name, how] of found.fonts) r.field('PDF fonts', name, how);
}

function sizeLabel(box) {
  if (!Array.isArray(box) || box.length < 4 || !box.every((x) => typeof x === 'number')) return null;
  const w = Math.round(Math.abs(box[2] - box[0])); const h = Math.round(Math.abs(box[3] - box[1]));
  const name = SIZES[`${Math.min(w, h)}x${Math.max(w, h)}`];
  return `${w} × ${h} pt${name ? ` (${name}${w > h ? ', landscape' : ''})` : ''}`;
}

function pageDetails(I) {
  const { doc, r } = I;
  const pages = doc.pages();
  r.field('Container', 'Pages', !pages.length && I.enc ? 'Unknown (encrypted)' : String(pages.length));
  const sizes = new Map();
  pages.forEach((p) => { const s = sizeLabel(doc.resolve(p.inherited.MediaBox)); if (s) sizes.set(s, (sizes.get(s) ?? 0) + 1); });
  const sorted = [...sizes].sort((a, b) => b[1] - a[1]);
  if (sorted.length) r.field('Container', 'Page size', sorted.slice(0, 5).map(([s, n]) => (sorted.length > 1 ? `${s}, ${n} page${n === 1 ? '' : 's'}` : s)).join('; '));
  let comments = 0; let redacts = 0; const authors = new Set();
  pages.forEach((p, i) => {
    const annots = doc.resolve(p.dict.get('Annots'));
    if (!Array.isArray(annots)) return;
    for (const a of annots.slice(0, 5000)) {
      const d = doc.resolve(a);
      if (!(d instanceof Dict)) continue;
      const sub = nameOf(d.get('Subtype')) ?? 'Unknown';
      const num = a instanceof Ref ? a.num : p.num;
      if (MARKUP.has(sub)) {
        if (sub === 'Popup') continue;
        comments++;
        const author = I.t(d.get('T')); const body = I.t(d.get('Contents')) || I.t(d.get('RC')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const date = I.t(d.get('M')) || I.t(d.get('CreationDate'));
        const label = ANNOT_LABELS[sub] ?? sub;
        r.field('PDF comments', `Page ${i + 1} ${label.toLowerCase()}`, [author && `${author}:`, body, date && `(${pdfDate(date)})`].filter(Boolean).join(' ') || label, { flag: author ? 'privacy' : undefined });
        if (author) { authors.add(author); r.add('People', 'Comment author', author, { flag: 'privacy' }); }
        if (body) r.add('Comments', 'PDF comment', body);
        r.block('Comment', ...I.where(num), { container: `${label} annotation, page ${i + 1}` });
      } else if (sub === 'Redact') {
        redacts++;
        r.field('PDF comments', `Page ${i + 1} redaction mark`, I.t(d.get('OverlayText')) || 'Not applied');
        if (I.t(d.get('T'))) r.add('People', 'Redaction mark author', I.t(d.get('T')), { flag: 'privacy' });
        r.block('Redaction mark', ...I.where(num), { removable: false, container: `Redact annotation, page ${i + 1}`, note: 'Kept so the unapplied redaction stays visible' });
      } else if (sub === 'Link') {
        const act = doc.dict(d.get('A'));
        if (actionType(act) === 'URI') {
          const uri = I.t(act.get('URI'));
          r.field('PDF links', `Page ${i + 1}`, uri);
          r.block('Link', ...I.where(num), { removable: false, container: `Link, page ${i + 1}`, note: 'Links stay clickable' });
        }
      } else if (sub !== 'Widget') r.field('PDF annotations', `Page ${i + 1}`, sub);
    }
  });
  if (comments) r.signal('privacy', 'Comments and markup', `${comments} comment${comments === 1 ? '' : 's'} or markup annotation${comments === 1 ? '' : 's'}${authors.size ? `, by ${[...authors].slice(0, 3).join(', ')}` : ''}. Comments are easy to forget and travel with the file.`, 'PDF annotations', 'comments');
  if (redacts) r.signal('privacy', 'Redaction marked but not applied', `${redacts} redaction mark${redacts === 1 ? ' was' : 's were'} never applied. The content under ${redacts === 1 ? 'it' : 'them'} is still in the file and readable.`, 'PDF annotations', 'unapplied redactions');
}

function fieldValue(I, v) {
  v = I.doc.resolve(v);
  if (Array.isArray(v)) return v.map((x) => I.t(x)).filter(Boolean).join(', ');
  if (v instanceof Stream) return '(rich text)';
  return I.t(v);
}

function forms(I) {
  const { doc, r } = I;
  const form = doc.dict(I.cat?.get('AcroForm'));
  const fields = form ? doc.resolve(form.get('Fields')) : null;
  const seen = new Set(); const sigs = []; const filled = []; let count = 0;
  const visit = (ref, parent, depth) => {
    if (depth > 32 || count > 20000) return;
    if (ref instanceof Ref) { if (seen.has(ref.num)) return; seen.add(ref.num); }
    const d = doc.resolve(ref);
    if (!(d instanceof Dict)) return;
    count++;
    const full = [parent, I.t(d.get('T'))].filter(Boolean).join('.');
    const kids = doc.resolve(d.get('Kids'));
    const fieldKids = Array.isArray(kids) ? kids.filter((k) => { const kd = doc.resolve(k); return kd instanceof Dict && (kd.has('T') || kd.has('FT') || kd.has('Kids')); }) : [];
    for (const k of fieldKids) visit(k, full, depth + 1);
    const ft = fieldType(doc, d); const num = ref instanceof Ref ? ref.num : null;
    if (ft === 'Sig') { if (!fieldKids.length) sigs.push({ d, num, name: full }); return; }
    if (fieldKids.length || !filledValue(doc, d.get('V'))) return;
    const value = I.enc ? '(encrypted)' : fieldValue(I, d.get('V'));
    filled.push(full || 'unnamed');
    r.field('PDF form', full || '(unnamed field)', value, { flag: 'privacy' });
    r.block('Form data', ...I.where(num), { container: `Field ${full || '(unnamed)'}`, note: 'Kept unless form clearing is chosen' });
  };
  if (Array.isArray(fields)) for (const f of fields) visit(f, '', 0);
  // Signature widgets on pages that the form's field list does not reach, or in a file with no form.
  for (const p of doc.pages()) {
    const annots = doc.resolve(p.dict.get('Annots'));
    if (!Array.isArray(annots)) continue;
    for (const a of annots) {
      if (a instanceof Ref && seen.has(a.num)) continue;
      const d = doc.resolve(a);
      if (!(d instanceof Dict) || fieldType(doc, d) !== 'Sig') continue;
      if (a instanceof Ref) seen.add(a.num);
      sigs.push({ d, num: a instanceof Ref ? a.num : null, name: I.t(d.get('T')) ?? '' });
    }
  }
  if (form) r.field('PDF form', 'Fields', String(count));
  if (filled.length) r.signal('privacy', 'Filled-in form data', `${filled.length} form field${filled.length === 1 ? ' holds a value' : 's hold values'} (${filled.slice(0, 4).join(', ')}).`, 'PDF form', 'filled-in form data');
  signatures(I, sigs);
  const perms = doc.dict(I.cat?.get('Perms'));
  if (perms?.has('DocMDP')) r.field('PDF signatures', 'Certification', 'The document is certified: its author limited what may change');
  if (I.cat?.has('DSS')) r.field('PDF signatures', 'Validation data', 'Stored (certificates and revocation data)');
}

function signatures(I, sigs) {
  const { doc, r } = I; const src = 'PDF signatures'; const who = [];
  let n = 0;
  for (const s of sigs) {
    const ref = s.d.get('V'); const v = doc.dict(ref);
    if (!v) { r.field(src, s.name || 'Signature field', 'Empty, not signed'); continue; }
    n++;
    const key = (k) => `${s.name || `Signature ${n}`} ${k}`;
    const name = I.t(v.get('Name'));
    r.field(src, key('signer name'), name, { flag: 'privacy' });
    r.field(src, key('reason'), I.t(v.get('Reason')));
    r.field(src, key('location'), I.t(v.get('Location')), { flag: 'privacy' });
    r.field(src, key('contact'), I.t(v.get('ContactInfo')), { flag: 'privacy' });
    const when = I.t(v.get('M')); if (when) r.field(src, key('time'), pdfDate(when));
    r.field(src, key('format'), [nameOf(v.get('Filter')), nameOf(v.get('SubFilter'))].filter(Boolean).join(', '));
    const range = doc.resolve(v.get('ByteRange'));
    if (Array.isArray(range) && range.length === 4 && range.every(isInt)) {
      const end = range[2] + range[3];
      r.field(src, key('covers'), end >= doc.u8.length ? 'The whole file' : `The first ${fmtBytes(end)} of ${fmtBytes(doc.u8.length)}. Changes were added after this signature`);
    }
    let cert = null;
    const blob = doc.resolve(v.get('Contents')); const certBlob = doc.resolve(v.get('Cert'));
    if (!I.enc && blob instanceof Str) cert = parseSignedData(blob.bytes);
    if (!cert?.signer && !I.enc) { const c = Array.isArray(certBlob) ? certBlob[0] : certBlob; if (c instanceof Str) cert = parseSignedData(c.bytes); }
    if (cert?.signer) {
      const { subject, issuer, notBefore, notAfter } = cert.signer;
      const fmt = (o) => ['CN', 'O', 'OU', 'Email', 'C'].filter((k) => o[k]).map((k) => `${k}=${o[k]}`).join(', ');
      r.field(src, key('certificate'), fmt(subject), { flag: 'privacy' });
      r.field(src, key('issued by'), fmt(issuer));
      if (notBefore) r.field(src, key('certificate valid'), `${notBefore} to ${notAfter}`);
      if (cert.signingTime) r.field(src, key('signing time (signed attribute)'), cert.signingTime);
      if (cert.certificates.length > 1) r.field(src, key('certificates included'), String(cert.certificates.length));
      if (subject.Email) r.add('People', 'Signer email', subject.Email, { flag: 'privacy' });
    }
    const signer = name || cert?.signer?.subject.CN || cert?.signer?.subject.O || '';
    if (signer) { who.push(signer); r.add('People', 'Signer', signer, { flag: 'privacy' }); }
    r.block('Signature', ...I.where(ref instanceof Ref ? ref.num : s.num), { container: `Signature ${s.name || n}` });
  }
  if (n) r.signal('privacy', 'Digitally signed', `${n} signature${n === 1 ? '' : 's'}${who.length ? ` by ${who.slice(0, 3).join(', ')}` : ''}. A signature carries the signer's name and certificate details. It was not verified here.`, 'PDF signatures', "the signer's identity");
}

async function xfa(I) {
  const { doc, r } = I;
  const form = doc.dict(I.cat?.get('AcroForm'));
  const x = form?.get('XFA');
  if (!x) return;
  const v = doc.resolve(x);
  const packets = [];
  if (v instanceof Stream) packets.push(['xdp', v, x instanceof Ref ? x.num : null]);
  else if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) { const s = doc.resolve(v[i + 1]); if (s instanceof Stream) packets.push([I.t(v[i]), s, v[i + 1] instanceof Ref ? v[i + 1].num : null]); }
  const fields = doc.resolve(form.get('Fields'));
  const hybrid = Array.isArray(fields) && fields.length > 0;
  let xml = '';
  for (const [, s] of packets.slice(0, 50)) { const data = await streamData(I, s, 'an XFA form packet'); if (data) xml += utf8.decode(data.subarray(0, 4 * 1048576)); }
  r.field('PDF form', 'XFA packets', packets.map((p) => p[0]).join(', '));
  if (/<script\b/i.test(xml)) r.field('PDF form', 'XFA scripts', 'Present');
  const data = /<xfa:data\b[^>]*>([\s\S]*?)<\/xfa:data>/i.exec(xml)?.[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (data) {
    r.field('PDF form', 'XFA form data', data.slice(0, 500), { flag: 'privacy' });
    r.signal('privacy', 'Filled-in form data', 'The XFA form holds filled-in data.', 'PDF form', 'filled-in form data');
  }
  r.block('XFA form', ...I.where(packets[0]?.[2] ?? null), hybrid ? { container: 'AcroForm /XFA', note: 'The regular form fields stay' } : { removable: false, container: 'AcroForm /XFA', note: 'Kept: the form has no regular fields to fall back on' });
}

function catalogDetails(I) {
  const { doc, r } = I; const c = I.cat;
  if (!c) return;
  const src = 'PDF document';
  r.field(src, 'Language', I.t(c.get('Lang')));
  if (doc.dict(c.get('MarkInfo'))?.get('Marked') === true || c.has('StructTreeRoot')) r.field(src, 'Tagged for accessibility', 'Yes');
  for (const k of ['PageMode', 'PageLayout']) r.field(src, k === 'PageMode' ? 'Opens with' : 'Page layout', nameOf(c.get(k)));
  const intents = doc.resolve(c.get('OutputIntents'));
  if (Array.isArray(intents)) for (const oi of intents.slice(0, 10)) { const d = doc.dict(oi); if (d) r.field(src, 'Output intent', [I.t(d.get('OutputConditionIdentifier')), I.t(d.get('Info'))].filter(Boolean).join(', ') || nameOf(d.get('S'))); }
  if (c.has('Collection')) r.field(src, 'Portfolio', 'Yes (opens as a collection of attached files)');
  const ext = doc.dict(c.get('Extensions'));
  if (ext) for (const [k, e] of ext) { const d = doc.dict(e); if (d) r.field(src, `Extension ${k}`, `Level ${doc.resolve(d.get('ExtensionLevel'))}`); }
  const uri = doc.dict(c.get('URI'));
  if (uri) r.field(src, 'Base address for links', I.t(uri.get('Base')));
  const oc = doc.dict(c.get('OCProperties'));
  if (oc) {
    const ocgs = doc.resolve(oc.get('OCGs')); const d = doc.dict(oc.get('D'));
    const ids = (k) => new Set((doc.resolve(d?.get(k)) ?? []).filter((x) => x instanceof Ref).map((x) => x.num));
    const off = ids('OFF'); const on = ids('ON'); const base = nameOf(d?.get('BaseState')) ?? 'ON';
    const hidden = [];
    if (Array.isArray(ocgs)) for (const g of ocgs.slice(0, 1000)) {
      if (!(g instanceof Ref)) continue;
      const name = I.t(doc.dict(g)?.get('Name')) || 'Unnamed layer';
      const isHidden = base === 'OFF' ? !on.has(g.num) : off.has(g.num);
      r.field('PDF layers', name, isHidden ? 'Hidden by default' : 'Visible');
      if (isHidden) { hidden.push(name); r.block('Hidden layer', ...I.where(g.num), { removable: false, container: `Layer ${name}`, note: 'Kept: removing it would need the page content rewritten' }); }
    }
    if (hidden.length) r.signal('privacy', 'Hidden layers', `${hidden.length} layer${hidden.length === 1 ? ' is' : 's are'} hidden by default (${hidden.slice(0, 3).join(', ')}). Their content is in the file and can be shown in a PDF reader.`, 'PDF layers', 'hidden layers');
  }
}

function describe(v, infoNum, num) {
  if (num === infoNum) return 'Info dictionary';
  if (v instanceof Stream) {
    const d = v.dict; const type = nameOf(d.get('Type')); const sub = nameOf(d.get('Subtype'));
    if (type === 'Metadata') return 'XMP metadata';
    if (sub === 'Image') return 'image';
    if (sub === 'Form') return 'form';
    if (type === 'EmbeddedFile') return 'embedded file';
    if (d.has('Length1') || d.has('Length2') || sub === 'Type1C' || sub === 'CIDFontType0C' || sub === 'OpenType') return 'font file';
    if (type === 'XRef' || type === 'ObjStm') return 'structure';
    return 'content stream';
  }
  if (v instanceof Dict) {
    const type = nameOf(v.get('Type'));
    if (type === 'Page') return 'page';
    if (type === 'Annot' || (v.has('Rect') && v.has('Subtype'))) return 'annotation';
    if (type === 'Catalog') return 'catalog';
    if (type === 'Pages') return 'page tree';
    if (type === 'Font' || type === 'FontDescriptor') return 'font';
    if (type === 'Filespec') return 'attachment';
    if (!type && ['Author', 'Title', 'Producer', 'Creator'].some((k) => v.get(k) instanceof Str)) return 'Info dictionary';
  }
  return 'other';
}
const SIGNIFICANT = new Set(['Info dictionary', 'XMP metadata', 'image', 'embedded file', 'page', 'annotation', 'content stream', 'attachment', 'form']);
const tally = (labels) => { const m = new Map(); for (const l of labels) m.set(l, (m.get(l) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${n} ${l}${n === 1 ? '' : l.endsWith('s') ? '' : 's'}`).join(', '); };

async function history(I) {
  const { doc, r } = I; const u8 = doc.u8;
  const infoRef = doc.trailer.get('Info'); const infoNum = infoRef instanceof Ref ? infoRef.num : null;
  const current = doc.dict(infoRef);
  let revs; let old;
  if (doc.recovered) {
    const eofs = []; for (let i = u8.indexOf(0x25); i >= 0 && eofs.length < 256; i = u8.indexOf(0x25, i + 1)) if (u8[i + 1] === 0x25 && u8[i + 2] === 0x45 && u8[i + 3] === 0x4f && u8[i + 4] === 0x46) eofs.push(i + 5);
    revs = []; let start = 0;
    for (const e of eofs) { revs.push({ start, end: e }); start = e; }
    if (!revs.length) revs.push({ start: 0, end: u8.length });
    const { found, order } = doc.scan();
    old = order.filter(([num, off]) => found.get(num) !== off).map(([num, offset]) => ({ num, entry: { type: 1, offset } }));
  } else { revs = doc.revisions(); old = doc.superseded(); }
  const n = revs.length;
  const indexOf = (o) => {
    if (o.section) { const i = revs.findIndex((x) => x.section === o.section); if (i >= 0) return i; }
    const i = revs.findIndex((x) => o.entry.offset >= x.start && o.entry.offset < x.end);
    return i < 0 ? 0 : i;
  };
  const perRev = revs.map(() => []);
  const oldXmp = [];
  for (const o of old.slice(0, 5000)) {
    const v = doc.readOld(o.entry); const label = o.deleted && v === null ? 'deleted object' : describe(v, o.num === infoNum ? o.num : null, o.num);
    const i = indexOf(o);
    perRev[i].push(label);
    if (I.enc) continue;
    if (label === 'Info dictionary' && v instanceof Dict) {
      for (const [k, raw] of v) {
        let value = text(doc.resolve(raw)); if (!value) continue;
        if (k === 'CreationDate' || k === 'ModDate') value = pdfDate(value);
        const now = current?.has(k) ? text(doc.resolve(current.get(k))) : null;
        if (now !== null && (now === value || pdfDate(now) === value)) continue;
        r.field(`Earlier version ${i + 1} Info`, k, value, { flag: 'privacy' });
        if (k === 'Author') r.add('People', 'Earlier author', value, { flag: 'privacy' });
      }
    } else if (label === 'XMP metadata') oldXmp.push([i, v]);
  }
  if (n > 1 || old.length) r.field('PDF history', 'Revisions', String(n));
  revs.forEach((rev, i) => {
    r.struct(`Revision ${i + 1}`, rev.start, rev.end - rev.start, i === n - 1 ? 'Current version' : 'Earlier version');
    if (n < 2) return;
    const summary = perRev[i].length ? `Replaced or deleted later: ${tally(perRev[i])}` : 'Nothing replaced later';
    r.field('PDF history', `Revision ${i + 1}`, `${i === n - 1 ? 'Current version' : 'Earlier version'}, bytes ${rev.start.toLocaleString('en-US')} to ${rev.end.toLocaleString('en-US')}${i === n - 1 ? '' : `. ${summary}`}`);
    if (i < n - 1) r.block('Earlier version', rev.start, rev.end - rev.start, { container: `Revision ${i + 1} of ${n}`, note: summary });
  });
  const replaced = perRev.flat();
  if (n > 1) r.signal('privacy', 'Earlier versions kept in the file', `The file was saved ${n} times by appending changes, so earlier versions are still inside${replaced.length ? `, including ${tally(replaced)} that were later replaced or deleted` : ''}. PDF readers show only the latest version.`, 'PDF incremental updates', 'earlier versions');
  for (const [i, s] of oldXmp.slice(0, 20)) {
    const data = await streamData(I, s, 'an earlier XMP metadata stream');
    if (!data) continue;
    const scratch = new Report(0); parseXmp(xmlText(data), scratch);
    const now = new Set([...r.sources].filter(([k]) => k.startsWith('XMP ')).flatMap(([, fs]) => fs.map((f) => `${f.key}=${f.value}`)));
    for (const [, fields] of scratch.sources) for (const f of fields) if (f.key !== 'Packet size' && !now.has(`${f.key}=${f.value}`)) r.field(`Earlier version ${i + 1} XMP`, f.key, f.value, { flag: 'privacy' });
  }
  if (!I.enc) orphans(I, infoNum);
  const last = revs.at(-1);
  if (!doc.recovered && last.end < u8.length) {
    let k = last.end; while (k < u8.length && WS[u8[k]]) k++;
    if (k < u8.length) {
      const extra = u8.length - last.end;
      r.struct('Trailing data', last.end, extra);
      r.block('Trailer', last.end, extra, { decoded: false, note: 'Data after the end of the document' });
      r.field('PDF history', 'Data after the end of the document', fmtBytes(extra), { flag: 'privacy' });
      r.signal('privacy', 'Hidden data after the document', `${fmtBytes(extra)} follow the final end-of-file marker. PDF readers ignore it.`, 'PDF trailer', 'hidden data after the document');
    }
  }
}

function orphans(I, infoNum) {
  const { doc, r } = I;
  const encrypt = doc.trailer.get('Encrypt');
  const labels = []; const spans = new Map(); let first = null;
  const hint = doc.resolve(doc.linearized()?.get('H'))?.[0];
  for (const [num, e] of doc.entries) {
    if (e.type === 0 || I.reach.has(num) || (encrypt instanceof Ref && encrypt.num === num)) continue;
    if (labels.length >= 100000) break;
    const v = doc.get(num);
    if (v === null) continue;
    if (v instanceof Stream && (isName(v.dict.get('Type'), 'XRef') || isName(v.dict.get('Type'), 'ObjStm'))) continue;
    if (v instanceof Dict && v.has('Linearized')) continue;
    // Bare numbers and empty containers carry nothing, and the linearization hint stream is structure.
    if (!(v instanceof Stream) && !(v instanceof Str) && !(v?.size || v?.length)) continue;
    if (v instanceof Stream && isInt(hint) && doc.span(num)?.[0] === hint) continue;
    labels.push(describe(v, infoNum, num));
    const span = doc.span(num);
    if (span) { spans.set(span[0], span[1]); if (first === null || span[0] < first) first = span[0]; }
  }
  if (!labels.length) return;
  const summary = tally(labels);
  r.field('PDF history', 'Unused objects', `${labels.length}: ${summary}`);
  r.block('Unused objects', first ?? 0, [...spans.values()].reduce((a, b) => a + b, 0), { container: `${labels.length} object${labels.length === 1 ? '' : 's'} nothing refers to`, note: summary });
  if (labels.some((l) => SIGNIFICANT.has(l))) r.signal('privacy', 'Leftover content kept in the file', `${summary} are stored but no longer used by the document. Leftovers like these can hold deleted or replaced content.`, 'PDF objects', 'leftover content');
}

function nameTree(doc, node, fn, depth = 0, seen = new Set(), count = { n: 0 }) {
  if (depth > 32 || count.n > 10000) return;
  if (node instanceof Ref) { if (seen.has(node.num)) return; seen.add(node.num); }
  const d = doc.dict(node);
  if (!d) return;
  const names = doc.resolve(d.get('Names'));
  if (Array.isArray(names)) for (let i = 0; i + 1 < names.length; i += 2) { count.n++; fn(text(doc.resolve(names[i])), names[i + 1]); }
  const kids = doc.resolve(d.get('Kids'));
  if (Array.isArray(kids)) for (const k of kids) nameTree(doc, k, fn, depth + 1, seen, count);
}

async function embeddedFiles(I, list) {
  const { doc, r } = I;
  const treeNames = new Map();
  nameTree(doc, doc.dict(I.cat?.get('Names'))?.get('EmbeddedFiles'), (key, v) => { if (v instanceof Ref) treeNames.set(v.num, key); });
  const seen = new Set(); const names = [];
  for (const f of list) {
    if (seen.has(f.d) || seen.size >= MAX_FILES) continue;
    seen.add(f.d);
    const ef = doc.dict(f.d.get('EF'));
    const ref = ef?.get('UF') ?? ef?.get('F'); const s = doc.resolve(ref);
    if (!(s instanceof Stream)) continue;
    const name = target(I, f.d) || treeNames.get(f.owner) || 'Unnamed attachment';
    names.push(name);
    const params = doc.dict(s.dict.get('Params'));
    const size = doc.resolve(params?.get('Size'));
    const parts = [isInt(size) ? fmtBytes(size) : `${fmtBytes(s.raw.length)} stored`];
    const mime = nameOf(s.dict.get('Subtype')); if (mime) parts.push(mime.replace(/#2F/gi, '/'));
    const created = I.t(params?.get('CreationDate')); if (created) parts.push(`created ${pdfDate(created)}`);
    const modified = I.t(params?.get('ModDate')); if (modified) parts.push(`modified ${pdfDate(modified)}`);
    const desc = I.t(f.d.get('Desc')); if (desc) parts.push(desc);
    r.field('PDF attachments', name, parts.join(', '), { flag: 'privacy' });
    r.add('File', 'Embedded file', name);
    r.block('Embedded file', ...I.where(ref instanceof Ref ? ref.num : f.owner), { container: `Attachment ${name}` });
    if (nesting >= 2 || I.enc || s.raw.length > MAX_EMBEDDED_INSPECT || (isInt(size) && size > MAX_EMBEDDED_INSPECT)) continue;
    const data = await streamData(I, s, 'an embedded file');
    if (!data) continue;
    const { inspectFile } = await import('../index.js');
    let inner;
    nesting++;
    try { inner = await inspectFile(data, name); } finally { nesting--; }
    const src = `Attachment ${name}`;
    r.field(src, 'Format', inner.format ?? 'Not recognized');
    if (inner.fieldCount) r.field(src, 'Summary', inner.summary.title);
    for (const g of inner.highlights) for (const h of g.fields) r.field(src, `${g.name}: ${h.key}`, h.value, { flag: h.flag });
    for (const s2 of inner.signals) if (s2.kind === 'privacy') r.signal('privacy', s2.title, `In the attached file "${name}": ${s2.detail}`, src, s2.short);
  }
  if (names.length) r.signal('privacy', 'Embedded files', `${names.length} file${names.length === 1 ? ' is' : 's are'} attached inside the PDF (${names.slice(0, 3).join(', ')}). Attachments travel with the document and are easy to overlook.`, 'PDF attachments', 'embedded files');
}

// An orientation tag alone is what the image cleaner writes back, so it does not count as metadata.
export const orientationOnly = (rep) => { const s = rep.sources.filter((x) => !x.technical); return s.length === 1 && s[0].name === 'EXIF IFD0' && s[0].fields.every((f) => f.key === 'Orientation'); };

export const imageKey = (raw) => `${raw.length}:${crc32(raw)}`;

async function images(I, list) {
  const { r } = I; const seen = new Set(); let n = 0;
  for (const im of list) {
    if (seen.has(im.s) || seen.size >= MAX_IMAGES) continue;
    seen.add(im.s);
    const data = await streamData(I, im.s, 'an image', { image: true });
    if (!data || data[0] !== 0xff || data[1] !== 0xd8) continue;
    const { inspectImage } = await import('../index.js');
    const inner = await inspectImage(data);
    if (inner.format !== 'JPEG' || !inner.cleanable.blocks || orientationOnly(inner)) continue;
    n++;
    const cleanable = cleanableJpeg(I.doc, im.s);
    const kinds = [...new Set(inner.blocks.filter((b) => b.removable !== false).map((b) => b.kind))].join(', ');
    const facts = inner.highlights.flatMap((g) => g.fields.map((f) => `${f.key}: ${f.value}`)).slice(0, 6).join('; ');
    r.field('PDF images', `Image ${n} (${inner.width ?? '?'} × ${inner.height ?? '?'})`, `${kinds}${facts ? `. ${facts}` : ''}`, { flag: inner.signals.some((s) => s.kind === 'privacy') ? 'privacy' : undefined });
    for (const g of inner.highlights) if (g.name !== 'File') for (const f of g.fields) r.add(g.name, f.key, f.value, { flag: f.flag });
    for (const s of inner.signals) r.signal(s.kind, s.title, `In an image inside the PDF: ${s.detail}`, 'PDF images', s.short);
    r.block('Image metadata', ...I.where(im.num), cleanable
      ? { container: `JPEG image ${n} (${kinds})`, key: imageKey(im.s.raw) }
      : { removable: false, container: `JPEG image ${n} (${kinds})`, note: 'Kept: the image is stored with extra compression and is not rewritten' });
  }
}

async function redactions(I) {
  const { doc, r } = I;
  if (I.enc) return;
  const budget = new Budget(32 * 1048576, LIMITS.maxInflateBytes);
  const pages = doc.pages().slice(0, 300); const flagged = [];
  for (let i = 0; i < pages.length && budget.left > 0; i++) {
    const p = pages[i];
    const contents = doc.resolve(p.dict.get('Contents'));
    const parts = (Array.isArray(contents) ? contents.map((c) => doc.resolve(c)) : [contents]).filter((s) => s instanceof Stream).slice(0, 64);
    if (!parts.length) continue;
    const chunks = [];
    for (const s of parts) {
      try { const { data, codec } = await decode(s.raw, s.dict, { resolve: (v) => doc.resolve(v), budget }); if (!codec) chunks.push(data, Uint8Array.of(10)); } catch { break; }
    }
    const xobjects = doc.dict(doc.dict(p.dict.get('Resources') ?? p.inherited.Resources)?.get('XObject'));
    const box = doc.resolve(p.inherited.MediaBox);
    const area = Array.isArray(box) && box.length >= 4 ? Math.abs((box[2] - box[0]) * (box[3] - box[1])) || Infinity : Infinity;
    const all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const hits = coveredContent(all, { isImage: (name) => isName(doc.dict(xobjects?.get(name))?.get('Subtype'), 'Image'), pageArea: area });
    if (!hits.texts.length && !hits.images) continue;
    const what = [hits.texts.length && `${hits.texts.length} piece${hits.texts.length === 1 ? '' : 's'} of text`, hits.images && `${hits.images} image${hits.images === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
    const shown = snippet(hits.texts);
    r.field('PDF redaction clues', `Page ${i + 1}`, `${what} under a filled black box${shown ? `: "${shown}"` : ''}`, { flag: 'privacy' });
    flagged.push(i + 1);
  }
  if (flagged.length) r.signal('privacy', 'Content may be hidden under black boxes', `On page${flagged.length === 1 ? '' : 's'} ${flagged.slice(0, 5).join(', ')}, text or images are drawn and then covered by a filled black rectangle. This is how a failed redaction looks: the covered content is still in the file and can be copied out. It can also be ordinary design, so treat it as a clue.`, 'PDF page content', 'possibly unredacted content');
}

function finalSignals(I) {
  const { r } = I;
  if (I.doc.repairedLengths) r.field('Container', 'Stream lengths corrected', String(I.doc.repairedLengths));
  outer: for (const [name, fields] of r.sources) {
    for (const f of fields) {
      const m = PATH.exec(f.value);
      if (m) { r.signal('privacy', 'File path with a user name', `${name} ${f.key} holds the path ${m[0]}, which can reveal a user name or computer layout.`, name, 'a file path'); break outer; }
    }
  }
  const software = [...(r.highlights.get('Software') ?? [])].map((f) => f.value);
  const device = software.find((v) => DEVICE.test(v));
  if (device) r.signal('privacy', 'Scanner or app that made the file named', `"${device.slice(0, 120)}" names the scanner, copier or scanning app that produced this PDF.`, 'PDF Info', 'a scanner or device name');
}

