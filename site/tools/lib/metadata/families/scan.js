// The generic scan every file gets, whatever its format: true type, appended data, embedded files and
// readable personal details.
// Blocks added here are never removable, except hidden characters in plain text, which the text cleaner
// removes. Other families' cleaners must not be asked to remove what they did not report.
import { fmtBytes, hexPreview, startsWith } from '../bytes.js';
import { TEXT_EXT, expectedFor, extension, logicalEnd, sniff } from '../scan/magic.js';
import { HIDDEN_KINDS, decodeHidden, decodeText, hiddenRuns, lineCol, mixedScriptWords, textKind } from '../scan/text.js';
import { entropy, extractStrings, findDetails } from '../scan/strings.js';
import { findEmbedded } from '../scan/embedded.js';
import { certificate, tlv } from '../scan/der.js';

const TYPE = 'File type';
const TEXTUAL = new Set(['PostScript', 'RTF document']);
const FOUND = 'Text found in the file';
const GENERIC_EXT = new Set(['bin', 'dat', 'db', 'dmp', 'img', 'out', 'cap', 'key', 'raw', 'pkg', 'a', 'lib', 'o', 'tmp', 'bak', 'data', 'core']);
const AN = /^([AEIOaeio]|X\.|MP|xz|LZ|RPM|ar |ICO|ICNS|ISO|SQL|HTML|MIDI)/;
const article = (s) => `${AN.test(s) ? 'an' : 'a'} ${s}`;
const Article = (s) => article(s).replace(/^a/, 'A');
const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : (/(s|sh|ch|x)$/.test(w) ? 'es' : 's')}`;

// File types that are sensitive by nature: [title, detail, short].
const NETWORK = ['Network capture', 'Captured network traffic can include addresses, visited sites, messages and passwords sent without encryption.', 'captured network traffic'];
const SENSITIVE = {
  'Packet capture': NETWORK, 'Packet capture (pcapng)': NETWORK,
  'Windows memory dump': ['Memory dump', 'A memory dump holds a copy of a program’s memory, which can include passwords, keys and open documents.', 'a memory dump'],
  'Windows shortcut': ['Windows shortcut', 'Shortcuts record the target’s full path, the drive’s serial number and often the computer name and network card address.', 'a Windows shortcut'],
  'Finder folder data': ['Folder listing', 'This macOS file stores the names of the files in the folder it came from.', 'a folder listing'],
  'Windows registry hive': ['Windows registry data', 'Registry files record user names, recently opened files, devices and installed software.', 'registry data'],
  'Windows event log': ['Windows event log', 'Event logs record user names, computer names, sign-ins and program activity.', 'an event log'],
};
const CHAR_NAMES = { 0x200b: 'zero width space', 0x200c: 'zero width non-joiner', 0x200d: 'zero width joiner', 0x2060: 'word joiner', 0xfeff: 'zero width no-break space', 0x180e: 'Mongolian vowel separator', 0x202a: 'left-to-right embedding', 0x202b: 'right-to-left embedding', 0x202c: 'pop directional formatting', 0x202d: 'left-to-right override', 0x202e: 'right-to-left override', 0x2066: 'left-to-right isolate', 0x2067: 'right-to-left isolate', 0x2068: 'first strong isolate', 0x2069: 'pop directional isolate', 0x200e: 'left-to-right mark', 0x200f: 'right-to-left mark', 0x061c: 'Arabic letter mark', 0x00a0: 'no-break space', 0x00ad: 'soft hyphen', 0x202f: 'narrow no-break space', 0x3000: 'ideographic space', 0x3164: 'Hangul filler', 0xffa0: 'halfwidth Hangul filler' };
const cpName = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}${CHAR_NAMES[cp] ? ` ${CHAR_NAMES[cp]}` : ''}`;

