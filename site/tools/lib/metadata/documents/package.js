// Helpers shared by the ZIP-based document inspectors and cleaners: bounded part reads, path and URL
// classification, archive-level metadata and embedded images.
import { readEntry, HOSTS, METHODS } from '../../zip/index.js';
import { utf8, latin1, fmtBytes } from '../bytes.js';
import { detect, inspectImage } from '../index.js';
import { XmlError } from './xml.js';

export const DOC_LIMITS = {
  maxPartBytes: 32 * 1024 * 1024,   // one XML part
  maxReadBytes: 96 * 1024 * 1024,   // all parts read while inspecting or cleaning one file
  maxImageBytes: 160 * 1024 * 1024, // all embedded images read for one file
  maxImages: 200,
  maxListed: 500,
};

// Embedded-image formats the document cleaners rewrite. Images in other formats are reported but kept.
export const IMAGE_CLEANABLE = new Set(['JPEG', 'PNG', 'WebP', 'GIF']);

export const budget = (bytes) => ({ left: bytes });

// Reads one entry within the per-file budget. Returns null when the entry is over the limits.
export async function readPart(zip, entry, b, limit = DOC_LIMITS.maxPartBytes) {
  const cap = Math.min(limit, b.left);
  if (entry.size > cap) return null;
  const data = await readEntry(zip, entry, cap);
  b.left -= data.length;
  return data;
}

// Why a part could not be fully read, worded to follow its name in an incomplete-analysis warning.
export const TOO_LARGE = 'is larger than the inspection limit';
export const MISSING = 'is missing';
export function failure(error) {
  if (error instanceof XmlError) return error.limit ? TOO_LARGE : `is malformed (${error.message})`;
  return `could not be read (${error?.message ?? error})`;
}

// Reads and parses a part the analysis depends on. Returns { text } or { reason } when it cannot be fully read.
export async function readRequired(zip, entry, b, limit, parse) {
  if (!entry) return { reason: MISSING };
  let data;
  try { data = await readPart(zip, entry, b, limit); } catch (error) { return { reason: failure(error) }; }
  if (!data) return { reason: TOO_LARGE };
  const text = utf8.decode(data);
  if (!parse) return { text };
  try { return { text, doc: parse(text) }; } catch (error) { return { reason: failure(error) }; }
}

export async function readText(zip, entry, b, limit) {
  const data = await readPart(zip, entry, b, limit);
  return data && utf8.decode(data);
}

