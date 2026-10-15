// Lossless metadata removal. The cleaner cuts the metadata blocks the inspector found out of the file's
// container and copies every other byte as is, so pixels are never decoded or re-encoded.
import { LIMITS, concat, crc32 } from '../metadata/bytes.js';
import { inspectFile, inspectImage } from '../metadata/index.js';
import { enumValue } from '../metadata/tags.js';
import * as documents from './families/documents.js';
import * as pdf from './families/pdf.js';
import * as media from './families/media.js';
import * as text from './families/text.js';
import * as images from './families/images.js';

const FORMATS = new Set(['JPEG', 'PNG', 'WebP', 'GIF']);
const listJoin = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
// Read when called: the family modules import this one, so their exports are not ready while it loads.
const imageList = () => listJoin([...FORMATS, ...images.formats]);
const ORIENTED = new Set(['JPEG', 'PNG', 'WebP']);

export async function cleanImage(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length > LIMITS.maxFileBytes) return refuse('This file is larger than 200 MB.');
  const before = await inspectImage(u8);
  if (!before.format) return refuse(`This file is not an image the Metadata Cleaner supports. Supported image formats: ${imageList()}.`);
  if (images.formats.has(before.format)) return cleanFile(u8);
  if (!FORMATS.has(before.format)) return refuse(`${before.format} images cannot be cleaned yet. Supported image formats: ${imageList()}.`);
  if (before.warnings.some((w) => /damaged|truncated|past the end|Too many/.test(w))) return refuse('The file is damaged or unusually structured, so it was left untouched.');

  const blocks = before.blocks.filter((b) => b.removable !== false && !hasRemovableAncestor(before.blocks, b));
  const cuts = [];
  for (const b of blocks) {
    if (!Number.isInteger(b.offset) || !Number.isInteger(b.length) || b.offset < 0 || b.length <= 0 || b.offset + b.length > u8.length) return refuse('A metadata block could not be located safely, so the file was left untouched.');
    cuts.push([b.offset, b.offset + b.length]);
  }
  cuts.sort((a, c) => a[0] - c[0]);
  const merged = [];
  for (const cut of cuts) { const last = merged.at(-1); if (last && cut[0] <= last[1]) last[1] = Math.max(last[1], cut[1]); else merged.push([...cut]); }

  const parts = []; let at = 0;
  for (const [from, to] of merged) { parts.push(u8.subarray(at, from)); at = to; }
  parts.push(u8.subarray(at));
  let out = concat(parts);

  // A JFIF header that carried a thumbnail goes back in front without it.
  const jfif = blocks.find((b) => b.kind === 'Thumbnail' && b.container === 'APP0 JFIF');
  if (jfif) out = concat([out.subarray(0, 2), bareJfif(u8.subarray(jfif.offset, jfif.offset + 18)), out.subarray(2)]);

  // Display rotation lives in EXIF. Dropping it would turn a portrait photo sideways, so it alone is kept.
  const orientation = ORIENTED.has(before.format) ? readOrientation(before) : 1;
  if (orientation > 1) out = withOrientation(out, before.format, orientation);
  if (before.format === 'WebP') out = fixWebp(out, orientation > 1);

  const after = await inspectImage(out);
  const leftovers = after.blocks.filter((b) => b.removable !== false && !hasRemovableAncestor(after.blocks, b) && !(orientation > 1 && b.kind === 'EXIF'));
  const sizeOk = after.width === before.width && after.height === before.height && after.format === before.format;
  if (leftovers.length || !sizeOk || after.warnings.length) return refuse('The cleaned file did not pass the check afterwards, so it was not produced.');

  return {
    ok: true, data: out, format: before.format, width: before.width, height: before.height,
    bytesBefore: u8.length, bytesAfter: out.length,
    removed: blocks.map((b) => ({ kind: b.kind, container: b.container ?? '', bytes: b.length })),
    exposures: before.signals.filter((s) => s.kind === 'privacy' || s.kind === 'declared').map((s) => s.title),
    kept: [...(orientation > 1 ? [`Orientation (${enumValue('Orientation', orientation)})`] : []), ...after.blocks.filter((b) => b.removable === false).map((b) => `${b.kind} (${b.container})`)],
    orientation,
  };
}

// Each family module exports formats (a Set of report.format values) and
// clean(u8, report, ctx) => { data, removed: [{ kind, container, bytes }], kept: [string], allowed?: (block) => boolean }.
// It throws a Refusal to leave the file untouched. allowed marks blocks deliberately kept, which the check
// afterwards accepts. ctx: { name, options }.
const FAMILIES = [images, documents, pdf, media, text];
// option: the cleaner option that lifts this refusal (acceptChanges, removeSignatures), when there is one.
export class Refusal extends Error { constructor(message, option) { super(message); if (option) this.option = option; } }
// Every format report.format can name that some cleaner rewrites.
export const cleanableFormats = () => new Set([...FORMATS, ...FAMILIES.flatMap((f) => [...(f.formats ?? [])])]);

