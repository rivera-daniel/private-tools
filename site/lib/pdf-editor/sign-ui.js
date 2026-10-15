// Sign mode of the PDF Editor. mountSign(container, ctx) builds the panel inside container and returns
// { unmount(), refresh(), signedBytes() }. ctx follows the editor's mode contract: getBytes(), setBytes(u8, label),
// pageCount(), pageSize(i), renderPage(i, scale), plus the optional originalBytes(): the exact bytes of the
// working document when it is one file with no edits since it was opened or adopted, or null. Signing and
// checking use those bytes when there are any, because rebuilding a signed file breaks its signatures.
// After signing, setBytes(signed, 'Signed') is called and a 'pdf-signed' event with detail { bytes } bubbles
// from the container; the editor must save those bytes unchanged (no cleaning, no password) for the signature
// to stay valid. signedBytes() returns them until the document changes.
//
// Key sources: a .p12/.pfx file (decrypted here with WebCrypto), or a smart card through the local signer
// program (see local/signer/ in the source repository). The card option only appears when the page was served
// by that program, which injects <meta name="local-signer-token">; the hosted site never shows it.
import { signPdf, verifyPdf, readCertificates, describeChange, SignError } from './sign.js';
import { p12Signer, P12Error } from './pkcs12.js';
import { parseCertificate, algorithmsFor } from './cms.js';

