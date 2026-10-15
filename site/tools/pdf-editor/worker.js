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
]).then(([pdf, stamp, compress, clean, zip]) => {
  lib = { ...pdf, ...stamp, ...compress, cleanFile: clean.cleanFile, writeZip: zip.writeZip };
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
  if (error instanceof lib.PdfError) return error.message;
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
async function toPng(data, type) {
  const bitmap = await createImageBitmap(new Blob([data], { type }));
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
      try { bytes = await toPng(bytes, file.type); } catch { skipped.push({ name: file.name, reason: 'This browser cannot read this image.' }); continue; }
    }
    prepared.push({ bytes, name: file.name });
  }
  if (!prepared.length) throw new lib.PdfError(skipped.length ? 'None of these images could be read.' : 'Choose at least one image.');
  const made = await lib.imagesToPdf(prepared, { pageSize, margin });
  let bytes;
  try { bytes = lib.saveDocument(made.doc); } finally { made.doc.destroy(); }
  reply({ type: 'opened', id, source: register(name, lib.openPdf(bytes)), skipped: [...skipped, ...made.skipped] });
}

const MAX_PIXELS = 16 * 1024 * 1024;

async function render({ id, src, page, scale, rotate = 0 }) {
  const source = sources.get(src);
  if (!source) throw new lib.PdfError('This page is no longer open.');
  let s = scale;
  let out = lib.renderPage(source.doc, page, s, rotate);
  if (out.width * out.height > MAX_PIXELS) { s *= Math.sqrt(MAX_PIXELS / (out.width * out.height)); out = lib.renderPage(source.doc, page, s, rotate); }
  const bitmap = await createImageBitmap(new ImageData(out.pixels, out.width, out.height));
  reply({ type: 'rendered', id, bitmap }, [bitmap]);
}

// The working document as bytes, as it would be saved but without cleaning or a password.
async function build({ id, plan }) {
  const bytes = lib.buildBytes(sources, plan, { compress: false });
  reply({ type: 'built', id, data: buffer(bytes) }, [buffer(bytes)]);
}

async function adopt({ id, name, data }) {
  const opened = lib.openPdf(new Uint8Array(data));
  if (opened.needsPassword) throw new lib.PdfError('The new document is password protected and cannot be used here.');
  reply({ type: 'opened', id, source: register(name, opened) });
}

// Output: hidden data removed first (the cleaner cannot read encrypted files), then the password added.
async function finish(bytes, name, { clean, protection }) {
  const report = { cleaned: false, removed: [], kept: [], refused: null, encrypted: false };
  let data = bytes;
  if (clean) {
    const result = await lib.cleanFile(data, name, { removeSignatures: true });
    if (result.ok) {
      report.cleaned = true; report.removed = result.removed ?? []; report.kept = result.kept ?? [];
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

// Several PDFs from groups of plan indexes, in a ZIP when there is more than one.
async function split({ id, plan, groups, names, options }) {
  const files = [];
  for (let i = 0; i < groups.length; i++) {
    const built = lib.buildBytes(sources, groups[i].map((k) => plan[k]), { compress: true });
    const { data } = await finish(built, names[i], options);
    files.push({ name: names[i], data });
  }
  if (files.length === 1) { reply({ type: 'saved', id, data: buffer(files[0].data), single: true, count: 1 }, [buffer(files[0].data)]); return; }
  const zip = await lib.writeZip(files.map((f) => ({ name: f.name, data: f.data, method: 8 })));
  reply({ type: 'saved', id, data: buffer(zip), count: files.length }, [buffer(zip)]);
}

async function toImages({ id, plan, indexes, format, scale, quality, names }) {
  const doc = lib.buildDocument(sources, indexes.map((i) => plan[i]));
  try {
    const files = [];
    for (let i = 0; i < indexes.length; i++) {
      files.push({ name: names[i], data: lib.pageImage(doc, i, { format, scale, quality }) });
      if (i % 5 === 4) reply({ type: 'progress', id, done: i + 1, total: indexes.length });
    }
    if (files.length === 1) { reply({ type: 'saved', id, data: buffer(files[0].data), single: true, count: 1 }, [buffer(files[0].data)]); return; }
    const zip = await lib.writeZip(files.map((f) => ({ name: f.name, data: f.data, method: 0 })));
    reply({ type: 'saved', id, data: buffer(zip), count: files.length }, [buffer(zip)]);
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

const JOBS = { open, images, render, build, adopt, save, split, toImages, compress, stamp, drop };
