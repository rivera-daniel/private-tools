// View mode of the PDF Editor: continuous pages, zoom, view-only rotation, find, text selection, thumbnails,
// bookmarks and links. mountView(container, ctx) builds the viewer inside container and returns
// { refresh(), unmount(), focusFind() }. ctx (provided by the editor):
//   pageCount(): number
//   pageSize(i): { width, height }          page i in points as the document shows it (after its rotation)
//   pageRotation(i): number                  the rotation the editor applies to page i (0, 90, 180, 270)
//   renderPage(i, scale, rotate): Promise<ImageBitmap>   page i with `rotate` degrees added on top
//   pageText(i): Promise<{ width, height, lines, links }>   lines [{ x, y, w, h, text, size, wmode }] and links
//                                            [{ x, y, w, h, url } | { x, y, w, h, page }] in the page's own
//                                            space (before the editor's rotation), top-left origin, points
//   search(needle): Promise<{ hits: [{ page, quads }], capped }>   quads in the same space as pageText
//   outline(): Promise<[{ title, page, kids }]>   page is a page index of the working document or -1
//   thumbnail(i): Promise<ImageBitmap|null>  a small rendering of page i before the editor's rotation
// Text from the file is shown through textContent only, and positions are set through element.style
// properties, which the Content Security Policy allows (style attributes are not).
const STYLES = '/lib/pdf-editor/view.css';
const PX_PER_PT = 96 / 72;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const MIN_ZOOM = 0.25; const MAX_ZOOM = 6;
const GAP = 16;

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
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c);
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
const ICONS = {
  sidebar: 'M4 5h16v14H4zM9 5v14', prev: 'M15 6l-6 6 6 6', next: 'M9 6l6 6-6 6', up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6',
  minus: 'M6 12h12', plus: 'M12 6v12M6 12h12', width: 'M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3', page: 'M7 3h10v18H7zM10 8h4M10 12h4',
  rotate: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', exit: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-4-4', close: 'M6 6l12 12M18 6L6 18', link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};
