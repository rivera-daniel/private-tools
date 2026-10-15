// Deterministic mutation fuzzer for the inspector and the cleaner. Each case mutates one corpus file with
// a seeded generator (bit flips, truncation, length-field inflation, duplicated and self-referencing
// structures, huge counts) and runs inspectFile and cleanFile in a child process. A case fails when either
// throws, the child crashes, a case runs past the time budget, peak memory passes the cap, or a cleaned
// output still contains, as readable metadata, a planted secret that was intact in the mutated input.
// "Readable" means the site's inspector or ExifTool (when installed) reports it in the cleaned file.
// Planted strings left only as bytes no parser recognises, and files a mutation turned into another
// format, are listed for review without failing. A handful of hand-built hostile files (entity expansion,
// deep nesting, a zip bomb with a lying size, reference cycles) run first.
//
//   node tests/independent/fuzz.mjs [--seed N] [--iterations N] [--jobs N] [--timeout ms] [--mem MB]
//                                   [--external] [--case N] [--only id-substring]
//
// --case N replays one case of the given seed and saves its input. Failing inputs go to test-results/fuzz/.
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { makeCorpus } from './make-corpus.mjs';
import { findTools, ExifTool } from './tools.mjs';
import { findSecrets } from './scan.mjs';
import { rawZip, docx } from '../fixtures/documents.js';
import { pdf, basic } from '../fixtures/pdf.js';
import { base, segment, jpegWith, exifSegment, tEXt, pngWith } from '../fixtures/build.js';
import { box, ebmlUnknown, id3v2, id3Text, mp3Frames, u32 } from '../fixtures/media.js';
import { readZip, readEntry, writeZip } from '../../site/lib/zip/index.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args[i + 1]; };
const SEED = Number(opt('seed', 1));
const ITERATIONS = Number(opt('iterations', 200));
const JOBS = Number(opt('jobs', Math.max(1, Math.min(8, availableParallelism() - 1))));
const TIMEOUT = Number(opt('timeout', 15000));
const MEM_MB = Number(opt('mem', 1024));
const ONLY = opt('only', '');
const CASE = opt('case', null);
const EXTERNAL = args.includes('--external');

// ---------- deterministic randomness ----------
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rngFor = (seed, i) => mulberry32(Math.imul(seed, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77));
const int = (r, n) => Math.floor(r() * n);
const pick = (r, list) => list[int(r, list.length)];

// ---------- structure finders: offsets of length fields and of whole units ----------
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => b.readUInt32BE(o);

