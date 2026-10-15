// Office Open XML: DOCX, XLSX and PPTX with their macro-enabled, template and show variants.
import { parseXml, rootOf, elements, all, get, text, attrLocal, attrValue } from './xml.js';
import { openPackage, planPackage, sanitizePart, partFamily, mayNeedRewrite, mainPart, contentType, guessFormat, isPicturePart, MAIN_TYPES, familyOf, NS } from './opc.js';
import { budget, entryBlock, rewriteBlock, flag, flagUsers, sample, printerName, usersInBinary, readPart, failure, TOO_LARGE } from './package.js';

// Decided from [Content_Types].xml and the package relationships alone.
export async function ooxmlFormat(zip) {
  try {
    const pkg = await openPackage(zip, budget(16 * 1024 * 1024), { rootOnly: true });
    const main = mainPart(pkg);
    const format = main ? MAIN_TYPES[contentType(pkg, main)] : null;
    return format ?? (pkg.incomplete.length ? guessFormat(pkg) : null);
  } catch { return null; }
}

const CORE = {
  creator: ['Author', 'People'], lastModifiedBy: ['Last modified by', 'People'],
  title: ['Title', 'Document'], subject: ['Subject', 'Document'], keywords: ['Keywords', 'Document'], description: ['Description', 'Document'],
  category: ['Category', 'Document'], contentStatus: ['Status', 'Document'], identifier: ['Identifier', 'Document'], language: ['Language', 'Document'],
  revision: ['Revision', 'Document'], version: ['Version', 'Document'],
  created: ['Created', 'Dates'], modified: ['Modified', 'Dates'], lastPrinted: ['Last printed', 'Dates'],
};
const APP = {
  Application: ['Application', 'Software'], AppVersion: ['Application version', 'Software'], Template: ['Template', 'Software'],
  Company: ['Company', 'People'], Manager: ['Manager', 'People'], TotalTime: ['Total editing time', 'Dates'],
};
const PERSON_ATTRS = { author: 'Comment author', displayName: 'Person', userId: 'User ID', initials: 'Initials', name: 'Person', userName: 'User name' };
const STORY = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|glossary\/document)\.xml$/;

