// Tool catalog: available tools as cards, planned ones as compact roadmap rows grouped by job, plus search
// across everything. TOOLS is the single source of truth. stage is null for available tools.
const GROUPS = [
  { id: 'inspect', name: 'Inspect and clean', short: 'Inspect and clean' },
  { id: 'documents', name: 'Documents and PDF', short: 'Documents' },
  { id: 'images', name: 'Images', short: 'Images' },
  { id: 'files', name: 'Files and archives', short: 'Files' },
  { id: 'security', name: 'Security', short: 'Security' },
  { id: 'forensics', name: 'Forensics', short: 'Forensics' },
  { id: 'media', name: 'Media', short: 'Media' },
];
const STAGES = { Next: 'Next', Then: 'Soon', Later: 'Later', Last: 'Further out' };
const STAGE_ORDER = Object.keys(STAGES);
const TOOLS = [
  { name: 'Image Inspector', copy: 'See every piece of metadata in an image: location, camera, people, software and AI provenance.', group: 'inspect', stage: null, art: 'inspector', href: '/tools/image-inspector/' },
  { name: 'File Inspector', copy: 'See what any file reveals: its true type, hidden text, user names, build paths, signatures and metadata.', group: 'inspect', stage: null, art: 'files', href: '/tools/file-inspector/' },
  { name: 'Metadata Cleaner', copy: 'Remove location, names, hidden text and other sensitive metadata from photos, documents, PDFs, audio and video.', group: 'inspect', stage: null, art: 'cleaner', href: '/tools/metadata-cleaner/' },
  { name: 'Archiver', copy: 'Create and open ZIP, 7z, tar and gzip archives, extract RAR, xz, ISO and more, with AES-256 passwords and hidden data removed.', group: 'files', stage: null, art: 'archiver', href: '/tools/archiver/' },
  { name: 'PDF Editor', copy: 'Merge, split, reorder, compress and password-protect PDFs and redact them for real, all on your device.', group: 'documents', stage: null, art: 'pdfedit', href: '/tools/pdf-editor/' },
  { name: 'Photo Editor', copy: 'A full layered image editor in your browser: layers, masks, adjustment layers, selections, filters and PSD files.', group: 'images', stage: 'Last', art: 'photo', beta: true },
  { name: 'Audio Editor', copy: 'Record, cut, mix and clean up audio in your browser, without uploading your recordings.', group: 'media', stage: 'Last', art: 'wave' },
  { name: 'Office Viewer', copy: 'Open Word documents, spreadsheets and slide decks privately, without uploading them to an online office suite.', group: 'documents', stage: 'Next', art: 'office' },
  { name: 'QR Code Generator', copy: 'Make static QR codes that never expire and never route through a tracking server.', group: 'security', stage: 'Then', art: 'qr' },
  { name: 'Image Redactor', copy: 'Blur, pixelate or black out faces, plates and account numbers. The pixels are replaced, not covered.', group: 'images', stage: 'Next', art: 'imgredact' },
  { name: 'File Encryptor', copy: 'Encrypt any file with a passphrase or public key before you share it, in the open age format.', group: 'files', stage: 'Then', art: 'lock' },
  { name: 'Background Remover', copy: 'Cut out the subject of a photo with a model that runs on your device.', group: 'images', stage: 'Later', art: 'cutout' },
  { name: 'Data Anonymizer', copy: 'Find names, emails, phone numbers and IDs in CSV, Excel and JSON files, then mask, hash or remove them.', group: 'security', stage: 'Then', art: 'table' },
  { name: 'Developer Tools', copy: 'Format JSON and YAML, diff text, encode Base64 and URLs and test regular expressions without pasting secrets into a website.', group: 'security', stage: 'Then', art: 'code' },
  { name: 'Password Generator', copy: 'Generate strong passwords and passphrases with your browser’s secure random generator and check their strength.', group: 'security', stage: 'Then', art: 'key' },
  { name: 'PGP Tool', copy: 'Encrypt, decrypt, sign and verify messages and files with OpenPGP keys.', group: 'security', stage: 'Then', art: 'pgp' },
  { name: '2FA Backup Decoder', copy: 'Read authenticator export QR codes and otpauth links to move or back up your two-factor accounts.', group: 'security', stage: 'Then', art: 'otp' },
  { name: 'Private OCR', copy: 'Extract text from images and scanned documents on your device.', group: 'documents', stage: 'Next', art: 'ocr' },
  { name: 'Resume ATS Preview', copy: 'Preview the text an applicant tracking system extracts from your resume and spot formatting it cannot read.', group: 'documents', stage: 'Later', art: 'resume' },
  { name: 'Image Converter', copy: 'Convert HEIC to JPG and between other formats, resize and compress images without uploading them.', group: 'images', stage: 'Next', art: 'converter' },
  { name: 'Hash & Verify', copy: 'Calculate MD5, SHA-1, SHA-256 and SHA-512 hashes of any file and check them against an expected value.', group: 'forensics', stage: 'Later', art: 'hash' },
  { name: 'Timestamp Decoder', copy: 'Read a raw number as every common timestamp format: Unix, Windows, Apple, Chrome, DOS and GPS time.', group: 'forensics', stage: 'Later', art: 'clock' },
  { name: 'Email Header Analyzer', copy: 'Trace the servers an email passed through and check SPF, DKIM and DMARC results for signs of spoofing.', group: 'forensics', stage: 'Later', art: 'mail' },
  { name: 'Link & QR Inspector', copy: 'Decode QR codes, unwrap redirect links, spot look-alike domains and remove tracking without opening the link.', group: 'security', stage: 'Then', art: 'link' },
  { name: 'Hex Viewer', copy: 'View the raw bytes of a file with its metadata, hidden data and structures marked on them.', group: 'forensics', stage: 'Later', art: 'hex' },
  { name: 'Windows Artifact Viewer', copy: 'Read shortcut files, Jump Lists, Prefetch, event logs, registry hives, thumbnail caches and browser history.', group: 'forensics', stage: 'Later', art: 'artifacts' },
  { name: 'Packet Capture Viewer', copy: 'Explore PCAP files: hosts, DNS queries, visited sites, HTTP requests and files carried in the traffic.', group: 'forensics', stage: 'Later', art: 'network' },
  { name: 'Certificate & Token Decoder', copy: 'Decode certificates, certificate requests and JSON Web Tokens, with expiry and weak-key warnings.', group: 'forensics', stage: 'Later', art: 'certificate' },
  { name: 'PDF signing', copy: 'Sign PDFs with a certificate file and verify the signatures already in a document.', group: 'documents', stage: 'Next', art: 'sign', update: 'PDF Editor' },
  { name: 'Image Forensics', copy: 'Examine JPEG compression traces, resave clues, error levels and noise. Shows evidence, never a verdict.', group: 'forensics', stage: 'Later', art: 'lens' },
];

