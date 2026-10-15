// True redaction for PDF files with MuPDF. Every function takes the MuPDF module (or a document opened with
// it), so the same code runs in the page's worker and under Node for tests.
//
// Coordinates: marks, matches and boxes are in points on the page as it is shown (MuPDF page space): origin
// at the top-left corner of the visible page, y growing downwards, rotation already applied. pageInfo()
// returns each page's bounds in the same space.
import { cleanFile } from '../clean/index.js';
import { coveredContent, snippet } from '../metadata/pdf/content.js';
import { Parser, Keyword, Dict, Str, PdfError, decodeText } from '../metadata/pdf/syntax.js';
import { serialize } from '../clean/pdf/writer.js';
import { LIMITS } from '../metadata/bytes.js';

export const MAX_MARKS = 5000;
export const MAX_MATCHES = 2000;
const STEXT = 'preserve-whitespace';
// Verification reads everything, including text placed outside the visible page.
const STEXT_ALL = 'preserve-whitespace,clip=no';
const LABEL_FONT = 'RdLabel';
const REPLACEMENT = '[redacted]';
// Strings with fewer letters or digits than this are only checked in the page text: in metadata and raw
// streams a short fragment matches too much that has nothing to do with it.
const MIN_SCRUB = 4;

export class RedactError extends Error { constructor(message, code) { super(message); this.code = code; } }

// ---------- Opening ----------

// Opens a PDF. Throws RedactError with code 'password' or 'wrong-password' when a password is needed.
export function openPdf(mupdf, bytes, password = '') {
  if (!bytes || bytes.length === 0) throw new RedactError('The file is empty.', 'not-pdf');
  if (bytes.length > LIMITS.maxFileBytes) throw new RedactError('This file is larger than 200 MB.', 'too-large');
  let doc;
  try { doc = mupdf.Document.openDocument(bytes, 'application/pdf'); } catch { throw new RedactError('This file could not be opened as a PDF.', 'not-pdf'); }
  const pdf = doc.asPDF?.();
  if (!pdf) throw new RedactError('This file could not be opened as a PDF.', 'not-pdf');
  if (pdf.needsPassword()) {
    if (!password) throw new RedactError('This PDF is protected with a password. Enter it to redact the document.', 'password');
    if (!pdf.authenticatePassword(password)) throw new RedactError('That password is not correct.', 'wrong-password');
  }
  let pages = 0;
  try { pages = pdf.countPages(); } catch { pages = 0; }
  if (!pages) throw new RedactError('The PDF has no pages that can be read.', 'not-pdf');
  return pdf;
}

// Text on hidden layers is still in the file, so search, collection and redaction see every layer.
export function showAllLayers(pdf) {
  const n = safe(() => pdf.countLayers(), 0);
  for (let i = 0; i < n; i++) safe(() => pdf.setLayerVisible(i, true));
}

export function pageInfo(pdf) {
  const out = [];
  const n = pdf.countPages();
  for (let i = 0; i < n; i++) {
    const page = pdf.loadPage(i);
    const b = page.getBounds();
    out.push({ bounds: [b[0], b[1], b[2], b[3]], width: b[2] - b[0], height: b[3] - b[1] });
  }
  return out;
}

export function documentInfo(pdf) {
  const enc = safe(() => pdf.getMetaData('encryption'), 'None') || 'None';
  return { pages: pageInfo(pdf), encrypted: enc !== 'None', encryption: enc === 'None' ? '' : enc, signed: isSigned(pdf), layers: safe(() => pdf.countLayers(), 0) };
}

function isSigned(pdf) {
  const fields = obj(() => pdf.getTrailer().get('Root').get('AcroForm').get('Fields'));
  if (!fields?.isArray()) return false;
  let signed = false; let seen = 0;
  const visit = (f, depth) => {
    if (signed || depth > 32 || ++seen > 20000) return;
    const d = f.resolve();
    if (!d.isDictionary()) return;
    const ft = d.getInheritable('FT');
    if (ft.isName() && ft.asName() === 'Sig' && d.get('V').resolve().isDictionary()) { signed = true; return; }
    const kids = d.get('Kids');
    if (kids.isArray()) kids.forEach((k) => visit(k, depth + 1));
  };
  fields.forEach((f) => visit(f, 0));
  return signed;
}

// ---------- Page text ----------

// Lines of characters with their quads, in reading order.
function pageLines(page, options = STEXT) {
  const lines = []; let line = null;
  const st = page.toStructuredText(options);
  try {
    st.walk({
      beginLine() { line = []; lines.push(line); },
      onChar(c, origin, font, size, quad) { if (line) line.push({ c, q: Array.from(quad) }); },
      endLine() { line = null; },
    });
  } finally { st.destroy?.(); }
  return lines;
}

// The page as one string with a quad for each character (null for line breaks).
function pageText(lines) {
  let text = ''; const quads = [];
  for (const line of lines) {
    for (const ch of line) { text += ch.c; for (let i = 0; i < ch.c.length; i++) quads.push(ch.q); }
    text += '\n'; quads.push(null);
  }
  return { text, quads };
}

const quadRect = (q) => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];
const rectQuad = (r) => [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]];
const unionRect = (rects) => rects.reduce((a, r) => [Math.min(a[0], r[0]), Math.min(a[1], r[1]), Math.max(a[2], r[2]), Math.max(a[3], r[3])], [Infinity, Infinity, -Infinity, -Infinity]);
const overlaps = (a, b, eps = 0.01) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > eps && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > eps;
const inside = (x, y, r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const round = (r) => r.map((v) => Math.round(v * 100) / 100);

// One quad per line for the characters from..to of a page.
function matchQuads(quads, from, to) {
  const out = []; let first = null; let last = null;
  const flush = () => { if (first) out.push([first[0], first[1], last[2], last[3], first[4], first[5], last[6], last[7]]); first = null; last = null; };
  for (let i = from; i < to; i++) {
    const q = quads[i];
    if (!q) { flush(); continue; }
    if (q === last) continue;
    if (!first) first = q;
    last = q;
  }
  flush();
  return out;
}

// ---------- Search ----------

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}_]';
const digits = (s) => s.replace(/\D/g, '');

