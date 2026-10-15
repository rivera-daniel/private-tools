// File names and reported values come from the user's files. Render through textContent only.
import { clearFile, takeFile } from '/lib/handoff.js';

const $ = (id) => document.getElementById(id);
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 120000;
const KINDS = { EXIF: 'EXIF', XMP: 'XMP', IPTC: 'IPTC', C2PA: 'Content Credentials', Comment: 'comments', Text: 'text chunks', Thumbnail: 'thumbnails', Photoshop: 'Photoshop data', Trailer: 'hidden trailing data', Time: 'timestamps', 'Text tag': 'text tags', Tag: 'other tags', Location: 'location tags', MakerNote: 'maker notes', 'Item data': 'metadata items' };
// Cleaner options by key. Refusals name the option that lifts them, and results list options that would
// remove what was kept.
const OPTIONS = {
  acceptChanges: 'Accept tracked changes in documents',
  removeMacros: 'Remove macros',
  removeSignatures: 'Remove digital signatures from PDFs',
  clearForms: 'Clear filled-in form fields in PDFs',
};
const OFFERS = { removeMacros: ['Macros kept.', 'to strip them'], clearForms: ['Filled-in form fields kept.', 'to empty them'] };
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>';

// Jobs run one at a time. A spare worker stands by so a hung file can be cancelled offline.
let worker = spawn(); let spare = spawn(); let next = 0; let running = null; let timer = null; const urls = [];
const waiting = [];

function spawn() {
  const w = new Worker('/metadata-cleaner/worker.js', { type: 'module' });
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
const chosen = () => Object.fromEntries([...document.querySelectorAll('[data-option]')].map((box) => [box.dataset.option, box.checked]));

function thumbnail(file) {
  const thumb = el('span', 'job-thumb');
  const icon = () => { thumb.innerHTML = FILE_ICON; thumb.classList.add('icon'); };
  if (!file.type.startsWith('image/')) { icon(); return thumb; }
  const img = el('img'); img.alt = ''; img.onerror = icon; img.src = track(file); thumb.append(img);
  return thumb;
}

function add(files) {
  if (!files.length) return;
  $('dropzone').hidden = true; $('queue').hidden = false;
  const options = chosen();
  for (const file of files) {
    const row = el('li', 'job'); row.dataset.state = 'waiting';
    const body = el('div', 'job-body'); body.append(el('strong', '', file.name), el('p', '', 'Waiting…'));
    row.append(thumbnail(file), body, el('span', 'state', ''));
    $('jobs').append(row);
    waiting.push({ id: next++, file, row, body, options });
  }
  title(); pump();
}

function title() {
  const rows = [...$('jobs').children];
  const finished = rows.filter((r) => r.dataset.state === 'done').length;
  $('queue-title').textContent = `${plural(rows.length, 'file')}, ${finished} cleaned`;
}

function pump() {
  if (running || !waiting.length) return;
  running = waiting.shift();
  const { file, row, body, options } = running;
  row.dataset.state = 'working';
  row.lastChild.replaceWith(el('span', 'spinner'));
  body.replaceChildren(body.firstChild, el('p', '', 'Cleaning…'));
  if (file.size > MAX_BYTES) { done({ id: running.id, ok: false, reason: 'This file is larger than 200 MB.' }); return; }
  timer = setTimeout(() => { restart(); done({ id: running.id, ok: false, reason: 'Cleaning took too long and was stopped.' }); }, TIMEOUT_MS);
  worker.postMessage({ id: running.id, file, options });
}

function done(result) {
  clearTimeout(timer);
  const job = running; running = null;
  const { file, row, body } = job;
  const status = body.lastChild;
  if (!result.ok) {
    row.dataset.state = 'error';
    const option = OPTIONS[result.option] && !job.options[result.option] ? result.option : null;
    status.textContent = option ? `${result.reason} Turn on “${OPTIONS[option]}” to clean it.` : result.reason;
    row.lastChild.replaceWith(option ? retryButton(job, option, 'Retry with option') : el('span', 'state', 'Not cleaned'));
  } else {
    row.dataset.state = 'done';
    const found = result.removed.length;
    if (!found) status.textContent = 'No metadata found. The file is unchanged.';
    else {
      const counts = new Map(); for (const b of result.removed) { const k = KINDS[b.kind] ?? b.kind.toLowerCase(); counts.set(k, (counts.get(k) ?? 0) + 1); }
      status.textContent = `Removed ${plural(found, 'block')}: ${[...counts.keys()].join(', ')}. ${size(result.bytesBefore)} → ${size(result.bytesAfter)}.`;
    }
    if (result.kept?.length) body.append(el('p', 'kept', `Kept: ${result.kept.join(', ')}.`));
    for (const option of (result.offer ?? []).filter((o) => OFFERS[o] && !job.options[o])) {
      const offer = el('p', 'offer', `${OFFERS[option][0]} Enable “${OPTIONS[option]}” ${OFFERS[option][1]}. `);
      offer.append(retryButton(job, option, 'Clean again'));
      body.append(offer);
    }
    const save = el('a', 'save', 'Save'); save.href = track(new Blob([result.data], { type: file.type || 'application/octet-stream' })); save.download = cleanName(file.name);
    save.setAttribute('aria-label', `Save cleaned ${file.name}`);
    row.lastChild.replaceWith(save);
  }
  title(); pump();
}

// Runs the job again with one more option turned on, in the same row.
function retryButton(job, option, label) {
  const button = el('button', label === 'Clean again' ? 'link-button' : 'retry', label); button.type = 'button';
  button.setAttribute('aria-label', `${label}: ${job.file.name} with “${OPTIONS[option]}”`);
  button.addEventListener('click', () => {
    const { row, body } = job;
    row.dataset.state = 'waiting';
    body.replaceChildren(body.firstChild, el('p', '', 'Waiting…'));
    row.lastChild.replaceWith(el('span', 'state', ''));
    waiting.push({ ...job, id: next++, options: { ...job.options, [option]: true } });
    title(); pump();
  });
  return button;
}

function reset() {
  clearTimeout(timer);
  if (running) { restart(); running = null; }
  waiting.length = 0;
  $('jobs').replaceChildren(); for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  $('queue').hidden = true; $('dropzone').hidden = false; $('file').value = '';
}

function optionsState() {
  const on = Object.values(chosen()).filter(Boolean).length;
  $('options-state').textContent = on ? `${on} on` : 'All off';
}

for (const box of document.querySelectorAll('[data-option]')) box.addEventListener('change', optionsState);
$('file').addEventListener('change', (e) => add([...e.target.files]));
$('again').addEventListener('click', () => { reset(); $('file').click(); });
const zone = $('dropzone');
for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
for (const type of ['dragleave', 'drop']) zone.addEventListener(type, () => zone.classList.remove('over'));
zone.addEventListener('drop', (e) => { e.preventDefault(); add([...e.dataTransfer.files]); });
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
window.addEventListener('pagehide', () => { for (const u of urls) URL.revokeObjectURL(u); });

// The list of formats comes from the clean module, so the page never lists one it cannot clean.
import('/lib/clean/index.js').then((m) => { const list = m.describeCleanable(); $('formats').textContent = `${list.charAt(0).toUpperCase()}${list.slice(1)}, up to 200 MB each.`; }, () => {});

// The inspectors hand over the file they just inspected.
if (location.hash === '#from-inspector') {
  history.replaceState(null, '', location.pathname);
  takeFile().then((file) => { if (file) add([file]); }, () => {});
} else clearFile();
