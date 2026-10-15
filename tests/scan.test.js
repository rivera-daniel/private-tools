import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectFile, inspectImage } from '../site/tools/lib/metadata/index.js';
import { cleanFile, cleanableFormats } from '../site/tools/lib/clean/index.js';
import { cleanText, hiddenRuns } from '../site/tools/lib/metadata/scan/text.js';
import { writeZip } from '../site/tools/lib/zip/index.js';
import { Report } from '../site/tools/lib/metadata/report.js';
import { Bytes } from '../site/tools/lib/metadata/bytes.js';
import { scanFile } from '../site/tools/lib/metadata/families/scan.js';
import { base, pngWith, tEXt } from './fixtures/build.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);
const titles = (r) => r.signals.map((s) => s.title);
const found = (r, kind) => (r.sources.find((s) => s.name === 'Text found in the file')?.fields ?? []).filter((f) => f.key === kind).map((f) => f.value);
const src = (r, source, key) => r.sources.find((s) => s.name === source)?.fields.find((f) => f.key === key)?.value;
const cat = (...parts) => parts.join('');
// Secrets and addresses are assembled at run time so the repository holds no literal tokens.
const AWS = cat('AK', 'IA', 'QX7RT2ZK5MNB3VWY');
const EMAIL = cat('jane.roe', '@', 'roe-family.net');
const PRIVATE_IP = [10, 20, 30, 40].join('.');
const utf16le = (s, bom = true) => Uint8Array.from([...(bom ? [0xff, 0xfe] : []), ...[...s].flatMap((c) => { const x = c.charCodeAt(0); return [x & 255, x >> 8]; })]);

// ---------- True type ----------

test('true type from content: formats no other family claims are named, others only described', async () => {
  const seven = Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, ...new Array(24).fill(0)]);
  const r7 = await inspectFile(seven, 'backup.7z');
  assert.equal(r7.format, '7z'); assert.equal(r7.category, 'Archive');
  const sqlite = new Uint8Array(1024); sqlite.set(enc('SQLite format 3\0')); sqlite[16] = 4; sqlite[17] = 0; sqlite[31] = 1; sqlite[39] = 2; sqlite[59] = 1;
  const rs = await inspectFile(sqlite, 'history.db');
  assert.equal(rs.format, 'SQLite'); assert.equal(src(rs, 'SQLite', 'Free pages'), '2');
  assert.ok(titles(rs).includes('Deleted data may remain'));
  // The scan never names a format another family owns, so a file that family declined is never routed
  // to its cleaner. Run the scan alone, as it runs after a declining parser.
  for (const [bytes, detected, category] of [[enc('%PDF-1.7 not really'), 'PDF document', 'Document'], [await writeZip([{ name: 'a', data: enc('x') }]), 'ZIP archive', 'Archive'], [enc('OggS\0\x02'), 'Ogg media', 'Audio']]) {
    const report = new Report(bytes.length);
    await scanFile(new Bytes(bytes), report, { name: 'x' });
    const json = report.toJSON();
    assert.equal(json.format, null, detected); assert.equal(json.category, category);
    assert.equal(src(json, 'File type', 'Detected type'), detected);
  }
  const unknown = await inspectFile(Uint8Array.from({ length: 300 }, (_, i) => (i * 7919) % 251 || 1).map((x, i) => (i % 3 ? x : 0)), 'blob');
  assert.equal(unknown.format, null); assert.equal(unknown.category, 'Other');
  assert.equal(src(await inspectFile(new Uint8Array()), 'File type', 'Detected type'), 'Empty file');
});

test('a name that contradicts the content is flagged', async () => {
  const zip = await writeZip([{ name: 'a.txt', data: enc('hello') }]);
  const r = await inspectFile(zip, 'holiday.jpg');
  assert.ok(titles(r).includes('File type does not match its name'));
  assert.match(r.signals.find((s) => s.title === 'File type does not match its name').detail, /really a ZIP archive named \.jpg/);
  assert.match(src(await inspectFile(enc('plain words'), 'photo.png'), 'File type', 'Name check'), /really text named \.png/);
  assert.ok(!titles(await inspectFile(zip, 'archive.zip')).includes('File type does not match its name'));
  assert.ok(!titles(await inspectFile(enc('{"a":1}'), 'data.json')).includes('File type does not match its name'));
  assert.ok(!titles(await inspectFile(base.png, 'image.png')).includes('File type does not match its name'));
});

