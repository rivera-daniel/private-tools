// Redact mode of the PDF Editor. mountRedact(container, ctx) builds the panel inside container and returns
// { unmount() }. ctx: getBytes() → Promise<Uint8Array>, setBytes(u8, label), pageCount(), pageSize(i),
// renderPage(i, scale) → Promise<ImageBitmap>. Search and redaction run in /tools/pdf-editor/redact-worker.js.
const WORKER = '/tools/pdf-editor/redact-worker.js';
const STYLES = '/tools/lib/pdf-editor/redact.css';
const PRESETS = [['email', 'Emails'], ['phone', 'Phone numbers'], ['ssn', 'SSNs'], ['card', 'Card numbers'], ['iban', 'IBANs'], ['date', 'Dates']];
const SEARCH_TIMEOUT = 15000;
const MIN_ZOOM = 0.25; const MAX_ZOOM = 4;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';
function icon(d) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', d); svg.append(path);
  return svg;
}
const ICONS = { prev: 'M15 6l-6 6 6 6', next: 'M9 6l6 6-6 6', minus: 'M6 12h12', plus: 'M12 6v12M6 12h12', fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', draw: 'M4 4h7v7H4zM14 14h6v6h-6zM11 7.5h5.5V14', close: 'M6 6l12 12M18 6L6 18', warn: 'M12 4l9 16H3zM12 10v4M12 17v.5', check: 'M5 12.5l4.5 4.5L19 7', lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3' };

