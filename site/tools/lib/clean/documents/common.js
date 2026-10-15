// Shared by the document cleaners: copying entries, cleaning embedded pictures and messages.
import { rawEntry, readZip } from '../../zip/index.js';
import { detect, inspectImage } from '../../metadata/index.js';
import { IMAGE_CLEANABLE, readPart } from '../../metadata/documents/package.js';
import { cleanImage, Refusal } from '../index.js';

export const TRACKED = 'This document has tracked changes, which keep deleted text and the names of the people who made each change. Accept or reject all changes in your editor first, or choose to accept them here.';
export const refuse = (message, option) => { throw new Refusal(message, option); };

// An unchanged entry is copied still compressed. Times, extra fields and comments are not carried over.
export function copyEntry(zip, e) {
  if (e.directory) return { name: e.name, data: new Uint8Array() };
  return { name: e.name, raw: rawEntry(zip, e), crc: e.crc, size: e.size, method: e.method, ...unixMode(e) };
}

// Unix file modes (the executable bit, symbolic links) are kept. They do not identify anyone.
export function unixMode(e) {
  return e.versionMadeBy >> 8 === 3 && e.externalAttributes >>> 16 ? { unix: true, externalAttributes: e.externalAttributes & 0xffff0000 } : {};
}

// Embedded pictures are cleaned by the image cleaner when it supports the format.
export async function cleanPicture(zip, e, b) {
  const data = await readPart(zip, e, b, b.left);
  if (!data || !detect(data)) return null;
  const head = await inspectImage(data);
  if (!IMAGE_CLEANABLE.has(head.format) || !head.cleanable.blocks) return null;
  const result = await cleanImage(data);
  if (!result.ok) refuse(`The embedded picture ${e.name} could not be cleaned (${result.reason}), so the file was left untouched.`);
  if (!result.removed.length) return null;
  return { data: result.data, removed: { kind: 'Embedded image metadata', container: e.name, bytes: data.length - result.data.length } };
}

export function reopen(u8) {
  try { return readZip(u8); } catch (error) { return refuse(`The cleaned file could not be read back (${error.message}), so it was not produced.`); }
}

// Archive-level blocks every ZIP-based cleaner removes by rewriting the archive.
const ARCHIVE_KINDS = new Set(['Archive details', 'Prepended data', 'Trailing data', 'Comment']);
export const archiveRemovals = (report) => report.blocks.filter((b) => ARCHIVE_KINDS.has(b.kind)).map((b) => ({ kind: b.kind, container: b.container ?? '', bytes: b.length }));