const STYLES = '/lib/pdf-editor/sign.css';
const MAX_P12 = 1 << 20;
const MAX_IMAGE_SIDE = 600;

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
const ICONS = { prev: 'M15 6l-6 6 6 6', next: 'M9 6l6 6-6 6', check: 'M5 12.5l4.5 4.5L19 7', warn: 'M12 4l9 16H3zM12 10v4M12 17v.5', cross: 'M6 6l12 12M18 6L6 18', pen: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4', info: 'M12 8v.5M12 11v5M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18' };

function ensureStyles() {
  if (document.querySelector(`link[href="${STYLES}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLES }));
}

const dateText = (d) => (d ? d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const dayText = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const sameBytes = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ALG_LABEL = { 'RSASSA-PKCS1-v1_5': 'RSA PKCS #1 v1.5 (most compatible)', 'RSA-PSS': 'RSA-PSS', 'ECDSA-P256': 'ECDSA P-256', 'ECDSA-P384': 'ECDSA P-384' };

/* Smart card through the local signer */

function localSignerToken() { return document.querySelector('meta[name="local-signer-token"]')?.getAttribute('content') || null; }

async function cardStatus(token) {
  try {
    const res = await fetch('/local-signer/status', { headers: { 'X-Local-Signer-Token': token }, cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    const json = await res.json();
    return json && json.version === 1 && Array.isArray(json.tokens) ? json : null;
  } catch { return null; }
}

function cardSigner(token, slot, cert, others, algorithm, pin) {
  const leaf = parseCertificate(unb64(cert.der));
  // The chain: issuers of the leaf found among the other certificates on the card.
  const pool = others.map((c) => { try { return parseCertificate(unb64(c.der)); } catch { return null; } }).filter(Boolean);
  const chain = [leaf];
  for (let cur = leaf; chain.length < 6 && !cur.selfIssued;) {
    const next = pool.find((c) => !chain.includes(c) && c.subject.text === cur.issuer.text);
    if (!next) break; chain.push(next); cur = next;
  }
  return {
    certificates: chain.map((c) => c.der), algorithm, certificate: leaf,
    async sign(digest) {
      const res = await fetch('/local-signer/sign', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Local-Signer-Token': token },
        body: JSON.stringify({ slot: slot.slot, id: cert.id, pin, algorithm, hash: algorithm === 'ECDSA-P384' ? 'SHA-384' : 'SHA-256', digest: b64(digest) }),
      });
      let json = null; try { json = await res.json(); } catch { /* not JSON */ }
      if (!res.ok || !json?.signature) {
        let message = json?.error || `The card signer refused the request (HTTP ${res.status}).`;
        if (json?.pinFinalTry) message += ' One try is left before the card locks.';
        else if (json?.pinCountLow) message += ' Few tries are left before the card locks.';
        throw new SignError(message);
      }
      return unb64(json.signature);
    },
  };
}

/* Panel */

export function mountSign(container, ctx) {
  ensureStyles();
  const S = {
    page: 0, box: null, draft: null, visible: true, source: 'file', p12: null, p12File: null, algorithm: null,
    card: null, cardToken: localSignerToken(), cardChoice: '', image: null, imageName: '', trusted: [], signed: null,
    busy: false, destroyed: false, renderToken: 0, scale: 1, verifyToken: 0,
  };

  const live = el('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const say = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };

  /* Page view with the box */
  const pageLabel = el('span', { class: 'sg-pagenum' });
  const navBtn = (label, d, onclick) => el('button', { type: 'button', class: 'sg-icon', 'aria-label': label, title: label, onclick }, icon(d));
  const prevBtn = navBtn('Previous page', ICONS.prev, () => go(S.page - 1));
  const nextBtn = navBtn('Next page', ICONS.next, () => go(S.page + 1));
  const placeBtn = el('button', { type: 'button', class: 'sg-btn small', text: 'Place a box', onclick: () => placeDefault() });
  const clearBoxBtn = el('button', { type: 'button', class: 'sg-btn small', text: 'Clear box', onclick: () => { S.box = null; drawBox(); update(); } });
  const toolbar = el('div', { class: 'sg-toolbar', role: 'toolbar', 'aria-label': 'Page' }, el('div', { class: 'sg-group' }, prevBtn, pageLabel, nextBtn), el('div', { class: 'sg-group' }, placeBtn, clearBoxBtn));
  const canvas = el('canvas', { class: 'sg-canvas', 'aria-hidden': 'true' });
  const boxEl = el('div', { class: 'sg-box', hidden: true }, el('span', { text: 'Signature' }));
  const overlay = el('div', { class: 'sg-overlay', role: 'img', 'aria-label': 'Page preview. Drag to draw where the signature goes.' });
  const sheet = el('div', { class: 'sg-sheet' }, canvas, overlay, boxEl);
  const stage = el('div', { class: 'sg-stage' }, sheet);
  const boxHint = el('p', { class: 'sg-hint' });
  const viewer = el('div', { class: 'sg-viewer' }, toolbar, stage, boxHint);

  /* Key source */
  const sourceFile = el('input', { type: 'radio', name: 'sg-source', value: 'file', checked: true });
  const sourceCard = el('input', { type: 'radio', name: 'sg-source', value: 'card' });
  const cardChoiceLabel = el('label', { class: 'sg-seg', hidden: true }, sourceCard, el('span', { text: 'Smart card or USB token' }));
  const sourceSet = el('div', { class: 'sg-segs', role: 'radiogroup', 'aria-label': 'Key source' }, el('label', { class: 'sg-seg' }, sourceFile, el('span', { text: 'Certificate file (.p12/.pfx)' })), cardChoiceLabel);

  const fileInput = el('input', { type: 'file', id: 'sg-p12', class: 'visually-hidden', accept: '.p12,.pfx,application/x-pkcs12', tabindex: '-1' });
  const fileName = el('span', { class: 'sg-filename', text: 'No file chosen' });
  const chooseBtn = el('button', { type: 'button', class: 'sg-btn', text: 'Choose file', onclick: () => fileInput.click() });
  const pwInput = el('input', { type: 'password', id: 'sg-password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Password' });
  const openBtn = el('button', { type: 'submit', class: 'sg-btn', text: 'Open' });
  const fileError = el('p', { class: 'sg-error', role: 'alert', hidden: true });
  const filePane = el('form', { class: 'sg-pane', onsubmit: (e) => { e.preventDefault(); openP12(); } },
    el('div', { class: 'sg-inline' }, chooseBtn, fileName), fileInput,
    el('div', { class: 'sg-inline' }, el('label', { class: 'visually-hidden', for: 'sg-password', text: 'Certificate password' }), pwInput, openBtn),
    fileError);

  const cardSelect = el('select', { id: 'sg-card-cert' });
  const pinInput = el('input', { type: 'password', id: 'sg-pin', autocomplete: 'off', spellcheck: 'false', inputmode: 'numeric', placeholder: 'PIN' });
  const cardNote = el('p', { class: 'sg-hint' });
  const cardError = el('p', { class: 'sg-error', role: 'alert', hidden: true });
  const cardRefresh = el('button', { type: 'button', class: 'sg-btn small', text: 'Look again', onclick: () => loadCard(true) });
  const cardPane = el('div', { class: 'sg-pane', hidden: true },
    el('label', { class: 'sg-label', for: 'sg-card-cert', text: 'Certificate on the card' }), el('div', { class: 'sg-inline' }, cardSelect, cardRefresh),
    el('label', { class: 'sg-label', for: 'sg-pin', text: 'Card PIN' }), pinInput, cardNote, cardError);

  const certBox = el('div', { class: 'sg-cert', hidden: true });
  const algSelect = el('select', { id: 'sg-alg' });
  const algField = el('div', { class: 'sg-field', hidden: true }, el('label', { class: 'sg-label', for: 'sg-alg', text: 'Signature algorithm' }), algSelect);
  const keyCard = el('section', { class: 'sg-card', 'aria-label': 'Signing certificate' }, el('h3', { class: 'sg-card-title', text: 'Certificate' }), sourceSet, filePane, cardPane, certBox, algField);

  /* Placement and details */
  const visibleRadio = el('input', { type: 'radio', name: 'sg-visible', value: 'visible', checked: true });
  const invisibleRadio = el('input', { type: 'radio', name: 'sg-visible', value: 'invisible' });
  const placement = el('div', { class: 'sg-choices' }, el('label', {}, visibleRadio, el('span', { text: 'Visible: draw a box on the page' })), el('label', {}, invisibleRadio, el('span', { text: 'Invisible' })));
  const imageInput = el('input', { type: 'file', id: 'sg-image', class: 'visually-hidden', accept: 'image/png,image/jpeg,image/webp', tabindex: '-1' });
  const imageName = el('span', { class: 'sg-filename', text: 'No image' });
  const imageBtn = el('button', { type: 'button', class: 'sg-btn small', text: 'Add an image', onclick: () => imageInput.click() });
  const imageClear = el('button', { type: 'button', class: 'sg-btn small', text: 'Remove', hidden: true, onclick: () => { S.image = null; imageInput.value = ''; update(); } });
  const imageRow = el('div', { class: 'sg-inline sg-image' }, imageBtn, imageClear, imageName, imageInput);
  const reasonInput = el('input', { type: 'text', id: 'sg-reason', maxlength: '200', autocomplete: 'off', placeholder: 'I approve this document' });
  const locationInput = el('input', { type: 'text', id: 'sg-location', maxlength: '200', autocomplete: 'off', placeholder: 'City, country' });
  const detailsCard = el('section', { class: 'sg-card', 'aria-label': 'Signature details' },
    el('h3', { class: 'sg-card-title', text: 'Signature' }), placement, imageRow,
    el('div', { class: 'sg-field' }, el('label', { class: 'sg-label', for: 'sg-reason', text: 'Reason (optional)' }), reasonInput),
    el('div', { class: 'sg-field' }, el('label', { class: 'sg-label', for: 'sg-location', text: 'Location (optional)' }), locationInput));

  const notes = el('ul', { class: 'sg-notes' },
    el('li', { text: 'Adobe shows the signer as unknown unless it trusts your certificate.' }),
    el('li', { text: 'Saving other edits after signing invalidates the signature — sign last.' }));
  const signBtn = el('button', { type: 'button', class: 'button sg-sign', text: 'Sign', onclick: () => askConfirm() });
  const blocker = el('p', { class: 'sg-hint sg-blocker' });
  const confirmText = el('p', {});
  const confirmBtn = el('button', { type: 'button', class: 'button', text: 'Confirm signature', onclick: () => sign() });
  const cancelBtn = el('button', { type: 'button', class: 'sg-btn', text: 'Cancel', onclick: () => { confirmBox.hidden = true; signBtn.hidden = false; signBtn.focus(); } });
  const confirmBox = el('div', { class: 'sg-confirm', role: 'alertdialog', 'aria-label': 'Confirm signature', hidden: true }, el('strong', { text: 'Sign this document?' }), confirmText, el('div', { class: 'sg-inline' }, confirmBtn, cancelBtn));
  const busyEl = el('p', { class: 'sg-busy', hidden: true, role: 'status' });
  const signError = el('p', { class: 'sg-error', role: 'alert', hidden: true });
  const result = el('div', { class: 'sg-result', hidden: true, role: 'status' });

  /* Verification */
  const verifyList = el('div', { class: 'sg-sigs' });
  const trustInput = el('input', { type: 'file', id: 'sg-trust', class: 'visually-hidden', accept: '.cer,.crt,.pem,.der,application/pkix-cert,application/x-x509-ca-cert', tabindex: '-1' });
  const trustBtn = el('button', { type: 'button', class: 'sg-btn small', text: 'Trust a root certificate', onclick: () => trustInput.click() });
  const trustList = el('ul', { class: 'sg-trusted' });
  const trustError = el('p', { class: 'sg-error', role: 'alert', hidden: true });
  const verifyCard = el('section', { class: 'sg-card', 'aria-label': 'Signatures in this document' },
    el('div', { class: 'sg-card-head' }, el('h3', { class: 'sg-card-title', text: 'Signatures in this document' }), el('div', { class: 'sg-actions' }, trustBtn, el('button', { type: 'button', class: 'sg-btn small', text: 'Check again', onclick: () => verify() }))),
    trustInput, trustList, trustError, verifyList,
    el('p', { class: 'sg-hint', text: 'Checked offline in this browser: revocation (CRL and OCSP) and timestamps are not checked, and certificates are trusted only if you import their root here.' }));

  const side = el('div', { class: 'sg-side' }, keyCard, detailsCard, notes, blocker, signBtn, confirmBox, busyEl, signError, result);
  const root = el('div', { class: 'sg' },
    el('div', { class: 'sg-head' }, el('h2', { text: 'Sign' }), el('p', { text: 'Add a digital signature with your certificate. The key never leaves this device.' })),
    el('div', { class: 'sg-layout' }, viewer, side), verifyCard, live);
  container.replaceChildren(root);

  /* Rendering */
  const pageCount = () => ctx.pageCount();
  const pageSize = (i) => ctx.pageSize(i);

  async function renderPage() {
    const n = pageCount();
    if (!n) { pageLabel.textContent = 'No pages'; return; }
    S.page = Math.min(Math.max(0, S.page), n - 1);
    pageLabel.textContent = `Page ${S.page + 1} of ${n}`;
    prevBtn.disabled = S.page === 0; nextBtn.disabled = S.page >= n - 1;
    const { width, height } = pageSize(S.page);
    const avail = Math.max(200, stage.clientWidth - 32);
    S.scale = Math.min(avail / width, 1.6);
    sheet.style.width = `${Math.round(width * S.scale)}px`; sheet.style.height = `${Math.round(height * S.scale)}px`;
    drawBox();
    const token = ++S.renderToken;
    try {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bitmap = await ctx.renderPage(S.page, S.scale * dpr);
      if (token !== S.renderToken || S.destroyed) { bitmap.close?.(); return; }
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.style.width = `${Math.round(width * S.scale)}px`; canvas.style.height = `${Math.round(height * S.scale)}px`;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close?.();
    } catch { /* the editor shows rendering problems itself */ }
  }

  function go(i) { if (i < 0 || i >= pageCount()) return; S.page = i; renderPage(); update(); }

  function drawBox() {
    const b = S.draft ?? (S.box && S.box.page === S.page ? S.box : null);
    boxEl.hidden = !b || !S.visible;
    boxEl.classList.toggle('draft', Boolean(S.draft));
    if (b) Object.assign(boxEl.style, { left: `${b.x * S.scale}px`, top: `${b.y * S.scale}px`, width: `${b.width * S.scale}px`, height: `${b.height * S.scale}px` });
  }

  function placeDefault() {
    const { width, height } = pageSize(S.page);
    const w = Math.min(220, width - 40); const h = Math.min(70, height - 40);
    S.box = { page: S.page, x: width - w - 36, y: height - h - 48, width: w, height: h };
    S.visible = true; visibleRadio.checked = true;
    drawBox(); update(); say(`Signature box placed on page ${S.page + 1}.`);
    stage.scrollTop = Math.max(0, S.box.y * S.scale + 16 + S.box.height * S.scale - stage.clientHeight + 24);
  }

  let drag = null;
  const pointAt = (e) => { const r = overlay.getBoundingClientRect(); const { width, height } = pageSize(S.page); return [Math.min(Math.max(0, (e.clientX - r.left) / S.scale), width), Math.min(Math.max(0, (e.clientY - r.top) / S.scale), height)]; };
  overlay.addEventListener('pointerdown', (e) => {
    if (!S.visible || S.busy || e.button !== 0) return;
    e.preventDefault(); overlay.setPointerCapture(e.pointerId);
    drag = pointAt(e); S.draft = { page: S.page, x: drag[0], y: drag[1], width: 0, height: 0 }; drawBox();
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = pointAt(e);
    S.draft = { page: S.page, x: Math.min(x, drag[0]), y: Math.min(y, drag[1]), width: Math.abs(x - drag[0]), height: Math.abs(y - drag[1]) };
    drawBox();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    if (S.draft && S.draft.width >= 24 && S.draft.height >= 12) { S.box = S.draft; say(`Signature box drawn on page ${S.page + 1}.`); }
    S.draft = null; drawBox(); update();
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', () => { drag = null; S.draft = null; drawBox(); });
  const onResize = () => renderPage();
  window.addEventListener('resize', onResize);

  /* Key sources */
  function signer() {
    if (S.source === 'file') return S.p12 ? (S.algorithm && S.algorithm !== S.p12.algorithm ? S.p12.withAlgorithm(S.algorithm) : S.p12) : null;
    const c = currentCardCert();
    if (!c || !S.cardToken) return null;
    const slot = S.card.tokens.find((t) => t.slot === c.slot);
    return cardSigner(S.cardToken, slot, c.cert, slot.certificates.filter((x) => x !== c.cert), S.algorithm ?? c.cert.algorithms[0], pinInput.value);
  }
  function currentCardCert() {
    if (!S.card) return null;
    const [slot, id] = S.cardChoice.split(':');
    const t = S.card.tokens.find((x) => String(x.slot) === slot);
    const cert = t?.certificates.find((c) => c.id === id);
    return cert ? { slot: t.slot, token: t, cert } : null;
  }

  function showCert(cert, extra = []) {
    if (!cert) { certBox.hidden = true; algField.hidden = true; return; }
    const now = new Date();
    const rows = [['Subject', cert.subject.text], ['Issuer', cert.issuer.text], ['Valid', `${dayText(cert.notBefore)} – ${dayText(cert.notAfter)}`], ['Key', cert.key.type === 'EC' ? `ECDSA ${cert.key.curve}` : `RSA ${cert.key.bits}-bit`], ...extra];
    if (cert.keyUsage) rows.push(['Key usage', cert.keyUsage.join(', ')]);
    const warnings = [];
    if (now > cert.notAfter) warnings.push('This certificate has expired. Signatures made with it show as invalid in most readers.');
    if (now < cert.notBefore) warnings.push('This certificate is not valid yet.');
    if (cert.keyUsage && !cert.keyUsage.includes('Digital signature') && !cert.keyUsage.includes('Non-repudiation')) warnings.push('This certificate is not meant for signing; readers may reject the signature.');
    certBox.replaceChildren(
      el('strong', { class: 'sg-cert-name', text: cert.subject.cn || cert.subject.text }),
      el('dl', {}, rows.map(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
      ...warnings.map((w) => el('p', { class: 'sg-warn' }, icon(ICONS.warn), el('span', { text: w }))));
    certBox.hidden = false;
    const algs = algorithmsFor(cert);
    if (!algs.includes(S.algorithm)) S.algorithm = algs[0] ?? null;
    algSelect.replaceChildren(...algs.map((a) => el('option', { value: a, text: ALG_LABEL[a], selected: a === S.algorithm })));
    algField.hidden = algs.length < 2;
  }

  async function openP12() {
    fileError.hidden = true;
    if (!S.p12File) { fileError.textContent = 'Choose a .p12 or .pfx file first.'; fileError.hidden = false; return; }
    if (S.p12File.size > MAX_P12) { fileError.textContent = 'This file is too large to be a certificate file.'; fileError.hidden = false; return; }
    openBtn.disabled = true; openBtn.textContent = 'Opening…';
    try {
      const bytes = new Uint8Array(await S.p12File.arrayBuffer());
      S.p12 = await p12Signer(bytes, pwInput.value);
      bytes.fill(0);
      pwInput.value = '';
      S.algorithm = S.p12.algorithm;
      showCert(S.p12.certificate, S.p12.chain.length > 1 ? [['Chain', `${S.p12.chain.length - 1} issuer certificate${S.p12.chain.length > 2 ? 's' : ''} included`]] : [['Chain', 'No issuer certificates in the file']]);
      say(`Opened the certificate of ${S.p12.certificate.subject.cn || S.p12.certificate.subject.text}.`);
    } catch (error) {
      S.p12 = null; showCert(null);
      fileError.textContent = error instanceof P12Error || error instanceof SignError ? error.message : `The file could not be opened (${error.message}).`;
      fileError.hidden = false;
    } finally { openBtn.disabled = false; openBtn.textContent = 'Open'; update(); }
  }

  async function loadCard(force = false) {
    if (!S.cardToken) return;
    if (force) { cardRefresh.disabled = true; cardError.hidden = true; }
    const status = await cardStatus(S.cardToken);
    cardRefresh.disabled = false;
    if (S.destroyed) return;
    if (!status) { if (force) { cardError.textContent = 'The card signer is not responding. Is it still running?'; cardError.hidden = false; } return; }
    S.card = status;
    cardChoiceLabel.hidden = false;
    const options = [];
    for (const t of status.tokens) for (const c of t.certificates) {
      if (!c.algorithms?.length) continue;
      options.push(el('option', { value: `${t.slot}:${c.id}`, text: `${c.subject.replace(/^.*?CN=([^,]+).*$/, '$1')} — ${t.label || 'Token'}` }));
    }
    cardSelect.replaceChildren(...(options.length ? options : [el('option', { value: '', text: 'No usable certificates found' })]));
    if (!options.some((o) => o.value === S.cardChoice)) S.cardChoice = options[0]?.value ?? '';
    cardSelect.value = S.cardChoice;
    cardNote.textContent = status.error ? status.error : !status.tokens.length ? 'No card or token found. Insert it and choose Look again.' : 'The PIN goes only to the card signer running on this computer.';
    if (S.source === 'card') showCardCert();
    update();
  }

  function showCardCert() {
    const c = currentCardCert();
    if (!c) { showCert(null); return; }
    let cert = null;
    try { cert = parseCertificate(unb64(c.cert.der)); } catch { showCert(null); return; }
    const flags = [];
    if (c.token.pinLocked) flags.push('The PIN is locked.');
    else if (c.token.pinFinalTry) flags.push('One PIN try is left before the card locks.');
    else if (c.token.pinCountLow) flags.push('Few PIN tries are left.');
    showCert(cert, [['Card', [c.token.label, c.token.manufacturer].filter(Boolean).join(' · ')]]);
    for (const f of flags) certBox.append(el('p', { class: 'sg-warn' }, icon(ICONS.warn), el('span', { text: f })));
    pinInput.hidden = Boolean(c.token.protectedAuthPath);
    if (c.token.protectedAuthPath) cardNote.textContent = 'Enter the PIN on the card reader when asked.';
  }

  function setSource(source) {
    S.source = source; S.algorithm = null;
    filePane.hidden = source !== 'file'; cardPane.hidden = source !== 'card';
    if (source === 'file') showCert(S.p12?.certificate ?? null); else showCardCert();
    if (S.p12 && source === 'file') S.algorithm = S.p12.algorithm;
    update();
  }

  /* Appearance */
  async function loadImage(file) {
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * s)); const h = Math.max(1, Math.round(bmp.height * s));
      const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0, w, h); bmp.close();
      S.image = { width: w, height: h, rgba: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer) };
      S.imageName = file.name;
    } catch { S.image = null; signError.textContent = 'That image could not be read.'; signError.hidden = false; }
    update();
  }

  function appearanceLines(cert) {
    const name = cert?.subject.cn || cert?.subject.o || cert?.subject.text || 'Unknown signer';
    const lines = [`Digitally signed by ${name}`, `Date: ${new Date().toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}`];
    if (reasonInput.value.trim()) lines.push(`Reason: ${reasonInput.value.trim()}`);
    if (locationInput.value.trim()) lines.push(`Location: ${locationInput.value.trim()}`);
    return lines;
  }

  /* Signing */
  function problem() {
    if (!pageCount()) return 'Open a PDF first.';
    if (S.source === 'file' && !S.p12) return 'Open your certificate file first.';
    if (S.source === 'card') {
      const c = currentCardCert();
      if (!c) return 'Choose a certificate on the card.';
      if (c.token.pinLocked) return 'The card PIN is locked.';
      if (!c.token.protectedAuthPath && !pinInput.value) return 'Enter the card PIN.';
    }
    if (S.visible && !S.box) return 'Draw the signature box on a page, or choose Invisible.';
    return '';
  }

  function update() {
    const p = problem();
    signBtn.disabled = S.busy || Boolean(p);
    blocker.textContent = p; blocker.hidden = !p;
    imageRow.hidden = !S.visible;
    imageName.textContent = S.image ? S.imageName : 'No image';
    imageClear.hidden = !S.image;
    placeBtn.disabled = !S.visible || !pageCount(); clearBoxBtn.disabled = !S.box;
    overlay.classList.toggle('drawing', S.visible);
    boxHint.textContent = !S.visible ? 'The signature will be invisible. It still appears in the signature panel of PDF readers.'
      : S.box ? `Signature box on page ${S.box.page + 1}, ${Math.round(S.box.width)} × ${Math.round(S.box.height)} points. Drag to redraw it.`
        : 'Drag on the page to draw where the signature goes, or use Place a box.';
    if (!confirmBox.hidden && p) { confirmBox.hidden = true; signBtn.hidden = false; }
    drawBox();
  }

  function askConfirm() {
    if (problem() || S.busy) return;
    const s = signer();
    const cert = s.certificate;
    const where = S.visible ? `a visible signature on page ${S.box.page + 1}` : 'an invisible signature';
    confirmText.textContent = `${cert.subject.cn || cert.subject.text} adds ${where}${S.source === 'card' ? ' with the key on the card' : ''}. Undo removes it again.`;
    signBtn.hidden = true; confirmBox.hidden = false; confirmBtn.focus();
  }

  async function documentBytes() {
    const exact = (await ctx.originalBytes?.()) ?? null;
    return { bytes: exact ?? await ctx.getBytes(), exact: Boolean(exact) };
  }

  async function sign() {
    confirmBox.hidden = true; signBtn.hidden = false;
    if (problem() || S.busy) return;
    S.busy = true; update(); signError.hidden = true; result.hidden = true;
    busyEl.textContent = S.source === 'card' ? 'Signing with the card…' : 'Signing…'; busyEl.hidden = false;
    try {
      const s = signer();
      const { bytes } = await documentBytes();
      const out = await signPdf(bytes, s, {
        reason: reasonInput.value.trim() || undefined, location: locationInput.value.trim() || undefined,
        page: S.visible ? S.box.page : 0,
        rect: S.visible ? { x: S.box.x, y: S.box.y, width: S.box.width, height: S.box.height } : undefined,
        appearance: S.visible ? { lines: appearanceLines(s.certificate), image: S.image ?? undefined } : undefined,
      });
      if (S.source === 'card') pinInput.value = '';
      S.signed = out;
      await ctx.setBytes(out, 'Signed');
      container.dispatchEvent(new CustomEvent('pdf-signed', { bubbles: true, detail: { bytes: out } }));
      result.replaceChildren(icon(ICONS.check), el('div', {}, el('strong', { text: 'Signed' }), el('p', { text: 'Save the PDF now. Any other edit before saving invalidates the signature.' })));
      result.hidden = false;
      say('Document signed.');
      S.box = null;
      await verify(out);
      if (S.source === 'card') loadCard();
    } catch (error) {
      signError.textContent = error instanceof SignError || error instanceof P12Error ? error.message : `Signing failed: ${error.message}`;
      signError.hidden = false;
      if (S.source === 'card') loadCard();
    } finally { S.busy = false; busyEl.hidden = true; update(); }
  }

  /* Verification view */
  async function verify(known) {
    const token = ++S.verifyToken;
    verifyList.replaceChildren(el('p', { class: 'sg-empty', text: 'Checking…' }));
    let report; let exact = true;
    try {
      let bytes = known;
      if (!bytes) { if (!pageCount()) { verifyList.replaceChildren(el('p', { class: 'sg-empty', text: 'No document open.' })); return; } ({ bytes, exact } = await documentBytes()); }
      report = await verifyPdf(bytes, { trusted: S.trusted });
    } catch (error) { report = { signatures: [], problem: `The signatures could not be checked (${error.message}).` }; }
    if (token !== S.verifyToken || S.destroyed) return;
    const items = [];
    if (report.problem) items.push(el('p', { class: 'sg-error', text: report.problem }));
    else if (!report.signatures.length) items.push(el('p', { class: 'sg-empty', text: 'This document has no digital signatures.' }));
    if (!exact && report.signatures.length) items.push(el('p', { class: 'sg-warn' }, icon(ICONS.warn), el('span', { text: 'The pages were edited after opening, so these results describe the edited copy, in which earlier signatures no longer match.' })));
    for (const s of report.signatures) items.push(signatureItem(s));
    verifyList.replaceChildren(...items);
  }

  const STATUS = {
    valid: [ICONS.check, 'Valid', 'The document has not changed since it was signed.'],
    'valid-later-signed': [ICONS.check, 'Valid', 'Valid for the revision it signed. Later revisions only add signatures.'],
    'valid-later-changed': [ICONS.warn, 'Valid, then changed', 'The signature is intact, but the document was changed after signing.'],
    invalid: [ICONS.cross, 'Not valid', 'The signature does not match the document.'],
    unsupported: [ICONS.info, 'Not checked', 'This kind of signature is not checked here.'],
  };

  function signatureItem(s) {
    const [d, label, summary] = STATUS[s.status] ?? STATUS.invalid;
    const bad = s.status === 'invalid';
    const rows = [];
    if (s.signer) {
      rows.push(['Signer', s.signer.subject], ['Issuer', s.signer.issuer], ['Certificate valid', `${dayText(new Date(s.signer.notBefore))} – ${dayText(new Date(s.signer.notAfter))}${s.signer.expired ? ' (expired)' : s.signer.notYetValid ? ' (not yet valid)' : ''}`]);
      if (s.signer.keyUsage) rows.push(['Key usage', s.signer.keyUsage.join(', ')]);
      if (s.signer.extKeyUsage) rows.push(['Extended key usage', s.signer.extKeyUsage.join(', ')]);
      rows.push(['Key', s.signer.key], ['Fingerprint (SHA-256)', s.signer.fingerprint]);
    }
    if (s.claimedTime) rows.push(['Signing time (claimed by the signer)', dateText(s.claimedTime)]);
    if (s.reason) rows.push(['Reason', s.reason]);
    if (s.location) rows.push(['Location', s.location]);
    rows.push(['Type', `${s.kind}${s.hash ? `, ${s.hash}` : ''}`]);
    if (s.chain.length) rows.push(['Chain', s.chain.map((c) => c.commonName || c.subject).join(' → ') + (s.chainComplete ? '' : ' (incomplete: the issuer is not included)')]);
    rows.push(['Trust', s.trust === 'trusted' ? 'Chains to a root certificate you imported.' : s.trust === 'untrusted' ? 'Does not chain to any root certificate you imported.' : 'Not checked against a trust list. Import a root certificate to check.']);
    const extra = [];
    if (s.laterChanges?.kinds.length) extra.push(el('div', { class: 'sg-changes' }, el('p', { text: 'Changed after this signature:' }), el('ul', {}, s.laterChanges.kinds.map((k) => el('li', { text: `${describeChange(k.kind)} (${k.count})` })))));
    else if (s.laterChanges && !s.laterChanges.readable) extra.push(el('p', { class: 'sg-hint', text: 'Later revisions exist but could not be compared.' }));
    for (const p of s.problems) extra.push(el('p', { class: bad ? 'sg-error' : 'sg-warn' }, icon(ICONS.warn), el('span', { text: p })));
    return el('article', { class: `sg-sig${bad ? ' bad' : ''}` },
      el('div', { class: 'sg-sig-head' }, el('span', { class: 'sg-sig-icon' }, icon(d)), el('div', {}, el('strong', { text: `${label} — ${s.signer?.commonName || s.name || s.field}` }), el('p', { text: summary }))),
      el('dl', {}, rows.map(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])), ...extra);
  }

  function renderTrusted() {
    trustList.replaceChildren(...S.trusted.map((c, i) => el('li', {}, el('span', { text: `Trusted: ${c.subject.cn || c.subject.text}` }), el('button', { type: 'button', class: 'sg-btn small', text: 'Remove', onclick: () => { S.trusted.splice(i, 1); renderTrusted(); verify(S.signed ?? undefined); } }))));
  }

  /* Events */
  sourceFile.addEventListener('change', () => setSource('file'));
  sourceCard.addEventListener('change', () => setSource('card'));
  fileInput.addEventListener('change', () => { S.p12File = fileInput.files[0] ?? null; fileName.textContent = S.p12File?.name ?? 'No file chosen'; S.p12 = null; showCert(null); update(); if (S.p12File) pwInput.focus(); });
  cardSelect.addEventListener('change', () => { S.cardChoice = cardSelect.value; S.algorithm = null; showCardCert(); update(); });
  pinInput.addEventListener('input', update);
  algSelect.addEventListener('change', () => { S.algorithm = algSelect.value; });
  visibleRadio.addEventListener('change', () => { S.visible = true; update(); });
  invisibleRadio.addEventListener('change', () => { S.visible = false; update(); });
  imageInput.addEventListener('change', () => { if (imageInput.files[0]) loadImage(imageInput.files[0]); });
  trustInput.addEventListener('change', async () => {
    trustError.hidden = true;
    const f = trustInput.files[0]; trustInput.value = '';
    if (!f) return;
    try {
      const certs = readCertificates(new Uint8Array(await f.arrayBuffer()));
      for (const c of certs) if (!S.trusted.some((t) => t.subject.text === c.subject.text && t.serialHex === c.serialHex)) S.trusted.push(c);
      renderTrusted(); verify(S.signed ?? undefined);
    } catch { trustError.textContent = 'That file is not a certificate (DER or PEM).'; trustError.hidden = false; }
  });

  renderPage(); update(); verify(); loadCard();

  return {
    async refresh() {
      // The document may have changed in another mode: the signed bytes stay only while they are still the
      // working document, and the box goes if its page is gone.
      if (S.box && S.box.page >= pageCount()) S.box = null;
      const exact = S.signed ? (await ctx.originalBytes?.()) ?? null : null;
      if (S.signed && !sameBytes(exact, S.signed)) { S.signed = null; result.hidden = true; }
      renderPage(); update(); verify();
    },
    signedBytes: () => S.signed,
    unmount() {
      S.destroyed = true; S.p12 = null;
      window.removeEventListener('resize', onResize);
      container.replaceChildren();
    },
  };
}
