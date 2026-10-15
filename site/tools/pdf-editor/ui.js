// PDF Editor page. File names come from the user's files: render them through textContent only.
// Every PDF operation runs in worker.js (MuPDF in WebAssembly). This page keeps the plan: the list of pages,
// each from an opened file or blank, with its rotation (see /tools/lib/pdf-editor/plan.js).
//
// Redact mode contract. Opening the Redact tab imports /tools/lib/pdf-editor/redact-ui.js and calls
// mountRedact(container, ctx) once, with container = <section id="redact-panel">. If the import fails the
// panel says redaction is not available. mountRedact may return an object with refresh(), which is called
// each time the tab is opened again, since the pages may have changed meanwhile. ctx:
//   getBytes(): Promise<Uint8Array>      the current document as PDF bytes, with every edit applied, not
//                                         cleaned and without a password
//   setBytes(u8, label): Promise<void>    replaces the working document (for example after redaction) and
//                                         refreshes the thumbnails; label names the change for Undo
//   pageCount(): number
//   pageSize(i): { width, height }        page i in PDF points as displayed, after rotation
//   renderPage(i, scale): Promise<ImageBitmap>   page i as displayed, scale 1 = 72 dpi
import { clearFile, takeFile } from '/tools/lib/handoff.js';
import { fromSource, rotatePages, removePages, duplicatePages, insertBlank, pickPages, movePagesTo, movePagesBy, entrySize } from '/tools/lib/pdf-editor/plan.js';
import { parseRanges, splitEvery, onePerPage, groupLabel, PageRangeError } from '/tools/lib/pdf-editor/ranges.js';
import { isLatin } from '/tools/lib/pdf-editor/text.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const plural = (n, w, ws = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`;
const SVG = 'http://www.w3.org/2000/svg';
function icon(d) { const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.append(p); return s; }
const MAX_TOTAL = 500 * 1024 * 1024;
const THUMB = 260; // longest side of a thumbnail bitmap in pixels
const MAX_BITMAPS = 500;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/* Worker */
let worker; let nextId = 1; const calls = new Map(); let engineReady = false;
const readyWaiters = [];
function spawn() {
  worker = new Worker('/tools/pdf-editor/worker.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') { engineReady = true; readyWaiters.splice(0).forEach((f) => f()); return; }
    if (data.type === 'fatal') { showError(data.message); setBusy(null); return; }
    const call = calls.get(data.id);
    if (!call) return;
    if (data.type === 'progress') { call.progress?.(data); return; }
    calls.delete(data.id);
    if (data.type === 'error') call.reject(new Error(data.message)); else call.resolve(data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    for (const call of calls.values()) call.reject(new Error('The PDF engine stopped unexpectedly. The browser may have run out of memory.'));
    calls.clear();
  };
}
spawn();
const whenReady = () => (engineReady ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve)));
function call(message, transfer = [], progress) {
  const id = nextId++;
  return new Promise((resolve, reject) => { calls.set(id, { resolve, reject, progress }); worker.postMessage({ ...message, id }, transfer); });
}

/* State */
const sources = new Map(); // id -> { id, name, pageCount, sizes, encrypted, signed, repaired, bytes, letter }
let plan = []; let original = []; let steps = []; let at = -1;
let selected = new Set(); let focusKey = null; let anchorKey = null;
let nextKey = 1; let letterCount = 0; let busy = false; let mode = 'organize';
const notes = [];
const keyed = (entries) => entries.map((e) => ({ ...e, key: nextKey++ }));
const sizeOf = (e) => (e.blank ? e.blank : sources.get(e.src).sizes[e.page]);
const displayed = (e) => entrySize(e, sizeOf(e));
const indexesOf = (keys) => plan.map((e, i) => (keys.has(e.key) ? i : -1)).filter((i) => i >= 0);
const selectedIndexes = () => indexesOf(selected);
const plain = (entries) => entries.map((e) => (e.blank ? { blank: e.blank, rotate: e.rotate } : { src: e.src, page: e.page, rotate: e.rotate }));
// The files the pages come from, in the order they were opened.
const usedSources = () => { const used = new Set(plan.filter((e) => !e.blank).map((e) => e.src)); return [...sources.values()].filter((s) => used.has(s.id)); };
const baseName = () => (usedSources()[0]?.name ?? sources.values().next().value?.name ?? 'document').replace(/\.(pdf|jpe?g|png|webp|gif|avif)$/i, '') || 'document';

function commit(next, label, keepSelection = true) {
  steps = steps.slice(0, at + 1);
  steps.push({ plan: next, label });
  if (steps.length > 100) steps.shift();
  at = steps.length - 1;
  plan = next;
  if (!keepSelection) selected = new Set();
  else selected = new Set([...selected].filter((k) => plan.some((e) => e.key === k)));
  render();
  if (label) announce(label);
}