export async function scanFile(b, r, ctx = {}) {
  const u8 = b.u8; const name = ctx.name ?? '';
  const ext = extension(name);
  if (!u8.length) { r.category ??= 'Other'; r.field(TYPE, 'Detected type', 'Empty file'); return; }
  // A byte order mark marks text even when the next bytes happen to look like a signature.
  const bom = (u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff) || (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf);
  let early = bom ? decodeText(u8) : null;
  let type = early ? null : sniff(u8);
  // Some signatures are plain words ("true", "MAC ", "%PDF-" anywhere in the head). When such a match
  // reads as text, it is text, unless the format itself is textual.
  if (type && !TEXTUAL.has(type.name) && !(type.name === 'PDF document' && startsWith(u8, '%PDF-')) && [...u8.subarray(0, 4)].every((x) => x === 9 || x === 10 || x === 13 || (x >= 0x20 && x < 0x7f))) {
    early = decodeText(u8);
    if (early) type = null;
  }
  const decoded = early ?? (type ? null : decodeText(u8));
  const kind = decoded ? textKind(decoded.text, ext) : null;

  if (r.format === null && (type?.own || decoded)) r.format = decoded ? 'Text' : type.name;
  r.category ??= type?.category ?? (decoded ? 'Document' : 'Other');
  r.field(TYPE, 'Detected type', type?.name ?? (decoded ? `Text (${kind})` : 'Unknown binary data'));
  r.field(TYPE, 'Category', r.category);
  if (ext) r.field(TYPE, 'Name extension', `.${ext}`);
  checkName(r, ext, type, decoded);
  if (type && SENSITIVE[type.name]) { const [title, detail, short] = SENSITIVE[type.name]; r.signal('privacy', title, detail, TYPE, short); }
  if (type?.key) r.signal('privacy', 'Private key in the file', `This is ${article(type.name)}. Anyone with the file can use the key to sign, decrypt or sign in as its owner.`, TYPE, 'a private key');
  if (type?.name === 'X.509 certificate') describeCert(r, u8);
  if (type?.name === 'SQLite') sqlite(r, b);
  if (!type && !decoded && u8.length >= 4096 && entropy(u8, 0, Math.min(u8.length, 1048576)) > 7.5) r.field(TYPE, 'Content', 'Looks compressed or encrypted');

  const trailers = appended(r, u8, type);
  embedded(r, u8, type, trailers, decoded);
  if (decoded) textFile(r, decoded, kind);
  details(r, u8, type, decoded, trailers);
}

function checkName(r, ext, type, decoded) {
  if (!ext || GENERIC_EXT.has(ext)) return;
  const expected = expectedFor(ext);
  let detail = '';
  if (type && (expected.length || TEXT_EXT.has(ext)) && !type.ext.includes(ext)) detail = `This file is really ${article(type.name)} named .${ext}.`;
  else if (decoded && expected.length && !TEXT_EXT.has(ext)) detail = `This file is really text named .${ext}.`;
  else if (!type && !decoded && expected.length) detail = `This file is named .${ext}, but its content is not ${article(expected[0].name)}.`;
  if (!detail) return;
  r.field(TYPE, 'Name check', detail, { flag: 'privacy' });
  r.signal('privacy', 'File type does not match its name', `${detail} Apps that trust the name can open it the wrong way, and misnamed files are a common way to hide content.`, TYPE, 'a misleading file name');
}

function describeCert(r, u8, source = 'Certificate') {
  const cert = certificate(u8, tlv(u8, 0));
  if (!cert) return;
  r.field(source, 'Subject', cert.subject.line);
  r.field(source, 'Issuer', cert.issuer.line);
  r.field(source, 'Valid from', cert.notBefore);
  r.field(source, 'Valid until', cert.notAfter);
  if (cert.subject.E) r.field(source, 'Email', cert.subject.E, { flag: 'privacy' });
}

