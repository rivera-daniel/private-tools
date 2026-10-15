// Office Open XML packages: the part and relationship model, the removal plan and the in-part rewrites.
// The inspector and the cleaner both run these, so what the inspector reports is exactly what the
// cleaner removes, and a cleaned file inspects as clean.
import { parseXml, rootOf, serialize, all, walk, elements, get, set, dropAttrs, attrNs, attrLocal, attrValue, remove, unwrap, clear, text, is, kids } from './xml.js';
import { DOC_LIMITS, budget, readPart, targetKind, bareName, isLeftover, usersIn } from './package.js';
import { utf8 } from '../bytes.js';

export const NS = {
  R: new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']),
  W: new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']),
  S: new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main']),
  P: new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main']),
  W14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  W15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  MC: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  X15AC: 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac',
  O: 'urn:schemas-microsoft-com:office:office',
  V: 'urn:schemas-microsoft-com:vml',
  X: 'urn:schemas-microsoft-com:office:excel',
  CP: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  DC: 'http://purl.org/dc/elements/1.1/',
  DCTERMS: 'http://purl.org/dc/terms/',
  EP: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  CUSTOM: 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  RELS: 'http://schemas.openxmlformats.org/package/2006/relationships',
  TYPES: 'http://schemas.openxmlformats.org/package/2006/content-types',
  BIB: 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography',
};
const XR = /spreadsheetml\/20\d\d\/revision\d*$/;
const isW = (el) => el.type === 'el' && NS.W.has(el.ns);

export const MAIN_TYPES = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml': 'DOCX',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml': 'DOTX',
  'application/vnd.ms-word.document.macroEnabled.main+xml': 'DOCM',
  'application/vnd.ms-word.template.macroEnabledTemplate.main+xml': 'DOTM',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml': 'XLSX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml': 'XLTX',
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml': 'XLSM',
  'application/vnd.ms-excel.template.macroEnabled.main+xml': 'XLTM',
  'application/vnd.ms-excel.sheet.binary.macroEnabled.main': 'XLSB',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml': 'PPTX',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml': 'PPSX',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml': 'POTX',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml': 'PPTM',
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml': 'PPSM',
  'application/vnd.ms-powerpoint.template.macroEnabled.main+xml': 'POTM',
  'application/vnd.ms-visio.drawing.main+xml': 'VSDX',
};
export const familyOf = (format) => (/^D/.test(format) ? 'word' : /^X/.test(format) ? 'xl' : /^P/.test(format) ? 'ppt' : 'other');

// Relationship types (last segment of the type URI) whose target part the cleaner drops, with the
// block kind it is reported as.
const DROP = {
  thumbnail: 'Thumbnail', 'custom-properties': 'Custom properties',
  comments: 'Comments', commentsExtended: 'Comments', commentsIds: 'Comments', commentsExtensible: 'Comments',
  threadedComment: 'Comments', commentAuthors: 'Comments', documentTasks: 'Comments',
  people: 'People', person: 'People', authors: 'People',
  printerSettings: 'Printer settings',
  revisionInfo: 'Editing history', changesInfo: 'Editing history',
  classificationlabels: 'Sensitivity label',
  origin: 'Digital signature',
  webextension: 'Add-ins', webextensiontaskpanes: 'Add-ins',
};
const MACROS = new Set(['vbaProject', 'wordVbaData', 'keyMapCustomizations', 'extensibility']);
const REVISIONS = new Set(['revisionHeaders', 'usernames']);
const LINK_TYPES = new Set(['hyperlink']);
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'media']);
// References to removed relationships: on these elements only the attribute goes, everything else is removed.
const ATTR_ONLY = new Set(['pageSetup', 'blip', 'imagedata', 'fill', 'stroke']);

