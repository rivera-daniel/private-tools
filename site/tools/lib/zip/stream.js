// Streaming ZIP writing and reading for archives larger than memory. The writer sends entries to a sink one
// chunk at a time and patches each local header once its sizes are known. The reader works on a Blob (a File
// in the browser) and only ever reads the central directory and the entry being extracted.
import { crc32 } from '../metadata/bytes.js';
import { compress, decompress, tap, blobChunks } from '../archive/streams.js';
import { ZIP_LIMITS, METHODS, decodeName, dosDate, toDos } from './index.js';
import { aesEncrypt, aesDecrypt, aesExtra, parseAesExtra, AES_STRENGTH, AES_MAC_BYTES, aesOverhead } from './aes.js';
import { zipCryptoDecrypt } from './zipcrypto.js';

const SIG = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, end64: 0x06064b50, locator64: 0x07064b50 };
const MAX32 = 0xffffffff;
const encoder = new TextEncoder();

function setU64(view, at, n) { view.setUint32(at, n % 2 ** 32, true); view.setUint32(at + 4, Math.floor(n / 2 ** 32), true); }
const u64 = (view, at) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;

function zip64Extra(values) {
  const out = new Uint8Array(4 + values.length * 8); const v = new DataView(out.buffer);
  v.setUint16(0, 0x0001, true); v.setUint16(2, values.length * 8, true);
  values.forEach((n, i) => setU64(v, 4 + i * 8, n));
  return out;
}

const join = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// Whether an entry of this many uncompressed bytes may need ZIP64 sizes. Deflate can grow incompressible
// data by a few bytes per 16 KB block, and encryption adds a fixed overhead.
export const mayNeedZip64 = (size) => size + Math.ceil(size / 1000) + 65536 >= MAX32;

// Writes ZIP entries to a sink (see archive/streams.js). Every entry carries only what ZIP requires:
// no timestamps beyond the DOS date, no extra fields except ZIP64 and AES, no comments, no Unix owner.
export class ZipStreamWriter {
  constructor(sink, { password = null, comment = '' } = {}) {
    this.sink = sink; this.password = password || null; this.comment = comment;
    this.offset = 0; this.central = []; this.patches = []; this.count = 0;
  }

  // entry: { name, size (uncompressed, used to decide on ZIP64), source (async iterable), method (0 or 8),
  // modified (Date as wall-clock time read through UTC fields, or null for 1980-01-01), directory }.
  async add({ name, size = 0, source = null, method = 8, modified = null, directory = false }) {
    if (directory && !name.endsWith('/')) name += '/';
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 0xffff) throw new Error(`${name}: name is too long`);
    const encrypted = Boolean(this.password) && !directory;
    if (directory) method = 0;
    const big = !directory && mayNeedZip64(size + (encrypted ? aesOverhead() : 0));
    const flags = (encrypted ? 1 : 0) | (/[^\x20-\x7e]/.test(name) ? 0x800 : 0);
    const version = encrypted ? 51 : big ? 45 : method === 8 ? 20 : 10;
    const { date, time } = toDos(modified);
    const extra = join(big ? zip64Extra([0, 0]) : new Uint8Array(), encrypted ? aesExtra(method) : new Uint8Array());

