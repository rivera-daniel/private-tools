// Tool catalog: renders cards, search and category filters. Tool data is static.
const TOOLS = [
  { name: 'Image Inspector', copy: 'See every piece of metadata in an image: location, camera, people, software and AI provenance.', category: ['images', 'privacy'], art: 'inspector', status: 'Available', href: '/tools/image-inspector/' },
  { name: 'Metadata Cleaner', copy: 'Remove location, camera details and other sensitive metadata from images.', category: ['images', 'privacy'], art: 'cleaner', status: 'Available', href: '/tools/metadata-cleaner/' },
  { name: 'Archiver', copy: 'Create and open ZIP, tar and gzip archives, with AES-256 passwords and hidden data removed.', category: ['documents', 'privacy'], art: 'archiver', status: 'Available', href: '/tools/archiver/' },
  { name: 'Private OCR', copy: 'Extract text from images and scanned documents on your device.', category: ['images', 'documents'], art: 'ocr', status: 'Planned' },
  { name: 'Resume ATS Preview', copy: 'Preview the text an applicant tracking system extracts from your resume and spot formatting it cannot read.', category: ['documents', 'careers'], art: 'resume', status: 'Planned' },
  { name: 'Image Converter', copy: 'Convert, resize and compress images without uploading them.', category: ['images'], art: 'converter', status: 'Planned' },
  { name: 'PDF Privacy Cleaner', copy: 'Inspect document metadata and prepare a cleaner file to share.', category: ['documents', 'privacy'], art: 'pdf', status: 'Planned' },
];

// Artwork uses theme classes from site.css so it follows light and dark mode.
const corners = '<path class="art-red" d="M10 19v-8h8m28 0h8v8M10 45v8h8m28 0h8v-8" stroke-width="2.2"/>';
const page = '<path class="art-ink" d="M17 7h23l10 10v40H17zM40 7v11h10M23 28h19M23 35h19M23 42h14" stroke-width="1.8"/>';
const ART = {
  inspector: `${corners}<rect class="art-soft-fill" x="17" y="21" width="30" height="23" rx="3"/><path class="art-mid-fill" d="m19 41 8-11 6 7 5-8 7 12"/><circle class="art-mid-fill" cx="40" cy="25" r="2.3"/>`,
  cleaner: `${page}<circle class="art-red-fill art-surface" cx="49" cy="49" r="11" stroke-width="2"/><path class="art-on-red" d="M44 49h10" stroke-width="1.7"/>`,
  archiver: `${corners}<rect class="art-soft-fill" x="18" y="18" width="28" height="30" rx="3"/><path class="art-mid" d="M32 18v4m0 4v4m0 4v4" stroke-width="2.4"/><rect class="art-ink" x="28.5" y="38" width="7" height="6" rx="1.5" stroke-width="1.8"/>`,
  ocr: `${corners}<path class="art-mid" d="M23 25v-4h19v4M32.5 21v23M27 44h11" stroke-width="4"/>`,
  resume: `${page}<path class="art-red" d="M47 55v-8m6 8V40m6 15V34" stroke-width="4"/>`,
  converter: '<g class="art-mid" stroke-width="1.6"><rect x="9" y="19" width="29" height="29" rx="3"/><path d="m12 43 8-10 6 8 4-4 5 7"/></g><rect class="art-paper-fill art-ink" x="31" y="9" width="27" height="28" rx="3" stroke-width="1.7"/><path class="art-mid-fill" d="m34 33 7-10 6 6 5-6 4 10"/><circle class="art-mid-fill" cx="49" cy="16" r="2"/><path class="art-red" d="M40 47a8 8 0 0 0-14-3l-2 3m0-5v5h5M25 53a8 8 0 0 0 14 2l2-3m0 5v-5h-5" stroke-width="2.4"/>',
  pdf: '<path class="art-ink" d="M16 7h24l10 10v39H16zM40 7v11h10" stroke-width="1.8"/><text class="art-ink-fill" x="21" y="40" font-family="Inter,sans-serif" font-size="13" font-weight="500">PDF</text><path class="art-red-fill art-surface" d="m49 40-9 4v8c0 5 5 8 9 10 4-2 9-5 9-10v-8z" stroke-width="2"/><path class="art-on-red-fill" d="m49 47-4 2v4l4 3 4-3v-4z"/>',
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