function jpegUnits(b) {
  const out = [];
  for (let o = 2; o + 4 <= b.length && b[o] === 0xff;) {
    const m = b[o + 1]; if (m === 0xda || m === 0xd9) break;
    const len = be16(b, o + 2); out.push({ at: o, len: len + 2, field: [o + 2, 2, 'be'] }); o += 2 + len;
  }
  return out;
}
function pngUnits(b) {
  const out = [];
  for (let o = 8; o + 12 <= b.length;) { const len = be32(b, o); out.push({ at: o, len: len + 12, field: [o, 4, 'be'] }); o += 12 + len; if (len > b.length) break; }
  return out;
}
function riffUnits(b, le = true, start = 12) {
  const out = [{ at: 0, len: 0, field: [4, 4, le ? 'le' : 'be'] }];
  for (let o = start; o + 8 <= b.length;) { const len = le ? b.readUInt32LE(o + 4) : be32(b, o + 4); out.push({ at: o, len: 8 + len + (len & 1), field: [o + 4, 4, le ? 'le' : 'be'] }); o += 8 + len + (len & 1); if (len > b.length) break; }
  return out;
}
function boxUnits(b, from = 0, to = b.length, depth = 0, out = []) {
  for (let o = from; o + 8 <= to;) {
    const len = be32(b, o); const type = b.toString('latin1', o + 4, o + 8);
    if (len < 8 || o + len > to) break;
    out.push({ at: o, len, field: [o, 4, 'be'] });
    if (depth < 6 && /^(moov|trak|mdia|minf|stbl|udta|meta|ilst|edts|dinf)$/.test(type)) boxUnits(b, o + 8 + (type === 'meta' && b[o + 8] === 0 ? 4 : 0), o + len, depth + 1, out);
    o += len;
  }
  return out;
}
function zipUnits(b) {
  const out = [];
  for (let o = 0; o + 4 <= b.length; o++) {
    const sig = b.readUInt32LE(o);
    if (sig === 0x04034b50 && o + 30 <= b.length) out.push({ at: o, len: 30 + b.readUInt16LE(o + 26) + b.readUInt16LE(o + 28) + b.readUInt32LE(o + 18), field: pickZipField(o, [18, 22, 26, 28]) });
    else if (sig === 0x02014b50 && o + 46 <= b.length) out.push({ at: o, len: 46 + b.readUInt16LE(o + 28) + b.readUInt16LE(o + 30) + b.readUInt16LE(o + 32), field: pickZipField(o, [20, 24, 28, 30, 32, 42]) });
    else if (sig === 0x06054b50 && o + 22 <= b.length) out.push({ at: o, len: 22, field: pickZipField(o, [8, 10, 12, 16, 20]) });
  }
  return out;
}
let zipFieldSalt = 0;
function pickZipField(o, rel) { const r = rel[(zipFieldSalt++) % rel.length]; return [o + r, r === 26 || r === 28 || r === 30 || r === 32 || r === 8 || r === 10 || r === 20 ? 2 : 4, 'le']; }
function flacUnits(b) {
  const out = []; let o = b.indexOf('fLaC'); if (o < 0) return out; o += 4;
  for (; o + 4 <= b.length;) { const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; out.push({ at: o, len: 4 + len, field: [o + 1, 3, 'be'] }); if (b[o] & 0x80) break; o += 4 + len; }
  return out;
}
function ebmlUnits(b) {
  // Element headers with a 1-byte ID in the class-A range or 4-byte top-level IDs; sizes are vints.
  const out = [];
  for (const id of [[0x1a, 0x45, 0xdf, 0xa3], [0x18, 0x53, 0x80, 0x67], [0x15, 0x49, 0xa9, 0x66], [0x16, 0x54, 0xae, 0x6b], [0x12, 0x54, 0xc3, 0x67], [0x10, 0x43, 0xa7, 0x70], [0x19, 0x41, 0xa4, 0x69], [0x1f, 0x43, 0xb6, 0x75]]) {
    for (let o = b.indexOf(Buffer.from(id)); o >= 0; o = b.indexOf(Buffer.from(id), o + 1)) out.push({ at: o, len: 0, field: [o + 4, 0, 'vint'] });
  }
  return out;
}
function pdfFields(b) {
  const s = b.toString('latin1'); const out = [];
  for (const m of s.matchAll(/\/(Length|Count|N|First|Size|Prev|W|Index|Height|Width)\s+(\d+)/g)) out.push({ at: m.index + m[0].length - m[2].length, len: m[2].length, text: true });
  return out;
}

function unitsFor(family, b) {
  switch (family) {
    case 'jpeg': return jpegUnits(b);
    case 'png': return pngUnits(b);
    case 'webp': case 'wav': return riffUnits(b);
    case 'aiff': return riffUnits(b, false);
    case 'mp4': return boxUnits(b);
    case 'ooxml': case 'odf': case 'epub': case 'zip': return zipUnits(b);
    case 'flac': return flacUnits(b);
    case 'mkv': return ebmlUnits(b);
    default: return [];
  }
}

// ---------- mutators ----------
const INTERESTING = [0, 1, 2, 7, 8, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff];

