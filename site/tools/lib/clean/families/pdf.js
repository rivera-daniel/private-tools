// PDF: rewrites the document as one fresh revision holding only what the current version uses. Earlier
// revisions, unused objects, document metadata, scripts and automatic actions, attachments and comments
// are left out. Page content, fonts and images are copied byte for byte, except that JPEG images go
// through the image cleaner.
import { Refusal, cleanImage } from '../index.js';
import { PdfDocument } from '../../metadata/pdf/document.js';
import { Dict, Stream, Ref, Name, isName } from '../../metadata/pdf/syntax.js';
import { DROP_KEYS, chainRemovable, openActionKept, removedAnnotation, cleanableJpeg, fieldType } from '../../metadata/pdf/rules.js';
import { imageKey } from '../../metadata/pdf/inspect.js';
import { writePdf } from '../pdf/writer.js';

export const formats = new Set(['PDF']);

// Arrays where a dropped entry is left out rather than replaced by null.
const LISTS = new Set(['Annots', 'Fields', 'Kids', 'K', 'CO']);
const ROOT_DROP = new Set(['OpenAction', 'Collection', 'SpiderInfo']);

// options: clearForms (empty filled-in form fields), removeSignatures (clean a signed PDF, dropping its
// signatures).
export async function clean(u8, report, ctx) {
  const options = ctx.options ?? {};
  const doc = await PdfDocument.open(u8);
  if (doc.encrypted) throw new Refusal('This PDF is encrypted. Remove the password in a PDF reader first, then clean the unlocked copy.');
  const cat = doc.catalog(); const rootRef = doc.trailer.get('Root');
  if (!cat || !(rootRef instanceof Ref)) throw new Refusal('The PDF has no readable document catalog, so it was left untouched.');
  const pageCount = doc.pages().length;
  const plan = planDrops(doc, options);
  if (plan.signed && !options.removeSignatures) throw new Refusal('This PDF is digitally signed. Cleaning would invalidate the signature.');

  const map = new Map(); const roles = new Map(); const out = []; const queue = [];
  const refTo = (num, key, role) => {
    let n = map.get(num);
    if (n === undefined) { n = out.length + 1; map.set(num, n); roles.set(num, { key, role }); out.push(null); queue.push(num); }
    return new Ref(n, 0);
  };
  const objrDropped = (d) => isName(d.get('Type'), 'OBJR') && d.get('Obj') instanceof Ref && plan.drop.has(d.get('Obj').num);
  const dropped = (x) => {
    if (x instanceof Ref) return plan.drop.has(x.num) || doc.get(x.num) === null;
    return x instanceof Dict && (removedAnnotation(x) || (options.removeSignatures && fieldType(doc, x) === 'Sig') || objrDropped(x));
  };
  let clearedText = false;

  // Returns undefined for a value that is left out.
  const tx = (v, key, role, depth) => {
    if (depth > 100) throw new Refusal('The PDF nests objects too deeply to rewrite safely, so it was left untouched.');
    if (v instanceof Ref) return dropped(v) ? undefined : refTo(v.num, key, role);
    if (Array.isArray(v)) {
      const list = [];
      for (const x of v) {
        if (LISTS.has(key) && dropped(x)) continue;
        const y = tx(x, null, null, depth + 1);
        list.push(y === undefined ? null : y);
      }
      return list;
    }
    if (v instanceof Dict) return txDict(v, role, depth + 1, null, false);
    if (v instanceof Stream) return undefined;
    return v;
  };

  const txDict = (d, role, depth, num, stream) => {
    if (objrDropped(d)) return undefined;
    const o = new Dict();
    const root = num === rootRef.num;
    const ft = options.clearForms && (d.has('V') || d.has('AS') || d.has('AP')) ? fieldType(doc, d) : null;
    for (const [k, v] of d) {
      if (DROP_KEYS.has(k) || (stream && k === 'Length')) continue;
      if ((k === 'A' || k === 'Next') && chainRemovable(doc, v)) continue;
      if (root && ROOT_DROP.has(k) && !(k === 'OpenAction' && openActionKept(doc, v))) continue;
      if (root && options.removeSignatures && (k === 'Perms' || k === 'DSS')) continue;
      if (role === 'Names' && (k === 'JavaScript' || k === 'EmbeddedFiles')) continue;
      if (role === 'AcroForm' && ((k === 'XFA' && plan.hybrid) || (k === 'SigFlags' && options.removeSignatures))) continue;
      if ((ft === 'Tx' || ft === 'Ch') && (k === 'V' || (k === 'AP' && isName(d.get('Subtype'), 'Widget')))) { clearedText = true; continue; }
      if (ft === 'Btn' && (k === 'V' || k === 'AS')) { o.set(k, new Name('Off')); continue; }
      const childRole = root && k === 'Names' ? 'Names' : root && k === 'AcroForm' ? 'AcroForm' : null;
      const y = tx(v, k, childRole, depth);
      if (y !== undefined) o.set(k, y);
    }
    return o;
  };

  refTo(rootRef.num, null, null);
  const jpegs = [];
  for (let i = 0; i < queue.length; i++) {
    const num = queue[i]; const v = doc.get(num); const { key, role } = roles.get(num);
    const at = map.get(num) - 1;
    if (v instanceof Stream) {
      out[at] = { dict: txDict(v.dict, role, 0, num, true), data: v.raw };
      if (cleanableJpeg(doc, v)) jpegs.push(at);
    } else if (v instanceof Dict) out[at] = txDict(v, role, 0, num, false) ?? null;
    else out[at] = tx(v, key, role, 0) ?? null;
  }
  const acro = cat.get('AcroForm');
  if (clearedText && acro) {
    const target = acro instanceof Ref ? out[map.get(acro.num) - 1] : out[0].get('AcroForm');
    if (target instanceof Dict) target.set('NeedAppearances', true);
  }

  const keptImages = new Set();
  for (const at of jpegs) {
    const raw = out[at].data;
    const result = await cleanImage(raw);
    if (!result.ok) { keptImages.add(imageKey(raw)); continue; }
    if (result.data.length !== raw.length || result.data.some((b, i) => b !== raw[i])) { out[at].data = result.data; out[at].dict.delete('DL'); }
  }

  const id = crypto.getRandomValues(new Uint8Array(16));
  const data = writePdf({ version: doc.version ?? '1.7', objects: out, root: new Ref(1, 0), id });
  const problems = [];
  const check = await PdfDocument.open(data, { warn: (m) => problems.push(m) });
  if (problems.length || !check.catalog() || check.pages().length !== pageCount) throw new Refusal('The rewritten PDF did not pass the check afterwards, so it was not produced.');

  const allowed = (b) => (b.kind === 'Form data' && !options.clearForms) || (b.kind === 'Image metadata' && keptImages.has(b.key));
  const hasRemovableAncestor = (b) => { for (let p = b.parent; p !== null && p !== undefined; p = report.blocks[p]?.parent) if (report.blocks[p]?.removable !== false) return true; return false; };
  const removed = report.blocks.filter((b) => b.removable !== false && !hasRemovableAncestor(b) && !allowed(b)).map((b) => ({ kind: b.kind, container: b.container ?? '', bytes: b.length }));
  if (doc.trailer.has('ID')) removed.push({ kind: 'Document ID', container: 'Replaced with a fresh random ID', bytes: 0 });
  const keptCounts = new Map();
  for (const b of report.blocks) if ((b.removable === false && b.kind !== 'Document ID') || allowed(b)) keptCounts.set(b.kind, (keptCounts.get(b.kind) ?? 0) + 1);
  const why = { 'Form data': 'filled-in form fields, kept unless form clearing is chosen', Link: 'links, still clickable', 'Hidden layer': 'hidden layers', 'Redaction mark': 'unapplied redaction marks', 'XFA form': 'XFA form, needed to show the form', 'Image metadata': 'images whose metadata the image cleaner could not remove' };
  const kept = [...keptCounts].map(([kind, n]) => `${n} ${why[kind] ?? kind}`);
  return { data, removed, kept, allowed };
}

