// OpenDocument: ODT, ODS, ODP and ODG with their templates. The rules here are shared with the cleaner.
import { parseXml, rootOf, elements, all, walk, get, text, attrNs, attrLocal, dropAttrs, prune, clear, child } from './xml.js';
import { DOC_LIMITS, budget, readPart, entryBlock, rewriteBlock, flag, flagUsers, sample, targetKind, isLeftover } from './package.js';
import { utf8 } from '../bytes.js';

export const ODF_TYPES = {
  'application/vnd.oasis.opendocument.text': 'ODT', 'application/vnd.oasis.opendocument.text-template': 'OTT',
  'application/vnd.oasis.opendocument.spreadsheet': 'ODS', 'application/vnd.oasis.opendocument.spreadsheet-template': 'OTS',
  'application/vnd.oasis.opendocument.presentation': 'ODP', 'application/vnd.oasis.opendocument.presentation-template': 'OTP',
  'application/vnd.oasis.opendocument.graphics': 'ODG', 'application/vnd.oasis.opendocument.graphics-template': 'OTG',
};

export const ODF = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0', meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  dc: 'http://purl.org/dc/elements/1.1/', text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0', draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0', style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  xlink: 'http://www.w3.org/1999/xlink', config: 'urn:oasis:names:tc:opendocument:xmlns:config:1.0',
  officeooo: 'http://openoffice.org/2009/office', manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
};

const META = {
  generator: ['Application', 'Software'], 'initial-creator': ['Author', 'People'], creator: ['Last modified by', 'People'], 'printed-by': ['Printed by', 'People'],
  'creation-date': ['Created', 'Dates'], date: ['Modified', 'Dates'], 'print-date': ['Last printed', 'Dates'], 'editing-duration': ['Total editing time', 'Dates'],
  'editing-cycles': ['Revision', 'Document'], title: ['Title', 'Document'], subject: ['Subject', 'Document'], description: ['Description', 'Document'],
  keyword: ['Keywords', 'Document'], language: ['Language', 'Document'],
};
// Links a reader follows by clicking. Any other link is fetched by the editor on its own.
const CLICKABLE = new Set(['a', 'event-listener', 'link']);
const PRINTER_ITEMS = new Set(['PrinterName', 'PrinterSetup', 'PrintFaxName', 'PrinterPaperFromSetup']);
const SOURCE_ITEMS = new Set(['CurrentDatabaseDataSource', 'CurrentDatabaseCommand', 'CurrentDatabaseCommandType']);
const RSID_ITEMS = new Set(['Rsid', 'RsidRoot']);
export const hasMacros = (names) => names.some((n) => /^Basic\/[^/]+\/(?!script-lb\.xml$|dialog-lb\.xml$)[^/]+\.xml$/.test(n) || /^Scripts\/.+[^/]$/.test(n));
export const isMacroEntry = (name) => /^(Basic|Scripts|Dialogs)\//.test(name);