function undo() { if (busy || at <= 0) return; announce(`Undid ${steps[at].label?.toLowerCase() ?? 'the last change'}.`); at--; plan = steps[at].plan; tidySelection(); render(); }
function redo() { if (busy || at >= steps.length - 1) return; at++; plan = steps[at].plan; tidySelection(); render(); announce(`Redid ${steps[at].label?.toLowerCase() ?? 'the change'}.`); }
function tidySelection() { selected = new Set([...selected].filter((k) => plan.some((e) => e.key === k))); }

/* Messages */
function announce(text) { $('announce').textContent = ''; requestAnimationFrame(() => { $('announce').textContent = text; }); }
function showError(message) { $('error').hidden = !message; $('error').textContent = message ?? ''; }
// The busy bar shows what runs; `busy` keeps a second job from starting meanwhile.
function setBusy(title, detail = '') {
  $('busy').hidden = !title;
  if (title) { $('busy-title').textContent = title; $('busy-detail').textContent = detail; }
}
async function job(title, work) {
  if (busy) return undefined;
  busy = true; showError(null); setBusy(title); updateTools();
  try { return await work(); }
  catch (error) { showError(error.message); return undefined; }
  finally { busy = false; setBusy(null); updateTools(); }
}

const urls = [];
function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type })); urls.push(url);
  const a = el('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
}
window.addEventListener('pagehide', () => { for (const u of urls) URL.revokeObjectURL(u); });

/* Opening files */
const isPdfName = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name);
async function sniffPdf(file) { const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer()); return new TextDecoder('latin1').decode(head).includes('%PDF-'); }
const openBytes = () => [...sources.values()].reduce((n, s) => n + s.bytes, 0);

async function addFiles(list) {
  const files = [...list];
  if (!files.length || busy) return;
  showError(null);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (openBytes() + total > MAX_TOTAL) { showError(`These files add up to more than 500 MB together with what is open. Open fewer or smaller files.`); return; }
  const pdfs = []; const images = []; const rejected = [];
  for (const f of files) {
    if (isPdfName(f) || (!isImage(f) && await sniffPdf(f))) pdfs.push(f);
    else if (isImage(f)) images.push(f);
    else rejected.push(f.name);
  }
  if (!engineReady) { setBusy('Loading the PDF engine…'); await whenReady(); setBusy(null); }
  busy = true; updateTools();
  try {
    for (const file of pdfs) await openPdfFile(file);
    if (images.length) await openImages(images);
  } finally { busy = false; setBusy(null); }
  if (rejected.length) showError(`${rejected.join(', ')} ${rejected.length === 1 ? 'is' : 'are'} not a PDF or an image this editor can open.`);
  render();
}

async function openPdfFile(file) {
  let password = null;
  for (;;) {
    setBusy(`Opening ${file.name}…`);
    let r;
    try { const data = await file.arrayBuffer(); r = await call({ type: 'open', name: file.name, data, password }, [data]); }
    catch (error) { setBusy(null); showError(`${file.name}: ${error.message}`); return; }
    setBusy(null);
    if (r.type === 'password') {
      password = await askPassword(file.name, r);
      if (password === null) return;
      continue;
    }
    addSource(r.source, `Opened ${file.name}`);
    return;
  }
}

async function openImages(files) {
  setBusy(`Adding ${plural(files.length, 'image')}…`);
  try {
    const data = await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: await f.arrayBuffer() })));
    const pageSize = document.querySelector('input[name=img-size]:checked').value;
    const margin = Number(document.querySelector('input[name=img-margin]:checked').value);
    const name = files.length === 1 ? files[0].name : `${plural(files.length, 'image')}`;
    const r = await call({ type: 'images', files: data, pageSize, margin, name }, data.map((d) => d.data));
    addSource(r.source, `Added ${plural(files.length, 'image')}`);
    for (const s of r.skipped ?? []) notes.push({ text: `${s.name} was not added: ${s.reason}` });
  } catch (error) { showError(error.message); }
  finally { setBusy(null); }
}

function addSource(meta, label) {
  const letter = LETTERS[letterCount++ % LETTERS.length];
  sources.set(meta.id, { ...meta, letter });
  if (meta.repaired) notes.push({ text: `${meta.name} was damaged and has been repaired. Check its pages before relying on the result.` });
  const pages = keyed(fromSource(meta.id, meta.pageCount));
  original = [...original, ...pages.map((e) => ({ ...e }))];
  const first = !plan.length;
  commit([...plan, ...pages], label);
  if (first) { $('save-name').value = `${baseName()}-edited`; $('save-result').hidden = true; }
}

