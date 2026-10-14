// SVG is text. Read it with linear scans only; never render or execute it here.
import { LIMITS, utf8, clean, fmtBytes } from '../bytes.js';
import { parseXmp, attributes, decodeEntities } from '../xmp.js';
import { AI_TOOL_PATTERN } from '../signals.js';

const EDITOR_NS = { inkscape: 'Inkscape', sodipodi: 'Inkscape (Sodipodi)', sketch: 'Sketch', figma: 'Figma', 'xmlns:i': 'Adobe Illustrator', serif: 'Affinity', bx: 'Boxy SVG', vectornator: 'Vectornator' };
const PATH_ATTRS = /^(sodipodi:docname|sodipodi:absref|inkscape:export-filename|inkscape:export-xdpi|sodipodi:docbase|xlink:href|href)$/;

export async function parseSvg(b, r) {
  r.format = 'SVG';
  let text = utf8.decode(b.u8);
  if (text.length > LIMITS.maxSvgChars) { r.warn('SVG is larger than 10 MB. Only the first 10 MB was read.'); text = text.slice(0, LIMITS.maxSvgChars); }
  const src = 'SVG';
  let i = 0; const n = text.length; let scripts = 0; let handlers = 0; let foreign = 0; let images = 0; let dataImages = 0;
  const external = new Set(); const editors = new Set(); const comments = []; const paths = [];
  let rootSeen = false; let styleClose = 0; let capture = null; let captureStart = 0; let metadataStart = -1;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4); const body = text.slice(lt + 4, e < 0 ? n : e).trim();
      if (body && comments.length < 50) comments.push(body.slice(0, 2000));
      i = e < 0 ? n : e + 3; continue;
    }
    if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt + 9); i = e < 0 ? n : e + 3; continue; }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') { const e = text.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    const gt = text.indexOf('>', lt);
    if (gt < 0) break;
    const tag = text.slice(lt + 1, gt);
    i = gt + 1;
    const closing = tag[0] === '/';
    const name = (/^\/?([^\s/>]+)/.exec(tag)?.[1] ?? '').toLowerCase();
    const local = name.split(':').pop();
    if (closing) {
      if (capture && local === capture) { const body = clean(decodeEntities(text.slice(captureStart, lt).replace(/<[^>]{0,1000}>/g, ''))); if (body) { r.field(src, capture === 'title' ? 'Title' : 'Description', body); r.add('Description', capture === 'title' ? 'SVG title' : 'SVG description', body); } capture = null; }
      if (local === 'metadata' && metadataStart >= 0) { parseXmp(text.slice(metadataStart, lt), r); r.block('XMP', undefined, lt - metadataStart, { container: 'svg metadata element' }); metadataStart = -1; }
      continue;
    }
    if (local === 'script') scripts++;
    if (local === 'foreignobject') foreign++;
    if (local === 'title' || local === 'desc') { capture = local; captureStart = gt + 1; }
    if (local === 'metadata') metadataStart = gt + 1;
    for (const [key, raw] of attributes(tag)) {
      const value = decodeEntities(raw);
      const k = key.toLowerCase();
      if (/^on[a-z]+$/.test(k)) handlers++;
      if (k.startsWith('xmlns:')) { const ns = k.slice(6); if (EDITOR_NS[ns]) editors.add(EDITOR_NS[ns]); }
      if (k === 'xmlns:i' || k === 'xmlns:x') editors.add('Adobe Illustrator');
      if ((k === 'href' || k === 'xlink:href')) {
        if (local === 'image') { images++; if (value.startsWith('data:')) dataImages++; }
        if (/^(https?:)?\/\//i.test(value) || /^file:/i.test(value)) external.add(value.slice(0, 300));
      } else if (/url\(\s*['"]?(https?:|\/\/)/i.test(value)) external.add(value.slice(0, 300));
      if (PATH_ATTRS.test(k) && k !== 'href' && k !== 'xlink:href' && k !== 'inkscape:export-xdpi') paths.push(`${key}: ${value}`);
      if (!rootSeen && local === 'svg' && ['width', 'height', 'viewbox', 'version'].includes(k)) r.field(src, key, value);
      if (k.startsWith('inkscape:') || k.startsWith('sodipodi:')) r.field('SVG editor data', key, value, { flag: PATH_ATTRS.test(k) ? 'privacy' : undefined });
    }
    if (local === 'svg') rootSeen = true;
    if (local === 'style') {
      // One forward search per closing tag keeps unterminated <style> floods linear.
      if (styleClose !== -1 && styleClose < gt) styleClose = text.indexOf('</style', gt);
      if (styleClose > gt) {
        const css = text.slice(gt + 1, styleClose);
        for (const m of css.matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^'")\s]{1,300})/gi)) external.add(m[1]);
        for (const m of css.matchAll(/@import\s+(?:url\()?['"]?([^'");\s]{1,300})/gi)) external.add(m[1]);
        i = styleClose;
      }
    }
  }
  for (const c of comments) {
    r.field('SVG comments', 'Comment', c); r.add('Comments', 'SVG comment', c);
    if (/Generator:\s*(.+?)(?:\s*-->|$)/i.test(c)) r.add('Software', 'Generator', c.match(/Generator:\s*(.+)/i)[1].slice(0, 200));
    if (AI_TOOL_PATTERN.test(c) && /generat|created|made/i.test(c)) r.signal('clue', 'AI tool named in metadata', c.slice(0, 160), 'SVG comment');
  }
  if (comments.length) r.block('Comment', undefined, comments.reduce((s, c) => s + c.length, 0), { container: 'SVG comments' });
  if (editors.size) { r.field(src, 'Editor namespaces', [...editors].join(', ')); r.add('Software', 'Editor', [...editors].join(', ')); }
  r.field(src, 'Scripts', String(scripts));
  r.field(src, 'Event handler attributes', String(handlers));
  if (foreign) r.field(src, 'foreignObject elements', String(foreign));
  if (images) r.field(src, 'Embedded raster images', `${images}${dataImages ? ` (${dataImages} inline)` : ''}. Their own metadata is not inspected.`);
  if (scripts || handlers) r.signal('privacy', 'Active content in SVG', `${scripts} script element${scripts === 1 ? '' : 's'} and ${handlers} event handler${handlers === 1 ? '' : 's'}. When opened directly in a browser, this SVG can run code.`, 'SVG', 'active content');
  if (external.size) {
    [...external].slice(0, 50).forEach((u, k) => r.field('SVG external references', `Reference ${k + 1}`, u, { flag: 'privacy' }));
    r.signal('privacy', 'External references', `${external.size} external URL${external.size === 1 ? '' : 's'}. Opening the SVG can contact ${external.size === 1 ? 'that server' : 'those servers'}, revealing when and where it was viewed.`, 'SVG', 'external references');
  }
  if (paths.length) {
    paths.slice(0, 20).forEach((p) => r.add('File', 'Editor path', p, { flag: 'privacy' }));
    r.signal('privacy', 'File path stored', `The editor saved file names or paths from the computer that made it: ${paths[0].slice(0, 160)}.`, 'SVG editor data', 'a file path');
  }
  const w = r.sources.get(src)?.find((f) => f.key === 'width')?.value; const h = r.sources.get(src)?.find((f) => f.key === 'height')?.value;
  const vb = r.sources.get(src)?.find((f) => f.key.toLowerCase() === 'viewbox')?.value?.trim().split(/[\s,]+/).map(Number);
  if (w && h && /^\d/.test(w) && /^\d/.test(h) && !/%$/.test(w)) { r.width = parseFloat(w); r.height = parseFloat(h); }
  else if (vb?.length === 4 && vb.every(Number.isFinite)) { r.width = vb[2]; r.height = vb[3]; }
  r.struct('SVG document', 0, b.length, fmtBytes(b.length));
}
