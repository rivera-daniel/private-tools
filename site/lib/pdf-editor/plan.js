// The working document is a plan: a list of pages, each taken from an opened source file or blank, with
// a rotation added on top of the page's own. Organize operations rewrite the plan and never touch a file;
// the PDF is built from it only when needed. No MuPDF here, so the page uses these directly.
// Entry: { src, page, rotate } or { blank: [width, height], rotate }. Other fields (a key for the page's
// own bookkeeping) are carried along.

export const fromSource = (src, count) => Array.from({ length: count }, (_, page) => ({ src, page, rotate: 0 }));

const sorted = (indexes) => [...new Set(indexes)].sort((a, b) => a - b);
const turn = (r, by) => (((r + by) % 360) + 360) % 360;

export function rotatePages(plan, indexes, degrees) {
  const set = new Set(indexes);
  return plan.map((e, i) => (set.has(i) ? { ...e, rotate: turn(e.rotate ?? 0, degrees) } : e));
}

export function removePages(plan, indexes) {
  const set = new Set(indexes);
  return plan.filter((_, i) => !set.has(i));
}

// Each chosen page gets a copy right after it. makeKey gives the copy its own key.
export function duplicatePages(plan, indexes, makeKey = () => undefined) {
  const set = new Set(indexes); const out = []; const placed = [];
  plan.forEach((e, i) => {
    out.push(e);
    if (set.has(i)) { const key = makeKey(); out.push(key === undefined ? { ...e } : { ...e, key }); placed.push(out.length - 1); }
  });
  return { plan: out, indexes: placed };
}

export function insertBlank(plan, at, size, extra = {}) {
  const out = plan.slice();
  const index = Math.max(0, Math.min(at, out.length));
  out.splice(index, 0, { blank: [size[0], size[1]], rotate: 0, ...extra });
  return { plan: out, index };
}

export const pickPages = (plan, indexes) => sorted(indexes).map((i) => plan[i]).filter(Boolean);

// Moves the chosen pages, kept in their current order, so they land before the page now at index
// `before` (plan.length puts them at the end). Returns the new plan and where the moved pages are.
export function movePagesTo(plan, indexes, before) {
  const chosen = sorted(indexes).filter((i) => i >= 0 && i < plan.length);
  if (!chosen.length) return { plan, indexes: [] };
  const set = new Set(chosen);
  const target = before - chosen.filter((i) => i < before).length;
  const rest = plan.filter((_, i) => !set.has(i));
  const at = Math.max(0, Math.min(target, rest.length));
  rest.splice(at, 0, ...chosen.map((i) => plan[i]));
  return { plan: rest, indexes: chosen.map((_, k) => at + k) };
}

// Moves the chosen pages one step earlier (-1) or later (+1) as a block, stopping at the ends.
export function movePagesBy(plan, indexes, delta) {
  const chosen = sorted(indexes);
  if (!chosen.length) return { plan, indexes: [] };
  if (delta < 0 && chosen[0] === 0) return { plan, indexes: chosen };
  if (delta > 0 && chosen.at(-1) === plan.length - 1) return { plan, indexes: chosen };
  return movePagesTo(plan, chosen, delta < 0 ? chosen[0] - 1 : chosen.at(-1) + 2);
}

// Displayed size of an entry in PDF points, given the source page's displayed size.
export function entrySize(entry, sourceSize) {
  const [w, h] = entry.blank ?? sourceSize;
  return (entry.rotate ?? 0) % 180 ? [h, w] : [w, h];
}
