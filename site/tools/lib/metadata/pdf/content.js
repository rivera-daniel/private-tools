// A rough reading of page content for one pattern: text or images painted first and then covered by a
// filled black rectangle, which is how a failed redaction looks. It is a clue, never a verdict.
import { Parser, Keyword, Str, Name, PdfError, indexOfBytes } from './syntax.js';

const MAX_OPS = 1000000;
const MAX_MARKS = 50000;
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const ID = [1, 0, 0, 1, 0, 0];

function box(m, x, y, w, h) {
  const pts = [apply(m, x, y), apply(m, x + w, y), apply(m, x, y + h), apply(m, x + w, y + h)];
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const isBlack = (ops) => {
  const v = ops.filter((x) => typeof x === 'number');
  if (ops.some((x) => x instanceof Name) || !v.length) return false;
  if (v.length === 1) return v[0] <= 0.05;
  if (v.length === 3) return v.every((x) => x <= 0.05);
  if (v.length === 4) return (v[3] >= 0.95 && v.slice(0, 3).every((x) => x <= 0.05)) || v.every((x) => x >= 0.9);
  return false;
};

// isImage(name) tells whether a /Do operand names an image XObject.
export function coveredContent(u8, { isImage = () => false, pageArea = Infinity } = {}) {
  const p = new Parser(u8);
  let ctm = ID; let black = true; const stack = []; let path = [];
  let tm = ID; let tlm = ID; let leading = 0;
  const texts = []; const images = []; const covers = [];
  let ops = []; let seq = 0; let count = 0;
  const showText = (strings) => { if (texts.length < MAX_MARKS) { const [x, y] = apply(mul(tm, ctm), 0, 0); texts.push({ x, y, seq: seq++, strings }); } };
  for (;;) {
    let v;
    try { p.skip(); if (p.pos >= p.end) break; v = p.value(); } catch (error) { if (error instanceof PdfError) break; throw error; }
    if (!(v instanceof Keyword)) { if (ops.length < 64) ops.push(v); continue; }
    if (++count > MAX_OPS) break;
    const n = ops.map((x) => (typeof x === 'number' ? x : 0));
    switch (v.word) {
      case 'q': if (stack.length < 64) stack.push([ctm, black]); break;
      case 'Q': if (stack.length) [ctm, black] = stack.pop(); break;
      case 'cm': if (n.length >= 6) ctm = mul(n.slice(-6), ctm); break;
      case 'g': case 'rg': case 'k': case 'sc': case 'scn': black = isBlack(ops); break;
      case 'cs': black = true; break;
      case 're': if (n.length >= 4 && path.length < 1000) path.push(box(ctm, ...n.slice(-4))); break;
      case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
        if (black) for (const r of path) if (covers.length < MAX_MARKS) covers.push({ ...r, seq: seq++ });
        path = []; break;
      case 'n': case 'S': case 's': path = []; break;
      case 'BT': tm = ID; tlm = ID; break;
      case 'Tm': if (n.length >= 6) { tm = n.slice(-6); tlm = tm; } break;
      case 'Td': case 'TD': if (n.length >= 2) { if (v.word === 'TD') leading = -n.at(-1); tlm = mul([1, 0, 0, 1, n.at(-2), n.at(-1)], tlm); tm = tlm; } break;
      case 'TL': if (n.length) leading = n.at(-1); break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break;
      case 'Tj': showText(ops.filter((x) => x instanceof Str)); break;
      case 'TJ': showText((Array.isArray(ops.at(-1)) ? ops.at(-1) : []).filter((x) => x instanceof Str)); break;
      case "'": case '"': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; showText(ops.filter((x) => x instanceof Str)); break;
      case 'Do': if (ops.at(-1) instanceof Name && isImage(ops.at(-1).name) && images.length < MAX_MARKS) images.push({ ...box(ctm, 0, 0, 1, 1), seq: seq++ }); break;
      case 'BI': { const at = indexOfBytes(u8, 'EI', p.pos); p.pos = at < 0 ? p.end : at + 2; break; }
      default: break;
    }
    ops = [];
  }
  const hit = new Set(); let hitImages = 0;
  const boxes = covers.filter((c) => { const w = c.x1 - c.x0; const h = c.y1 - c.y0; return w >= 4 && h >= 4 && w * h <= pageArea * 0.6; }).slice(0, 500);
  for (const c of boxes) {
    const w = c.x1 - c.x0; const h = c.y1 - c.y0;
    for (const t of texts) if (t.seq < c.seq && t.x >= c.x0 - 1 && t.x <= c.x1 + 1 && t.y >= c.y0 - 1 && t.y <= c.y1 + 1) hit.add(t);
    for (const im of images) {
      if (im.seq > c.seq) continue;
      const ix = Math.max(0, Math.min(im.x1, c.x1) - Math.max(im.x0, c.x0)); const iy = Math.max(0, Math.min(im.y1, c.y1) - Math.max(im.y0, c.y0));
      if (ix * iy >= w * h * 0.5) { hitImages++; break; }
    }
  }
  return { texts: [...hit].sort((a, b) => a.seq - b.seq), images: hitImages };
}

// Covered text when it reads as plain text, which holds only for simple single-byte fonts.
export function snippet(texts) {
  let s = '';
  for (const t of texts) { for (const x of t.strings) s += String.fromCharCode(...x.bytes.subarray(0, 200)); s += ' '; if (s.length > 400) break; }
  s = s.replace(/\s+/g, ' ').trim();
  const printable = s.replace(/[^\x20-\x7e]/g, '').length;
  return s && printable / s.length > 0.9 ? s.slice(0, 120) : '';
}