function ensureStyles() {
  if (document.querySelector(`link[href="${STYLES}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLES }));
}

// Maps a point of an unrotated w × h page to the page turned clockwise by r degrees.
function turn(x, y, w, h, r) {
  return r === 90 ? [h - y, x] : r === 180 ? [w - x, h - y] : r === 270 ? [y, w - x] : [x, y];
}
function turnRect(b, w, h, r) {
  const a = turn(b.x, b.y, w, h, r); const c = turn(b.x + b.w, b.y + b.h, w, h, r);
  return { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(c[0] - a[0]), h: Math.abs(c[1] - a[1]) };
}
const place = (node, r, s) => { node.style.left = `${r.x * s}px`; node.style.top = `${r.y * s}px`; node.style.width = `${r.w * s}px`; node.style.height = `${r.h * s}px`; };

let measureCtx = null;
function textWidth(text, px) {
  measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d');
  measureCtx.font = `${px}px sans-serif`;
  return measureCtx.measureText(text).width;
}

export function mountView(container, ctx) {
  ensureStyles();
  const S = {
    zoom: 1, fit: 'width', rotate: 0, page: 0, pages: [], destroyed: false, renderQueue: new Set(), rendering: 0,
    texts: new Map(), query: '', hits: [], hit: -1, capped: false, searchToken: 0, sidebar: !matchMedia('(max-width: 900px)').matches,
    sideTab: 'thumbs', outline: null, scrollRaf: 0, generation: 0,
  };
  const live = el('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const say = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };

  /* Toolbar */
  const btn = (label, d, onclick, extra = {}) => el('button', { type: 'button', class: 'vw-icon', 'aria-label': label, title: label, onclick, ...extra }, icon(d));
  const sideBtn = btn('Show or hide the sidebar', ICONS.sidebar, () => setSidebar(!S.sidebar), { 'aria-pressed': String(S.sidebar) });
  const prevBtn = btn('Previous page', ICONS.up, () => goTo(S.page - 1));
  const nextBtn = btn('Next page', ICONS.down, () => goTo(S.page + 1));
  const pageInput = el('input', { type: 'text', class: 'vw-pageinput', inputmode: 'numeric', 'aria-label': 'Page number', autocomplete: 'off', value: '1' });
  const pageTotal = el('span', { class: 'vw-total', text: 'of 1' });
  const zoomSelect = el('select', { class: 'vw-zoom', 'aria-label': 'Zoom' });
  const zoomOut = btn('Zoom out', ICONS.minus, () => zoomBy(1 / 1.25));
  const zoomIn = btn('Zoom in', ICONS.plus, () => zoomBy(1.25));
  const fitWidth = btn('Fit width', ICONS.width, () => setFit('width'));
  const fitPage = btn('Fit page', ICONS.page, () => setFit('page'));
  const rotateBtn = btn('Rotate the view', ICONS.rotate, () => { S.rotate = (S.rotate + 90) % 360; relayout(); say(`View turned to ${S.rotate} degrees. The document is not changed.`); });
  const fullBtn = btn('Full screen', ICONS.full, () => toggleFullscreen());
  const findInput = el('input', { type: 'search', class: 'vw-find', placeholder: 'Find in document', 'aria-label': 'Find in document', autocomplete: 'off', spellcheck: 'false' });
  const findCount = el('span', { class: 'vw-count', 'aria-live': 'polite' });
  const findPrev = btn('Previous match', ICONS.up, () => stepHit(-1));
  const findNext = btn('Next match', ICONS.down, () => stepHit(1));
  const toolbar = el('div', { class: 'vw-toolbar', role: 'toolbar', 'aria-label': 'Viewer' },
    el('div', { class: 'vw-group' }, sideBtn, prevBtn, nextBtn, el('label', { class: 'vw-pagebox' }, pageInput, pageTotal)),
    el('div', { class: 'vw-group' }, zoomOut, zoomSelect, zoomIn, fitWidth, fitPage, rotateBtn, fullBtn),
    el('div', { class: 'vw-group vw-findbox' }, el('span', { class: 'vw-find-icon' }, icon(ICONS.search)), findInput, findCount, findPrev, findNext));

  /* Sidebar */
  const thumbsTab = el('button', { type: 'button', role: 'tab', class: 'vw-tab', 'aria-selected': 'true', text: 'Pages', onclick: () => setSideTab('thumbs') });
  const outlineTab = el('button', { type: 'button', role: 'tab', class: 'vw-tab', 'aria-selected': 'false', text: 'Bookmarks', hidden: true, onclick: () => setSideTab('outline') });
  const thumbList = el('ol', { class: 'vw-thumbs', 'aria-label': 'Pages' });
  const outlineList = el('ul', { class: 'vw-outline', 'aria-label': 'Bookmarks', hidden: true });
  const sidebar = el('nav', { class: 'vw-sidebar', 'aria-label': 'Pages and bookmarks' }, el('div', { class: 'vw-tabs', role: 'tablist' }, thumbsTab, outlineTab), thumbList, outlineList);

  /* Pages */
  const column = el('div', { class: 'vw-pages' });
  const scroller = el('div', { class: 'vw-scroll', tabindex: '0', 'aria-label': 'Document pages' }, column);
  const linkBar = el('div', { class: 'vw-linkbar', hidden: true, role: 'dialog', 'aria-label': 'Open link' });
  const body = el('div', { class: 'vw-body' }, sidebar, el('div', { class: 'vw-main' }, scroller, linkBar));
  const root = el('div', { class: 'vw' }, toolbar, body, live);
  container.replaceChildren(root);

  /* Layout */
  const count = () => ctx.pageCount();
  const totalRotation = (i) => (ctx.pageRotation(i) + S.rotate) % 360;
  function shownSize(i) {
    const { width, height } = ctx.pageSize(i);
    return S.rotate % 180 ? { width: height, height: width } : { width, height };
  }
  const scale = () => S.zoom * PX_PER_PT;

  function fitZoom() {
    const n = count(); if (!n) return 1;
    const avail = Math.max(120, scroller.clientWidth - 2 * GAP - 2);
    if (S.fit === 'width') {
      let widest = 1; for (let i = 0; i < n; i++) widest = Math.max(widest, shownSize(i).width);
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / (widest * PX_PER_PT)));
    }
    const { width, height } = shownSize(Math.min(S.page, n - 1));
    const availH = Math.max(120, scroller.clientHeight - 2 * GAP);
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(avail / (width * PX_PER_PT), availH / (height * PX_PER_PT))));
  }

  function buildPages() {
    observer.disconnect();
    S.generation++;
    S.pages = [];
    const nodes = [];
    for (let i = 0; i < count(); i++) {
      const canvas = el('canvas', { class: 'vw-canvas', 'aria-hidden': 'true', width: '0', height: '0' });
      const text = el('div', { class: 'vw-text' });
      const marks = el('div', { class: 'vw-marks', 'aria-hidden': 'true' });
      const links = el('div', { class: 'vw-links' });
      const node = el('div', { class: 'vw-page', role: 'region', 'aria-label': `Page ${i + 1}` }, canvas, marks, text, links);
      node.dataset.index = String(i);
      S.pages.push({ node, canvas, text, marks, links, rendered: 0, textShown: -1, near: false });
      nodes.push(node);
    }
    column.replaceChildren(...nodes);
    buildThumbs();
  }

  function sizePages() {
    const s = scale();
    S.pages.forEach((p, i) => { const { width, height } = shownSize(i); p.node.style.width = `${Math.round(width * s)}px`; p.node.style.height = `${Math.round(height * s)}px`; });
  }

  // Keeps the same spot of the current page in view across zoom and rotation changes.
  function relayout() {
    const anchor = S.pages[S.page]?.node; let frac = 0;
    if (anchor) frac = (scroller.scrollTop - anchor.offsetTop) / Math.max(1, anchor.offsetHeight);
    if (S.fit) S.zoom = fitZoom();
    sizePages();
    for (const p of S.pages) { p.rendered = 0; p.textShown = -1; }
    if (anchor) scroller.scrollTop = anchor.offsetTop + frac * anchor.offsetHeight;
    updateZoomUi();
    for (const p of S.pages) if (p.near) queueRender(p);
    pump();
  }

  function updateZoomUi() {
    const pct = Math.round(S.zoom * 100);
    const options = [['width', 'Fit width'], ['page', 'Fit page'], ...ZOOMS.map((z) => [String(z), `${Math.round(z * 100)}%`])];
    if (!S.fit && !ZOOMS.some((z) => Math.abs(z - S.zoom) < 0.001)) options.push([String(S.zoom), `${pct}%`]);
    zoomSelect.replaceChildren(...options.map(([v, t]) => el('option', { value: v, text: t })));
    zoomSelect.value = S.fit ?? String(ZOOMS.find((z) => Math.abs(z - S.zoom) < 0.001) ?? S.zoom);
    fitWidth.setAttribute('aria-pressed', String(S.fit === 'width'));
    fitPage.setAttribute('aria-pressed', String(S.fit === 'page'));
    zoomOut.disabled = S.zoom <= MIN_ZOOM + 0.001; zoomIn.disabled = S.zoom >= MAX_ZOOM - 0.001;
  }

  function setZoom(z) { S.fit = null; S.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)); relayout(); say(`Zoom ${Math.round(S.zoom * 100)}%.`); }
  function zoomBy(f) { setZoom(S.zoom * f); }
  function setFit(f) { S.fit = f; relayout(); say(f === 'width' ? 'Fit width.' : 'Fit page.'); }
  zoomSelect.addEventListener('change', () => { const v = zoomSelect.value; if (v === 'width' || v === 'page') setFit(v); else setZoom(Number(v)); });

  /* Rendering */
  const observer = new IntersectionObserver((entries) => {
    for (const x of entries) {
      const p = S.pages[Number(x.target.dataset.index)]; if (!p) continue;
      p.near = x.isIntersecting;
      if (p.near) queueRender(p);
      else if (p.rendered) { p.canvas.width = 0; p.canvas.height = 0; p.rendered = 0; p.text.replaceChildren(); p.links.replaceChildren(); p.textShown = -1; }
    }
    pump();
  }, { root: scroller, rootMargin: '120% 0px' });

  function queueRender(p) { S.renderQueue.add(p); }
  function pump() {
    while (S.rendering < 2 && S.renderQueue.size) {
      const near = [...S.renderQueue].sort((a, b) => Math.abs(S.pages.indexOf(a) - S.page) - Math.abs(S.pages.indexOf(b) - S.page));
      const p = near[0]; S.renderQueue.delete(p);
      const i = S.pages.indexOf(p);
      if (i < 0 || !p.near) continue;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const want = scale() * dpr;
      if (Math.abs(p.rendered - want) < 0.001) { showText(i); continue; }
      S.rendering++;
      const generation = S.generation; const rotate = S.rotate;
      // MuPDF renders at 72 dpi for scale 1, so the scale in points is pixels per point.
      ctx.renderPage(i, want, rotate).then((bitmap) => {
        if (S.destroyed || generation !== S.generation || rotate !== S.rotate || !p.near) { bitmap.close?.(); return; }
        p.canvas.width = bitmap.width; p.canvas.height = bitmap.height;
        p.canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close?.();
        p.rendered = want;
        showText(i);
      }, () => {}).finally(() => { S.rendering--; pump(); });
    }
  }

  async function showText(i) {
    const p = S.pages[i]; const s = scale(); const key = s * 1000 + S.rotate;
    if (p.textShown === key) return;
    p.textShown = key;
    let data = S.texts.get(i);
    if (!data) {
      try { data = await ctx.pageText(i); } catch { return; }
      if (S.destroyed) return;
      S.texts.set(i, data);
    }
    if (p.textShown !== key) return;
    const r = totalRotation(i); const { width: w, height: h } = data;
    const spans = [];
    for (const line of data.lines) {
      const span = el('span', { text: line.text });
      const vertical = line.wmode === 1;
      const fontPx = Math.max(1, (vertical ? line.w : line.h) * s * 0.92);
      const [px, py] = turn(line.x, line.y, w, h, r);
      span.style.left = `${px * s}px`; span.style.top = `${py * s}px`; span.style.fontSize = `${fontPx}px`;
      const natural = textWidth(line.text, fontPx);
      const sx = natural > 0 ? ((vertical ? line.h : line.w) * s) / natural : 1;
      span.style.transform = `rotate(${(r + (vertical ? 90 : 0)) % 360}deg) scaleX(${sx.toFixed(4)})`;
      spans.push(span, document.createTextNode('\n'));
    }
    p.text.replaceChildren(...spans);
    const links = data.links.map((l) => {
      const box = turnRect(l, w, h, r);
      const a = l.url
        ? el('a', { class: 'vw-link', href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url, 'aria-label': `Link to ${l.url}`, onclick: (e) => { e.preventDefault(); askLink(l.url); } })
        : el('a', { class: 'vw-link', href: '#', title: `Go to page ${l.page + 1}`, 'aria-label': `Go to page ${l.page + 1}`, onclick: (e) => { e.preventDefault(); goTo(l.page); } });
      place(a, box, s);
      return a;
    });
    p.links.replaceChildren(...links);
    drawMarks(i);
  }

  /* Navigation */
  function goTo(i, { smooth = false } = {}) {
    const n = count(); if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    const node = S.pages[i].node;
    scroller.scrollTo({ top: node.offsetTop - GAP / 2, behavior: smooth ? 'smooth' : 'auto' });
    setCurrent(i);
  }
  function setCurrent(i) {
    if (i === S.page && pageInput.value === String(i + 1)) return;
    S.page = i;
    if (document.activeElement !== pageInput) pageInput.value = String(i + 1);
    prevBtn.disabled = i <= 0; nextBtn.disabled = i >= count() - 1;
    for (const li of thumbList.children) li.classList.toggle('current', Number(li.dataset.index) === i);
    const cur = thumbList.children[i];
    if (cur && S.sidebar) { const top = cur.offsetTop - thumbList.offsetTop; if (top < thumbList.scrollTop || top + cur.offsetHeight > thumbList.scrollTop + thumbList.clientHeight) thumbList.scrollTop = top - 20; }
  }
  function trackScroll() {
    if (S.scrollRaf) return;
    S.scrollRaf = requestAnimationFrame(() => {
      S.scrollRaf = 0;
      const mark = scroller.scrollTop + scroller.clientHeight / 3;
      let lo = 0; let hi = S.pages.length - 1; let best = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (S.pages[mid].node.offsetTop <= mark) { best = mid; lo = mid + 1; } else hi = mid - 1; }
      setCurrent(best);
    });
  }
  scroller.addEventListener('scroll', trackScroll, { passive: true });
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const n = Number.parseInt(pageInput.value, 10); if (Number.isFinite(n)) goTo(n - 1); else pageInput.value = String(S.page + 1); scroller.focus({ preventScroll: true }); }
    if (e.key === 'Escape') { pageInput.value = String(S.page + 1); scroller.focus({ preventScroll: true }); }
  });
  pageInput.addEventListener('blur', () => { pageInput.value = String(S.page + 1); });
  pageInput.addEventListener('focus', () => pageInput.select());

  /* Find */
  async function runSearch(query) {
    const token = ++S.searchToken;
    S.query = query; S.hits = []; S.hit = -1; S.capped = false;
    if (!query) { findCount.textContent = ''; redrawMarks(); return; }
    findCount.textContent = 'Searching…';
    let r;
    try { r = await ctx.search(query); } catch { r = { hits: [], capped: false }; }
    if (token !== S.searchToken || S.destroyed) return;
    S.hits = r.hits; S.capped = r.capped;
    const after = S.hits.findIndex((x) => x.page >= S.page);
    S.hit = S.hits.length ? (after < 0 ? 0 : after) : -1;
    redrawMarks();
    showHit();
  }
  function showHit() {
    if (!S.hits.length) { findCount.textContent = S.query ? 'No matches' : ''; say(S.query ? 'No matches.' : ''); return; }
    findCount.textContent = `${S.hit + 1} of ${S.hits.length}${S.capped ? '+' : ''}`;
    const h = S.hits[S.hit];
    const p = S.pages[h.page];
    const data = S.texts.get(h.page);
    const { width: w0, height: h0 } = ctx.pageSize(h.page);
    const r0 = ctx.pageRotation(h.page);
    // The page's own size before the editor's rotation, from the size shown.
    const base = data ?? (r0 % 180 ? { width: h0, height: w0 } : { width: w0, height: h0 });
    const box = turnRect(quadBox(h.quads), base.width, base.height, totalRotation(h.page));
    const top = p.node.offsetTop + box.y * scale() - scroller.clientHeight / 3;
    scroller.scrollTo({ top: Math.max(0, top) });
    const left = p.node.offsetLeft + box.x * scale() - scroller.clientWidth / 3;
    if (box.x * scale() + p.node.offsetLeft > scroller.scrollLeft + scroller.clientWidth || p.node.offsetLeft + box.x * scale() < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left);
    setCurrent(h.page);
    redrawMarks();
    say(`Match ${S.hit + 1} of ${S.hits.length} on page ${h.page + 1}.`);
  }
  function stepHit(d) {
    if (findInput.value !== S.query) { runSearch(findInput.value); return; }
    if (!S.hits.length) return;
    S.hit = (S.hit + d + S.hits.length) % S.hits.length;
    showHit();
  }
  const quadBox = (quads) => {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const q of quads) for (let k = 0; k < 8; k += 2) { x0 = Math.min(x0, q[k]); x1 = Math.max(x1, q[k]); y0 = Math.min(y0, q[k + 1]); y1 = Math.max(y1, q[k + 1]); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  function drawMarks(i) {
    const p = S.pages[i]; const data = S.texts.get(i);
    if (!p) return;
    if (!data || !S.hits.length) { p.marks.replaceChildren(); return; }
    const s = scale(); const r = totalRotation(i);
    const out = [];
    S.hits.forEach((h, k) => {
      if (h.page !== i) return;
      for (const q of h.quads) {
        const m = el('div', { class: k === S.hit ? 'vw-mark current' : 'vw-mark' });
        place(m, turnRect(quadBox([q]), data.width, data.height, r), s);
        out.push(m);
      }
    });
    p.marks.replaceChildren(...out);
  }
  function redrawMarks() { S.pages.forEach((p, i) => { if (S.texts.has(i)) drawMarks(i); }); }
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (findInput.value !== S.query) runSearch(findInput.value); else stepHit(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { findInput.value = ''; runSearch(''); scroller.focus({ preventScroll: true }); }
  });
  findInput.addEventListener('search', () => { if (!findInput.value) runSearch(''); });

  /* Links */
  function askLink(url) {
    const open = el('a', { class: 'button vw-open', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Open in a new tab', onclick: () => { linkBar.hidden = true; } });
    linkBar.replaceChildren(el('span', { class: 'vw-linkicon' }, icon(ICONS.link)),
      el('div', { class: 'vw-linktext' }, el('strong', { text: 'This link leaves the editor' }), el('span', { text: url })),
      open, el('button', { type: 'button', class: 'vw-btn', text: 'Cancel', onclick: () => { linkBar.hidden = true; scroller.focus({ preventScroll: true }); } }));
    linkBar.hidden = false; open.focus();
  }

  /* Sidebar */
  function setSidebar(on) {
    S.sidebar = on; body.classList.toggle('no-sidebar', !on); sideBtn.setAttribute('aria-pressed', String(on));
    if (S.fit) requestAnimationFrame(() => relayout());
    if (on) loadThumbs();
  }
  function setSideTab(tab) {
    S.sideTab = tab;
    thumbsTab.setAttribute('aria-selected', String(tab === 'thumbs')); outlineTab.setAttribute('aria-selected', String(tab === 'outline'));
    thumbList.hidden = tab !== 'thumbs'; outlineList.hidden = tab !== 'outline';
  }
  const thumbObserver = new IntersectionObserver((entries) => {
    for (const x of entries) if (x.isIntersecting) { thumbObserver.unobserve(x.target); drawThumb(Number(x.target.dataset.index)); }
  }, { root: thumbList, rootMargin: '200px 0px' });
  function buildThumbs() {
    thumbObserver.disconnect();
    const items = [];
    for (let i = 0; i < count(); i++) {
      const { width, height } = shownSize(i);
      const canvas = el('canvas', { 'aria-hidden': 'true' });
      const k = 110 / Math.max(width, height); canvas.width = Math.max(1, Math.round(width * k)); canvas.height = Math.max(1, Math.round(height * k));
      const li = el('li', {}, el('button', { type: 'button', 'aria-label': `Page ${i + 1}`, onclick: () => goTo(i) }, el('span', { class: 'vw-thumb' }, canvas), el('span', { class: 'vw-thumbnum', text: String(i + 1) })));
      li.dataset.index = String(i);
      items.push(li);
    }
    thumbList.replaceChildren(...items);
    if (S.sidebar) loadThumbs();
  }
  function loadThumbs() { for (const li of thumbList.children) if (!li.dataset.drawn) thumbObserver.observe(li); }
  async function drawThumb(i) {
    const li = thumbList.children[i]; if (!li || li.dataset.drawn) return;
    li.dataset.drawn = '1';
    const generation = S.generation;
    let bitmap = null; try { bitmap = await ctx.thumbnail(i); } catch { bitmap = null; }
    if (!bitmap || generation !== S.generation || S.destroyed) return;
    const canvas = li.querySelector('canvas'); const r = totalRotation(i);
    const turned = r % 180 !== 0;
    const k = 110 / Math.max(bitmap.width, bitmap.height);
    canvas.width = Math.round((turned ? bitmap.height : bitmap.width) * k); canvas.height = Math.round((turned ? bitmap.width : bitmap.height) * k);
    const g = canvas.getContext('2d');
    g.translate(canvas.width / 2, canvas.height / 2); g.rotate((r * Math.PI) / 180); g.scale(k, k);
    g.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  }
  async function loadOutline() {
    const generation = S.generation;
    let items = [];
    try { items = await ctx.outline(); } catch { items = []; }
    if (generation !== S.generation || S.destroyed) return;
    const build = (list) => list.map((o) => {
      const li = el('li', {}, o.page >= 0 ? el('button', { type: 'button', text: o.title || 'Untitled', onclick: () => goTo(o.page) }) : el('span', { text: o.title || 'Untitled' }));
      if (o.kids.length) li.append(el('ul', {}, build(o.kids)));
      return li;
    });
    outlineList.replaceChildren(...build(items));
    outlineTab.hidden = !items.length;
    if (!items.length && S.sideTab === 'outline') setSideTab('thumbs');
  }

  /* Full screen */
  function toggleFullscreen() {
    if (document.fullscreenElement === root) document.exitFullscreen?.();
    else root.requestFullscreen?.().catch(() => {});
  }
  const onFullscreen = () => {
    const on = document.fullscreenElement === root;
    fullBtn.replaceChildren(icon(on ? ICONS.exit : ICONS.full));
    fullBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen'); fullBtn.title = fullBtn.getAttribute('aria-label');
    requestAnimationFrame(() => relayout());
  };
  document.addEventListener('fullscreenchange', onFullscreen);

  /* Keyboard: only while the viewer is shown */
  const active = () => !S.destroyed && container.offsetParent !== null && !container.closest('[hidden]');
  const onKey = (e) => {
    if (!active()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); findInput.focus(); findInput.select(); return; }
    if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(1.25); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.25); return; }
    if (mod && e.key === '0') { e.preventDefault(); setFit('width'); return; }
    if (mod || e.altKey || e.target.closest('input, textarea, select, [contenteditable], button, a')) return;
    const page = scroller.clientHeight * 0.9;
    const keys = { ArrowDown: () => scroller.scrollBy(0, 48), ArrowUp: () => scroller.scrollBy(0, -48), PageDown: () => scroller.scrollBy(0, page), PageUp: () => scroller.scrollBy(0, -page), ' ': () => scroller.scrollBy(0, e.shiftKey ? -page : page), Home: () => goTo(0), End: () => goTo(count() - 1), ArrowRight: () => goTo(S.page + 1), ArrowLeft: () => goTo(S.page - 1) };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  };
  document.addEventListener('keydown', onKey);

  let resizeTimer = 0;
  const resizeObserver = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.fit && active()) relayout(); }, 120); });
  resizeObserver.observe(scroller);

  function load() {
    S.texts.clear(); S.renderQueue.clear(); S.outline = null;
    const n = count();
    pageTotal.textContent = `of ${n}`;
    S.page = Math.min(S.page, Math.max(0, n - 1));
    buildPages();
    if (S.fit) S.zoom = fitZoom();
    sizePages();
    updateZoomUi();
    setCurrent(S.page);
    goTo(S.page);
    // Observed only once the placeholders have their sizes, so only pages near the view render.
    for (const p of S.pages) observer.observe(p.node);
    loadOutline();
    if (S.query) runSearch(S.query);
  }

  body.classList.toggle('no-sidebar', !S.sidebar);
  requestAnimationFrame(() => load());

  return {
    refresh() { load(); },
    focusFind() { findInput.focus(); },
    unmount() {
      S.destroyed = true; observer.disconnect(); thumbObserver.disconnect(); resizeObserver.disconnect();
      document.removeEventListener('keydown', onKey); document.removeEventListener('fullscreenchange', onFullscreen);
      container.replaceChildren();
    },
  };
}
