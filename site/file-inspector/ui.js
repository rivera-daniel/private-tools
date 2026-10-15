// Every extracted value is attacker-controlled. Render through textContent only.
import { clearFile, sendFile } from '/lib/handoff.js';

const $ = (id) => document.getElementById(id);
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const HIGHLIGHT_ORDER = ['Program', 'Provenance', 'Generation data', 'Location', 'Camera', 'People', 'Software', 'Dates', 'Description', 'Comments', 'Color profile', 'File'];
const OPEN_HIGHLIGHTS = new Set(['Program', 'Provenance', 'Generation data', 'Location', 'Camera', 'People']);
const PROVENANCE_ORDER = { declared: 0, clue: 1, credentials: 2 };
const LABELS = { declared: 'Declared', clue: 'Clue', credentials: 'Credentials', privacy: 'Exposed' };
// Line icons per category. Constant markup, never built from file data.
const ICONS = {
  Document: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 15.5h5M10 19h3"/>',
  Image: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="m4 16 4.5-4.5 3.5 3.5 2.5-2.5L20 18"/><circle cx="15.5" cy="9.5" r="1.5"/>',
  Audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  Video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/>',
  Archive: '<path d="M4 8h16v12H4zM3 4h18v4H3z"/><path d="M10 12h4"/>',
  Program: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2.5L7 15M12.5 15H17"/>',
  Other: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
};

// Workers load with the page, so inspecting a file needs no network access. A spare stands by so
// cancelling still works offline.
let worker = spawn(); let spare = spawn(); let pending = null; let timer = null; let previewUrl = null;
let cleanerFile = null;

function spawn() {
  const w = new Worker('/file-inspector/worker.js', { type: 'module' });
  w.onmessage = ({ data }) => { if (w !== worker) return; const job = pending; finish(); if (job) data.ok ? render(job, data.report, data.cleanable) : showError(job, data.error); };
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
const field = (report, source, key) => report.sources.find((s) => s.name === source)?.fields.find((f) => f.key === key)?.value;

function finish() { pending = null; clearTimeout(timer); }

// Terminating is the only way to stop a parse in progress. The spare replaces it.
function restart() { finish(); worker.terminate(); worker = spare; spare = spawn(); }

function reset() {
  if (pending) restart();
  for (const id of ['signals', 'privacy', 'highlights', 'sources', 'technical', 'structure', 'warnings']) $(id).replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null; cleanerFile = null;
  $('preview').removeAttribute('src'); $('preview').hidden = true; $('type-icon').hidden = true;
  $('filter').value = '';
  $('results').hidden = true; $('busy').hidden = true; $('dropzone').hidden = false;
  $('file').value = '';
}

function inspect(file) {
  if (!file) return;
  reset();
  if (file.size > MAX_BYTES) { showError(file, 'This file is larger than 200 MB. Choose a smaller file.'); return; }
  $('dropzone').hidden = true; $('busy').hidden = false; $('busy-name').textContent = file.name;
  pending = file;
  timer = setTimeout(() => { restart(); showError(file, 'Inspection took too long and was stopped.'); }, TIMEOUT_MS);
  worker.postMessage(file);
}

function showIcon(category) {
  $('preview').hidden = true;
  $('preview-frame').classList.add('icon-frame');
  const icon = $('type-icon');
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[category] ?? ICONS.Other}</svg>`;
  icon.hidden = false;
}

// Only images get a preview. A browser that cannot decode the format falls back to the icon.
function showFrame(file, facts, category) {
  $('busy').hidden = true; $('results').hidden = false;
  $('file-name').textContent = file.name;
  $('file-facts').textContent = facts;
  $('preview-frame').classList.remove('icon-frame');
  if (category !== 'Image') { showIcon(category); return; }
  previewUrl = URL.createObjectURL(file);
  $('preview').onerror = () => showIcon('Image');
  $('preview').hidden = false;
  $('preview').src = previewUrl;
}

function showError(file, message) {
  showFrame(file, formatBytes(file.size), 'Other');
  setCard('summary', { level: 'error', title: 'This file could not be inspected', detail: message });
  for (const id of ['privacy-block', 'cleaner', 'provenance', 'highlights-block', 'sources-block', 'warnings']) $(id).hidden = true;
}

function setCard(id, { level, title, detail }) {
  $(id).dataset.level = level;
  $(`${id}-title`).textContent = title;
  $(`${id}-detail`).textContent = detail;
}

function typeLabel(report) {
  const detected = field(report, 'File type', 'Detected type');
  if (report.format === 'Text' || !report.format) return detected ?? 'Unknown type';
  return report.format;
}

function render(file, report, cleanable) {
  if (!report.category) { showError(file, report.warnings[0] ?? 'This file could not be read.'); return; }
  const label = typeLabel(report);
  showFrame(file, [label, report.category !== label && report.category, report.width && `${report.width} × ${report.height}`, formatBytes(report.size)].filter(Boolean).join(' · '), report.category);
  setCard('summary', report.summary);
  $('provenance').hidden = !report.provenance;
  if (report.provenance) setCard('provenance', report.provenance);

  $('warnings').replaceChildren(...report.warnings.map((w) => el('p', '', w)));
  $('warnings').hidden = report.warnings.length === 0;

  fillSignals('privacy', report.signals.filter((s) => s.kind === 'privacy'));
  $('privacy-block').hidden = !report.signals.some((s) => s.kind === 'privacy');
  fillSignals('signals', report.signals.filter((s) => s.kind !== 'privacy').sort((a, b) => PROVENANCE_ORDER[a.kind] - PROVENANCE_ORDER[b.kind]));
  $('signals').hidden = !report.signals.some((s) => s.kind !== 'privacy');

  const { blocks: removable, bytes: removableBytes } = report.cleanable;
  cleanerFile = cleanable && removable > 0 ? file : null;
  $('cleaner').hidden = removable === 0;
  $('cleaner-title').textContent = `${plural(removable, 'metadata block')} (${formatBytes(removableBytes)}) can be removed`;
  $('cleaner-detail').textContent = cleanable
    ? `Open this file in Metadata Cleaner to remove ${removable === 1 ? 'it' : 'them'} on your device.`
    : `Metadata Cleaner cannot rewrite ${label} files yet.`;

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
  $('structure-group').hidden = report.structure.length === 0;
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
    if (text.length > 240 || text.split('\n').length > 4) {
      const more = el('details', 'long');
      more.append(el('summary', '', `${text.slice(0, 140).split('\n')[0]}…`), el('pre', '', text.length > 20000 ? `${text.slice(0, 20000)}\n… ${text.length - 20000} more characters` : text));
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

// The cleaner card opens Metadata Cleaner with this file already queued.
$('cleaner').addEventListener('click', async (e) => {
  if (!cleanerFile || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  try { await sendFile(cleanerFile); location.assign('/metadata-cleaner/#from-inspector'); } catch { location.assign('/metadata-cleaner/'); }
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
