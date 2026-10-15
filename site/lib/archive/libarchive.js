// Formats the Archiver does not read itself (7z, RAR, xz, bzip2, zstd, lzma, lz4, ISO 9660, CAB, cpio, ar and
// tar with those compressions) go through libarchive compiled to WebAssembly (see vendor/libarchive/NOTICE).
// It runs in the worker only: archives are read with FileReaderSync, one range at a time, when libarchive asks.
import { safePath } from './paths.js';
import { guard, LIMITS, LimitError } from './index.js';
import { Cancelled } from './streams.js';
import { WrongPassword } from '../zip/aes.js';
import { NeedsPassword } from '../zip/stream.js';

const BASE = '/vendor/libarchive/';
const BUFFER = 1024 * 1024;
const OK = 0; const EOF = 1; const WARN = -20;
const TYPE = { 0o100000: 'file', 0o040000: 'directory', 0o120000: 'symlink' };
// Compression-only formats: the file may hold a single compressed file rather than an archive.
export const COMPRESSED = new Set(['xz', 'bz2', 'zst', 'lzma', 'lz4']);

let loading = null;
const io = { file: null, reader: null, out: null };

function load() {
  loading ??= import(`${BASE}libarchive.js`).then(({ default: create }) => {
    const module = {
      locateFile: (path) => BASE + path,
      print: () => {}, printErr: () => {},
      readAt(offset, length, dst) {
        try {
          const bytes = new Uint8Array(io.reader.readAsArrayBuffer(io.file.slice(offset, offset + length)));
          module.HEAPU8.set(bytes, dst);
          return bytes.length;
        } catch { return -1; }
      },
      writeOut(src, length) { if (!io.out) return -1; io.out.push(module.HEAPU8.slice(src, src + length)); return length; },
    };
    return create(module);
  }).catch((error) => { loading = null; throw new Error(`The archive reader could not be loaded (${error.message}). Reload the page and try again.`); });
  return loading;
}

// Starts loading the WebAssembly module ahead of use, so archives open with the network turned off later.
export const preload = () => load().catch(() => { loading = null; });

const text = (M, ptr) => M.UTF8ToString(ptr);

// Decoding errors on encrypted data almost always mean the password is wrong.
const DAMAGED = /Damaged|Decompression failed|CRC|corrupt|Malformed|Truncated|Invalid|checksum|error/i;

function fail(message, format, { password = null, encrypted = false } = {}) {
  if (/Passphrase required/i.test(message)) return new NeedsPassword();
  if (password && encrypted && DAMAGED.test(message)) return new WrongPassword('The password is not correct, or the archive is damaged.');
  return new Error(friendly(message, format));
}

function friendly(message, format) {
  if (/Crypto codec not supported|encrypted|Encryption/i.test(message)) {
    if (format === 'rar') return 'This RAR archive is encrypted. Encrypted RAR archives cannot be opened in the browser.';
    return 'This archive is encrypted in a way the Archiver cannot open.';
  }
  if (/Unrecognized archive format/i.test(message)) return 'This file is not an archive the Archiver recognizes, or it is damaged.';
  if (/RAR solid|multivolume|multi-volume/i.test(message)) return `This archive cannot be opened: ${message}.`;
  return `The archive could not be read (${message}).`;
}

function open(M, file, format, password) {
  io.file = file; io.reader = new FileReaderSync();
  const pw = password ? M.stringToNewUTF8(password) : 0;
  const a = M._ar_open(file.size, pw, COMPRESSED.has(format) ? 1 : 0);
  if (pw) M._free(pw);
  if (!a) throw fail(text(M, M._ar_last_error()), format, { password, encrypted: true });
  return a;
}

