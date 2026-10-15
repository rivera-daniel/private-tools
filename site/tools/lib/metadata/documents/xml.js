// A small strict XML reader and writer for document packages. Workers have no DOMParser, and the
// cleaner needs to rewrite parts without disturbing bytes it does not touch: untouched attributes
// and text are written back exactly as they were read.

export class XmlError extends Error {}
export const XML_LIMITS = { maxNodes: 500000, maxDepth: 256, maxChars: 32 * 1024 * 1024 };

const NAME = /^[A-Za-z_:À-￿][\w.\-:·-￿]*$/;
const ATTR = /\s+([^\s=/>]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// lenient: unknown named entities (HTML's &nbsp; in EPUB XHTML) are kept as written instead of refused.
export function decode(raw, lenient = false) {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][\w.-]*);?/g, (m, ref) => {
    if (!m.endsWith(';')) { if (lenient) return m; throw new XmlError('bad character reference'); }
    if (ref[0] === '#') {
      const n = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!(n === 9 || n === 10 || n === 13 || (n >= 0x20 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff))) throw new XmlError('bad character reference');
      return String.fromCodePoint(n);
    }
    if (ref in ENTITIES) return ENTITIES[ref];
    if (lenient) return m;
    throw new XmlError(`undeclared entity &${ref};`);
  });
}

export const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

// Element: { type: 'el', name, prefix, local, ns, attrs: [{ name, raw, quote }], children, parent, scope }.
// Text: { type: 'text', raw }. Anything else (declaration, comment, CDATA, PI, doctype): { type: 'raw', raw }.
export function parseXml(text, { lenient = false, maxNodes = XML_LIMITS.maxNodes } = {}) {
  if (text.length > XML_LIMITS.maxChars) throw new XmlError('part is too large to read');
  const doc = { type: 'doc', children: [], parent: null, scope: { xml: XML_NS } };
  let cur = doc; let i = 0; let nodes = 0; let depth = 0; let root = false;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const push = (node) => { if (++nodes > maxNodes) throw new XmlError('more nodes than the limit'); node.parent = cur; cur.children.push(node); };
  while (i < n) {
    const lt = text.indexOf('<', i);
    const end = lt < 0 ? n : lt;
    if (end > i) {
      const raw = text.slice(i, end);
      if (cur === doc) { if (raw.trim()) throw new XmlError('text outside the root element'); }
      else { if (raw.includes(']]>')) throw new XmlError('stray ]]>'); decode(raw, lenient); }
      push({ type: 'text', raw });
      i = end; continue;
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4); if (close < 0) throw new XmlError('unclosed comment');
      push({ type: 'raw', raw: text.slice(i, close + 3) }); i = close + 3; continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (cur === doc) throw new XmlError('CDATA outside the root element');
      const close = text.indexOf(']]>', i); if (close < 0) throw new XmlError('unclosed CDATA');
      push({ type: 'raw', raw: text.slice(i, close + 3), cdata: true }); i = close + 3; continue;
    }
    if (text.startsWith('<?', i)) {
      const close = text.indexOf('?>', i + 2); if (close < 0) throw new XmlError('unclosed processing instruction');
      push({ type: 'raw', raw: text.slice(i, close + 2) }); i = close + 2; continue;
    }
    if (text.startsWith('<!DOCTYPE', i)) {
      if (cur !== doc || root) throw new XmlError('misplaced doctype');
      // The internal subset is kept as written and never expanded.
      let j = i + 9; let bracket = 0;
      for (; j < n; j++) { const c = text[j]; if (c === '[') bracket++; else if (c === ']') bracket--; else if (c === '>' && bracket <= 0) break; }
      if (j >= n) throw new XmlError('unclosed doctype');
      push({ type: 'raw', raw: text.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (text[i + 1] === '/') {
      const close = text.indexOf('>', i); if (close < 0) throw new XmlError('unclosed end tag');
      const name = text.slice(i + 2, close).trim();
      if (cur === doc || name !== cur.name) throw new XmlError(`mismatched end tag </${name}>`);
      cur = cur.parent; depth--; i = close + 1; continue;
    }
    // Start tag.
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(text[j])) j++;
    const name = text.slice(i + 1, j);
    if (!NAME.test(name)) throw new XmlError('bad element name');
    if (cur === doc && root) throw new XmlError('more than one root element');
    const attrs = []; const seen = new Set();
    ATTR.lastIndex = j;
    for (let m; (m = ATTR.exec(text));) {
      if (seen.has(m[1])) throw new XmlError(`duplicate attribute ${m[1]}`);
      if (!NAME.test(m[1])) throw new XmlError('bad attribute name');
      seen.add(m[1]);
      const raw = m[2] ?? m[3];
      decode(raw, lenient);
      attrs.push({ name: m[1], raw, quote: m[2] === undefined ? "'" : '"' });
      j = ATTR.lastIndex;
    }
    while (j < n && /\s/.test(text[j])) j++;
    const empty = text[j] === '/';
    if (empty) j++;
    if (text[j] !== '>') throw new XmlError(`malformed start tag <${name}>`);
    const el = { type: 'el', name, attrs, children: [], selfClose: empty, scope: cur.scope };
    let declares = null;
    for (const a of attrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) { declares ??= Object.create(cur.scope); declares[a.name === 'xmlns' ? '' : a.name.slice(6)] = decode(a.raw, lenient); }
    }
    if (declares) el.scope = declares;
    const colon = name.indexOf(':');
    el.prefix = colon < 0 ? '' : name.slice(0, colon); el.local = colon < 0 ? name : name.slice(colon + 1);
    el.ns = el.scope[el.prefix] ?? '';
    push(el);
    if (cur === doc) root = true;
    i = j + 1;
    if (!empty) { cur = el; if (++depth > XML_LIMITS.maxDepth) throw new XmlError('nested too deeply'); }
  }
  if (cur !== doc) throw new XmlError(`unclosed element <${cur.name}>`);
  if (!root) throw new XmlError('no root element');
  return doc;
}