// The cleanable formats in words, grouped the way people name them. Built from the families' own lists.
export function describeCleanable(formats = cleanableFormats()) {
  const pick = (list) => [...list].filter((f) => formats.has(f));
  const docs = pick(documents.formats);
  const parts = [
    pick([...FORMATS, ...images.formats]).length && `photos (${pick([...FORMATS, ...images.formats]).join(", ")})`,
    formats.has('PDF') && 'PDF',
    docs.some((f) => /^(DOC|DOT|XLS|XLT|PPT|PPS|POT)/.test(f)) && 'Word, Excel and PowerPoint files',
    docs.some((f) => /^O[DT][TSPG]$/.test(f)) && 'OpenDocument files',
    ...pick(['EPUB', 'ZIP']),
    pick(media.formats).length && `audio and video (${pick(media.formats).join(", ")})`,
    formats.has('Text') && 'plain text',
  ].filter(Boolean);
  return listJoin(parts);
}

// Any file the inspector can read. Images go through cleanImage. Other formats go through their family's
// cleaner, and the result is inspected again before it is handed back.
export async function cleanFile(input, name = '', options = {}) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length > LIMITS.maxFileBytes) return refuse('This file is larger than 200 MB.');
  const before = await inspectFile(u8, name);
  if (FORMATS.has(before.format)) return cleanImage(u8);
  const family = FAMILIES.find((f) => f.formats?.has(before.format));
  if (!family) return refuse(before.format ? `${before.format} files cannot be cleaned yet.` : 'This file type is not one the Metadata Cleaner can rewrite safely, so it was left untouched.');
  if (before.warnings.some((w) => /damaged|truncated|past the end|Too many/.test(w))) return refuse('The file is damaged or unusually structured, so it was left untouched.');
  // Finding nothing only proves the file is clean when the inspector could read all of it.
  if (!before.cleanable.blocks && before.warnings.length) return refuse('Parts of the file could not be read, so it could not be checked for metadata and was left untouched.');
  if (!before.cleanable.blocks) return { ok: true, data: u8, format: before.format, bytesBefore: u8.length, bytesAfter: u8.length, removed: [], exposures: [], kept: [] };
  let result;
  try { result = await family.clean(u8, before, { name, options }); }
  catch (error) { if (error instanceof Refusal) return refuse(error.message, error.option); throw error; }
  const after = await inspectFile(result.data, name);
  const allowed = result.allowed ?? (() => false);
  const leftovers = after.blocks.filter((b) => b.removable !== false && !hasRemovableAncestor(after.blocks, b) && !allowed(b));
  const newWarnings = after.warnings.filter((w) => !before.warnings.includes(w));
  const same = after.format === before.format && after.width === before.width && after.height === before.height;
  if (leftovers.length || newWarnings.length || !same) return refuse('The cleaned file did not pass the check afterwards, so it was not produced.');
  return {
    ok: true, data: result.data, format: before.format, width: before.width, height: before.height,
    bytesBefore: u8.length, bytesAfter: result.data.length, removed: result.removed, kept: result.kept,
    // Options that would remove what was kept here (removeMacros, clearForms).
    offer: result.offer ?? [],
    exposures: before.signals.filter((s) => s.kind === 'privacy' || s.kind === 'declared').map((s) => s.title),
  };
}

const refuse = (reason, option) => ({ ok: false, reason, ...(option ? { option } : {}) });

function hasRemovableAncestor(blocks, b) {
  for (let p = b.parent; p !== null && p !== undefined; p = blocks[p]?.parent) if (blocks[p]?.removable !== false) return true;
  return false;
}

function readOrientation(report) {
  const field = report.sources.find((s) => s.name === 'EXIF IFD0')?.fields.find((f) => f.key === 'Orientation');
  if (!field) return 1;
  for (let n = 1; n <= 8; n++) if (enumValue('Orientation', n) === field.value || field.value === String(n)) return n;
  return 1;
}

// APP0 JFIF with the original version, density unit and density, and no thumbnail.
function bareJfif(head) {
  const seg = Uint8Array.from(head); seg[2] = 0; seg[3] = 16; seg[16] = 0; seg[17] = 0;
  return seg;
}

// Smallest valid EXIF payload: a big-endian TIFF header and one IFD holding Orientation.
function minimalTiff(orientation) {
  return Uint8Array.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
}

function withOrientation(u8, format, orientation) {
  const tiff = minimalTiff(orientation);
  if (format === 'JPEG') {
    const exif = Uint8Array.from([0xff, 0xe1, 0, 8 + tiff.length, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
    // JFIF must stay the first segment.
    let at = 2;
    if (u8[2] === 0xff && u8[3] === 0xe0) at = 4 + ((u8[4] << 8) | u8[5]);
    return concat([u8.subarray(0, at), exif, u8.subarray(at)]);
  }
  if (format === 'PNG') return concat([u8.subarray(0, 33), pngChunk('eXIf', tiff), u8.subarray(33)]);
  const chunk = riffChunk('EXIF', tiff);
  return concat([u8, chunk]);
}

function riffChunk(type, data) {
  const head = new Uint8Array(8); head.set([...type].map((c) => c.charCodeAt(0)));
  new DataView(head.buffer).setUint32(4, data.length, true);
  return concat([head, data, new Uint8Array(data.length & 1)]);
}

// WebP: the RIFF size and the VP8X feature flags must describe what is left.
function fixWebp(u8, keepExif) {
  const out = u8.slice(); const view = new DataView(out.buffer);
  view.setUint32(4, out.length - 8, true);
  if (String.fromCharCode(...out.subarray(12, 16)) === 'VP8X') out[20] = (out[20] & ~0x0c) | (keepExif ? 0x08 : 0);
  return out;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length); const view = new DataView(out.buffer);
  view.setUint32(0, data.length); out.set([...type].map((c) => c.charCodeAt(0)), 4); out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
