// Streaming helpers shared by the archive readers and writers. Sources are async iterables of Uint8Array.

export const MB = 1024 * 1024;

// Reads blob[start, end) in chunks without loading it whole.
export async function* blobChunks(blob, start = 0, end = blob.size) {
  if (end <= start) return;
  const reader = blob.slice(start, end).stream().getReader();
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) return; if (value.length) yield value; }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function* bytesChunks(u8, size = MB) { for (let i = 0; i < u8.length; i += size) yield u8.subarray(i, i + size); }

// Pipes a source through a TransformStream such as CompressionStream, reading and writing concurrently.
export async function* through(source, transform) {
  const writer = transform.writable.getWriter(); const reader = transform.readable.getReader();
  let failure = null;
  const pump = (async () => {
    try { for await (const chunk of source) await writer.write(chunk); await writer.close(); }
    catch (error) { failure = error; await writer.abort(error).catch(() => {}); }
  })();
  try {
    for (;;) {
      let step;
      try { step = await reader.read(); } catch (error) { await pump; throw failure ?? error; }
      if (step.done) break;
      if (step.value.length) yield step.value;
    }
    await pump;
    if (failure) throw failure;
  } finally { await reader.cancel().catch(() => {}); }
}

export const compress = (source, format) => through(source, new CompressionStream(format));
export const decompress = (source, format) => through(source, new DecompressionStream(format));

// Calls fn(chunk) for each chunk while passing it on.
export async function* tap(source, fn) { for await (const chunk of source) { fn(chunk); yield chunk; } }

export async function collect(source) {
  const chunks = []; let total = 0;
  for await (const c of source) { chunks.push(c); total += c.length; }
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Output targets. write() takes ownership of the chunk. patch(offset, bytes) rewrites bytes already written
// and is only called after the last write. abort() discards the output.
//
// MemorySink builds a Blob. Runs of chunks are folded into Blobs as they arrive so the browser can move
// them out of the JavaScript heap. Chunks written with { pinned: true } stay as arrays so they can be patched.
export class MemorySink {
  constructor(type = 'application/octet-stream') { this.type = type; this.parts = []; this.loose = []; this.looseBytes = 0; this.pinned = []; this.size = 0; }
  async write(chunk, { pinned = false } = {}) {
    if (pinned) { this.fold(); this.parts.push(chunk); this.pinned.push({ offset: this.size, chunk }); }
    else { this.loose.push(chunk); this.looseBytes += chunk.length; if (this.looseBytes >= 32 * MB) this.fold(); }
    this.size += chunk.length;
  }
  fold() { if (this.loose.length) { this.parts.push(new Blob(this.loose)); this.loose = []; this.looseBytes = 0; } }
  async patch(offset, bytes) {
    let lo = 0; let hi = this.pinned.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.pinned[mid].offset <= offset) lo = mid; else hi = mid - 1; }
    const hit = this.pinned[lo];
    if (!hit || offset < hit.offset || offset + bytes.length > hit.offset + hit.chunk.length) throw new Error('patch outside a pinned chunk');
    hit.chunk.set(bytes, offset - hit.offset);
  }
  async close() { this.fold(); const blob = new Blob(this.parts, { type: this.type }); this.parts = []; this.pinned = []; return blob; }
  async abort() { this.parts = []; this.loose = []; this.pinned = []; }
}

// Writes to a FileSystemWritableFileStream (or anything with the same write/close/abort), coalescing
// small chunks into larger writes.
export class WritableSink {
  constructor(writable) { this.writable = writable; this.buffer = []; this.buffered = 0; this.size = 0; }
  async write(chunk) {
    this.buffer.push(chunk); this.buffered += chunk.length; this.size += chunk.length;
    if (this.buffered >= 4 * MB) await this.flush();
  }
  async flush() {
    if (!this.buffered) return;
    const data = this.buffer.length === 1 ? this.buffer[0] : new Blob(this.buffer);
    this.buffer = []; this.buffered = 0;
    await this.writable.write(data);
  }
  async patch(offset, bytes) { await this.flush(); await this.writable.write({ type: 'write', position: offset, data: bytes }); }
  async close() { await this.flush(); await this.writable.close(); return null; }
  async abort() { this.buffer = []; await this.writable.abort().catch(() => {}); }
}

// Sequential reader with exact reads over an async iterable source.
export class StreamReader {
  constructor(source) { this.it = source[Symbol.asyncIterator](); this.head = new Uint8Array(0); this.position = 0; this.ended = false; }
  async fill(n) {
    const parts = [this.head]; let have = this.head.length;
    while (have < n && !this.ended) {
      const { done, value } = await this.it.next();
      if (done) { this.ended = true; break; }
      parts.push(value); have += value.length;
    }
    if (parts.length > 1) { const all = new Uint8Array(have); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } this.head = all; }
  }
  // Returns up to n bytes (fewer only at the end of the source).
  async read(n) {
    if (this.head.length < n) await this.fill(n);
    const out = this.head.subarray(0, Math.min(n, this.head.length)); this.head = this.head.subarray(out.length); this.position += out.length;
    return out;
  }
  // Yields exactly n bytes in pieces, or fewer when the source ends early.
  async* chunks(n) {
    let left = n;
    while (left > 0) {
      if (!this.head.length) {
        if (this.ended) return;
        const { done, value } = await this.it.next();
        if (done) { this.ended = true; return; }
        this.head = value;
      }
      const piece = this.head.subarray(0, Math.min(left, this.head.length));
      this.head = this.head.subarray(piece.length); this.position += piece.length; left -= piece.length;
      yield piece;
    }
  }
  async skip(n) { let skipped = 0; for await (const c of this.chunks(n)) skipped += c.length; return skipped; }
  async close() { await this.it.return?.(); }
}

// The same interface over a Blob. skip() seeks without reading.
export class BlobReader {
  constructor(blob, position = 0) { this.blob = blob; this.position = position; }
  async read(n) {
    const end = Math.min(this.blob.size, this.position + n);
    const out = new Uint8Array(await this.blob.slice(this.position, end).arrayBuffer()); this.position = end;
    return out;
  }
  async* chunks(n) { const end = Math.min(this.blob.size, this.position + n); const start = this.position; this.position = end; yield* blobChunks(this.blob, start, end); }
  async skip(n) { const end = Math.min(this.blob.size, this.position + n); const skipped = end - this.position; this.position = end; return skipped; }
  async close() {}
}

export class Cancelled extends Error { constructor() { super('Cancelled'); this.name = 'Cancelled'; } }
