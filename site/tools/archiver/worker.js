// Archiver worker: creates, lists and extracts archives off the page's thread. Files arrive as File objects
// and output goes to a FileSystemWritableFileStream when the page picked a location, or to a Blob.
import { createArchive, listArchive, extractEntries, detectFormat, NATIVE, LIMITS, LimitError } from '/tools/lib/archive/index.js';
import { MemorySink, WritableSink, collect, Cancelled } from '/tools/lib/archive/streams.js';
import { ZipStreamWriter, NeedsPassword } from '/tools/lib/zip/stream.js';
import { WrongPassword } from '/tools/lib/zip/aes.js';
import { inspectFile } from '/tools/lib/metadata/index.js';
import { planExtraction, foldersToScan } from '/tools/lib/archive/destination.js';
import { lookup, createNew, removeCreated, scan, freshFolder, writeEntry } from '/tools/lib/archive/folder.js';

let current = null;
let libarchive = null;
// libarchive (7z, RAR, xz and more) is loaded right away so it is ready even if the network goes away.
import('/tools/lib/archive/libarchive.js').then((m) => { libarchive ??= m; m.preload(); }, () => {}); // { file, listing }
let cancel = false;
const cancelled = () => cancel;
let lastProgress = 0;

function progress(id, done, total, name) {
  const now = Date.now();
  if (now - lastProgress < 100 && done < total) return;
  lastProgress = now;
  self.postMessage({ type: 'progress', id, done, total, name });
}

function describe(error) {
  if (error instanceof Cancelled) return { cancelled: true, message: 'Cancelled.' };
  if (error instanceof NeedsPassword) return { needsPassword: true, message: error.message };
  if (error instanceof WrongPassword) return { needsPassword: true, wrongPassword: true, message: error.message };
  if (error instanceof LimitError) return { message: error.message };
  if (error?.name === 'QuotaExceededError') return { message: 'The disk or browser storage is full.' };
  if (error?.name === 'NotAllowedError') return { message: 'Permission to write there was not granted.' };
  return { message: error?.message || 'Something went wrong. The file may be damaged.' };
}

async function sinkFor(handle, type) {
  return handle ? new WritableSink(await handle.createWritable()) : new MemorySink(type);
}

const TYPES = { '7z': 'application/x-7z-compressed', zip: 'application/zip', tar: 'application/x-tar', 'tar.gz': 'application/gzip', gz: 'application/gzip' };

async function create({ id, items, options, handle }) {
  const sink = await sinkFor(handle, TYPES[options.format]);
  const out = await createArchive({ items, ...options, sink, cancelled, onProgress: (done, total, name) => progress(id, done, total, name) });
  self.postMessage({ type: 'created', id, blob: out.result, size: sink.size, cleaned: out.cleaned, kept: out.kept, count: out.entries.length });
}

// ZIP dates are wall-clock time read through UTC fields. They are shown as local dates like tar's.
const local = (d, wall) => (!d ? null : wall ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) : d);

// The listing sent to the page leaves out the parsed ZIP records.
const light = (e, format) => ({ id: e.id, name: e.name, path: e.path, note: e.note, kind: e.kind, size: e.size, compressedSize: e.compressedSize, modified: local(e.modified, format === 'zip'), encrypted: e.encrypted, weak: e.weak, method: e.method });

async function open({ id, file, password = null }) {
  current = null;
  const format = await detectFormat(file);
  if (!format) throw new Error('This file is not an archive the Archiver recognizes.');
  let listing = NATIVE.has(format) ? await listArchive(file, format, { cancelled }) : null;
  // ZIP entries compressed with bzip2, LZMA, XZ or Zstandard are read by libarchive instead.
  const foreign = listing?.format === 'zip' && listing.entries.some((e) => e.kind === 'file' && e.method !== 0 && e.method !== 8 && !e.encrypted);
  if (!listing || foreign) {
    libarchive ??= await import('/tools/lib/archive/libarchive.js');
    listing = await libarchive.listArchive(file, format, { cancelled, password });
  }
  current = { file, listing };
  self.postMessage({ type: 'listing', id, format: listing.format, label: listing.label ?? null, entries: listing.entries.map((e) => light(e, listing.format)), warnings: listing.warnings, size: file.size, decrypts: listing.native !== false || listing.decrypts === true, headerPassword: Boolean(password) });
}

function chunksOf(ids, password, cap) {
  const { file, listing } = current;
  return listing.native === false ? libarchive.extractEntries(file, listing, ids, { password, cap, cancelled }) : extractEntries(file, listing, ids, { password, cap });
}

function totalOf(ids) {
  const set = new Set(ids);
  return current.listing.entries.reduce((n, e) => n + (set.has(e.id) && e.kind === 'file' ? e.size ?? 0 : 0), 0);
}

function selection(ids) {
  const set = new Set(ids);
  return current.listing.entries.filter((e) => set.has(e.id) && e.path && (e.kind === 'file' || e.kind === 'directory')).map((e) => ({ id: e.id, path: e.path, kind: e.kind }));
}

// Preflight for mode 'here': what already exists where the chosen entries would go.
async function plan({ id, ids, dir }) {
  const entries = selection(ids);
  const result = planExtraction(entries, { existing: await scan(dir, foldersToScan(entries)) });
  self.postMessage({ type: 'planned', id, collisions: result.collisions, files: result.files.length });
}

