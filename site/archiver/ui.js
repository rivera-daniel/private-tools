// Archiver page. File and entry names come from the user's files and archives: render through textContent only.
import { clearFile, sendFile } from '/lib/handoff.js';
import { archiveBase } from '/lib/archive/destination.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const size = (n) => (n === null || n === undefined ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const plural = (n, w, ws = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`;
const pad = (n) => String(n).padStart(2, '0');
const date = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—');
const SVG = 'http://www.w3.org/2000/svg';
function icon(d) { const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.append(p); return s; }
const ICONS = {
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  remove: 'M6 6l12 12M18 6 6 18',
};
const BIG = 512 * 1024 * 1024; // Above this, Chromium writes straight to a file the visitor picks.
const MAX_ROWS = 1000;
const canPickFolder = typeof window.showDirectoryPicker === 'function';
const canPickFile = typeof window.showSaveFilePicker === 'function';

// One worker runs one job at a time. Cancel asks it to stop; a worker that does not answer is replaced.
let worker; let job = null; let nextId = 1; let openFile = null;
function spawn() {
  worker = new Worker('/archiver/worker.js', { type: 'module' });
  worker.onmessage = ({ data }) => { if (job && data.id === job.id) job.handle(data); };
  worker.onerror = (event) => { event.preventDefault(); if (job) { const j = job; job = null; j.handle({ type: 'error', message: 'The archiver stopped unexpectedly. The file may be damaged.' }); } };
}
spawn();

function run(message, handlers) {
  const id = nextId++;
  job = { id, handle: (data) => {
    if (data.type === 'progress') { handlers.progress?.(data); return; }
    job = null;
    if (data.type === 'error') handlers.error(data); else handlers.done(data);
  } };
  worker.postMessage({ ...message, id });
}

function cancelJob() {
  if (!job) return;
  const pending = job;
  worker.postMessage({ type: 'cancel' });
  setTimeout(() => {
    if (job !== pending) return;
    worker.terminate(); spawn(); job = null;
    pending.handle({ type: 'error', cancelled: true, message: 'Cancelled.' });
    if (openFile) run({ type: 'open', file: openFile }, { done() {}, error() {} });
  }, 4000);
}

const urls = [];
function download(blob, name) {
  const url = URL.createObjectURL(blob); urls.push(url);
  const a = el('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
}
window.addEventListener('pagehide', () => { for (const u of urls) URL.revokeObjectURL(u); });

async function pickSave(name) {
  try { return await window.showSaveFilePicker({ suggestedName: name }); }
  catch (error) { if (error.name === 'AbortError') return undefined; throw error; }
}

function showProgress(prefix, { done, total, name }) {
  $(`${prefix}-bar`).style.width = total ? `${Math.min(100, (done / total) * 100).toFixed(1)}%` : '0%';
  $(`${prefix}-busy-detail`).textContent = total ? `${size(done)} of ${size(total)}${name ? ` · ${name}` : ''}` : name ?? '';
}

function setBusy(prefix, title) {
  $(`${prefix}-busy`).hidden = !title;
  if (title) { $(`${prefix}-busy-title`).textContent = title; $(`${prefix}-bar`).style.width = '0%'; $(`${prefix}-busy-detail`).textContent = ''; }
}

function showError(id, message) { $(id).hidden = !message; $(id).textContent = message ?? ''; }

/* Tabs */
const tabs = [$('tab-create'), $('tab-open')];
function selectTab(tab) {
  if (job) return;
  for (const t of tabs) { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; $(t.getAttribute('aria-controls')).hidden = !on; }
}
for (const t of tabs) {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const other = tabs[1 - tabs.indexOf(t)]; selectTab(other); other.focus(); } });
}

/* Create */
let items = []; let nameEdited = false;

async function walk(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path: prefix + file.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader(); const children = [];
    for (;;) { const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); if (!batch.length) break; children.push(...batch); }
    if (!children.length) out.push({ path: `${prefix}${entry.name}`, directory: true });
    for (const child of children) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

function addItems(list) {
  if (!list.length) return;
  const seen = new Set(items.map((i) => i.path));
  for (const item of list) if (!seen.has(item.path)) { seen.add(item.path); items.push(item); }
  items.sort((a, b) => a.path.localeCompare(b.path));
  $('create-result').hidden = true; showError('create-error', null);
  renderCreate();
}