// Returns the embedded picture entries the image inspector should look at.
export async function parseOoxml(zip, r, id) {
  const pkg = await openPackage(zip);
  const plan = await planPackage(pkg, { removeMacros: true, acceptChanges: true });
  for (const { part, reason } of pkg.incomplete) r.markIncomplete(part, reason);
  const gap = (e, reason) => r.markIncomplete(e.name, reason);
  const family = familyOf(id.format);
  const main = mainPart(pkg);
  r.field('Document', 'Format', id.format);
  if (main) r.field('Document', 'Main part', pkg.entries.get(main).name);
  const relsOf = (part) => pkg.rels.get(part) ?? [];
  const relKind = new Map();
  for (const list of pkg.rels.values()) for (const rel of list) if (rel.part && !relKind.has(rel.part)) relKind.set(rel.part, rel.kind);

  // Parts the cleaner drops, with what they reveal.
  const unused = [];
  for (const [lower, kind] of plan.remove) {
    const e = pkg.entries.get(lower);
    if (!e || /(^|\/)_rels\//.test(lower) || kind === 'System leftovers') continue;
    if (plan.macros.has(lower) || plan.revisions.has(lower)) continue;
    entryBlock(r, kind, e);
    try { await describeDropped(r, pkg, e, kind, unused); }
    catch (error) { gap(e, failure(error)); }
  }
  if (unused.length) r.field('Package', 'Unused parts', unused.slice(0, 50).join(', '));
  for (const lower of plan.macros) {
    const e = pkg.entries.get(lower); if (!e) continue;
    entryBlock(r, 'Macros', e, { note: 'Removed only when macro removal is chosen. Removing macros changes what the document does.' });
    if (/vba/i.test(lower)) flag(r, 'macros', `${e.name} holds Visual Basic macros, code that can run when the document is opened.`, 'Package');
  }
  for (const lower of plan.revisions) {
    const e = pkg.entries.get(lower); if (!e) continue;
    entryBlock(r, 'Tracked changes', e, { note: 'Shared workbook change history' });
    let t = null;
    try { t = await pkg.read(lower); if (t === null) gap(e, TOO_LARGE); } catch (error) { gap(e, failure(error)); }
    const names = t ? [...t.matchAll(/\b(?:userName|name)="([^"]+)"/g)].map((m) => m[1]) : [];
    for (const n of new Set(names)) r.add('People', 'Change author', n);
    flag(r, 'tracked', `The workbook keeps a change history${names.length ? ` with the names ${[...new Set(names)].slice(0, 3).join(', ')}` : ''}.`, e.name);
  }

  for (const lower of plan.keptXml) {
    const e = pkg.entries.get(lower);
    entryBlock(r, 'Data connection', e, { removable: false, note: 'Power Query definitions, needed to refresh the data' });
    flag(r, 'connection', 'Power Query definitions name the files, servers or web addresses the data comes from.', e.name);
  }

  // Links that point outside the package.
  for (const { rel, where } of plan.external) {
    const relsEntry = pkg.entries.get(rel.relsName);
    if (rel.kind === 'hyperlink') {
      r.field('Links', 'Hyperlink', rel.target);
      if (where === 'path') flagUsers(r, [rel.target], 'Links');
      continue;
    }
    const label = rel.kind === 'attachedTemplate' ? 'Attached template' : `Linked ${rel.kind}`;
    if (rel.kind === 'attachedTemplate') r.add('Software', 'Template', rel.target);
    if (where === 'remote') {
      r.field('Remote resources', label, rel.target, { flag: 'privacy' });
      rewriteBlock(r, 'Remote resource', relsEntry, rel.target.length, { note: label });
      flag(r, 'remote', `${label} at ${rel.target}. Opening the file can contact that address, which tells its owner when and where the file was opened.`, 'Relationships');
    } else if (where === 'path') {
      r.field('Linked files', label, rel.target);
      rewriteBlock(r, 'File path', relsEntry, rel.target.length, { note: label });
      flagUsers(r, [rel.target], 'Relationships');
    } else if (where === 'local') r.field('Linked files', label, rel.target);
  }

  // Every XML part: what the cleaner would rewrite, plus content kept on purpose.
  const hidden = { runs: 0, text: [], sheets: [], rows: 0, cols: 0, slides: 0 };
  const media = [];
  for (const [lower, e] of pkg.entries) {
    if (plan.remove.has(lower)) continue;
    const kind = relKind.get(lower);
    if (isPicturePart(pkg, lower)) { media.push(e); continue; }
    if (/(^|\/)media\//.test(lower)) continue;
    if (kind === 'oleObject' || kind === 'package') await describeEmbedded(r, pkg, e);
    else if (kind === 'font') entryBlock(r, 'Embedded font', e, { removable: false, note: 'Needed to display the document' });
    else if (kind === 'control' || kind === 'activeXControlBinary') entryBlock(r, 'Active content', e, { removable: false, note: 'ActiveX control' });
    else if (kind === 'xlMacrosheet' || kind === 'xlIntlMacrosheet') { entryBlock(r, 'Macros', e, { removable: false, note: 'Excel 4.0 macro sheet' }); flag(r, 'macros', `${e.name} is an Excel 4.0 macro sheet, code that can run when the workbook is opened.`, 'Package'); }
    const fam = partFamily(pkg, lower, id.format);
    if (!fam) continue;
    let t;
    try { t = await pkg.read(lower); } catch (error) { gap(e, failure(error)); continue; }
    if (t === null) { gap(e, TOO_LARGE); continue; }
    const hasIds = plan.removedIds.has(lower);
    const needed = mayNeedRewrite(t, fam, hasIds, plan, lower);
    const detect = (fam === 'word' && STORY.test(lower)) || (fam === 'xl' && /^xl\/(workbook|connections|pivotcache\/pivotcachedefinition\d*)\.xml$/.test(lower)) || (fam === 'ppt' && /^ppt\/notesslides\//.test(lower)) || fam === 'core' || fam === 'app';
    if (fam === 'xl' && /^xl\/worksheets\//.test(lower)) {
      hidden.rows += (t.match(/<(?:\w+:)?row\b[^>]*\shidden="(?:1|true)"/g) ?? []).length;
      hidden.cols += (t.match(/<(?:\w+:)?col\b[^>]*\shidden="(?:1|true)"/g) ?? []).length;
    }
    if (fam === 'ppt' && /^ppt\/slides\/slide\d+\.xml$/.test(lower) && /<p:sld\b[^>]*\sshow="(?:0|false)"/.test(t)) hidden.slides++;
    if (!needed && !detect) continue;
    let doc;
    try { doc = parseXml(t); } catch (error) { gap(e, failure(error)); continue; }
    try {
      if (fam === 'core') describeCore(r, doc);
      else if (fam === 'app') describeApp(r, doc);
      else if (fam === 'word' && STORY.test(lower)) describeHidden(doc, hidden);
      else if (lower === 'xl/workbook.xml') for (const sh of all(doc, (x) => NS.S.has(x.ns) && x.local === 'sheet' && /hidden/i.test(get(x, 'state') ?? ''))) hidden.sheets.push(`${get(sh, 'name')} (${get(sh, 'state') === 'veryHidden' ? 'very hidden' : 'hidden'})`);
      else if (lower === 'xl/connections.xml') describeConnections(r, doc, e);
      else if (/pivotcachedefinition/.test(lower)) describePivot(r, doc, e);
      else if (/^ppt\/notesslides\//.test(lower)) {
        const notes = all(doc, (x) => x.local === 't').map(text).join(' ').trim();
        if (notes && !/^\d+$/.test(notes)) { r.field('Speaker notes', e.name, sample(notes)); entryBlock(r, 'Speaker notes', e, { removable: false, note: 'Part of the presentation; remove notes in your editor' }); flag(r, 'notes', 'The presentation has speaker notes, which the audience does not see but anyone with the file can read.', e.name); }
      }
    } catch (error) { gap(e, failure(error)); }
    if (!needed) continue;
    const s = sanitizePart(doc, { name: lower, family: fam }, plan);
    report(r, s, e);
  }
  reportHidden(r, hidden, pkg, family);
  return media;
}

function report(r, s, e) {
  if (s.properties) rewriteBlock(r, 'Properties', e, 200, { note: 'Rewritten without personal fields' });
  if (s.fingerprints) {
    rewriteBlock(r, 'Editing fingerprints', e, s.fingerprintBytes, { note: `${s.fingerprints} editing session or document IDs` });
    r.field('Editing fingerprints', e.name, `${s.fingerprints} session or document IDs`);
    flag(r, 'fingerprints', 'Revision-session and document IDs are stored. They can link this file to other documents edited on the same computer.', e.name);
  }
  for (const v of s.ids.filter(Boolean)) r.field('Editing fingerprints', 'Document ID', v);
  if (s.software) r.add('Software', 'Excel build', s.software);
  if (s.tracked) {
    rewriteBlock(r, 'Tracked changes', e, s.tracked * 60, { note: `${s.tracked} tracked changes` });
    r.field('Tracked changes', e.name, `${s.tracked} changes`);
    for (const a of s.trackedAuthors) r.add('People', 'Change author', a);
    const dates = s.trackedDates.slice().sort();
    if (dates.length) { r.add('Dates', 'First tracked change', dates[0]); r.add('Dates', 'Last tracked change', dates.at(-1)); }
    flag(r, 'tracked', `${s.tracked} tracked change${s.tracked === 1 ? '' : 's'}${s.trackedAuthors.size ? ` by ${[...s.trackedAuthors].slice(0, 3).join(', ')}` : ''}, including deleted text, are stored in the file.`, e.name);
  }
  if (s.comments) rewriteBlock(r, 'Comments', e, s.comments * 40, { note: 'Comment anchors' });
  if (s.docVars.length) {
    rewriteBlock(r, 'Document variables', e, s.docVars.reduce((n, [k, v]) => n + k.length + v.length + 40, 0));
    for (const [k, v] of s.docVars) r.field('Document variables', k, v);
    flag(r, 'docvars', `${s.docVars.length} document variable${s.docVars.length === 1 ? '' : 's'} hold values that are never shown on the page.`, e.name);
  }
  if (s.fields.length) {
    rewriteBlock(r, 'Remote resource', e, s.fields.join('').length, { note: 'Fields that fetch content' });
    for (const f of s.fields) r.field('Fields', 'Updating field', f);
    const dde = s.fields.some((f) => /^DDE/i.test(f));
    flag(r, 'remote', `${s.fields.length} field${s.fields.length === 1 ? '' : 's'} (${[...new Set(s.fields.map((f) => f.split(/\s/)[0].toUpperCase()))].join(', ')}) fetch content${dde ? ' or run a program' : ''} when the document is opened or updated.`, e.name);
    flagUsers(r, s.fields, e.name);
  }
  for (const l of s.links) if (l) r.field('Links', 'Hyperlink field', l);
  if (s.paths.length) {
    rewriteBlock(r, 'File path', e, s.paths.join('').length, { note: s.mailMerge ? 'Mail merge data source' : 'Where the file was saved' });
    for (const p of s.paths) r.field('File paths', s.mailMerge ? 'Mail merge source' : 'Saved at', p, { flag: 'privacy' });
    flagUsers(r, s.paths, e.name);
  }
  if (s.people.length) {
    rewriteBlock(r, 'People', e, s.people.join('').length + 10);
    for (const p of s.people) r.add('People', /^S::|@/.test(p) ? 'User ID' : 'Editor', p);
  }
  if (s.refresh) {
    rewriteBlock(r, 'Remote resource', e, s.refresh * 20, { note: 'Data connections refreshed on open' });
    flag(r, 'remote', 'Data connections refresh when the workbook opens, which contacts the data source.', e.name);
  }
}

function describeCore(r, doc) {
  for (const el of elements(rootOf(doc))) {
    const value = text(el).trim(); const map = CORE[el.local];
    if (!value) continue;
    r.field('Core properties', map?.[0] ?? el.local, value);
    if (map) r.add(map[1], map[0], value);
  }
}

function describeApp(r, doc) {
  for (const el of elements(rootOf(doc))) {
    if (el.local === 'HeadingPairs') continue;
    if (el.local === 'TitlesOfParts') { const parts = all(el, (x) => x.local === 'lpstr').map(text); if (parts.length) r.field('App properties', 'Titles of parts', sample(parts.join(', '), 600)); continue; }
    const value = text(el).trim(); if (!value) continue;
    const map = APP[el.local];
    r.field('App properties', map?.[0] ?? el.local, el.local === 'TotalTime' ? `${value} min` : value);
    if (map) r.add(map[1], map[0], el.local === 'TotalTime' ? `${value} min` : value);
    if (el.local === 'Template' || el.local === 'HyperlinkBase') flagUsers(r, [value], 'App properties');
  }
}

function describePeople(r, doc, label) {
  const names = new Set(); let comments = 0;
  for (const el of all(doc, () => true)) {
    for (const a of el.attrs) {
      const key = PERSON_ATTRS[attrLocal(a)];
      if (key && !a.name.startsWith('xmlns')) { const v = attrValue(a).trim(); if (v && !/^\{?[0-9a-f-]{8,}\}?$/i.test(v)) { r.add('People', key === 'Person' && label === 'Comments' ? 'Comment author' : key, v); if (key !== 'Initials' && key !== 'User ID') names.add(v); } }
    }
    if (NS.S.has(el.ns) && el.local === 'author') { const v = text(el).trim(); if (v) { r.add('People', 'Comment author', v); names.add(v); } }
    if (/^(comment|cm|threadedComment)$/.test(el.local) && el.parent?.type === 'el') {
      const body = text(el).trim();
      if (body && comments++ < 200) r.field('Comments', get(el, 'author', el.ns) ?? 'Comment', sample(body));
    }
  }
  return { names: [...names], comments };
}

async function describeDropped(r, pkg, e, kind, unused) {
  const lower = e.name.toLowerCase();
  const read = async () => { const t = await pkg.read(lower); if (t === null) r.markIncomplete(e.name, TOO_LARGE); return t; };
  const xml = async () => { const t = await read(); return t === null ? null : parseXml(t); };
  if (kind === 'Thumbnail') flag(r, 'thumbnail', `${e.name} is a small picture of the first page, which can show content later removed.`, 'Package');
  else if (kind === 'Custom properties') {
    const doc = await xml(); if (!doc) return;
    let n = 0;
    for (const p of elements(rootOf(doc))) { const v = text(p).trim(); const name = get(p, 'name') ?? 'Property'; r.field('Custom properties', name, v); n++; if (/author|owner|manager|editor|user|person|e-?mail/i.test(name) && v) r.add('People', name, v); }
    if (n) flag(r, 'custom', `${n} custom propert${n === 1 ? 'y is' : 'ies are'} stored, often added by document management systems.`, e.name);
  } else if (kind === 'Comments' || kind === 'People') {
    if (!/\.xml$/i.test(lower)) return;
    const doc = await xml(); if (!doc) return;
    const { names, comments } = describePeople(r, doc, kind);
    if (kind === 'Comments' && (comments || names.length)) flag(r, 'comments', `Comments${names.length ? ` by ${names.slice(0, 3).join(', ')}` : ''} are stored in the file.`, e.name);
  } else if (kind === 'Printer settings') {
    const data = await readPart(pkg.zip, e, pkg.b, 1024 * 1024);
    const name = data && printerName(data);
    if (name) { r.field('Printer settings', 'Printer', name); flag(r, 'printer', `The printer "${name}" is recorded.`, e.name); }
  } else if (kind === 'Custom XML') {
    const t = await read(); if (!t || /itemProps/i.test(lower)) return;
    const visible = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (visible) r.field('Custom XML', e.name, sample(visible));
    for (const m of t.matchAll(/<(?:\w+:)?DisplayName>([^<]+)</g)) r.add('People', 'Person', m[1]);
  } else if (kind === 'Digital signature') {
    const t = /\.xml$/i.test(lower) ? await read() : null;
    for (const m of (t ?? '').matchAll(/<(?:\w+:)?X509SubjectName>([^<]+)</g)) { r.add('People', 'Signed by', m[1]); flag(r, 'signature', `The digital signature names ${m[1]}. Cleaning removes the signature, which would no longer be valid.`, e.name); }
  } else if (kind === 'Sensitivity label') {
    const t = await read();
    for (const m of (t ?? '').matchAll(/\b(id|siteId)="([^"]+)"/g)) r.field('Sensitivity label', m[1] === 'siteId' ? 'Organization ID' : 'Label ID', m[2]);
  } else if (kind === 'Editing history') {
    const t = await read();
    const n = (t?.match(/<(?:\w+:)?(client|chgData|docChg)\b/g) ?? []).length;
    r.field('Editing history', e.name, `${n} records`);
    flag(r, 'fingerprints', 'Editing history records client IDs and dates of past edits.', e.name);
  } else if (kind === 'Add-ins') r.field('Add-ins', e.name, 'Add-in settings');
  else if (kind === 'Unused part') unused.push(e.name);
}

async function describeEmbedded(r, pkg, e) {
  entryBlock(r, 'Embedded object', e, { removable: false, note: 'Part of the document content' });
  r.field('Embedded files', e.name, `${e.size.toLocaleString('en-US')} bytes`);
  flag(r, 'embedded', 'The document contains embedded files, which keep their own content and metadata.', 'Package');
  if (/\.bin$/i.test(e.name)) {
    const data = await readPart(pkg.zip, e, pkg.b, 8 * 1024 * 1024).catch(() => null);
    const users = data ? usersInBinary(data) : [];
    if (users.length) flag(r, 'users', `${e.name} records a path with the user name ${users.slice(0, 3).join(', ')}.`, e.name);
  }
}

function describeHidden(doc, hidden) {
  for (const v of all(doc, (x) => NS.W.has(x.ns) && x.local === 'vanish' && x.parent?.local === 'rPr' && x.parent.parent?.local === 'r')) {
    const val = get(v, 'val', v.ns);
    if (val === '0' || val === 'false' || val === 'off') continue;
    hidden.runs++;
    const t = text(v.parent.parent);
    if (t && hidden.text.join('').length < 600) hidden.text.push(t);
  }
}

function describeConnections(r, doc, e) {
  let n = 0;
  for (const c of all(doc, (x) => NS.S.has(x.ns) && x.local === 'connection')) {
    n++;
    const name = get(c, 'name') ?? 'Connection';
    const details = all(c, (x) => NS.S.has(x.ns) && /^(dbPr|olapPr|webPr|textPr)$/.test(x.local)).map((x) => get(x, 'connection') ?? get(x, 'url') ?? get(x, 'sourceFile') ?? '').filter(Boolean);
    for (const d of details) r.field('Data connections', name, d, { flag: 'privacy' });
    const file = get(c, 'odcFile'); if (file) r.field('Data connections', `${name} file`, file);
    flagUsers(r, [...details, file ?? ''], e.name);
  }
  if (n) {
    entryBlock(r, 'Data connection', e, { removable: false, note: 'Needed to refresh the data' });
    flag(r, 'connection', `${n} data connection${n === 1 ? '' : 's'} name servers, files or accounts the data comes from.`, e.name);
  }
}

function describePivot(r, doc, e) {
  const src = all(doc, (x) => NS.S.has(x.ns) && x.local === 'worksheetSource')[0];
  const root = rootOf(doc);
  if (src) r.field('Pivot caches', e.name, [get(src, 'sheet'), get(src, 'ref'), get(src, 'name')].filter(Boolean).join(' '));
  const records = get(root, 'recordCount');
  if (records) r.field('Pivot caches', `${e.name} records`, records);
  entryBlock(r, 'Pivot cache', e, { removable: false, note: 'A saved copy of the source data, needed by the pivot table' });
}

function reportHidden(r, h, pkg, family) {
  const parts = [];
  if (h.runs) { parts.push(`${h.runs} hidden text run${h.runs === 1 ? '' : 's'}`); r.field('Hidden content', 'Hidden text', sample(h.text.join(' ') || '(formatting only)')); }
  if (h.sheets.length) { parts.push(`hidden sheets ${h.sheets.join(', ')}`); r.field('Hidden content', 'Hidden sheets', h.sheets.join(', ')); }
  if (h.rows) { parts.push(`${h.rows} hidden rows`); r.field('Hidden content', 'Hidden rows', String(h.rows)); }
  if (h.cols) { parts.push(`${h.cols} hidden column ranges`); r.field('Hidden content', 'Hidden columns', String(h.cols)); }
  if (h.slides) { parts.push(`${h.slides} hidden slide${h.slides === 1 ? '' : 's'}`); r.field('Hidden content', 'Hidden slides', String(h.slides)); }
  if (!parts.length) return;
  const main = pkg.entries.get(mainPart(pkg) ?? '') ?? pkg.zip.entries[0];
  entryBlock(r, 'Hidden content', main, { removable: false, note: 'Part of the document; reveal and delete it in your editor' });
  flag(r, 'hidden', `The ${family === 'xl' ? 'workbook' : family === 'ppt' ? 'presentation' : 'document'} has content that is not shown: ${parts.join(', ')}.`, 'Document');
}
