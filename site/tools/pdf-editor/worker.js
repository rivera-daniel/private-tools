// PDF Editor worker: holds the opened files in MuPDF (WebAssembly) and does every PDF operation off the page's
// thread. Files arrive as ArrayBuffers and leave as ArrayBuffers or ImageBitmaps. Nothing is sent anywhere.
// MuPDF loads before the first job; messages that arrive earlier wait in a queue, then 'ready' is posted.
let lib = null;
const queue = [];
let running = false;

const sources = new Map(); // id -> { doc, bytes, password, name }
let nextSource = 1;

const loaded = Promise.all([
  import('/tools/lib/pdf-editor/index.js'),
  import('/tools/lib/pdf-editor/stamp.js'),
  import('/tools/lib/pdf-editor/compress.js'),
  import('/tools/lib/clean/index.js'),
  import('/tools/lib/zip/index.js'),
  import('/tools/lib/pdf-editor/render-guard.js'),
  import('/tools/lib/metadata/index.js'),
]).then(([pdf, stamp, compress, clean, zip, guard, metadata]) => {
  lib = { ...pdf, ...stamp, ...compress, ...guard, cleanFile: clean.cleanFile, writeZip: zip.writeZip, inspectImage: metadata.inspectImage };
  self.postMessage({ type: 'ready' });
}, () => self.postMessage({ type: 'fatal', message: 'The PDF engine could not be loaded. Reload the page to try again.' }));

self.onmessage = ({ data }) => { queue.push(data); pump(); };

async function pump() {
  if (running) return;
  running = true;
  try {
    await loaded;
    if (!lib) return;
    while (queue.length) {
      const data = queue.shift();
      try { await JOBS[data.type](data); }
      catch (error) { self.postMessage({ type: 'error', id: data.id, message: describe(error) }); }
    }
  } finally { running = false; }
}

function describe(error) {
  if (error instanceof lib.PdfError || error instanceof lib.RenderSizeError) return error.message;
  const text = String(error?.message ?? error);
  if (/out of memory|memory access out of bounds|Cannot enlarge memory|Array buffer allocation/i.test(text)) return 'The browser ran out of memory. Try fewer or smaller files.';
  return 'Something went wrong while processing the PDF. The file may be damaged.';
}

const reply = (data, transfer = []) => self.postMessage(data, transfer);
const buffer = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);
const describeSource = (id, s, r) => ({ id, name: s.name, pageCount: r.pageCount, sizes: r.sizes, encrypted: r.encrypted, signed: r.signed, repaired: r.repaired, bytes: s.bytes.length });

function register(name, opened) {
  const id = nextSource++;
  const source = { ...opened.source, name };
  sources.set(id, source);
  return describeSource(id, source, opened);
}

async function open({ id, name, data, password = null }) {
  const opened = lib.openPdf(new Uint8Array(data), password);
  if (opened.needsPassword) { reply({ type: 'password', id, wrongPassword: Boolean(opened.wrongPassword), ownerPassword: Boolean(opened.ownerPassword) }); return; }
  reply({ type: 'opened', id, source: register(name, opened) });
}