function sqlite(r, b) {
  const page = b.u16(16) === 1 ? 65536 : b.u16(16);
  r.field('SQLite', 'Page size', fmtBytes(page));
  r.field('SQLite', 'Pages', String(b.u32(28)));
  r.field('SQLite', 'Text encoding', { 1: 'UTF-8', 2: 'UTF-16LE', 3: 'UTF-16BE' }[b.u32(56)] ?? String(b.u32(56)));
  if (b.u32(60)) r.field('SQLite', 'User version', String(b.u32(60)));
  if (b.u32(68)) r.field('SQLite', 'Application ID', `0x${b.u32(68).toString(16).padStart(8, '0')}`);
  const free = b.u32(36);
  r.field('SQLite', 'Free pages', String(free));
  if (free) r.signal('privacy', 'Deleted data may remain', `${plural(free, 'free page')} in this database can still hold rows that were deleted.`, 'SQLite', 'deleted data');
}

// Appended data the format's own parser did not report, plus what any trailer turns out to be.
function appended(r, u8, type) {
  const existing = r.blocks.filter((x) => x.kind === 'Trailer').map((x) => ({ offset: x.offset, length: x.length }));
  const reported = existing.length || r.signals.some((s) => /^Hidden data after/.test(s.title));
  const end = reported ? null : logicalEnd(u8, type);
  if (end !== null && end > 0 && end < u8.length) {
    const tail = u8.subarray(end);
    // A few bytes of padding are normal after many formats.
    if (tail.length > 16 || tail.some((x) => x !== 0 && x !== 0x0a && x !== 0x0d && x !== 0x20)) {
      r.block('Trailer', end, tail.length, { decoded: false, removable: false, note: `Data after the end of the ${type.name}` });
      r.struct('Appended data', end, tail.length, 'After the end of the format');
      r.signal('privacy', 'Hidden data after the end of the file', `${fmtBytes(tail.length)} follow the end of the ${type.name}. Apps that open it do not show this data.`, 'Appended data', 'hidden data after the end of the file');
      existing.push({ offset: end, length: tail.length });
    }
  }
  existing.slice(0, 4).forEach((t, i) => {
    const source = i ? `Appended data ${i + 1}` : 'Appended data';
    const tail = u8.subarray(t.offset, t.offset + t.length);
    const inner = sniff(tail);
    r.field(source, 'Offset', `0x${t.offset.toString(16).toUpperCase()}`);
    r.field(source, 'Size', fmtBytes(tail.length));
    if (inner) r.field(source, 'Content', Article(inner.name), { flag: 'privacy' });
    else if (tail.length >= 4096 && entropy(tail, 0, Math.min(tail.length, 1048576)) > 7.5) r.field(source, 'Content', 'Looks compressed or encrypted');
    r.field(source, 'Starts with', hexPreview(tail, 24));
    // Installers and self-extracting programs carry their payload this way by design.
    if (inner && r.category !== 'Program') r.signal('privacy', 'A file is hidden inside', `The data after the end of this file is ${article(inner.name)}.`, source, 'a hidden file');
  });
  return existing.map((t) => [t.offset, t.offset + t.length]);
}

function embedded(r, u8, type, trailers, decoded) {
  const category = type?.category ?? null;
  const pictures = new Set(['JPEG image', 'PNG image']);
  // Pictures inside images and programs are normal (previews, icons) unless they sit in a trailer.
  let ranges; let ignore = new Set();
  if (category === 'Image' || category === 'Program') { ranges = [[1, u8.length]]; ignore = pictures; }
  else if (!type) ranges = decoded ? [] : [[1, u8.length]];
  else ranges = trailers;
  const hits = findEmbedded(u8, ranges, { ignore });
  if (ignore.size) hits.push(...findEmbedded(u8, trailers, { max: 5 }).filter((h) => pictures.has(h.type)));
  const inTrailer = (o) => trailers.some(([a, z]) => o >= a && o < z);
  const seen = new Set();
  for (const h of hits.sort((a, c) => a.offset - c.offset)) {
    if (seen.has(h.offset)) continue; seen.add(h.offset);
    r.field('Embedded files', `${h.type} at 0x${h.offset.toString(16).toUpperCase()}`, inTrailer(h.offset) ? 'After the end of the file' : 'Inside the file');
    r.struct(`Embedded ${h.type}`, h.offset, 0, 'Signature found');
  }
  const hidden = hits.filter((h) => (inTrailer(h.offset) && category !== 'Program') || category === 'Image' || !type);
  if (hidden.length) r.signal('privacy', 'A file is hidden inside', `${Article(hidden[0].type)} starts at byte ${hidden[0].offset.toLocaleString('en-US')}${hidden.length > 1 ? `, with ${plural(hidden.length - 1, 'more embedded file')}` : ''}. The same bytes can open as a different kind of file.`, 'Embedded files', 'a hidden file');
}