export const rootOf = (doc) => doc.children.find((c) => c.type === 'el');

export function serialize(node) {
  const out = [];
  const write = (x) => {
    if (x.type === 'text' || x.type === 'raw') { out.push(x.raw); return; }
    if (x.type === 'doc') { for (const c of x.children) write(c); return; }
    out.push('<', x.name);
    for (const a of x.attrs) out.push(' ', a.name, '=', a.quote, a.raw, a.quote);
    if (!x.children.length && x.selfClose !== false) { out.push('/>'); return; }
    if (!x.children.length) { out.push('></', x.name, '>'); return; }
    out.push('>');
    for (const c of x.children) write(c);
    out.push('</', x.name, '>');
  };
  // Iterative over siblings, recursive over depth, which parseXml already capped.
  write(node);
  return out.join('');
}

export const isWellFormed = (text, lenient = false) => { try { parseXml(text, { lenient }); return true; } catch { return false; } };

// Attribute namespace: unprefixed attributes have none.
export function attrNs(el, a) { const c = a.name.indexOf(':'); return c < 0 ? '' : el.scope[a.name.slice(0, c)] ?? ''; }
export const attrLocal = (a) => a.name.slice(a.name.indexOf(':') + 1);
export const attrValue = (a) => (a.value !== undefined ? a.value : decode(a.raw, true));

// get(el, 'val') matches an unprefixed attribute; get(el, 'val', NS) one in that namespace.
export function get(el, local, ns = '') {
  for (const a of el.attrs) if (attrLocal(a) === local && attrNs(el, a) === ns && !a.name.startsWith('xmlns')) return attrValue(a);
  return undefined;
}

export function set(el, local, ns, value) {
  const a = el.attrs.find((x) => attrLocal(x) === local && attrNs(el, x) === ns);
  if (a) { a.value = String(value); a.raw = escapeAttr(value); a.quote = '"'; }
}

// Removes attributes matching fn(attr, el). Namespace declarations are never removed.
export function dropAttrs(el, fn) {
  const before = el.attrs.length;
  el.attrs = el.attrs.filter((a) => a.name === 'xmlns' || a.name.startsWith('xmlns:') || !fn(a, el));
  return before - el.attrs.length;
}

// Pre-order walk over node (when it is an element) and its descendants. fn returning false skips the
// element's children. Safe against removal during the walk because children are snapshotted.
export function walk(node, fn) {
  const stack = [node];
  while (stack.length) {
    const x = stack.pop();
    if (x.type === 'el' && fn(x) === false) continue;
    if (x.children) for (let k = x.children.length - 1; k >= 0; k--) if (x.children[k].type === 'el') stack.push(x.children[k]);
  }
}

export function all(node, fn) { const out = []; walk(node, (x) => { if (fn(x)) out.push(x); }); return out; }
export const is = (el, ns, local) => el.type === 'el' && el.ns === ns && (local === undefined || el.local === local);
export const kids = (el, ns, local) => el.children.filter((c) => c.type === 'el' && (ns === undefined || c.ns === ns) && (local === undefined || c.local === local));
export const child = (el, ns, local) => el.children.find((c) => c.type === 'el' && c.ns === ns && c.local === local);

export function text(el) {
  const out = [];
  const go = (x) => { for (const c of x.children) { if (c.type === 'text') out.push(decode(c.raw, true)); else if (c.cdata) out.push(c.raw.slice(9, -3)); else if (c.type === 'el') go(c); } };
  go(el);
  return out.join('');
}

export function remove(el) { const list = el.parent.children; const k = list.indexOf(el); if (k >= 0) list.splice(k, 1); }
export function unwrap(el) {
  const list = el.parent.children; const k = list.indexOf(el);
  if (k < 0) return;
  for (const c of el.children) c.parent = el.parent;
  list.splice(k, 1, ...el.children);
}
export function clear(el) { el.children = []; el.selfClose = true; }
export const elements = (el) => el.children.filter((c) => c.type === 'el');
