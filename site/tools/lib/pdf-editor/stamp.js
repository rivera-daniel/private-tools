// Text stamped on pages: watermarks and page numbers or header and footer text. Uses Helvetica, one of the
// 14 fonts every PDF reader has, so no font file is embedded. Text is placed in the page as it is shown,
// so it reads upright on rotated pages too.
import { mupdf, PdfError } from './index.js';
import { formatPageLabel } from './ranges.js';
import { winAnsi } from './text.js';

export { winAnsi, isLatin } from './text.js';

const COLORS = { gray: '0.5 g', black: '0 g', red: '0.74 0.06 0.17 rg' };
const fmt = (n) => (Math.abs(n) < 1e-6 ? '0' : Number(n.toFixed(4)).toString());

function textWidth(font, shown, size) {
  let w = 0;
  for (const ch of shown) w += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)));
  return w * size;
}

function uniqueName(dict, prefix) {
  for (let n = 1; ; n++) if (dict.get(`${prefix}${n}`).isNull()) return `${prefix}${n}`;
}

// The page's resources become its own, with copies of the Font and ExtGState dictionaries, so adding to
// them never changes another page that shared them.
function ownResources(doc, pageObj) {
  const inherited = pageObj.getInheritable('Resources');
  const res = doc.newDictionary();
  if (inherited.isDictionary()) inherited.forEach((v, k) => res.put(k, v));
  for (const key of ['Font', 'ExtGState']) {
    const copy = doc.newDictionary(); const old = res.get(key);
    if (old.isDictionary()) old.forEach((v, k) => copy.put(k, v));
    res.put(key, copy);
  }
  pageObj.put('Resources', res);
  return res;
}

// Appends drawing to a page, with the existing content wrapped in q/Q so its graphics state cannot leak.
function appendContent(doc, pageObj, ops) {
  const old = pageObj.get('Contents');
  const list = doc.newArray();
  list.push(doc.addStream('q\n', {}));
  if (old.isArray()) old.forEach((v) => list.push(v)); else if (!old.isNull()) list.push(old);
  list.push(doc.addStream(`Q\n${ops}`, {}));
  pageObj.put('Contents', list);
}

// Places one line of text on every chosen page. place(bounds, width, height, index) returns
// { x, y, angle } in the page's displayed space: the text's center, top-left origin, counterclockwise angle.
function stampText(doc, { pages, fontName = 'Helvetica', size, opacity = 1, color = 'black', lines, place }) {
  const font = new mupdf.Font(fontName);
  const fontRef = doc.addSimpleFont(font, 'Latin');
  const count = doc.countPages();
  const targets = (pages ?? Array.from({ length: count }, (_, i) => i)).filter((i) => i >= 0 && i < count);
  for (const index of targets) {
    const text = lines(index);
    if (!text) continue;
    const { codes, shown } = winAnsi(text);
    const width = textWidth(font, shown, size);
    const page = doc.loadPage(index);
    try {
      const bounds = page.getBounds(); const ctm = page.getTransform();
      const pageObj = page.getObject();
      const res = ownResources(doc, pageObj);
      const fname = uniqueName(res.get('Font'), 'PTF'); res.get('Font').put(fname, fontRef);
      const gs = doc.newDictionary(); gs.put('ca', opacity); gs.put('CA', opacity);
      const gname = uniqueName(res.get('ExtGState'), 'PTG'); res.get('ExtGState').put(gname, gs);
      const { x, y, angle } = place(bounds, width, size, index);
      // Text space (y up, centered on the text) to displayed space (y down), then to PDF user space.
      let m = mupdf.Matrix.translate(-width / 2, -size * 0.35);
      m = mupdf.Matrix.concat(m, [1, 0, 0, -1, 0, 0]);
      m = mupdf.Matrix.concat(m, mupdf.Matrix.rotate(-angle));
      m = mupdf.Matrix.concat(m, mupdf.Matrix.translate(x, y));
      m = mupdf.Matrix.concat(m, mupdf.Matrix.invert(ctm));
      const hex = codes.map((c) => c.toString(16).padStart(2, '0')).join('');
      appendContent(doc, pageObj, `q /${gname} gs ${COLORS[color] ?? COLORS.black} BT /${fname} ${fmt(size)} Tf ${m.map(fmt).join(' ')} Tm <${hex}> Tj ET Q\n`);
    } finally { page.destroy(); }
  }
  font.destroy();
  return targets.length;
}

