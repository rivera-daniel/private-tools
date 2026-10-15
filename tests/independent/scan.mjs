// Byte-level secret scanner. It shares no code with the site: it looks for the planted strings in the raw
// bytes, in every zlib stream it can find, in every ZIP entry found by walking local headers (not the
// central directory), and in long base64 runs, in UTF-8, UTF-16 and hex spellings.
import { inflateSync, inflateRawSync, constants } from 'node:zlib';

const MAX_INFLATE = 64 * 1024 * 1024;
const MAX_ATTEMPTS = 20000;
const MAX_DEPTH = 3;

// The spellings a string can take inside a file.
function spellings(s) {
  const utf8 = Buffer.from(s, 'utf8');
  const le = Buffer.from(s, 'utf16le');
  const be = Buffer.from(le).swap16();
  const out = [['utf8', utf8], ['utf16le', le], ['utf16be', be]];
  for (const [name, b] of [['hex', utf8], ['hex-utf16be', be]]) {
    out.push([name, Buffer.from(b.toString('hex'))], [name, Buffer.from(b.toString('hex').toUpperCase())]);
  }
  return out.map(([enc, b]) => [enc, b.toString('latin1')]);
}

function inflateAt(u8, at, raw) {
  const opts = { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: MAX_INFLATE };
  try { return raw ? inflateRawSync(u8.subarray(at), opts) : inflateSync(u8.subarray(at), opts); } catch { return null; }
}

// Offsets that start a plausible zlib stream: deflate method, window <= 32K, header checksum, no preset dictionary.
function zlibStarts(u8) {
  const out = [];
  for (let i = 0; i + 2 < u8.length && out.length < MAX_ATTEMPTS; i++) {
    const cmf = u8[i]; const flg = u8[i + 1];
    if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || (flg & 0x20) || ((cmf << 8) | flg) % 31 !== 0) continue;
    out.push(i);
  }
  return out;
}

// Walks ZIP local file headers wherever they appear and returns their (decompressed) contents.
export function zipLocalEntries(u8) {
  const out = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = 0; i + 30 <= u8.length; i++) {
    if (u8[i] !== 0x50 || u8[i + 1] !== 0x4b || u8[i + 2] !== 3 || u8[i + 3] !== 4) continue;
    const flags = dv.getUint16(i + 6, true); const method = dv.getUint16(i + 8, true);
    const time = dv.getUint16(i + 10, true); const date = dv.getUint16(i + 12, true);
    let csize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true); const extraLen = dv.getUint16(i + 28, true);
    const start = i + 30 + nameLen + extraLen;
    if (start > u8.length) continue;
    const name = Buffer.from(u8.subarray(i + 30, i + 30 + nameLen)).toString('utf8');
    const extra = u8.subarray(i + 30 + nameLen, start);
    if (flags & 8 || csize === 0 || start + csize > u8.length) csize = u8.length - start;
    const comp = u8.subarray(start, start + csize);
    const data = method === 8 ? inflateAt(comp, 0, true) : method === 0 ? comp : null;
    out.push({ offset: i, name, method, flags, time, date, extra, data });
  }
  return out;
}

const B64 = /[A-Za-z0-9+/]{60,}={0,2}/g;

// Every view of the file worth scanning: [label, bytes].
function views(u8, label, depth, acc) {
  acc.push([label, u8]);
  if (depth >= MAX_DEPTH) return acc;
  for (const at of zlibStarts(u8)) {
    const d = inflateAt(u8, at, false);
    if (d && d.length) views(new Uint8Array(d.buffer, d.byteOffset, d.length), `${label} > zlib@${at}`, depth + 1, acc);
  }
  for (const e of zipLocalEntries(u8)) if (e.data && e.method === 8 && e.data.length) views(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.length), `${label} > zip:${e.name}`, depth + 1, acc);
  else if (e.data && e.method === 0 && e.data.length && depth + 1 < MAX_DEPTH) views(e.data, `${label} > zip:${e.name}`, depth + 1, acc);
  const text = Buffer.from(u8).toString('latin1');
  let n = 0;
  for (const m of text.matchAll(B64)) {
    if (++n > 200) break;
    const d = Buffer.from(m[0], 'base64');
    if (d.length) views(new Uint8Array(d.buffer, d.byteOffset, d.length), `${label} > base64@${m.index}`, depth + 1, acc);
  }
  return acc;
}

// Returns [{ secret, encoding, where }] for every planted string found.
export function findSecrets(u8, secrets) {
  const needles = secrets.map((s) => [s, spellings(s)]);
  const hits = [];
  for (const [where, bytes] of views(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8), 'file', 0, [])) {
    const hay = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    for (const [secret, forms] of needles) {
      for (const [encoding, needle] of forms) if (hay.includes(needle)) { hits.push({ secret, encoding, where }); break; }
    }
  }
  return hits;
}