function textFile(r, decoded, kind) {
  const { text, encoding } = decoded;
  r.field(TYPE, 'Text kind', kind);
  r.field(TYPE, 'Encoding', `${encoding}${decoded.bom ? ' with byte order mark' : ''}`);
  const lines = text ? (text.match(/\n/g)?.length ?? 0) + (text.endsWith('\n') ? 0 : 1) : 0;
  r.field(TYPE, 'Lines', lines.toLocaleString('en-US'));
  r.field(TYPE, 'Line endings', /\r\n/.test(text) ? (/[^\r]\n/.test(text) ? 'Mixed' : 'Windows (CRLF)') : /\n/.test(text) ? 'Unix (LF)' : /\r/.test(text) ? 'Classic Mac (CR)' : 'None');
  if (decoded.truncated) r.warn('Only the first 32 MB of text was checked for hidden characters.');
  if (kind === 'PEM') pem(r, text);
  if (kind === 'PuTTY key') r.signal('privacy', 'Private key in the file', 'This is a PuTTY private key. Anyone with the file can use the key to sign in as its owner.', TYPE, 'a private key');
  if (kind === 'vCard contacts') r.signal('privacy', 'Contact details', `${plural((text.match(/^BEGIN:VCARD/gim) ?? []).length, 'contact card')} with names and contact details.`, TYPE, 'contact details');
  if (kind === 'Email message') email(r, text);

  const runs = hiddenRuns(text, { encoding });
  const byKind = new Map();
  for (const run of runs) { if (!byKind.has(run.kind)) byKind.set(run.kind, []); byKind.get(run.kind).push(run); }
  for (const [k, list] of byKind) {
    const gone = list.filter((x) => x.removable);
    const chars = [...new Set(list.map((x) => x.cp))].slice(0, 6).map(cpName).join(', ');
    const state = gone.length === list.length ? '' : gone.length ? `, ${gone.length.toLocaleString('en-US')} of them hidden` : ', all in normal use';
    r.field('Hidden characters', HIDDEN_KINDS[k], `${list.length.toLocaleString('en-US')}${state}. First at ${lineCol(text, list[0].at)}. ${chars}`, gone.length && k !== 'bom' ? { flag: 'privacy' } : {});
    // Only plain text is cleaned by this module's cleaner. Other text formats belong to their own families.
    if (r.format === 'Text' && gone.length) r.block(HIDDEN_KINDS[k], byteOffset(text, gone[0].at, encoding), gone.reduce((n, x) => n + byteLength(x, encoding), 0), { container: 'Text', note: plural(gone.length, 'character') });
  }
  const count = (k) => byKind.get(k)?.filter((x) => x.removable).length ?? 0;
  const secret = decodeHidden(text, runs.filter((x) => x.removable));
  if (secret.tags) r.field('Hidden characters', 'Hidden text (tag characters)', secret.tags, { flag: 'privacy' });
  if (secret.selectors) r.field('Hidden characters', 'Hidden text (variation selectors)', secret.selectors, { flag: 'privacy' });
  const quote = (s) => (s ? ` Hidden text: “${s.slice(0, 160)}”.` : '');
  if (count('tag')) r.signal('privacy', 'Invisible tag characters', `Tag characters (${count('tag')} found) hide text that does not show on screen but is read by software, a known way to slip instructions to AI tools.${quote(secret.tags)}`, 'Hidden characters', 'invisible tag characters');
  if (count('vs')) r.signal('privacy', 'Data hidden in variation selectors', `Runs of variation selectors (${count('vs')} found) encode hidden bytes after a visible character.${quote(secret.selectors)}`, 'Hidden characters', 'data hidden in variation selectors');
  if (count('zw')) r.signal('privacy', 'Zero-width characters', `Invisible characters (${count('zw')} found). Patterns of them can carry a watermark that identifies who received this copy.`, 'Hidden characters', 'zero-width characters');
  if (count('bidi')) r.signal('privacy', 'Text direction controls', `Characters that reorder text on screen (${count('bidi')} found), so it can read differently to people than to software (the Trojan Source technique).`, 'Hidden characters', 'text direction controls');
  if (count('filler')) r.signal('privacy', 'Invisible filler characters', `Hangul filler characters (${count('filler')} found) display as blank space and are used to make names and text invisible.`, 'Hidden characters', 'invisible filler characters');
  const mixed = mixedScriptWords(text);
  if (mixed.count) {
    r.field('Hidden characters', 'Look-alike letters', `${plural(mixed.count, 'word')} mixing Latin with Cyrillic or Greek letters: ${mixed.samples.join(', ')}`, { flag: 'privacy' });
    r.signal('privacy', 'Look-alike letters', `Words that mix Latin letters with look-alike Cyrillic or Greek letters (${mixed.count} found), such as “${mixed.samples[0]}”. This disguises names, links and commands.`, 'Hidden characters', 'look-alike letters');
  }
  const escapes = (text.match(/\x1b\[[0-9;?]{0,32}[A-Za-z]/g) ?? []).length;
  if (escapes) r.field('Hidden characters', 'Terminal escape codes', `${escapes.toLocaleString('en-US')}. They change how text looks in a terminal and can hide parts of it.`);
}

const byteOffset = (text, index, encoding) => (encoding.startsWith('UTF-16') ? index * 2 : new TextEncoder().encode(text.slice(0, index)).length);
const byteLength = (run, encoding) => (encoding.startsWith('UTF-16') ? (run.end - run.at) * 2 : run.cp < 0x80 ? 1 : run.cp < 0x800 ? 2 : run.cp < 0x10000 ? 3 : 4);

function pem(r, text) {
  const labels = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]{1,40})-----/g)].map((m) => m[1]);
  r.field('PEM', 'Blocks', [...new Set(labels)].map((l) => `${l} × ${labels.filter((x) => x === l).length}`).join(', '));
  if (labels.some((l) => /PRIVATE KEY/.test(l))) r.signal('privacy', 'Private key in the file', 'The file holds a private key. Anyone with the file can use it to sign, decrypt or sign in as its owner.', 'PEM', 'a private key');
  let n = 0;
  for (const m of text.matchAll(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]{1,200000}?)-----END CERTIFICATE-----/g)) {
    if (++n > 5) break;
    try { describeCert(r, Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0)), n === 1 ? 'Certificate' : `Certificate ${n}`); } catch { /* not base64 */ }
  }
}

