// Page range parsing and split planning. No MuPDF here, so the page itself can use these.

export class PageRangeError extends Error {}

// '1-3, 5, 8-' against a page count. Returns groups of zero-based page indexes, one per comma-separated part,
// in the order written. Throws PageRangeError with a message meant for people.
export function parseRanges(spec, count) {
  const parts = String(spec).split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new PageRangeError('Enter at least one page or range, such as 1-3, 5, 8-.');
  return parts.map((part) => {
    const m = /^(\d*)\s*(?:(-|–)\s*(\d*))?$/.exec(part);
    if (!m || (!m[1] && !m[3] && !m[2]) || (!m[1] && !m[2])) throw new PageRangeError(`“${part}” is not a page or range.`);
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : count) : from;
    if (from < 1 || to < 1) throw new PageRangeError('Page numbers start at 1.');
    if (from > count || to > count) throw new PageRangeError(`This document has ${count} page${count === 1 ? '' : 's'}; “${part}” goes past the end.`);
    if (from > to) throw new PageRangeError(`“${part}” runs backwards.`);
    return Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  });
}

// Groups of n consecutive pages.
export function splitEvery(count, n) {
  const size = Math.floor(Number(n));
  if (!Number.isFinite(size) || size < 1) throw new PageRangeError('Enter a number of pages of 1 or more.');
  const groups = [];
  for (let i = 0; i < count; i += size) groups.push(Array.from({ length: Math.min(size, count - i) }, (_, k) => i + k));
  return groups;
}

export const onePerPage = (count) => Array.from({ length: count }, (_, i) => [i]);

// 'Page {n} of {total}' with the page number and total filled in.
export const formatPageLabel = (format, n, total) => String(format).replaceAll('{n}', String(n)).replaceAll('{total}', String(total));

// Short label for a group of pages in file names: '1-3', '5'.
export function groupLabel(group) {
  const first = group[0] + 1; const last = group.at(-1) + 1;
  const contiguous = group.every((p, i) => i === 0 || p === group[i - 1] + 1);
  return first === last ? String(first) : contiguous ? `${first}-${last}` : `${first}-${last}-selection`;
}