function renderCreate() {
  const has = items.length > 0;
  $('create-drop').hidden = has; $('create-panel').hidden = !has;
  if (!has) return;
  const files = items.filter((i) => !i.directory); const total = files.reduce((n, i) => n + i.file.size, 0);
  $('create-title').textContent = `${plural(files.length, 'file')}${items.length > files.length ? `, ${plural(items.length - files.length, 'empty folder')}` : ''} · ${size(total)}`;
  const rows = items.slice(0, MAX_ROWS).map((item, index) => {
    const tr = el('tr'); const name = el('td'); const wrap = el('div', 'name');
    wrap.append(icon(item.directory ? ICONS.folder : ICONS.file), el('span', item.directory ? 'dir' : '', item.directory ? `${item.path}/` : item.path));
    name.append(wrap);
    const remove = el('button', 'icon-only'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${item.path}`); remove.append(icon(ICONS.remove));
    remove.addEventListener('click', () => { items.splice(index, 1); renderCreate(); });
    const act = el('td', 'act'); act.append(remove);
    tr.append(name, el('td', 'num', item.directory ? '—' : size(item.file.size)), act);
    return tr;
  });
  $('create-list').replaceChildren(...rows);
  $('create-more').hidden = items.length <= MAX_ROWS;
  $('create-more').textContent = `And ${plural(items.length - MAX_ROWS, 'more item')}.`;
  updateOptions();
}

const formatOf = () => document.querySelector('input[name=format]:checked').value;
const EXT = { zip: '.zip', 'tar.gz': '.tar.gz', tar: '.tar', gz: '.gz', '7z': '.7z' };

function defaultName() {
  const tops = new Set(items.map((i) => i.path.split('/')[0]));
  return tops.size === 1 ? [...tops][0] : 'archive';
}

function updateOptions() {
  const files = items.filter((i) => !i.directory);
  const gzOk = files.length === 1 && items.length === 1;
  const gz = document.querySelector('input[name=format][value=gz]');
  gz.disabled = !gzOk;
  if (!gzOk && gz.checked) document.querySelector('input[name=format][value="tar.gz"]').checked = true;
  const format = formatOf();
  $('method-field').hidden = format !== 'zip';
  $('password').disabled = format !== 'zip'; $('reveal').disabled = format !== 'zip';
  $('password').placeholder = format === 'zip' ? 'No password' : 'Only ZIP archives can have a password';
  $('archive-ext').textContent = EXT[format];
  $('format-hint').textContent = { zip: 'Opens everywhere. Supports passwords.', 'tar.gz': 'Common on Linux and macOS. Compresses all files together.', tar: 'Uncompressed. Common on Linux and macOS.', gz: 'A single compressed file.', '7z': 'Usually the smallest. Opens in 7-Zip, Keka and most archive apps. Up to 1 GB.' }[format];
  if (!nameEdited) {
    let base = defaultName();
    if (format === 'gz' && files.length === 1) base = files[0].path.split('/').pop();
    else if (items.length === 1 && !items[0].directory) base = base.replace(/\.[^.]+$/, '') || base;
    $('archive-name').value = base;
  }
}

$('create-drop').addEventListener('click', (e) => { if (!e.target.closest('button')) $('create-files').click(); });
$('pick-files').addEventListener('click', () => $('create-files').click());
$('pick-folder').addEventListener('click', () => $('create-folder').click());
$('add-files').addEventListener('click', () => $('create-files').click());
$('add-folder').addEventListener('click', () => $('create-folder').click());
$('create-files').addEventListener('change', (e) => { addItems([...e.target.files].map((file) => ({ file, path: file.name }))); e.target.value = ''; });
$('create-folder').addEventListener('change', (e) => { addItems([...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))); e.target.value = ''; });
$('clear').addEventListener('click', () => { items = []; nameEdited = false; renderCreate(); });
$('archive-name').addEventListener('input', () => { nameEdited = true; });
for (const r of document.querySelectorAll('input[name=format]')) r.addEventListener('change', updateOptions);
$('reveal').addEventListener('click', () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password'; $('reveal').textContent = show ? 'Hide' : 'Show'; $('reveal').setAttribute('aria-pressed', String(show));
});

function dropTarget(zone, onDrop) {
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
  for (const type of ['dragleave', 'drop']) zone.addEventListener(type, () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); onDrop(e.dataTransfer); });
}
async function droppedItems(transfer) {
  // Entries must be taken while the drop event is still running.
  const entries = [...transfer.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = [...transfer.files];
  if (!entries.length) return files.map((file) => ({ file, path: file.name }));
  const out = [];
  for (const entry of entries) await walk(entry, '', out);
  return out;
}
dropTarget($('create-drop'), async (transfer) => {
  try { addItems(await droppedItems(transfer)); } catch { showError('create-error', 'Some dropped items could not be read.'); }
});
dropTarget($('create-panel'), async (transfer) => {
  try { addItems(await droppedItems(transfer)); } catch { showError('create-error', 'Some dropped items could not be read.'); }
});
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (job || !items.length) return;
  const format = formatOf();
  const name = `${($('archive-name').value.trim() || 'archive').replace(/[\\/:*?"<>|]+/g, '-')}${EXT[format]}`;
  const options = { format, method: document.querySelector('input[name=method]:checked').value, password: format === 'zip' ? $('password').value || null : null, clean: $('clean').checked, hideDates: $('hide-dates').checked };
  const total = items.reduce((n, i) => n + (i.directory ? 0 : i.file.size), 0);
  showError('create-error', null);
  let handle = null;
  if (canPickFile && total > BIG) { try { handle = await pickSave(name); } catch { handle = null; } if (handle === undefined) return; }
  $('create-panel').hidden = true; setBusy('create', options.clean ? 'Cleaning and archiving…' : 'Creating archive…');
  run({ type: 'create', items: items.map((i) => ({ file: i.file, path: i.path, directory: Boolean(i.directory) })), options, handle }, {
    progress: (p) => showProgress('create', p),
    done: (r) => { setBusy('create', null); showResult(r, name, options); },
    error: (r) => { setBusy('create', null); $('create-panel').hidden = false; if (!r.cancelled) showError('create-error', r.message); },
  });
});
$('create-cancel').addEventListener('click', cancelJob);

function showResult(r, name, options) {
  $('create-result').hidden = false;
  $('result-title').textContent = name;
  const parts = [`${plural(r.count, 'entry', 'entries')}`, size(r.size)];
  if (options.password) parts.push('AES-256 encrypted');
  $('result-detail').textContent = r.blob ? parts.join(' · ') : `${parts.join(' · ')} · saved to the file you chose`;
  const save = $('result-save');
  save.hidden = !r.blob;
  if (r.blob) { const url = URL.createObjectURL(r.blob); urls.push(url); save.href = url; save.download = name; save.setAttribute('aria-label', `Save ${name}`); }
  const report = [];
  if (options.clean) {
    if (r.cleaned.length) {
      const li = el('li'); const d = el('details'); d.append(el('summary', '', `Hidden data removed from ${plural(r.cleaned.length, 'file')}.`));
      const ul = el('ul'); for (const c of r.cleaned) { const item = el('li'); item.append(el('span', '', `${c.path}: ${plural(c.removed, 'block')} removed, ${size(c.before)} → ${size(c.after)}`)); ul.append(item); }
      d.append(ul); li.append(d); report.push(li);
    } else report.push(el('li', '', 'No hidden data was found in files the Metadata Cleaner supports.'));
    if (r.kept.length) {
      const li = el('li'); const d = el('details'); d.append(el('summary', '', `${plural(r.kept.length, 'file')} added unchanged because the Metadata Cleaner cannot clean ${r.kept.length === 1 ? 'it' : 'them'}.`));
      const ul = el('ul'); for (const k of r.kept) { const item = el('li'); item.append(el('span', '', `${k.path}: ${k.reason}`)); ul.append(item); }
      d.append(ul); li.append(d); report.push(li);
    }
  }
  report.push(el('li', '', options.hideDates ? 'Every entry is dated 1 January 1980. No owner, comment or extra field is stored.' : 'Entries keep their last-modified dates. No owner, comment or extra field is stored.'));
  $('result-report').replaceChildren(...report);
}
$('result-back').addEventListener('click', () => { $('create-result').hidden = true; $('create-panel').hidden = false; });
$('result-new').addEventListener('click', () => { $('create-result').hidden = true; items = []; nameEdited = false; $('password').value = ''; renderCreate(); });

/* Open */
let listing = null; let selected = new Set(); let password = null; let lockedFile = null;
const extractable = (e) => e.kind === 'file' && e.path;

dropTarget($('open-drop'), (transfer) => { const file = transfer.files[0]; if (file) openArchive(file); });
$('open-file').addEventListener('change', (e) => { const file = e.target.files[0]; e.target.value = ''; if (file) openArchive(file); });
$('open-another').addEventListener('click', () => { if (job) return; resetOpen(); $('open-file').click(); });
$('open-cancel').addEventListener('click', cancelJob);

function resetOpen() {
  listing = null; openFile = null; password = null; selected = new Set(); lockedFile = null;
  $('list-card').hidden = false; $('extract-run').hidden = false; $('unlock').dataset.state = '';
  $('unlock-detail').textContent = 'Enter the password to extract its files.';
  $('unlock-password').value = '';
  $('open-panel').hidden = true; $('open-drop').hidden = false; $('unlock').hidden = true; $('open-done').hidden = true; showError('open-error', null);
}

function openArchive(file, withPassword = null) {
  if (job) return;
  if (!withPassword) resetOpen();
  $('open-drop').hidden = true; $('open-panel').hidden = true; setBusy('open', 'Reading archive…'); $('open-busy-detail').textContent = file.name;
  run({ type: 'open', file, password: withPassword }, {
    done: (r) => {
      setBusy('open', null); openFile = file; listing = r; lockedFile = null; password = withPassword;
      $('list-card').hidden = false; $('extract-run').hidden = false;
      selected = new Set(r.entries.filter(extractable).map((e) => e.id)); renderOpen();
    },
    error: (r) => {
      setBusy('open', null);
      if (r.needsPassword) { showLocked(file, r.wrongPassword); return; }
      $('open-drop').hidden = false; if (!r.cancelled) showError('open-error', r.message);
    },
  });
}

// Archives that encrypt their file names cannot be listed before the password is known.
function showLocked(file, wrong) {
  lockedFile = file; openFile = file;
  $('open-panel').hidden = false; $('list-card').hidden = true; $('extract-run').hidden = true; $('open-warnings').hidden = true; done(null);
  $('archive-name-out').textContent = file.name;
  $('archive-facts').textContent = 'Encrypted archive · file names are hidden';
  $('unlock').hidden = false;
  if (wrong) wrongPassword();
  else { $('unlock-detail').textContent = 'This archive encrypts its file names too. Enter the password to open it.'; $('unlock-password').focus(); }
}

const FORMAT_LABEL = { zip: 'ZIP archive', tar: 'tar archive', 'tar.gz': 'tar.gz archive', gz: 'gzip file', '7z': '7z archive' };

function renderOpen() {
  $('open-panel').hidden = false;
  $('archive-name-out').textContent = openFile.name;
  const files = listing.entries.filter((e) => e.kind === 'file');
  const total = files.reduce((n, e) => n + (e.size ?? 0), 0);
  const encrypted = files.filter((e) => e.encrypted);
  const unknown = files.some((e) => e.size === null);
  const facts = [listing.label ?? FORMAT_LABEL[listing.format] ?? listing.format, plural(files.length, 'file'), unknown ? 'unpacked size unknown' : `${size(total)} unpacked`, `${size(listing.size)} packed`];
  if (encrypted.length && !listing.decrypts) facts.push('encrypted');
  else if (encrypted.length) facts.push(encrypted.some((e) => e.weak) && encrypted.every((e) => e.weak) ? 'legacy ZipCrypto encryption' : encrypted.some((e) => e.weak) ? 'mixed encryption' : 'AES encrypted');
  $('archive-facts').textContent = facts.join(' · ');
  const warnings = [...listing.warnings];
  const blocked = listing.entries.filter((e) => !e.path && e.kind !== 'directory').length; const links = listing.entries.filter((e) => e.kind === 'symlink' || e.kind === 'hardlink').length;
  if (blocked) warnings.push(`${plural(blocked, 'entry', 'entries')} would be written outside the chosen folder and will be skipped.`);
  if (links) warnings.push(`${plural(links, 'link')} in this archive will not be extracted. Links can point anywhere on your disk.`);
  if (encrypted.some((e) => e.weak)) warnings.push('Some files use legacy ZipCrypto encryption, which is easy to break. Do not rely on it to protect anything.');
  $('open-warnings').hidden = !warnings.length;
  $('open-warnings').replaceChildren(...warnings.map((w) => el('p', '', w)));
  $('unlock').hidden = !encrypted.length || password !== null || !listing.decrypts;
  $('extract-folder').hidden = !canPickFolder; $('extract-here-label').hidden = !canPickFolder;
  $('extract-zip').className = canPickFolder ? 'ghost' : 'primary';
  renderEntries();
}

function renderEntries() {
  const query = $('entry-filter').value.trim().toLowerCase();
  const shown = listing.entries.filter((e) => (e.path || e.kind !== 'directory') && (!query || e.name.toLowerCase().includes(query)));
  const rows = shown.slice(0, MAX_ROWS).map((e) => {
    const tr = el('tr'); if (!e.path || e.kind === 'symlink' || e.kind === 'hardlink' || e.kind === 'other') tr.className = 'blocked';
    const pick = el('td', 'pick');
    if (extractable(e)) {
      const box = el('input'); box.type = 'checkbox'; box.checked = selected.has(e.id); box.setAttribute('aria-label', `Select ${e.name}`);
      box.addEventListener('change', () => { if (box.checked) selected.add(e.id); else selected.delete(e.id); renderSelection(); });
      pick.append(box);
    }
    const name = el('td'); const wrap = el('div', 'name');
    const label = el('span', e.kind === 'directory' ? 'dir' : '', e.name);
    wrap.append(icon(e.kind === 'directory' ? ICONS.folder : e.kind === 'symlink' || e.kind === 'hardlink' ? ICONS.link : ICONS.file), label);
    if (e.encrypted) { const tag = el('span', e.weak ? 'tag-mini weak' : 'tag-mini'); tag.append(icon(ICONS.lock), document.createTextNode(e.weak ? 'ZipCrypto' : 'AES')); wrap.append(tag); }
    name.append(wrap);
    const NOTE = { absolute: 'Stored with an absolute path. It is extracted inside the chosen folder.', renamed: 'Control characters in the name were replaced.', traversal: 'Blocked: the name points outside the extraction folder.', empty: 'Blocked: the entry has no usable name.' };
    let note = NOTE[e.note] ?? '';
    if (e.kind === 'symlink' || e.kind === 'hardlink') note = 'Link, not extracted.';
    else if (e.kind === 'other') note = 'Special file, not extracted.';
    if (note) name.append(el('span', 'note', note));
    const act = el('td', 'act');
    if (extractable(e)) {
      const save = el('button', 'row-button', 'Save'); save.type = 'button'; save.setAttribute('aria-label', `Save ${e.name}`);
      save.addEventListener('click', () => saveOne(e));
      const inspect = el('button', 'row-button', 'Inspect'); inspect.type = 'button'; inspect.setAttribute('aria-label', `Inspect ${e.name}`);
      inspect.addEventListener('click', () => inspectOne(e));
      act.append(save, inspect);
    }
    tr.append(pick, name, el('td', 'num', e.kind === 'directory' ? '—' : size(e.size)), el('td', 'num packed', e.compressedSize === null || e.kind === 'directory' ? '—' : size(e.compressedSize)), el('td', 'date', date(e.modified)), act);
    return tr;
  });
  $('open-list').replaceChildren(...rows);
  $('open-more').hidden = shown.length <= MAX_ROWS;
  $('open-more').textContent = `Showing ${MAX_ROWS.toLocaleString('en-US')} of ${shown.length.toLocaleString('en-US')} entries. Use the filter to find others; selection includes all of them.`;
  renderSelection();
}

function renderSelection() {
  const all = listing.entries.filter(extractable);
  const chosen = all.filter((e) => selected.has(e.id));
  const bytes = chosen.reduce((n, e) => n + (e.size ?? 0), 0);
  $('selection').textContent = `${chosen.length.toLocaleString('en-US')} of ${plural(all.length, 'file')} selected · ${size(bytes)}`;
  $('select-all').checked = chosen.length === all.length && all.length > 0;
  $('select-all').indeterminate = chosen.length > 0 && chosen.length < all.length;
  $('extract-folder').disabled = !chosen.length; $('extract-zip').disabled = !chosen.length;
}
$('select-all').addEventListener('change', () => {
  selected = $('select-all').checked ? new Set(listing.entries.filter(extractable).map((e) => e.id)) : new Set();
  renderEntries();
});
$('entry-filter').addEventListener('input', () => renderEntries());

$('unlock').addEventListener('submit', (e) => {
  e.preventDefault();
  if (job) return;
  const value = $('unlock-password').value;
  if (!value) return;
  if (lockedFile) { openArchive(lockedFile, value); return; }
  setBusy('open', 'Checking password…');
  run({ type: 'check', password: value }, {
    done: () => { setBusy('open', null); password = value; $('unlock').hidden = true; $('unlock').dataset.state = ''; done(`Password accepted.`); },
    error: (r) => { setBusy('open', null); if (r.needsPassword) wrongPassword(); else if (!r.cancelled) showError('open-error', r.message); },
  });
});

function wrongPassword() {
  password = null; $('unlock').hidden = false; $('unlock').dataset.state = 'wrong';
  $('unlock-detail').textContent = 'That password is not correct. Try again.';
  $('unlock-password').select(); $('unlock-password').focus();
}

function needsPasswordFirst(ids) {
  const set = new Set(ids);
  if (password === null && listing.entries.some((e) => set.has(e.id) && e.encrypted)) {
    $('unlock').hidden = false; $('unlock-detail').textContent = 'Enter the password to extract the encrypted files.'; $('unlock-password').focus();
    return true;
  }
  return false;
}

function done(message) { $('open-done').hidden = !message; $('open-done').textContent = message ?? ''; }

function extractJob(message, title, onDone) {
  showError('open-error', null); done(null);
  setBusy('open', title);
  run({ ...message, password }, {
    progress: (p) => showProgress('open', p),
    done: (r) => { setBusy('open', null); onDone(r); },
    error: (r) => { setBusy('open', null); if (r.needsPassword && r.wrongPassword) wrongPassword(); else if (r.needsPassword) needsPasswordFirst(message.ids ?? [message.entryId]); else if (!r.cancelled) showError('open-error', r.message); },
  });
}

const baseName = () => archiveBase(openFile.name);

// By default files go into a new folder named after the archive. Extracting directly into the chosen folder
// first checks which names already exist there and asks what to do with each before anything is written.
$('extract-folder').addEventListener('click', async () => {
  if (job) return;
  const ids = [...selected];
  if (!ids.length || needsPasswordFirst(ids)) return;
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (error) { if (error.name !== 'AbortError') showError('open-error', 'The folder could not be opened for writing.'); return; }
  if (!$('extract-here').checked) { toFolder(ids, dir, 'new', {}); return; }
  showError('open-error', null); done(null); setBusy('open', 'Checking the folder…');
  run({ type: 'plan', ids, dir }, {
    done: async (r) => {
      setBusy('open', null);
      const choices = r.collisions.length ? await askCollisions(r.collisions) : {};
      if (choices) toFolder(ids, dir, 'here', choices);
    },
    error: (r) => { setBusy('open', null); if (!r.cancelled) showError('open-error', r.message); },
  });
});

function toFolder(ids, dir, mode, choices) {
  extractJob({ type: 'toFolder', ids, dir, mode, choices }, 'Extracting…', (r) => {
    const parts = [`Extracted ${plural(r.written, 'file')} to ${r.folder ? `${dir.name}/${r.folder}` : dir.name}.`];
    if (r.replaced) parts.push(`${plural(r.replaced, 'file')} replaced.`);
    if (r.renamed) parts.push(`${plural(r.renamed, 'file')} renamed to keep both.`);
    if (r.skipped) parts.push(`${plural(r.skipped, 'file')} skipped.`);
    if (r.failed.length) parts.push(`${plural(r.failed.length, 'file')} could not be written: ${r.failed.slice(0, 5).map((f) => `${f.path} (${f.reason})`).join('; ')}${r.failed.length > 5 ? '…' : ''}`);
    done(parts.join(' '));
  });
}

// Shows the names that already exist. Resolves with { path: 'skip' | 'keep' | 'replace' } for every
// collision, or null when cancelled. Keep both is preselected; Replace is never chosen for the visitor.
const MAX_COLLISIONS = 200;
function askCollisions(collisions) {
  const dialog = $('collide-dialog');
  const choice = new Map(collisions.map((c) => [c.path, 'keep']));
  $('collide-title').textContent = collisions.length === 1 ? '1 name already exists' : `${collisions.length.toLocaleString('en-US')} names already exist`;
  const selects = collisions.slice(0, MAX_COLLISIONS).map((c) => {
    const li = el('li'); const label = el('span', 'collide-name', c.path);
    label.append(el('small', '', c.existing === 'directory' ? 'A folder with this name exists. Folders are never replaced.' : c.wanted === 'directory' ? 'A file with this name exists where the archive has a folder.' : 'A file with this name exists.'));
    const select = el('select'); select.setAttribute('aria-label', `What to do with ${c.path}`);
    for (const [value, text] of [['skip', 'Skip'], ['keep', 'Keep both'], ['replace', 'Replace']]) { const o = el('option', '', text); o.value = value; o.disabled = value === 'replace' && !c.replaceable; select.append(o); }
    select.value = 'keep'; select.addEventListener('change', () => choice.set(c.path, select.value));
    li.append(label, select);
    return { c, select, li };
  });
  $('collide-list').replaceChildren(...selects.map((s) => s.li));
  const more = collisions.length - selects.length;
  $('collide-more').hidden = more <= 0;
  $('collide-more').textContent = `${plural(more, 'more name')} not shown follow the last choice made for all, or Keep both.`;
  return new Promise((resolve) => {
    const all = (e) => {
      const value = e.target.dataset.all; if (!value) return;
      for (const c of collisions) if (value !== 'replace' || c.replaceable) choice.set(c.path, value);
      for (const s of selects) s.select.value = choice.get(s.c.path);
    };
    const finish = (result) => { dialog.querySelector('.collide-all').removeEventListener('click', all); dialog.onclose = null; $('collide-run').onclick = null; $('collide-cancel').onclick = null; if (dialog.open) dialog.close(); resolve(result); };
    dialog.querySelector('.collide-all').addEventListener('click', all);
    $('collide-run').onclick = () => finish(Object.fromEntries(choice));
    $('collide-cancel').onclick = () => finish(null);
    dialog.onclose = () => finish(null);
    dialog.showModal();
  });
}

$('extract-zip').addEventListener('click', async () => {
  if (job) return;
  const ids = [...selected];
  if (!ids.length || needsPasswordFirst(ids)) return;
  const name = `${baseName()}-files.zip`;
  const total = listing.entries.filter((e) => selected.has(e.id)).reduce((n, e) => n + (e.size ?? 0), 0);
  let handle = null;
  if (canPickFile && total > BIG) { try { handle = await pickSave(name); } catch { handle = null; } if (handle === undefined) return; }
  extractJob({ type: 'toZip', ids, handle }, 'Extracting…', (r) => {
    if (r.blob) download(r.blob, name);
    done(`${plural(ids.length, 'file')} extracted into ${name} (${size(r.size)}).`);
  });
});

async function saveOne(e) {
  if (job || needsPasswordFirst([e.id])) return;
  const name = e.path.split('/').pop();
  let handle = null;
  if (canPickFile && (e.size ?? 0) > BIG) { try { handle = await pickSave(name); } catch { handle = null; } if (handle === undefined) return; }
  extractJob({ type: 'one', entryId: e.id, handle }, `Extracting ${name}…`, (r) => { if (r.blob) download(r.blob, name); done(`Saved ${name}.`); });
}

let inspected = null;
function inspectOne(e) {
  if (job || needsPasswordFirst([e.id])) return;
  extractJob({ type: 'inspect', entryId: e.id }, `Inspecting ${e.path.split('/').pop()}…`, (r) => {
    inspected = r;
    $('inspect-title').textContent = r.name;
    const { report } = r;
    $('inspect-summary').dataset.level = report.summary.level;
    $('inspect-format').textContent = [report.format ?? 'Unrecognized format', report.category].filter(Boolean).join(' · ');
    $('inspect-summary-title').textContent = report.summary.title;
    $('inspect-summary-detail').textContent = report.summary.detail;
    $('inspect-signals').replaceChildren(...report.signals.slice(0, 8).map((s) => el('li', '', s)));
    $('inspect-dialog').showModal();
  });
}
$('inspect-close').addEventListener('click', () => $('inspect-dialog').close());
$('inspect-open').addEventListener('click', async () => {
  if (!inspected) return;
  await sendFile(new File([inspected.blob], inspected.name));
  location.href = '/file-inspector/#from-inspector';
});

clearFile();