function setField(b, [at, size, endian], value) {
  // EBML: an 8-byte size, all ones (unknown size) or the value.
  if (endian === 'vint') { if (at + 8 <= b.length) { b[at] = 0x01; for (let i = 1; i < 8; i++) b[at + i] = value === 0xffffffff ? 0xff : i < 4 ? 0 : (value >>> (8 * (7 - i))) & 0xff; } return; }
  if (at + size > b.length) return;
  for (let i = 0; i < size; i++) { const shift = 8 * (endian === 'le' ? i : size - 1 - i); b[at + i] = Number((BigInt(value >>> 0) >> BigInt(shift)) & 0xffn); }
}

const MUTATORS = {
  bitflip(r, b) { const n = 1 + int(r, 8); for (let i = 0; i < n && b.length; i++) b[int(r, b.length)] ^= 1 << int(r, 8); return { b, what: `${n} bit flips` }; },
  byte(r, b) { if (!b.length) return { b, what: 'noop' }; const at = int(r, b.length); b[at] = pick(r, [0, 0xff, 0x7f, 0x80, 0x01]); return { b, what: `byte @${at}` }; },
  truncate(r, b) { const at = int(r, b.length); return { b: b.subarray(0, at), what: `truncate @${at}` }; },
  truncateUnit(r, b, family) { const u = unitsFor(family, b); if (!u.length) return MUTATORS.truncate(r, b); const x = pick(r, u); const at = x.at + int(r, Math.max(1, x.len)); return { b: b.subarray(0, Math.min(at, b.length)), what: `truncate in unit @${x.at}` }; },
  inflate(r, b, family) {
    if (family === 'pdf') { const f = pdfFields(b); if (!f.length) return MUTATORS.bitflip(r, b); const x = pick(r, f); const v = String(pick(r, [0, 1, 999999999, 2147483648, 4294967296, -1])); return { b: Buffer.concat([b.subarray(0, x.at), Buffer.from(v), b.subarray(x.at + x.len)]), what: `pdf number @${x.at} -> ${v}` }; }
    const u = unitsFor(family, b); if (!u.length) return MUTATORS.bitflip(r, b);
    const x = pick(r, u); const v = pick(r, INTERESTING); setField(b, x.field, v); return { b, what: `length field @${x.field[0]} -> ${v}` };
  },
  duplicate(r, b, family) {
    const u = unitsFor(family, b).filter((x) => x.len > 0 && x.at + x.len <= b.length && x.at > 0);
    if (!u.length) { const at = int(r, b.length); const len = 1 + int(r, Math.min(64, b.length - at)); return { b: Buffer.concat([b.subarray(0, at), b.subarray(at, at + len), b.subarray(at)]), what: `dup bytes @${at}+${len}` }; }
    const x = pick(r, u); const n = pick(r, [1, 2, 10, 300, 3000]); const unit = b.subarray(x.at, x.at + x.len);
    if (unit.length * n > 32 * 1024 * 1024) return { b, what: 'noop' };
    return { b: Buffer.concat([b.subarray(0, x.at), ...Array(n + 1).fill(unit), b.subarray(x.at + x.len)]), what: `unit @${x.at} x${n + 1}` };
  },
  remove(r, b, family) { const u = unitsFor(family, b).filter((x) => x.len > 0 && x.at > 0); if (!u.length) return MUTATORS.truncate(r, b); const x = pick(r, u); return { b: Buffer.concat([b.subarray(0, x.at), b.subarray(x.at + x.len)]), what: `remove unit @${x.at}` }; },
  splice(r, b) { const at = int(r, b.length); const from = int(r, b.length); const len = int(r, Math.min(256, b.length - from)); return { b: Buffer.concat([b.subarray(0, at), b.subarray(from, from + len), b.subarray(at + len)]), what: `overwrite @${at} with @${from}+${len}` }; },
  selfref(r, b, family) {
    if (family === 'pdf') { const s = b.toString('latin1'); const ms = [...s.matchAll(/(\d+) 0 R/g)]; if (!ms.length) return MUTATORS.bitflip(r, b); const m = pick(r, ms); const own = /(\d+) 0 obj[^]*$/.exec(s.slice(0, m.index)); const t = own ? own[1] : '1'; return { b: Buffer.concat([b.subarray(0, m.index), Buffer.from(`${t} 0 R`), b.subarray(m.index + m[0].length)]), what: `pdf ref @${m.index} -> ${t} 0 R` }; }
    // Point a 4-byte offset-like value at its own position (TIFF IFD links, ZIP offsets).
    if (b.length < 8) return MUTATORS.bitflip(r, b); const at = int(r, b.length - 4); b.writeUInt32LE(Math.max(0, at - 6), at); return { b, what: `self offset @${at}` };
  },
};
const NAMES = Object.keys(MUTATORS);