// Browsers decode more image formats than MuPDF (WebP, GIF, AVIF and others): those are turned into PNG here.
// The size is read from the file's header first when the format is known, so an image claiming huge
// dimensions is not decoded; the decoded size is checked again before the canvas is made.
async function toPng(data, type) {
  const tooLarge = () => new lib.RenderSizeError('This image is too large to convert.');
  const head = await lib.inspectImage(data).catch(() => ({}));
  if (head.width && head.height && !lib.fitsPixels(head.width, head.height)) throw tooLarge();
  const bitmap = await createImageBitmap(new Blob([data], { type }));
  if (!lib.fitsPixels(bitmap.width, bitmap.height)) { bitmap.close(); throw tooLarge(); }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

async function images({ id, files, pageSize, margin, name }) {
  const prepared = []; const skipped = [];
  for (const file of files) {
    let bytes = new Uint8Array(file.data);
    const kind = lib.imageKind(bytes);
    if (kind !== 'jpeg' && kind !== 'png') {
      try { bytes = await toPng(bytes, file.type); } catch (error) { skipped.push({ name: file.name, reason: error instanceof lib.RenderSizeError ? error.message : 'This browser cannot read this image.' }); continue; }
    }
    prepared.push({ bytes, name: file.name });
  }
  if (!prepared.length) throw new lib.PdfError(skipped.length ? 'None of these images could be read.' : 'Choose at least one image.');
  const made = await lib.imagesToPdf(prepared, { pageSize, margin });
  let bytes;
  try { bytes = lib.saveDocument(made.doc); } finally { made.doc.destroy(); }
  reply({ type: 'opened', id, source: register(name, lib.openPdf(bytes)), skipped: [...skipped, ...made.skipped] });
}

// Thumbnails get a smaller pixel budget than pages shown at full size. Both are checked before drawing.
async function render({ id, src, page, scale, rotate = 0, thumb = false }) {
  const source = sources.get(src);
  if (!source) throw new lib.PdfError('This page is no longer open.');
  const out = lib.renderPage(source.doc, page, scale, rotate, { maxPixels: thumb ? lib.THUMB_PIXELS : lib.PREVIEW_PIXELS });
  const bitmap = await createImageBitmap(new ImageData(out.pixels, out.width, out.height));
  reply({ type: 'rendered', id, bitmap }, [bitmap]);
}

// The working document as bytes, as it would be saved but without cleaning or a password.
async function build({ id, plan }) {
  const bytes = lib.buildBytes(sources, plan, { compress: false });
  reply({ type: 'built', id, data: buffer(bytes) }, [buffer(bytes)]);
}

// The stored bytes of one source, copied, for signing without a rebuild. Sources opened with a password are not
// handed out: their stored bytes are still encrypted.
async function original({ id, src }) {
  const s = sources.get(src);
  const bytes = s && !s.password ? s.bytes.slice() : null;
  reply({ type: 'original', id, data: bytes ? bytes.buffer : null }, bytes ? [bytes.buffer] : []);
}

// View mode: the text lines of a page (for selection and copy) and its links, in page space at 72 dpi with
// the page's own rotation applied and the origin at the top left, before any rotation from the plan.
async function pageText({ id, src, page }) {
  const s = sources.get(src);
  if (!s) throw new lib.PdfError('The file is no longer open.');
  const p = s.doc.loadPage(page);
  try {
    const [x0, y0, x1, y1] = p.getBounds();
    const lines = [];
    const st = p.toStructuredText('preserve-whitespace');
    try {
      const json = JSON.parse(st.asJSON());
      for (const block of json.blocks ?? []) for (const line of block.lines ?? []) {
        if (!line.text?.trim() || lines.length >= 5000) continue;
        const b = line.bbox;
        lines.push({ x: b.x - x0, y: b.y - y0, w: b.w, h: b.h, text: line.text.slice(0, 2000), size: line.font?.size ?? b.h, wmode: line.wmode ?? 0 });
      }
    } finally { st.destroy(); }
    const links = [];
    for (const link of p.getLinks().slice(0, 500)) {
      const [lx0, ly0, lx1, ly1] = link.getBounds();
      const box = { x: lx0 - x0, y: ly0 - y0, w: lx1 - lx0, h: ly1 - ly0 };
      if (link.isExternal()) {
        const url = link.getURI();
        if (/^(https?|mailto):/i.test(url)) links.push({ ...box, url });
      } else {
        let target = -1;
        try { target = s.doc.resolveLink(link); } catch { /* broken destination */ }
        if (target >= 0) links.push({ ...box, target });
      }
    }
    reply({ type: 'text', id, width: x1 - x0, height: y1 - y0, lines, links });
  } finally { p.destroy(); }
}

// Finds text on the pages listed (items: [{ src, page }] in plan order). Quads are in page space as above.
async function search({ id, items, needle }) {
  const hits = []; let total = 0;
  for (let i = 0; i < items.length && total < 2000; i++) {
    const s = sources.get(items[i].src);
    if (!s) continue;
    const p = s.doc.loadPage(items[i].page);
    try {
      const [x0, y0] = p.getBounds();
      for (const hit of p.search(needle, 'ignore-case')) {
        hits.push({ index: i, quads: hit.map((q) => q.map((v, k) => v - (k % 2 ? y0 : x0))) });
        if (++total >= 2000) break;
      }
    } finally { p.destroy(); }
  }
  reply({ type: 'found', id, hits, capped: total >= 2000 });
}

// The bookmarks of a file: [{ title, page, kids }], page being the file's page index or -1.
async function outline({ id, src }) {
  const s = sources.get(src);
  let items = null;
  try { items = s?.doc.loadOutline() ?? null; } catch { items = null; }
  let count = 0;
  const walk = (list, depth) => (list ?? []).filter(() => count++ < 2000 && depth < 16).map((o) => ({ title: String(o.title ?? '').slice(0, 300), page: Number.isInteger(o.page) ? o.page : -1, kids: walk(o.down, depth + 1) }));
  reply({ type: 'outline', id, items: walk(items, 0) });
}

async function adopt({ id, name, data }) {
  const opened = lib.openPdf(new Uint8Array(data));
  if (opened.needsPassword) throw new lib.PdfError('The new document is password protected and cannot be used here.');
  reply({ type: 'opened', id, source: register(name, opened) });
}

// Output: hidden data removed first (the cleaner cannot read encrypted files), then the password added.
// The report says what was removed, what was kept (retained: the hidden part of it) and why cleaning was
// refused, for the page to show and to ask about before anything is downloaded.
async function finish(bytes, name, { clean, protection }) {
  const report = { name, cleaned: false, removed: [], kept: [], retained: [], refused: null, encrypted: false };
  let data = bytes;
  if (clean) {
    const result = await lib.cleanFile(data, name, { removeSignatures: true });
    if (result.ok) {
      report.cleaned = true; report.removed = result.removed ?? []; report.kept = result.kept ?? []; report.retained = result.keptHidden ?? report.kept;
      data = result.data;
      if (!protection) { const packed = lib.resave(data); if (packed.length < data.length) data = packed; }
    } else report.refused = result.reason;
  }
  if (protection) { data = lib.protectPdf(data, protection); report.encrypted = true; }
  return { data, report };
}

async function save({ id, plan, name, options }) {
  const built = lib.buildBytes(sources, plan, { compress: true });
  const { data, report } = await finish(built, name, options);
  reply({ type: 'saved', id, data: buffer(data), report, pages: plan.length }, [buffer(data)]);
}

// Several PDFs from groups of plan indexes, in a ZIP when there is more than one. Each file has its report.
async function split({ id, plan, groups, names, options }) {
  const files = [];
  for (let i = 0; i < groups.length; i++) {
    const built = lib.buildBytes(sources, groups[i].map((k) => plan[k]), { compress: true });
    const { data, report } = await finish(built, names[i], options);
    files.push({ name: names[i], data, report });
  }
  const reports = files.map((f) => f.report);
  if (files.length === 1) { reply({ type: 'saved', id, data: buffer(files[0].data), single: true, count: 1, reports }, [buffer(files[0].data)]); return; }
  const zip = await lib.writeZip(files.map((f) => ({ name: f.name, data: f.data, method: 8 })));
  reply({ type: 'saved', id, data: buffer(zip), count: files.length, reports }, [buffer(zip)]);
}

async function toImages({ id, plan, indexes, format, scale, quality, names }) {
  const doc = lib.buildDocument(sources, indexes.map((i) => plan[i]));
  try {
    const files = []; const reduced = [];
    for (let i = 0; i < indexes.length; i++) {
      const image = lib.pageImage(doc, i, { format, scale, quality });
      files.push({ name: names[i], data: image.data });
      if (image.clamped) reduced.push({ name: names[i], dpi: Math.floor(72 * image.scale) });
      if (i % 5 === 4) reply({ type: 'progress', id, done: i + 1, total: indexes.length });
    }
    if (files.length === 1) { reply({ type: 'saved', id, data: buffer(files[0].data), single: true, count: 1, reduced }, [buffer(files[0].data)]); return; }
    const zip = await lib.writeZip(files.map((f) => ({ name: f.name, data: f.data, method: 0 })));
    reply({ type: 'saved', id, data: buffer(zip), count: files.length, reduced }, [buffer(zip)]);
  } finally { doc.destroy(); }
}

// Rewrites the working document as one new source and reports sizes.
async function compress({ id, plan, lossy, name }) {
  const doc = lib.buildDocument(sources, plan);
  let images = null;
  try {
    if (lossy) images = lib.downsampleImages(doc, lossy);
    const bytes = lib.saveDocument(doc, { compress: true });
    const used = new Set(plan.filter((e) => !e.blank).map((e) => e.src));
    const before = [...used].reduce((n, s) => n + (sources.get(s)?.bytes.length ?? 0), 0);
    reply({ type: 'opened', id, source: register(name, lib.openPdf(bytes)), before, after: bytes.length, images });
  } finally { doc.destroy(); }
}

async function stamp({ id, plan, watermark, numbers, name }) {
  const doc = lib.buildDocument(sources, plan);
  try {
    if (watermark) lib.addWatermark(doc, watermark);
    if (numbers) lib.addPageNumbers(doc, numbers);
    const bytes = lib.saveDocument(doc, { compress: true });
    reply({ type: 'opened', id, source: register(name, lib.openPdf(bytes)) });
  } finally { doc.destroy(); }
}

async function drop({ ids }) {
  for (const id of ids) { const s = sources.get(id); if (s) { s.doc.destroy(); sources.delete(id); } }
}

const JOBS = { open, images, render, build, original, pageText, search, outline, adopt, save, split, toImages, compress, stamp, drop };