// Reads the manifest and decides which entries the cleaner drops. options: { removeMacros, acceptChanges }.
export async function planOdf(zip, b, options = {}) {
  const names = zip.entries.map((e) => e.name);
  const manifestEntry = zip.entries.find((e) => e.name === 'META-INF/manifest.xml');
  let manifest = null; const listed = new Set(); let encrypted = false;
  if (manifestEntry) {
    const data = await readPart(zip, manifestEntry, b, 8 * 1024 * 1024);
    if (data) {
      manifest = parseXml(utf8.decode(data));
      for (const fe of all(manifest, (x) => x.ns === ODF.manifest && x.local === 'file-entry')) {
        listed.add(get(fe, 'full-path', ODF.manifest) ?? '');
        if (all(fe, (x) => x.local === 'encryption-data').length) encrypted = true;
      }
    }
  }
  const macros = new Set(hasMacros(names) ? names.filter((n) => isMacroEntry(n) && !n.endsWith('/')) : []);
  const remove = new Map();
  for (const e of zip.entries) {
    const n = e.name;
    if (n === 'mimetype' || n === 'META-INF/manifest.xml' || e.directory) continue;
    if (isLeftover(n)) remove.set(n, 'System leftovers');
    else if (/^Thumbnails\//.test(n)) remove.set(n, 'Thumbnail');
    else if (/^META-INF\/(document|macro)?signatures[^/]*\.xml$/i.test(n)) remove.set(n, 'Digital signature');
    else if (n === 'layout-cache') remove.set(n, 'Unused part');
    else if (macros.has(n)) { if (options.removeMacros) remove.set(n, 'Macros'); }
    else if (manifest && !listed.has(n) && !n.startsWith('META-INF/')) remove.set(n, 'Unused part');
  }
  return { manifest, listed, encrypted, macros, remove, options };
}

// Which sanitizer a part needs, by its file name in the package or in an embedded object.
export function odfKind(name) {
  const base = name.split('/').pop();
  if (base === 'meta.xml') return 'meta';
  if (base === 'settings.xml') return 'settings';
  if (base === 'content.xml' || base === 'styles.xml') return 'content';
  return null;
}

// Rewrites one XML part in place and reports what it found. With acceptChanges false, tracked changes
// are only counted.
export function sanitizeOdf(doc, kind, plan) {
  const s = { properties: 0, fingerprints: 0, fingerprintBytes: 0, tracked: 0, authors: new Set(), dates: [], comments: [], remote: [], paths: [], links: [], printer: 0, printerNames: [], sources: [], macros: 0, changed: false };
  const root = rootOf(doc);
  if (!root) return s;
  if (kind === 'meta') {
    const meta = child(root, ODF.office, 'meta');
    if (meta && elements(meta).length) { s.properties = elements(meta).length; clear(meta); s.changed = true; }
    return s;
  }
  if (kind === 'settings') {
    const dead = [];
    for (const item of all(root, (x) => x.ns === ODF.config && x.local === 'config-item')) {
      const name = get(item, 'name', ODF.config); const value = text(item).trim();
      if (PRINTER_ITEMS.has(name)) { s.printer++; if (name === 'PrinterName' && value) s.printerNames.push(value); }
      else if (SOURCE_ITEMS.has(name)) { if (value) s.sources.push(value); }
      else if (RSID_ITEMS.has(name)) { s.fingerprints++; s.fingerprintBytes += 60; }
      else continue;
      dead.push(item);
    }
    if (dead.length) { prune(dead); s.changed = true; }
    return s;
  }
  const accept = plan.options.acceptChanges;
  const changes = []; const markers = []; const fetched = []; const listeners = []; const notes = [];
  walk(root, (el) => {
    const n = dropAttrs(el, (a) => attrNs(el, a) === ODF.officeooo && /rsid$/.test(attrLocal(a)));
    if (n) { s.fingerprints += n; s.fingerprintBytes += n * 30; s.changed = true; }
    if (el.ns === ODF.office && (el.local === 'annotation' || el.local === 'annotation-end')) {
      if (el.local === 'annotation') {
        const who = all(el, (x) => x.ns === ODF.dc && x.local === 'creator').map(text)[0] ?? '';
        const body = all(el, (x) => x.ns === ODF.text && x.local === 'p').map(text).join(' ');
        s.comments.push({ who: who.trim(), body });
      }
      notes.push(el); return false;
    }
    if ((el.ns === ODF.text || el.ns === ODF.table) && el.local === 'tracked-changes') {
      const regions = elements(el).length;
      s.tracked += regions;
      for (const c of all(el, (x) => x.ns === ODF.office && x.local === 'change-info')) {
        const who = all(c, (x) => x.ns === ODF.dc && x.local === 'creator').map(text)[0];
        const when = all(c, (x) => x.ns === ODF.dc && x.local === 'date').map(text)[0];
        if (who) s.authors.add(who.trim());
        if (when) s.dates.push(when.trim());
      }
      if (regions) changes.push(el);
      return false;
    }
    if (el.ns === ODF.text && (el.local === 'change' || el.local === 'change-start' || el.local === 'change-end')) { markers.push(el); return false; }
    const href = get(el, 'href', ODF.xlink);
    if (href !== undefined) {
      if (el.local === 'event-listener' && /^(vnd\.sun\.star\.script|macro):/i.test(href)) listeners.push(el);
      else {
        const where = targetKind(href);
        if (where === 'remote' || where === 'path') {
          if (CLICKABLE.has(el.local)) s.links.push(href);
          else { (where === 'remote' ? s.remote : s.paths).push(`${el.local}: ${href}`); fetched.push(el); }
        }
      }
    }
    return true;
  });
  if (notes.length) { prune(notes); s.changed = true; }
  // A linked picture or object goes; its frame goes too when nothing else is left in it.
  if (fetched.length) {
    const frames = [...new Set(fetched.map((el) => el.parent))];
    prune(fetched);
    prune(frames.filter((f) => f?.ns === ODF.draw && f.local === 'frame' && !elements(f).some((c) => c.ns === ODF.draw)));
    s.changed = true;
  }
  if (plan.options.removeMacros && listeners.length) {
    const lists = [...new Set(listeners.map((el) => el.parent))];
    prune(listeners); s.macros = listeners.length; s.changed = true;
    prune(lists.filter((l) => l?.local === 'event-listeners' && !elements(l).length));
  }
  if (accept && (changes.length || markers.length)) { prune([...changes, ...markers]); s.changed = true; }
  return s;
}

export async function parseOdf(zip, r, id) {
  const b = budget(DOC_LIMITS.maxReadBytes);
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  const plan = await planOdf(zip, b, { removeMacros: true, acceptChanges: true });
  r.field('Document', 'Format', id.format);
  if (plan.encrypted) { r.field('Document', 'Encrypted', 'Yes'); r.warn('The document is password protected, so its content could not be read.'); }
  for (const [name, kind] of plan.remove) {
    const e = byName.get(name);
    if (!e || kind === 'System leftovers' || kind === 'Macros') continue;
    entryBlock(r, kind, e);
    if (kind === 'Thumbnail') flag(r, 'thumbnail', `${name} is a small picture of the first page, which can show content later removed.`, 'Package');
    if (kind === 'Digital signature') {
      const data = await readPart(zip, e, b).catch(() => null);
      for (const m of (data ? utf8.decode(data) : '').matchAll(/<(?:\w+:)?X509SubjectName>([^<]+)</g)) { r.add('People', 'Signed by', m[1]); flag(r, 'signature', `The digital signature names ${m[1]}. Cleaning removes the signature, which would no longer be valid.`, name); }
    }
  }
  for (const name of plan.macros) entryBlock(r, 'Macros', byName.get(name), { note: 'Removed only when macro removal is chosen. Removing macros changes what the document does.' });
  if (plan.macros.size) flag(r, 'macros', 'The document contains macros, code that can run when it is opened.', 'Basic');
  const hidden = { text: 0, sections: 0, rows: 0, cols: 0, tables: 0, slides: 0, notes: null };
  let skipped = false;
  const media = [];
  for (const e of zip.entries) {
    if (plan.remove.has(e.name) || e.directory || plan.encrypted) continue;
    if (/(^|\/)Pictures\//.test(e.name)) { media.push(e); continue; }
    const kind = odfKind(e.name);
    if (!kind) continue;
    let doc;
    try {
      const data = await readPart(zip, e, b);
      if (!data) { skipped = true; continue; }
      doc = parseXml(utf8.decode(data));
    } catch (error) { if (error.limit) skipped = true; else r.warn('Some XML parts are malformed or could not be read.'); continue; }
    if (kind === 'meta') describeMeta(r, doc, e);
    if (kind === 'content') describeContent(doc, hidden, r, e);
    report(r, sanitizeOdf(doc, kind, plan), e);
  }
  if (skipped) r.warn('Some parts are larger than the inspection limit and were not inspected.');
  if (hidden.notes) entryBlock(r, 'Speaker notes', hidden.notes, { removable: false, note: 'Part of the presentation; remove notes in your editor' });
  const parts = [];
  const count = (n, one, many = `${one}s`) => n && parts.push(`${n} ${n === 1 ? one : many}`);
  count(hidden.text, 'hidden text passage'); count(hidden.sections, 'hidden section'); count(hidden.rows, 'hidden row');
  count(hidden.cols, 'hidden column'); count(hidden.tables, 'hidden sheet'); count(hidden.slides, 'hidden slide');
  if (parts.length) {
    const content = byName.get('content.xml') ?? zip.entries[0];
    entryBlock(r, 'Hidden content', content, { removable: false, note: 'Part of the document; reveal and delete it in your editor' });
    r.field('Hidden content', 'Summary', parts.join(', '));
    flag(r, 'hidden', `The document has content that is not shown: ${parts.join(', ')}.`, 'content.xml');
  }
  for (const e of zip.entries) if (/^Object [^/]+\/content\.xml$/.test(e.name)) r.field('Embedded files', e.name.split('/')[0], 'Embedded object');
  return media;
}

function describeMeta(r, doc, e) {
  const meta = child(rootOf(doc), ODF.office, 'meta');
  if (!meta) return;
  const source = e.name === 'meta.xml' ? 'Document properties' : `Properties of ${e.name.split('/')[0]}`;
  for (const el of elements(meta)) {
    if (el.local === 'document-statistic') { for (const a of el.attrs) if (!a.name.startsWith('xmlns')) r.field(source, attrLocal(a), a.raw); continue; }
    if (el.local === 'template' || el.local === 'auto-reload') {
      const href = get(el, 'href', ODF.xlink) ?? '';
      r.field(source, el.local === 'template' ? 'Template' : 'Reloads from', href);
      if (el.local === 'template') r.add('Software', 'Template', href);
      flagUsers(r, [href], source);
      if (el.local === 'auto-reload' && targetKind(href) === 'remote') flag(r, 'remote', `The document reloads itself from ${href}.`, source);
      continue;
    }
    if (el.local === 'user-defined') { r.field('Custom properties', get(el, 'name', ODF.meta) ?? 'Property', text(el)); flag(r, 'custom', 'Custom properties are stored in the document.', source); continue; }
    const value = text(el).trim(); if (!value) continue;
    const map = META[el.local];
    r.field(source, map?.[0] ?? el.local, value);
    if (map) r.add(map[1], map[0], value);
  }
}

function describeContent(doc, hidden, r, e) {
  walk(rootOf(doc), (el) => {
    if (el.ns === ODF.text && (el.local === 'hidden-text' || el.local === 'hidden-paragraph')) { hidden.text++; const t = get(el, 'string-value', ODF.text) ?? text(el); if (t) r.field('Hidden content', 'Hidden text', sample(t)); }
    else if (el.ns === ODF.text && el.local === 'section' && get(el, 'display', ODF.text) === 'none') { hidden.sections++; r.field('Hidden content', 'Hidden section', sample(text(el))); }
    else if (el.ns === ODF.table && el.local === 'table-row' && get(el, 'visibility', ODF.table) === 'collapse') hidden.rows += Math.min(1e6, Number(get(el, 'number-rows-repeated', ODF.table) ?? 1) || 1);
    else if (el.ns === ODF.table && el.local === 'table-column' && get(el, 'visibility', ODF.table) === 'collapse') hidden.cols += Math.min(1e6, Number(get(el, 'number-columns-repeated', ODF.table) ?? 1) || 1);
    else if (el.ns === ODF.style && el.local === 'table-properties' && get(el, 'display', ODF.table) === 'false') hidden.tables++;
    else if (el.ns === ODF.style && el.local === 'drawing-page-properties' && get(el, 'visibility', ODF.presentation) === 'hidden') hidden.slides++;
    else if (el.ns === ODF.presentation && el.local === 'notes') {
      const notes = all(el, (x) => x.ns === ODF.text && x.local === 'p').map(text).join(' ').trim();
      if (notes) { r.field('Speaker notes', e.name, sample(notes)); flag(r, 'notes', 'The presentation has speaker notes, which the audience does not see but anyone with the file can read.', e.name); hidden.notes = e; }
      return false;
    }
    return true;
  });
}

function report(r, s, e) {
  if (s.properties) rewriteBlock(r, 'Properties', e, 200, { note: 'Rewritten without personal fields' });
  if (s.fingerprints) {
    rewriteBlock(r, 'Editing fingerprints', e, s.fingerprintBytes, { note: `${s.fingerprints} editing session IDs` });
    r.field('Editing fingerprints', e.name, `${s.fingerprints} session IDs`);
    flag(r, 'fingerprints', 'Revision-session IDs are stored. They can link this file to other documents edited on the same computer.', e.name);
  }
  if (s.comments.length) {
    rewriteBlock(r, 'Comments', e, s.comments.reduce((n, c) => n + c.body.length + 80, 0));
    for (const c of s.comments.slice(0, 200)) r.field('Comments', c.who || 'Comment', sample(c.body));
    const who = [...new Set(s.comments.map((c) => c.who).filter(Boolean))];
    for (const w of who) r.add('People', 'Comment author', w);
    flag(r, 'comments', `Comments${who.length ? ` by ${who.slice(0, 3).join(', ')}` : ''} are stored in the file.`, e.name);
  }
  if (s.tracked) {
    rewriteBlock(r, 'Tracked changes', e, s.tracked * 80, { note: `${s.tracked} tracked changes` });
    r.field('Tracked changes', e.name, `${s.tracked} changes`);
    for (const a of s.authors) r.add('People', 'Change author', a);
    const dates = s.dates.slice().sort();
    if (dates.length) { r.add('Dates', 'First tracked change', dates[0]); r.add('Dates', 'Last tracked change', dates.at(-1)); }
    flag(r, 'tracked', `${s.tracked} tracked change${s.tracked === 1 ? '' : 's'}${s.authors.size ? ` by ${[...s.authors].slice(0, 3).join(', ')}` : ''}, including deleted text, are stored in the file.`, e.name);
  }
  if (s.remote.length) {
    rewriteBlock(r, 'Remote resource', e, s.remote.join('').length);
    for (const x of s.remote) r.field('Remote resources', 'Linked', x, { flag: 'privacy' });
    flag(r, 'remote', `${s.remote[0]}. Opening the file can contact that address, which tells its owner when and where the file was opened.`, e.name);
  }
  if (s.paths.length) {
    rewriteBlock(r, 'File path', e, s.paths.join('').length);
    for (const x of s.paths) r.field('Linked files', 'Linked', x);
    flagUsers(r, s.paths, e.name);
  }
  for (const l of s.links) r.field('Links', 'Hyperlink', l);
  flagUsers(r, s.links.filter((l) => targetKind(l) === 'path'), e.name);
  if (s.printer) {
    rewriteBlock(r, 'Printer settings', e, 300);
    for (const p of s.printerNames) r.field('Printer settings', 'Printer', p);
    if (s.printerNames.length) flag(r, 'printer', `The printer "${s.printerNames[0]}" is recorded.`, e.name);
  }
  if (s.sources.length) { rewriteBlock(r, 'Data source', e, s.sources.join('').length); for (const x of s.sources) r.field('Data sources', 'Data source', x); }
  if (s.macros) rewriteBlock(r, 'Macros', e, s.macros * 80, { note: 'Macro event handlers' });
}