// Resolves with the password typed, or null when the file is skipped.
function askPassword(name, r) {
  const form = $('unlock');
  form.hidden = false; form.dataset.state = r.wrongPassword ? 'wrong' : '';
  $('unlock-title').textContent = r.ownerPassword ? `${name} restricts changes` : `${name} is password protected`;
  $('unlock-detail').textContent = r.wrongPassword ? 'That password is not correct. Try again.' : r.ownerPassword ? 'Its author limited what can be changed. Enter the owner password to edit it.' : 'Enter its password to open it.';
  $('unlock-password').value = ''; $('unlock-password').focus();
  return new Promise((resolve) => {
    const finish = (value) => { form.hidden = true; form.onsubmit = null; $('unlock-skip').onclick = null; resolve(value); };
    form.onsubmit = (e) => { e.preventDefault(); const v = $('unlock-password').value; if (v) finish(v); };
    $('unlock-skip').onclick = () => finish(null);
  });
}

$('file').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; addFiles(f); });
$('add-files').addEventListener('click', () => $('file').click());
$('add-images').addEventListener('click', () => $('image-files').click());
$('image-files').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; addFiles(f); });
const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add('over'); });
for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (!$('editor').hidden && !dragKeys && e.dataTransfer.files.length && !e.target.closest('#redact-panel')) addFiles(e.dataTransfer.files); });

/* Thumbnails: rendered by the worker a few at a time, only for pages near the visible area. */
const list = $('pages');
const nodes = new Map(); // key -> li
const bitmaps = new Map(); // 'src:page' -> ImageBitmap, oldest first
const requested = new Set(); const visible = new Set(); let inflight = 0;
const bitmapKey = (e) => `${e.src}:${e.page}`;
const observer = new IntersectionObserver((entries) => {
  for (const x of entries) { const k = Number(x.target.dataset.key); if (x.isIntersecting) visible.add(k); else visible.delete(k); }
  pumpThumbs();
}, { root: list, rootMargin: '400px 0px' });

function pumpThumbs() {
  if (inflight >= 2) return;
  const byKey = new Map(plan.map((e) => [e.key, e]));
  for (const key of [...visible].sort((a, b) => indexOfKey(a) - indexOfKey(b))) {
    if (inflight >= 2) return;
    const e = byKey.get(key);
    if (!e || e.blank) continue;
    const bk = bitmapKey(e);
    if (bitmaps.has(bk) || requested.has(bk)) continue;
    requested.add(bk); inflight++;
    const [w, h] = sources.get(e.src).sizes[e.page];
    call({ type: 'render', src: e.src, page: e.page, scale: Math.min(2, THUMB / Math.max(w, h, 1)) }).then((r) => {
      bitmaps.set(bk, r.bitmap);
      if (bitmaps.size > MAX_BITMAPS) { const [oldest, bmp] = bitmaps.entries().next().value; bitmaps.delete(oldest); bmp.close(); }
      for (const p of plan) if (!p.blank && bitmapKey(p) === bk && nodes.has(p.key)) draw(nodes.get(p.key), p);
    }, () => {}).finally(() => { requested.delete(bk); inflight--; pumpThumbs(); });
  }
}
let keyIndex = new Map();
const indexOfKey = (k) => keyIndex.get(k) ?? Infinity;

function draw(li, e) {
  const canvas = li.querySelector('canvas');
  const bitmap = e.blank ? null : bitmaps.get(bitmapKey(e));
  const rotate = e.rotate ?? 0;
  const stamp = `${bitmap ? 'b' : 'p'}:${rotate}`;
  if (li.dataset.drawn === stamp && bitmap) return;
  const [dw, dh] = displayed(e);
  const ctx = canvas.getContext('2d');
  if (!bitmap) {
    const s = 40 / Math.max(dw, dh, 1);
    canvas.width = Math.max(1, Math.round(dw * s)); canvas.height = Math.max(1, Math.round(dh * s));
    // Paper while the page renders; blank pages stay white.
    ctx.fillStyle = e.blank ? '#fff' : 'rgba(255,255,255,0.55)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    li.dataset.drawn = stamp;
    return;
  }
  const turned = rotate % 180 !== 0;
  canvas.width = turned ? bitmap.height : bitmap.width; canvas.height = turned ? bitmap.width : bitmap.height;
  ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2); ctx.restore();
  li.dataset.drawn = stamp;
}

const CHECK = 'm5 12.5 4.5 4.5L19 7.5';
function makeNode(e) {
  const li = el('li', 'page'); li.setAttribute('role', 'option'); li.tabIndex = -1; li.draggable = true; li.dataset.key = String(e.key);
  const sheet = el('span', 'sheet'); sheet.append(el('canvas'));
  const tick = el('span', 'tick'); tick.append(icon(CHECK)); sheet.append(tick);
  const caption = el('span', 'caption'); caption.append(el('span', 'num'), el('span', 'badge'));
  li.append(sheet, caption);
  observer.observe(li);
  return li;
}

