// Redaction worker for the PDF Editor: search, the fake-redaction check, page rendering and redaction run
// here, off the page's thread, with MuPDF in WebAssembly. Nothing leaves the device.
//
// MuPDF finishes loading with a top-level await. Messages that arrive meanwhile would be lost if the handler
// were set after it, so the handler is set first and the engine is imported dynamically.
let mupdf; let R;
const ready = Promise.all([import('/tools/vendor/mupdf/mupdf.js'), import('/tools/lib/pdf-editor/redact.js')]).then(([m, r]) => { mupdf = m; R = r; mupdf.setLog(() => {}); });
let state = null; // { bytes, password, doc, view }

const need = () => { if (!state) throw new R.RedactError('No document is open.', 'closed'); return state; };

// The page as an ImageBitmap at the given scale, in the same orientation as the page bounds.
async function render(page, scale) {
  const p = need().view.loadPage(page);
  const s = Math.max(0.1, Math.min(scale, 6));
  const pix = p.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
  const w = pix.getWidth(); const h = pix.getHeight(); const stride = pix.getStride();
  const src = pix.getPixels();
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0, o = y * stride, d = y * w * 4; x < w; x++, o += 3, d += 4) { rgba[d] = src[o]; rgba[d + 1] = src[o + 1]; rgba[d + 2] = src[o + 2]; rgba[d + 3] = 255; }
  }
  pix.destroy?.();
  return createImageBitmap(new ImageData(rgba, w, h));
}

const ops = {
  open({ bytes, password = '' }) {
    state?.doc?.destroy?.(); state?.view?.destroy?.();
    state = null;
    const doc = R.openPdf(mupdf, bytes, password);
    // Pages are drawn as a reader shows them; search and redaction also see hidden layers.
    const view = R.openPdf(mupdf, bytes, password);
    state = { bytes, password, doc, view };
    const info = R.documentInfo(doc);
    R.showAllLayers(doc);
    return info;
  },
  check() { return R.checkRedactions(mupdf, need().doc); },
  search({ query, options }) { return R.findText(need().doc, query, options); },
  preflight({ marks }) {
    const { doc } = need();
    const list = R.normalizeMarks(marks, R.pageInfo(doc));
    const plan = R.planRedaction(doc, list);
    return { strings: plan.strings, misses: plan.misses, other: R.otherOccurrences(doc, list, plan) };
  },
  async redact({ marks, options }) {
    const { bytes, password } = need();
    const r = await R.redact(mupdf, bytes, marks, { ...options, password });
    if (r.ok) r.data = r.data.slice();
    return r;
  },
  render({ page, scale }) { return render(page, scale); },
};

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    await ready;
    // Lets the page time a request from when it starts rather than from when it was queued.
    if (data.timed) self.postMessage({ id, started: true });
    if (!Object.hasOwn(ops, op)) throw new R.RedactError('Unknown request.', 'op');
    const result = await ops[op](data);
    const transfer = [];
    if (result?.data instanceof Uint8Array) transfer.push(result.data.buffer);
    if (typeof ImageBitmap !== 'undefined' && result instanceof ImageBitmap) transfer.push(result);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: { message: error?.message || 'Something went wrong. The file may be damaged.', code: error?.code ?? 'failed' } });
  }
};
