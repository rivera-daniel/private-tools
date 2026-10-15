// EPUB 2 and 3. The rules here are shared with the cleaner.
import { parseXml, rootOf, elements, all, get, set, text, remove, dropAttrs, attrLocal, attrValue, escapeText, serialize } from './xml.js';
import { DOC_LIMITS, budget, readPart, entryBlock, rewriteBlock, flag, sample, targetKind, isLeftover } from './package.js';
import { resolveTarget } from './opc.js';
import { utf8 } from '../bytes.js';

const OPF = 'http://www.idpf.org/2007/opf';
const DC = 'http://purl.org/dc/elements/1.1/';
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
// Dublin Core elements a book needs (identifier, title, language) stay. These go.
const DC_DROP = new Set(['creator', 'contributor', 'publisher', 'rights', 'date', 'subject', 'description', 'source', 'relation', 'coverage', 'type']);
// Metadata that changes how the book is shown stays.
const META_KEEP = /^(dcterms:modified|rendition:|media:|ibooks:|schema:|a11y:)/;
// EPUB 3 requires a modification date. The cleaner sets this fixed one, which says nothing.
export const MODIFIED = '1980-01-01T00:00:00Z';
const VENDOR_FILES = /^(iTunesMetadata(-original)?\.plist|iTunesArtwork|META-INF\/calibre_bookmarks\.txt)$/;
const REMOTE_HINT = /(?:src|href|data|poster|srcset)\s*=\s*["']?\s*(?:https?:|\/\/|ftp:|file:)|url\(\s*['"]?\s*(?:https?:|\/\/|file:)|@import/i;
// Elements whose only job is to fetch the remote resource. Anything else keeps its element and loses the attribute.
const FETCHERS = new Set(['img', 'image', 'audio', 'video', 'source', 'track', 'iframe', 'embed', 'object', 'script', 'link', 'input', 'frame', 'use', 'feImage']);
const isRemote = (v) => targetKind(v) === 'remote' || /^file:/i.test(v.trim());