function render() {
  const hasPages = plan.length > 0 || sources.size > 0;
  $('dropzone').hidden = hasPages; $('editor').hidden = !hasPages;
  if (!hasPages) return;
  keyIndex = new Map(plan.map((e, i) => [e.key, i]));
  const multi = new Set(plan.filter((e) => !e.blank).map((e) => e.src)).size > 1;
  const live = new Set(plan.map((e) => e.key));
  for (const [k, li] of nodes) if (!live.has(k)) { observer.unobserve(li); visible.delete(k); li.remove(); nodes.delete(k); }
  if (focusKey !== null && !live.has(focusKey)) focusKey = plan[0]?.key ?? null;
  if (focusKey === null && plan.length) focusKey = plan[0].key;
  const ordered = plan.map((e, i) => {
    let li = nodes.get(e.key);
    if (!li) { li = makeNode(e); nodes.set(e.key, li); }
    const src = e.blank ? null : sources.get(e.src);
    li.querySelector('.num').textContent = String(i + 1);
    const badge = li.querySelector('.badge'); badge.hidden = !multi || !src; badge.textContent = src?.letter ?? '';
    const isSel = selected.has(e.key);
    li.setAttribute('aria-selected', String(isSel));
    li.tabIndex = e.key === focusKey ? 0 : -1;
    li.setAttribute('aria-label', `Page ${i + 1}${e.blank ? ', blank' : multi ? `, from ${src.name}` : ''}${e.rotate ? `, turned ${e.rotate}°` : ''}`);
    draw(li, e);
    return li;
  });
  const same = ordered.length === list.children.length && ordered.every((li, i) => list.children[i] === li);
  if (!same) list.replaceChildren(...ordered);
  if (!plan.length) list.replaceChildren(el('li', 'empty-pages', 'No pages left. Undo, reset or add files.'));
  renderDoc(); updateTools(); pumpThumbs();
}

function renderDoc() {
  const used = usedSources();
  const pages = plan.length;
  $('doc-name').textContent = used.length > 1 ? `${used[0].name} and ${plural(used.length - 1, 'other file')}` : used[0]?.name ?? 'Blank document';
  const facts = [plural(pages, 'page')];
  if (used.length > 1) facts.push(plural(used.length, 'file'));
  facts.push(size(used.reduce((n, s) => n + s.bytes, 0)));
  $('doc-facts').textContent = facts.join(' · ');
  const files = $('doc-files');
  files.hidden = used.length < 2;
  files.replaceChildren(...(used.length < 2 ? [] : used.map((s) => { const li = el('li'); li.append(el('span', 'badge', s.letter), el('span', '', `${s.name} · ${plural(s.pageCount, 'page')}`)); return li; })));
  const warn = [];
  for (const s of used) if (s.signed) warn.push(`${s.name} is digitally signed. Saving rewrites the file, so its signature will no longer be valid.`);
  for (const n of notes) warn.push(n.text);
  $('notes').hidden = !warn.length; $('notes').replaceChildren(...warn.map((t) => el('p', '', t)));
  const signed = used.filter((s) => s.signed);
  $('sign-note').hidden = !signed.length;
  $('sign-note').textContent = signed.length ? `Saving invalidates the digital signature in ${signed.map((s) => s.name).join(', ')}${$('clean').checked ? ', and removing hidden data drops it' : ''}.` : '';
  updateProtect();
  $('undo').disabled = at <= 0; $('redo').disabled = at >= steps.length - 1;
  $('reset').disabled = at <= 0;
}

function updateTools() {
  const count = selected.size;
  $('selection').textContent = count ? `${count.toLocaleString('en-US')} of ${plural(plan.length, 'page')} selected` : `${plural(plan.length, 'page')}`;
  $('select-all').checked = count > 0 && count === plan.length;
  $('select-all').indeterminate = count > 0 && count < plan.length;
  for (const b of document.querySelectorAll('[data-needs=selection]')) b.disabled = busy || !count;
  $('insert-blank').disabled = busy;
  $('save').disabled = busy || !plan.length;
  const scope = count ? plural(count, 'selected page') : `all ${plural(plan.length, 'page')}`;
  $('out-scope').textContent = `Exports ${scope}. Several images are saved together in a ZIP.`;
}

/* Selection and keyboard */
function setFocus(key, move = true) {
  focusKey = key;
  for (const [k, li] of nodes) li.tabIndex = k === key ? 0 : -1;
  if (move) nodes.get(key)?.focus();
}
function toggle(key) { if (selected.has(key)) selected.delete(key); else selected.add(key); anchorKey = key; }
function selectRange(toKey) {
  const a = indexOfKey(anchorKey ?? toKey); const b = indexOfKey(toKey);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(plan[i].key);
}
list.addEventListener('click', (e) => {
  const li = e.target.closest('li.page'); if (!li) return;
  const key = Number(li.dataset.key);
  if (e.shiftKey && anchorKey !== null) selectRange(key); else toggle(key);
  setFocus(key); render();
});
$('select-all').addEventListener('change', () => { selected = $('select-all').checked ? new Set(plan.map((e) => e.key)) : new Set(); render(); });

