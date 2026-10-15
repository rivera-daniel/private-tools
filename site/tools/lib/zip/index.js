// ZIP reading and writing on in-memory bytes. Shared by the document inspectors, the cleaner and the
// archiver. Deflate runs on the browser's own CompressionStream. All input is hostile: every offset
// and size is checked against the file before use.
import { Bytes, concat, crc32, inflate, utf8 } from '../metadata/bytes.js';

export const ZIP_LIMITS = { maxEntries: 100000, maxEntryBytes: 1024 * 1024 * 1024 };
export const METHODS = { 0: 'Stored', 1: 'Shrunk', 6: 'Imploded', 8: 'Deflated', 9: 'Deflate64', 12: 'BZIP2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 98: 'PPMd', 99: 'AES encrypted' };
export const HOSTS = { 0: 'MS-DOS or Windows (FAT)', 3: 'Unix', 7: 'Macintosh', 10: 'Windows NTFS', 11: 'MVS', 19: 'macOS', 14: 'VFAT' };

const SIG = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, end64: 0x06064b50, locator64: 0x07064b50, descriptor: 0x08074b50 };
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

export const isZip = (u8) => u8.length >= 22 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7) && (u8[3] === 4 || u8[3] === 6 || u8[3] === 8);

export function decodeName(u8, utf8Flag) {
  if (utf8Flag || u8.every((b) => b < 0x80)) return utf8.decode(u8);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  if (!text.includes('�')) return text;
  return [...u8].map((b) => (b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80])).join('');
}

export function dosDate(date, time) {
  if (!date) return null;
  const d = new Date(Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2));
  return Number.isNaN(d.getTime()) ? null : d;
}