function luhn(s) {
  const d = digits(s);
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanValid(s) {
  const v = s.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of code) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

// One-click searches. Each pattern is matched against the page text; check() rejects lookalikes.
export const PRESETS = [
  { id: 'email', label: 'Email addresses', pattern: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-])/gu },
  { id: 'phone', label: 'Phone numbers', pattern: /(?<![\p{L}\p{N}+]|\d[ .-])(?:(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}|\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5})(?![\p{L}\p{N}]|[ .-]\d)/gu, check: (s) => { const n = digits(s).length; return n >= 10 && n <= 15; } },
  { id: 'ssn', label: 'US Social Security numbers', pattern: /(?<![\p{N}-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\p{N}-])/gu },
  { id: 'card', label: 'Card numbers', pattern: /(?<![\p{N}])\d(?:[ -]?\d){12,18}(?![\p{N}])/gu, check: luhn },
  { id: 'iban', label: 'IBANs', pattern: /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}(?![\p{L}\p{N}])/gu, check: ibanValid },
  { id: 'date', label: 'Dates', pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS})\\.?,? \\d{4})(?![\\p{L}\\p{N}])`, 'giu') },
];

// A RegExp for a search. query is literal text unless regex is set; preset picks a built-in pattern.
export function searchPattern(query, { caseSensitive = false, wholeWord = false, regex = false, preset = null } = {}) {
  if (preset) {
    const p = PRESETS.find((x) => x.id === preset);
    if (!p) throw new RedactError('Unknown search pattern.', 'pattern');
    return { re: new RegExp(p.pattern.source, p.pattern.flags), check: p.check };
  }
  const q = String(query ?? '');
  if (!q.trim()) throw new RedactError('Enter something to search for.', 'pattern');
  if (q.length > 500) throw new RedactError('The search is too long.', 'pattern');
  let src = regex ? q : q.trim().split(/\s+/).map(escape).join('\\s+');
  if (wholeWord) src = `(?<!${WORD})(?:${src})(?!${WORD})`;
  try { return { re: new RegExp(src, `gu${caseSensitive ? '' : 'i'}`) }; } catch { throw new RedactError('That is not a valid regular expression.', 'pattern'); }
}

// Finds text on every page (or the pages listed). Returns { matches: [{ page, text, quads, rect }], truncated }.
export function findText(doc, query, options = {}) {
  const { re, check } = searchPattern(query, options);
  const matches = []; let truncated = false;
  const n = doc.countPages();
  const pages = options.pages ?? [...Array(n).keys()];
  const limit = options.limit ?? MAX_MATCHES;
  for (const i of pages) {
    if (i < 0 || i >= n) continue;
    const { text, quads } = pageText(pageLines(doc.loadPage(i)));
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const s = m[0].replace(/\s+$/, '');
      if (!s.trim() || (check && !check(s))) continue;
      const q = matchQuads(quads, m.index, m.index + s.length);
      if (!q.length) continue;
      if (matches.length >= limit) { truncated = true; break; }
      matches.push({ page: i, text: s.replace(/\s+/g, ' '), quads: q.map(round), rect: round(unionRect(q.map(quadRect))) });
    }
    if (truncated) break;
  }
  return { matches, truncated };
}

// ---------- Marks ----------

const finite = (a, n) => Array.isArray(a) && a.length === n && a.every((v) => typeof v === 'number' && Number.isFinite(v));

// Checks and normalizes marks: { page, rect: [x0, y0, x1, y1] } or { page, quads: [[8 numbers], ...] },
// optionally with text (the text the mark is meant to remove, which verification then requires gone).
export function normalizeMarks(marks, pages) {
  if (!Array.isArray(marks) || !marks.length) throw new RedactError('Mark at least one area to redact.', 'marks');
  if (marks.length > MAX_MARKS) throw new RedactError(`At most ${MAX_MARKS} marks can be applied at once.`, 'marks');
  return marks.map((m, i) => {
    const page = m?.page;
    if (!Number.isInteger(page) || page < 0 || page >= pages.length) throw new RedactError(`Mark ${i + 1} is on a page that does not exist.`, 'marks');
    const b = pages[page].bounds;
    const clip = (r) => [Math.max(r[0], b[0]), Math.max(r[1], b[1]), Math.min(r[2], b[2]), Math.min(r[3], b[3])];
    let quads;
    if (Array.isArray(m.quads) && m.quads.length) {
      if (m.quads.length > 500 || !m.quads.every((q) => finite(q, 8))) throw new RedactError(`Mark ${i + 1} has an invalid shape.`, 'marks');
      quads = m.quads.map((q) => q.slice());
    } else if (finite(m.rect, 4)) {
      const r = clip([Math.min(m.rect[0], m.rect[2]), Math.min(m.rect[1], m.rect[3]), Math.max(m.rect[0], m.rect[2]), Math.max(m.rect[1], m.rect[3])]);
      if (r[2] - r[0] < 0.5 || r[3] - r[1] < 0.5) throw new RedactError(`Mark ${i + 1} is too small or outside the page.`, 'marks');
      quads = [rectQuad(r)];
    } else throw new RedactError(`Mark ${i + 1} has no area.`, 'marks');
    const rects = quads.map(quadRect);
    const text = typeof m.text === 'string' ? m.text.slice(0, 2000) : '';
    return { page, quads, rects, rect: unionRect(rects), text };
  });
}

const hits = (rect, rects) => rects.some((r) => overlaps(rect, r));

// ---------- Planning ----------

const norm = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
const squash = (s) => s.normalize('NFKC').replace(/\s+/g, '');
const letters = (s) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

function count(hay, needle) {
  if (!needle) return 0;
  let n = 0; let at = 0;
  while ((at = hay.indexOf(needle, at)) !== -1) { n++; at += needle.length; }
  return n;
}

// The matcher shared by the metadata scrub and the raw scan: case-insensitive, any whitespace between
// characters, whole words only.
export function scrubPattern(s) {
  const chars = [...squash(s)];
  return new RegExp(`(?<!${WORD})${chars.map(escape).join('\\s*')}(?!${WORD})`, 'giu');
}

// What a set of marks removes: the exact strings under them (and the text each mark was made for), with
// how often each string also appears in text no mark touches.
export function planRedaction(doc, marks) {
  const n = doc.countPages();
  const byPage = new Map();
  for (const m of marks) { if (!byPage.has(m.page)) byPage.set(m.page, []); byPage.get(m.page).push(m); }
  const strings = new Map(); // text -> { text, pages:Set }
  const misses = [];
  const add = (t, page) => { const s = norm(t); if (!s) return; if (!strings.has(s)) strings.set(s, { text: s, pages: new Set() }); strings.get(s).pages.add(page); };
  let full = ''; let unmarked = '';
  const pagesText = [];
  for (let i = 0; i < n; i++) {
    const lines = pageLines(doc.loadPage(i), STEXT_ALL);
    const pm = byPage.get(i) ?? [];
    const under = pm.map(() => []);
    let pageFull = ''; let pageUnmarked = '';
    for (const line of lines) {
      let run = '';
      for (const ch of line) {
        const r = quadRect(ch.q);
        const covering = pm.length ? pm.map((m) => hits(r, m.rects)) : [];
        const covered = covering.some(Boolean);
        covering.forEach((c, k) => { if (c) under[k].push(ch.c); });
        pageFull += ch.c;
        pageUnmarked += covered ? '\u0001' : ch.c;
        if (covered) run += ch.c; else { add(run, i); run = ''; }
      }
      add(run, i);
      pageFull += '\n'; pageUnmarked += '\n';
      under.forEach((u) => { if (u.length && u.at(-1) !== ' ') u.push(' '); });
    }
    pm.forEach((m, k) => {
      if (!m.text) return;
      if (!squash(under[k].join('')).includes(squash(m.text))) misses.push({ page: i, text: norm(m.text) });
      else add(m.text, i);
    });
    pagesText.push(pageUnmarked);
    full += `${pageFull}\n`; unmarked += `${pageUnmarked}\n`;
  }
  const fullN = norm(full); const unmarkedN = norm(unmarked);
  const list = [...strings.values()].map((s) => {
    const scrub = letters(s.text) >= MIN_SCRUB;
    const re = scrub ? scrubPattern(s.text) : null;
    const elsewhere = re ? pagesText.reduce((a, t) => a + (norm(t).match(re)?.length ?? 0), 0) : 0;
    return { text: s.text, pages: [...s.pages].map((p) => p + 1), before: count(fullN, s.text), unmarked: count(unmarkedN, s.text), scrub, elsewhere };
  });
  return { strings: list, misses };
}

// Other places where the strings under the marks appear and no mark covers them, as search matches.
export function otherOccurrences(doc, marks, plan) {
  const out = [];
  for (const s of plan.strings) {
    if (!s.scrub || !s.elsewhere) continue;
    const { matches } = findText(doc, s.text, { wholeWord: true, limit: 500 });
    const free = matches.filter((m) => !marks.some((k) => k.page === m.page && m.quads.some((q) => hits(quadRect(q), k.rects))));
    if (free.length) out.push({ text: s.text, count: free.length, matches: free });
  }
  return out;
}

// ---------- Fake redactions ----------

function dark(cs, color) {
  const n = safe(() => cs.getNumberOfComponents(), color.length);
  const v = Array.from(color).slice(0, n);
  if (!v.length) return false;
  if (n === 1) return v[0] <= 0.1;
  if (n === 3) return v.every((x) => x <= 0.1);
  if (n === 4) return (v[3] >= 0.9 && v.slice(0, 3).every((x) => x <= 0.15)) || v.every((x) => x >= 0.85);
  return false;
}

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const concat = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

function pathRect(path, ctm) {
  const xs = []; const ys = [];
  const pt = (x, y) => { if (xs.length < 4000) { const p = apply(ctm, x, y); xs.push(p[0]); ys.push(p[1]); } };
  path.walk({ moveTo: pt, lineTo: pt, curveTo(a, b, c, d, e, f) { pt(a, b); pt(c, d); pt(e, f); } });
  if (!xs.length) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const unitRect = (m) => { const p = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)]; return [Math.min(...p.map((v) => v[0])), Math.min(...p.map((v) => v[1])), Math.max(...p.map((v) => v[0])), Math.max(...p.map((v) => v[1]))]; };

// Paint order on a page: dark filled shapes, text (with each glyph's centre) and images.
function paintEvents(mupdf, page, withAnnots) {
  const events = [];
  const glyphs = (text, ctm) => {
    const chars = [];
    text.walk({
      showGlyph(font, trm, glyph, unicode) {
        if (chars.length > 20000) return;
        const m = concat(Array.from(trm), Array.from(ctm));
        let adv = 0.5;
        try { adv = font.advanceGlyph(glyph, 0) || 0.5; } catch { /* keep the estimate */ }
        const c = apply(m, adv / 2, 0.3);
        chars.push({ c: unicode > 0 ? String.fromCodePoint(unicode) : '', x: c[0], y: c[1] });
      },
    });
    if (chars.length && events.length < 200000) events.push({ type: 'text', chars });
  };
  const device = new mupdf.Device({
    fillPath(path, evenOdd, ctm, cs, color, alpha) {
      if (alpha < 0.95 || !dark(cs, color) || events.length > 200000) return;
      const r = pathRect(path, ctm);
      if (r) events.push({ type: 'box', rect: r });
    },
    fillText(text, ctm) { glyphs(text, ctm); },
    strokeText(text, stroke, ctm) { glyphs(text, ctm); },
    clipText(text, ctm) { glyphs(text, ctm); },
    ignoreText(text, ctm) { glyphs(text, ctm); },
    fillImage(image, ctm) { events.push({ type: 'image', rect: unitRect(ctm) }); },
    fillImageMask(image, ctm) { events.push({ type: 'image', rect: unitRect(ctm) }); },
  });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
    if (withAnnots) { events.push({ type: 'annots' }); page.runPageAnnots(device, mupdf.Matrix.identity); }
    device.close();
  } finally { device.destroy?.(); }
  return events;
}

// Renders only the images on a page (white background) and tells, for each rect, whether the images show
// anything there: true when pixels inside it differ.
function imageInk(mupdf, page, rects, scale = 2) {
  const b = page.getBounds();
  const box = [Math.floor(b[0] * scale), Math.floor(b[1] * scale), Math.ceil(b[2] * scale), Math.ceil(b[3] * scale)];
  if ((box[2] - box[0]) * (box[3] - box[1]) > 40e6) return rects.map(() => null);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, false);
  pix.clear(255);
  const draw = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pix);
  const fwd = new mupdf.Device({
    fillImage(img, ctm, alpha) { draw.fillImage(img, ctm, alpha); },
    fillImageMask(img, ctm, cs, color, alpha) { draw.fillImageMask(img, ctm, cs, color, alpha); },
    clipPath(path, eo, ctm) { draw.clipPath(path, eo, ctm); },
    clipStrokePath(path, s, ctm) { draw.clipStrokePath(path, s, ctm); },
    clipText(t, ctm) { draw.clipText(t, ctm); },
    clipStrokeText(t, s, ctm) { draw.clipStrokeText(t, s, ctm); },
    clipImageMask(img, ctm) { draw.clipImageMask(img, ctm); },
    popClip() { draw.popClip(); },
    beginMask(r, l, cs, c) { draw.beginMask(r, l, cs, c); },
    endMask() { draw.endMask(); },
    beginGroup(r, cs, i, k, bm, a) { draw.beginGroup(r, cs, i, k, bm, a); },
    endGroup() { draw.endGroup(); },
  });
  try { page.runPageContents(fwd, mupdf.Matrix.identity); fwd.close(); draw.close(); } finally { fwd.destroy?.(); draw.destroy?.(); }
  const px = pix.getPixels().slice(); const w = pix.getWidth(); const h = pix.getHeight(); const stride = pix.getStride();
  const x0 = pix.getX(); const y0 = pix.getY();
  pix.destroy?.();
  return rects.map((r) => {
    const inset = 1.5;
    const ax = Math.max(0, Math.ceil((r[0] + inset) * scale) - x0); const bx = Math.min(w, Math.floor((r[2] - inset) * scale) - x0);
    const ay = Math.max(0, Math.ceil((r[1] + inset) * scale) - y0); const by = Math.min(h, Math.floor((r[3] - inset) * scale) - y0);
    if (bx <= ax || by <= ay) return false;
    let lo = [255, 255, 255]; let hi = [0, 0, 0];
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) {
        const o = y * stride + x * 3;
        for (let c = 0; c < 3; c++) { const v = px[o + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
      }
    }
    return { ink: hi.some((v, c) => v - lo[c] > 12), mean: (lo[0] + hi[0]) / 2 };
  });
}

function contentBytes(pdf, page) {
  const contents = obj(() => page.getObject().get('Contents'));
  if (!contents || contents.isNull()) return new Uint8Array();
  const list = [];
  if (contents.isArray()) contents.forEach((c) => list.push(c)); else list.push(contents);
  const parts = [];
  for (const c of list.slice(0, 64)) { if (safe(() => c.isStream(), false)) { try { parts.push(c.readStream().asUint8Array().slice(), Uint8Array.of(10)); } catch { /* damaged stream */ } } }
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}

// Pages where text or images are painted and then covered by a filled black shape (or a black annotation),
// so that the "redaction" hides nothing: the covered text can still be copied out. Unapplied redaction
// marks are listed too. Returns { pages: [{ page, boxes: [{ rect, text, image }], text }], unapplied }.
export function checkRedactions(mupdf, doc) {
  const out = []; const unapplied = [];
  const n = Math.min(doc.countPages(), 2000);
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const b = page.getBounds(); const area = (b[2] - b[0]) * (b[3] - b[1]);
    let events;
    try { events = paintEvents(mupdf, page, true); } catch { continue; }
    const boxes = [];
    events.forEach((e, k) => {
      if (e.type !== 'box') return;
      const w = e.rect[2] - e.rect[0]; const h = e.rect[3] - e.rect[1];
      if (w < 4 || h < 4 || w * h > area * 0.6 || boxes.length >= 500) return;
      let text = ''; let image = false;
      for (let j = 0; j < k; j++) {
        const p = events[j];
        if (p.type === 'text') { const got = p.chars.filter((c) => inside(c.x, c.y, e.rect)).map((c) => c.c).join(''); if (got) text += (text && !text.endsWith(' ') ? ' ' : '') + got; }
        else if (p.type === 'image') {
          const ix = Math.max(0, Math.min(p.rect[2], e.rect[2]) - Math.max(p.rect[0], e.rect[0])); const iy = Math.max(0, Math.min(p.rect[3], e.rect[3]) - Math.max(p.rect[1], e.rect[1]));
          if (ix * iy >= w * h * 0.5) image = true;
        }
      }
      text = norm(text);
      if (text || image) boxes.push({ rect: round(e.rect), text, image });
    });
    // An image under a box hides something only if it shows something there.
    const imageBoxes = boxes.filter((x) => x.image);
    if (imageBoxes.length) {
      const ink = safe(() => imageInk(mupdf, page, imageBoxes.map((x) => x.rect)), imageBoxes.map(() => ({ ink: true })));
      imageBoxes.forEach((x, k) => { x.image = ink[k] === null ? true : ink[k].ink; });
    }
    const kept = boxes.filter((x) => x.text || x.image);
    let source = 'boxes';
    let text = kept.map((x) => x.text).filter(Boolean).join(' ');
    if (!kept.length) {
      // The inspector's own reading of the page content, which can see what the device pass did not.
      const resources = obj(() => page.getObject().getInheritable('Resources'));
      const xobjects = resources?.get('XObject');
      const isImage = (name) => { const x = obj(() => xobjects?.get(name)); return !!x && !x.isNull() && x.get('Subtype').isName() && x.get('Subtype').asName() === 'Image'; };
      const box = obj(() => page.getObject().getInheritable('MediaBox'));
      const mediaArea = box?.isArray() && box.length >= 4 ? Math.abs((box.get(2).asNumber() - box.get(0).asNumber()) * (box.get(3).asNumber() - box.get(1).asNumber())) || Infinity : Infinity;
      const hit = safe(() => coveredContent(contentBytes(doc, page), { isImage, pageArea: mediaArea }), { texts: [], images: 0 });
      if (hit.texts.length) { source = 'content'; text = snippet(hit.texts); }
      if (!hit.texts.length) { /* images found only by the content reading are not reported: the device pass rendered them */ }
      else out.push({ page: i, boxes: [], text, source });
    }
    if (kept.length) out.push({ page: i, boxes: kept, text, source });
    for (const a of safe(() => page.getAnnotations(), [])) {
      if (safe(() => a.getType(), '') !== 'Redact') continue;
      const r = a.getBounds();
      const lines = pageLines(page, STEXT_ALL);
      const t = norm(lines.map((l) => l.filter((c) => overlaps(quadRect(c.q), r)).map((c) => c.c).join('')).filter(Boolean).join(' '));
      unapplied.push({ page: i, rect: round(Array.from(r)), text: t });
    }
  }
  return { pages: out, unapplied };
}

// ---------- Redaction ----------

const IMAGE_METHOD = { 'remove-overlapping': 1, 'blank-pixels': 2, none: 0 };
const LINE_ART_METHOD = { 'remove-covered': 1, none: 0 };

export const DEFAULTS = { mode: 'remove', images: 'blank-pixels', lineArt: 'remove-covered', fill: true, label: '', dpi: 150, password: '', allowSignatureLoss: false };

// Redacts marks and returns { ok: true, data, removed, verification } or { ok: false, code, reason,
// verification? }. Nothing is returned when the check afterwards finds any of the redacted text.
export async function redact(mupdf, bytes, marks, options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!['remove', 'rasterize'].includes(o.mode)) return refuse('bad-options', 'Unknown redaction mode.');
  if (!(o.images in IMAGE_METHOD) || !(o.lineArt in LINE_ART_METHOD)) return refuse('bad-options', 'Unknown redaction option.');
  const label = typeof o.label === 'string' ? o.label.replace(/[^\x20-\x7e]/g, '').slice(0, 40) : '';
  const dpi = Math.min(600, Math.max(72, Number(o.dpi) || 150));
  try {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const pdf = openPdf(mupdf, input, o.password);
    const info = documentInfo(pdf);
    if (info.signed && !o.allowSignatureLoss) return refuse('signed', 'This PDF is digitally signed. Redacting it invalidates the signature, and the signature is removed.');
    const list = normalizeMarks(marks, info.pages);
    const removed = [];

    // Rasterized pages are drawn as the reader sees them, before hidden layers are switched on.
    const rasters = new Map();
    if (o.mode === 'rasterize') {
      for (const page of new Set(list.map((m) => m.page))) rasters.set(page, rasterPage(mupdf, pdf, page, list.filter((m) => m.page === page), dpi, o.fill));
    }
    showAllLayers(pdf);
    const plan = planRedaction(pdf, list);
    if (plan.misses.length) {
      const leftovers = plan.misses.map((m) => ({ kind: 'Mark misses its text', page: m.page + 1, text: m.text }));
      return refuse('miss', `A mark does not cover the text it was made for (page ${leftovers[0].page}: "${clip(leftovers[0].text)}"). Nothing was changed.`, { ok: false, leftovers });
    }
    const scrubbed = plan.strings.filter((s) => s.scrub);
    const scrubRes = scrubbed.map((s) => ({ text: s.text, re: scrubPattern(s.text) }));

    const byPage = new Map();
    for (const m of list) { if (!byPage.has(m.page)) byPage.set(m.page, []); byPage.get(m.page).push(m); }
    let imagesHit = 0;
    for (const [i, pm] of byPage) {
      const page = pdf.loadPage(i);
      if (o.mode === 'rasterize') {
        replaceWithImage(mupdf, pdf, page, rasters.get(i));
        removed.push({ kind: 'Page rasterized', page: i + 1, detail: `Text, vector graphics, links and form fields on this page were replaced by a ${dpi} dpi image` });
        continue;
      }
      if (o.images !== 'none') {
        const events = safe(() => paintEvents(mupdf, page, false), []);
        imagesHit += events.filter((e) => e.type === 'image' && pm.some((m) => hits(e.rect, m.rects))).length;
      }
      clearWidgets(page, pm, scrubRes, removed, i);
      for (const m of pm) {
        const annot = page.createAnnotation('Redact');
        if (m.quads.length === 1 && isAxisRect(m.quads[0])) annot.setRect(quadRect(m.quads[0])); else annot.setQuadPoints(m.quads);
        annot.update();
      }
      page.applyRedactions(!!o.fill, IMAGE_METHOD[o.images], LINE_ART_METHOD[o.lineArt], 0);
    }
    for (const s of plan.strings) for (const p of s.pages) if (s.text) removed.push({ kind: 'Page text', page: p, text: s.text });
    if (imagesHit) removed.push({ kind: 'Images', detail: `${imagesHit} image${imagesHit === 1 ? '' : 's'} under the marks ${o.images === 'blank-pixels' ? 'had the covered pixels blanked' : 'removed'}` });

    let labels = 0;
    if (label && o.fill) for (const [i, pm] of byPage) labels += drawLabels(mupdf, pdf, pdf.loadPage(i), pm, label);
    scrubStrings(pdf, scrubRes, removed);
    scrubMarkedContent(pdf, scrubRes, removed);

    const saved = pdf.saveToBuffer('garbage=4,compress=yes,clean=yes,encrypt=none').asUint8Array().slice();
    pdf.destroy?.();
    if (info.encrypted) removed.push({ kind: 'Encryption', detail: 'Saved without a password. Use Protect to add one again.' });
    if (info.signed) removed.push({ kind: 'Digital signature', detail: 'Removed, since redaction invalidates it' });
    const cleaned = await cleanFile(saved, 'redacted.pdf', { removeSignatures: info.signed });
    if (!cleaned.ok) return refuse('clean', `The redacted file could not be cleaned of metadata, so it was not produced. ${cleaned.reason ?? ''}`.trim());
    for (const r of cleaned.removed ?? []) removed.push({ kind: r.kind, detail: r.container || '' });

    const verification = verifyRedaction(mupdf, cleaned.data, { pages: info.pages.length, marks: list, plan, label: labels ? label : '', labels, mode: o.mode, images: o.images, fill: !!o.fill });
    if (!verification.ok) return refuse('verification', `The check afterwards found redacted content still in the file, so it was not produced: ${verification.leftovers.map((l) => `${l.kind}${l.text ? ` "${clip(l.text)}"` : ''}`).slice(0, 3).join('; ')}.`, verification);
    return { ok: true, data: cleaned.data, removed: dedupe(removed), verification, pages: info.pages.length, encrypted: info.encrypted, signed: info.signed };
  } catch (error) {
    if (error instanceof RedactError) return refuse(error.code, error.message);
    return refuse('failed', `The PDF could not be redacted: ${error?.message ?? 'unknown error'}. Nothing was changed.`);
  }
}

const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const refuse = (code, reason, verification) => ({ ok: false, code, reason, ...(verification ? { verification } : {}) });
const isAxisRect = (q) => q[1] === q[3] && q[5] === q[7] && q[0] === q[4] && q[2] === q[6];

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Form fields under a mark, and fields whose value holds a redacted string, are emptied. Their appearance
// is regenerated, so the old value is not drawn any more either.
function clearWidgets(page, pm, scrubRes, removed, i) {
  for (const w of safe(() => page.getWidgets(), [])) {
    let value = '';
    try { value = w.getValue() ?? ''; } catch { continue; }
    if (!value) continue;
    const r = Array.from(w.getBounds());
    const under = pm.some((m) => hits(r, m.rects));
    const holds = scrubRes.some((s) => { s.re.lastIndex = 0; return s.re.test(value); });
    if (!under && !holds) continue;
    try {
      if (w.isText()) w.setTextValue('');
      else if (w.isChoice()) w.setChoiceValue('');
      else continue;
      w.update();
      removed.push({ kind: 'Form field value', page: i + 1, text: value.slice(0, 200) });
    } catch { /* left for the check afterwards */ }
  }
}

const KEY_KIND = { Title: 'Title', T: 'Name', TU: 'Form field tooltip', V: 'Form field value', DV: 'Form field default', Alt: 'Alternate text', ActualText: 'Actual text', E: 'Abbreviation expansion', Contents: 'Annotation text', URI: 'Link address', P: 'Page label', Subject: 'Subject', Author: 'Author', Keywords: 'Keywords' };

function scrubText(s, scrubRes) {
  let out = s; let found = null;
  for (const r of scrubRes) { r.re.lastIndex = 0; if (r.re.test(out)) { found ??= r.text; r.re.lastIndex = 0; out = out.replace(r.re, REPLACEMENT); } }
  return found ? { out, found } : null;
}

// Every text string in the document's objects (outline titles, form values, structure tree alternate and
// actual text, page labels, link addresses, document info) that holds a redacted string has it replaced.
function scrubStrings(pdf, scrubRes, removed) {
  if (!scrubRes.length) return;
  const total = pdf.countObjects();
  let visited = 0;
  const walk = (o, key, depth, owner, ownerKey) => {
    if (depth > 40 || ++visited > 2000000) return;
    if (o.isString()) {
      const s = o.asString();
      const hit = scrubText(s, scrubRes);
      if (hit && owner) { owner.put(ownerKey, pdf.newString(hit.out)); removed.push({ kind: KEY_KIND[ownerKey] ?? 'Text string', text: hit.found }); }
      return;
    }
    if (o.isIndirect()) return;
    if (o.isArray()) { for (let i = 0; i < o.length; i++) walk(o.get(i), key, depth + 1, o, i); return; }
    if (o.isDictionary()) { const keys = []; o.forEach((v, k) => keys.push(k)); for (const k of keys) walk(o.get(k), k, depth + 1, o, k); }
  };
  for (let num = 1; num < total; num++) {
    const ref = obj(() => pdf.newIndirect(num));
    if (!ref) continue;
    const o = obj(() => ref.resolve());
    if (!o || o.isNull()) continue;
    if (o.isString()) continue; // an indirect string has no owner to update; the check afterwards reports it
    if (o.isArray() || o.isDictionary()) walk(o, null, 0, null, null);
  }
}

function streamKind(o) {
  const type = o.get('Type'); const sub = o.get('Subtype');
  const t = type.isName() ? type.asName() : ''; const s = sub.isName() ? sub.asName() : '';
  if (s === 'Image' || t === 'XRef' || t === 'ObjStm' || t === 'Metadata' || t === 'EmbeddedFile') return 'skip';
  if (o.get('Length1').isNumber() || o.get('Length2').isNumber() || ['Type1C', 'CIDFontType0C', 'OpenType'].includes(s)) return 'font';
  return 'content';
}

// Marked-content property lists written inline in content streams (/Span <</ActualText (...)>> BDC) are
// not objects, so they are rewritten in the stream itself.
function scrubMarkedContent(pdf, scrubRes, removed) {
  if (!scrubRes.length) return;
  const total = pdf.countObjects();
  for (let num = 1; num < total; num++) {
    // Stream data is reached through the indirect reference; resolve() keeps only the dictionary.
    const o = obj(() => pdf.newIndirect(num));
    if (!o || !safe(() => o.isStream(), false) || streamKind(o) !== 'content') continue;
    let data;
    try { data = o.readStream().asUint8Array().slice(); } catch { continue; }
    if (data.length > 64 * 1048576 || indexOf(data, 'BDC') < 0) continue;
    const edits = [];
    const p = new Parser(data);
    let last = null; let count = 0;
    for (;;) {
      let v; let start;
      try { p.skip(); if (p.pos >= p.end) break; start = p.pos; v = p.value(); } catch (error) { if (error instanceof PdfError) break; throw error; }
      if (++count > 2000000) break;
      if (v instanceof Keyword) {
        if ((v.word === 'BDC' || v.word === 'DP') && last && last.v instanceof Dict) {
          const hit = scrubDict(last.v, scrubRes);
          if (hit) { edits.push([last.start, last.end, serialize(last.v)]); removed.push({ kind: 'Marked content text', text: hit }); }
        }
        if (v.word === 'BI') { const at = indexOf(data, 'EI', p.pos); p.pos = at < 0 ? p.end : at + 2; }
        last = null;
      } else last = { v, start, end: p.pos };
    }
    if (!edits.length) continue;
    const parts = []; let at = 0;
    for (const [s, e, text] of edits) { parts.push(data.subarray(at, s), latin1Bytes(text)); at = e; }
    parts.push(data.subarray(at));
    const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0)); let k = 0;
    for (const x of parts) { out.set(x, k); k += x.length; }
    try { o.writeStream(out); } catch { /* left for the check afterwards */ }
  }
}

function scrubDict(d, scrubRes, depth = 0) {
  let found = null;
  if (depth > 16) return null;
  for (const [k, v] of d) {
    if (v instanceof Str) {
      const s = decodeText(v.bytes);
      const hit = scrubText(s, scrubRes);
      if (hit) { found ??= hit.found; d.set(k, new Str(textBytes(hit.out))); }
    } else if (v instanceof Dict) found ??= scrubDict(v, scrubRes, depth + 1);
  }
  return found;
}

// PDF text string bytes: PDFDocEncoding when the text is Latin-1, otherwise UTF-16BE with a byte order mark.
function textBytes(s) {
  if (/^[\x00-\xff]*$/.test(s)) return latin1Bytes(s);
  const out = [0xfe, 0xff];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out.push(c >> 8, c & 0xff); }
  return Uint8Array.from(out);
}

function latin1Bytes(s) { const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff; return u8; }

function indexOf(u8, word, from = 0) {
  const w = latin1Bytes(word);
  outer: for (let i = from; i <= u8.length - w.length; i++) { for (let j = 0; j < w.length; j++) if (u8[i + j] !== w[j]) continue outer; return i; }
  return -1;
}

// Draws the page as an image with the marks burned in.
function rasterPage(mupdf, pdf, index, pm, dpi, fill) {
  const page = pdf.loadPage(index);
  const scale = dpi / 72;
  const bounds = Array.from(page.getBounds());
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const draw = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pix);
  for (const m of pm) {
    for (const q of m.quads) {
      const path = new mupdf.Path();
      path.moveTo(q[0], q[1]); path.lineTo(q[2], q[3]); path.lineTo(q[6], q[7]); path.lineTo(q[4], q[5]); path.closePath();
      draw.fillPath(path, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, fill ? [0, 0, 0] : [1, 1, 1], 1);
      // Burn the bounding box too, so antialiasing at a slanted edge cannot leave a sliver.
      const r = quadRect(q); const box = new mupdf.Path(); box.rect(r[0], r[1], r[2], r[3]);
      draw.fillPath(box, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, fill ? [0, 0, 0] : [1, 1, 1], 1);
    }
  }
  draw.close(); draw.destroy?.();
  const jpeg = pix.asJPEG(90, false).slice();
  pix.destroy?.();
  return { jpeg, bounds };
}

// Replaces a page's content with the rasterized image. Its annotations and form fields go too, since what
// they showed is in the image.
function replaceWithImage(mupdf, pdf, page, raster) {
  const po = page.getObject();
  const [x0, y0, x1, y1] = raster.bounds; const w = x1 - x0; const h = y1 - y0;
  removePageAnnotations(pdf, po);
  const image = new mupdf.Image(raster.jpeg);
  const ref = pdf.addImage(image);
  const resources = pdf.addObject(pdf.newDictionary());
  const xo = pdf.newDictionary(); xo.put('Im0', ref); resources.put('XObject', xo);
  const contents = pdf.addStream(`q ${num(w)} 0 0 ${num(h)} 0 0 cm /Im0 Do Q\n`, pdf.newDictionary());
  po.put('MediaBox', [0, 0, w, h]);
  for (const k of ['CropBox', 'TrimBox', 'BleedBox', 'ArtBox', 'UserUnit', 'Group', 'Thumb', 'PieceInfo', 'B', 'VP']) po.delete(k);
  po.put('Rotate', 0);
  po.put('Resources', resources);
  po.put('Contents', contents);
}

function removePageAnnotations(pdf, po) {
  const annots = po.get('Annots');
  const nums = new Set();
  if (annots.isArray()) annots.forEach((a) => { if (a.isIndirect()) nums.add(a.asIndirect()); });
  po.delete('Annots');
  if (!nums.size) return;
  const form = obj(() => pdf.getTrailer().get('Root').get('AcroForm'));
  const prune = (arr, depth) => {
    if (!arr?.isArray() || depth > 32) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr.get(i);
      if (item.isIndirect() && nums.has(item.asIndirect())) { arr.delete(i); continue; }
      const d = item.resolve();
      if (d.isDictionary()) {
        prune(d.get('Kids'), depth + 1);
        const kids = d.get('Kids');
        if (kids.isArray() && kids.length === 0) arr.delete(i);
      }
    }
  };
  if (form && form.isDictionary()) prune(form.get('Fields'), 0);
}

const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));

// Writes the label (such as "[REDACTED]") in white inside each black box that is big enough.
function drawLabels(mupdf, pdf, page, pm, label) {
  const font = new mupdf.Font('Helvetica');
  const po = page.getObject();
  let res = po.get('Resources');
  if (!res.isDictionary()) { const inherited = po.getInheritable('Resources'); res = pdf.newDictionary(); if (inherited.isDictionary()) inherited.forEach((v, k) => res.put(k, v)); po.put('Resources', res); }
  let fonts = res.get('Font');
  if (!fonts.isDictionary()) { fonts = pdf.newDictionary(); res.put('Font', fonts); }
  if (fonts.get(LABEL_FONT).isNull()) fonts.put(LABEL_FONT, pdf.addSimpleFont(font, 'Latin'));
  let width = 0;
  for (const ch of label) width += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)), 0);
  const toUser = mupdf.Matrix.invert(page.getTransform());
  let ops = ''; let n = 0;
  for (const m of pm) {
    const r = m.rect; const bw = r[2] - r[0]; const bh = r[3] - r[1];
    const size = Math.min(bh * 0.7, 14, (bw * 0.9) / Math.max(width, 0.1));
    if (size < 4) continue;
    const x = r[0] + (bw - width * size) / 2; const y = r[1] + bh / 2 + size * 0.35;
    // Text space in page space (y down), then into the page's own coordinates.
    const tm = concat([size, 0, 0, -size, x, y], toUser);
    ops += `BT /${LABEL_FONT} 1 Tf 1 g ${tm.map(num).join(' ')} Tm (${label.replace(/[()\\]/g, '\\$&')}) Tj ET\n`;
    n++;
  }
  if (!n) return 0;
  const contents = po.get('Contents');
  const list = pdf.newArray();
  list.push(pdf.addStream('q\n', pdf.newDictionary()));
  if (contents.isArray()) contents.forEach((c) => list.push(c)); else if (!contents.isNull()) list.push(contents);
  list.push(pdf.addStream(`Q\nq\n${ops}Q\n`, pdf.newDictionary()));
  po.put('Contents', list);
  return n;
}

// ---------- Verification ----------

// Opens the finished file and checks that none of the redacted text is left: not in the text of any page,
// not in any object's strings, not in any decompressed stream, that the page count is unchanged, that the
// file is one revision without encryption or unapplied marks, and that images show nothing under the marks.
export function verifyRedaction(mupdf, data, { pages, marks, plan, label = '', labels = 0, mode = 'remove', images = 'blank-pixels', fill = true }) {
  const leftovers = []; const checks = [];
  let pdf;
  try { pdf = openPdf(mupdf, data); } catch { return { ok: false, leftovers: [{ kind: 'The redacted file does not open' }], checks }; }
  try {
    const n = pdf.countPages();
    if (n !== pages) leftovers.push({ kind: `Page count changed from ${pages} to ${n}` });
    else checks.push(`All ${n} page${n === 1 ? '' : 's'} are still there`);
    showAllLayers(pdf);

    // Page text.
    let full = '';
    for (let i = 0; i < n; i++) full += `${pageLines(pdf.loadPage(i), STEXT_ALL).map((l) => l.map((c) => c.c).join('')).join('\n')}\n\n`;
    const fullN = norm(full);
    const elsewhere = []; const scan = [];
    for (const s of plan.strings) {
      const allowed = s.unmarked + (label ? count(norm(label), s.text) * labels : 0);
      const found = count(fullN, s.text);
      if (found > allowed) leftovers.push({ kind: 'Page text', text: s.text, found: found - allowed });
      if (!s.scrub) continue;
      const re = scrubPattern(s.text);
      // Still shown where no mark covered it: the raw scan cannot tell those apart, so it is reported instead.
      const shown = fullN.match(re)?.length ?? 0;
      if (shown) elsewhere.push({ text: s.text, count: shown });
      else if (!(label && scrubPattern(s.text).test(label))) scan.push({ text: s.text, re });
    }
    checks.push('None of the redacted text is in the text of any page');

    // Strings and streams in every object.
    const found = new Map();
    const test = (text, where) => {
      for (const s of scan) { s.re.lastIndex = 0; if (s.re.test(text) && !found.has(s.text + where)) found.set(s.text + where, { kind: where, text: s.text }); }
    };
    const total = pdf.countObjects();
    let visited = 0;
    const walk = (o, depth) => {
      if (depth > 40 || ++visited > 3000000) return;
      if (o.isString()) { const b = o.asByteString(); test(decodeText(b), 'Text string in the file'); test(latin(b), 'Text string in the file'); return; }
      if (o.isIndirect()) return;
      if (o.isArray()) { for (let i = 0; i < o.length; i++) walk(o.get(i), depth + 1); return; }
      if (o.isDictionary()) o.forEach((v) => walk(v, depth + 1));
    };
    let streams = 0;
    for (let num = 1; num < total && scan.length; num++) {
      const ref = obj(() => pdf.newIndirect(num));
      const o = obj(() => ref?.resolve());
      if (!o) continue;
      if (safe(() => ref.isStream(), false)) {
        walk(o, 0);
        if (streamKind(o) !== 'content' && !isXmp(o)) continue;
        let u8;
        try { u8 = ref.readStream().asUint8Array().slice(); } catch { leftovers.push({ kind: 'A stream in the file could not be read to check it' }); continue; }
        streams++;
        test(latin(u8), 'Stream data');
        test(new TextDecoder('utf-8', { fatal: false }).decode(u8), 'Stream data');
        if (u8.length < 32 * 1048576) test(streamStrings(u8), 'Text drawn in a content stream');
      } else walk(o, 0);
    }
    if (scan.length) {
      test(latin(data), 'Raw file bytes');
      checks.push(`No redacted string is in the file's ${total - 1} objects, ${streams} decompressed streams or raw bytes`);
    }
    for (const f of found.values()) leftovers.push(f);

    // Structure.
    const raw = latin(data);
    const revisions = (raw.match(/startxref/g) ?? []).length;
    if (revisions !== 1 || /\/Prev\s/.test(raw)) leftovers.push({ kind: 'The file still holds earlier revisions' }); else checks.push('The file is one revision with no earlier versions inside');
    if (/\/Encrypt\b/.test(raw)) leftovers.push({ kind: 'The file is still encrypted' });
    let marksLeft = 0;
    for (let i = 0; i < n; i++) for (const a of safe(() => pdf.loadPage(i).getAnnotations(), [])) if (safe(() => a.getType(), '') === 'Redact') marksLeft++;
    if (marksLeft) leftovers.push({ kind: `${marksLeft} redaction mark${marksLeft === 1 ? ' was' : 's were'} not applied` });

    // Images under the marks.
    if (mode === 'rasterize' || images !== 'none') {
      const byPage = new Map();
      for (const m of marks) { if (!byPage.has(m.page)) byPage.set(m.page, []); byPage.get(m.page).push(...m.rects); }
      let bad = 0; let checked = 0;
      for (const [i, rects] of byPage) {
        const result = safe(() => imageInk(mupdf, pdf.loadPage(i), rects), null);
        if (!result) { leftovers.push({ kind: 'Images on a marked page could not be checked', page: i + 1 }); continue; }
        result.forEach((r) => {
          if (r === false) return;
          checked++;
          if (r === null || r.ink) bad++;
          else if (mode === 'rasterize' && fill && r.mean > 40) bad++;
        });
        if (bad) leftovers.push({ kind: 'Image content still shows under a mark', page: i + 1 });
        bad = 0;
      }
      if (checked) checks.push(mode === 'rasterize' ? 'The rasterized pages show only the boxes under the marks' : 'No image shows anything under the marks');
    }
    return { ok: leftovers.length === 0, leftovers, checks, elsewhere, strings: plan.strings.map((s) => s.text) };
  } finally { pdf.destroy?.(); }
}

const latin = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return s; };

function isXmp(o) { const t = o.get('Type'); return t.isName() && t.asName() === 'Metadata'; }

// The strings a content stream shows, joined within each text object, so that text split by kerning
// ([(Jo) -20 (hn)] TJ) reads as one.
function streamStrings(u8) {
  const p = new Parser(u8); let out = ''; let count = 0;
  const take = (v) => { if (v instanceof Str) out += decodeText(v.bytes); else if (Array.isArray(v)) for (const x of v) take(x); };
  for (;;) {
    let v;
    try { p.skip(); if (p.pos >= p.end) break; v = p.value(); } catch (error) { if (error instanceof PdfError) break; throw error; }
    if (++count > 2000000) break;
    if (v instanceof Keyword) {
      if (v.word === 'ET') out += '\n';
      if (v.word === 'BI') { const at = indexOf(u8, 'EI', p.pos); p.pos = at < 0 ? p.end : at + 2; }
      continue;
    }
    take(v);
    if (v instanceof Dict) for (const x of v.values()) take(x);
  }
  return out;
}

// ---------- Helpers ----------

function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
function obj(fn) { try { const o = fn(); return o && !o.isNull() ? o : null; } catch { return null; } }