function labelOf(M, a, format) {
  const name = text(M, M._ar_format(a));
  const filters = []; for (let i = 0; i < M._ar_filters(a); i++) { const f = text(M, M._ar_filter(a, i)); if (f && f !== 'none') filters.push(f); }
  const filter = filters[0] ?? '';
  if (/tar/i.test(name)) return filter ? `tar.${{ gzip: 'gz', bzip2: 'bz2', zstd: 'zst', lzma: 'lzma', xz: 'xz', lz4: 'lz4', compress: 'Z' }[filter] ?? filter} archive` : 'tar archive';
  if (/raw/i.test(name)) return `${filter || format} compressed file`;
  if (/7-Zip/i.test(name)) return '7z archive';
  if (/RAR5/i.test(name)) return 'RAR 5 archive';
  if (/RAR/i.test(name)) return 'RAR archive';
  if (/ISO9660/i.test(name)) return 'ISO 9660 disc image';
  if (/CAB/i.test(name)) return 'Cabinet archive';
  return `${name}${filter ? ` (${filter})` : ''}`;
}

// The single entry of a raw compressed file is named after the file.
const rawName = (file) => file.name.replace(/\.(xz|bz2|bzip2|zst|zstd|lzma|lz4)$/i, '') || 'file';

// Lists the archive. Returns { format, label, entries, warnings, native: false }.
export async function listArchive(file, format, { cancelled = () => false, password = null } = {}) {
  const M = await load();
  const a = open(M, file, format, password);
  const entries = []; const warnings = []; let declared = 0;
  try {
    for (;;) {
      if (cancelled()) throw new Cancelled();
      const r = M._ar_next(a);
      if (r === EOF) break;
      if (r !== OK && r !== WARN) {
        const error = fail(text(M, M._ar_error(a)), format, { password, encrypted: format === '7z' });
        if (!entries.length || error instanceof NeedsPassword || error instanceof WrongPassword) throw error;
        warnings.push(`The listing stopped early. ${error.message}`); break;
      }
      if (entries.length >= LIMITS.maxEntries) throw new LimitError(`This archive has more than ${LIMITS.maxEntries.toLocaleString('en-US')} entries, which is more than the Archiver opens.`);
      const raw = /raw/i.test(text(M, M._ar_format(a)));
      const name = raw ? rawName(file) : text(M, M._ar_path());
      const size = M._ar_size(); const mtime = M._ar_mtime();
      const kind = M._ar_hardlink() ? 'hardlink' : TYPE[M._ar_type()] ?? 'other';
      const { path, note } = safePath(name);
      entries.push({ id: entries.length, name, path, note: kind === 'directory' && note === 'empty' ? null : note, kind, size: kind === 'file' ? (size >= 0 ? size : null) : 0, compressedSize: null, modified: mtime > 0 ? new Date(mtime * 1000) : null, encrypted: M._ar_encrypted() === 1, weak: false, method: null });
      // Skipping an entry of a compressed tar decompresses it, so declared sizes are checked first: a tiny
      // file claiming terabytes would otherwise keep the reader busy with nothing to show for it.
      if (size > 0) declared += size;
      if (declared > LIMITS.diskTotal || (declared > LIMITS.ratioFloor && declared / Math.max(1, file.size) > LIMITS.maxRatio)) {
        throw new LimitError(`This archive claims to expand more than ${LIMITS.maxRatio.toLocaleString('en-US')} times its size, which is how zip bombs work, so it was not opened.`);
      }
      // A raw compressed file has one entry; skipping it would decompress the whole file for nothing.
      if (raw) break;
      if (M._ar_skip(a) < WARN) { warnings.push(`The listing stopped early. ${friendly(text(M, M._ar_error(a)), format)}`); break; }
    }
    const decrypts = format === '7z';
    if (entries.some((e) => e.encrypted) && !decrypts) warnings.push(friendly('encrypted', format));
    return { format, label: labelOf(M, a, format), entries, warnings, native: false, decrypts, password };
  } finally { M._ar_close(a); }
}