// Where the package document is, what the cleaner drops and whether the book is DRM protected.
export async function planEpub(zip, b) {
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  const read = async (name, limit) => { const e = byName.get(name); const d = e && await readPart(zip, e, b, limit); return d ? utf8.decode(d) : null; };
  let opfPath = null;
  const container = await read('META-INF/container.xml', 1024 * 1024);
  if (container) { const rf = all(parseXml(container), (x) => x.local === 'rootfile')[0]; opfPath = rf ? get(rf, 'full-path') : null; }
  if (!opfPath || !byName.has(opfPath)) opfPath = zip.entries.find((e) => /\.opf$/i.test(e.name))?.name ?? null;
  let drm = byName.has('META-INF/rights.xml');
  const obfuscated = new Set();
  const encryption = await read('META-INF/encryption.xml', 4 * 1024 * 1024);
  if (encryption) {
    for (const data of all(parseXml(encryption), (x) => x.local === 'EncryptedData')) {
      const method = all(data, (x) => x.local === 'EncryptionMethod')[0]; const ref = all(data, (x) => x.local === 'CipherReference')[0];
      const alg = method && get(method, 'Algorithm'); const uri = ref && get(ref, 'URI');
      if (FONT_OBFUSCATION.has(alg)) { if (uri) obfuscated.add(safeDecode(uri)); } else drm = true;
    }
  }
  const listed = new Set(); let opf = null;
  if (opfPath) {
    const t = await read(opfPath, 8 * 1024 * 1024);
    if (t) {
      opf = parseXml(t);
      for (const item of all(opf, (x) => x.ns === OPF && x.local === 'item')) { const href = get(item, 'href'); if (href && targetKind(href) === 'local') listed.add(resolveTarget(opfPath, href)); }
    }
  }
  const remove = new Map();
  for (const e of zip.entries) {
    const n = e.name;
    if (n === 'mimetype' || e.directory || n === opfPath) continue;
    if (isLeftover(n)) remove.set(n, 'System leftovers');
    else if (VENDOR_FILES.test(n)) remove.set(n, n.startsWith('iTunes') ? 'Store purchase record' : 'Reading positions');
    else if (n === 'META-INF/signatures.xml') remove.set(n, 'Digital signature');
    else if (!n.startsWith('META-INF/') && opf && !listed.has(n)) remove.set(n, 'Unused part');
  }
  return { opfPath, opf, drm, obfuscated, remove, listed };
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// The package document: personal and vendor metadata go, remote items go. Rewrites doc in place.
export function sanitizeOpf(doc) {
  const s = { fields: [], remote: [], changed: false };
  const root = rootOf(doc);
  const metadata = root && all(root, (x) => x.ns === OPF && x.local === 'metadata')[0];
  if (!metadata) return s;
  const dropped = new Set();
  const drop = (el, key, value) => { s.fields.push([key, value]); const id = get(el, 'id'); if (id) dropped.add(`#${id}`); remove(el); };
  for (const el of elements(metadata)) {
    if (el.ns === DC && DC_DROP.has(el.local)) { drop(el, el.local, text(el).trim()); continue; }
    if (el.local === 'meta') {
      const name = get(el, 'name'); const property = get(el, 'property'); const refines = get(el, 'refines');
      if (name !== undefined) { if (name !== 'cover') drop(el, name, get(el, 'content') ?? ''); continue; }
      if (property === 'dcterms:modified' && !refines) {
        if (text(el).trim() !== MODIFIED) { s.fields.push(['modified', text(el).trim()]); el.children = [{ type: 'text', raw: escapeText(MODIFIED), parent: el }]; }
        continue;
      }
      if (!refines && !META_KEEP.test(property ?? '')) drop(el, property ?? 'meta', text(el).trim());
      continue;
    }
    if (el.local === 'link' && isRemote(get(el, 'href') ?? '')) { s.remote.push(get(el, 'href')); remove(el); }
  }
  // Refinements of removed elements go with them, and so do refinements of those.
  for (let again = true; again;) {
    again = false;
    for (const el of elements(metadata)) {
      const refines = el.local === 'meta' ? get(el, 'refines') : undefined;
      if (refines && dropped.has(refines)) { drop(el, get(el, 'property') ?? 'meta', text(el).trim()); again = true; }
    }
  }
  const manifest = all(root, (x) => x.ns === OPF && x.local === 'manifest')[0];
  for (const item of manifest ? elements(manifest) : []) {
    const href = get(item, 'href') ?? '';
    if (isRemote(href)) {
      s.remote.push(href);
      const id = get(item, 'id');
      for (const ref of all(root, (x) => x.local === 'itemref' && get(x, 'idref') === id)) remove(ref);
      remove(item);
    } else if (/\bremote-resources\b/.test(get(item, 'properties') ?? '')) {
      const rest = get(item, 'properties').split(/\s+/).filter((p) => p && p !== 'remote-resources');
      if (rest.length) set(item, 'properties', '', rest.join(' ')); else dropAttrs(item, (a) => a.name === 'properties');
      s.changed = true;
    }
  }
  if (s.fields.length || s.remote.length) s.changed = true;
  return s;
}

export const mayLoadRemote = (t) => REMOTE_HINT.test(t);

// Removes what a content document ('xml') or style sheet ('css') would fetch from the network.
// Returns { remote, out } where out is the rewritten text, or null when nothing changed.
export function sanitizeContent(value, kind) {
  const remote = [];
  if (kind === 'css') { const out = cleanCss(value, remote); return { remote, out: out === value ? null : out }; }
  const doc = parseXml(value, { lenient: true });
  const fetchers = []; const attrs = []; let changed = false;
  for (const el of all(doc, () => true)) {
    for (const a of el.attrs) {
      const local = attrLocal(a);
      if (local === 'style') {
        const v = attrValue(a); const fixed = cleanCss(v, remote);
        if (fixed !== v) { set(el, 'style', '', fixed); changed = true; }
        continue;
      }
      if (!/^(src|href|data|poster|srcset)$/.test(local)) continue;
      const v = attrValue(a).trim();
      const hit = local === 'srcset' ? v.split(',').some((c) => isRemote(c.trim().split(/\s+/)[0] ?? '')) : isRemote(v);
      if (!hit || el.local === 'a' || el.local === 'area') continue;
      if (el.local === 'link' && !/stylesheet|icon|preload|prefetch|import|manifest/i.test(get(el, 'rel') ?? 'stylesheet')) continue;
      remote.push(`${el.local}: ${v}`);
      if (FETCHERS.has(el.local)) fetchers.push(el); else attrs.push([el, a]);
    }
    if (el.local === 'style') {
      for (const c of el.children) {
        if (c.type !== 'text' && !c.cdata) continue;
        const t = c.cdata ? c.raw.slice(9, -3) : c.raw; const fixed = cleanCss(t, remote);
        if (fixed !== t) { c.raw = c.cdata ? `<![CDATA[${fixed}]]>` : fixed; changed = true; }
      }
    }
  }
  for (const el of fetchers) if (el.parent) remove(el);
  for (const [el, a] of attrs) el.attrs = el.attrs.filter((x) => x !== a);
  return { remote, out: changed || fetchers.length || attrs.length ? serialize(doc) : null };
}

function cleanCss(css, remote) {
  return css
    .replace(/@import\s+(?:url\(\s*)?(['"]?)\s*((?:https?:)?\/\/[^'")\s;]+|file:[^'")\s;]+)\1\s*\)?[^;]*;?/gi, (m, q, u) => { remote.push(`@import: ${u}`); return ''; })
    .replace(/url\(\s*(['"]?)\s*((?:https?:)?\/\/[^'")\s]+|file:[^'")\s]+)\s*\1\s*\)/gi, (m, q, u) => { remote.push(`url: ${u}`); return 'none'; });
}

