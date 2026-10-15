// Writing extracted files into a folder through the File System Access API. Nothing that was in the folder
// before is ever removed: every file and folder created here is recorded in a list (created), and cleanup
// after a failure touches only entries on that list.
import { WritableSink, blobChunks } from './streams.js';
import { freshFolderName, keepBothName, nameKey } from './destination.js';

const missing = (error) => error?.name === 'NotFoundError';

// The handle named name in dir, or null when there is none. kind: 'file' or 'directory'.
export async function lookup(dir, name, kind) {
  try { return kind === 'file' ? await dir.getFileHandle(name) : await dir.getDirectoryHandle(name); } catch (error) { if (missing(error)) return null; throw error; }
}

// Creates a file or folder that does not exist yet and records it. Refuses rather than open an existing one.
export async function createNew(dir, name, kind, created) {
  if (await taken(dir, name)) return null;
  const handle = kind === 'file' ? await dir.getFileHandle(name, { create: true }) : await dir.getDirectoryHandle(name, { create: true });
  created.push({ dir, name, kind });
  return handle;
}

export async function removeCreated(created, item) {
  const at = created.indexOf(item); if (at < 0) return;
  created.splice(at, 1);
  // A folder is removed only while it is empty.
  await item.dir.removeEntry(item.name).catch(() => {});
}

// Name keys and kinds of everything in the folders an extraction would write into, keyed by path on disk.
export async function scan(dir, tree, path = '', out = new Map()) {
  const names = new Map(); const subfolders = [];
  for await (const [name, handle] of dir.entries()) {
    names.set(nameKey(name), { name, kind: handle.kind });
    if (handle.kind === 'directory' && tree.has(nameKey(name))) subfolders.push([name, handle, tree.get(nameKey(name))]);
  }
  out.set(path, names);
  for (const [name, handle, subtree] of subfolders) await scan(handle, subtree, path ? `${path}/${name}` : name, out);
  return out;
}

// A new, empty folder in dir named after the archive.
export async function freshFolder(dir, archiveName, created) {
  const names = new Set();
  for await (const name of dir.keys()) names.add(nameKey(name));
  for (;;) {
    const name = freshFolderName(archiveName, names); names.add(nameKey(name));
    const handle = await createNew(dir, name, 'directory', created);
    if (!handle) continue;
    const { done } = await handle.keys().next();
    if (done) return { name, handle };
  }
}

// True when dir has a file or folder called name. On a disk that ignores case, the system answers for the
// other spellings too. An error other than "not found" counts as taken.
async function taken(dir, name) {
  return Boolean(await lookup(dir, name, 'file').catch(() => true) || await lookup(dir, name, 'directory').catch(() => true));
}

const appeared = () => new Error('A file with this name appeared while extracting. It was left as it is.');

// Writes chunks to handle. When record is set the file is this run's and is removed if writing fails;
// otherwise the browser's transactional writer leaves the old contents in place.
async function fill(handle, chunks, onChunk, record, created) {
  let sink = null;
  try {
    sink = new WritableSink(await handle.createWritable());
    for await (const chunk of chunks) { onChunk(chunk); await sink.write(chunk); }
    await sink.close();
  } catch (error) {
    if (sink) await sink.abort();
    if (record) await removeCreated(created, record);
    throw error;
  }
}

export const supportsMove = () => typeof globalThis.FileSystemHandle?.prototype?.move === 'function';

// Writes one entry to name in parent. A new file is written under a temporary name and moved into place
// once complete and verified. A replaced file is swapped in the same way. Where move() is missing, a new file
// is written under its final name and a replaced file through its transactional writer.
export async function writeEntry(parent, name, replace, chunks, created, onChunk = () => {}, canMove = supportsMove()) {
  const existing = replace ? await lookup(parent, name, 'file').catch(() => null) : null;
  let final = name;
  if (!existing && await taken(parent, final)) {
    // Something appeared after the plan was made, or the disk ignores case: keep it and write beside it.
    const names = new Set(); for await (const n of parent.keys()) names.add(nameKey(n));
    final = keepBothName(final, names);
  }
  if (!canMove) {
    const handle = existing ?? await createNew(parent, final, 'file', created);
    if (!handle) throw appeared();
    await fill(handle, chunks, onChunk, existing ? null : created.at(-1), created);
    return final;
  }
  let temp = null;
  for (let n = 0; !temp; n++) temp = await createNew(parent, `.${final}${n ? `.${n}` : ''}.partial`, 'file', created);
  const record = created.at(-1);
  await fill(temp, chunks, onChunk, record, created);
  try {
    if (!existing && await taken(parent, final)) throw appeared();
    await temp.move(existing ? existing.name : final);
    created.splice(created.indexOf(record), 1);
    if (!existing) created.push({ dir: parent, name: final, kind: 'file' });
    return final;
  } catch (error) {
    // move() can be refused on some disks: copy the finished file instead, then drop the temporary one.
    try {
      const target = existing ?? await createNew(parent, final, 'file', created);
      if (!target) throw error;
      const done = await temp.getFile();
      await fill(target, blobChunks(done, 0, done.size), () => {}, existing ? null : created.at(-1), created);
      return final;
    } finally { await removeCreated(created, record); }
  }
}
