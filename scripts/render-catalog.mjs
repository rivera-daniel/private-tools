// Regenerate crawlable catalog and roadmap HTML after changing the shared registry.
// Usage: node scripts/render-catalog.mjs. Does not fetch or upload anything.
import { writeFile, mkdir, access } from 'node:fs/promises';
import { illustration, ILLUSTRATION_KINDS } from '../site/assets/catalog-illustrations.js';
import { GROUPS, STAGES, TOOLS, DETAILS } from '../site/assets/catalog-data.js';
import { ARROW } from '../site/assets/catalog-icons.js';
const root = new URL('../site/', import.meta.url);
const escape = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = (t) => t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
const group = (t) => GROUPS.find((g) => g.id === t.group)?.name ?? t.group;
const icon = (t) => illustration(t.art, `roadmap-${slug(t)}-`);
const mark = '<svg viewBox="0 0 44 30" aria-hidden="true"><path d="M14 4h10L10 25H0zM30 0h12L26 27H14z" fill="currentColor"/></svg>';
const live = TOOLS.filter((t) => !t.stage);
// Fail before writing either page if a released card is incomplete.
const names = new Set(), slugs = new Set();
for (const t of TOOLS) {
 if (names.has(t.name) || slugs.has(slug(t))) throw new Error(`Duplicate tool name or slug: ${t.name}`);
 names.add(t.name); slugs.add(slug(t));
 if (!GROUPS.some(g => g.id === t.group) || !t.copy?.trim()) throw new Error(`Missing category or description: ${t.name}`);
 if (!ILLUSTRATION_KINDS.includes(t.art)) throw new Error(`Missing illustration: ${t.name}`);
 if (t.stage && !(t.stage in STAGES)) throw new Error(`Unknown roadmap stage: ${t.name}`);
 if (!t.stage) {
  if (!DETAILS[t.name]?.trim() || !ILLUSTRATION_KINDS.includes(t.art)) throw new Error(`Released tool needs details and registered illustration: ${t.name}`);
  if (!/^\/[a-z0-9-]+\/$/.test(t.href ?? '')) throw new Error(`Invalid local tool URL: ${t.name}`);
  await access(new URL(`${t.href.slice('/'.length)}index.html`, root));
 }
}
const stages = Object.keys(STAGES);
const planned = TOOLS.filter((t) => t.stage).sort((a,b) => stages.indexOf(a.stage)-stages.indexOf(b.stage));
const options = `<option value="all">All categories</option>${GROUPS.filter((g) => TOOLS.some((t) => t.group === g.id)).map((g) => `<option value="${escape(g.id)}">${escape(g.short)}</option>`).join('')}`;
function card(t) {
  return `<article class="cat-card" data-tool="${escape(t.name)}" data-group="${escape(t.group)}" id="${slug(t)}">
  <a class="cat-card-link" href="${escape(t.href)}">
    <div class="tool-body">${illustration(t.art,`card-${slug(t)}-`)}<div class="tool-heading"><h3>${escape(t.name)}</h3></div>
      <p class="tool-copy">${escape(t.copy)}</p><p class="tool-details">${escape(DETAILS[t.name] ?? '')}</p>
      <span class="tool-action">Open tool <span aria-hidden="true">↗</span></span>
    </div>
  </a>
</article>`;
}
function plannedRow(t) {
 return `<button type="button" class="cat-row" data-tool="${escape(t.name)}" data-group="${escape(t.group)}" aria-haspopup="dialog">${icon(t)}<span class="cat-row-body"><span class="cat-row-top"><span class="cat-row-title">${escape(t.name)}</span><span class="cat-tag">${escape(STAGES[t.stage])}${t.beta ? ' · Beta' : ''}</span></span><span class="cat-row-copy">${escape(t.copy)}</span></span></button>`;
}
const teaser = `<a class="cat-teaser" href="/roadmap/"><span class="teaser-arrow" aria-hidden="true">${ARROW}</span><h3>More tools.<br>Same privacy.</h3><p>${planned.length} more tools on the roadmap, from private OCR to file encryption.</p><span class="tool-action">Explore the roadmap <span aria-hidden="true">↗</span></span></a>`;
function page(roadmap = false) {
 const title=roadmap?'Roadmap — Private Tools':'Private Tools — Private browser tools for your files';
 const description=roadmap?'Explore the Private Tools roadmap: upcoming browser tools for images, documents, privacy and file forensics.':'Inspect image and file metadata, remove hidden personal data, create encrypted archives, and view, edit or redact PDFs. Private browser tools with no file uploads or accounts.';
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="description" content="${description}"><meta name="color-scheme" content="light dark"><title>${title}</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="preload" href="/assets/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/catalog.css"><script src="/assets/theme.js"></script></head>
<body class="catalog" data-page="${roadmap?'roadmap':'catalog'}">
<header class="header wrap"><a class="brand" href="/">${mark}Private Tools</a><nav aria-label="Primary"><a href="${roadmap?'/':'#available'}">Tools</a><a href="/roadmap/"${roadmap?' aria-current="page"':''}>Roadmap</a><a href="https://github.com/rivera-daniel/private-tools">Source</a><button type="button" class="icon-button" id="theme-toggle" aria-label="Change theme"></button></nav></header>
<main>
<section class="cat-intro wrap" aria-labelledby="catalog-title"><div class="hero-copy"><h1 id="catalog-title">${roadmap?'A little more.<br><span>On the way.</span>':'Your files.<br><span>Your tools.</span>'}</h1><p>${roadmap?'A growing collection, built around your files.':'On your device. No uploads. No accounts.'}</p><div class="hero-actions"><a class="hero-primary" href="#available">${roadmap?'Explore the roadmap':'Explore tools'} <span aria-hidden="true">↓</span></a><a class="hero-secondary" href="${roadmap?'/':'/roadmap/'}">${roadmap?'Back to the tools':'See the roadmap'} <span aria-hidden="true">→</span></a></div></div>
${roadmap?'':`<nav class="app-shelf" aria-label="Tools in this collection">${live.slice(0,5).map((t)=>`<a href="#${slug(t)}">${illustration(t.art,`hero-${slug(t)}-`)}<span>${escape(t.name)}</span></a>`).join('')}</nav>`}</section>
<div class="cat-body"><div class="cat-sentinel" id="bar-sentinel"></div><div class="cat-bar" id="bar"><div class="cat-bar-inner wrap"><div class="cat-head"><h2 id="available-title">${roadmap?'On the roadmap':'Toolkit'}</h2><p id="available-note">${roadmap?planned.length+' planned':live.length+' available'}</p></div><div class="catalog-controls"><label class="cat-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><span class="visually-hidden">Search all tools, including planned ones</span><input type="search" id="search" placeholder="Search tools" autocomplete="off" aria-controls="available results"><button type="button" class="cat-clear" id="clear" aria-label="Clear search" hidden>×</button></label><select class="cat-group-select" id="group-select" aria-label="Filter tools by category">${options}</select></div></div><p class="visually-hidden" id="search-status" role="status" aria-live="polite"></p></div>
<section class="cat-section wrap" id="available" aria-labelledby="available-title"><div class="${roadmap?'cat-rows':'cat-grid'}" id="cards">${roadmap?planned.map(plannedRow).join('\n'):live.map(card).join('\n')+teaser}</div><p id="catalog-empty" class="catalog-empty" hidden>${roadmap?'No planned tools in this category. <a href="/">Browse the available tools.</a>':'No available tools in this category yet. <a href="/roadmap/">See what’s coming on the roadmap.</a>'}</p></section>
<section class="cat-section wrap" id="results" aria-labelledby="results-title" hidden><div class="results-heading"><h2 id="results-title">Search results</h2><p id="results-note"></p></div><div class="cat-rows" id="result-rows"></div></section></div>
</main>
<footer class="catalog-footer wrap"><div><a class="brand" href="/">${mark}Private Tools</a><p>Your files stay yours.</p></div><nav aria-label="Footer"><a href="https://github.com/rivera-daniel/private-tools#privacy-model">Privacy</a><a href="https://github.com/rivera-daniel/private-tools">GitHub</a><span>© 2026 Daniel Rivera</span></nav></footer>
<dialog id="tool-dialog" aria-labelledby="dialog-title"><form method="dialog"><button class="close" aria-label="Close">×</button></form><p class="eyebrow" id="dialog-status"></p><h2 id="dialog-title"></h2><p id="dialog-copy"></p><p>Not available yet. Follow its progress on the <a href="/roadmap/">roadmap</a>.</p><form method="dialog"><button class="button">Back to tools</button></form></dialog><script type="module" src="/assets/app.js"></script></body></html>\n`;
}
await mkdir(new URL('roadmap/',root),{recursive:true});
await writeFile(new URL('index.html',root),page());
await writeFile(new URL('roadmap/index.html',root),page(true));
console.log(`Rendered ${live.length} available tools and ${planned.length} planned tools with static descriptions.`);