// DOS time has no time zone. Writers store local wall-clock time, so it is read and written as UTC
// here and shown without a zone.
export function toDos(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 1980 ? date : new Date(Date.UTC(1980, 0, 1));
  return {
    date: ((Math.min(d.getUTCFullYear(), 2107) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

function readExtra(b, start, length) {
  const fields = [];
  for (let o = start; o + 4 <= start + length;) {
    const id = b.u16(o, true); const size = b.u16(o + 2, true);
    if (o + 4 + size > start + length) break;
    fields.push({ id, offset: o, length: size + 4, data: b.slice(o + 4, size) });
    o += 4 + size;
  }
  return fields;
}

function findEnd(b) {
  for (let o = b.length - 22; o >= Math.max(0, b.length - 22 - 65535); o--) {
    if (b.u32(o, true) === SIG.end && o + 22 + b.u16(o + 20, true) <= b.length) return o;
  }
  return -1;
}

// Returns { entries, comment, end, centralOffset, centralSize, prefix, zip64 } or throws when the file is not a readable ZIP.
// prefix is the byte count before the first entry (self-extracting stubs, prepended data).
export function readZip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const b = new Bytes(u8);
  const end = findEnd(b);
  if (end < 0) throw new Error('no ZIP end-of-central-directory record');
  let count = b.u16(end + 10, true); let centralSize = b.u32(end + 12, true); let centralOffset = b.u32(end + 16, true);
  const comment = b.slice(end + 22, b.u16(end + 20, true));
  let zip64 = false;
  if (end >= 20 && b.u32(end - 20, true) === SIG.locator64) {
    const at = b.u64(end - 12, true);
    if (b.has(at, 56) && b.u32(at, true) === SIG.end64) { zip64 = true; count = b.u64(at + 32, true); centralSize = b.u64(at + 40, true); centralOffset = b.u64(at + 48, true); }
  }
  if (count > ZIP_LIMITS.maxEntries) throw new Error(`more than ${ZIP_LIMITS.maxEntries.toLocaleString('en-US')} entries`);
  // Data prepended to the archive shifts every offset. The central directory's real position reveals by how much.
  const centralEnd = zip64 ? end - 20 - 56 : end;
  let shift = 0;
  if (!b.has(centralOffset, 4) || b.u32(centralOffset, true) !== SIG.central) {
    const guess = centralEnd - centralSize;
    if (guess >= 0 && b.has(guess, 4) && b.u32(guess, true) === SIG.central) shift = guess - centralOffset;
    else if (count) throw new Error('central directory not found');
  }
  const entries = [];
  let o = centralOffset + shift;
  for (let i = 0; i < count; i++) {
    if (!b.has(o, 46) || b.u32(o, true) !== SIG.central) throw new Error('central directory is damaged');
    const flags = b.u16(o + 8, true);
    const nameLength = b.u16(o + 28, true); const extraLength = b.u16(o + 30, true); const commentLength = b.u16(o + 32, true);
    if (!b.has(o + 46, nameLength + extraLength + commentLength)) throw new Error('central directory is damaged');
    const nameBytes = b.slice(o + 46, nameLength);
    const extra = readExtra(b, o + 46 + nameLength, extraLength);
    let size = b.u32(o + 24, true); let compressedSize = b.u32(o + 20, true); let localOffset = b.u32(o + 42, true);
    const z64 = extra.find((f) => f.id === 0x0001);
    if (z64) {
      const zb = new Bytes(z64.data); let at = 0;
      if (size === 0xffffffff && zb.has(at, 8)) { size = zb.u64(at, true); at += 8; }
      if (compressedSize === 0xffffffff && zb.has(at, 8)) { compressedSize = zb.u64(at, true); at += 8; }
      if (localOffset === 0xffffffff && zb.has(at, 8)) { localOffset = zb.u64(at, true); at += 8; }
    }
    const name = decodeName(nameBytes, flags & 0x800);
    entries.push({
      index: i, name, nameBytes, directory: name.endsWith('/'),
      comment: decodeName(b.slice(o + 46 + nameLength + extraLength, commentLength), flags & 0x800),
      versionMadeBy: b.u16(o + 4, true), versionNeeded: b.u16(o + 6, true), flags, encrypted: (flags & 1) === 1,
      method: b.u16(o + 10, true), dosTime: b.u16(o + 12, true), dosDate: b.u16(o + 14, true),
      modified: dosDate(b.u16(o + 14, true), b.u16(o + 12, true)),
      crc: b.u32(o + 16, true), compressedSize, size,
      internalAttributes: b.u16(o + 36, true), externalAttributes: b.u32(o + 38, true),
      localOffset: localOffset + shift, centralOffset: o, centralLength: 46 + nameLength + extraLength + commentLength,
      extra,
    });
    o += 46 + nameLength + extraLength + commentLength;
  }
  for (const e of entries) locate(b, e);
  const first = entries.reduce((min, e) => Math.min(min, e.localOffset), centralOffset + shift);
  return { entries, comment: decodeName(comment, false), commentBytes: comment, end, centralOffset: centralOffset + shift, centralSize, prefix: Math.max(0, first), zip64, bytes: u8 };
}

// Adds where the entry's local header, data and data descriptor sit.
function locate(b, e) {
  e.localExtra = []; e.dataOffset = null; e.localLength = 0;
  if (!b.has(e.localOffset, 30) || b.u32(e.localOffset, true) !== SIG.local) return;
  const nameLength = b.u16(e.localOffset + 26, true); const extraLength = b.u16(e.localOffset + 28, true);
  e.localExtra = readExtra(b, e.localOffset + 30 + nameLength, extraLength);
  e.dataOffset = e.localOffset + 30 + nameLength + extraLength;
  let length = 30 + nameLength + extraLength + e.compressedSize;
  if (e.flags & 8) {
    const at = e.dataOffset + e.compressedSize;
    const big = e.size >= 0xffffffff || e.compressedSize >= 0xffffffff;
    const signed = b.has(at, 4) && b.u32(at, true) === SIG.descriptor;
    length += (signed ? 4 : 0) + (big ? 20 : 12);
  }
  e.localLength = b.has(e.localOffset, length) ? length : 0;
}

// The entry's stored bytes, still compressed.
export function rawEntry(zip, entry) {
  if (entry.dataOffset === null || entry.dataOffset + entry.compressedSize > zip.bytes.length) throw new Error(`${entry.name}: data is outside the file`);
  return zip.bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
}

// The entry's contents. Throws for encrypted entries, unsupported methods, size over the limit or a CRC mismatch.
export async function readEntry(zip, entry, limit = ZIP_LIMITS.maxEntryBytes) {
  if (entry.encrypted) throw new Error(`${entry.name}: encrypted`);
  const raw = rawEntry(zip, entry);
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = await inflate(raw, limit, 'deflate-raw');
  else throw new Error(`${entry.name}: ${METHODS[entry.method] ?? `method ${entry.method}`} compression is not supported`);
  if (data.length > limit) throw new Error(`${entry.name}: larger than the limit`);
  if (crc32(data) !== entry.crc) throw new Error(`${entry.name}: checksum mismatch`);
  return data;
}

export async function deflateRaw(u8) {
  const out = await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return new Uint8Array(out);
}

const encoder = new TextEncoder();

// entries: [{ name, data } | { name, raw, crc, size, method }], written in the given order.
// Optional per entry: method (0 stored, 8 deflated; default deflated unless that is larger), modified (Date,
// default 1980-01-01, which carries no information), comment, externalAttributes, unix (true marks a Unix
// host so externalAttributes hold a mode). ZIP64 records are added only when sizes or counts need them.
export async function writeZip(entries, { comment = '' } = {}) {
  const parts = []; const central = []; let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const flags = /[^\x20-\x7e]/.test(entry.name) || /[^\x20-\x7e]/.test(entry.comment ?? '') ? 0x800 : 0;
    let method; let body; let crc; let size;
    if (entry.raw) { method = entry.method; body = entry.raw; crc = entry.crc; size = entry.size; }
    else {
      size = entry.data.length; crc = crc32(entry.data);
      method = entry.method ?? 8;
      body = entry.data;
      if (method === 8) { const packed = await deflateRaw(entry.data); if (packed.length < size || entry.method === 8) body = packed; else method = 0; }
    }
    const big = size >= 0xffffffff || body.length >= 0xffffffff || offset >= 0xffffffff;
    const { date, time } = toDos(entry.modified);
    const version = big ? 45 : method === 8 ? 20 : 10;
    const localExtra = big ? zip64Extra([size, body.length]) : new Uint8Array();
    const local = new Uint8Array(30 + name.length + localExtra.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG.local, true); lv.setUint16(4, version, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, big ? 0xffffffff : body.length, true); lv.setUint32(22, big ? 0xffffffff : size, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, localExtra.length, true);
    local.set(name, 30); local.set(localExtra, 30 + name.length);

    const commentBytes = encoder.encode(entry.comment ?? '');
    const centralExtra = big ? zip64Extra([size, body.length, offset]) : new Uint8Array();
    const record = new Uint8Array(46 + name.length + centralExtra.length + commentBytes.length); const cv = new DataView(record.buffer);
    cv.setUint32(0, SIG.central, true); cv.setUint16(4, ((entry.unix ? 3 : 0) << 8) | version, true); cv.setUint16(6, version, true);
    cv.setUint16(8, flags, true); cv.setUint16(10, method, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, big ? 0xffffffff : body.length, true); cv.setUint32(24, big ? 0xffffffff : size, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, centralExtra.length, true); cv.setUint16(32, commentBytes.length, true);
    cv.setUint32(38, entry.externalAttributes ?? (entry.name.endsWith('/') ? 0x10 : 0), true);
    cv.setUint32(42, big ? 0xffffffff : offset, true);
    record.set(name, 46); record.set(centralExtra, 46 + name.length); record.set(commentBytes, 46 + name.length + centralExtra.length);

    parts.push(local, body); central.push(record);
    offset += local.length + body.length;
  }
  const centralSize = central.reduce((n, r) => n + r.length, 0);
  const tail = [];
  const needs64 = entries.length >= 0xffff || offset >= 0xffffffff || centralSize >= 0xffffffff;
  if (needs64) {
    const rec = new Uint8Array(56); const v = new DataView(rec.buffer);
    v.setUint32(0, SIG.end64, true); setU64(v, 4, 44); v.setUint16(12, 45, true); v.setUint16(14, 45, true);
    setU64(v, 24, entries.length); setU64(v, 32, entries.length); setU64(v, 40, centralSize); setU64(v, 48, offset);
    const loc = new Uint8Array(20); const lv = new DataView(loc.buffer);
    lv.setUint32(0, SIG.locator64, true); setU64(lv, 8, offset + centralSize); lv.setUint32(16, 1, true);
    tail.push(rec, loc);
  }
  const commentBytes = encoder.encode(comment);
  const end = new Uint8Array(22 + commentBytes.length); const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG.end, true);
  ev.setUint16(8, needs64 ? 0xffff : entries.length, true); ev.setUint16(10, needs64 ? 0xffff : entries.length, true);
  ev.setUint32(12, needs64 ? 0xffffffff : centralSize, true); ev.setUint32(16, needs64 ? 0xffffffff : offset, true);
  ev.setUint16(20, commentBytes.length, true); end.set(commentBytes, 22);
  return concat([...parts, ...central, ...tail, end]);
}

function setU64(view, at, n) { view.setUint32(at, n % 2 ** 32, true); view.setUint32(at + 4, Math.floor(n / 2 ** 32), true); }

function zip64Extra(values) {
  const out = new Uint8Array(4 + values.length * 8); const v = new DataView(out.buffer);
  v.setUint16(0, 0x0001, true); v.setUint16(2, values.length * 8, true);
  values.forEach((n, i) => setU64(v, 4 + i * 8, n));
  return out;
}