// Usernames inside home folder paths on Windows, macOS and Linux.
export function usersIn(s) {
  const out = new Set();
  for (const m of String(s).matchAll(/[\\/](?:Users|home|Documents and Settings)[\\/]([^\\/\s"'<>|:*?]{1,64})/gi)) {
    if (!/^(Public|Default|Default User|All Users|Shared|Guest|\.\.?)$/i.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

// Where a link points: 'remote' (fetching it is a network request, including Windows file shares),
// 'path' (an absolute local path), 'mail', or 'local' (relative to the document, or within it).
export function targetKind(target) {
  const s = String(target).trim();
  if (/^mailto:/i.test(s)) return 'mail';
  if (/^(\\\\|\/\/)[^\\/]/.test(s)) return 'remote';
  const file = /^file:(\/*)(.*)$/i.exec(s);
  if (file) return file[1].length === 2 && !/^localhost[\\/]/i.test(file[2]) ? 'remote' : 'path';
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\')) return 'path';
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(s)) return 'remote';
  return 'local';
}

// The last path segment alone, which an editor resolves next to the document without a network request.
export function bareName(target) {
  const s = String(target).split(/[?#]/)[0].replace(/[\\/]+$/, '');
  const last = s.split(/[\\/]/).pop().replace(/[:*?"<>|]/g, '');
  return last && last !== '.' && last !== '..' ? last : 'link';
}

export function entryBlock(r, kind, entry, extra = {}) {
  return r.block(kind, entry.localOffset, entry.localLength + entry.centralLength, { container: entry.name, entry: entry.name, ...extra });
}

// A rewrite inside a kept part. length is the size of the markup the cleaner removes.
export function rewriteBlock(r, kind, entry, length, extra = {}) {
  return r.block(kind, entry.localOffset, Math.max(1, length), { container: entry.name, entry: entry.name, rewrite: true, ...extra });
}

// Windows printer settings (DEVMODE) start with the printer name in UTF-16.
export function printerName(u8) {
  if (u8.length < 64) return '';
  const name = new TextDecoder('utf-16le').decode(u8.subarray(0, 64)).replace(/\0[\s\S]*$/, '').trim();
  return /^[\x20-\x7e\u00a0-\uffff]{1,32}$/.test(name) ? name : '';
}

// Usernames in paths stored inside binary parts (OLE packages record where the embedded file came from).
export function usersInBinary(u8) {
  const view = u8.subarray(0, 8 * 1024 * 1024);
  return [...new Set([...usersIn(latin1(view)), ...usersIn(new TextDecoder('utf-16le').decode(view.subarray(0, view.length & ~1)))])];
}

const LEFTOVER = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._[^/]*$)/i;
export const isLeftover = (name) => LEFTOVER.test(name);
const PLACEHOLDER_DATE = (e) => (e.dosDate === 0 || e.dosDate === 33) && e.dosTime === 0;

// Archive-level details every ZIP-based file shares: data around the archive, comments, timestamps,
// extra fields, operating system and Unix ids.
export function inspectArchive(zip, r) {
  const u8 = zip.bytes;
  if (zip.prefix > 0) {
    r.struct('Prepended data', 0, zip.prefix);
    r.block('Prepended data', 0, zip.prefix, { decoded: false, note: 'Data before the archive' });
    r.field('Archive', 'Data before the archive', fmtBytes(zip.prefix), { flag: 'privacy' });
    r.signal('privacy', 'Hidden data before the archive', `${fmtBytes(zip.prefix)} come before the first entry. Archive tools skip it.`, 'Archive', 'hidden data before the archive');
  }
  const tail = zip.end + 22 + zip.commentBytes.length;
  if (tail < u8.length) {
    r.struct('Trailing data', tail, u8.length - tail);
    r.block('Trailing data', tail, u8.length - tail, { decoded: false, note: 'Data after the end of the archive' });
    r.field('Archive', 'Data after the archive', fmtBytes(u8.length - tail), { flag: 'privacy' });
    r.signal('privacy', 'Hidden data after the archive', `${fmtBytes(u8.length - tail)} follow the end of the archive. Archive tools ignore it.`, 'Archive', 'hidden data after the archive');
  }
  r.struct('Central directory', zip.centralOffset, zip.centralSize, `${zip.entries.length} entries`);
  if (zip.comment) {
    r.field('Archive', 'Archive comment', zip.comment);
    r.add('Comments', 'Archive comment', zip.comment);
    r.block('Comment', zip.end + 22, zip.commentBytes.length, { container: 'Archive comment' });
  }
  const hosts = new Set(); const uids = new Set(); const gids = new Set(); const offsets = new Set();
  let details = 0; let encrypted = 0; let first = null; let last = null;
  const methods = new Set();
  for (const e of zip.entries) {
    hosts.add(e.versionMadeBy >> 8);
    methods.add(e.method);
    if (e.encrypted) encrypted++;
    if (e.comment) { details++; r.field('Archive', `Comment on ${e.name}`, e.comment); r.add('Comments', 'Entry comment', e.comment); }
    if (e.extra.length || e.localExtra.length) details++;
    if (!PLACEHOLDER_DATE(e)) {
      details++;
      if (e.modified) { if (!first || e.modified < first) first = e.modified; if (!last || e.modified > last) last = e.modified; }
    }
    for (const f of [...e.extra, ...e.localExtra]) {
      const d = new DataView(f.data.buffer, f.data.byteOffset, f.data.length);
      if (f.id === 0x7875 && f.data.length >= 3) {
        const us = f.data[1]; const gs = f.data[2 + us];
        if (us && us <= 4 && f.data.length >= 3 + us) uids.add(readLe(f.data, 2, us));
        if (gs && gs <= 4 && f.data.length >= 3 + us + gs) gids.add(readLe(f.data, 3 + us, gs));
      } else if (f.id === 0x7855 && f.data.length >= 4) { uids.add(d.getUint16(0, true)); gids.add(d.getUint16(2, true)); }
      else if (f.id === 0x5455 && f.data.length >= 5 && (f.data[0] & 1) && e.modified) {
        const utc = d.getUint32(1, true) * 1000;
        const minutes = Math.round((e.modified.getTime() - utc) / 900000) * 15;
        if (Math.abs(minutes) <= 14 * 60) offsets.add(minutes);
      } else if (f.id === 0x000a && f.data.length >= 32 && d.getUint16(4, true) === 1 && d.getUint16(6, true) >= 24) {
        const ms = Number(d.getBigUint64(8, true) / 10000n) - 11644473600000;
        const when = new Date(ms);
        if (!Number.isNaN(when.getTime()) && e.modified) {
          const minutes = Math.round((e.modified.getTime() - ms) / 900000) * 15;
          if (Math.abs(minutes) <= 14 * 60) offsets.add(minutes);
        }
      }
    }
  }
  for (const h of hosts) r.add('Software', 'Archive made on', HOSTS[h] ?? `Host system ${h}`);
  r.field('Archive', 'Entries', String(zip.entries.length));
  r.field('Archive', 'Compression', [...methods].map((m) => METHODS[m] ?? `Method ${m}`).join(', '));
  if (zip.zip64) r.field('Archive', 'ZIP64', 'Yes');
  if (first) { r.add('Dates', 'Earliest file date', fmtDos(first)); if (last > first) r.add('Dates', 'Latest file date', fmtDos(last)); }
  if (uids.size) { r.field('Archive', 'Unix user ID', [...uids].join(', ')); r.add('People', 'Unix user ID', [...uids].join(', ')); }
  if (gids.size) r.field('Archive', 'Unix group ID', [...gids].join(', '));
  if (offsets.size) {
    const zone = [...offsets].map((m) => `UTC${m < 0 ? '−' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`).join(', ');
    r.field('Archive', 'Time zone', zone); r.add('Dates', 'Time zone', zone);
    r.signal('privacy', 'Time zone revealed', `The archive stores both local and universal file times, which gives away the time zone ${zone}.`, 'Archive', 'time zone');
  }
  if (encrypted) r.field('Archive', 'Encrypted entries', String(encrypted));
  if (details) r.block('Archive details', zip.centralOffset, zip.centralSize, { container: 'Central directory', note: 'Entry times, extra fields and comments' });
  const users = new Set(zip.entries.flatMap((e) => usersIn(`/${e.name}`)));
  if (users.size) r.signal('privacy', 'Usernames in file paths', `Paths include the user name ${[...users].slice(0, 3).join(', ')}.`, 'Archive', 'usernames in paths');
  const leftovers = zip.entries.filter((e) => isLeftover(e.name));
  for (const e of leftovers) entryBlock(r, 'System leftovers', e, { note: 'Created by the operating system, not part of the content' });
  if (leftovers.length) r.signal('privacy', 'Operating system leftovers', `${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'} such as __MACOSX, .DS_Store or Thumbs.db record file names, folder views or thumbnails.`, 'Archive', 'system leftovers');
  checkOverlap(zip, r);
}

function readLe(u8, at, n) { let v = 0; for (let k = n - 1; k >= 0; k--) v = v * 256 + u8[at + k]; return v; }
const fmtDos = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

// Entries sharing or overlapping stored data are how small archives expand to enormous sizes.
function checkOverlap(zip, r) {
  const spans = zip.entries.filter((e) => e.dataOffset !== null && e.compressedSize > 0).map((e) => [e.localOffset, e.dataOffset + e.compressedSize]).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < spans.length; k++) {
    if (spans[k][0] < spans[k - 1][1]) { r.warn('Archive entries overlap each other, a sign of a damaged or malicious file.'); return; }
  }
}

// Embedded pictures go through the image inspector. Their findings are listed under the picture's path.
// A picture that cannot be read leaves the analysis incomplete: its metadata would go unchecked.
export async function inspectImages(r, zip, entries) {
  const b = budget(DOC_LIMITS.maxImageBytes); let n = 0;
  for (const [k, e] of entries.entries()) {
    if (n >= DOC_LIMITS.maxImages) { r.markIncomplete(`${entries.length - k} embedded images`, `were not inspected (more than ${DOC_LIMITS.maxImages})`); break; }
    let data;
    try { data = await readPart(zip, e, b, DOC_LIMITS.maxImageBytes); } catch (error) { r.markIncomplete(`Embedded image ${e.name}`, failure(error)); continue; }
    if (!data) { r.markIncomplete(`Embedded image ${e.name}`, TOO_LARGE); continue; }
    if (!detect(data)) continue;
    n++;
    const rep = await inspectImage(data);
    const source = `Embedded image ${e.name}`;
    for (const s of rep.sources) if (!s.technical) for (const f of s.fields) r.field(source, f.key, f.value, { group: s.name });
    for (const h of rep.highlights) for (const f of h.fields) r.add(h.name, f.key, f.value, { source: e.name });
    for (const s of rep.signals) r.signal(s.kind, s.title, `${e.name}: ${s.detail}`, source, s.short);
    if (imageNeedsCleaning(rep)) {
      const cleanable = IMAGE_CLEANABLE.has(rep.format);
      entryBlock(r, 'Embedded image metadata', e, cleanable ? { format: rep.format } : { format: rep.format, removable: false, note: `${rep.format} images cannot be cleaned here` });
    }
  }
}

// Media parts declared as video or audio are not pictures, so they are neither read nor counted
// against the picture budget.
export const declaredNonImage = (type) => /^(video|audio)\//i.test(String(type ?? ''));

// The image cleaner keeps a lone orientation tag, so a picture holding only that counts as clean.
export function imageNeedsCleaning(rep) {
  if (!rep.cleanable.blocks) return false;
  const meta = rep.sources.filter((s) => !s.technical);
  const onlyOrientation = meta.length === 1 && meta[0].name === 'EXIF IFD0' && meta[0].fields.every((f) => f.key === 'Orientation');
  return !(onlyOrientation && rep.blocks.filter((b) => b.removable !== false).every((b) => b.kind === 'EXIF'));
}

// Privacy signals shared by the document inspectors: [title, short phrase for the summary].
export const SIGNALS = {
  remote: ['Loads content from the internet when opened', 'remote content'],
  users: ['Usernames in file paths', 'usernames in paths'],
  tracked: ['Tracked changes with authors', 'tracked changes'],
  comments: ['Comments with authors', 'comments'],
  hidden: ['Hidden content', 'hidden content'],
  docvars: ['Hidden document variables', 'document variables'],
  macros: ['Macros (active content)', 'macros'],
  fingerprints: ['Editing session IDs', 'editing fingerprints'],
  notes: ['Speaker notes', 'speaker notes'],
  printer: ['Printer name stored', 'printer name'],
  embedded: ['Embedded files', 'embedded files'],
  custom: ['Custom properties', 'custom properties'],
  connection: ['Data connection details', 'data connections'],
  thumbnail: ['Embedded thumbnail preview', 'an embedded thumbnail'],
  signature: ['Digital signature names the signer', 'signer name'],
  store: ['Store account recorded', 'a store account'],
};
export const flag = (r, key, detail, source) => r.signal('privacy', SIGNALS[key][0], detail, source, SIGNALS[key][1]);
export function flagUsers(r, values, source) {
  const users = [...new Set(values.flatMap((v) => usersIn(v)))];
  if (users.length) flag(r, 'users', `Paths include the user name ${users.slice(0, 3).join(', ')}.`, source);
  return users;
}
export const sample = (s, n = 300) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
