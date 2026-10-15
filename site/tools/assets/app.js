// Tool catalog: renders cards, search and category filters. Tool data is static.
const TOOLS = [
  { name: 'Image Inspector', copy: 'See every piece of metadata in an image: location, camera, people, software and AI provenance.', category: ['images', 'privacy'], art: 'inspector', status: 'Available', href: '/tools/image-inspector/' },
  { name: 'File Inspector', copy: 'See what any file reveals: its true type, hidden text, user names, build paths, signatures and metadata.', category: ['images', 'documents', 'privacy'], art: 'files', status: 'Available', href: '/tools/file-inspector/' },
  { name: 'Metadata Cleaner', copy: 'Remove location, names, hidden text and other sensitive metadata from photos, documents, PDFs, audio and video.', category: ['images', 'documents', 'privacy'], art: 'cleaner', status: 'Available', href: '/tools/metadata-cleaner/' },
  { name: 'Private OCR', copy: 'Extract text from images and scanned documents on your device.', category: ['images', 'documents'], art: 'ocr', status: 'Planned' },
  { name: 'Resume ATS Preview', copy: 'Preview the text an applicant tracking system extracts from your resume and spot formatting it cannot read.', category: ['documents', 'careers'], art: 'resume', status: 'Planned' },
  { name: 'Image Converter', copy: 'Convert, resize and compress images without uploading them.', category: ['images'], art: 'converter', status: 'Planned' },
  { name: 'PDF Privacy Cleaner', copy: 'Inspect document metadata and prepare a cleaner file to share.', category: ['documents', 'privacy'], art: 'pdf', status: 'Planned' },
  { name: 'Hash & Verify', copy: 'Calculate MD5, SHA-1, SHA-256 and SHA-512 hashes of any file and check them against an expected value.', category: ['forensics'], art: 'hash', status: 'Planned' },
  { name: 'Timestamp Decoder', copy: 'Read a raw number as every common timestamp format: Unix, Windows, Apple, Chrome, DOS and GPS time.', category: ['forensics'], art: 'clock', status: 'Planned' },
  { name: 'Email Header Analyzer', copy: 'Trace the servers an email passed through and check SPF, DKIM and DMARC results for signs of spoofing.', category: ['forensics', 'privacy'], art: 'mail', status: 'Planned' },
  { name: 'Link & QR Inspector', copy: 'Decode QR codes, unwrap redirect links, spot look-alike domains and remove tracking without opening the link.', category: ['privacy', 'forensics'], art: 'link', status: 'Planned' },
  { name: 'Hex Viewer', copy: 'View the raw bytes of a file with its metadata, hidden data and structures marked on them.', category: ['forensics'], art: 'hex', status: 'Planned' },
  { name: 'Windows Artifact Viewer', copy: 'Read shortcut files, Jump Lists, Prefetch, event logs, registry hives, thumbnail caches and browser history.', category: ['forensics'], art: 'artifacts', status: 'Planned' },
  { name: 'Packet Capture Viewer', copy: 'Explore PCAP files: hosts, DNS queries, visited sites, HTTP requests and files carried in the traffic.', category: ['forensics'], art: 'network', status: 'Planned' },
  { name: 'Certificate & Token Decoder', copy: 'Decode certificates, certificate requests and JSON Web Tokens, with expiry and weak-key warnings.', category: ['forensics'], art: 'certificate', status: 'Planned' },
  { name: 'Image Forensics', copy: 'Examine JPEG compression traces, resave clues, error levels and noise. Shows evidence, never a verdict.', category: ['images', 'forensics'], art: 'lens', status: 'Planned' },
];

