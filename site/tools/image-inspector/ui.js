// Every extracted value is attacker-controlled. Render through textContent only.
import { clearFile, sendFile } from '/tools/lib/handoff.js';

const $ = (id) => document.getElementById(id);
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const HIGHLIGHT_ORDER = ['Provenance', 'Generation data', 'Location', 'Camera', 'People', 'Software', 'Dates', 'Description', 'Comments', 'Color profile', 'File'];
const OPEN_HIGHLIGHTS = new Set(['Provenance', 'Generation data', 'Location', 'Camera', 'People']);
const CLEANABLE = new Set(['JPEG', 'PNG', 'WebP', 'GIF']);
const PROVENANCE_ORDER = { declared: 0, clue: 1, credentials: 2 };
const LABELS = { declared: 'Declared', clue: 'Clue', credentials: 'Credentials', privacy: 'Exposed' };
const SUPPORTED = new Set(['JPEG', 'PNG', 'WebP', 'HEIC', 'HEIF', 'AVIF', 'JPEG XL', 'GIF', 'TIFF', 'DNG', 'CR2', 'CR3', 'NEF', 'ARW', 'ORF', 'RW2', 'PEF', 'RAF', 'PSD', 'PSB', 'BMP', 'SVG']);

// Workers load with the page, so inspecting a file needs no network access. A spare stands by so
// cancelling still works offline.
let worker = spawn(); let spare = spawn(); let pending = null; let timer = null; let previewUrl = null;
let cleanerFile = null;