function planDrops(doc, options) {
  const drop = new Set(); let signed = false;
  for (const p of doc.pages()) {
    const annots = doc.resolve(p.dict.get('Annots'));
    if (!Array.isArray(annots)) continue;
    for (const a of annots) {
      if (!(a instanceof Ref)) continue;
      const d = doc.resolve(a);
      if (removedAnnotation(d) || (options.removeSignatures && d instanceof Dict && fieldType(doc, d) === 'Sig')) drop.add(a.num);
    }
  }
  const form = doc.dict(doc.catalog().get('AcroForm'));
  const fields = doc.resolve(form?.get('Fields'));
  const seen = new Set();
  const visit = (ref, depth) => {
    if (depth > 32 || seen.size > 20000) return;
    if (ref instanceof Ref) { if (seen.has(ref.num)) return; seen.add(ref.num); }
    const d = doc.resolve(ref);
    if (!(d instanceof Dict)) return;
    if (fieldType(doc, d) === 'Sig') {
      if (doc.dict(d.get('V'))) signed = true;
      if (options.removeSignatures && ref instanceof Ref) drop.add(ref.num);
    }
    const kids = doc.resolve(d.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) visit(k, depth + 1);
  };
  if (Array.isArray(fields)) for (const f of fields) visit(f, 0);
  return { drop, signed, hybrid: Array.isArray(fields) && fields.length > 0 };
}
