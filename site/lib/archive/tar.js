// tar writing (ustar, with PAX records for long or non-ASCII names and sizes of 8 GB or more) and reading
// (ustar, GNU, PAX and old V7 headers). Input is hostile: every header is checksummed and every size checked.
const BLOCK = 512;
const encoder = new TextEncoder(); const decoder = new TextDecoder('utf-8', { fatal: false });
const MAX_OCTAL_SIZE = 8 ** 11 - 1;
const MAX_META = 1024 * 1024;

const ascii = (s) => /^[\x20-\x7e]*$/.test(s);
function putString(block, at, length, s) { const b = encoder.encode(s); block.set(b.subarray(0, length), at); }
function putOctal(block, at, length, n) { putString(block, at, length, Math.floor(n).toString(8).padStart(length - 1, '0') + '\0'); }
function putBase256(block, at, length, n) { for (let i = length - 1; i > 0; i--) { block[at + i] = n % 256; n = Math.floor(n / 256); } block[at] = 0x80; }

function checksum(block) { let sum = 0; for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]; return sum; }

function ustarHeader({ name, prefix = '', size, mtime, type, mode }) {
  const h = new Uint8Array(BLOCK);
  putString(h, 0, 100, name); putOctal(h, 100, 8, mode); putOctal(h, 108, 8, 0); putOctal(h, 116, 8, 0);
  if (size > MAX_OCTAL_SIZE) putBase256(h, 124, 12, size); else putOctal(h, 124, 12, size);
  putOctal(h, 136, 12, Math.max(0, Math.min(mtime, MAX_OCTAL_SIZE)));
  h[156] = type.charCodeAt(0);
  putString(h, 257, 6, 'ustar\0'); putString(h, 263, 2, '00');
  putOctal(h, 329, 8, 0); putOctal(h, 337, 8, 0);
  putString(h, 345, 155, prefix);
  putString(h, 148, 8, checksum(h).toString(8).padStart(6, '0') + '\0 ');
  return h;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`; const bodyLength = encoder.encode(body).length;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return `${length}${body}`;
}

// Splits a path into ustar's prefix and name fields when it fits, else returns null.
function splitUstar(path) {
  if (!ascii(path)) return null;
  if (path.length <= 100) return { name: path, prefix: '' };
  for (let i = path.lastIndexOf('/', 155); i > 0; i = path.lastIndexOf('/', i - 1)) {
    if (path.length - i - 1 <= 100 && i <= 155) return path.length - i - 1 > 0 ? { prefix: path.slice(0, i), name: path.slice(i + 1) } : null;
  }
  return null;
}

const pad = (n) => (BLOCK - (n % BLOCK)) % BLOCK;

// Yields the tar stream for entries: an iterable of { name, size, source, mtime (seconds), directory }.
// Owner IDs are 0, owner names empty, modes 644 and 755.
export async function* tarStream(entries) {
  for await (const entry of entries) {
    const directory = Boolean(entry.directory);
    const path = directory && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
    const size = directory ? 0 : entry.size;
    const fields = splitUstar(path);
    const records = [];
    if (!fields) records.push(paxRecord('path', path));
    if (size > MAX_OCTAL_SIZE) records.push(paxRecord('size', String(size)));
    if (records.length) {
      const body = encoder.encode(records.join(''));
      yield ustarHeader({ name: '././@PaxHeader', size: body.length, mtime: entry.mtime, type: 'x', mode: 0o644 });
      yield body; yield new Uint8Array(pad(body.length));
    }
    const fallback = fields ?? { name: [...path].filter((c) => c >= ' ' && c <= '~').join('').slice(-100) || 'file', prefix: '' };
    yield ustarHeader({ ...fallback, size, mtime: entry.mtime, type: directory ? '5' : '0', mode: directory ? 0o755 : 0o644 });
    if (directory) continue;
    let written = 0;
    for await (const chunk of entry.source) {
      written += chunk.length;
      if (written > size) throw new Error(`${entry.name}: changed while it was being archived.`);
      yield chunk;
    }
    if (written !== size) throw new Error(`${entry.name}: changed while it was being archived.`);
    yield new Uint8Array(pad(size));
  }
  yield new Uint8Array(BLOCK * 2);
}

function readString(block, at, length) { let end = at; while (end < at + length && block[end]) end++; return decoder.decode(block.subarray(at, end)); }

function readNumber(block, at, length) {
  if (block[at] & 0x80) {
    let n = block[at] & 0x7f;
    for (let i = 1; i < length; i++) { n = n * 256 + block[at + i]; if (n > Number.MAX_SAFE_INTEGER) return NaN; }
    return n;
  }
  const text = String.fromCharCode(...block.subarray(at, at + length)).replace(/[\0 ]+$/, '').replace(/^[ ]+/, '').replace(/\0.*$/, '');
  if (!text) return 0;
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN;
}

const isZero = (block) => block.every((b) => b === 0);

export function looksLikeTar(block) {
  if (block.length < BLOCK || isZero(block.subarray(0, BLOCK))) return false;
  const stored = readNumber(block, 148, 8);
  if (Number.isNaN(stored)) return false;
  const sum = checksum(block);
  let signed = 0; for (let i = 0; i < BLOCK; i++) signed += i >= 148 && i < 156 ? 32 : (block[i] << 24) >> 24;
  return stored === sum || stored === signed;
}

// PAX records are "<length> <key>=<value>\n" where length counts the bytes of the whole record, its own digits
// included. Values may contain newlines, so records are cut by their length, never by searching for one.
// A malformed record refuses the archive. A key given twice keeps its last value, as POSIX specifies.
function parsePax(bytes) {
  const out = Object.create(null); let at = 0;
  const damaged = () => new Error('A tar extended header is damaged.');
  while (at < bytes.length) {
    if (bytes.subarray(at).every((b) => b === 0)) break; // padding some writers leave after the last record
    let i = at; let length = 0;
    while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39 && i - at < 8) length = length * 10 + bytes[i++] - 0x30;
    if (i === at || bytes[i] !== 0x20) throw damaged();
    const end = at + length;
    if (end < i + 4 || end > bytes.length || bytes[end - 1] !== 0x0a) throw damaged();
    const record = bytes.subarray(i + 1, end - 1); const eq = record.indexOf(0x3d);
    if (eq <= 0) throw damaged();
    out[decoder.decode(record.subarray(0, eq))] = decoder.decode(record.subarray(eq + 1));
    at = end;
  }
  return out;
}

// GNU long name and long link records: the name, then NUL padding and nothing else.
function readLong(body) {
  const nul = body.indexOf(0); const end = nul < 0 ? body.length : nul;
  if (end === 0 || body.subarray(end).some((b) => b !== 0)) throw new Error('A tar long name record is damaged.');
  return decoder.decode(body.subarray(0, end));
}

const TYPES = { '0': 'file', '\0': 'file', '7': 'file', '5': 'directory', D: 'directory', '1': 'hardlink', '2': 'symlink', '3': 'device', '4': 'device', '6': 'fifo', S: 'sparse', V: 'label', M: 'multivolume' };

// Reads entries from a reader (StreamReader or BlobReader from streams.js). Yields
// { name, size, type, linkname, modified, chunks() }. Call chunks() to read the data; data not read is skipped.
export async function* readTar(reader) {
  let global = {}; let pax = {}; let longName = null; let longLink = null; let first = true;
  for (;;) {
    const block = await reader.read(BLOCK);
    if (block.length === 0) return;
    if (block.length < BLOCK) throw new Error('The tar archive is cut off.');
    if (isZero(block)) return;
    if (!looksLikeTar(block)) { if (first) throw new Error('This is not a tar archive.'); throw new Error('A tar header is damaged.'); }
    first = false;
    const flag = String.fromCharCode(block[156]);
    let size = readNumber(block, 124, 12);
    if (Number.isNaN(size)) throw new Error('A tar header has an invalid size.');
    if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
      if (size > MAX_META) throw new Error('A tar extended header is too large.');
      const body = await reader.read(size); await reader.skip(pad(size));
      if (body.length < size) throw new Error('The tar archive is cut off.');
      if (flag === 'x') pax = { ...pax, ...parsePax(body) };
      else if (flag === 'g') global = { ...global, ...parsePax(body) };
      else if (flag === 'L') longName = readLong(body);
      else longLink = readLong(body);
      continue;
    }
    // An empty value removes the attribute: the header's own field applies again.
    const meta = Object.fromEntries(Object.entries({ ...global, ...pax }).filter(([, v]) => v !== ''));
    if (meta.size !== undefined) { if (!/^\d+$/.test(meta.size)) throw new Error('A tar header has an invalid size.'); size = Number(meta.size); }
    if (size > Number.MAX_SAFE_INTEGER) throw new Error('A tar header has an invalid size.');
    const ustar = String.fromCharCode(...block.subarray(257, 262)) === 'ustar';
    let name = readString(block, 0, 100);
    if (ustar && String.fromCharCode(...block.subarray(257, 263)) === 'ustar\0') { const prefix = readString(block, 345, 155); if (prefix) name = `${prefix}/${name}`; }
    name = meta.path ?? longName ?? name;
    const linkname = meta.linkpath ?? longLink ?? readString(block, 157, 100);
    let type = TYPES[flag] ?? 'other';
    if (type === 'file' && name.endsWith('/')) type = 'directory';
    const mtime = meta.mtime !== undefined ? Number(meta.mtime) : readNumber(block, 136, 12);
    pax = {}; longName = null; longLink = null;
    // Symbolic links and ustar directories carry no data even when a size is set. GNU dumpdir entries ('D')
    // and PAX hard links with data do, and that data is skipped.
    const dataSize = type === 'symlink' || flag === '5' ? 0 : size;
    const start = reader.position;
    const entry = { name, size: dataSize, type, linkname, modified: Number.isFinite(mtime) && mtime > 0 ? new Date(mtime * 1000) : null, mode: readNumber(block, 100, 8) };
    let opened = false;
    entry.chunks = () => {
      if (opened) throw new Error('tar entry data can only be read once');
      opened = true;
      return (async function* () {
        let got = 0;
        for await (const chunk of reader.chunks(dataSize)) { got += chunk.length; yield chunk; }
        if (got < dataSize) throw new Error(`${name}: the tar archive is cut off.`);
      })();
    };
    yield entry;
    const consumed = reader.position - start;
    if (consumed > dataSize) throw new Error('tar reader went past an entry');
    const left = dataSize - consumed + pad(dataSize);
    if (await reader.skip(left) < left && dataSize - consumed > 0) throw new Error(`${name}: the tar archive is cut off.`);
  }
}