function columns() {
  const items = [...list.children].filter((n) => n.classList.contains('page'));
  if (items.length < 2) return 1;
  const top = items[0].offsetTop; let n = 0;
  for (const li of items) { if (li.offsetTop !== top) break; n++; }
  return Math.max(1, n);
}
// The pages an action applies to: the selection, or the focused page when nothing is selected.
const targets = () => { const s = selectedIndexes(); if (s.length) return s; const f = indexOfKey(focusKey); return Number.isFinite(f) ? [f] : []; };

list.addEventListener('keydown', (e) => {
  const li = e.target.closest('li.page'); if (!li || busy) return;
  const key = Number(li.dataset.key); const i = indexOfKey(key);
  const go = (j) => { const k = plan[Math.max(0, Math.min(plan.length - 1, j))]?.key; if (k !== undefined) { if (e.shiftKey && !e.altKey) { anchorKey ??= key; selectRange(k); render(); } setFocus(k); } };
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() }[e.key];
  if (step && e.altKey) { e.preventDefault(); move(step < 0 ? -1 : 1); return; }
  if (step) { e.preventDefault(); go(i + step); return; }
  if (e.key === 'Home') { e.preventDefault(); go(0); return; }
  if (e.key === 'End') { e.preventDefault(); go(plan.length - 1); return; }
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(key); render(); announce(`Page ${i + 1} ${selected.has(key) ? 'selected' : 'not selected'}.`); return; }
  if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); selected = new Set(plan.map((p) => p.key)); render(); announce(`All ${plural(plan.length, 'page')} selected.`); return; }
  if (e.key === 'Escape') { selected = new Set(); render(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); return; }
  if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); rotate(e.shiftKey ? -90 : 90); }
});

/* Organize actions */
function move(delta) {
  const idx = targets(); if (!idx.length) return;
  const r = movePagesBy(plan, idx, delta);
  if (r.plan === plan) return;
  if (!selected.size) selected = new Set([plan[idx[0]].key]);
  commit(r.plan, `Moved ${plural(idx.length, 'page')} to position ${r.indexes[0] + 1}`);
  setFocus(focusKey);
}
function rotate(deg) { const idx = targets(); if (idx.length) { commit(rotatePages(plan, idx, deg), `Rotated ${plural(idx.length, 'page')} ${deg > 0 ? 'right' : 'left'}`); setFocus(focusKey); } }
function remove() {
  const idx = targets(); if (!idx.length) return;
  const after = plan[Math.max(...idx) + 1]?.key ?? plan[Math.min(...idx) - 1]?.key ?? null;
  commit(removePages(plan, idx), `Deleted ${plural(idx.length, 'page')}`, false);
  if (after !== null) setFocus(after);
}
$('rotate-left').addEventListener('click', () => rotate(-90));
$('rotate-right').addEventListener('click', () => rotate(90));
$('move-earlier').addEventListener('click', () => move(-1));
$('move-later').addEventListener('click', () => move(1));
$('delete').addEventListener('click', remove);
$('duplicate').addEventListener('click', () => {
  const idx = selectedIndexes(); if (!idx.length) return;
  const r = duplicatePages(plan, idx, () => nextKey++);
  commit(r.plan, `Duplicated ${plural(idx.length, 'page')}`);
});
$('insert-blank').addEventListener('click', () => {
  const idx = selectedIndexes();
  const after = idx.length ? Math.max(...idx) : plan.length - 1;
  const near = plan[after] ?? plan[0];
  const dims = near ? displayed(near) : [612, 792];
  const r = insertBlank(plan, after + 1, dims, { key: nextKey++ });
  commit(r.plan, `Inserted a blank page at position ${r.index + 1}`);
});
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('reset').addEventListener('click', () => { if (!busy) commit(keyed(original), 'Reset to the original pages', false); });
$('close').addEventListener('click', () => {
  if (busy) return;
  call({ type: 'drop', ids: [...sources.keys()] }).catch(() => {});
  sources.clear(); plan = []; original = []; steps = []; at = -1; selected = new Set(); notes.length = 0; letterCount = 0;
  for (const b of bitmaps.values()) b.close();
  bitmaps.clear(); for (const li of nodes.values()) observer.unobserve(li); nodes.clear(); list.replaceChildren(); visible.clear();
  $('save-result').hidden = true; $('compress-result').hidden = true; showError(null);
  render();
});
document.addEventListener('keydown', (e) => {
  if ($('editor').hidden || mode === 'redact' || e.target.closest('input, textarea, select, [contenteditable]')) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
});