// Artwork uses theme classes from site.css so it follows light and dark mode.
const corners = '<path class="art-red" d="M10 19v-8h8m28 0h8v8M10 45v8h8m28 0h8v-8" stroke-width="2.2"/>';
const page = '<path class="art-ink" d="M17 7h23l10 10v40H17zM40 7v11h10M23 28h19M23 35h19M23 42h14" stroke-width="1.8"/>';
const ART = {
  inspector: `${corners}<rect class="art-soft-fill" x="17" y="21" width="30" height="23" rx="3"/><path class="art-mid-fill" d="m19 41 8-11 6 7 5-8 7 12"/><circle class="art-mid-fill" cx="40" cy="25" r="2.3"/>`,
  files: `${corners}<path class="art-ink" d="M21 15h15l8 8v26H21zM36 15v8h8" stroke-width="1.8"/><path class="art-mid" d="M26 29h10M26 34h7" stroke-width="1.8"/><circle class="art-red" cx="39" cy="40" r="5.5" stroke-width="2.2"/><path class="art-red" d="m43 44 5 5" stroke-width="2.2"/>`,
  cleaner: `${page}<circle class="art-red-fill art-surface" cx="49" cy="49" r="11" stroke-width="2"/><path class="art-on-red" d="M44 49h10" stroke-width="1.7"/>`,
  archiver: `${corners}<rect class="art-soft-fill" x="18" y="18" width="28" height="30" rx="3"/><path class="art-mid" d="M32 18v4m0 4v4m0 4v4" stroke-width="2.4"/><rect class="art-ink" x="28.5" y="38" width="7" height="6" rx="1.5" stroke-width="1.8"/>`,
  ocr: `${corners}<path class="art-mid" d="M23 25v-4h19v4M32.5 21v23M27 44h11" stroke-width="4"/>`,
  resume: `${page}<path class="art-red" d="M47 55v-8m6 8V40m6 15V34" stroke-width="4"/>`,
  converter: '<g class="art-mid" stroke-width="1.6"><rect x="9" y="19" width="29" height="29" rx="3"/><path d="m12 43 8-10 6 8 4-4 5 7"/></g><rect class="art-paper-fill art-ink" x="31" y="9" width="27" height="28" rx="3" stroke-width="1.7"/><path class="art-mid-fill" d="m34 33 7-10 6 6 5-6 4 10"/><circle class="art-mid-fill" cx="49" cy="16" r="2"/><path class="art-red" d="M40 47a8 8 0 0 0-14-3l-2 3m0-5v5h5M25 53a8 8 0 0 0 14 2l2-3m0 5v-5h-5" stroke-width="2.4"/>',
  pdfedit: '<path class="art-ink" d="M14 7h24l10 10v39H14zM38 7v11h10" stroke-width="1.8"/><path class="art-mid" d="M20 26h20M20 32h12" stroke-width="1.8"/><rect class="art-ink-fill" x="20" y="37" width="16" height="5" rx="1"/><path class="art-red" d="m50 30 6 6-16 16h-6v-6z" stroke-width="2.4"/>',
  photo: '<rect class="art-ink" x="8" y="12" width="40" height="32" rx="3" stroke-width="1.8"/><path class="art-mid-fill" d="m11 41 10-13 8 9 6-7 10 11z"/><circle class="art-mid-fill" cx="38" cy="21" r="3"/><path class="art-red" d="m44 54 12-12m-4-4 4 4-3 3" stroke-width="2.4"/><path class="art-red-fill" d="m42 56 3-6 3 3z"/>',
  qr: '<g class="art-ink" stroke-width="1.8"><rect x="10" y="10" width="16" height="16" rx="2"/><rect x="38" y="10" width="16" height="16" rx="2"/><rect x="10" y="38" width="16" height="16" rx="2"/></g><path class="art-ink-fill" d="M15 15h6v6h-6zM43 15h6v6h-6zM15 43h6v6h-6z"/><path class="art-red-fill" d="M38 38h5v5h-5zM48 38h6v5h-6zM38 48h5v6h-5zM44 44h5v5h-5zM49 49h5v5h-5z"/>',
  imgredact: '<rect class="art-ink" x="9" y="13" width="44" height="34" rx="3" stroke-width="1.8"/><path class="art-mid-fill" d="m12 44 11-14 8 9 6-7 13 12z"/><path class="art-red-fill" d="M33 18h6v6h-6zM39 24h6v6h-6zM33 30h6v-6h-6zM39 18h6v6h-6z" opacity=".95"/><path class="art-ink-fill" d="M14 50h20v4H14z"/>',
  lock: `${page}<rect class="art-red-fill art-surface" x="38" y="40" width="20" height="16" rx="3" stroke-width="2"/><path class="art-red" d="M42 40v-4a6 6 0 0 1 12 0v4" stroke-width="2.4"/>`,
  cutout: '<rect class="art-soft" x="9" y="11" width="46" height="42" rx="3" stroke-width="1.8" stroke-dasharray="3 3"/><circle class="art-ink" cx="32" cy="25" r="7" stroke-width="1.8"/><path class="art-ink" d="M18 50c2-9 8-14 14-14s12 5 14 14" stroke-width="1.8"/><path class="art-red" d="m44 14 8 8m0-8-8 8" stroke-width="2.4"/>',
  table: '<rect class="art-ink" x="9" y="12" width="46" height="38" rx="3" stroke-width="1.8"/><path class="art-ink" d="M9 22h46M9 32h46M9 41h46M25 12v38" stroke-width="1.5"/><path class="art-red-fill" d="M29 25h22v4H29zM29 35h16v4H29z"/>',
  code: '<rect class="art-ink" x="9" y="13" width="46" height="36" rx="3" stroke-width="1.8"/><path class="art-ink" d="M9 21h46" stroke-width="1.5"/><path class="art-mid" d="m22 29-6 6 6 6m20-12 6 6-6 6" stroke-width="2.2"/><path class="art-red" d="m35 27-6 16" stroke-width="2.4"/>',
  key: '<circle class="art-ink" cx="22" cy="32" r="10" stroke-width="1.8"/><circle class="art-ink-fill" cx="22" cy="32" r="3"/><path class="art-ink" d="M32 32h22m-6 0v7m-6-7v5" stroke-width="1.8"/><path class="art-red" d="M12 52h40" stroke-width="2.4" stroke-dasharray="5 4"/>',
  pgp: '<rect class="art-ink" x="10" y="17" width="34" height="24" rx="3" stroke-width="1.8"/><path class="art-ink" d="m11 19 16 12 16-12" stroke-width="1.8"/><circle class="art-red-fill art-surface" cx="46" cy="44" r="10" stroke-width="2"/><path class="art-on-red" d="m41 44 4 4 7-8" stroke-width="2"/>',
  otp: '<rect class="art-ink" x="18" y="7" width="28" height="50" rx="5" stroke-width="1.8"/><path class="art-ink" d="M28 51h8" stroke-width="1.8"/><path class="art-red" d="M24 28h4m4 0h4m4 0h0M24 28h16" stroke-width="3"/><path class="art-mid" d="M25 37h14" stroke-width="2" stroke-dasharray="2 3"/>',
  wave: '<path class="art-mid" d="M10 32h4m4-8v16m4-22v28m4-18v8m4-14v20m4-26v32m4-20v8m4-12v16m4-6v-4" stroke-width="2.2"/><path class="art-red" d="M41 10v44" stroke-width="2.4"/>',
  office: '<rect class="art-ink" x="10" y="10" width="26" height="34" rx="3" stroke-width="1.8"/><path class="art-mid" d="M15 19h16M15 25h16M15 31h10" stroke-width="1.8"/><rect class="art-paper-fill art-ink" x="28" y="22" width="26" height="32" rx="3" stroke-width="1.8"/><path class="art-ink" d="M28 31h26M28 40h26M37 22v32" stroke-width="1.4"/><path class="art-red-fill" d="M39 33h13v5H39z"/>',
  hash: `${page}<path class="art-red" d="M40 40l-2 16m8-16-2 16m-7-11h12m-13 6h12" stroke-width="2.2"/>`,
  clock: '<circle class="art-ink" cx="32" cy="32" r="21" stroke-width="1.8"/><path class="art-mid" d="M32 15v3m0 28v3m17-17h-3m-28 0h-3" stroke-width="1.8"/><path class="art-red" d="M32 22v10l7 5" stroke-width="2.4"/>',
  mail: '<rect class="art-ink" x="12" y="16" width="34" height="24" rx="3" stroke-width="1.8"/><path class="art-ink" d="m13 18 16 12 16-12" stroke-width="1.8"/><path class="art-red" d="M24 48h14m4 0h4" stroke-width="2.4"/><circle class="art-red-fill" cx="50" cy="48" r="3.5"/>',
  link: '<g class="art-ink" stroke-width="1.8"><rect x="9" y="9" width="12" height="12" rx="2"/><rect x="9" y="27" width="12" height="12" rx="2"/><rect x="27" y="9" width="12" height="12" rx="2"/></g><path class="art-mid-fill" d="M13 13h4v4h-4zM13 31h4v4h-4zM31 13h4v4h-4z"/><path class="art-red" d="M36 44a6 6 0 0 1 0-8l4-4a6 6 0 0 1 8 8l-2 2m-6 6-4 4a6 6 0 0 1-8-8l2-2m4 4 8-8" stroke-width="2.4"/>',
  hex: '<rect class="art-ink" x="9" y="12" width="46" height="40" rx="3" stroke-width="1.8"/><path class="art-mid" d="M15 21h6m4 0h6m4 0h6m4 0h3M15 29h6m16 0h6m4 0h3M15 37h6m4 0h6m4 0h6m4 0h3M15 45h6m4 0h6" stroke-width="2.2"/><rect class="art-red" x="23" y="25.5" width="12" height="7" rx="2" stroke-width="2"/>',
  artifacts: '<rect class="art-ink" x="9" y="12" width="40" height="32" rx="3" stroke-width="1.8"/><path class="art-ink" d="M9 20h40" stroke-width="1.8"/><path class="art-mid" d="M15 28h14M15 34h10" stroke-width="1.8"/><circle class="art-red" cx="42" cy="42" r="7" stroke-width="2.4"/><path class="art-red" d="m47 47 6 6" stroke-width="2.4"/>',
  network: '<g class="art-ink" stroke-width="1.8"><circle cx="16" cy="18" r="5"/><circle cx="48" cy="18" r="5"/><circle cx="16" cy="46" r="5"/></g><path class="art-mid" d="M21 18h22M16 23v18M20 42l23-21" stroke-width="1.8"/><circle class="art-red-fill" cx="48" cy="46" r="6"/><path class="art-red" d="M21 46h21" stroke-width="2.2" stroke-dasharray="3 3"/>',
  certificate: '<rect class="art-ink" x="9" y="13" width="40" height="30" rx="3" stroke-width="1.8"/><path class="art-mid" d="M15 21h20M15 27h14M15 33h10" stroke-width="1.8"/><circle class="art-red-fill art-surface" cx="46" cy="42" r="8" stroke-width="2"/><path class="art-red" d="m42 49-2 8 6-3 6 3-2-8" stroke-width="2"/>',
  sign: '<path class="art-ink" d="M14 7h24l10 10v39H14zM38 7v11h10" stroke-width="1.8"/><path class="art-mid" d="M20 26h20M20 32h14" stroke-width="1.8"/><path class="art-red" d="M19 47c3-6 6-6 6-2s-2 6 1 4 4-7 7-5-1 6 2 5 4-3 6-3" stroke-width="2.2"/><path class="art-ink" d="M19 53h22" stroke-width="1.5"/>',
  lens: '<rect class="art-ink" x="10" y="14" width="36" height="28" rx="3" stroke-width="1.8"/><path class="art-mid-fill" d="m13 39 9-12 7 8 5-6 9 10z"/><circle class="art-mid-fill" cx="36" cy="22" r="2.6"/><circle class="art-red-fill art-surface" cx="44" cy="42" r="8" stroke-width="2.4"/><circle class="art-on-red" cx="44" cy="42" r="3.5" stroke-width="1.8"/><path class="art-red" d="m50 48 5 5" stroke-width="2.8"/>',
};
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

