// Generic ZIP cleaner: the same files, stored the same way, without times, comments, extra fields,
// Unix ids, data around the archive or operating system leftovers.
import { writeZip } from '../../zip/index.js';
import { isLeftover } from '../../metadata/documents/package.js';
import { packageSignature } from '../../metadata/documents/archive.js';
import { refuse, copyEntry } from './common.js';

export async function cleanArchive(zip, report) {
  const signature = packageSignature(zip);
  if (signature) refuse('This is a signed package. Rewriting it would break the signature, so it was left untouched.');
  const removed = report.blocks.filter((b) => b.removable !== false && b.kind !== 'System leftovers').map((b) => ({ kind: b.kind, container: b.container ?? '', bytes: b.length }));
  const entries = [];
  for (const e of zip.entries) {
    if (isLeftover(e.name)) { removed.push({ kind: 'System leftovers', container: e.name, bytes: e.size }); continue; }
    entries.push(copyEntry(zip, e));
  }
  return { data: await writeZip(entries), removed, kept: [] };
}
