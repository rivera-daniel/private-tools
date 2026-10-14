// File names and reported values come from the user's files. Render through textContent only.
import { clearFile, takeFile } from '/tools/lib/handoff.js';

const $ = (id) => document.getElementById(id);
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 120000;
const MIME = { JPEG: 'image/jpeg', PNG: 'image/png', WebP: 'image/webp', GIF: 'image/gif' };
const KINDS = { EXIF: 'EXIF', XMP: 'XMP', IPTC: 'IPTC', C2PA: 'Content Credentials', Comment: 'comments', Text: 'text chunks', Thumbnail: 'thumbnails', Photoshop: 'Photoshop data', Trailer: 'hidden trailing data', Time: 'timestamps' };

// Jobs run one at a time. A spare worker stands by so a hung file can be cancelled offline.
let worker = spawn(); let spare = spawn(); let next = 0; let running = null; let timer = null; const urls = [];
const waiting = [];

function spawn() {
  const w = new Worker('/tools/metadata-cleaner/worker.js', { type: 'module' });
  w.onmessage = ({ data }) => { if (w === worker && running?.id === data.id) done(data); };
  w.onerror = (event) => { event.preventDefault(); if (w === worker && running) { restart(); done({ id: running.id, ok: false, reason: 'The cleaner stopped unexpectedly. The file may be damaged.' }); } };
  return w;
}

function restart() { clearTimeout(timer); worker.terminate(); worker = spare; spare = spawn(); }

const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
const cleanName = (name) => { const dot = name.lastIndexOf('.'); return dot > 0 ? `${name.slice(0, dot)}-clean${name.slice(dot)}` : `${name}-clean`; };
const track = (blob) => { const url = URL.createObjectURL(blob); urls.push(url); return url; };

function add(files) {
  if (!files.length) return;
  $('dropzone').hidden = true; $('queue').hidden = false;
  for (const file of files) {
    const row = el('li', 'job'); row.dataset.state = 'waiting';
    const thumb = el('span', 'job-thumb'); const body = el('div', 'job-body'); body.append(el('strong', '', file.name), el('p', '', 'Waiting…'));
    const img = el('img'); img.alt = ''; img.onerror = () => img.remove(); img.src = track(file); thumb.append(img);
    row.append(thumb, body, el('span', 'state', ''));
    $('jobs').append(row);
    waiting.push({ id: next++, file, row, body });
  }
  title(); pump();
}

function title() {
  const rows = [...$('jobs').children];
  const finished = rows.filter((r) => r.dataset.state === 'done').length;
  $('queue-title').textContent = `${plural(rows.length, 'image')}, ${finished} cleaned`;
}

function pump() {
  if (running || !waiting.length) return;
  running = waiting.shift();
  const { file, row, body } = running;
  row.dataset.state = 'working';
  row.lastChild.replaceWith(el('span', 'spinner'));
  body.lastChild.textContent = 'Cleaning…';
  if (file.size > MAX_BYTES) { done({ id: running.id, ok: false, reason: 'This file is larger than 200 MB.' }); return; }
  timer = setTimeout(() => { restart(); done({ id: running.id, ok: false, reason: 'Cleaning took too long and was stopped.' }); }, TIMEOUT_MS);
  worker.postMessage({ id: running.id, file });
}

function done(result) {
  clearTimeout(timer);
  const { file, row, body } = running; running = null;
  const status = body.lastChild;
  if (!result.ok) {
    row.dataset.state = 'error'; status.textContent = result.reason;
    row.lastChild.replaceWith(el('span', 'state', 'Not cleaned'));
  } else {
    row.dataset.state = 'done';
    const found = result.removed.length;
    if (!found) status.textContent = 'No metadata found. The file is unchanged.';
    else {
      const counts = new Map(); for (const b of result.removed) counts.set(KINDS[b.kind] ?? b.kind.toLowerCase(), (counts.get(KINDS[b.kind] ?? b.kind.toLowerCase()) ?? 0) + 1);
      status.textContent = `Removed ${plural(found, 'block')}: ${[...counts.keys()].join(', ')}. ${size(result.bytesBefore)} → ${size(result.bytesAfter)}.`;
    }
    body.append(...(result.kept.length ? [el('p', 'kept', `Kept: ${result.kept.join(', ')}.`)] : []));
    const save = el('a', 'save', 'Save'); save.href = track(new Blob([result.data], { type: MIME[result.format] })); save.download = cleanName(file.name);
    save.setAttribute('aria-label', `Save cleaned ${file.name}`);
    row.lastChild.replaceWith(save);
  }
  title(); pump();
}

function reset() {
  clearTimeout(timer);
  if (running) { restart(); running = null; }
  waiting.length = 0;
  $('jobs').replaceChildren(); for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  $('queue').hidden = true; $('dropzone').hidden = false; $('file').value = '';
}

$('file').addEventListener('change', (e) => add([...e.target.files]));
$('again').addEventListener('click', () => { reset(); $('file').click(); });
const zone = $('dropzone');
for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
for (const type of ['dragleave', 'drop']) zone.addEventListener(type, () => zone.classList.remove('over'));
zone.addEventListener('drop', (e) => { e.preventDefault(); add([...e.dataTransfer.files]); });
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
window.addEventListener('pagehide', () => { for (const u of urls) URL.revokeObjectURL(u); });

// Image Inspector hands over the image it just inspected.
if (location.hash === '#from-inspector') {
  history.replaceState(null, '', location.pathname);
  takeFile().then((file) => { if (file) add([file]); }, () => {});
} else clearFile();