// Half the width and height of the text's box once turned by `angle` degrees.
function extents(width, size, angle) {
  const r = (angle * Math.PI) / 180; const hw = width / 2; const hh = size * 0.6;
  return [Math.abs(Math.cos(r)) * hw + Math.abs(Math.sin(r)) * hh, Math.abs(Math.sin(r)) * hw + Math.abs(Math.cos(r)) * hh];
}

// position: 'center' or '<top|middle|bottom>-<left|center|right>'.
function anchor(bounds, position, ex, ey, margin) {
  const [x0, y0, x1, y1] = bounds;
  const [v, h] = position === 'center' ? ['middle', 'center'] : position.split('-');
  const x = h === 'left' ? x0 + margin + ex : h === 'right' ? x1 - margin - ex : (x0 + x1) / 2;
  const y = v === 'top' ? y0 + margin + ey : v === 'bottom' ? y1 - margin - ey : (y0 + y1) / 2;
  return { x, y };
}

const checkText = (text, what) => {
  if (!String(text ?? '').trim()) throw new PdfError(`Enter the ${what}.`);
};

// options: text, size (points, or 0 to fit the page width), opacity 0-1, rotation degrees counterclockwise,
// position, color ('gray', 'black', 'red'), pages (indexes, default all).
export function addWatermark(doc, { text, size = 0, opacity = 0.25, rotation = 45, position = 'center', color = 'gray', pages, margin = 36 } = {}) {
  checkText(text, 'watermark text');
  const font = new mupdf.Font('Helvetica-Bold');
  const unit = textWidth(font, winAnsi(text).shown, 1); font.destroy();
  return stampText(doc, {
    pages, fontName: 'Helvetica-Bold', opacity, color, size: size || 48, lines: () => text,
    place: (bounds, width, s) => {
      const [ex, ey] = extents(width, s, rotation);
      return { ...anchor(bounds, position, ex, ey, margin), angle: rotation };
    },
    ...(size ? {} : { size: fitSize(doc, pages, unit, rotation) }),
  });
}

// The largest size at which the text fits across the smallest chosen page, between 12 and 120 points.
function fitSize(doc, pages, unit, rotation) {
  let smallest = Infinity;
  const count = doc.countPages();
  for (const i of pages ?? Array.from({ length: count }, (_, k) => k)) {
    if (i < 0 || i >= count) continue;
    const page = doc.loadPage(i); const [x0, y0, x1, y1] = page.getBounds(); page.destroy();
    const r = (Math.abs(rotation) * Math.PI) / 180;
    const span = Math.abs(Math.cos(r)) > 0.01 ? Math.min((x1 - x0) / Math.abs(Math.cos(r)), Math.abs(Math.sin(r)) > 0.01 ? (y1 - y0) / Math.abs(Math.sin(r)) : Infinity) : y1 - y0;
    smallest = Math.min(smallest, span);
  }
  return Math.max(12, Math.min(120, (smallest * 0.7) / Math.max(unit, 0.01)));
}

// options: format with {n} and {total}, position ('<top|bottom>-<left|center|right>'), start (number of the
// first numbered page), from (first page to number, 1-based), size, margin (points), pages (indexes).
export function addPageNumbers(doc, { format = 'Page {n} of {total}', position = 'bottom-center', start = 1, from = 1, size = 10, margin = 28, color = 'black' } = {}) {
  checkText(format, 'page number format');
  const count = doc.countPages();
  const first = Math.max(1, Math.min(Number(from) || 1, count)) - 1;
  const startAt = Number.isFinite(Number(start)) ? Math.trunc(Number(start)) : 1;
  const total = startAt + (count - first) - 1;
  const pages = Array.from({ length: count - first }, (_, k) => first + k);
  return stampText(doc, {
    pages, size, color, lines: (i) => formatPageLabel(format, startAt + i - first, total),
    place: (bounds, width, s) => { const [ex, ey] = extents(width, s, 0); return { ...anchor(bounds, position, ex, ey, margin), angle: 0 }; },
  });
}