function spawn() {
  const w = new Worker('/tools/image-inspector/worker.js', { type: 'module' });
  w.onmessage = ({ data }) => { if (w !== worker) return; const job = pending; finish(); if (job) data.ok ? render(job, data.report) : showError(job, data.error); };
  w.onerror = (event) => { event.preventDefault(); if (w !== worker) return; const job = pending; restart(); if (job) showError(job, 'The inspector stopped unexpectedly. The file may be damaged.'); };
  return w;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function finish() { pending = null; clearTimeout(timer); }

// Terminating is the only way to stop a parse in progress. The spare replaces it.
function restart() { finish(); worker.terminate(); worker = spare; spare = spawn(); }

function reset() {
  if (pending) restart();
  for (const id of ['signals', 'privacy', 'highlights', 'sources', 'technical', 'structure', 'warnings']) $(id).replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null; cleanerFile = null;
  $('preview').removeAttribute('src'); $('preview').hidden = false; $('no-preview').hidden = true;
  $('filter').value = '';
  $('results').hidden = true; $('busy').hidden = true; $('dropzone').hidden = false;
  $('file').value = '';
}

function inspect(file) {
  if (!file) return;
  reset();
  if (file.size > MAX_BYTES) { showError(file, 'This file is larger than 200 MB. Choose a smaller image.'); return; }
  $('dropzone').hidden = true; $('busy').hidden = false; $('busy-name').textContent = file.name;
  pending = file;
  timer = setTimeout(() => { restart(); showError(file, 'Inspection took too long and was stopped.'); }, TIMEOUT_MS);
  worker.postMessage(file);
}

function showFrame(file, facts) {
  $('busy').hidden = true; $('results').hidden = false;
  $('file-name').textContent = file.name;
  $('file-facts').textContent = facts;
  // Try a preview for every file. Browsers that cannot decode a format fire an error and get a placeholder.
  previewUrl = URL.createObjectURL(file);
  $('preview').onerror = () => { $('preview').hidden = true; $('no-preview').hidden = false; };
  $('preview').src = previewUrl;
}

function showError(file, message) {
  showFrame(file, formatBytes(file.size));
  setCard('summary', { level: 'error', title: 'This file could not be inspected', detail: message });
  for (const id of ['privacy-block', 'cleaner', 'provenance', 'highlights-block', 'sources-block', 'warnings']) $(id).hidden = true;
}

function setCard(id, { level, title, detail }) {
  $(id).dataset.level = level;
  $(`${id}-title`).textContent = title;
  $(`${id}-detail`).textContent = detail;
}

function render(file, report) {
  if (!SUPPORTED.has(report.format)) { showError(file, report.warnings[0] ?? 'This file is not a supported image.'); return; }
  showFrame(file, [report.format, report.width && `${report.width} × ${report.height}`, formatBytes(report.size)].filter(Boolean).join(' · '));
  setCard('summary', report.summary);
  $('provenance').hidden = false;
  setCard('provenance', report.provenance);

  $('warnings').replaceChildren(...report.warnings.map((w) => el('p', '', w)));
  $('warnings').hidden = report.warnings.length === 0;

  fillSignals('privacy', report.signals.filter((s) => s.kind === 'privacy'));
  $('privacy-block').hidden = !report.signals.some((s) => s.kind === 'privacy');
  fillSignals('signals', report.signals.filter((s) => s.kind !== 'privacy').sort((a, b) => PROVENANCE_ORDER[a.kind] - PROVENANCE_ORDER[b.kind]));
  $('signals').hidden = !report.signals.some((s) => s.kind !== 'privacy');

  const { blocks: removable, bytes: removableBytes } = report.cleanable;
  const cleanable = CLEANABLE.has(report.format);
  cleanerFile = cleanable && removable > 0 ? file : null;
  $('cleaner').hidden = removable === 0;
  $('cleaner-title').textContent = `${plural(removable, 'metadata block')} (${formatBytes(removableBytes)}) can be removed`;
  $('cleaner-detail').textContent = cleanable
    ? `Open this image in Metadata Cleaner to remove ${removable === 1 ? 'it' : 'them'} on your device.`
    : `Metadata Cleaner supports JPEG, PNG, WebP and GIF. ${report.format} support is planned.`;

  const highlights = [...report.highlights].sort((a, b) => order(a.name) - order(b.name));
  $('highlights').replaceChildren(...highlights.map((g) => renderGroup(g, OPEN_HIGHLIGHTS.has(g.name))));
  $('highlights-block').hidden = highlights.length === 0;

  const metadata = report.sources.filter((s) => !s.technical);
  const technical = report.sources.filter((s) => s.technical);
  $('sources-title').textContent = `All metadata · ${plural(report.fieldCount, 'field')}`;
  $('sources').replaceChildren(...metadata.map((g) => renderGroup(g, false)));
  $('technical').replaceChildren(...technical.map((g) => renderGroup(g, false)));
  $('technical-title').hidden = technical.length === 0;
  $('structure').replaceChildren(...report.structure.map(structureRow));
  $('structure-count').textContent = String(report.structure.length);
  $('sources-block').hidden = false;
  $('filter-empty').hidden = true;
  $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

const order = (name) => { const i = HIGHLIGHT_ORDER.indexOf(name); return i < 0 ? 99 : i; };

function fillSignals(id, signals) {
  $(id).replaceChildren(...signals.map((s) => {
    const li = el('li', `signal ${s.kind}`);
    const body = el('div');
    body.append(el('strong', '', s.title), el('p', '', s.detail), el('small', '', `Source: ${s.source}`));
    li.append(el('span', 'tag', LABELS[s.kind]), body);
    return li;
  }));
}

function renderGroup(group, open) {
  const section = el('details', 'group');
  section.open = open;
  const summary = el('summary');
  summary.append(el('span', '', group.name), el('span', 'count', String(group.fields.length)));
  const list = el('dl');
  for (const f of group.fields) {
    const row = el('div', f.flag === 'privacy' ? 'row exposed' : 'row');
    row.dataset.search = `${f.key} ${f.value}`.toLowerCase().slice(0, 2000);
    const value = el('dd');
    const text = String(f.value);
    if (text.length > 240) {
      const more = el('details', 'long');
      more.append(el('summary', '', `${text.slice(0, 140)}…`), el('pre', '', text.length > 20000 ? `${text.slice(0, 20000)}\n… ${text.length - 20000} more characters` : text));
      value.append(more);
    } else value.textContent = text;
    row.append(el('dt', '', f.key), value);
    list.append(row);
  }
  section.append(summary, list);
  return section;
}

function structureRow(s) {
  const tr = el('tr');
  tr.append(el('td', 'mono', s.offset === undefined ? '' : `0x${s.offset.toString(16).toUpperCase()}`), el('td', '', s.type), el('td', '', formatBytes(s.length)), el('td', '', s.note || ''));
  return tr;
}

function applyFilter() {
  const q = $('filter').value.trim().toLowerCase();
  let any = false;
  for (const group of $('sources').children) {
    let hits = 0;
    for (const row of group.querySelectorAll('.row')) { const show = !q || row.dataset.search.includes(q); row.hidden = !show; if (show) hits++; }
    group.hidden = hits === 0;
    if (q) group.open = hits > 0;
    any ||= hits > 0;
  }
  $('filter-empty').hidden = any || !q;
}

// The cleaner card opens Metadata Cleaner with this image already queued.
$('cleaner').addEventListener('click', async (e) => {
  if (!cleanerFile || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  try { await sendFile(cleanerFile); location.assign('/tools/metadata-cleaner/#from-inspector'); } catch { location.assign('/tools/metadata-cleaner/'); }
});
clearFile();

$('filter').addEventListener('input', applyFilter);
$('file').addEventListener('change', (e) => inspect(e.target.files[0]));
$('cancel').addEventListener('click', reset);
$('again').addEventListener('click', () => { reset(); $('file').click(); });
const zone = $('dropzone');
for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
for (const type of ['dragleave', 'drop']) zone.addEventListener(type, () => zone.classList.remove('over'));
zone.addEventListener('drop', (e) => { e.preventDefault(); inspect(e.dataTransfer.files[0]); });
// Dropping elsewhere on the page must not navigate the browser to the file.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
window.addEventListener('pagehide', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
