// Archive creation and extraction for the Archiver: ZIP (with WinZip AES), tar, tar.gz and gzip, all
// streamed so archives larger than memory work when the output goes to a file on disk.
import { cleanFile } from '../clean/index.js';
import { ZipStreamWriter, openZipBlob, zipEntryChunks } from '../zip/stream.js';
import { tarStream, readTar, looksLikeTar } from './tar.js';
import { safePath, uniquePath } from './paths.js';
import { MB, blobChunks, bytesChunks, compress, decompress, tap, BlobReader, StreamReader, Cancelled } from './streams.js';

const GB = 1024 * MB;
export const LIMITS = {
  maxEntries: 100000,
  // An archive that expands more than maxRatio times is stopped once its output passes ratioFloor.
  maxRatio: 1000, ratioFloor: 100 * MB,
  // Total output when it is held in browser memory, and when it is written to a folder on disk.
  memoryTotal: 2 * GB, diskTotal: 256 * GB,
  cleanBytes: 200 * MB,
};
const HIDDEN_DATE = 315532800; // 1980-01-01, the earliest date ZIP can store.

export class LimitError extends Error { constructor(message) { super(message); this.name = 'LimitError'; } }

// Formats this module reads itself. Others go to libarchive in the worker.
export const NATIVE = new Set(['zip', 'tar', 'tar.gz', 'gz']);

const startsWith = (u8, bytes, at = 0) => bytes.every((b, i) => u8[at + i] === b);
const MAGIC = [
  ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]], ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ['bz2', [0x42, 0x5a, 0x68]], ['zst', [0x28, 0xb5, 0x2f, 0xfd]], ['lz4', [0x04, 0x22, 0x4d, 0x18]], ['cab', [0x4d, 0x53, 0x43, 0x46]],
  ['cpio', [0x30, 0x37, 0x30, 0x37, 0x30]], ['ar', [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e]], ['lzh', [0x2d, 0x6c, 0x68], 2],
];

// Identifies the archive format from the first bytes, the end of a ZIP, and the file name as a last resort.
export async function detectFormat(file) {
  const head = new Uint8Array(await file.slice(0, 0x8006).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    try {
      const reader = new StreamReader(decompress(blobChunks(file, 0, Math.min(file.size, 4 * MB)), 'gzip'));
      const block = await reader.read(512); await reader.close();
      return looksLikeTar(block) ? 'tar.gz' : 'gz';
    } catch { return 'gz'; }
  }
  if (head[0] === 0x50 && head[1] === 0x4b && [3, 5, 7].includes(head[2])) return 'zip';
  for (const [format, bytes, at = 0] of MAGIC) if (startsWith(head, bytes, at)) return format;
  if (looksLikeTar(head.subarray(0, 512))) return 'tar';
  if (head.length >= 0x8006 && startsWith(head, [0x43, 0x44, 0x30, 0x30, 0x31], 0x8001)) return 'iso';
  if (head[0] === 0x5d && head[1] === 0x00 && head[2] === 0x00) return 'lzma';
  // Self-extracting archives and ZIPs with data in front still end with a ZIP directory.
  try { await openZipBlob(file); return 'zip'; } catch { /* not a ZIP */ }
  return null;
}

const EXT_STORED = new Set('jpg jpeg png gif webp heic heif avif jxl mp3 mp4 m4a m4v mov mkv webm ogg oga ogv opus flac aac wma wmv avi zip gz tgz bz2 tbz2 xz txz zst lz4 7z rar cab docx xlsx pptx odt ods odp epub jar apk ipa woff woff2 dmg'.split(' '));
const MAGIC_STORED = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47], [0x47, 0x49, 0x46, 0x38], [0x50, 0x4b, 0x03, 0x04], [0x1f, 0x8b], [0x37, 0x7a, 0xbc, 0xaf], [0x52, 0x61, 0x72, 0x21], [0xfd, 0x37, 0x7a, 0x58], [0x42, 0x5a, 0x68], [0x28, 0xb5, 0x2f, 0xfd], [0x4f, 0x67, 0x67, 0x53], [0x66, 0x4c, 0x61, 0x43], [0x1a, 0x45, 0xdf, 0xa3], [0x49, 0x44, 0x33], [0x77, 0x4f, 0x46]];

// Files that are already compressed gain nothing from deflate and are stored as they are.
export function alreadyCompressed(name, head) {
  const ext = name.toLowerCase().split('.').pop();
  if (EXT_STORED.has(ext)) return true;
  if (MAGIC_STORED.some((m) => startsWith(head, m))) return true;
  return startsWith(head, [0x66, 0x74, 0x79, 0x70], 4) || (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8));
}

// Wall-clock time read through UTC fields, which is how ZIP's DOS dates are written (see zip/index.js toDos).
const wallClock = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000);