export const relType = (type) => String(type).split('/').pop();
export const relsPathFor = (part) => { const k = part.lastIndexOf('/'); return `${part.slice(0, k + 1)}_rels/${part.slice(k + 1)}.rels`; };
export function sourceOfRels(relsName) {
  const m = /^(.*?)_rels\/([^/]*)\.rels$/i.exec(relsName);
  return m ? m[1] + m[2] : null;
}

export function resolveTarget(source, target) {
  let t = String(target);
  try { t = decodeURIComponent(t); } catch { /* keep as written */ }
  t = t.split('#')[0];
  if (!t) return null;
  const path = t.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const seg of t.replace(/^\/+/, '').split('/')) { if (seg === '..') path.pop(); else if (seg && seg !== '.') path.push(seg); }
  return path.join('/');
}

// Reads [Content_Types].xml and every relationship part. Parts are looked up case-insensitively, as OPC
// requires. pkg.read(part) returns a part's text within the per-file budget, or null when it is over the limits.
export async function openPackage(zip, b = budget(DOC_LIMITS.maxReadBytes)) {
  const pkg = { zip, b, entries: new Map(), texts: new Map(), rels: new Map(), relsDocs: new Map(), relByEl: new Map(), defaults: new Map(), overrides: new Map(), errors: [], tooLarge: [] };
  for (const e of zip.entries) if (!e.directory) pkg.entries.set(e.name.toLowerCase(), e);
  pkg.read = async (lower, limit = DOC_LIMITS.maxPartBytes) => {
    if (pkg.texts.has(lower)) return pkg.texts.get(lower);
    const e = pkg.entries.get(lower);
    if (!e) return null;
    const data = await readPart(zip, e, b, limit);
    if (!data) { pkg.tooLarge.push(e.name); return null; }
    const t = utf8.decode(data);
    pkg.texts.set(lower, t);
    return t;
  };
  const typesText = await pkg.read('[content_types].xml', 4 * 1024 * 1024);
  if (typesText) {
    pkg.typesDoc = parseXml(typesText);
    for (const el of elements(rootOf(pkg.typesDoc))) {
      if (el.local === 'Default') pkg.defaults.set(String(get(el, 'Extension') ?? '').toLowerCase(), get(el, 'ContentType') ?? '');
      else if (el.local === 'Override') pkg.overrides.set(String(get(el, 'PartName') ?? '').replace(/^\//, '').toLowerCase(), get(el, 'ContentType') ?? '');
    }
  }
  for (const [lower, e] of pkg.entries) {
    if (!/(^|\/)_rels\/[^/]*\.rels$/.test(lower)) continue;
    const source = sourceOfRels(e.name);
    let doc;
    try { const t = await pkg.read(lower, 8 * 1024 * 1024); if (!t) continue; doc = parseXml(t); }
    catch (error) { pkg.errors.push(`${e.name}: ${error.message}`); continue; }
    pkg.relsDocs.set(lower, doc);
    const list = [];
    for (const el of elements(rootOf(doc))) {
      if (el.local !== 'Relationship') continue;
      const rel = { id: get(el, 'Id') ?? '', type: get(el, 'Type') ?? '', target: get(el, 'Target') ?? '', external: /^external$/i.test(get(el, 'TargetMode') ?? ''), el, relsName: lower, source: source.toLowerCase() };
      rel.kind = relType(rel.type);
      if (!rel.external) rel.part = resolveTarget(source, rel.target)?.toLowerCase() ?? null;
      list.push(rel); pkg.relByEl.set(el, rel);
    }
    pkg.rels.set(source.toLowerCase(), list);
  }
  return pkg;
}

export const contentType = (pkg, lower) => pkg.overrides.get(lower) ?? pkg.defaults.get(lower.split('.').pop()) ?? '';

export function mainPart(pkg) {
  const rel = (pkg.rels.get('') ?? []).find((r) => r.kind === 'officeDocument' && !r.external && r.part && pkg.entries.has(r.part));
  return rel ? rel.part : null;
}

// What the cleaner does to the package. options: { removeMacros, acceptChanges }.
// remove: Map(part -> kind). dropRels: Set(rel). retarget: Map(rel -> new target). removedIds: Map(source part -> Set(id)).
export async function planPackage(pkg, options = {}) {
  const remove = new Map(); const dropRels = new Set(); const retarget = new Map(); const external = [];
  const macros = []; const revisions = []; const vmlNotes = new Set();
  let customXmlRemoved = false;
  for (const [, list] of pkg.rels) {
    for (const rel of list) {
      if (rel.external) {
        const where = targetKind(rel.target);
        external.push({ rel, where });
        if (LINK_TYPES.has(rel.kind) || where === 'local' || where === 'mail') continue;
        if (rel.kind === 'attachedTemplate' || MEDIA_TYPES.has(rel.kind)) dropRels.add(rel);
        else retarget.set(rel, bareName(rel.target));
        continue;
      }
      if (!rel.part || !pkg.entries.has(rel.part)) continue;
      let kind = DROP[rel.kind];
      if (rel.kind === 'customXml') {
        let root = null;
        try { const t = await pkg.read(rel.part); root = t && rootOf(parseXml(t)); } catch { /* unreadable custom XML is dropped */ }
        if (!(root && root.local === 'Sources' && root.ns === NS.BIB)) { kind = 'Custom XML'; customXmlRemoved = true; }
      }
      if (MACROS.has(rel.kind)) { macros.push(rel.part); if (options.removeMacros) kind = 'Macros'; }
      if (REVISIONS.has(rel.kind)) { revisions.push(rel.part); if (options.acceptChanges) kind = 'Tracked changes'; }
      if (kind && !remove.has(rel.part)) remove.set(rel.part, kind);
    }
  }
  // Legacy comment shapes in spreadsheets: a drawing holding only comment boxes goes with the comments.
  for (const [, list] of pkg.rels) {
    if (!list.some((r) => r.kind === 'comments' && remove.has(r.part))) continue;
    for (const rel of list.filter((r) => r.kind === 'vmlDrawing' && r.part && pkg.entries.has(r.part))) {
      try {
        const t = await pkg.read(rel.part);
        const doc = parseXml(t ?? '');
        const shapes = all(doc, (x) => x.ns === NS.V && x.local === 'shape');
        const notes = shapes.filter(isNoteShape);
        if (notes.length && notes.length === shapes.length) remove.set(rel.part, 'Comments');
        else if (notes.length) vmlNotes.add(rel.part);
      } catch { /* left as is; the check afterwards decides */ }
    }
  }
  // Parts no relationship reaches any more are dropped too. Their kind follows the part that referenced them.
  const reach = (skip) => {
    const seen = new Set(); const queue = [''];
    while (queue.length) {
      const src = queue.shift();
      for (const rel of pkg.rels.get(src) ?? []) {
        if (rel.external || !rel.part || seen.has(rel.part) || (skip && (remove.has(rel.part) || dropRels.has(rel)))) continue;
        if (!pkg.entries.has(rel.part)) continue;
        seen.add(rel.part); queue.push(rel.part);
      }
    }
    return seen;
  };
  const after = reach(true);
  const orphans = [];
  for (const [lower, e] of pkg.entries) {
    if (lower === '[content_types].xml' || /(^|\/)_rels\/[^/]*\.rels$/.test(lower) || remove.has(lower) || after.has(lower)) continue;
    if (isLeftover(e.name)) remove.set(lower, 'System leftovers'); else orphans.push(lower);
  }
  // A part only a dropped part referenced is reported under that part's kind.
  for (let changed = true; changed;) {
    changed = false;
    for (const lower of orphans) {
      if (remove.has(lower)) continue;
      for (const [src, list] of pkg.rels) if (remove.has(src) && list.some((r) => r.part === lower)) { remove.set(lower, remove.get(src)); changed = true; break; }
    }
  }
  for (const lower of orphans) if (!remove.has(lower)) remove.set(lower, 'Unused part');
  for (const [lower] of pkg.relsDocs) {
    const source = sourceOfRels(lower);
    if (source === '') continue;
    if (!pkg.entries.has(source)) remove.set(lower, 'Unused part');
    else if (remove.has(source)) remove.set(lower, remove.get(source));
  }
  const removedIds = new Map();
  for (const [source, list] of pkg.rels) {
    for (const rel of list) {
      if (dropRels.has(rel) || (!rel.external && rel.part && remove.has(rel.part))) {
        dropRels.add(rel);
        if (!removedIds.has(source)) removedIds.set(source, new Set());
        removedIds.get(source).add(rel.id);
      }
    }
  }
  return { remove, dropRels, retarget, removedIds, external, macros, revisions, vmlNotes, customXmlRemoved, options };
}

export function isNoteShape(shape) {
  return all(shape, (x) => x.ns === NS.X && x.local === 'ClientData').some((c) => get(c, 'ObjectType') === 'Note');
}

// Applies the plan's relationship edits to a parsed .rels document.
export function rewriteRels(doc, pkg, plan) {
  let changed = false;
  for (const el of elements(rootOf(doc))) {
    const rel = pkg.relByEl.get(el);
    if (!rel) continue;
    if (plan.dropRels.has(rel)) { remove(el); changed = true; }
    else if (plan.retarget.has(rel)) { set(el, 'Target', '', plan.retarget.get(rel)); changed = true; }
  }
  return changed;
}

// Fields whose result Word refreshes from elsewhere when the document opens or prints.
export const AUTO_FIELD = /^\s*(INCLUDEPICTURE|INCLUDETEXT|IMPORT|LINK|DDE|DDEAUTO|RD)\b/i;
export const fieldTarget = (instr) => { const m = /^\s*\S+\s+(?:"([^"]*)"|(\S+))/.exec(instr); return (m?.[1] ?? m?.[2] ?? '').replace(/\\\\/g, '\\'); };

// Rewrites one XML part in place and reports what it found. info: { name, family }, family being
// 'word', 'xl', 'ppt', 'core', 'app' or 'vml'. With acceptChanges false, tracked changes are only counted.
export function sanitizePart(doc, info, plan) {
  const s = { fingerprints: 0, fingerprintBytes: 0, tracked: 0, trackedAuthors: new Set(), trackedDates: [], comments: 0, docVars: [], fields: [], links: [], paths: [], people: [], mailMerge: 0, refresh: 0, ids: [], changed: false };
  const root = rootOf(doc);
  if (!root) return s;
  const removedIds = plan.removedIds.get(info.name) ?? new Set();
  if (info.family === 'core' || info.family === 'app') {
    if (elements(root).length) { s.properties = elements(root).length; clear(root); s.changed = true; }
    return s;
  }
  if (info.family === 'vml' && plan.vmlNotes.has(info.name)) {
    for (const shape of all(root, (x) => x.ns === NS.V && x.local === 'shape' && isNoteShape(x))) { remove(shape); s.changed = true; }
  }
  // References to relationships the plan removes.
  if (removedIds.size) {
    const hits = [];
    walk(root, (el) => {
      for (const a of el.attrs) {
        if ((NS.R.has(attrNs(el, a)) || (attrNs(el, a) === NS.O && attrLocal(a) === 'relid')) && removedIds.has(attrValue(a))) { hits.push([el, a]); }
      }
    });
    for (const [el, a] of hits) {
      if (ATTR_ONLY.has(el.local)) el.attrs = el.attrs.filter((x) => x !== a);
      else removeWithEmptyExt(el);
      s.changed = true;
    }
  }
  if (info.family === 'word') sanitizeWord(root, plan, s);
  else if (info.family === 'xl') sanitizeSheet(root, s);
  return s;
}

function removeWithEmptyExt(el) {
  let parent = el.parent;
  remove(el);
  while (parent && parent.type === 'el' && (parent.local === 'ext' || parent.local === 'extLst' || parent.local === 'AlternateContent' || parent.local === 'Choice') && !elements(parent).length) {
    const up = parent.parent; remove(parent); parent = up;
  }
}

const TRACK_WRAP = new Set(['ins', 'del', 'moveFrom', 'moveTo']);
const TRACK_CHANGE = new Set(['rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'tblGridChange', 'numberingChange', 'tblPrExChange']);
const TRACK_RANGE = new Set(['moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd', 'customXmlInsRangeStart', 'customXmlInsRangeEnd', 'customXmlDelRangeStart', 'customXmlDelRangeEnd', 'customXmlMoveFromRangeStart', 'customXmlMoveFromRangeEnd', 'customXmlMoveToRangeStart', 'customXmlMoveToRangeEnd', 'cellIns', 'cellDel', 'cellMerge']);
const COMMENT_MARK = new Set(['commentRangeStart', 'commentRangeEnd', 'commentReference']);
const SETTINGS_DROP = new Set(['rsids', 'docVars', 'mailMerge']);

function sanitizeWord(root, plan, s) {
  const accept = plan.options.acceptChanges;
  const wraps = []; const markers = []; const drops = []; const rowsDeleted = []; const marksDeleted = []; const strays = [];
  walk(root, (el) => {
    const n = dropAttrs(el, (a) => {
      const ns = attrNs(el, a); const local = attrLocal(a);
      const hit = (NS.W.has(ns) && local.startsWith('rsid')) || (ns === NS.W14 && (local === 'paraId' || local === 'textId'));
      if (hit) s.fingerprintBytes += a.name.length + a.raw.length + 4;
      return hit;
    });
    if (n) { s.fingerprints += n; s.changed = true; }
    if (!isW(el)) {
      if ((el.ns === NS.W14 || el.ns === NS.W15) && el.local === 'docId' && root.local === 'settings') { s.ids.push(get(el, 'val', el.ns)); s.fingerprints++; s.fingerprintBytes += 40; remove(el); s.changed = true; return false; }
      return true;
    }
    const local = el.local;
    if (local === 'permStart') {
      const ed = get(el, 'ed', el.ns);
      if (ed) { s.people.push(ed); dropAttrs(el, (a) => attrLocal(a) === 'ed'); s.changed = true; }
    }
    if (root.local === 'settings' && el.parent === root && SETTINGS_DROP.has(local)) {
      if (local === 'rsids') { s.fingerprints += all(el, () => true).length; s.fingerprintBytes += serialize(el).length; }
      else if (local === 'docVars') for (const v of all(el, (x) => isW(x) && x.local === 'docVar')) s.docVars.push([get(v, 'name', v.ns) ?? '', get(v, 'val', v.ns) ?? '']);
      else { s.mailMerge++; for (const x of all(el, (y) => isW(y) && (y.local === 'connectString' || y.local === 'query'))) s.paths.push(get(x, 'val', x.ns) ?? ''); }
      remove(el); s.changed = true; return false;
    }
    if (COMMENT_MARK.has(local)) { s.comments++; drops.push(el); return false; }
    if (local === 'dataBinding' && plan.customXmlRemoved) { drops.push(el); return false; }
    const parent = el.parent?.local;
    if (TRACK_WRAP.has(local)) {
      s.tracked++; noteChange(el, s);
      if (parent === 'rPr' && el.parent.parent?.local === 'pPr') { if (local === 'del' || local === 'moveFrom') marksDeleted.push(el); else markers.push(el); }
      else if (parent === 'trPr') { if (local === 'del') rowsDeleted.push(el); else markers.push(el); }
      else if (parent === 'rPr' || parent === 'tcPr' || parent === 'numPr') markers.push(el);
      else if (local === 'del' || local === 'moveFrom') { drops.push(el); return false; }
      else wraps.push(el);
      return true;
    }
    if (TRACK_CHANGE.has(local) || TRACK_RANGE.has(local)) { s.tracked++; noteChange(el, s); drops.push(el); return false; }
    if (local === 'delText' || local === 'delInstrText') { strays.push(el); return false; }
    return true;
  });
  // Comment anchors go whatever the tracked-change decision is.
  for (const el of drops.filter((x) => COMMENT_MARK.has(x.local) || x.local === 'dataBinding')) { const run = el.parent; remove(el); if (run?.local === 'r' && !elements(run).some((c) => c.local !== 'rPr')) remove(run); s.changed = true; }
  neutralizeFields(root, s);
  if (!accept) return;
  for (const el of drops.filter((x) => !COMMENT_MARK.has(x.local) && x.local !== 'dataBinding')) remove(el);
  for (const el of strays) remove(el);
  for (const el of rowsDeleted) { const row = el.parent.parent; if (row?.local === 'tr') remove(row); }
  for (const el of marksDeleted) {
    const p = el.parent.parent.parent; remove(el);
    if (p?.local !== 'p' || !p.parent) continue;
    const siblings = elements(p.parent); const next = siblings[siblings.indexOf(p) + 1];
    if (!next || next.local !== 'p' || !isW(next)) continue;
    const moving = p.children.filter((c) => !(c.type === 'el' && c.local === 'pPr'));
    const at = next.children.findIndex((c) => c.type === 'el' && c.local === 'pPr') + 1;
    for (const c of moving) c.parent = next;
    next.children.splice(at, 0, ...moving);
    remove(p);
  }
  for (const el of wraps) unwrap(el);
  for (const el of markers) remove(el);
  if (s.tracked) s.changed = true;
}

function noteChange(el, s) {
  const author = get(el, 'author', el.ns); const date = get(el, 'date', el.ns);
  if (author) s.trackedAuthors.add(author);
  if (date && s.trackedDates.length < 1000) s.trackedDates.push(date);
}

// Turns fields that fetch content (INCLUDEPICTURE, LINK, DDE…) into their last result, so opening the
// document fetches nothing. Clickable HYPERLINK fields are only listed.
function neutralizeFields(root, s) {
  for (const f of all(root, (x) => isW(x) && x.local === 'fldSimple')) {
    const instr = get(f, 'instr', f.ns) ?? '';
    if (AUTO_FIELD.test(instr)) { s.fields.push(instr.trim()); unwrap(f); s.changed = true; }
    else if (/^\s*HYPERLINK\b/i.test(instr)) s.links.push(fieldTarget(instr));
  }
  const stack = [];
  const finish = (f) => {
    if (/^\s*HYPERLINK\b/i.test(f.instr)) { s.links.push(fieldTarget(f.instr)); return; }
    if (!AUTO_FIELD.test(f.instr)) return;
    s.fields.push(f.instr.trim()); s.changed = true;
    for (const run of f.instrRuns) remove(run);
    for (const [run, mark] of [[f.separate, f.sepMark], [f.end, f.endMark]]) {
      if (!run) continue;
      remove(mark);
      if (!elements(run).some((c) => c.local !== 'rPr')) remove(run);
    }
  };
  for (const run of all(root, (x) => isW(x) && x.local === 'r')) {
    for (const c of elements(run)) {
      if (!isW(c)) continue;
      if (c.local === 'fldChar') {
        const type = get(c, 'fldCharType', c.ns);
        if (type === 'begin') stack.push({ instr: '', instrRuns: [run], state: 'instr' });
        else if (type === 'separate' && stack.length && stack.at(-1).state === 'instr') Object.assign(stack.at(-1), { state: 'result', separate: run, sepMark: c });
        else if (type === 'end' && stack.length) { const f = stack.pop(); f.end = run; f.endMark = c; finish(f); }
      } else if (c.local === 'instrText' && stack.length && stack.at(-1).state === 'instr') stack.at(-1).instr += text(c);
    }
    for (const f of stack) if (f.state === 'instr' && f.instrRuns.at(-1) !== run) f.instrRuns.push(run);
  }
}

function sanitizeSheet(root, s) {
  walk(root, (el) => {
    const n = dropAttrs(el, (a) => attrLocal(a) === 'uid' && XR.test(attrNs(el, a)));
    if (n) { s.fingerprints += n; s.fingerprintBytes += n * 50; s.changed = true; }
    if (el.ns === NS.MC && el.local === 'AlternateContent' && all(el, (x) => x.ns === NS.X15AC && x.local === 'absPath').length) {
      for (const p of all(el, (x) => x.ns === NS.X15AC && x.local === 'absPath')) s.paths.push(get(p, 'url') ?? '');
      remove(el); s.changed = true; return false;
    }
    if (XR.test(el.ns) && el.local === 'revisionPtr') { s.ids.push(get(el, 'documentId') ?? ''); s.fingerprints++; s.fingerprintBytes += serialize(el).length; remove(el); s.changed = true; return false; }
    if (NS.S.has(el.ns) && el.local === 'fileVersion' && root.local === 'workbook') { s.software = [get(el, 'appName'), get(el, 'lastEdited'), get(el, 'rupBuild')].filter(Boolean).join(' '); s.fingerprints++; s.fingerprintBytes += serialize(el).length; remove(el); s.changed = true; return false; }
    if (NS.S.has(el.ns) && el.local === 'fileSharing' && get(el, 'userName')) { s.people.push(get(el, 'userName')); dropAttrs(el, (a) => a.name === 'userName'); s.changed = true; }
    if (NS.S.has(el.ns) && el.local === 'connection' && get(el, 'refreshOnLoad')) { s.refresh++; dropAttrs(el, (a) => a.name === 'refreshOnLoad'); s.changed = true; }
    return true;
  });
}

// Which rewrite family an XML part belongs to, or null for parts that are copied unchanged.
export function partFamily(pkg, lower, format) {
  const type = contentType(pkg, lower);
  if (type === 'application/vnd.openxmlformats-package.core-properties+xml') return 'core';
  if (type === 'application/vnd.openxmlformats-officedocument.extended-properties+xml') return 'app';
  if (lower.endsWith('.vml') || type === 'application/vnd.openxmlformats-officedocument.vmlDrawing') return 'vml';
  if (!/xml$/.test(type) && !lower.endsWith('.xml')) return null;
  const fam = familyOf(format);
  if (fam === 'word' && lower.startsWith('word/')) return 'word';
  if (fam === 'xl' && lower.startsWith('xl/')) return 'xl';
  if (fam === 'ppt' && lower.startsWith('ppt/')) return 'ppt';
  return 'other';
}

// Cheap test for whether a part can hold anything sanitizePart changes, so big parts that cannot are
// copied without being parsed.
export function mayNeedRewrite(textValue, family, hasRemovedIds, plan, lower) {
  if (hasRemovedIds || family === 'core' || family === 'app') return true;
  if (family === 'vml') return plan.vmlNotes.has(lower);
  if (family === 'word') return /rsid|paraId|textId|comment(Range|Reference)|<w:(ins|del|moveFrom|moveTo|delText|delInstrText)\b|Change\b|RangeStart|RangeEnd|cell(Ins|Del|Merge)|instrText|fldSimple|dataBinding|permStart|docVars|docId|mailMerge/.test(textValue) || !/^<\?xml[^>]*\?>\s*<w:/.test(textValue);
  if (family === 'xl') return /uid=|absPath|revisionPtr|fileVersion|fileSharing|refreshOnLoad/.test(textValue);
  return false;
}

export { usersIn, serialize, parseXml, rootOf, text, is, kids, get };