/* Drag and drop reordering */
let dragKeys = null; let dropMark = null;
function clearMark() { if (dropMark) dropMark.classList.remove('drop-before', 'drop-after'); dropMark = null; }
list.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li.page'); if (!li || busy) { e.preventDefault(); return; }
  const key = Number(li.dataset.key);
  if (!selected.has(key)) { selected = new Set([key]); render(); }
  dragKeys = new Set(selected);
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(key));
  for (const k of dragKeys) nodes.get(k)?.classList.add('dragging');
});
list.addEventListener('dragover', (e) => {
  if (!dragKeys) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  const li = e.target.closest('li.page'); if (!li) return;
  const r = li.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
  if (dropMark !== li || li.classList.contains('drop-after') !== after) { clearMark(); dropMark = li; li.classList.add(after ? 'drop-after' : 'drop-before'); }
});
list.addEventListener('drop', (e) => {
  if (!dragKeys) return;
  e.preventDefault(); e.stopPropagation();
  const li = dropMark; const after = li?.classList.contains('drop-after');
  clearMark();
  if (!li) return;
  const before = indexOfKey(Number(li.dataset.key)) + (after ? 1 : 0);
  const idx = indexesOf(dragKeys);
  const r = movePagesTo(plan, idx, before);
  if (r.plan.some((p, i) => p !== plan[i])) commit(r.plan, `Moved ${plural(idx.length, 'page')} to position ${r.indexes[0] + 1}`);
});
list.addEventListener('dragend', () => { clearMark(); for (const li of nodes.values()) li.classList.remove('dragging'); dragKeys = null; });

/* Modes */
const tabs = [...document.querySelectorAll('.modes [role=tab]')];
function selectMode(tab) {
  mode = tab.id.replace('tab-', '');
  for (const t of tabs) { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; $(t.getAttribute('aria-controls')).hidden = !on; }
  $('layout').hidden = mode === 'redact';
  $('page-tools').hidden = mode !== 'organize';
  if (mode === 'redact') openRedact();
}
for (const t of tabs) {
  t.addEventListener('click', () => selectMode(t));
  t.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return;
    const next = tabs[(tabs.indexOf(t) + d + tabs.length) % tabs.length]; selectMode(next); next.focus();
  });
}

/* Redact mode (see the contract at the top) */
let redact = null;
const ctx = {
  getBytes: async () => new Uint8Array((await call({ type: 'build', plan: plain(plan) })).data),
  setBytes: async (u8, label = 'Redacted') => {
    const data = u8.slice().buffer;
    const r = await call({ type: 'adopt', name: usedSources()[0]?.name ?? 'document.pdf', data }, [data]);
    replaceWith(r.source, label);
  },
  pageCount: () => plan.length,
  pageSize: (i) => { const [width, height] = displayed(plan[i]); return { width, height }; },
  renderPage: async (i, scale) => {
    const e = plan[i];
    if (!e) throw new Error(`There is no page ${i + 1}.`);
    if (e.blank) {
      const [w, h] = displayed(e); const c = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      return c.transferToImageBitmap();
    }
    return (await call({ type: 'render', src: e.src, page: e.page, scale, rotate: e.rotate ?? 0 })).bitmap;
  },
};
async function openRedact() {
  if (redact) { redact.handle?.refresh?.(); return; }
  redact = { handle: null };
  const panel = $('redact-panel');
  try {
    const mod = await import('/tools/lib/pdf-editor/redact-ui.js');
    if (typeof mod.mountRedact !== 'function') throw new Error('missing mountRedact');
    redact.handle = (await mod.mountRedact(panel, ctx)) ?? null;
  } catch {
    const note = el('div', 'unavailable'); note.append(el('strong', '', 'Redaction is not available in this build.'), el('p', '', 'The other modes work as usual.'));
    panel.replaceChildren(note);
  }
}

// A new source replaces the whole working document (after compression, stamping or redaction).
function replaceWith(meta, label) {
  const signed = usedSources().some((s) => s.signed);
  const letter = LETTERS[letterCount++ % LETTERS.length];
  sources.set(meta.id, { ...meta, signed: meta.signed || signed, letter, name: usedSources()[0]?.name ?? meta.name });
  commit(keyed(fromSource(meta.id, meta.pageCount)), label, false);
}