// Artwork uses theme classes from site.css so it follows light and dark mode.
const corners = '<path class="art-red" d="M10 19v-8h8m28 0h8v8M10 45v8h8m28 0h8v-8" stroke-width="2.2"/>';
const page = '<path class="art-ink" d="M17 7h23l10 10v40H17zM40 7v11h10M23 28h19M23 35h19M23 42h14" stroke-width="1.8"/>';
const ART = {
  inspector: `${corners}<rect class="art-soft-fill" x="17" y="21" width="30" height="23" rx="3"/><path class="art-mid-fill" d="m19 41 8-11 6 7 5-8 7 12"/><circle class="art-mid-fill" cx="40" cy="25" r="2.3"/>`,
  files: `${corners}<path class="art-ink" d="M21 15h15l8 8v26H21zM36 15v8h8" stroke-width="1.8"/><path class="art-mid" d="M26 29h10M26 34h7" stroke-width="1.8"/><circle class="art-red" cx="39" cy="40" r="5.5" stroke-width="2.2"/><path class="art-red" d="m43 44 5 5" stroke-width="2.2"/>`,
  cleaner: `${page}<circle class="art-red-fill art-surface" cx="49" cy="49" r="11" stroke-width="2"/><path class="art-on-red" d="M44 49h10" stroke-width="1.7"/>`,
  ocr: `${corners}<path class="art-mid" d="M23 25v-4h19v4M32.5 21v23M27 44h11" stroke-width="4"/>`,
  resume: `${page}<path class="art-red" d="M47 55v-8m6 8V40m6 15V34" stroke-width="4"/>`,
  converter: '<g class="art-mid" stroke-width="1.6"><rect x="9" y="19" width="29" height="29" rx="3"/><path d="m12 43 8-10 6 8 4-4 5 7"/></g><rect class="art-paper-fill art-ink" x="31" y="9" width="27" height="28" rx="3" stroke-width="1.7"/><path class="art-mid-fill" d="m34 33 7-10 6 6 5-6 4 10"/><circle class="art-mid-fill" cx="49" cy="16" r="2"/><path class="art-red" d="M40 47a8 8 0 0 0-14-3l-2 3m0-5v5h5M25 53a8 8 0 0 0 14 2l2-3m0 5v-5h-5" stroke-width="2.4"/>',
  pdf: '<path class="art-ink" d="M16 7h24l10 10v39H16zM40 7v11h10" stroke-width="1.8"/><text class="art-ink-fill" x="21" y="40" font-family="Inter,sans-serif" font-size="13" font-weight="500">PDF</text><path class="art-red-fill art-surface" d="m49 40-9 4v8c0 5 5 8 9 10 4-2 9-5 9-10v-8z" stroke-width="2"/><path class="art-on-red-fill" d="m49 47-4 2v4l4 3 4-3v-4z"/>',
  hash: `${page}<path class="art-red" d="M40 40l-2 16m8-16-2 16m-7-11h12m-13 6h12" stroke-width="2.2"/>`,
  clock: '<circle class="art-ink" cx="32" cy="32" r="21" stroke-width="1.8"/><path class="art-mid" d="M32 15v3m0 28v3m17-17h-3m-28 0h-3" stroke-width="1.8"/><path class="art-red" d="M32 22v10l7 5" stroke-width="2.4"/>',
  mail: '<rect class="art-ink" x="12" y="16" width="34" height="24" rx="3" stroke-width="1.8"/><path class="art-ink" d="m13 18 16 12 16-12" stroke-width="1.8"/><path class="art-red" d="M24 48h14m4 0h4" stroke-width="2.4"/><circle class="art-red-fill" cx="50" cy="48" r="3.5"/>',
  link: '<g class="art-ink" stroke-width="1.8"><rect x="9" y="9" width="12" height="12" rx="2"/><rect x="9" y="27" width="12" height="12" rx="2"/><rect x="27" y="9" width="12" height="12" rx="2"/></g><path class="art-mid-fill" d="M13 13h4v4h-4zM13 31h4v4h-4zM31 13h4v4h-4z"/><path class="art-red" d="M36 44a6 6 0 0 1 0-8l4-4a6 6 0 0 1 8 8l-2 2m-6 6-4 4a6 6 0 0 1-8-8l2-2m4 4 8-8" stroke-width="2.4"/>',
  hex: '<rect class="art-ink" x="9" y="12" width="46" height="40" rx="3" stroke-width="1.8"/><path class="art-mid" d="M15 21h6m4 0h6m4 0h6m4 0h3M15 29h6m16 0h6m4 0h3M15 37h6m4 0h6m4 0h6m4 0h3M15 45h6m4 0h6" stroke-width="2.2"/><rect class="art-red" x="23" y="25.5" width="12" height="7" rx="2" stroke-width="2"/>',
  artifacts: '<rect class="art-ink" x="9" y="12" width="40" height="32" rx="3" stroke-width="1.8"/><path class="art-ink" d="M9 20h40" stroke-width="1.8"/><path class="art-mid" d="M15 28h14M15 34h10" stroke-width="1.8"/><circle class="art-red" cx="42" cy="42" r="7" stroke-width="2.4"/><path class="art-red" d="m47 47 6 6" stroke-width="2.4"/>',
  network: '<g class="art-ink" stroke-width="1.8"><circle cx="16" cy="18" r="5"/><circle cx="48" cy="18" r="5"/><circle cx="16" cy="46" r="5"/></g><path class="art-mid" d="M21 18h22M16 23v18M20 42l23-21" stroke-width="1.8"/><circle class="art-red-fill" cx="48" cy="46" r="6"/><path class="art-red" d="M21 46h21" stroke-width="2.2" stroke-dasharray="3 3"/>',
  certificate: '<rect class="art-ink" x="9" y="13" width="40" height="30" rx="3" stroke-width="1.8"/><path class="art-mid" d="M15 21h20M15 27h14M15 33h10" stroke-width="1.8"/><circle class="art-red-fill art-surface" cx="46" cy="42" r="8" stroke-width="2"/><path class="art-red" d="m42 49-2 8 6-3 6 3-2-8" stroke-width="2"/>',
  lens: '<rect class="art-ink" x="10" y="14" width="36" height="28" rx="3" stroke-width="1.8"/><path class="art-mid-fill" d="m13 39 9-12 7 8 5-6 9 10z"/><circle class="art-mid-fill" cx="36" cy="22" r="2.6"/><circle class="art-red-fill art-surface" cx="44" cy="42" r="8" stroke-width="2.4"/><circle class="art-on-red" cx="44" cy="42" r="3.5" stroke-width="1.8"/><path class="art-red" d="m50 48 5 5" stroke-width="2.8"/>',
};
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

