// Entry names come from the archive and are hostile. Every name is turned into a relative path below the
// extraction folder before it is used, or refused.

// Returns { path, note }. path is null when the entry must not be extracted.
// note: null, 'absolute' (a leading / or drive letter was removed), 'renamed' (control characters replaced),
// 'traversal' (a .. segment, refused) or 'empty' (nothing left, refused).
export function safePath(raw) {
  let p = String(raw).replace(/\\/g, '/');
  let note = null;
  if (/^[a-zA-Z]:/.test(p)) { p = p.slice(2); note = 'absolute'; }
  if (p.startsWith('/')) { p = p.replace(/^\/+/, ''); note = 'absolute'; }
  const parts = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { path: null, note: 'traversal' };
    parts.push(segment);
  }
  if (!parts.length) return { path: null, note: 'empty' };
  const cleaned = parts.map((s) => s.replace(/[\x00-\x1f\x7f]/g, '_'));
  if (cleaned.some((s, i) => s !== parts[i])) note ??= 'renamed';
  return { path: cleaned.join('/'), note };
}

export const NOTES = {
  absolute: 'Stored with an absolute path. It is extracted inside the chosen folder.',
  renamed: 'The name had control characters, which were replaced.',
  traversal: 'Blocked: the name points outside the extraction folder.',
  empty: 'Blocked: the entry has no usable name.',
};

// Makes a path unique within a set by adding " (2)", " (3)" and so on before the extension.
export function uniquePath(path, taken) {
  if (!taken.has(path.toLowerCase())) { taken.add(path.toLowerCase()); return path; }
  const slash = path.lastIndexOf('/'); const dir = path.slice(0, slash + 1); const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.'); const stem = dot > 0 ? base.slice(0, dot) : base; const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; ; n++) { const candidate = `${dir}${stem} (${n})${ext}`; if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; } }
}