/* Organize panel: split and extract */
const splitMode = () => document.querySelector('input[name=split]:checked').value;
for (const r of document.querySelectorAll('input[name=split]')) r.addEventListener('change', () => { $('split-ranges-field').hidden = splitMode() !== 'ranges'; $('split-every-field').hidden = splitMode() !== 'every'; });
function outputOptions() {
  const protection = readProtection();
  return { clean: $('clean').checked, protection };
}
$('split-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let groups;
  try {
    groups = splitMode() === 'ranges' ? parseRanges($('split-ranges').value, plan.length) : splitMode() === 'every' ? splitEvery(plan.length, $('split-every').value) : onePerPage(plan.length);
  } catch (error) { if (error instanceof PageRangeError) { showError(error.message); return; } throw error; }
  let options; try { options = outputOptions(); } catch (error) { showError(error.message); return; }
  const base = baseName();
  const names = groups.map((g) => `${base}-${g.length === 1 ? 'page' : 'pages'}-${groupLabel(g)}.pdf`);
  await job(`Splitting into ${plural(groups.length, 'file')}…`, async () => {
    const r = await call({ type: 'split', plan: plain(plan), groups, names, options });
    if (r.single) download(r.data, names[0], 'application/pdf'); else download(r.data, `${base}-split.zip`, 'application/zip');
    announce(`Saved ${plural(r.count, 'file')}.`);
  });
});
$('extract').addEventListener('click', async () => {
  const idx = selectedIndexes(); if (!idx.length) return;
  let options; try { options = outputOptions(); } catch (error) { showError(error.message); return; }
  const name = `${baseName()}-extract.pdf`;
  await job(`Extracting ${plural(idx.length, 'page')}…`, async () => {
    const r = await call({ type: 'split', plan: plain(plan), groups: [idx], names: [name], options });
    download(r.data, name, 'application/pdf');
    announce(`Saved ${name}.`);
  });
});

/* Convert panel: pages to images */
const outFormat = () => document.querySelector('input[name=out-format]:checked').value;
for (const r of document.querySelectorAll('input[name=out-format]')) r.addEventListener('change', () => { $('out-quality-field').hidden = outFormat() !== 'jpeg'; });
$('out-quality').addEventListener('input', () => { $('out-quality-value').textContent = $('out-quality').value; });
$('export-images').addEventListener('click', async () => {
  const idx = selectedIndexes().length ? selectedIndexes() : plan.map((_, i) => i);
  if (!idx.length) return;
  const format = outFormat(); const ext = format === 'jpeg' ? 'jpg' : 'png';
  const dpi = Number(document.querySelector('input[name=out-dpi]:checked').value);
  const base = baseName();
  const names = idx.map((i) => `${base}-page-${i + 1}.${ext}`);
  await job(`Rendering ${plural(idx.length, 'page')}…`, async () => {
    const r = await call({ type: 'toImages', plan: plain(plan), indexes: idx, format, scale: dpi / 72, quality: Number($('out-quality').value), names }, [], (p) => { $('busy-detail').textContent = `${p.done} of ${p.total}`; });
    if (r.single) download(r.data, names[0], `image/${format}`); else download(r.data, `${base}-images.zip`, 'application/zip');
    announce(`Saved ${plural(r.count, 'image')}.`);
  });
});

/* Protect panel */
function readProtection() {
  const pw = $('pw').value; const pw2 = $('pw2').value; const owner = $('owner-pw').value;
  if (!pw && !pw2) { if (owner) throw new Error('Enter a password to open the PDF before setting an owner password.'); return null; }
  if (pw !== pw2) throw new Error('The two passwords do not match.');
  for (const [v, label] of [[pw, 'The password'], [owner, 'The owner password']]) {
    if (v.includes(',')) throw new Error(`${label} cannot contain a comma.`);
    if (new TextEncoder().encode(v).length > 127) throw new Error(`${label} is too long.`);
  }
  return { userPassword: pw, ownerPassword: owner, allow: { print: $('allow-print').checked, copy: $('allow-copy').checked, edit: $('allow-edit').checked } };
}
function updateProtect() {
  const encrypted = usedSources().filter((s) => s.encrypted);
  $('protect-status').textContent = encrypted.length ? `${encrypted.map((s) => s.name).join(', ')} ${encrypted.length === 1 ? 'was' : 'were'} password protected. The saved copy has no password unless you add one here.` : 'Add a password that is needed to open the saved PDF.';
  const pw = $('pw').value;
  const restricted = !($('allow-print').checked && $('allow-copy').checked && $('allow-edit').checked);
  $('protect-note').textContent = pw ? `Password: AES-256${restricted ? ', with restrictions' : ''}. Added after hidden data is removed.` : encrypted.length ? 'No password: the original password is removed.' : 'No password.';
}
for (const id of ['pw', 'pw2', 'owner-pw', 'allow-print', 'allow-copy', 'allow-edit']) $(id).addEventListener('input', updateProtect);
$('pw-reveal').addEventListener('click', () => {
  const show = $('pw').type === 'password';
  for (const id of ['pw', 'pw2', 'owner-pw']) $(id).type = show ? 'text' : 'password';
  $('pw-reveal').textContent = show ? 'Hide' : 'Show'; $('pw-reveal').setAttribute('aria-pressed', String(show));
});
$('clean').addEventListener('change', renderDoc);

