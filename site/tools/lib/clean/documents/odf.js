// OpenDocument cleaner: drops thumbnails, signatures and unlisted files, empties meta.xml, rewrites
// content, styles and settings, and keeps the manifest in step with the entries.
import { writeZip } from '../../zip/index.js';
import { parseXml, all, get, remove, serialize } from '../../metadata/documents/xml.js';
import { planOdf, sanitizeOdf, odfKind, ODF } from '../../metadata/documents/odf.js';
import { DOC_LIMITS, budget, readPart } from '../../metadata/documents/package.js';
import { utf8 } from '../../metadata/bytes.js';
import { TRACKED, refuse, copyEntry, cleanPicture, reopen, archiveRemovals } from './common.js';

const enc = new TextEncoder();
const REWRITES = { properties: 'Properties', fingerprints: 'Editing fingerprints', tracked: 'Tracked changes', printer: 'Printer settings', macros: 'Macros' };

export async function cleanOdf(zip, report, options) {
  if (report.blocks.some((b) => b.kind === 'Tracked changes') && !options.acceptChanges) refuse(TRACKED);
  const b = budget(DOC_LIMITS.maxReadBytes);
  const plan = await planOdf(zip, b, options);
  if (plan.encrypted) refuse('This document is password protected. It cannot be rewritten without the password, so it was left untouched.');
  if (!plan.manifest) refuse('The document has no readable manifest, so it was left untouched.');
  const out = new Map(); const removed = archiveRemovals(report);
  for (const [name, kind] of plan.remove) removed.push({ kind, container: name, bytes: zip.entries.find((e) => e.name === name)?.size ?? 0 });
  const images = budget(DOC_LIMITS.maxImageBytes);
  for (const e of zip.entries) {
    if (plan.remove.has(e.name) || e.directory) continue;
    if (/(^|\/)Pictures\//.test(e.name)) {
      const picture = await cleanPicture(zip, e, images);
      if (picture) { out.set(e.name, picture.data); removed.push(picture.removed); }
      continue;
    }
    const kind = odfKind(e.name);
    if (!kind) continue;
    const data = await readPart(zip, e, b);
    if (!data) refuse(`${e.name} is too large to clean safely, so the document was left untouched.`);
    let doc;
    try { doc = parseXml(utf8.decode(data)); } catch (error) { refuse(error.limit ? `${e.name} is too large to clean safely, so the document was left untouched.` : `${e.name} is not well-formed XML (${error.message}), so the document was left untouched.`); }
    const s = sanitizeOdf(doc, kind, plan);
    if (s.tracked && !options.acceptChanges) refuse(TRACKED);
    if (!s.changed) continue;
    out.set(e.name, serialize(doc));
    for (const [key, kindName] of Object.entries(REWRITES)) if (s[key]) removed.push({ kind: kindName, container: e.name, bytes: 0 });
    if (s.comments.length) removed.push({ kind: 'Comments', container: e.name, bytes: 0 });
    if (s.remote.length || s.paths.length) removed.push({ kind: 'Remote resource', container: e.name, bytes: 0 });
    if (s.sources.length) removed.push({ kind: 'Data source', container: e.name, bytes: 0 });
  }
  // The manifest lists exactly the entries that remain.
  const kept = new Set(zip.entries.filter((e) => !plan.remove.has(e.name)).map((e) => e.name));
  let manifestChanged = false;
  for (const fe of all(plan.manifest, (x) => x.ns === ODF.manifest && x.local === 'file-entry')) {
    const path = get(fe, 'full-path', ODF.manifest) ?? '';
    // A folder entry goes only when the cleaner emptied the folder.
    const gone = path.endsWith('/') ? path !== '/' && [...plan.remove.keys()].some((n) => n.startsWith(path)) && ![...kept].some((n) => n.startsWith(path)) : !kept.has(path);
    if (gone) { remove(fe); manifestChanged = true; }
  }
  if (manifestChanged) out.set('META-INF/manifest.xml', serialize(plan.manifest));
  const entries = [];
  const mimetype = zip.entries.find((e) => e.name === 'mimetype');
  entries.push({ name: 'mimetype', data: zip.bytes.slice(mimetype.dataOffset, mimetype.dataOffset + mimetype.compressedSize), method: 0 });
  for (const e of zip.entries) {
    if (e.name === 'mimetype' || plan.remove.has(e.name)) continue;
    const data = out.get(e.name);
    entries.push(data === undefined ? copyEntry(zip, e) : { name: e.name, data: typeof data === 'string' ? enc.encode(data) : data });
  }
  const result = await writeZip(entries);
  verify(result, out, plan.manifest);
  const keepMacros = !options.removeMacros && plan.macros.length > 0;
  const keptList = report.blocks.filter((x) => x.removable === false).map((x) => `${x.kind} (${x.container})${x.note ? `: ${x.note}` : ''}`);
  if (keepMacros) keptList.push('Macros (Basic): kept because removing them changes what the document does');
  return { data: result, removed, kept: keptList, allowed: (x) => keepMacros && x.kind === 'Macros' };
}

function verify(u8, out, manifest) {
  const zip = reopen(u8);
  if (zip.entries[0]?.name !== 'mimetype' || zip.entries[0].method !== 0) refuse('The cleaned file does not start with its type, so it was not produced.');
  const names = new Set(zip.entries.map((e) => e.name));
  for (const fe of all(manifest, (x) => x.ns === ODF.manifest && x.local === 'file-entry')) {
    const path = get(fe, 'full-path', ODF.manifest) ?? '';
    if (path !== '/' && !path.endsWith('/') && !names.has(path)) refuse('The cleaned manifest lists a missing file, so the file was not produced.');
  }
  for (const [name, data] of out) {
    if (typeof data !== 'string') continue;
    try { parseXml(data); } catch { refuse(`The rewritten ${name} is not well-formed, so the file was not produced.`); }
  }
}