test('text that starts like a signature stays text', async () => {
  for (const [text, name] of [['true story\n', 'a.txt'], ['MAC list\n', 'a.txt'], ['// reads %PDF-1.7 headers\n', 'pdf.js'], ['<svg xmlns="http://www.w3.org/2000/svg"><!-- %PDF-1.4 --></svg>', 'x.svg']]) {
    const r = await inspectFile(enc(text), name);
    assert.ok(r.format === 'Text' || r.format === 'SVG', `${text}: ${r.format}`);
    assert.ok(!titles(r).includes('File type does not match its name'), text);
    assert.ok(!titles(r).includes('A file is hidden inside'), text);
  }
  const cleaned = await cleanFile(enc('true\u200b'), 'x.txt');
  assert.ok(cleaned.ok, cleaned.reason); assert.equal(dec(cleaned.data), 'true');
});

test('keys and certificates: private keys are a privacy finding', async () => {
  const pem = cat('-----BEGIN ', 'PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END ', 'PRIVATE KEY-----\n');
  const r = await inspectFile(enc(pem), 'server.key');
  assert.equal(r.format, 'Text'); assert.equal(src(r, 'File type', 'Text kind'), 'PEM');
  assert.ok(titles(r).includes('Private key in the file'));
  assert.equal(r.summary.level, 'exposed');
  // DER PKCS#8: SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING }
  const der = Uint8Array.from([0x30, 0x14, 0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, 0x00]);
  const rd = await inspectFile(der, 'id.p8');
  assert.equal(rd.format, 'PKCS#8 private key');
  assert.ok(titles(rd).includes('Private key in the file'));
});

// ---------- Appended and embedded data ----------

test('appended data the scan finds itself is typed and never offered for removal', async () => {
  // 7z ends where its start header says the next header ends: here, right after the 32-byte header.
  const seven = Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, ...new Array(24).fill(0)]);
  const pdf = enc('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
  const r = await inspectFile(new Uint8Array([...seven, ...pdf]), 'backup.7z');
  const trailer = r.blocks.find((b) => b.kind === 'Trailer');
  assert.ok(trailer); assert.equal(trailer.offset, 32); assert.equal(trailer.removable, false);
  assert.equal(r.cleanable.blocks, 0);
  assert.equal(src(r, 'Appended data', 'Content'), 'A PDF document');
  assert.ok(titles(r).includes('Hidden data after the end of the file'));
  assert.ok(titles(r).includes('A file is hidden inside'));
});