    const local = new Uint8Array(30 + nameBytes.length + extra.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG.local, true); lv.setUint16(4, version, true); lv.setUint16(6, flags, true);
    lv.setUint16(8, encrypted ? 99 : method, true); lv.setUint16(10, time, true); lv.setUint16(12, date, true);
    if (big) { lv.setUint32(18, MAX32, true); lv.setUint32(22, MAX32, true); }
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, extra.length, true);
    local.set(nameBytes, 30); local.set(extra, 30 + nameBytes.length);
    const localOffset = this.offset;
    await this.write(local, true);

    let crc = 0; let usize = 0; let csize = 0;
    if (!directory && source) {
      let data = tap(source, (chunk) => { crc = crc32(chunk, crc); usize += chunk.length; });
      if (method === 8) data = compress(data, 'deflate-raw');
      if (encrypted) data = aesEncrypt(data, this.password);
      for await (const chunk of data) { csize += chunk.length; await this.write(chunk); }
    } else if (encrypted) {
      for await (const chunk of aesEncrypt([], this.password)) { csize += chunk.length; await this.write(chunk); }
    }
    if (!big && (usize >= MAX32 || csize >= MAX32)) throw new Error(`${name}: grew past 4 GB while being written`);
    // AE-2 stores no CRC: the HMAC protects the data and a CRC of small files would leak their contents.
    const storedCrc = encrypted ? 0 : crc;

    const fix = new DataView(local.buffer);
    fix.setUint32(14, storedCrc, true);
    if (big) { setU64(fix, 30 + nameBytes.length + 4, usize); setU64(fix, 30 + nameBytes.length + 12, csize); }
    else { fix.setUint32(18, csize, true); fix.setUint32(22, usize, true); }
    this.patches.push([localOffset, local]);

    const over = [usize >= MAX32 ? usize : null, csize >= MAX32 ? csize : null, localOffset >= MAX32 ? localOffset : null].filter((n) => n !== null);
    const centralExtra = join(over.length ? zip64Extra(over) : new Uint8Array(), encrypted ? aesExtra(method) : new Uint8Array());
    const record = new Uint8Array(46 + nameBytes.length + centralExtra.length); const cv = new DataView(record.buffer);
    const needed = over.length ? Math.max(version, 45) : version;
    cv.setUint32(0, SIG.central, true); cv.setUint16(4, needed, true); cv.setUint16(6, needed, true);
    cv.setUint16(8, flags, true); cv.setUint16(10, encrypted ? 99 : method, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, storedCrc, true); cv.setUint32(20, csize >= MAX32 ? MAX32 : csize, true); cv.setUint32(24, usize >= MAX32 ? MAX32 : usize, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, centralExtra.length, true);
    cv.setUint32(38, directory ? 0x10 : 0, true); cv.setUint32(42, localOffset >= MAX32 ? MAX32 : localOffset, true);
    record.set(nameBytes, 46); record.set(centralExtra, 46 + nameBytes.length);
    this.central.push(record); this.count++;
    return { name, size: usize, compressedSize: csize, method, encrypted };
  }

  async write(chunk, pinned = false) { this.offset += chunk.length; await this.sink.write(chunk, { pinned }); }

  // Writes the central directory, patches the local headers and closes the sink.
  async finish() {
    const centralOffset = this.offset;
    for (const record of this.central) await this.write(record);
    const centralSize = this.offset - centralOffset;
    const needs64 = this.count >= 0xffff || centralOffset >= MAX32 || centralSize >= MAX32;
    if (needs64) {
      const rec = new Uint8Array(56); const v = new DataView(rec.buffer);
      v.setUint32(0, SIG.end64, true); setU64(v, 4, 44); v.setUint16(12, 45, true); v.setUint16(14, 45, true);
      setU64(v, 24, this.count); setU64(v, 32, this.count); setU64(v, 40, centralSize); setU64(v, 48, centralOffset);
      const loc = new Uint8Array(20); const lv = new DataView(loc.buffer);
      lv.setUint32(0, SIG.locator64, true); setU64(lv, 8, centralOffset + centralSize); lv.setUint32(16, 1, true);
      await this.write(rec); await this.write(loc);
    }
    const comment = encoder.encode(this.comment);
    const end = new Uint8Array(22 + comment.length); const ev = new DataView(end.buffer);
    ev.setUint32(0, SIG.end, true);
    ev.setUint16(8, needs64 ? 0xffff : this.count, true); ev.setUint16(10, needs64 ? 0xffff : this.count, true);
    ev.setUint32(12, needs64 ? MAX32 : centralSize, true); ev.setUint32(16, needs64 ? MAX32 : centralOffset, true);
    ev.setUint16(20, comment.length, true); end.set(comment, 22);
    await this.write(end);
    for (const [offset, bytes] of this.patches) await this.sink.patch(offset, bytes);
    this.central = []; this.patches = [];
    return this.sink.close();
  }
}

export class NeedsPassword extends Error { constructor() { super('This archive is encrypted. Enter its password.'); this.name = 'NeedsPassword'; } }

const read = async (blob, start, length) => new Uint8Array(await blob.slice(start, start + length).arrayBuffer());