// Yields { entry, chunks } for the chosen entries in archive order, like index.js extractEntries.
export async function* extractEntries(file, listing, ids, { password = null, cap = LIMITS.memoryTotal, cancelled = () => false } = {}) {
  const M = await load();
  const wanted = new Set(ids);
  const state = { archiveSize: file.size, cap, total: 0 };
  password ||= listing.password ?? null;
  if (!password && listing.decrypts && listing.entries.some((e) => wanted.has(e.id) && e.encrypted)) throw new NeedsPassword();
  const a = open(M, file, listing.format, password);
  const buf = M._malloc(BUFFER);
  try {
    for (let id = 0; ; id++) {
      if (cancelled()) throw new Cancelled();
      const r = M._ar_next(a);
      if (r === EOF) return;
      if (r !== OK && r !== WARN) throw fail(text(M, M._ar_error(a)), listing.format, { password, encrypted: true });
      const e = listing.entries[id];
      if (!e) throw new Error('The archive changed while it was open.');
      if (!(wanted.has(e.id) && e.kind === 'file' && e.path)) continue;
      if (e.encrypted && !listing.decrypts) throw new Error(friendly('encrypted', listing.format));
      const chunks = (async function* () {
        let total = 0;
        for (;;) {
          const n = M._ar_data(a, buf, BUFFER);
          if (n === 0) break;
          if (n < 0) { const error = fail(text(M, M._ar_error(a)), listing.format, { password, encrypted: e.encrypted }); if (!(error instanceof WrongPassword || error instanceof NeedsPassword)) error.message = `${e.name}: ${error.message}`; throw error; }
          total += n;
          if (e.size !== null && total > e.size) throw new Error(`${e.name}: holds more data than the archive declares. The file is damaged or crafted.`);
          yield M.HEAPU8.slice(buf, buf + n);
        }
        if (e.size !== null && total !== e.size) throw new Error(`${e.name}: holds less data than the archive declares. The file is damaged.`);
      })();
      yield { entry: e, chunks: guard(chunks, state) };
    }
  } finally { M._free(buf); M._ar_close(a); }
}

export const SEVEN_Z_LIMIT = 1024 * 1024 * 1024;

// Writes a 7z archive (LZMA2) to the sink. entries: async iterable of { name, size, source, mtime, directory }.
// libarchive keeps the compressed data in WebAssembly memory until the end, so the input is limited.
export async function write7z(entries, sink, { cancelled = () => false } = {}) {
  const M = await load();
  const pending = []; io.out = pending;
  const drain = async () => { while (pending.length) await sink.write(pending.shift()); };
  const method = M.stringToNewUTF8('lzma2');
  const a = M._aw_open(method, 6); M._free(method);
  if (!a) { io.out = null; throw new Error(`7z: ${text(M, M._ar_last_error())}`); }
  const buf = M._malloc(BUFFER); let total = 0; let closed = false;
  try {
    for await (const entry of entries) {
      const path = M.stringToNewUTF8(entry.directory ? `${entry.name.replace(/\/$/, '')}/` : entry.name);
      const r = M._aw_header(a, path, entry.directory ? 0 : entry.size, entry.mtime ?? -1, entry.directory ? 1 : 0); M._free(path);
      if (r < WARN) throw new Error(`7z: ${text(M, M._ar_error(a))}`);
      if (entry.directory) continue;
      for await (const chunk of entry.source) {
        if (cancelled()) throw new Cancelled();
        total += chunk.length;
        if (total > SEVEN_Z_LIMIT) throw new LimitError('7z archives are limited to 1 GB of files here. Choose ZIP or tar.gz for more.');
        for (let o = 0; o < chunk.length; o += BUFFER) {
          const piece = chunk.subarray(o, o + BUFFER);
          M.HEAPU8.set(piece, buf);
          if (M._aw_data(a, buf, piece.length) < 0) throw new Error(`7z: ${text(M, M._ar_error(a))}`);
        }
        await drain();
      }
    }
    closed = true;
    if (M._aw_close(a) !== OK) throw new Error(`7z: ${text(M, M._ar_last_error())}`);
    await drain();
  } finally {
    if (!closed) M._aw_free(a);
    M._free(buf); io.out = null;
  }
}