function email(r, text) {
  const head = text.slice(0, 65536).split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  for (const line of head.split(/\r?\n/)) {
    const m = /^(From|To|Cc|Reply-To|Date|Subject|Message-ID|X-Mailer|User-Agent|X-Originating-IP)\s*:\s*(.{1,500})/i.exec(line);
    if (m) r.field('Email headers', m[1], m[2], /^(From|To|Cc|Reply-To|X-Originating-IP)$/i.test(m[1]) ? { flag: 'privacy' } : {});
  }
  const hops = (head.match(/^Received:/gim) ?? []).length;
  if (hops) r.field('Email headers', 'Servers passed', String(hops));
  r.signal('privacy', 'Email headers', 'The headers name the sender and recipients and list the mail servers the message passed through, often with IP addresses.', 'Email headers', 'email headers');
}

// Personal details in readable strings. Images are scanned only in their metadata and trailers: pixel
// data holds no text, and random bytes there only produce noise.
function details(r, u8, type, decoded, trailers) {
  const image = (type?.category ?? r.category) === 'Image';
  let text;
  if (decoded) text = decoded.text;
  else {
    let ranges;
    if (image) {
      ranges = [...r.blocks.filter((x) => Number.isInteger(x.offset) && x.length > 0).map((x) => [x.offset, Math.min(u8.length, x.offset + x.length)]), ...trailers].sort((a, c) => a[0] - c[0]);
      const merged = []; for (const g of ranges) { const last = merged.at(-1); if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]); else merged.push([...g]); }
      ranges = merged;
    } else {
      const head = Math.min(u8.length, 24 * 1048576);
      ranges = [[0, head]]; if (u8.length > head) ranges.push([Math.max(head, u8.length - 8 * 1048576), u8.length]);
    }
    text = extractStrings(u8, ranges, { skipDense: !image }).text;
  }
  if (!text) return;
  const { matches, users } = findDetails(text, { phones: Boolean(decoded) || image, publicIps: Boolean(decoded) || image });
  const flagged = new Set(['Email address', 'User folder path', 'Network share', 'Internal host name', 'MAC address', 'Phone number', 'GPS coordinates', 'Possible secret', 'Private key']);
  for (const m of matches) r.field(FOUND, m.kind, m.value, flagged.has(m.kind) || m.internal ? { flag: 'privacy' } : {});
  const of = (k) => matches.filter((m) => m.kind === k);
  const sample = (list) => list.slice(0, 2).map((m) => m.value.slice(0, 120)).join(', ');
  const emails = of('Email address');
  if (emails.length) r.signal('privacy', 'Email addresses found', `${plural(emails.length, 'email address')} in the file, such as ${sample(emails)}.`, FOUND, 'email addresses');
  if (users.size) r.signal('privacy', 'User names in file paths', `File paths name the account${users.size === 1 ? '' : 's'} ${[...users].slice(0, 3).map((u) => `“${u}”`).join(', ')} on the computer that made this file.`, FOUND, 'user names in file paths');
  const shares = of('Network share');
  if (shares.length) r.signal('privacy', 'Network share paths', `Paths to shared folders on a network, such as ${sample(shares)}, reveal server names.`, FOUND, 'network share paths');
  const internal = matches.filter((m) => m.internal);
  if (internal.length) r.signal('privacy', 'Internal network details', `Private addresses or internal host names, such as ${sample(internal)}, describe the network the file came from.`, FOUND, 'internal network names');
  const macs = of('MAC address');
  if (macs.length) r.signal('privacy', 'Hardware addresses', `${plural(macs.length, 'network card address')} (MAC) can identify a specific computer.`, FOUND, 'hardware addresses');
  const phones = of('Phone number');
  if (phones.length) r.signal('privacy', 'Phone numbers found', `${plural(phones.length, 'phone number')}, such as ${sample(phones)}.`, FOUND, 'phone numbers');
  const gps = of('GPS coordinates');
  if (gps.length) r.signal('privacy', 'Location coordinates in text', `Coordinates such as ${sample(gps)} point to a place.`, FOUND, 'location coordinates');
  const secrets = of('Possible secret');
  if (secrets.length) r.signal('privacy', 'Possible secret', `Text that looks like ${listJoin([...new Set(secrets.map((m) => article(m.value.split(':')[0])))].slice(0, 3))}. Anyone with the file could use it.`, FOUND, 'a possible secret');
  if (of('Private key').length) r.signal('privacy', 'Private key in the file', 'A private key block is stored in the file. Anyone with the file can use it.', FOUND, 'a private key');
}

const listJoin = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
