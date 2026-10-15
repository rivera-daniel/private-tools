// Pixel budget for every rasterization of a PDF page or image. The size of the bitmap is worked out from
// the page bounds and the transform before anything is drawn, so a page that claims to be 100,000 points
// wide cannot make the renderer ask for gigabytes. Pure arithmetic: no MuPDF, no DOM.

export const RENDER_PIXELS = 40e6;   // full-size renders: exports, redaction, the rasterized pages
export const PREVIEW_PIXELS = 16e6;  // pages shown on screen
export const THUMB_PIXELS = 2e6;     // page thumbnails
export const MAX_SIDE = 16384;       // longest side of any bitmap, in pixels

export class RenderSizeError extends Error {}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// The bitmap size MuPDF allocates for `bounds` drawn through `matrix` ([a b c d e f]): the transformed
// rectangle rounded out to whole pixels.
export function pixelSize(bounds, matrix = [1, 0, 0, 1, 0, 0]) {
  if (!Array.isArray(bounds) && !ArrayBuffer.isView(bounds)) throw new RenderSizeError('The page has no size.');
  const [x0, y0, x1, y1] = Array.from(bounds);
  if (![x0, y0, x1, y1].every(finite) || !(x1 > x0) || !(y1 > y0)) throw new RenderSizeError('The page size is not valid, so it cannot be drawn.');
  const [a, b, c, d, e, f] = Array.from(matrix);
  if (![a, b, c, d, e, f].every(finite)) throw new RenderSizeError('The drawing scale is not valid.');
  const xs = []; const ys = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) { xs.push(a * x + c * y + e); ys.push(b * x + d * y + f); }
  const width = Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs));
  const height = Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys));
  if (!finite(width) || !finite(height)) throw new RenderSizeError('The page is too large to draw.');
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

const within = (s, max, maxSide) => s.width * s.height <= max && s.width <= maxSide && s.height <= maxSide;

// The scale to draw `bounds` at: `scale`, or less when the bitmap would exceed maxPixels or maxSide.
// rotate is in degrees (added on top of the bounds, which already include the page's own rotation).
// Returns { scale, width, height, clamped }. Throws RenderSizeError for bounds or a scale that is not a
// positive finite number.
export function fitScale(bounds, scale, { rotate = 0, maxPixels = RENDER_PIXELS, maxSide = MAX_SIDE } = {}) {
  if (!finite(scale) || scale <= 0) throw new RenderSizeError('The drawing scale is not valid.');
  if (!finite(rotate)) throw new RenderSizeError('The rotation is not valid.');
  const r = (rotate * Math.PI) / 180;
  const cos = Math.round(Math.cos(r) * 1e9) / 1e9; const sin = Math.round(Math.sin(r) * 1e9) / 1e9;
  const at = (s) => pixelSize(bounds, [s * cos, s * sin, -s * sin, s * cos, 0, 0]);
  let s = scale; let size = at(s);
  if (within(size, maxPixels, maxSide)) return { scale: s, ...size, clamped: false };
  // One step to the right neighbourhood, then shrink a little at a time to absorb the rounding.
  s *= Math.min(Math.sqrt(maxPixels / (size.width * size.height)), maxSide / Math.max(size.width, size.height));
  size = at(s);
  for (let i = 0; i < 64 && !within(size, maxPixels, maxSide); i++) { s *= 0.97; size = at(s); }
  if (!within(size, maxPixels, maxSide) || !(s > 0)) throw new RenderSizeError('The page is too large to draw.');
  return { scale: s, ...size, clamped: true };
}

// True when a width x height bitmap fits the budget.
export function fitsPixels(width, height, { maxPixels = RENDER_PIXELS, maxSide = MAX_SIDE } = {}) {
  return finite(width) && finite(height) && width > 0 && height > 0 && width * height <= maxPixels && width <= maxSide && height <= maxSide;
}