// Reads the central directory of a ZIP held in a Blob. Returns { entries, comment, zip64, prefix }.
export async function openZipBlob(blob, { maxCentralBytes = 256 * 1024 * 1024 } = {}) {
  const tailStart = Math.max(0, blob.size - (22 + 0xffff + 20));
  const tail = await read(blob, tailStart, blob.size - tailStart); const tv = new DataView(tail.buffer);
  let end = -1;
  for (let o = tail.length - 22; o >= 0; o--) if (tv.getUint32(o, true) === SIG.end && o + 22 + tv.getUint16(o + 20, true) <= tail.length) { end = o; break; }
  if (end < 0) throw new Error('This is not a ZIP archive, or its end is missing.');
  let count = tv.getUint16(end + 10, true); let centralSize = tv.getUint32(end + 12, true); let centralOffset = tv.getUint32(end + 16, true);
  const comment = decodeName(tail.subarray(end + 22, end + 22 + tv.getUint16(end + 20, true)), false);
  const endAbs = tailStart + end;
  let zip64 = false; let centralEnd = endAbs;
  if (end >= 20 && tv.getUint32(end - 20, true) === SIG.locator64) {
    let at = u64(tv, end - 12);
    let rec = at + 56 <= blob.size ? await read(blob, at, 56) : new Uint8Array(0);
    if (rec.length !== 56 || new DataView(rec.buffer).getUint32(0, true) !== SIG.end64) { at = endAbs - 20 - 56; rec = at >= 0 ? await read(blob, at, 56) : new Uint8Array(0); }
    if (rec.length === 56 && new DataView(rec.buffer).getUint32(0, true) === SIG.end64) {
      const rv = new DataView(rec.buffer); zip64 = true; count = u64(rv, 32); centralSize = u64(rv, 40); centralOffset = u64(rv, 48); centralEnd = at;
    }
  }
  if (count > ZIP_LIMITS.maxEntries) throw new Error(`This archive lists more than ${ZIP_LIMITS.maxEntries.toLocaleString('en-US')} entries.`);
  if (centralSize > maxCentralBytes) throw new Error('The archive directory is too large to read.');
  let shift = 0;
  const sigAt = async (o) => o >= 0 && o + 4 <= blob.size && new DataView((await read(blob, o, 4)).buffer).getUint32(0, true) === SIG.central;
  if (count && !(await sigAt(centralOffset))) {
    const guess = centralEnd - centralSize;
    if (await sigAt(guess)) shift = guess - centralOffset; else throw new Error('The archive directory was not found. The file may be damaged.');
  }
  const cd = await read(blob, centralOffset + shift, centralSize); const v = new DataView(cd.buffer);
  const entries = [];
  for (let i = 0, o = 0; i < count; i++) {
    if (o + 46 > cd.length || v.getUint32(o, true) !== SIG.central) throw new Error('The archive directory is damaged.');
    const nameLength = v.getUint16(o + 28, true); const extraLength = v.getUint16(o + 30, true); const commentLength = v.getUint16(o + 32, true);
    if (o + 46 + nameLength + extraLength + commentLength > cd.length) throw new Error('The archive directory is damaged.');
    const flags = v.getUint16(o + 8, true);
    const nameBytes = cd.slice(o + 46, o + 46 + nameLength);
    let size = v.getUint32(o + 24, true); let compressedSize = v.getUint32(o + 20, true); let localOffset = v.getUint32(o + 42, true);
    let aes = null;
    for (let x = o + 46 + nameLength; x + 4 <= o + 46 + nameLength + extraLength;) {
      const id = v.getUint16(x, true); const len = v.getUint16(x + 2, true);
      if (x + 4 + len > o + 46 + nameLength + extraLength) break;
      if (id === 0x0001) {
        let at = x + 4; const stop = x + 4 + len;
        if (size === MAX32 && at + 8 <= stop) { size = u64(v, at); at += 8; }
        if (compressedSize === MAX32 && at + 8 <= stop) { compressedSize = u64(v, at); at += 8; }
        if (localOffset === MAX32 && at + 8 <= stop) { localOffset = u64(v, at); at += 8; }
      } else if (id === 0x9901) aes = parseAesExtra(cd.subarray(x + 4, x + 4 + len));
      x += 4 + len;
    }
    const versionMadeBy = v.getUint16(o + 4, true); const externalAttributes = v.getUint32(o + 38, true);
    const unixMode = versionMadeBy >> 8 === 3 || versionMadeBy >> 8 === 19 ? externalAttributes >>> 16 : 0;
    const name = decodeName(nameBytes, flags & 0x800);
    const method = v.getUint16(o + 10, true);
    const directory = name.endsWith('/') || name.endsWith('\\') || (unixMode & 0xf000) === 0x4000 || (externalAttributes & 0x10) === 0x10 && size === 0;
    entries.push({
      index: i, name, nameBytes, flags, method, realMethod: method === 99 && aes ? aes.method : method, aes,
      encrypted: (flags & 1) === 1, strong: (flags & 0x40) === 0x40,
      dosTime: v.getUint16(o + 12, true), modified: dosDate(v.getUint16(o + 14, true), v.getUint16(o + 12, true)),
      crc: v.getUint32(o + 16, true), size, compressedSize, localOffset: localOffset + shift,
      directory, symlink: (unixMode & 0xf000) === 0xa000,
    });
    o += 46 + nameLength + extraLength + commentLength;
  }
  // Entries must not share or overlap their data. Overlapping entries are how the smallest ZIP bombs work.
  const centralStart = centralOffset + shift;
  const sorted = entries.slice().sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]; const minEnd = e.localOffset + 30 + e.nameBytes.length + e.compressedSize;
    if (minEnd > centralStart) throw new Error(`${e.name}: its data runs into the archive directory. The file is damaged or crafted.`);
    if (i + 1 < sorted.length && minEnd > sorted[i + 1].localOffset) throw new Error('Entries in this archive overlap each other. That is how zip bombs are built, so it was not opened.');
  }
  return { entries, comment, zip64, prefix: sorted.length ? sorted[0].localOffset : centralStart };
}