// mode: 'new' (the default) extracts into a new folder named after the archive. 'here' extracts into dir
// itself, resolving names that already exist with choices from the preflight.
async function toFolder({ id, ids, password, dir, mode = 'new', choices = {} }) {
  const entries = selection(ids);
  const total = totalOf(ids); let done = 0; let written = 0; const failed = [];
  const created = [];
  let root = dir; let folder = null;
  try {
    if (mode !== 'here') ({ name: folder, handle: root } = await freshFolder(dir, current.file.name, created));
    const layout = planExtraction(entries, { existing: mode === 'here' ? await scan(root, foldersToScan(entries)) : new Map(), choices: mode === 'here' ? choices : {} });
    const handles = new Map([['', root]]);
    async function folderAt(path) {
      if (handles.has(path)) return handles.get(path);
      const slash = path.lastIndexOf('/');
      const parent = await folderAt(slash < 0 ? '' : path.slice(0, slash)); const name = path.slice(slash + 1);
      const handle = await lookup(parent, name, 'directory') ?? await createNew(parent, name, 'directory', created);
      if (!handle) throw new Error(`${path}: a file with this name is in the way.`);
      handles.set(path, handle); return handle;
    }
    for (const path of layout.directories) await folderAt(path).catch(() => {});
    const targets = new Map(layout.files.map((f) => [f.id, f]));
    for await (const { entry, chunks } of chunksOf(layout.files.map((f) => f.id), password, LIMITS.diskTotal)) {
      if (cancel) throw new Cancelled();
      const target = targets.get(entry.id); if (!target) continue;
      const slash = target.path.lastIndexOf('/');
      try {
        const parent = await folderAt(slash < 0 ? '' : target.path.slice(0, slash));
        await writeEntry(parent, target.path.slice(slash + 1), target.replace, chunks, created, (chunk) => {
          if (cancel) throw new Cancelled();
          done += chunk.length; progress(id, done, total, entry.path);
        });
        written++;
      } catch (error) {
        if (error instanceof Cancelled || error instanceof NeedsPassword || error instanceof WrongPassword || error instanceof LimitError) throw error;
        failed.push({ path: entry.path, reason: describe(error).message });
      }
    }
    self.postMessage({ type: 'extracted', id, written, failed, folder, skipped: layout.skipped.length, renamed: layout.renamed.filter((r) => r.reason !== 'portable').length, replaced: layout.files.filter((f) => f.replace).length });
  } catch (error) {
    // Stopped part way: remove only the empty folders this run created. Files already written stay.
    for (const item of [...created].reverse()) if (item.kind === 'directory') await removeCreated(created, item);
    throw error;
  }
}

// Re-packs the chosen entries as a plain ZIP, for browsers that cannot write to a folder.
async function toZip({ id, ids, password, handle }) {
  const sink = await sinkFor(handle, 'application/zip');
  const total = totalOf(ids); let done = 0;
  try {
    const writer = new ZipStreamWriter(sink);
    for await (const { entry, chunks } of chunksOf(ids, password, handle ? LIMITS.diskTotal : LIMITS.memoryTotal)) {
      const counted = (async function* () { for await (const c of chunks) { if (cancel) throw new Cancelled(); done += c.length; progress(id, done, total, entry.path); yield c; } })();
      await writer.add({ name: entry.path, size: entry.size ?? 0, source: counted, method: 8, modified: null });
    }
    const blob = await writer.finish();
    self.postMessage({ type: 'zipped', id, blob, size: sink.size });
  } catch (error) { await sink.abort(); throw error; }
}

// One entry, to a file the page picked or to a Blob.
async function one({ id, entryId, password, handle }) {
  const sink = await sinkFor(handle, 'application/octet-stream');
  const total = totalOf([entryId]); let done = 0; let found = false;
  try {
    for await (const { chunks } of chunksOf([entryId], password, handle ? LIMITS.diskTotal : LIMITS.memoryTotal)) {
      found = true;
      for await (const chunk of chunks) { if (cancel) throw new Cancelled(); await sink.write(chunk); done += chunk.length; progress(id, done, total, ''); }
    }
    if (!found) throw new Error('This entry cannot be extracted.');
    const blob = await sink.close();
    self.postMessage({ type: 'saved', id, entryId, blob });
  } catch (error) { await sink.abort(); throw error; }
}

async function inspect({ id, entryId, password }) {
  const entry = current.listing.entries.find((e) => e.id === entryId);
  if (entry.size > 200 * 1024 * 1024) throw new Error('Files larger than 200 MB cannot be inspected.');
  let data = null;
  for await (const { chunks } of chunksOf([entryId], password, 256 * 1024 * 1024)) data = await collect(chunks);
  if (!data) throw new Error('This entry cannot be extracted.');
  const name = entry.path.split('/').pop();
  const report = await inspectFile(data, name);
  const blob = new Blob([data]);
  self.postMessage({ type: 'inspected', id, entryId, name, blob, report: { format: report.format, category: report.category, summary: report.summary, signals: report.signals.filter((s) => s.kind === 'privacy' || s.kind === 'declared').map((s) => s.title), warnings: report.warnings.length, fields: report.fieldCount } });
}

// Checks a password on the smallest encrypted file. ZIP checks a verifier before any data; 7z has none,
// so its smallest file is decoded (its first megabyte when it is larger) to see whether that succeeds.
async function check({ id, password }) {
  const entry = current.listing.entries.filter((e) => e.encrypted && e.kind === 'file' && e.path).sort((x, y) => (x.size ?? 0) - (y.size ?? 0))[0];
  const whole = current.listing.native === false && (entry?.size ?? 0) <= 1024 * 1024;
  if (entry) for await (const { chunks } of chunksOf([entry.id], password, LIMITS.memoryTotal)) for await (const chunk of chunks) { if (!whole) break; void chunk; }
  self.postMessage({ type: 'checked', id });
}

const JOBS = { create, open, plan, toFolder, toZip, one, inspect, check };

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { cancel = true; return; }
  cancel = false;
  try { await JOBS[data.type](data); }
  catch (error) { self.postMessage({ type: 'error', id: data.id, ...describe(error) }); }
};