// items: [{ file, path, directory }]. format: 'zip', 'tar', 'tar.gz' or 'gz'. method: 'deflate' or 'store'
// (ZIP only). clean: run the Metadata Cleaner on each file first. hideDates: write 1980-01-01 instead of the
// file dates. sink: a MemorySink or WritableSink. onProgress(done, total, name). cancelled() returns true to stop.
// Returns { result, cleaned: [{ path, removed }], kept: [{ path, reason }], entries }.
export async function createArchive({ items, format, method = 'deflate', password = null, clean = true, hideDates = true, sink, onProgress = () => {}, cancelled = () => false }) {
  if (format === 'gz' && (items.length !== 1 || items[0].directory)) throw new Error('A .gz file holds exactly one file. Choose tar.gz for several files or folders.');
  if (password && format !== 'zip') throw new Error('Only ZIP archives can be encrypted here.');
  const taken = new Set();
  const list = items.map((item) => ({ ...item, path: uniquePath(item.path.replace(/\\/g, '/').replace(/^\/+/, ''), taken) }));
  const total = list.reduce((n, i) => n + (i.directory ? 0 : i.file.size), 0);
  let done = 0; const cleaned = []; const kept = [];

  // The bytes for each file: cleaned when asked and possible, otherwise read straight from the file.
  async function contents(item) {
    const { file } = item;
    const progress = (source) => tap(source, (chunk) => { if (cancelled()) throw new Cancelled(); done += chunk.length; onProgress(Math.min(done, total), total, item.path); });
    if (clean && file.size <= LIMITS.cleanBytes && file.size > 0) {
      const u8 = new Uint8Array(await file.arrayBuffer());
      let reason = null; let data = u8;
      try {
        const r = await cleanFile(u8, file.name);
        if (r.ok) { data = r.data; if (r.removed.length) cleaned.push({ path: item.path, removed: r.removed.length, before: r.bytesBefore, after: r.bytesAfter }); }
        else reason = r.reason;
      } catch { reason = 'The file could not be checked, so it was added unchanged.'; }
      if (reason) kept.push({ path: item.path, reason });
      const scale = file.size / Math.max(1, data.length);
      return { size: data.length, head: data.subarray(0, 16), source: tap(bytesChunks(data), (chunk) => { if (cancelled()) throw new Cancelled(); done += Math.round(chunk.length * scale); onProgress(Math.min(done, total), total, item.path); }) };
    }
    if (clean && file.size > LIMITS.cleanBytes) kept.push({ path: item.path, reason: 'Larger than 200 MB, so it was added unchanged.' });
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    return { size: file.size, head, source: progress(blobChunks(file)) };
  }
  const mtimeOf = (item) => (hideDates || !item.file ? null : item.file.lastModified);

  try {
    let result; const entries = [];
    if (format === 'zip') {
      const writer = new ZipStreamWriter(sink, { password });
      for (const item of list) {
        if (cancelled()) throw new Cancelled();
        if (item.directory) { entries.push(await writer.add({ name: item.path, directory: true, modified: null })); continue; }
        const c = await contents(item);
        const store = method === 'store' || c.size === 0 || alreadyCompressed(item.path, c.head);
        const ms = mtimeOf(item);
        entries.push(await writer.add({ name: item.path, size: c.size, source: c.source, method: store ? 0 : 8, modified: ms === null ? null : wallClock(ms) }));
      }
      result = await writer.finish();
    } else {
      async function* tarEntries() {
        for (const item of list) {
          if (cancelled()) throw new Cancelled();
          const ms = mtimeOf(item); const mtime = ms === null ? HIDDEN_DATE : Math.floor(ms / 1000);
          if (item.directory) { yield { name: item.path, directory: true, mtime }; continue; }
          const c = await contents(item);
          entries.push({ name: item.path, size: c.size });
          yield { name: item.path, size: c.size, source: c.source, mtime };
        }
      }
      let stream;
      if (format === 'gz') { const c = await contents(list[0]); entries.push({ name: list[0].path, size: c.size }); stream = compress(c.source, 'gzip'); }
      else if (format === 'tar') stream = tarStream(tarEntries());
      else if (format === 'tar.gz') stream = compress(tarStream(tarEntries()), 'gzip');
      else throw new Error(`Cannot create ${format} archives.`);
      for await (const chunk of stream) await sink.write(chunk);
      result = await sink.close();
    }
    return { result, cleaned, kept, entries };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

function gzipInfo(head, tail, fileName) {
  let name = null;
  if (head[3] & 0x08) {
    let at = 10;
    if (head[3] & 0x04) at += 2 + (head[10] | (head[11] << 8));
    let end = at; while (end < head.length && head[end]) end++;
    if (end < head.length) name = new TextDecoder('latin1').decode(head.subarray(at, end));
  }
  const fallback = fileName.replace(/\.(gz|gzip)$/i, '').replace(/\.tgz$/i, '.tar') || 'file';
  const size = tail.length === 4 ? (tail[0] | (tail[1] << 8) | (tail[2] << 16) | (tail[3] << 24)) >>> 0 : 0;
  return { name: (name && name.split(/[\\/]/).pop()) || fallback.split(/[\\/]/).pop(), size };
}

// Lists an archive without extracting it. Returns { format, entries, warnings }. Each entry:
// { id, name, path, note, kind ('file', 'directory', 'symlink', 'hardlink', 'other'), size, compressedSize,
//   modified, encrypted, weak (ZipCrypto), method }.
export async function listArchive(file, format, { cancelled = () => false } = {}) {
  const warnings = []; const entries = [];
  const add = (e) => {
    if (entries.length >= LIMITS.maxEntries) throw new LimitError(`This archive has more than ${LIMITS.maxEntries.toLocaleString('en-US')} entries, which is more than the Archiver opens.`);
    const { path, note } = safePath(e.name);
    entries.push({ id: entries.length, path, note, ...e });
  };
  if (format === 'zip') {
    const zip = await openZipBlob(file);
    for (const e of zip.entries) {
      add({ name: e.name, kind: e.directory ? 'directory' : e.symlink ? 'symlink' : 'file', size: e.directory ? 0 : e.size, compressedSize: e.compressedSize, modified: e.modified, encrypted: e.encrypted, weak: e.encrypted && e.method !== 99, method: e.realMethod, zip: e });
    }
    if (zip.prefix > 0) warnings.push('The archive has extra data in front of it, such as a self-extractor. Only the archive part is read.');
  } else if (format === 'tar' || format === 'tar.gz') {
    const reader = format === 'tar' ? new BlobReader(file) : new StreamReader(guard(decompress(blobChunks(file), 'gzip'), { archiveSize: file.size, cap: LIMITS.diskTotal }));
    for await (const e of readTar(reader)) {
      if (cancelled()) throw new Cancelled();
      add({ name: e.name, kind: ['file', 'directory', 'symlink', 'hardlink'].includes(e.type) ? e.type : 'other', size: e.type === 'file' ? e.size : 0, compressedSize: null, modified: e.modified, encrypted: false, weak: false, type: e.type });
    }
  } else if (format === 'gz') {
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 4)).arrayBuffer());
    const info = gzipInfo(head, tail, file.name);
    add({ name: info.name, kind: 'file', size: file.size >= 4 * GB ? null : info.size, compressedSize: file.size, modified: null, encrypted: false, weak: false });
  } else throw new Error(`${format} archives are not read here.`);
  return { format, entries, warnings };
}