const cards = document.getElementById('cards');
const search = document.getElementById('search');
const dialog = document.getElementById('tool-dialog');
let category = 'all';

function card(tool) {
  const el = document.createElement(tool.href ? 'a' : 'button');
  el.className = 'card';
  if (tool.href) el.href = tool.href; else el.type = 'button';
  const art = `<svg viewBox="0 0 64 64" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ART[tool.art]}</svg>`;
  el.innerHTML = `<span class="icon">${art}</span><span><h3></h3><p></p><span class="status"></span></span><span class="arrow">${ARROW}</span>`;
  el.querySelector('h3').textContent = tool.name;
  el.querySelector('p').textContent = tool.copy;
  const status = el.querySelector('.status');
  status.textContent = tool.status;
  status.classList.toggle('available', Boolean(tool.href));
  if (!tool.href) el.addEventListener('click', () => {
    document.getElementById('dialog-status').textContent = tool.status;
    document.getElementById('dialog-title').textContent = tool.name;
    document.getElementById('dialog-copy').textContent = tool.copy;
    dialog.showModal();
  });
  el.tool = tool;
  return el;
}

cards.append(...TOOLS.map(card));

function filter() {
  const query = search.value.toLowerCase().trim();
  let shown = 0;
  for (const el of cards.children) {
    const { tool } = el;
    const visible = (category === 'all' || tool.category.includes(category)) && `${tool.name} ${tool.copy}`.toLowerCase().includes(query);
    el.hidden = !visible;
    if (visible) shown++;
  }
  document.getElementById('empty').hidden = shown > 0;
}

search.addEventListener('input', filter);
for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    category = button.dataset.filter;
    for (const other of document.querySelectorAll('[data-filter]')) {
      other.classList.toggle('active', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    }
    filter();
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !dialog.open && document.activeElement.tagName !== 'INPUT') { event.preventDefault(); search.focus(); }
});