function mutate(item, i) {
  const r = rngFor(SEED, i);
  let b = Buffer.from(item.data); const steps = [];
  const n = 1 + int(r, 3);
  for (let k = 0; k < n; k++) { const name = pick(r, NAMES); const res = b.length ? MUTATORS[name](r, b, item.family) : { b, what: 'empty' }; b = Buffer.from(res.b); steps.push(`${name}: ${res.what}`); }
  return { data: b, steps };
}

// ---------- hand-built hostile files ----------
async function hostile() {
  const out = [];
  const add = (id, name, family, data, options = {}) => out.push({ id, name, family, data: Buffer.from(data), secrets: [], policy: [], options });
  const parts = async (u8) => { const z = readZip(u8); const list = []; for (const e of z.entries) list.push({ name: e.name, data: await readEntry(z, e) }); return list; };
  const docxParts = await parts(await docx());
  const swap = (name, data) => docxParts.map((p) => (p.name === name ? { name, data: Buffer.from(data) } : p));
  const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">${Array.from({ length: 9 }, (_, k) => `<!ENTITY lol${k + 1} "${`&lol${k || ''};`.repeat(10)}">`).join('')}]><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>&lol9;</dc:creator></cp:coreProperties>`;
  add('docx-billion-laughs', 'laughs.docx', 'ooxml', await writeZip(swap('docProps/core.xml', laughs)));
  const deep = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:p>'.repeat(200000)}${'</w:p>'.repeat(200000)}</w:body></w:document>`;
  add('docx-deep-nesting', 'deep.docx', 'ooxml', await writeZip(swap('word/document.xml', deep)));
  const attrs = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p ${Array.from({ length: 100000 }, (_, k) => `a${k}="1"`).join(' ')}/></w:body></w:document>`;
  add('docx-huge-attributes', 'attrs.docx', 'ooxml', await writeZip(swap('word/document.xml', attrs)));
  // 256 MB of zeros deflated, with the header claiming 1000 bytes.
  const bombData = deflateRawSync(Buffer.alloc(256 * 1024 * 1024));
  const zip = Buffer.from(rawZip([{ name: 'bomb.xml', data: bombData }]));
  zip.writeUInt16LE(8, 8); zip.writeUInt32LE(1000, 22);
  const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); zip.writeUInt16LE(8, cd + 10); zip.writeUInt32LE(1000, cd + 24);
  add('zip-bomb-lying-size', 'bomb.zip', 'zip', zip);
  const bombDocx = Buffer.from(await writeZip([...docxParts, { name: 'customXml/item9.xml', raw: bombData, method: 8, crc: 0, size: 1000 }]));
  add('docx-zip-bomb-part', 'bomb.docx', 'ooxml', bombDocx);
  add('pdf-deep-arrays', 'deep.pdf', 'pdf', pdf(basic({ extra: { 6: `${'['.repeat(100000)}${']'.repeat(100000)}` }, catalog: '/Deep 6 0 R' }), { trailer: '/Root 1 0 R' }));
  add('pdf-kids-cycle', 'cycle.pdf', 'pdf', pdf({ ...basic(), 2: '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>' }, { trailer: '/Root 1 0 R' }));
  const cyc = pdf(basic(), { trailer: '/Root 1 0 R' }).toString('latin1');
  const sx = Number(/startxref\s+(\d+)/.exec(cyc)[1]);
  add('pdf-prev-cycle', 'prev.pdf', 'pdf', Buffer.from(cyc.replace('/Root 1 0 R', `/Root 1 0 R /Prev ${sx}`), 'latin1'));
  add('pdf-ascii85-zeros', 'a85.pdf', 'pdf', pdf(basic({ extra: { 6: { dict: '<< /Type /Metadata /Subtype /XML /Filter /ASCII85Decode >>', data: Buffer.from(`${'z'.repeat(8 << 20)}~>`), flate: false } }, catalog: '/Metadata 6 0 R' }), { trailer: '/Root 1 0 R' }));
  add('pdf-huge-count', 'count.pdf', 'pdf', pdf({ ...basic(), 2: '<< /Type /Pages /Kids [3 0 R] /Count 2147483647 >>' }, { trailer: '/Root 1 0 R' }));
  let nested = box('free', 'x'); for (let k = 0; k < 5000; k++) nested = box('udta', nested);
  add('mp4-deep-boxes', 'deep.mp4', 'mp4', Buffer.concat([box('ftyp', 'isom', u32(0), 'isom'), box('moov', nested)]));
  add('mp4-box-size-1-huge', 'huge.mp4', 'mp4', Buffer.concat([box('ftyp', 'isom', u32(0), 'isom'), Buffer.from([0, 0, 0, 1]), Buffer.from('mdat'), Buffer.from([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.alloc(64)]));
  let e = Buffer.alloc(0); for (let k = 0; k < 3000; k++) e = ebmlUnknown(0x1f43b675, e);
  add('mkv-deep-unknown', 'deep.mkv', 'mkv', Buffer.concat([Buffer.from('1a45dfa3a34286810142f7810142f2810442f381084282886d6174726f736b61', 'hex'), ebmlUnknown(0x18538067, e)]));
  add('mp3-many-frames', 'many.mp3', 'mpeg', Buffer.concat([id3v2(Array.from({ length: 20000 }, (_, k) => id3Text('TXXX', `k${k}`))), mp3Frames()]));
  // EXIF IFD0 whose next-IFD link points back at itself, and 10000 APP segments.
  const loop = Buffer.from('4d4d002a00000008000101310002000000040000000000000008', 'hex');
  add('jpeg-ifd-loop', 'loop.jpg', 'jpeg', jpegWith(exifSegment(loop)));
  add('jpeg-many-segments', 'many.jpg', 'jpeg', jpegWith(...Array.from({ length: 10000 }, () => segment(0xe5, Buffer.from('x')))));
  add('png-many-chunks', 'many.png', 'png', pngWith(...Array.from({ length: 50000 }, (_, k) => tEXt('k', String(k)))));
  return out;
}

// ---------- runner ----------
class Pool {
  constructor(n) { this.n = n; this.idle = []; for (let i = 0; i < n; i++) this.idle.push(this.spawn()); this.waiting = []; }
  spawn() { return fork(new URL('./fuzz-child.mjs', import.meta.url), [], { serialization: 'advanced', execArgv: ['--max-old-space-size=4096'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); }
  async get() { if (this.idle.length) return this.idle.pop(); return new Promise((r) => this.waiting.push(r)); }
  put(c) { const w = this.waiting.shift(); if (w) w(c); else this.idle.push(c); }
  run(job) {
    return this.get().then((child) => new Promise((resolve) => {
      let done = false; let peak = 0; let stderr = '';
      const finish = (res, replace) => {
        if (done) return; done = true; clearTimeout(timer); clearInterval(poll); child.removeAllListeners('message'); child.removeAllListeners('exit'); child.stderr.removeAllListeners('data');
        if (replace) { child.kill('SIGKILL'); this.put(this.spawn()); } else this.put(child);
        resolve({ ...res, peakMb: Math.max(res.peakMb ?? 0, peak) });
      };
      const timer = setTimeout(() => finish({ hang: true }, true), TIMEOUT);
      const poll = setInterval(() => {
        try {
          const m = /VmRSS:\s+(\d+) kB/.exec(procStatus(child.pid)); const mb = m ? Number(m[1]) / 1024 : 0;
          peak = Math.max(peak, mb); if (mb > MEM_MB) finish({ memory: true }, true);
        } catch { /* exited */ }
      }, 50);
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('message', (m) => finish(m.fatal ? { fatal: m.fatal } : m, !!m.fatal));
      child.on('exit', (code, signal) => finish({ fatal: `child exited (${code ?? signal}) ${stderr.slice(-300)}` }, true));
      child.send({ id: job.id, data: new Uint8Array(job.data), name: job.name, options: job.options });
    }));
  }
  close() { for (const c of this.idle) c.kill(); }
}
const procStatus = (pid) => readFileSync(`/proc/${pid}/status`, 'utf8');

// ExifTool judges leftovers whenever it is installed. --external also adds the externally generated corpus.
const found = findTools();
const tools = EXTERNAL ? found : { exiftool: found.exiftool };
const { items: corpus } = await makeCorpus(tools, { external: EXTERNAL });
const seeds = corpus.filter((x) => x.expect === 'clean');
const hostiles = (await hostile()).filter((x) => x.id.includes(ONLY));
const pool = new Pool(JOBS);
const outDir = new URL('../../test-results/fuzz/', import.meta.url);
const stats = new Map(); const failures = []; const review = [];
const et = tools.exiftool ? new ExifTool(tools.exiftool) : null;
const scratch = mkdtempSync(join(tmpdir(), 'pt-fuzz-'));
let scratchN = 0;
// Which leaked strings the inspector or ExifTool reads as metadata in the cleaned file.
async function readableBy(clean, item, leaked) {
  const out = new Set(leaked.filter((t) => clean.seen?.includes(t)));
  if (et) {
    const path = join(scratch, `${scratchN++}${item.name.slice(item.name.lastIndexOf('.'))}`);
    writeFileSync(path, clean.data);
    const text = JSON.stringify((await et.read(path)).tags);
    for (const t of leaked) if (text.includes(t)) out.add(t);
    rmSync(path, { force: true });
  }
  return [...out];
}
let maxPeak = 0; let maxMs = 0; let slowest = ''; let heaviest = '';
const stat = (family) => { if (!stats.has(family)) stats.set(family, { cases: 0, cleaned: 0, refused: 0, failures: 0 }); return stats.get(family); };

function save(label, item, data) {
  const file = `${label.replace(/[^\w./-]+/g, '_')}${item.name.slice(item.name.lastIndexOf('.'))}`;
  const url = new URL(file, outDir);
  mkdirSync(new URL('.', url), { recursive: true });
  writeFileSync(url, data);
  return file;
}

async function runCase(label, item, data, steps) {
  if (CASE !== null) console.log(`replay input: test-results/fuzz/${save(`replay/${label}`, item, data)}\nmutations: ${steps.join('; ')}`);
  const secrets = item.secrets.length ? [...new Set(findSecrets(data, item.secrets).map((h) => h.secret))] : [];
  const res = await pool.run({ id: label, data, name: item.name, options: item.options });
  const s = stat(item.family); s.cases++;
  if ((res.peakMb ?? 0) > maxPeak) { maxPeak = res.peakMb; heaviest = label; }
  const ms = (res.ms?.inspect ?? 0) + (res.ms?.clean ?? 0);
  if (ms > maxMs) { maxMs = ms; slowest = label; }
  const problems = [];
  if (res.hang) problems.push(`hang (over ${TIMEOUT} ms)`);
  if (res.memory) problems.push(`memory over ${MEM_MB} MB`);
  if (res.fatal) problems.push(`crash: ${res.fatal}`);
  if (res.inspectError) problems.push(`inspectFile threw: ${res.inspectError}`);
  if (res.cleanError) problems.push(`cleanFile threw: ${res.cleanError}`);
  if (res.peakMb > MEM_MB) problems.push(`peak memory ${Math.round(res.peakMb)} MB`);
  if (res.clean?.ok) {
    s.cleaned++;
    const leaked = secrets.length ? [...new Set(findSecrets(res.clean.data, secrets).map((h) => h.secret))] : [];
    if (leaked.length) {
      const became = res.inspect?.format !== item.format;
      // A PDF photo the image cleaner cannot rewrite is kept as is and listed as kept.
      const disclosed = res.clean.kept.find((k) => /images? with metadata|image cleaner could not read/.test(k));
      const readable = became || disclosed ? [] : await readableBy(res.clean, item, leaked);
      if (readable.length) problems.push(`cleaned output still holds readable metadata: ${readable.join(', ')}`);
      else save(`review/${label}`, item, data), review.push({ label, item: item.id, steps, kind: became ? `became ${res.inspect?.format ?? 'unknown'}` : disclosed ? `kept and listed: ${disclosed}` : 'unrecognised bytes', leaked });
    }
  } else if (res.clean) s.refused++;
  if (problems.length) {
    s.failures++;
    failures.push({ label, item: item.id, steps, problems, file: save(label, item, data) });
  }
}

const started = Date.now();
if (CASE === null) for (const h of hostiles) await runCase(`hostile-${h.id}`, h, h.data, ['hand-built']);
// --only skips cases without renumbering them, so a case number always names the same input.
const indices = CASE !== null ? [Number(CASE)] : Array.from({ length: ITERATIONS }, (_, i) => i).filter((i) => seeds[i % seeds.length].id.includes(ONLY));
let next = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < indices.length) {
    const i = indices[next++]; const item = seeds[i % seeds.length];
    const { data, steps } = mutate(item, i);
    await runCase(`seed${SEED}-case${i}-${item.id}`, item, data, steps);
  }
}));
pool.close();
et?.close();
rmSync(scratch, { recursive: true, force: true });

const total = [...stats.values()].reduce((a, s) => a + s.cases, 0);
console.log(`Fuzz seed ${SEED}: ${indices.length} mutated cases over ${seeds.length} corpus files, ${CASE === null ? hostiles.length : 0} hand-built hostile files, ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`Time budget ${TIMEOUT} ms per case (slowest ${Math.round(maxMs)} ms, ${slowest}), memory cap ${MEM_MB} MB (highest peak ${Math.round(maxPeak)} MB, ${heaviest})`);
console.log('family      cases  cleaned  refused  failures');
for (const [f, s] of [...stats].sort()) console.log(`${f.padEnd(10)} ${String(s.cases).padStart(6)} ${String(s.cleaned).padStart(8)} ${String(s.refused).padStart(8)} ${String(s.failures).padStart(9)}`);
console.log(`total      ${String(total).padStart(6)}`);
console.log(`judge of leftovers: site inspector${et ? ' and ExifTool' : ' only (ExifTool not found)'}`);
if (review.length) {
  console.log(`\nFor review, not failed (${review.length}): planted strings left where no parser reads them as metadata`);
  for (const x of review) console.log(`  ${x.label}: ${x.kind}; ${x.leaked.join(', ')} (${x.steps.join('; ')})`);
}
for (const f of failures) console.log(`\nFAIL ${f.label}\n  input: test-results/fuzz/${f.file}\n  mutations: ${f.steps.join('; ')}\n  ${f.problems.join('\n  ')}`);
process.exitCode = failures.length ? 1 : 0;