const $ = (id) => document.getElementById(id);
const search = $('search');
const dialog = $('tool-dialog');
const bar = $('bar');
const sentinel = $('bar-sentinel');
const groupName = Object.fromEntries(GROUPS.map((g) => [g.id, g.name]));
const byStage = (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage);
const available = TOOLS.filter((t) => !t.stage);
const planned = TOOLS.filter((t) => t.stage).sort(byStage);
const plannedTools = planned.filter((t) => !t.update);
const usedGroups = GROUPS.filter((g) => TOOLS.some((t) => t.group === g.id));
let group = 'all';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const statusLabel = (tool) => (tool.stage ? `${STAGES[tool.stage]}${tool.beta ? ' · Beta' : ''}` : 'Available');
const describe = (tool) => (tool.update ? `Coming to the ${tool.update}. ${tool.copy}` : tool.copy);

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function icon(tool, className) {
  const el = node('span', className);
  el.innerHTML = `<svg viewBox="0 0 64 64" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ART[tool.art]}</svg>`;
  return el;
}

function arrow() {
  const el = node('span', 'cat-arrow');
  el.innerHTML = ARROW;
  return el;
}

// Available tool: a large card linking to the tool.
function card(tool) {
  const el = node('a', 'cat-card');
  el.href = tool.href;
  el.dataset.status = 'available';
  el.dataset.group = tool.group;
  const body = node('span', 'cat-card-body');
  body.append(node('span', 'cat-eyebrow', groupName[tool.group]), node('h3', '', tool.name), node('span', 'cat-card-copy', tool.copy));
  el.append(icon(tool, 'cat-icon'), body, arrow());
  return el;
}