function ensureStyles() {
  if (document.querySelector(`link[href="${STYLES}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLES }));
}

const fmt = (n) => (Math.round(n * 10) / 10).toString();
const sameBytes = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export function mountRedact(container, ctx) {
  ensureStyles();
  const S = {
    info: null, page: 0, zoom: null, fit: true, draw: !matchMedia('(pointer: coarse)').matches,
    marks: [], matches: [], truncated: false, nextId: 1, bytes: null, password: '', fake: null,
    busy: false, ack: '', renderToken: 0, bitmap: null, cursor: null, anchor: null, destroyed: false,
  };
  let worker = null; let seq = 0; const pending = new Map();

  function startWorker() {
    worker = new Worker(WORKER, { type: 'module' });
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; if (data.started) { p.start?.(); return; } pending.delete(data.id); clearTimeout(p.timer); if (data.ok) p.resolve(data.result); else p.reject(Object.assign(new Error(data.error.message), { code: data.error.code })); };
    worker.onerror = (event) => { event.preventDefault(); failAll('The redaction engine stopped unexpectedly. The file may be damaged.'); };
  }
  function failAll(message) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error(message), { code: 'crashed' })); } pending.clear(); }
  function call(op, payload = {}, { timeout = 0, transfer = [] } = {}) {
    if (!worker) startWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, timer: 0 };
      if (timeout) p.start = () => { p.timer = setTimeout(() => { pending.delete(id); restartWorker(); reject(Object.assign(new Error('The search took too long and was stopped. Try a simpler pattern.'), { code: 'timeout' })); }, timeout); };
      pending.set(id, p);
      worker.postMessage({ id, op, ...payload, timed: !!timeout }, transfer);
    });
  }
  async function restartWorker() {
    worker?.terminate(); worker = null; failAll('The redaction engine was restarted.');
    if (S.bytes) {
      try { await call('open', { bytes: S.bytes.slice(), password: S.password }); } catch { return; /* shown on the next action */ }
      call('check').then((fake) => { S.fake = fake; renderBanners(); }, () => {});
    }
  }

  // ---------- DOM ----------
  const live = el('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const say = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };

  const banners = el('div', { class: 'rd-banners' });
  const pwInput = el('input', { type: 'password', id: 'rd-password', autocomplete: 'off', spellcheck: 'false' });
  const pwError = el('p', { class: 'rd-error', hidden: true });
  const pwForm = el('form', { class: 'rd-banner rd-password', hidden: true, onsubmit: (e) => { e.preventDefault(); load(pwInput.value); } },
    el('span', { class: 'rd-banner-icon' }, icon(ICONS.lock)),
    el('div', {}, el('strong', { text: 'This PDF is protected with a password' }), el('p', { text: 'Enter it to search and redact. The redacted copy is saved without a password; add one again in Protect.' }),
      el('div', { class: 'rd-inline' }, el('label', { class: 'visually-hidden', for: 'rd-password', text: 'Password' }), pwInput, el('button', { type: 'submit', class: 'rd-btn', text: 'Unlock' })), pwError));

  const pageLabel = el('span', { class: 'rd-pagenum', 'aria-live': 'polite' });
  const zoomLabel = el('span', { class: 'rd-zoom' });
  const toolBtn = (label, d, onclick, extra = {}) => el('button', { type: 'button', class: 'rd-icon', 'aria-label': label, title: label, onclick, ...extra }, icon(d));
  const prevBtn = toolBtn('Previous page', ICONS.prev, () => go(S.page - 1));
  const nextBtn = toolBtn('Next page', ICONS.next, () => go(S.page + 1));
  const drawBtn = el('button', { type: 'button', class: 'rd-toggle', 'aria-pressed': String(S.draw), onclick: () => setDraw(!S.draw) }, icon(ICONS.draw), el('span', { text: 'Draw' }));
  const toolbar = el('div', { class: 'rd-toolbar', role: 'toolbar', 'aria-label': 'Page view' },
    el('div', { class: 'rd-group' }, prevBtn, pageLabel, nextBtn),
    el('div', { class: 'rd-group' }, toolBtn('Zoom out', ICONS.minus, () => zoomBy(1 / 1.25)), zoomLabel, toolBtn('Zoom in', ICONS.plus, () => zoomBy(1.25)), toolBtn('Fit width', ICONS.fit, () => { S.fit = true; renderPage(); })),
    drawBtn);

  const canvas = el('canvas', { class: 'rd-canvas', 'aria-hidden': 'true' });
  const overlay = el('div', { class: 'rd-overlay', tabindex: '0', role: 'application', 'aria-roledescription': 'page', 'aria-describedby': 'rd-keys' });
  const sheet = el('div', { class: 'rd-sheet' }, canvas, overlay);
  const stage = el('div', { class: 'rd-stage' }, sheet);
  const keysHint = el('p', { class: 'rd-hint', id: 'rd-keys', text: 'Drag over the page to mark an area. With the keyboard: focus the page, move with the arrow keys (Shift moves faster), press Enter at one corner and again at the opposite corner. Escape cancels.' });
  const viewer = el('div', { class: 'rd-viewer' }, toolbar, stage, keysHint);

  // Search.
  const query = el('input', { type: 'search', id: 'rd-query', placeholder: 'Name, number, word…', autocomplete: 'off', spellcheck: 'false' });
  const optCase = el('input', { type: 'checkbox', id: 'rd-case' });
  const optWord = el('input', { type: 'checkbox', id: 'rd-word' });
  const optRegex = el('input', { type: 'checkbox', id: 'rd-regex' });
  const searchError = el('p', { class: 'rd-error', hidden: true, role: 'alert' });
  const presetBar = el('div', { class: 'rd-presets', role: 'group', 'aria-label': 'Find common personal data' },
    PRESETS.map(([id, label]) => el('button', { type: 'button', class: 'rd-chip', 'data-preset': id, onclick: () => search({ preset: id, label }) , text: label })));
  const searchForm = el('form', { class: 'rd-card', onsubmit: (e) => { e.preventDefault(); search({}); } },
    el('h3', { class: 'rd-card-title' }, el('label', { for: 'rd-query', text: 'Find text to redact' })),
    el('div', { class: 'rd-inline' }, query, el('button', { type: 'submit', class: 'rd-btn', text: 'Search' })),
    el('div', { class: 'rd-checks' },
      el('label', {}, optCase, el('span', { text: 'Match case' })),
      el('label', {}, optWord, el('span', { text: 'Whole words' })),
      el('label', {}, optRegex, el('span', { text: 'Regular expression' }))),
    searchError,
    el('p', { class: 'rd-sub', text: 'Or find common personal data' }), presetBar);

  const matchTitle = el('h3', { class: 'rd-card-title' });
  const matchList = el('ul', { class: 'rd-list', 'aria-label': 'Matches' });
  const matchMore = el('p', { class: 'rd-more', hidden: true });
  const markAllBtn = el('button', { type: 'button', class: 'rd-btn small', text: 'Mark all', onclick: () => markMatches(S.matches) });
  const markSelBtn = el('button', { type: 'button', class: 'rd-btn small', text: 'Mark selected', onclick: () => markMatches(S.matches.filter((m) => m.checked)) });
  const matchCard = el('section', { class: 'rd-card', hidden: true, 'aria-label': 'Search results' },
    el('div', { class: 'rd-card-head' }, matchTitle, el('div', { class: 'rd-actions' }, markSelBtn, markAllBtn)), matchList, matchMore);

  const marksTitle = el('h3', { class: 'rd-card-title' });
  const marksList = el('ul', { class: 'rd-list', 'aria-label': 'Marked for redaction' });
  const marksEmpty = el('p', { class: 'rd-empty', text: 'Nothing marked yet. Draw a box on the page or mark search results.' });
  const clearBtn = el('button', { type: 'button', class: 'rd-btn small', text: 'Clear', onclick: () => { S.marks = []; S.ack = ''; refresh(); say('All marks removed.'); } });
  const marksCard = el('section', { class: 'rd-card', 'aria-label': 'Marked for redaction' },
    el('div', { class: 'rd-card-head' }, marksTitle, el('div', { class: 'rd-actions' }, clearBtn)), marksEmpty, marksList);

  const choice = (name, value, label, checked) => el('label', {}, el('input', { type: 'radio', name, value, checked }), el('span', { text: label }));
  const modeSet = el('div', { class: 'rd-choices' }, choice('rd-mode', 'remove', 'Remove content', true), choice('rd-mode', 'rasterize', 'Rasterize pages', false));
  const imageSet = el('div', { class: 'rd-choices' }, choice('rd-images', 'blank-pixels', 'Blank pixels', true), choice('rd-images', 'remove-overlapping', 'Remove image', false), choice('rd-images', 'none', 'Keep', false));
  const modeHint = el('p', { class: 'rd-hint' });
  const optLineArt = el('input', { type: 'checkbox', id: 'rd-lineart', checked: true });
  const optFill = el('input', { type: 'checkbox', id: 'rd-fill', checked: true });
  const optLabel = el('input', { type: 'text', id: 'rd-label', placeholder: '[REDACTED]', maxlength: '40', autocomplete: 'off', spellcheck: 'false' });
  const optDpi = el('select', { id: 'rd-dpi' }, el('option', { value: '150', text: '150 dpi', selected: true }), el('option', { value: '300', text: '300 dpi' }), el('option', { value: '100', text: '100 dpi' }));
  const imagesField = el('fieldset', { class: 'rd-field' }, el('legend', { text: 'Images under the boxes' }), imageSet);
  const dpiField = el('div', { class: 'rd-field', hidden: true }, el('label', { class: 'rd-legend', for: 'rd-dpi', text: 'Image resolution' }), optDpi);
  const lineArtField = el('label', { class: 'rd-check' }, optLineArt, el('span', { text: 'Remove lines and shapes fully under a box' }));
  const optionsCard = el('form', { class: 'rd-card rd-options', onsubmit: (e) => e.preventDefault(), 'aria-label': 'Redaction options' },
    el('fieldset', { class: 'rd-field' }, el('legend', { text: 'Mode' }), modeSet, modeHint),
    imagesField, dpiField, lineArtField,
    el('label', { class: 'rd-check' }, optFill, el('span', { text: 'Draw black boxes where content was removed' })),
    el('div', { class: 'rd-field' }, el('label', { class: 'rd-legend', for: 'rd-label' }, 'Text in the boxes ', el('span', { class: 'rd-optional', text: 'optional' })), optLabel));

  const notice = el('div', { class: 'rd-notice', hidden: true, role: 'status' });
  const applyBtn = el('button', { type: 'button', class: 'button rd-apply', text: 'Apply redactions', onclick: () => apply() });
  const busy = el('div', { class: 'rd-busy', hidden: true, role: 'status' }, el('span', { class: 'rd-spinner', 'aria-hidden': 'true' }), el('span', {}));
  const result = el('section', { class: 'rd-result', hidden: true, tabindex: '-1', 'aria-live': 'polite' });
  const side = el('div', { class: 'rd-side' }, searchForm, matchCard, marksCard, optionsCard, notice, applyBtn, busy, result);

  const layout = el('div', { class: 'rd-layout' }, viewer, side);
  const loading = el('div', { class: 'rd-busy' }, el('span', { class: 'rd-spinner', 'aria-hidden': 'true' }), el('span', { text: 'Opening the document…' }));
  const failed = el('p', { class: 'rd-error', hidden: true, role: 'alert' });
  const root = el('div', { class: 'rd' },
    el('div', { class: 'rd-head' }, el('h2', { text: 'Redact' }), el('p', { text: 'Marked text, images and form values are deleted from the file, not just covered, and the result is checked before you get it.' })),
    pwForm, banners, loading, failed, layout, live);
  layout.hidden = true;
  container.replaceChildren(root);

  // ---------- Loading ----------
  async function load(password = S.password) {
    loading.hidden = false; failed.hidden = true; pwError.hidden = true;
    try {
      const bytes = await ctx.getBytes();
      if (S.destroyed) return;
      S.bytes = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
      S.info = await call('open', { bytes: S.bytes.slice(), password });
      S.password = password;
      pwForm.hidden = true;
      layout.hidden = false;
      S.page = Math.min(S.page, S.info.pages.length - 1);
      renderBanners();
      refresh();
      await renderPage();
      call('check').then((fake) => { S.fake = fake; renderBanners(); }, () => {});
    } catch (error) {
      if (error.code === 'password' || error.code === 'wrong-password') {
        pwForm.hidden = false; layout.hidden = true;
        if (error.code === 'wrong-password') { pwError.textContent = error.message; pwError.hidden = false; }
        pwInput.focus();
      } else { failed.textContent = error.message; failed.hidden = false; layout.hidden = true; }
    } finally { loading.hidden = true; }
  }

  function renderBanners() {
    const consented = !!banners.querySelector('#rd-sigok')?.checked;
    banners.replaceChildren();
    const info = S.info; if (!info) return;
    if (info.signed) {
      const consent = el('input', { type: 'checkbox', id: 'rd-sigok', checked: consented });
      banners.append(el('div', { class: 'rd-banner' }, el('span', { class: 'rd-banner-icon' }, icon(ICONS.warn)),
        el('div', {}, el('strong', { text: 'This PDF is digitally signed' }), el('p', { text: 'Redacting changes the document, so the signature becomes invalid and is removed.' }),
          el('label', { class: 'rd-check' }, consent, el('span', { text: 'Redact anyway and remove the signature' })))));
    }
    if (info.encrypted) banners.append(el('div', { class: 'rd-banner quiet' }, el('span', { class: 'rd-banner-icon' }, icon(ICONS.lock)), el('div', {}, el('strong', { text: 'Encrypted PDF' }), el('p', { text: 'The redacted copy is saved without a password. Use Protect afterwards to add one again.' }))));
    const fake = S.fake;
    if (fake && (fake.pages.length || fake.unapplied.length)) {
      const pages = [...new Set([...fake.pages.map((p) => p.page), ...fake.unapplied.map((u) => u.page)])].sort((a, b) => a - b).map((p) => p + 1);
      const sample = fake.pages.map((p) => p.text).find(Boolean) ?? fake.unapplied.map((u) => u.text).find(Boolean) ?? '';
      const areas = fake.pages.flatMap((p) => p.boxes.map((b) => ({ page: p.page, rect: b.rect, text: b.text }))).concat(fake.unapplied.map((u) => ({ page: u.page, rect: u.rect, text: u.text })));
      const text = `${fake.pages.length ? 'Black boxes on' : 'Unapplied redaction marks on'} page${pages.length === 1 ? '' : 's'} ${pages.slice(0, 6).join(', ')} cover content that is still in the file and can be copied out${sample ? `: “${sample.slice(0, 80)}”` : ''}.`;
      banners.append(el('div', { class: 'rd-banner alert', role: 'alert' }, el('span', { class: 'rd-banner-icon' }, icon(ICONS.warn)),
        el('div', {}, el('strong', { text: 'This PDF has black boxes that hide nothing' }), el('p', { text }),
          areas.length ? el('button', { type: 'button', class: 'rd-btn', text: `Mark ${areas.length === 1 ? 'this area' : `these ${areas.length} areas`} for real redaction`, onclick: (e) => { addMarks(areas.map((a) => ({ ...a, source: 'box' }))); e.currentTarget.disabled = true; e.currentTarget.textContent = 'Marked for redaction'; go(areas[0].page); } }) : null)));
    }
  }

  // ---------- Page view ----------
  const pageBounds = () => S.info.pages[S.page].bounds;
  const pageW = () => { const b = pageBounds(); return b[2] - b[0]; };
  const pageH = () => { const b = pageBounds(); return b[3] - b[1]; };

  async function renderPage() {
    if (!S.info || S.destroyed) return;
    const token = ++S.renderToken;
    if (S.fit || !S.zoom) { lastWidth = stage.clientWidth; const avail = Math.max(200, stage.clientWidth - 32); S.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / pageW())); }
    const cssW = pageW() * S.zoom; const cssH = pageH() * S.zoom;
    sheet.style.width = `${cssW}px`; sheet.style.height = `${cssH}px`;
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    updateNav();
    overlay.setAttribute('aria-label', `Page ${S.page + 1}`);
    drawOverlay();
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 3);
    let scale = S.zoom * ratio;
    if (pageW() * pageH() * scale * scale > 24e6) scale = Math.sqrt(24e6 / (pageW() * pageH()));
    let bitmap = null;
    try {
      bitmap = await ctx.renderPage?.(S.page, scale);
      // The editor's rendering is used when it has the page's shape; otherwise the worker draws it, so
      // that boxes land exactly where they are drawn.
      if (!bitmap || Math.abs(bitmap.width / bitmap.height - pageW() / pageH()) > 0.02) { bitmap?.close?.(); bitmap = await call('render', { page: S.page, scale }); }
    } catch { try { bitmap = await call('render', { page: S.page, scale }); } catch { bitmap = null; } }
    if (token !== S.renderToken || S.destroyed) { bitmap?.close?.(); return; }
    if (!bitmap) return;
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
  }

  function updateNav() {
    if (!S.info) return;
    pageLabel.textContent = `Page ${S.page + 1} of ${S.info.pages.length}`;
    zoomLabel.textContent = `${Math.round((S.zoom ?? 1) * 100)}%`;
    prevBtn.disabled = S.busy || S.page === 0; nextBtn.disabled = S.busy || S.page >= S.info.pages.length - 1;
  }

  function go(page) {
    if (!S.info) return;
    const p = Math.max(0, Math.min(S.info.pages.length - 1, page));
    if (p === S.page && canvas.width) { drawOverlay(); return; }
    S.page = p; S.anchor = null; renderPage();
  }
  function zoomBy(f) { S.fit = false; S.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (S.zoom ?? 1) * f)); renderPage(); }
  function setDraw(on) { S.draw = on; drawBtn.setAttribute('aria-pressed', String(on)); overlay.classList.toggle('drawing', on); }
  setDraw(S.draw);

  // Page points <-> CSS pixels on the sheet.
  const toPt = (x, y) => { const b = pageBounds(); return [b[0] + x / S.zoom, b[1] + y / S.zoom]; };
  const toPx = (r) => { const b = pageBounds(); return [(r[0] - b[0]) * S.zoom, (r[1] - b[1]) * S.zoom, (r[2] - r[0]) * S.zoom, (r[3] - r[1]) * S.zoom]; };
  const place = (node, r) => { const [x, y, w, h] = toPx(r); node.style.left = `${x}px`; node.style.top = `${y}px`; node.style.width = `${Math.max(w, 2)}px`; node.style.height = `${Math.max(h, 2)}px`; return node; };
  const rectsOf = (m) => (m.quads ? m.quads.map((q) => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])]) : [m.rect]);

  function drawOverlay() {
    overlay.replaceChildren();
    if (!S.info) return;
    for (const m of S.matches) if (m.page === S.page && !m.marked) for (const r of rectsOf(m)) overlay.append(place(el('div', { class: `rd-hit${m.focus ? ' focus' : ''}` }), r));
    for (const m of S.marks) if (m.page === S.page) for (const r of rectsOf(m)) overlay.append(place(el('div', { class: 'rd-box', title: m.text || 'Marked area' }), r));
    if (S.draft) overlay.append(place(el('div', { class: 'rd-draft' }), S.draft));
    if (S.cursor) {
      const c = S.cursor; const size = 10 / S.zoom;
      overlay.append(place(el('div', { class: 'rd-cursor' }), [c[0] - size, c[1] - size, c[0] + size, c[1] + size]));
      if (S.anchor) overlay.append(place(el('div', { class: 'rd-draft' }), norm4([...S.anchor, ...c])));
    }
  }
  const norm4 = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

  // Pointer drawing.
  let drag = null;
  overlay.addEventListener('pointerdown', (e) => {
    if (!S.draw || e.button > 0 || S.busy) return;
    const box = overlay.getBoundingClientRect();
    drag = { id: e.pointerId, start: toPt(e.clientX - box.left, e.clientY - box.top) };
    try { overlay.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone; moves still arrive on the overlay */ }
    e.preventDefault();
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const box = overlay.getBoundingClientRect();
    S.draft = norm4([...drag.start, ...toPt(e.clientX - box.left, e.clientY - box.top)]);
    drawOverlay();
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = S.draft; drag = null; S.draft = null;
    if (r && (r[2] - r[0]) * S.zoom >= 4 && (r[3] - r[1]) * S.zoom >= 4) addMarks([{ page: S.page, rect: clampRect(r), source: 'drawn' }]);
    else drawOverlay();
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { drag = null; S.draft = null; drawOverlay(); } });

  const clampRect = (r) => { const b = pageBounds(); return [Math.max(b[0], r[0]), Math.max(b[1], r[1]), Math.min(b[2], r[2]), Math.min(b[3], r[3])].map((v) => Math.round(v * 100) / 100); };

  // Keyboard drawing.
  overlay.addEventListener('focus', () => { if (!S.cursor && S.info) { const b = pageBounds(); S.cursor = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; drawOverlay(); } });
  overlay.addEventListener('blur', () => { S.cursor = null; S.anchor = null; drawOverlay(); });
  overlay.addEventListener('keydown', (e) => {
    if (!S.cursor || S.busy) return;
    const step = e.shiftKey ? 20 : 4; const b = pageBounds();
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      S.cursor = [Math.max(b[0], Math.min(b[2], S.cursor[0] + moves[e.key][0])), Math.max(b[1], Math.min(b[3], S.cursor[1] + moves[e.key][1]))];
      drawOverlay();
      // Keep the cursor in view.
      const [x, y] = toPx([...S.cursor, ...S.cursor]);
      if (x < stage.scrollLeft + 20 || x > stage.scrollLeft + stage.clientWidth - 20) stage.scrollLeft = x - stage.clientWidth / 2;
      if (y < stage.scrollTop + 20 || y > stage.scrollTop + stage.clientHeight - 20) stage.scrollTop = y - stage.clientHeight / 2;
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!S.anchor) { S.anchor = S.cursor.slice(); say(`First corner set at ${fmt(S.cursor[0])}, ${fmt(S.cursor[1])} points. Move to the opposite corner and press Enter.`); drawOverlay(); return; }
      const r = norm4([...S.anchor, ...S.cursor]); S.anchor = null;
      if (r[2] - r[0] < 1 || r[3] - r[1] < 1) { say('The area is too small. Move further before pressing Enter.'); drawOverlay(); return; }
      addMarks([{ page: S.page, rect: clampRect(r), source: 'drawn' }]);
    } else if (e.key === 'Escape' && S.anchor) { S.anchor = null; say('Cancelled.'); drawOverlay(); }
    else if (e.key === 'PageDown') { e.preventDefault(); go(S.page + 1); }
    else if (e.key === 'PageUp') { e.preventDefault(); go(S.page - 1); }
  });

  // ---------- Marks ----------
  function addMarks(list) {
    let added = 0;
    for (const m of list) {
      const key = JSON.stringify([m.page, m.rect ?? m.quads]);
      if (S.marks.some((x) => x.key === key)) continue;
      S.marks.push({ ...m, id: S.nextId++, key });
      added++;
    }
    S.ack = '';
    for (const x of S.matches) if (S.marks.some((m) => m.key === JSON.stringify([x.page, x.quads]))) x.marked = true;
    refresh();
    if (added) say(`${added} area${added === 1 ? '' : 's'} marked. ${S.marks.length} in total.`);
    return added;
  }
  function removeMark(id) {
    const m = S.marks.find((x) => x.id === id);
    S.marks = S.marks.filter((x) => x.id !== id); S.ack = '';
    if (m) for (const x of S.matches) if (JSON.stringify([x.page, x.quads]) === m.key) x.marked = false;
    refresh(); say('Mark removed.');
  }
  function markMatches(list) {
    if (!list.length) { say('No matches selected.'); return; }
    addMarks(list.map((m) => ({ page: m.page, quads: m.quads, text: m.text, source: 'search' })));
  }

  function describeMark(m) {
    if (m.text) return m.text;
    const r = m.rect ?? rectsOf(m)[0];
    return `Area ${Math.round(r[2] - r[0])} × ${Math.round(r[3] - r[1])} pt`;
  }

  function refresh() {
    marksTitle.textContent = S.marks.length ? `Marked for redaction (${S.marks.length})` : 'Marked for redaction';
    marksEmpty.hidden = S.marks.length > 0; clearBtn.hidden = !S.marks.length;
    const sorted = [...S.marks].sort((a, b) => a.page - b.page || rectsOf(a)[0][1] - rectsOf(b)[0][1]);
    marksList.replaceChildren(...sorted.map((m) => el('li', { class: 'rd-item' },
      el('button', { type: 'button', class: 'rd-item-main', onclick: () => go(m.page), 'aria-label': `Show mark on page ${m.page + 1}: ${describeMark(m)}` },
        el('span', { class: 'rd-pg', text: `p. ${m.page + 1}` }), el('span', { class: 'rd-item-text', text: describeMark(m) })),
      el('button', { type: 'button', class: 'rd-icon small', 'aria-label': `Remove mark on page ${m.page + 1}: ${describeMark(m)}`, title: 'Remove', onclick: () => removeMark(m.id) }, icon(ICONS.close)))));
    renderMatches();
    applyBtn.disabled = !S.marks.length || S.busy;
    applyBtn.textContent = S.marks.length ? `Apply ${S.marks.length} redaction${S.marks.length === 1 ? '' : 's'}` : 'Apply redactions';
    const mode = optionsCard.querySelector('input[name="rd-mode"]:checked').value;
    modeHint.textContent = mode === 'remove'
      ? 'Deletes the text, image pixels and form values under each box. The rest of the page stays selectable.'
      : 'Turns each marked page into a picture with the boxes burned in. Nothing on those pages can be selected or searched afterwards. Other pages keep their text.';
    imagesField.hidden = mode !== 'remove'; lineArtField.hidden = mode !== 'remove'; dpiField.hidden = mode !== 'rasterize';
    drawOverlay();
  }
  optionsCard.addEventListener('change', refresh);

  // ---------- Search ----------
  let lastSearch = null;
  async function search({ preset = null, label = '' }) {
    searchError.hidden = true;
    const q = query.value;
    if (!preset && !q.trim()) { searchError.textContent = 'Enter something to search for.'; searchError.hidden = false; query.focus(); return; }
    for (const b of presetBar.children) b.setAttribute('aria-pressed', String(b.dataset.preset === preset));
    setBusy(true, preset ? `Finding ${label.toLowerCase()}…` : 'Searching…');
    try {
      const r = await call('search', { query: q, options: { preset, caseSensitive: optCase.checked, wholeWord: optWord.checked, regex: optRegex.checked } }, { timeout: SEARCH_TIMEOUT });
      lastSearch = preset ? label : `“${q}”`;
      S.matches = r.matches.map((m, i) => ({ ...m, i, checked: true, marked: S.marks.some((x) => x.key === JSON.stringify([m.page, m.quads])) }));
      S.truncated = r.truncated;
      matchCard.hidden = false;
      refresh();
      say(`${S.matches.length} match${S.matches.length === 1 ? '' : 'es'} for ${lastSearch}.`);
      if (S.matches.length && !S.matches.some((m) => m.page === S.page)) go(S.matches[0].page);
    } catch (error) { searchError.textContent = error.message; searchError.hidden = false; }
    finally { setBusy(false); }
  }

  function renderMatches() {
    if (matchCard.hidden) return;
    const n = S.matches.length;
    matchTitle.textContent = `${n} match${n === 1 ? '' : 'es'}${lastSearch ? ` for ${lastSearch}` : ''}`;
    markAllBtn.disabled = !S.matches.some((m) => !m.marked); markSelBtn.disabled = !S.matches.some((m) => m.checked && !m.marked);
    matchMore.hidden = !S.truncated; matchMore.textContent = 'Only the first 2,000 matches are listed. Narrow the search to see the rest.';
    const shown = S.matches.slice(0, 500);
    matchList.replaceChildren(...shown.map((m) => {
      const box = el('input', { type: 'checkbox', checked: m.checked, disabled: m.marked, 'aria-label': `Select match on page ${m.page + 1}: ${m.text}` });
      box.addEventListener('change', () => { m.checked = box.checked; markSelBtn.disabled = !S.matches.some((x) => x.checked && !x.marked); });
      return el('li', { class: `rd-item${m.marked ? ' done' : ''}` }, box,
        el('button', { type: 'button', class: 'rd-item-main', onclick: () => showMatch(m), 'aria-label': `Show match on page ${m.page + 1}: ${m.text}` },
          el('span', { class: 'rd-pg', text: `p. ${m.page + 1}` }), el('span', { class: 'rd-item-text', text: m.text })),
        m.marked ? el('span', { class: 'rd-tag', text: 'Marked' }) : el('button', { type: 'button', class: 'rd-btn small', text: 'Mark', 'aria-label': `Mark match on page ${m.page + 1}: ${m.text}`, onclick: () => markMatches([m]) }));
    }));
    if (n > shown.length) matchList.append(el('li', { class: 'rd-more', text: `${n - shown.length} more matches are not listed. Mark all includes them.` }));
  }

  function showMatch(m) {
    for (const x of S.matches) x.focus = x === m;
    go(m.page); drawOverlay();
    const [x, y] = toPx(m.rect);
    stage.scrollTo({ left: Math.max(0, x - stage.clientWidth / 3), top: Math.max(0, y - stage.clientHeight / 3) });
  }

  // ---------- Apply ----------
  function setBusy(on, text = '') {
    S.busy = on; busy.hidden = !on; busy.lastChild.textContent = text;
    if (on && !S.locked) { S.locked = [...layout.querySelectorAll('button, input, select')].filter((c) => !c.disabled); for (const c of S.locked) c.disabled = true; }
    if (!on && S.locked) { for (const c of S.locked) c.disabled = false; S.locked = null; updateNav(); }
    applyBtn.disabled = on || !S.marks.length;
  }

  function options() {
    const get = (name) => optionsCard.querySelector(`input[name="${name}"]:checked`).value;
    return { mode: get('rd-mode'), images: get('rd-images'), lineArt: optLineArt.checked ? 'remove-covered' : 'none', fill: optFill.checked, label: optLabel.value.trim(), dpi: Number(optDpi.value), allowSignatureLoss: !!banners.querySelector('#rd-sigok')?.checked };
  }

  const payload = () => S.marks.map((m) => ({ page: m.page, ...(m.quads ? { quads: m.quads } : { rect: m.rect }), ...(m.text ? { text: m.text } : {}) }));

  async function apply() {
    if (!S.marks.length || S.busy) return;
    result.hidden = true; notice.hidden = true;
    setBusy(true, 'Checking the marks…');
    try {
      const current = await ctx.getBytes();
      if (!sameBytes(current instanceof Uint8Array ? current : new Uint8Array(current), S.bytes)) {
        const pages = S.info.pages.length;
        await load(S.password);
        if (S.info.pages.length !== pages) S.marks = [];
        refresh();
        showResult(false, 'The document changed in the editor, so it was opened again. Check the marks and apply again.');
        return;
      }
      const marks = payload();
      const pre = await call('preflight', { marks });
      const key = JSON.stringify(marks);
      if (pre.other.length && S.ack !== key) {
        S.ack = key;
        const total = pre.other.reduce((a, o) => a + o.count, 0);
        const list = pre.other.slice(0, 3).map((o) => `“${o.text.slice(0, 50)}” ${o.count} more time${o.count === 1 ? '' : 's'}`).join(', ');
        notice.replaceChildren(el('strong', { text: 'The same text appears elsewhere' }),
          el('p', { text: `${list}, where no box covers it. Those copies would stay readable.` }),
          el('div', { class: 'rd-actions' },
            el('button', { type: 'button', class: 'rd-btn', text: `Mark the ${total} other occurrence${total === 1 ? '' : 's'}`, onclick: () => { addMarks(pre.other.flatMap((o) => o.matches.map((m) => ({ page: m.page, quads: m.quads, text: m.text, source: 'search' })))); notice.hidden = true; } }),
            el('button', { type: 'button', class: 'rd-btn', text: 'Redact only what is marked', onclick: () => { notice.hidden = true; S.ack = JSON.stringify(payload()); apply(); } })));
        notice.hidden = false;
        say('The same text appears elsewhere. Review before applying.');
        return;
      }
      setBusy(true, 'Redacting and checking the result…');
      const r = await call('redact', { marks, options: options() });
      if (!r.ok) { showResult(false, r.reason, r.verification); return; }
      const removed = r.removed; const verification = r.verification;
      await ctx.setBytes(r.data, 'Redacted');
      if (S.destroyed) return;
      S.marks = []; S.matches = []; S.ack = ''; matchCard.hidden = true;
      await load(S.password);
      showResult(true, '', verification, removed);
    } catch (error) { showResult(false, error.message); }
    finally { if (!S.destroyed) { setBusy(false); refresh(); } }
  }

  function showResult(ok, reason, verification, removed = []) {
    const head = el('div', { class: 'rd-result-head' }, el('span', { class: 'rd-result-icon' }, icon(ok ? ICONS.check : ICONS.warn)),
      el('div', {}, el('p', { class: 'eyebrow', text: ok ? 'Redaction applied' : 'Not redacted' }),
        el('h3', { text: ok ? (verification.elsewhere?.length ? 'Verified: the marked text is gone' : 'Verified: none of the redacted text remains') : 'The document was left unchanged' })));
    const parts = [head];
    if (!ok) parts.push(el('p', { class: 'rd-result-text', text: reason }));
    if (verification?.leftovers?.length) parts.push(el('ul', { class: 'rd-findings' }, verification.leftovers.slice(0, 12).map((l) => el('li', { text: `${l.kind}${l.page ? ` (page ${l.page})` : ''}${l.text ? `: “${l.text.slice(0, 80)}”` : ''}` }))));
    if (ok) {
      if (verification.elsewhere?.length) parts.push(el('p', { class: 'rd-result-warn', text: `Still readable where it was not marked: ${verification.elsewhere.map((e) => `“${e.text.slice(0, 50)}” (${e.count}×)`).join(', ')}.` }));
      parts.push(el('ul', { class: 'rd-checklist' }, verification.checks.map((c) => el('li', {}, icon(ICONS.check), el('span', { text: c })))));
      const rows = summarize(removed);
      if (rows.length) parts.push(el('details', { class: 'rd-removed' }, el('summary', { text: `What was removed (${rows.length})` }), el('ul', {}, rows.map((t) => el('li', { text: t })))));
      parts.push(el('p', { class: 'rd-hint', text: 'The editor now holds the redacted document. Download it from there.' }));
    }
    result.replaceChildren(...parts);
    result.dataset.state = ok ? 'ok' : 'error';
    result.hidden = false;
    result.focus({ preventScroll: true });
    result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function summarize(removed) {
    const out = [];
    const texts = new Map();
    for (const r of removed) {
      if (r.text) { const k = `${r.kind}: “${r.text.slice(0, 80)}”`; texts.set(k, (texts.get(k) ?? new Set()).add(r.page ?? 0)); }
      else out.push(r.detail ? `${r.kind}: ${r.detail}` : r.kind);
    }
    const lines = [...texts].map(([k, pages]) => { const p = [...pages].filter(Boolean); return p.length ? `${k} (page${p.length === 1 ? '' : 's'} ${p.join(', ')})` : k; });
    return [...lines, ...out];
  }

  // ---------- Lifecycle ----------
  let resizeTimer = 0;
  // Only a change of the stage's width matters; reacting to height changes would loop with the page's own size.
  let lastWidth = 0;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { const w = stage.clientWidth; if (S.fit && Math.abs(w - lastWidth) > 24) { lastWidth = w; renderPage(); } }, 150); };
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(stage);
  load('');

  return {
    unmount() {
      S.destroyed = true;
      resizeObserver.disconnect(); clearTimeout(resizeTimer);
      failAll('Closed.'); worker?.terminate(); worker = null;
      container.replaceChildren();
    },
  };
}
