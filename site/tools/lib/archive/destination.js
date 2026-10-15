// Where extracted files go on disk. Everything here is pure: the worker scans the chosen folder and passes
// what it found, so the rules can be tested without a browser.
//
// Paths are relative, '/'-separated and already made safe by safePath. Names are compared by key: NFC and
// lower case, because Windows and macOS treat "Report.txt", "report.txt" and the NFD spelling as one file.

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

export const nameKey = (name) => name.normalize('NFC').toLowerCase();

// A name every common file system accepts: NFC, no characters Windows forbids, no trailing dots or spaces,
// and not a reserved device name such as CON or nul.txt.
export function portableName(name) {
  let s = name.normalize('NFC').replace(/[<>:"|?*\\]/g, '_').replace(/[. ]+$/, '');
  if (!s) return '_';
  if (RESERVED.test(s.split('.')[0].replace(/ +$/, ''))) s = `_${s}`;
  return s;
}

// Archive file name without its archive extensions.
export const archiveBase = (name) => name.replace(/\.(zip|tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2|tar|gz|7z|rar|xz|bz2|zst|iso|cab)$/i, '') || 'archive';

// "report (extracted)", then "report (extracted) 2", "report (extracted) 3" while the name is taken.
// taken: a Set of name keys already in the folder.
export function freshFolderName(archiveName, taken) {
  const base = `${portableName(archiveBase(archiveName))} (extracted)`;
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base} ${n}`; if (!taken.has(nameKey(name))) return name; }
}

// "name (1).ext", "name (2).ext" and so on, the first whose key is not in taken.
export function keepBothName(name, taken) {
  const dot = name.lastIndexOf('.'); const stem = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) { const candidate = `${stem} (${n})${ext}`; if (!taken.has(nameKey(candidate))) return candidate; }
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

// entries: [{ id, path, kind: 'file' | 'directory' }] in archive order.
// existing: Map from a folder's path on disk ('' is the chosen folder) to a Map of name key -> { name, kind },
//   for every existing folder the extraction would write into. Empty when extracting into a new folder.
// choices: { [path on disk]: 'skip' | 'keep' | 'replace' } for collisions. A collision without a choice keeps
//   both. Only an existing file can be replaced, never a folder.
// Returns {
//   directories: [path]                         folders to create or reuse, parents first
//   files: [{ id, path, replace }]             replace: path is an existing file the visitor chose to replace
//   skipped: [{ id, path }]
//   renamed: [{ id, from, to, reason }]         reason: 'portable', 'duplicate' (two entries share a name) or 'collision'
//   collisions: [{ path, existing, wanted, replaceable, choice }]
// }
export function planExtraction(entries, { existing = new Map(), choices = {} } = {}) {
  const dirs = new Map(); // archive key path -> { path on disk, onDisk (an existing folder), skipped }
  dirs.set('', { path: '', onDisk: true, skipped: false });
  const planned = new Map(); // path on disk of a folder -> Set of name keys planned in it
  const plannedIn = (dir) => { if (!planned.has(dir)) planned.set(dir, new Set()); return planned.get(dir); };
  const existingIn = (dir) => existing.get(dir) ?? new Map();
  const taken = (dir) => new Set([...plannedIn(dir), ...existingIn(dir).keys()]);
  const directories = []; const files = []; const skipped = []; const renamed = []; const collisions = [];
  const choiceFor = (path) => choices[path] ?? 'keep';

  const parsed = entries.map((e) => {
    const raw = e.path.split('/'); const parts = raw.map(portableName);
    return { ...e, parts, keys: parts.map(nameKey), portable: parts.some((p, i) => p !== raw[i]) };
  });

  // Folders first, parents before children, so a file never takes a name a folder needs.
  const folderKeys = new Map();
  for (const e of parsed) {
    const depth = e.kind === 'directory' ? e.parts.length : e.parts.length - 1;
    for (let i = 1; i <= depth; i++) { const key = e.keys.slice(0, i).join('/'); if (!folderKeys.has(key)) folderKeys.set(key, { parts: e.parts.slice(0, i), keys: e.keys.slice(0, i) }); }
  }
  for (const [key, { parts, keys }] of [...folderKeys].sort(([a], [b]) => a.split('/').length - b.split('/').length)) {
    const parent = dirs.get(keys.slice(0, -1).join('/'));
    const name = parts.at(-1); const k = keys.at(-1);
    if (parent.skipped) { dirs.set(key, { skipped: true }); continue; }
    const found = parent.onDisk ? existingIn(parent.path).get(k) : undefined;
    if (found?.kind === 'directory') {
      // Merge into the existing folder under the name it already has on disk.
      const path = join(parent.path, found.name);
      dirs.set(key, { path, onDisk: true, skipped: false }); plannedIn(parent.path).add(k); directories.push(path);
      continue;
    }
    let final = name;
    if (found) {
      const path = join(parent.path, found.name); const choice = choiceFor(path) === 'skip' ? 'skip' : 'keep';
      collisions.push({ path, existing: found.kind, wanted: 'directory', replaceable: false, choice });
      if (choice === 'skip') { dirs.set(key, { skipped: true }); continue; }
      final = keepBothName(name, taken(parent.path));
    }
    const path = join(parent.path, final);
    plannedIn(parent.path).add(nameKey(final));
    dirs.set(key, { path, onDisk: false, skipped: false }); directories.push(path);
  }

  for (const e of parsed) {
    if (e.kind !== 'file') continue;
    const parent = dirs.get(e.keys.slice(0, -1).join('/'));
    if (parent.skipped) { skipped.push({ id: e.id, path: e.path }); continue; }
    const name = e.parts.at(-1); const k = e.keys.at(-1);
    let final = name; let replace = false; let reason = e.portable ? 'portable' : null;
    // Another entry of this archive, or a folder it creates, already has this name.
    const duplicate = folderKeys.has(e.keys.join('/')) || plannedIn(parent.path).has(k);
    const found = parent.onDisk && !duplicate ? existingIn(parent.path).get(k) : undefined;
    if (duplicate) { final = keepBothName(name, taken(parent.path)); reason = 'duplicate'; } else if (found) {
      const path = join(parent.path, found.name); const replaceable = found.kind === 'file';
      let choice = choiceFor(path);
      if (choice === 'replace' && !replaceable) choice = 'keep';
      collisions.push({ path, existing: found.kind, wanted: 'file', replaceable, choice });
      if (choice === 'skip') { skipped.push({ id: e.id, path: e.path }); continue; }
      if (choice === 'replace') { final = found.name; replace = true; } else { final = keepBothName(name, taken(parent.path)); reason = 'collision'; }
    }
    const path = join(parent.path, final);
    if (reason) renamed.push({ id: e.id, from: e.path, to: path, reason });
    plannedIn(parent.path).add(nameKey(final));
    files.push({ id: e.id, path, replace });
  }
  return { directories, files, skipped, renamed, collisions };
}

// The folders, as archive key paths, whose existing contents planExtraction needs: every folder an entry
// would write into. Returns a tree of Maps (name key -> subtree) for the worker to scan.
export function foldersToScan(entries) {
  const root = new Map();
  for (const e of entries) {
    const keys = e.path.split('/').map((p) => nameKey(portableName(p)));
    let node = root;
    for (const k of keys.slice(0, e.kind === 'directory' ? keys.length : -1)) { if (!node.has(k)) node.set(k, new Map()); node = node.get(k); }
  }
  return root;
}