// Compact row, used for the roadmap and for search results. Planned rows open the details dialog.
function row(tool, withGroup) {
  const el = node(tool.href ? 'a' : 'button', 'cat-row');
  el.dataset.status = tool.stage ? 'planned' : 'available';
  el.dataset.group = tool.group;
  if (tool.href) el.href = tool.href;
  else {
    el.type = 'button';
    el.setAttribute('aria-haspopup', 'dialog');
    el.addEventListener('click', () => openDialog(tool));
  }
  const body = node('span', 'cat-row-body');
  if (withGroup) body.append(node('span', 'cat-eyebrow', groupName[tool.group]));
  const tag = node('span', 'cat-tag', statusLabel(tool));
  if (!tool.stage) tag.classList.add('live');
  else if (tool.stage === 'Next') tag.classList.add('next');
  const top = node('span', 'cat-row-top');
  top.append(node('span', 'cat-row-title', tool.name), tag);
  body.append(top, node('span', 'cat-row-copy', describe(tool)));
  el.append(icon(tool, 'cat-row-icon'), body);
  el.tool = tool;
  return el;
}

function openDialog(tool) {
  $('dialog-status').textContent = [tool.update ? `${tool.update} update` : groupName[tool.group], statusLabel(tool)].join(' · ');
  $('dialog-title').textContent = tool.name;
  $('dialog-copy').textContent = tool.beta ? `${tool.copy} It arrives as a beta first.` : tool.copy;
  dialog.showModal();
}

