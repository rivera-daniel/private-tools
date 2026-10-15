// Office Open XML cleaner: drops metadata parts with their relationships and content-type entries,
// rewrites the parts that stay, and checks every relationship still resolves.
import { writeZip } from '../../zip/index.js';
import { parseXml, rootOf, elements, get, remove, serialize } from '../../metadata/documents/xml.js';
import { openPackage, planPackage, sanitizePart, partFamily, mayNeedRewrite, rewriteRels, relsPathFor } from '../../metadata/documents/opc.js';
import { DOC_LIMITS, budget, targetKind } from '../../metadata/documents/package.js';
import { TRACKED, refuse, copyEntry, cleanPicture, reopen, archiveRemovals } from './common.js';

const enc = new TextEncoder();

export async function cleanOoxml(zip, report, options) {
  if (report.blocks.some((b) => b.kind === 'Tracked changes') && !options.acceptChanges) refuse(TRACKED, 'acceptChanges');
  const pkg = await openPackage(zip, budget(DOC_LIMITS.maxReadBytes));
  if (pkg.errors.length) refuse('Some relationship parts could not be read, so the document was left untouched.');
  const plan = await planPackage(pkg, options);
  const out = new Map(); const removed = archiveRemovals(report);
  for (const [lower, kind] of plan.remove) {
    const e = pkg.entries.get(lower);
    if (e && !/(^|\/)_rels\//.test(lower)) removed.push({ kind, container: e.name, bytes: e.size });
  }
  for (const [lower, doc] of pkg.relsDocs) {
    if (plan.remove.has(lower)) continue;
    if (rewriteRels(doc, pkg, plan)) out.set(lower, serialize(doc));
  }
  for (const rel of plan.retarget.keys()) removed.push({ kind: targetKind(rel.target) === 'path' ? 'File path' : 'Remote resource', container: `${pkg.entries.get(rel.relsName)?.name}: ${rel.target}`, bytes: rel.target.length });
  for (const rel of plan.dropRels) if (rel.external) removed.push({ kind: 'Remote resource', container: `${pkg.entries.get(rel.relsName)?.name}: ${rel.target}`, bytes: rel.target.length });
  if (pkg.typesDoc) {
    let changed = false;
    for (const el of elements(rootOf(pkg.typesDoc))) {
      if (el.local !== 'Override') continue;
      const part = String(get(el, 'PartName') ?? '').replace(/^\//, '').toLowerCase();
      if (plan.remove.has(part)) { remove(el); changed = true; }
    }
    if (changed) out.set('[content_types].xml', serialize(pkg.typesDoc));
  }
  const images = budget(DOC_LIMITS.maxImageBytes);
  const relKind = new Map();
  for (const list of pkg.rels.values()) for (const rel of list) if (rel.part && !relKind.has(rel.part)) relKind.set(rel.part, rel.kind);
  for (const [lower, e] of pkg.entries) {
    if (plan.remove.has(lower) || out.has(lower) || lower === '[content_types].xml' || /(^|\/)_rels\/[^/]*\.rels$/.test(lower)) continue;
    if (/(^|\/)media\//.test(lower) || (relKind.get(lower) === 'image' && !/\.(xml|bin)$/.test(lower))) {
      const picture = await cleanPicture(zip, e, images);
      if (picture) { out.set(lower, picture.data); removed.push(picture.removed); }
      continue;
    }
    const fam = partFamily(pkg, lower, report.format);
    if (!fam) continue;
    const t = await pkg.read(lower);
    if (t === null) refuse(`${e.name} is too large to clean safely, so the document was left untouched.`);
    if (!mayNeedRewrite(t, fam, plan.removedIds.has(lower), plan, lower)) continue;
    let doc;
    try { doc = parseXml(t); } catch (error) { refuse(error.limit ? `${e.name} is too large to clean safely, so the document was left untouched.` : `${e.name} is not well-formed XML (${error.message}), so the document was left untouched.`); }
    const s = sanitizePart(doc, { name: lower, family: fam }, plan);
    if (s.tracked && !options.acceptChanges) refuse(TRACKED, 'acceptChanges');
    if (!s.changed) continue;
    out.set(lower, serialize(doc));
    removed.push(...rewrites(s, e.name));
  }
  // [Content_Types].xml stays first, as Office expects.
  const order = [...zip.entries].sort((a, b) => (b.name === '[Content_Types].xml') - (a.name === '[Content_Types].xml'));
  const entries = [];
  for (const e of order) {
    const lower = e.name.toLowerCase();
    if (plan.remove.has(lower)) continue;
    const data = out.get(lower);
    entries.push(data === undefined ? copyEntry(zip, e) : { name: e.name, data: typeof data === 'string' ? enc.encode(data) : data });
  }
  const result = await writeZip(entries);
  await verify(result, pkg, plan, out);
  const keepMacros = !options.removeMacros && plan.macros.size > 0;
  const kept = report.blocks.filter((b) => b.removable === false).map((b) => `${b.kind} (${b.container})${b.note ? `: ${b.note}` : ''}`);
  if (keepMacros) kept.push(...[...plan.macros].map((m) => `Macros (${pkg.entries.get(m)?.name}): kept because removing them changes what the document does`));
  return { data: result, removed, kept, allowed: (b) => keepMacros && b.kind === 'Macros', offer: keepMacros ? ['removeMacros'] : [] };
}

function rewrites(s, name) {
  const list = [];
  if (s.properties) list.push({ kind: 'Properties', container: name, bytes: 0 });
  if (s.fingerprints) list.push({ kind: 'Editing fingerprints', container: name, bytes: s.fingerprintBytes });
  if (s.tracked) list.push({ kind: 'Tracked changes', container: name, bytes: 0 });
  if (s.comments) list.push({ kind: 'Comments', container: name, bytes: 0 });
  if (s.docVars.length) list.push({ kind: 'Document variables', container: name, bytes: 0 });
  if (s.fields.length) list.push({ kind: 'Remote resource', container: name, bytes: 0 });
  if (s.paths.length) list.push({ kind: 'File path', container: name, bytes: 0 });
  if (s.people.length) list.push({ kind: 'People', container: name, bytes: 0 });
  if (s.refresh) list.push({ kind: 'Remote resource', container: name, bytes: 0 });
  return list;
}

// The cleaned package must read back, every rewritten part must be well-formed, and every relationship
// that resolved before must still resolve.
async function verify(u8, pkg, plan, out) {
  const zip = reopen(u8);
  const after = await openPackage(zip, budget(DOC_LIMITS.maxReadBytes));
  if (after.errors.length) refuse('The cleaned file has unreadable relationships, so it was not produced.');
  for (const [lower, data] of out) {
    if (typeof data !== 'string') continue;
    try { parseXml(data); } catch { refuse(`The rewritten ${lower} is not well-formed, so the file was not produced.`); }
  }
  for (const [source, list] of after.rels) {
    for (const rel of list) {
      if (rel.external || !rel.part) continue;
      const existed = pkg.entries.has(rel.part);
      if (existed && !after.entries.has(rel.part)) refuse(`A relationship in ${relsPathFor(source || '/')} points to a removed part, so the file was not produced.`);
    }
  }
}