// Content documents and style sheets the book lists, with the kind of rewrite they get.
export function contentParts(zip, plan) {
  const out = [];
  for (const item of all(plan.opf, (x) => x.ns === OPF && x.local === 'item')) {
    const href = get(item, 'href'); const type = get(item, 'media-type') ?? '';
    if (!href || targetKind(href) !== 'local') continue;
    const name = resolveTarget(plan.opfPath, href);
    const e = zip.entries.find((x) => x.name === name);
    if (!e || plan.obfuscated.has(name) || plan.remove.has(name)) continue;
    const kind = /^image\//.test(type) && !/svg/.test(type) ? 'image' : /css/.test(type) ? 'css' : /xml|html|svg/.test(type) ? 'xml' : null;
    if (kind) out.push({ e, kind });
  }
  return out;
}

export async function parseEpub(zip, r) {
  const b = budget(DOC_LIMITS.maxReadBytes);
  let plan;
  try { plan = await planEpub(zip, b); } catch { r.warn('The package document is malformed.'); return []; }
  r.field('Document', 'Format', 'EPUB');
  if (plan.opfPath) r.field('Document', 'Package document', plan.opfPath);
  if (plan.drm) { r.field('Document', 'DRM', 'Yes'); r.warn('The book is DRM protected, so most of its content could not be read.'); }
  if (plan.obfuscated.size) r.field('Document', 'Obfuscated fonts', String(plan.obfuscated.size));
  for (const [name, kind] of plan.remove) {
    const e = zip.entries.find((x) => x.name === name);
    if (!e || kind === 'System leftovers') continue;
    entryBlock(r, kind, e);
    if (kind === 'Store purchase record') {
      const data = await readPart(zip, e, b, 1024 * 1024).catch(() => null);
      for (const m of (data ? utf8.decode(data) : '').matchAll(/<key>(appleId|apple-id|userName|purchaser|buyer)[^<]*<\/key>\s*<string>([^<]+)<\/string>/gi)) r.add('People', 'Store account', m[2]);
      flag(r, 'store', `${name} is a store purchase record, which can name the account that bought the book.`, name);
    }
  }
  if (!plan.opf) return [];
  const opfEntry = zip.entries.find((e) => e.name === plan.opfPath);
  describeOpf(r, plan.opf);
  const s = sanitizeOpf(plan.opf);
  if (s.fields.length) rewriteBlock(r, 'Properties', opfEntry, s.fields.reduce((n, [k, v]) => n + k.length + v.length + 30, 0), { note: 'Creator, publisher, dates and vendor metadata' });
  const remote = [...s.remote];
  if (s.remote.length) rewriteBlock(r, 'Remote resource', opfEntry, s.remote.join('').length);
  const media = [];
  if (plan.drm) return media;
  for (const { e, kind } of contentParts(zip, plan)) {
    if (kind === 'image') { media.push(e); continue; }
    try {
      const data = await readPart(zip, e, b); if (!data) continue;
      const t = utf8.decode(data);
      if (!mayLoadRemote(t)) continue;
      const c = sanitizeContent(t, kind);
      if (c.remote.length) { rewriteBlock(r, 'Remote resource', e, c.remote.join('').length); remote.push(...c.remote); }
    } catch { r.warn('Some content documents are malformed.'); }
  }
  for (const x of remote.slice(0, 100)) r.field('Remote resources', 'Linked', x, { flag: 'privacy' });
  if (remote.length) flag(r, 'remote', `${remote.length} resource${remote.length === 1 ? '' : 's'} such as ${remote[0]} load from the internet when the book is opened, which tells their owner when and where it was read.`, 'Content');
  return media;
}

const OPF_FIELDS = {
  creator: ['Author', 'People'], contributor: ['Contributor', 'People'], publisher: ['Publisher', 'People'],
  title: ['Title', 'Document'], language: ['Language', 'Document'], identifier: ['Identifier', 'Document'], subject: ['Subject', 'Document'],
  description: ['Description', 'Document'], rights: ['Rights', 'Document'], date: ['Date', 'Dates'],
};

function describeOpf(r, doc) {
  const metadata = all(doc, (x) => x.ns === OPF && x.local === 'metadata')[0];
  if (!metadata) return;
  for (const el of elements(metadata)) {
    if (el.ns === DC) {
      const value = text(el).trim(); if (!value) continue;
      const map = OPF_FIELDS[el.local];
      r.field('Package metadata', map?.[0] ?? el.local, sample(value, 2000));
      if (map) r.add(map[1], map[0], sample(value));
      if (el.local === 'contributor' && /calibre|sigil|indesign|vellum|pressbooks/i.test(value)) r.add('Software', 'Made with', value);
    } else if (el.local === 'meta') {
      const name = get(el, 'name') ?? get(el, 'property') ?? 'meta';
      const value = get(el, 'content') ?? text(el).trim();
      if (!value || name === 'cover' || (name === 'dcterms:modified' && value === MODIFIED)) continue;
      r.field('Package metadata', name, sample(value, 2000));
      if (name === 'generator' || /^Sigil version$/i.test(name)) r.add('Software', 'Made with', value);
      if (name === 'dcterms:modified') r.add('Dates', 'Modified', value);
      if (name === 'calibre:timestamp') r.add('Dates', 'Added to library', value);
    }
  }
}