// Static build: everything is created once and filtering only toggles hidden.
const chips = usedGroups.map((g) => ({ id: g.id, label: g.short }));
chips.unshift({ id: 'all', label: 'All tools' });
for (const chip of chips) {
  const button = node('button', '', chip.label);
  button.type = 'button';
  button.dataset.group = chip.id;
  button.setAttribute('aria-pressed', String(chip.id === group));
  button.addEventListener('click', () => setGroup(chip.id));
  $('groups').append(button);
}

const cards = available.map(card);
const more = node('a', 'cat-more');
more.href = '#roadmap';
more.append(node('span', 'cat-more-count', `${plannedTools.length} more on the way`), node('span', 'cat-more-link', 'See the roadmap'), arrow());
$('cards').append(...cards, more);

const roadmapGroups = usedGroups.filter((g) => planned.some((t) => t.group === g.id)).map((g) => {
  const items = planned.filter((t) => t.group === g.id);
  const section = node('section', 'cat-group');
  section.dataset.group = g.id;
  section.dataset.size = String(Math.min(items.length, 4));
  section.setAttribute('aria-labelledby', `group-${g.id}`);
  const heading = node('h3', '', g.name);
  heading.id = `group-${g.id}`;
  const count = node('span', 'cat-count', String(items.length));
  count.append(node('span', 'visually-hidden', ' planned'));
  heading.append(count);
  const rows = node('div', 'cat-rows');
  rows.append(...items.map((t) => row(t, false)));
  section.append(heading, rows);
  return section;
});
$('roadmap-groups').append(...roadmapGroups);