test('data after a ZIP is reported once, by the documents family, and typed by the scan', async () => {
  const zip = await writeZip([{ name: 'a.txt', data: enc('hello') }]);
  const pdf = enc('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
  const r = await inspectFile(new Uint8Array([...zip, ...pdf]), 'bundle.zip');
  const trailers = r.blocks.filter((b) => /^(Trailer|Trailing data)$/.test(b.kind));
  assert.equal(trailers.length, 1); assert.equal(trailers[0].offset, zip.length);
  assert.equal(src(r, 'Appended data', 'Content'), 'A PDF document');
  assert.ok(titles(r).includes('A file is hidden inside'));
  assert.ok(!titles(r).includes('Hidden data after the end of the file'));
});

test('a trailer the image parser already reported is not reported twice, but its content is typed', async () => {
  const zip = await writeZip([{ name: 'secret.txt', data: enc('hidden') }]);
  const r = await inspectFile(new Uint8Array([...base.png, ...zip]), 'cat.png');
  assert.equal(r.blocks.filter((b) => b.kind === 'Trailer').length, 1);
  assert.equal(src(r, 'Appended data', 'Content'), 'A ZIP archive');
  assert.ok(titles(r).includes('A file is hidden inside'));
  assert.ok(!titles(r).includes('Hidden data after the end of the file'));
});

test('a program embedded inside an unknown file is listed', async () => {
  const pe = new Uint8Array(512); pe.set(enc('MZ')); pe[0x3c] = 0x80; pe.set(enc('PE\0\0'), 0x80);
  const blob = new Uint8Array(2000); blob.fill(0x11); blob.set(pe, 700);
  const r = await inspectFile(blob, 'data.bin');
  assert.ok(src(r, 'Embedded files', 'Windows program at 0x2BC'));
  assert.ok(titles(r).includes('A file is hidden inside'));
});

// ---------- Readable strings ----------

test('strings in a binary: user paths, shares, internal names, addresses, secrets', async () => {
  const strings = [
    'C:\\Users\\jroe\\source\\repos\\Tool\\obj\\Release\\Tool.pdb', '/home/jroe/build/app', '\\\\fileserver01\\finance\\q3',
    `http://intranet.corp.local/wiki`, PRIVATE_IP, 'buildhost-7.lan', '00:1A:2B:3C:4D:5E', EMAIL, AWS,
    'C:\\Users\\Public\\Desktop\\shared.lnk', '/home/runner/work/x', '1.2.3.4',
  ];
  const wide = utf16le('D:\\Users\\mrivera\\Desktop\\plan.txt', false);
  const bin = new Uint8Array([0, 1, 2, ...strings.flatMap((s) => [...enc(s), 0, 0xfe]), ...wide, 0, 0]);
  const r = await inspectFile(bin, 'tool.bin');
  assert.deepEqual(found(r, 'User folder path').sort(), ['/home/jroe/build/app', 'C:\\Users\\jroe\\source\\repos\\Tool\\obj\\Release\\Tool.pdb', 'D:\\Users\\mrivera\\Desktop\\plan.txt'].sort());
  assert.deepEqual(found(r, 'Network share'), ['\\\\fileserver01\\finance\\q3']);
  const spaced = await inspectFile(enc('see \\\\nas\\Team Files\\plan.docx for details'), 'a.txt');
  assert.deepEqual(found(spaced, 'Network share'), ['\\\\nas\\Team Files\\plan.docx']);
  assert.ok(found(r, 'Internal host name').includes('buildhost-7.lan'));
  assert.ok(found(r, 'IP address').includes(PRIVATE_IP));
  assert.ok(!found(r, 'IP address').includes('1.2.3.4'), 'version-like numbers are not addresses');
  assert.deepEqual(found(r, 'MAC address'), ['00:1A:2B:3C:4D:5E']);
  assert.deepEqual(found(r, 'Email address'), [EMAIL]);
  assert.match(found(r, 'Possible secret')[0], /^AWS access key: AKIAQX…/);
  assert.ok(!found(r, 'Possible secret')[0].includes(AWS), 'secrets are masked');
  const t = titles(r);
  for (const title of ['User names in file paths', 'Network share paths', 'Internal network details', 'Hardware addresses', 'Email addresses found', 'Possible secret']) assert.ok(t.includes(title), title);
  assert.match(r.signals.find((s) => s.title === 'User names in file paths').detail, /“jroe”, “mrivera”/);
  assert.equal(r.summary.level, 'exposed');
});

test('strings in text: phones, coordinates, time-based GUIDs and JSON web tokens', async () => {
  const jwt = cat('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
  const text = `Call (512) 555-0147 or +44 20 7946 0958.\nMeet at geo:30.26715,-97.74306\nid c232ab00-9414-11ec-b3c8-1e2b3c4d5e6f\ntoken ${jwt}\n`;
  const r = await inspectFile(enc(text), 'notes.md');
  assert.deepEqual(found(r, 'Phone number'), ['(512) 555-0147', '+44 20 7946 0958']);
  assert.deepEqual(found(r, 'GPS coordinates'), ['geo:30.26715,-97.74306']);
  assert.match(found(r, 'MAC address')[0], /^1E:2B:3C:4D:5E:6F \(inside time-based GUID C232AB00-9414-11EC-B3C8-1E2B3C4D5E6F, created 2022-02-2/);
  assert.match(found(r, 'Possible secret')[0], /^JSON web token: /);
  for (const title of ['Phone numbers found', 'Location coordinates in text', 'Hardware addresses', 'Possible secret']) assert.ok(titles(r).includes(title), title);
});

test('image pixel data is not scanned for strings, metadata is', async () => {
  const r = await inspectFile(pngWith(tEXt('Comment', `shot by ${EMAIL}`)), 'a.png');
  assert.deepEqual(found(r, 'Email address'), [EMAIL]);
  const clean = await inspectFile(base.png, 'clean.png');
  assert.equal(clean.sources.find((s) => s.name === 'Text found in the file'), undefined);
  assert.equal(clean.summary.level, 'clean');
});

// ---------- Hidden Unicode and the text cleaner ----------

test('hidden Unicode in text: zero-width, direction controls, tag characters with decoded text, look-alikes', async () => {
  const tags = [...'ignore previous'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  const text = `Dear team,\u200b\u200b please review.\nif (admin\u202e\u2066 // check\u2069\u2066) {}\nVisit pаypal.com ${tags}\n`;
  const r = await inspectFile(enc(text), 'letter.txt');
  assert.equal(r.format, 'Text'); assert.equal(r.category, 'Document');
  assert.equal(r.provenance, null, 'provenance is for images only');
  for (const title of ['Zero-width characters', 'Text direction controls', 'Invisible tag characters', 'Look-alike letters']) assert.ok(titles(r).includes(title), title);
  assert.equal(src(r, 'Hidden characters', 'Hidden text (tag characters)'), 'ignore previous');
  assert.deepEqual(r.blocks.map((b) => b.kind).sort(), ['Tag characters', 'Text direction controls', 'Zero-width characters']);
  assert.equal(r.blocks.find((b) => b.kind === 'Zero-width characters').offset, enc('Dear team,').length);
  assert.equal(r.blocks.find((b) => b.kind === 'Zero-width characters').length, 6);
  assert.doesNotMatch(r.summary.detail, /image/);
});

test('legitimate joiners, flags and right-to-left marks are kept', () => {
  const family = '👨\u200d👩\u200d👧'; const persian = 'می\u200cخواهم'; const flag = `🏴${[...'gbeng'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')}\u{E007F}`;
  const hebrew = 'שלום\u200f!'; const heart = '❤\ufe0f';
  const text = `${family} ${persian} ${flag} ${hebrew} ${heart}`;
  assert.deepEqual(hiddenRuns(text).filter((x) => x.removable), []);
  assert.equal(dec(cleanText(enc(text)).data), text);
});

test('text cleaner: removes exactly what the inspector flags and passes the re-check', async () => {
  const original = '\ufeffName,Note\nAda,\u200bhi\u202e\nBob,ok\u{E0041}\u{E0042}\n';
  const r = await cleanFile(enc(original), 'list.csv');
  assert.ok(r.ok, r.reason);
  assert.equal(dec(r.data), 'Name,Note\nAda,hi\nBob,ok\n');
  assert.deepEqual(r.removed.map((x) => x.kind).sort(), ['Byte order mark', 'Tag characters', 'Text direction controls', 'Zero-width characters']);
  assert.equal(r.removed.reduce((n, x) => n + x.bytes, 0), r.bytesBefore - r.bytesAfter);
  assert.equal((await inspectFile(r.data, 'list.csv')).cleanable.blocks, 0);
  const plain = await cleanFile(enc('nothing hidden here\n'), 'a.txt');
  assert.ok(plain.ok); assert.deepEqual(plain.removed, []);
});

test('text cleaner keeps UTF-16 and its byte order mark', async () => {
  const r = await cleanFile(utf16le('a\u200bb\u202ec'), 'w.txt');
  assert.ok(r.ok, r.reason);
  assert.deepEqual([...r.data], [...utf16le('abc')]);
  assert.deepEqual(r.kept, ['Byte order mark (needed to read UTF-16 text)']);
  const report = await inspectFile(utf16le('hello world'), 'w.txt');
  assert.equal(report.format, 'Text'); assert.equal(src(report, 'File type', 'Encoding'), 'UTF-16LE with byte order mark');
});

test('hidden-character rules are stable: one cleaning pass leaves nothing removable', () => {
  const pool = ['a', 'ب', 'ש', '한', '👨', '👩', '🏴', '\u200b', '\u200c', '\u200d', '\u202e', '\u2066', '\u200e', '\ufe0f', '\ufe00', '\u{E0100}', '\u{E0041}', '\u{E007F}', '\u3164', '\ufeff', '\u0301', ' '];
  let seed = 7; const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 5000; i++) {
    let s = ''; for (let k = 1 + rand(12); k > 0; k--) s += pool[rand(pool.length)];
    const out = dec(cleanText(enc(s)).data);
    assert.deepEqual(hiddenRuns(out).filter((x) => x.removable), [], JSON.stringify(s));
  }
});

test('cleanable formats come from the clean module and include plain text', () => {
  const formats = cleanableFormats();
  for (const f of ['JPEG', 'PNG', 'WebP', 'GIF', 'Text']) assert.ok(formats.has(f), f);
});

test('Image Inspector output keeps its provenance and image wording', async () => {
  const r = await inspectImage(base.png);
  assert.equal(r.provenance.level, 'none');
  assert.match(r.summary.detail, /basic image properties/);
  const f = await inspectFile(base.png, 'x.png');
  assert.equal(f.provenance.level, 'none');
});