// Yields an entry's contents. Checks the stored size, the CRC (or the AES authentication code) at the end
// and throws on any mismatch, so a consumer writing to disk must discard what it wrote when this throws.
export async function* zipEntryChunks(blob, entry, { password = null } = {}) {
  const head = await read(blob, entry.localOffset, 30); const hv = new DataView(head.buffer);
  if (head.length < 30 || hv.getUint32(0, true) !== SIG.local) throw new Error(`${entry.name}: the entry header is missing.`);
  const nameLength = hv.getUint16(26, true); const extraLength = hv.getUint16(28, true);
  const localName = await read(blob, entry.localOffset + 30, nameLength);
  if (localName.length !== entry.nameBytes.length || localName.some((b, i) => b !== entry.nameBytes[i])) throw new Error(`${entry.name}: the entry header does not match the directory.`);
  const start = entry.localOffset + 30 + nameLength + extraLength; const end = start + entry.compressedSize;
  if (end > blob.size) throw new Error(`${entry.name}: the data is cut off.`);
  if (entry.strong) throw new Error(`${entry.name}: PKWARE strong encryption is not supported.`);
  const method = entry.realMethod;
  if (method !== 0 && method !== 8) throw new Error(`${entry.name}: ${METHODS[method] ?? `method ${method}`} compression is not supported here.`);

  let data;
  if (entry.encrypted) {
    if (!password) throw new NeedsPassword();
    if (entry.method === 99) {
      if (!entry.aes) throw new Error(`${entry.name}: the AES settings are missing.`);
      const { salt: saltLength } = AES_STRENGTH[entry.aes.strength];
      if (entry.compressedSize < saltLength + 2 + AES_MAC_BYTES) throw new Error(`${entry.name}: the encrypted data is cut off.`);
      const salt = await read(blob, start, saltLength); const verifier = await read(blob, start + saltLength, 2);
      const mac = await read(blob, end - AES_MAC_BYTES, AES_MAC_BYTES);
      data = aesDecrypt(blobChunks(blob, start + saltLength + 2, end - AES_MAC_BYTES), { password, salt, verifier, mac, strength: entry.aes.strength });
    } else {
      if (entry.compressedSize < 12) throw new Error(`${entry.name}: the encrypted data is cut off.`);
      const header = await read(blob, start, 12);
      const check = entry.flags & 8 ? (entry.dosTime >> 8) & 0xff : entry.crc >>> 24;
      data = zipCryptoDecrypt(blobChunks(blob, start + 12, end), { password, header, check });
    }
  } else data = blobChunks(blob, start, end);
  if (method === 8) data = decompress(data, 'deflate-raw');

  let crc = 0; let total = 0;
  for await (const chunk of data) {
    total += chunk.length;
    if (total > entry.size) throw new Error(`${entry.name}: holds more data than the archive declares. The file is damaged or crafted.`);
    crc = crc32(chunk, crc);
    yield chunk;
  }
  if (total !== entry.size) throw new Error(`${entry.name}: holds less data than the archive declares. The file is damaged.`);
  const checkCrc = !(entry.method === 99 && entry.aes?.version === 2);
  if (checkCrc && crc !== entry.crc) throw new Error(`${entry.name}: checksum mismatch. The file is damaged${entry.encrypted && entry.method !== 99 ? ' or the password is wrong' : ''}.`);
}