const results = [...available, ...planned].map((t) => row(t, true));
$('result-rows').append(...results);

function matches(tool, query) {
  return [tool.name, tool.copy, groupName[tool.group], statusLabel(tool), tool.update ?? ''].join(' ').toLowerCase().includes(query);
}

function render() {
  const query = search.value.trim().toLowerCase();
  const inGroup = (el) => group === 'all' || el.dataset.group === group;
  let status = '';
  if (query) {
    let shown = 0;
    for (const el of results) { el.hidden = !matches(el.tool, query); if (!el.hidden) shown++; }
    $('results-note').textContent = shown ? `${plural(shown, 'tool')} for “${search.value.trim()}”` : `No tools match “${search.value.trim()}”.`;
    status = shown ? `${plural(shown, 'tool')} found` : 'No tools found';
  } else {
    let live = 0;
    for (const el of cards) { el.hidden = !inGroup(el); if (!el.hidden) live++; }
    more.hidden = group !== 'all';
    let soon = 0;
    for (const section of roadmapGroups) {
      section.hidden = !inGroup(section);
      if (!section.hidden) soon += planned.filter((t) => t.group === section.dataset.group && !t.update).length;
    }
    $('available').hidden = live === 0;
    $('roadmap').hidden = !roadmapGroups.some((s) => !s.hidden);
    $('available-note').textContent = `${plural(live, 'tool')} you can use today. Everything runs in your browser.`;
    $('roadmap-note').textContent = group === 'all' ? `${plural(soon, 'tool')} in development, grouped by job. Select one for details.` : `${plural(soon, 'tool')} in development. Select one for details.`;
    if (group !== 'all') status = `${groupName[group]}: ${live} available, ${soon} planned`;
  }
  if (query) { $('available').hidden = true; $('roadmap').hidden = true; }
  $('results').hidden = !query;
  $('clear').hidden = !query;
  $('search-status').textContent = status;
}

// When the bar is stuck to the top, bring the start of the list back into view after the content changes.
function toListTop() {
  const top = sentinel.getBoundingClientRect().top;
  if (top < 0) window.scrollTo(0, top + window.scrollY);
}

function setGroup(id) {
  group = id;
  for (const button of $('groups').children) button.setAttribute('aria-pressed', String(button.dataset.group === id));
  if (search.value) search.value = '';
  render();
  toListTop();
}

search.addEventListener('input', () => { render(); toListTop(); });
$('clear').addEventListener('click', () => { search.value = ''; render(); search.focus(); });
search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && search.value) { event.preventDefault(); search.value = ''; render(); }
});
document.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (event.key === '/' && !dialog.open && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); search.focus(); }
});
// Roadmap links show the whole roadmap, whatever was filtered before.
document.addEventListener('click', (event) => {
  if (event.target.closest('a[href="#roadmap"]') && (group !== 'all' || search.value)) setGroup('all');
});
new IntersectionObserver(([entry]) => {
  bar.classList.toggle('stuck', !entry.isIntersecting && entry.boundingClientRect.top < 0);
}).observe(sentinel);

render();