// Stops runaway output: more than the declared total, or a compression ratio beyond LIMITS.maxRatio.
// state: { archiveSize, cap, total }.
export async function* guard(source, state) {
  state.total ??= 0;
  for await (const chunk of source) {
    state.total += chunk.length;
    if (state.total > state.cap) throw new LimitError(`Extraction stopped at ${Math.round(state.cap / GB)} GB, the most the Archiver writes ${state.cap === LIMITS.memoryTotal ? 'to browser memory. Save to a folder instead to extract more' : 'in one go'}.`);
    if (state.total > LIMITS.ratioFloor && state.total / Math.max(1, state.archiveSize) > LIMITS.maxRatio) throw new LimitError(`Extraction stopped: this archive expands more than ${LIMITS.maxRatio.toLocaleString('en-US')} times its size, which is how zip bombs work.`);
    yield chunk;
  }
}

// Yields { entry, chunks } for the chosen entries, in archive order. chunks is an async iterable that must be
// consumed before the next entry is requested. Only regular files with a safe path are yielded.
export async function* extractEntries(file, listing, ids, { password = null, cap = LIMITS.memoryTotal } = {}) {
  const wanted = new Set(ids);
  const state = { archiveSize: file.size, cap, total: 0 };
  const ok = (e) => wanted.has(e.id) && e.kind === 'file' && e.path;
  const { format, entries } = listing;
  if (format === 'zip') {
    for (const e of entries) if (ok(e)) yield { entry: e, chunks: guard(zipEntryChunks(file, e.zip, { password }), state) };
  } else if (format === 'tar' || format === 'tar.gz') {
    const reader = format === 'tar' ? new BlobReader(file) : new StreamReader(decompress(blobChunks(file), 'gzip'));
    let id = 0;
    for await (const t of readTar(reader)) {
      const e = entries[id++];
      if (!e || e.name !== t.name) throw new Error('The archive changed while it was open.');
      if (ok(e)) yield { entry: e, chunks: guard(t.chunks(), state) };
    }
  } else if (format === 'gz') {
    const e = entries[0];
    if (ok(e)) yield { entry: e, chunks: guard(decompress(blobChunks(file), 'gzip'), state) };
  }
}