/* Compress panel */
$('lossy').addEventListener('change', () => { $('lossy-options').hidden = !$('lossy').checked; });
$('lossy-quality').addEventListener('input', () => { $('lossy-quality-value').textContent = $('lossy-quality').value; });
$('compress-run').addEventListener('click', async () => {
  if (!plan.length) return;
  const lossy = $('lossy').checked ? { dpi: Number(document.querySelector('input[name=lossy-dpi]:checked').value), quality: Number($('lossy-quality').value) } : null;
  await job(lossy ? 'Compressing pages and images…' : 'Compressing…', async () => {
    const r = await call({ type: 'compress', plan: plain(plan), lossy, name: baseName() });
    const out = $('compress-result'); out.hidden = false;
    if (r.after >= r.before) {
      call({ type: 'drop', ids: [r.source.id] }).catch(() => {});
      out.textContent = `Already compact: the rewritten file would be ${size(r.after)}, the original is ${size(r.before)}. Nothing was changed.`;
      return;
    }
    replaceWith(r.source, 'Compressed');
    const pct = Math.round((1 - r.after / r.before) * 100);
    out.textContent = `${size(r.before)} → ${size(r.after)}, ${pct}% smaller.${r.images ? ` ${plural(r.images.replaced, 'image')} downsampled.` : ''} Undo restores the original.`;
  });
});

/* Watermark panel */
const opacity = () => Number($('wm-opacity').value) / 100;
$('wm-opacity').addEventListener('input', () => { $('wm-opacity-value').textContent = `${$('wm-opacity').value}%`; });
$('wm-text').addEventListener('input', () => { $('wm-latin').hidden = isLatin($('wm-text').value); });
$('pn-format').addEventListener('input', () => { $('pn-latin').hidden = isLatin($('pn-format').value); });
$('watermark-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('wm-text').value.trim();
  if (!text) { showError('Enter the watermark text.'); return; }
  const which = document.querySelector('input[name=wm-pages]:checked').value;
  const pages = which === 'selected' ? selectedIndexes() : undefined;
  if (which === 'selected' && !pages.length) { showError('Select the pages to watermark first, or choose All pages.'); return; }
  const watermark = { text, size: Number($('wm-size').value) || 0, opacity: opacity(), rotation: Number(document.querySelector('input[name=wm-rotation]:checked').value), position: $('wm-position').value, color: document.querySelector('input[name=wm-color]:checked').value, pages };
  await job('Adding the watermark…', async () => {
    const r = await call({ type: 'stamp', plan: plain(plan), watermark, name: baseName() });
    replaceWith(r.source, `Added the watermark to ${pages ? plural(pages.length, 'page') : 'every page'}`);
  });
});
$('numbers-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const format = $('pn-format').value;
  if (!format.trim()) { showError('Enter the page number text.'); return; }
  const numbers = { format, position: $('pn-position').value, size: Math.max(6, Math.min(72, Number($('pn-size').value) || 10)), start: Number($('pn-start').value) || 1, from: Math.max(1, Number($('pn-from').value) || 1) };
  await job('Adding page numbers…', async () => {
    const r = await call({ type: 'stamp', plan: plain(plan), numbers, name: baseName() });
    replaceWith(r.source, 'Added page numbers');
  });
});

/* Save */
$('save-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!plan.length) return;
  let options; try { options = outputOptions(); } catch (error) { showError(error.message); selectMode($('tab-protect')); return; }
  const name = `${($('save-name').value.trim() || `${baseName()}-edited`).replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
  $('save-result').hidden = true;
  await job(options.clean ? 'Saving and removing hidden data…' : 'Saving…', async () => {
    const r = await call({ type: 'save', plan: plain(plan), name, options });
    download(r.data, name, 'application/pdf');
    showSaved(r, name, options);
  });
});

function showSaved(r, name, options) {
  $('save-result').hidden = false;
  $('save-title').textContent = name;
  const parts = [plural(r.pages, 'page'), size(r.data.byteLength)];
  if (r.report.encrypted) parts.push('AES-256 encrypted');
  $('save-detail').textContent = parts.join(' · ');
  const items = [];
  if (options.clean) {
    if (r.report.cleaned && r.report.removed.length) {
      const kinds = [...new Set(r.report.removed.map((x) => x.kind))];
      items.push(el('li', '', `Hidden data removed: ${kinds.join(', ')}.`));
    } else if (r.report.cleaned) items.push(el('li', '', 'No hidden data was found.'));
    else items.push(el('li', 'warn', `Hidden data was not removed: ${r.report.refused}`));
  }
  if (usedSources().some((s) => s.signed)) items.push(el('li', '', 'The digital signature of the original is no longer valid in this copy.'));
  if (r.report.encrypted) items.push(el('li', '', 'Keep the password safe: it cannot be recovered.'));
  $('save-report').replaceChildren(...items);
  $('save-report').hidden = !items.length;
  announce(`Saved ${name}.`);
}

/* Start */
async function start() {
  if (location.hash.startsWith('#from-')) {
    const file = await takeFile().catch(() => null);
    window.history.replaceState(null, '', location.pathname);
    if (file) { await addFiles([file]); return; }
  } else clearFile();
}
updateProtect();
start();
