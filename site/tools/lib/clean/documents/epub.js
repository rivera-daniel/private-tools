// EPUB cleaner: personal and vendor metadata out of the package document, store records and reading
// positions dropped, remote resources removed from content documents and style sheets.
import { writeZip } from '../../zip/index.js';
import { parseXml, serialize } from '../../metadata/documents/xml.js';
import { planEpub, sanitizeOpf, sanitizeNcx, sanitizeContent, mayLoadRemote, contentParts } from '../../metadata/documents/epub.js';
import { DOC_LIMITS, budget, readPart } from '../../metadata/documents/package.js';
import { utf8 } from '../../metadata/bytes.js';
import { refuse, copyEntry, cleanPicture, reopen, archiveRemovals } from './common.js';

const enc = new TextEncoder();

export async function cleanEpub(zip, report) {
  const b = budget(DOC_LIMITS.maxReadBytes);
  const plan = await planEpub(zip, b);
  if (plan.drm) refuse('This book is DRM protected. It cannot be rewritten, so it was left untouched.');
  if (!plan.opf) refuse('The book has no readable package document, so it was left untouched.');
  const out = new Map(); const removed = archiveRemovals(report);
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  for (const [name, kind] of plan.remove) removed.push({ kind, container: name, bytes: byName.get(name)?.size ?? 0 });
  const s = sanitizeOpf(plan.opf);
  if (s.changed) {
    out.set(plan.opfPath, serialize(plan.opf));
    if (s.fields.length) removed.push({ kind: 'Properties', container: plan.opfPath, bytes: 0 });
    if (s.remote.length) removed.push({ kind: 'Remote resource', container: plan.opfPath, bytes: 0 });
  }
  const images = budget(DOC_LIMITS.maxImageBytes);
  for (const { e, kind } of contentParts(zip, plan)) {
    if (kind === 'image') {
      const picture = await cleanPicture(zip, e, images);
      if (picture) { out.set(e.name, picture.data); removed.push(picture.removed); }
      continue;
    }
    const data = await readPart(zip, e, b);
    if (!data) refuse(`${e.name} is too large to clean safely, so the book was left untouched.`);
    const t = utf8.decode(data);
    if (kind === 'ncx') {
      let doc;
      try { doc = parseXml(t); } catch (error) { refuse(`${e.name} is not well-formed (${error.message}), so the book was left untouched.`); }
      if (sanitizeNcx(doc).changed) { out.set(e.name, serialize(doc)); removed.push({ kind: 'Properties', container: e.name, bytes: 0 }); }
      continue;
    }
    if (!mayLoadRemote(t)) continue;
    let c;
    try { c = sanitizeContent(t, kind); } catch (error) { refuse(`${e.name} is not well-formed (${error.message}), so the book was left untouched.`); }
    if (c.out === null) continue;
    out.set(e.name, c.out);
    removed.push({ kind: 'Remote resource', container: e.name, bytes: 0 });
  }
  const mimetype = zip.entries.find((e) => e.name === 'mimetype');
  const entries = [{ name: 'mimetype', data: zip.bytes.slice(mimetype.dataOffset, mimetype.dataOffset + mimetype.compressedSize), method: 0 }];
  for (const e of zip.entries) {
    if (e.name === 'mimetype' || plan.remove.has(e.name)) continue;
    const data = out.get(e.name);
    entries.push(data === undefined ? copyEntry(zip, e) : { name: e.name, data: typeof data === 'string' ? enc.encode(data) : data });
  }
  const result = await writeZip(entries);
  const check = reopen(result);
  if (check.entries[0]?.name !== 'mimetype' || check.entries[0].method !== 0) refuse('The cleaned book does not start with its type, so it was not produced.');
  for (const [name, data] of out) {
    if (typeof data !== 'string' || /\.css$/i.test(name)) continue;
    try { parseXml(data, { lenient: true }); } catch { refuse(`The rewritten ${name} is not well-formed, so the book was not produced.`); }
  }
  return { data: result, removed, kept: report.blocks.filter((x) => x.removable === false).map((x) => `${x.kind} (${x.container})`) };
}
