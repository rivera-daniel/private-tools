import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { inspectFile } from '../site/tools/lib/metadata/index.js';
import { cleanFile } from '../site/tools/lib/clean/index.js';
import { readZip, readEntry, writeZip } from '../site/tools/lib/zip/index.js';
import { parseXml } from '../site/tools/lib/metadata/documents/xml.js';
import { PERSON, TRACKER, docx, xlsx, pptx, odt, epub, rawZip, unixExtra, timeExtra, ntfsExtra, dos } from './fixtures/documents.js';

const within = async (ms, fn) => { const started = Date.now(); const out = await fn(); assert.ok(Date.now() - started < ms, `finished in ${Date.now() - started} ms`); return out; };
const rebuild = async (u8, change) => { const zip = readZip(u8); const list = []; for (const e of zip.entries) list.push({ name: e.name, data: await readEntry(zip, e), method: e.name === 'mimetype' ? 0 : undefined }); return writeZip(change(list)); };

const enc = new TextEncoder(); const dec = new TextDecoder();
const titles = (r) => r.signals.map((s) => s.title);
const kinds = (r) => r.blocks.map((b) => b.kind);
const hl = (r, group, key) => r.highlights.find((g) => g.name === group)?.fields.filter((f) => f.key === key).map((f) => f.value) ?? [];
const src = (r, source) => r.sources.find((s) => s.name === source)?.fields ?? [];
const removable = (r) => r.blocks.filter((b) => b.removable !== false);

async function entries(u8) {
  const zip = readZip(u8); const out = new Map();
  for (const e of zip.entries) if (!e.directory) out.set(e.name, await readEntry(zip, e, 64 * 1024 * 1024));
  return { zip, files: out, text: (name) => dec.decode(out.get(name)) };
}

// An independent tag-balance check, so well-formedness is not judged by the parser under test alone.
function balanced(xml) {
  const stack = [];
  for (const m of xml.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s>/!?]+)(?:\s(?:[^>"']|"[^"]*"|'[^']*')*?)?(\/?)>/g)) {
    if (!m[2]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else if (!m[3]) stack.push(m[2]);
  }
  return stack.length === 0;
}

async function assertWellFormed(u8) {
  const { files } = await entries(u8);
  for (const [name, data] of files) {
    if (!/\.(xml|rels|vml|opf|xhtml)$/i.test(name)) continue;
    const t = dec.decode(data);
    assert.ok(balanced(t), `${name} tags balance`);
    assert.doesNotThrow(() => parseXml(t, { lenient: /\.xhtml$/.test(name) }), `${name} parses`);
  }
}

// Every internal relationship target exists and every content-type override names an existing part.
async function assertPackageValid(u8) {
  const { zip, files, text } = await entries(u8);
  assert.equal(zip.entries[0].name, '[Content_Types].xml');
  const names = new Set([...files.keys()].map((n) => n.toLowerCase()));
  for (const m of text('[Content_Types].xml').matchAll(/PartName="\/([^"]+)"/g)) assert.ok(names.has(decodeURIComponent(m[1]).toLowerCase()), `override for ${m[1]}`);
  for (const name of files.keys()) {
    const m = /^(.*?)_rels\/(.*)\.rels$/.exec(name); if (!m) continue;
    const dir = (m[1] + m[2]).split('/').slice(0, -1);
    for (const r of text(name).matchAll(/<Relationship\b[^>]*>/g)) {
      if (/TargetMode="External"/.test(r[0])) continue;
      const target = /Target="([^"]*)"/.exec(r[0])[1];
      const path = target.startsWith('/') ? [] : [...dir];
      for (const seg of target.replace(/^\//, '').split('/')) seg === '..' ? path.pop() : path.push(seg);
      assert.ok(names.has(path.join('/').toLowerCase()), `${name} -> ${target}`);
    }
  }
  for (const e of zip.entries) {
    assert.equal(e.modified.toISOString(), '1980-01-01T00:00:00.000Z', `${e.name} time`);
    assert.equal(e.extra.length + e.localExtra.length, 0, `${e.name} extra fields`);
  }
}

async function cleanAndCheck(u8, name, options = {}) {
  const result = await cleanFile(u8, name, options);
  assert.ok(result.ok, result.reason);
  const after = await inspectFile(result.data, name);
  assert.deepEqual(after.warnings, []);
  const again = await cleanFile(result.data, name, options);
  assert.ok(again.ok, again.reason);
  assert.deepEqual(again.removed, [], 'cleaning a cleaned file removes nothing');
  await assertWellFormed(result.data);
  return { result, after };
}

// ---------- DOCX ----------

test('DOCX: properties, people, comments, fingerprints, remote content and embedded photo are found', async () => {
  const r = await inspectFile(await docx(), 'plan.docx');
  assert.equal(r.format, 'DOCX'); assert.equal(r.category, 'Document');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(hl(r, 'People', 'Author'), [PERSON.name]);
  assert.deepEqual(hl(r, 'People', 'Last modified by'), [PERSON.editor]);
  assert.ok(hl(r, 'People', 'Company').includes('Example Corp'));
  assert.ok(hl(r, 'People', 'Comment author').includes(PERSON.name));
  assert.ok(hl(r, 'People', 'User ID').some((v) => v.includes(PERSON.email)));
  assert.ok(hl(r, 'Software', 'Template').some((v) => v.includes(PERSON.user)));
  assert.deepEqual(hl(r, 'Dates', 'Total editing time'), ['42 min']);
  assert.deepEqual(hl(r, 'Location', 'GPS coordinates'), ['30.26715, -97.74306']);
  assert.ok(src(r, 'Document variables').some((f) => f.key === 'ClientCode' && f.value === 'ACME-7781'));
  assert.ok(src(r, 'Printer settings').some((f) => f.value === 'Floor3-Printer'));
  assert.ok(src(r, 'Comments').some((f) => f.value === 'Secret remark'));
  assert.ok(src(r, 'Hidden content').some((f) => f.value.includes('hidden note to self')));
  assert.ok(src(r, 'Links').some((f) => f.value === 'https://example.com/report'));
  for (const t of ['Usernames in file paths', 'Comments with authors', 'Editing session IDs', 'Loads content from the internet when opened', 'Hidden content', 'Hidden document variables', 'Printer name stored', 'Embedded thumbnail preview', 'Custom properties', 'Exact location stored', 'Names or ownership stored']) assert.ok(titles(r).includes(t), t);
  for (const k of ['Properties', 'Custom properties', 'Thumbnail', 'Comments', 'People', 'Custom XML', 'Printer settings', 'Unused part', 'Remote resource', 'Editing fingerprints', 'Document variables', 'Embedded image metadata', 'Archive details']) assert.ok(kinds(r).includes(k), k);
  assert.equal(r.blocks.find((b) => b.kind === 'Hidden content').removable, false);
  assert.equal(r.summary.level, 'exposed');
});

test('DOCX: remote template, remote image and INCLUDEPICTURE are told apart from a plain hyperlink', async () => {
  const r = await inspectFile(await docx(), 'plan.docx');
  const remote = src(r, 'Remote resources').map((f) => f.value);
  assert.ok(remote.includes('https://templates.example/corp.dotm'));
  assert.ok(remote.includes(TRACKER));
  assert.ok(src(r, 'Fields').some((f) => f.value.startsWith('INCLUDEPICTURE')));
  assert.ok(!remote.includes('https://example.com/report'), 'hyperlinks are listed, not flagged');
  const quiet = await inspectFile(await docx({ remote: false }), 'plan.docx');
  assert.ok(!titles(quiet).includes('Loads content from the internet when opened'));
});

test('DOCX: cleaning leaves a valid package with nothing personal and no network requests', async () => {
  const { result, after } = await cleanAndCheck(await docx(), 'plan.docx');
  assert.equal(after.format, 'DOCX');
  assert.equal(removable(after).length, 0);
  assert.deepEqual(after.signals.map((s) => s.title), ['Hidden content'], 'only the kept hidden text is still reported');
  await assertPackageValid(result.data);
  const { files, text } = await entries(result.data);
  for (const gone of ['docProps/custom.xml', 'docProps/thumbnail.jpeg', 'word/comments.xml', 'word/people.xml', 'customXml/item1.xml', 'customXml/itemProps1.xml', 'word/printerSettings/printerSettings1.bin', '[trash]/0001.dat']) assert.ok(!files.has(gone), gone);
  const all = [...files].filter(([n]) => /\.(xml|rels)$/.test(n)).map(([, d]) => dec.decode(d)).join('\n');
  for (const secret of [PERSON.name, PERSON.editor, PERSON.user, PERSON.email, 'Example Corp', 'ACME-7781', 'rsid', 'paraId', 'docId', 'tracker.example', 'templates.example', 'commentReference', 'INCLUDEPICTURE', 'Secret remark']) assert.ok(!all.includes(secret), `${secret} is gone`);
  assert.match(text('word/document.xml'), /Visible text/);
  assert.match(text('word/document.xml'), /cached result/, 'the field keeps its last result');
  assert.match(text('word/document.xml'), /hidden note to self/, 'hidden text is content and stays');
  assert.match(text('word/_rels/document.xml.rels'), /https:\/\/example\.com\/report/, 'hyperlinks stay');
  assert.match(text('docProps/core.xml'), /<cp:coreProperties[^>]*\/>$/);
  const photo = await inspectFile(files.get('word/media/image1.jpeg'), 'image1.jpeg');
  assert.ok(!titles(photo).includes('Exact location stored'), 'the embedded photo lost its GPS');
  assert.ok(result.removed.some((x) => x.kind === 'Embedded image metadata'));
  assert.ok(result.kept.some((k) => k.startsWith('Hidden content')));
});

test('DOCX: tracked changes are refused by default and accepted on request', async () => {
  const u8 = await docx({ tracked: true });
  const r = await inspectFile(u8, 'changes.docx');
  assert.ok(titles(r).includes('Tracked changes with authors'));
  assert.ok(hl(r, 'People', 'Change author').includes(PERSON.editor));
  const refused = await cleanFile(u8, 'changes.docx');
  assert.equal(refused.ok, false); assert.match(refused.reason, /Accept or reject all changes/);
  assert.equal(refused.option, 'acceptChanges');
  const { result } = await cleanAndCheck(u8, 'changes.docx', { acceptChanges: true });
  const doc = (await entries(result.data)).text('word/document.xml');
  assert.match(doc, /added words/, 'insertions kept');
  assert.ok(!doc.includes('deleted secret'), 'deletions dropped');
  assert.ok(!/w:ins\b|w:del\b|rPrChange|w:author/.test(doc), 'no revision markup left');
  assert.match(doc, /first half<\/w:t><\/w:r><w:r><w:t>second half/, 'a deleted paragraph mark joins the paragraphs');
  assert.match(doc, /<w:b\/>/, 'formatting stays as it is now');
});

test('DOCM: macros are kept by default, removed on request, and the format never changes', async () => {
  const u8 = await docx({ macros: true });
  const r = await inspectFile(u8, 'macro.docm');
  assert.equal(r.format, 'DOCM');
  assert.ok(titles(r).includes('Macros (active content)'));
  const kept = await cleanFile(u8, 'macro.docm');
  assert.ok(kept.ok, kept.reason);
  assert.ok(kept.kept.some((k) => k.startsWith('Macros')));
  assert.deepEqual(kept.offer, ['removeMacros']);
  assert.ok((await entries(kept.data)).files.has('word/vbaProject.bin'));
  const { result, after } = await cleanAndCheck(u8, 'macro.docm', { removeMacros: true });
  assert.equal(after.format, 'DOCM');
  assert.ok(!(await entries(result.data)).files.has('word/vbaProject.bin'));
  assert.ok(!titles(after).includes('Macros (active content)'));
  await assertPackageValid(result.data);
});

// ---------- XLSX and PPTX ----------

test('XLSX: saved path, hidden sheet, comments, threaded comments, external link and connection', async () => {
  const u8 = await xlsx();
  const r = await inspectFile(u8, 'book.xlsx');
  assert.equal(r.format, 'XLSX');
  assert.ok(src(r, 'File paths').some((f) => f.value.includes(PERSON.user)));
  assert.ok(src(r, 'Hidden content').some((f) => /Salaries \(very hidden\)/.test(f.value)));
  assert.ok(src(r, 'Hidden content').some((f) => f.key === 'Hidden rows' && f.value === '1'));
  assert.ok(src(r, 'Data connections').some((f) => f.value.includes('db.corp.example')));
  assert.ok(hl(r, 'People', 'User ID').includes(PERSON.email));
  for (const t of ['Usernames in file paths', 'Comments with authors', 'Editing session IDs', 'Hidden content', 'Data connection details', 'Loads content from the internet when opened', 'Printer name stored']) assert.ok(titles(r).includes(t), t);
  const { result, after } = await cleanAndCheck(u8, 'book.xlsx');
  assert.equal(removable(after).length, 0);
  await assertPackageValid(result.data);
  const { files, text } = await entries(result.data);
  for (const gone of ['xl/comments1.xml', 'xl/threadedComments/threadedComment1.xml', 'xl/persons/person.xml', 'xl/drawings/vmlDrawing1.vml', 'xl/printerSettings/printerSettings1.bin']) assert.ok(!files.has(gone), gone);
  assert.ok(files.has('xl/drawings/vmlDrawing2.vml'), 'a drawing with a form control stays');
  assert.ok(!/absPath|revisionPtr|fileVersion|xr:uid/.test(text('xl/workbook.xml') + text('xl/worksheets/sheet1.xml')));
  assert.ok(!/legacyDrawing/.test(text('xl/worksheets/sheet1.xml')), 'the comment drawing reference is gone');
  assert.match(text('xl/worksheets/sheet2.xml'), /legacyDrawing/);
  assert.match(text('xl/worksheets/sheet1.xml'), /<pageSetup orientation="portrait"\/>/, 'page setup stays without its printer');
  assert.match(text('xl/externalLinks/_rels/externalLink1.xml.rels'), /Target="Budget\.xlsx"/, 'the external link keeps only the file name');
  assert.ok(!/refreshOnLoad/.test(text('xl/connections.xml')));
  assert.match(text('xl/workbook.xml'), /state="veryHidden"/, 'hidden sheets are content and stay');
});

test('XLSX: Power Query definitions stay and are reported as kept', async () => {
  const u8 = await xlsx({ powerQuery: true });
  const r = await inspectFile(u8, 'query.xlsx');
  assert.ok(r.blocks.some((b) => b.kind === 'Data connection' && b.container === 'customXml/item1.xml' && b.removable === false));
  const { result } = await cleanAndCheck(u8, 'query.xlsx');
  assert.ok((await entries(result.data)).files.has('customXml/item1.xml'));
  await assertPackageValid(result.data);
});

test('PPTX: comment authors, modern comments, revision info, notes and hidden slides', async () => {
  const u8 = await pptx();
  const r = await inspectFile(u8, 'deck.pptx');
  assert.equal(r.format, 'PPTX');
  assert.ok(hl(r, 'People', 'User ID').some((v) => v.includes(PERSON.email)));
  assert.ok(src(r, 'Speaker notes').some((f) => f.value.includes('layoffs')));
  assert.ok(src(r, 'Hidden content').some((f) => f.key === 'Hidden slides'));
  for (const t of ['Comments with authors', 'Speaker notes', 'Hidden content', 'Editing session IDs']) assert.ok(titles(r).includes(t), t);
  const { result, after } = await cleanAndCheck(u8, 'deck.pptx');
  assert.equal(removable(after).length, 0);
  await assertPackageValid(result.data);
  const { files, text } = await entries(result.data);
  for (const gone of ['ppt/commentAuthors.xml', 'ppt/authors.xml', 'ppt/comments/comment1.xml', 'ppt/comments/modernComment_1.xml', 'ppt/revisionInfo.xml']) assert.ok(!files.has(gone), gone);
  assert.ok(!/commentRel|extLst/.test(text('ppt/slides/slide1.xml')), 'the modern comment reference and its empty extension list are gone');
  assert.ok(files.has('ppt/notesSlides/notesSlide1.xml'), 'speaker notes are content and stay');
  assert.ok(after.blocks.some((b) => b.kind === 'Speaker notes' && b.removable === false));
});

// ---------- OpenDocument ----------

test('ODT: meta.xml, annotations, rsids, printer, remote image and template path', async () => {
  const u8 = await odt();
  const r = await inspectFile(u8, 'letter.odt');
  assert.equal(r.format, 'ODT'); assert.equal(r.category, 'Document');
  assert.deepEqual(hl(r, 'People', 'Author'), [PERSON.name]);
  assert.ok(hl(r, 'Software', 'Application')[0].startsWith('LibreOffice'));
  assert.ok(hl(r, 'Software', 'Template')[0].includes(PERSON.user));
  for (const t of ['Usernames in file paths', 'Comments with authors', 'Editing session IDs', 'Loads content from the internet when opened', 'Printer name stored', 'Hidden content', 'Embedded thumbnail preview', 'Custom properties', 'Exact location stored']) assert.ok(titles(r).includes(t), t);
  const { result, after } = await cleanAndCheck(u8, 'letter.odt');
  assert.equal(removable(after).length, 0);
  const { zip, files, text } = await entries(result.data);
  assert.equal(zip.entries[0].name, 'mimetype'); assert.equal(zip.entries[0].method, 0);
  const listed = [...text('META-INF/manifest.xml').matchAll(/full-path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '/');
  assert.deepEqual(listed.sort(), [...files.keys()].filter((n) => n !== 'mimetype' && n !== 'META-INF/manifest.xml').sort(), 'manifest matches the entries');
  assert.ok(!files.has('Thumbnails/thumbnail.png') && !files.has('notes-left-behind.txt'));
  const all = ['content.xml', 'meta.xml', 'settings.xml', 'styles.xml'].map(text).join('\n');
  for (const secret of [PERSON.name, PERSON.editor, PERSON.user, 'rsid', 'Floor3', 'tracker.example', 'Secret remark', 'LibreOffice']) assert.ok(!all.includes(secret), `${secret} is gone`);
  assert.match(text('settings.xml'), /AddParaTableSpacing/, 'layout settings stay');
  assert.match(text('content.xml'), /Pictures\/photo\.jpg/, 'the embedded picture stays');
});

test('ODT: tracked changes refused by default, accepted on request; macros follow the option', async () => {
  const u8 = await odt({ tracked: true });
  assert.match((await cleanFile(u8, 't.odt')).reason, /Accept or reject all changes/);
  const { result } = await cleanAndCheck(u8, 't.odt', { acceptChanges: true });
  const content = (await entries(result.data)).text('content.xml');
  assert.ok(!/tracked-changes|change-start|deleted secret/.test(content));
  assert.match(content, /inserted words and rest/);
  const macro = await odt({ macros: true });
  assert.ok(titles(await inspectFile(macro, 'm.odt')).includes('Macros (active content)'));
  const kept = await cleanFile(macro, 'm.odt');
  assert.ok(kept.ok, kept.reason);
  assert.ok((await entries(kept.data)).files.has('Basic/Standard/Module1.xml'));
  const { result: gone } = await cleanAndCheck(macro, 'm.odt', { removeMacros: true });
  const g = await entries(gone.data);
  assert.ok(![...g.files.keys()].some((n) => n.startsWith('Basic/')));
  assert.ok(!/event-listener|Basic\//.test(g.text('content.xml') + g.text('META-INF/manifest.xml')));
});

// ---------- EPUB ----------

test('EPUB: package metadata, store record and remote resources found and removed', async () => {
  const u8 = await epub();
  const r = await inspectFile(u8, 'book.epub');
  assert.equal(r.format, 'EPUB');
  assert.deepEqual(hl(r, 'People', 'Author'), [PERSON.name]);
  assert.ok(hl(r, 'People', 'Store account').includes(PERSON.email));
  assert.ok(titles(r).includes('Loads content from the internet when opened'));
  assert.ok(titles(r).includes('Store account recorded'));
  const { result, after } = await cleanAndCheck(u8, 'book.epub');
  assert.equal(removable(after).length, 0);
  assert.ok(!titles(after).includes('Loads content from the internet when opened'));
  const { zip, files, text } = await entries(result.data);
  assert.equal(zip.entries[0].name, 'mimetype');
  assert.ok(!files.has('iTunesMetadata.plist') && !files.has('META-INF/calibre_bookmarks.txt'));
  const opf = text('OEBPS/content.opf');
  for (const secret of [PERSON.name, 'calibre', 'Example Press', 'remote-resources', '2025-', 'calibre_id', '8812']) assert.ok(!opf.includes(secret), `${secret} is gone`);
  assert.ok(r.blocks.some((b) => b.kind === 'Properties' && b.container === 'OEBPS/toc.ncx'), 'the table of contents author is found');
  const ncx = text('OEBPS/toc.ncx');
  assert.ok(!ncx.includes(PERSON.name) && !ncx.includes('calibre'), 'the table of contents loses author and generator');
  assert.match(ncx, /dtb:uid/);
  for (const needed of ['dc:identifier', 'dc:title', 'dc:language', 'dcterms:modified', 'name="cover"', 'rendition:layout']) assert.ok(opf.includes(needed), `${needed} stays`);
  assert.ok(!/tracker\.example|fonts\.example/.test(text('OEBPS/text/ch1.xhtml') + text('OEBPS/style.css')));
  assert.match(text('OEBPS/text/ch1.xhtml'), /&#160;starts/, 'untouched text is written back as it was');
  assert.match(text('OEBPS/text/ch1.xhtml'), /https:\/\/example\.com\/more/, 'clickable links stay');
});

// ---------- Generic ZIP ----------

test('ZIP: Unix ids, time zone, comments, usernames, leftovers and data around the archive', async () => {
  const when = dos(2025, 3, 4, 12, 30, 0); const utc = Date.UTC(2025, 2, 4, 17, 30, 0) / 1000;
  const u8 = rawZip([
    { name: ['home', PERSON.user, 'notes.txt'].join('/'), data: enc.encode('hello'), ...when, extra: Buffer.concat([unixExtra(1000, 1000), timeExtra(utc)]), comment: 'draft' },
    { name: 'report.txt', data: enc.encode('report'), ...when, host: 10, extra: ntfsExtra(utc * 1000) },
    { name: '__MACOSX/._report.txt', data: enc.encode('quarantine'), ...when },
    { name: '.DS_Store', data: enc.encode('Bud1'), ...when },
  ], { prefix: enc.encode('PREPENDED'), trailing: enc.encode('TRAILING'), comment: 'archive note' });
  const r = await inspectFile(u8, 'files.zip');
  assert.equal(r.format, 'ZIP'); assert.equal(r.category, 'Archive');
  assert.deepEqual(hl(r, 'People', 'Unix user ID'), ['1000']);
  assert.deepEqual(hl(r, 'Dates', 'Time zone'), ['UTC−05:00']);
  assert.ok(hl(r, 'Software', 'Archive made on').includes('Unix'));
  assert.ok(hl(r, 'Comments', 'Archive comment').includes('archive note'));
  for (const t of ['Hidden data before the archive', 'Hidden data after the archive', 'Usernames in file paths', 'Operating system leftovers', 'Time zone revealed']) assert.ok(titles(r).includes(t), t);
  assert.equal(src(r, 'Archive entries').length, 4);
  const result = await cleanFile(u8, 'files.zip');
  assert.ok(result.ok, result.reason);
  const zip = readZip(result.data);
  assert.equal(zip.prefix, 0); assert.equal(zip.comment, '');
  assert.equal(zip.end + 22, result.data.length, 'nothing after the end record');
  assert.deepEqual(zip.entries.map((e) => e.name), [['home', PERSON.user, 'notes.txt'].join('/'), 'report.txt']);
  for (const e of zip.entries) { assert.equal(e.modified.toISOString(), '1980-01-01T00:00:00.000Z'); assert.equal(e.extra.length + e.localExtra.length, 0); assert.equal(e.comment, ''); }
  assert.equal(dec.decode(await readEntry(zip, zip.entries[1])), 'report');
  const after = await inspectFile(result.data, 'files.zip');
  assert.equal(removable(after).length, 0);
  assert.deepEqual((await cleanFile(result.data, 'files.zip')).removed, []);
});

test('ZIP: encrypted entries and signed packages are refused', async () => {
  const locked = Buffer.from(await writeZip([{ name: 'a.txt', data: enc.encode('secret'), modified: new Date(Date.UTC(2024, 0, 1)) }]));
  const z = readZip(locked);
  locked.writeUInt16LE(1, z.entries[0].centralOffset + 8); locked.writeUInt16LE(1, z.entries[0].localOffset + 6);
  const r = await inspectFile(locked, 'locked.zip');
  assert.ok(titles(r).includes('Encrypted entries'));
  assert.match((await cleanFile(locked, 'locked.zip')).reason, /encrypted/);
  const jar = await writeZip([{ name: 'META-INF/MANIFEST.MF', data: enc.encode('Manifest-Version: 1.0\n') }, { name: 'META-INF/CERT.RSA', data: enc.encode('sig') }, { name: 'A.class', data: enc.encode('x'), modified: new Date(Date.UTC(2024, 0, 1)) }]);
  const jr = await inspectFile(jar, 'app.jar');
  assert.ok(src(jr, 'Archive').some((f) => f.key === 'Package type' && /JAR/.test(f.value)));
  assert.match((await cleanFile(jar, 'app.jar')).reason, /signed package/);
});

// ---------- Hostile input ----------

test('hostile: an entry that inflates past the limit is not read', async () => {
  const bomb = deflateRawSync(Buffer.alloc(40 * 1024 * 1024));
  const good = readZip(await docx());
  const list = [];
  for (const e of good.entries) list.push(e.name === 'word/document.xml' ? { name: e.name, raw: bomb, crc: 0, size: 100, method: 8 } : { name: e.name, data: await readEntry(good, e) });
  const u8 = await writeZip(list);
  const started = Date.now();
  const r = await inspectFile(u8, 'bomb.docx');
  assert.equal(r.format, 'DOCX');
  assert.ok(r.warnings.some((w) => /could not be read/.test(w)));
  assert.equal((await cleanFile(u8, 'bomb.docx')).ok, false);
  assert.ok(Date.now() - started < 10000);
});

test('hostile: central records sharing the same data are reported and never cleaned', async () => {
  const one = rawZip([{ name: 'a.txt', data: Buffer.alloc(1000, 0x61) }]);
  const z = readZip(one);
  const central = one.subarray(z.centralOffset, z.end);
  const copies = 2000;
  const cd = Buffer.concat(Array.from({ length: copies }, (_, i) => { const c = Buffer.from(central); c.write(String(i % 10), 46); return c; }));
  const end = Buffer.from(one.subarray(z.end)); end.writeUInt16LE(copies, 8); end.writeUInt16LE(copies, 10); end.writeUInt32LE(cd.length, 12);
  const u8 = Buffer.concat([one.subarray(0, z.centralOffset), cd, end]);
  const r = await inspectFile(u8, 'overlap.zip');
  assert.ok(r.warnings.some((w) => /overlap/.test(w)));
  assert.equal((await cleanFile(u8, 'overlap.zip')).ok, false);
});

test('hostile: many entries are listed up to a cap; a truncated directory is reported', async () => {
  const many = await writeZip(Array.from({ length: 3000 }, (_, i) => ({ name: `f${i}.txt`, data: enc.encode('x'), method: 0 })));
  const r = await inspectFile(many, 'many.zip');
  assert.equal(src(r, 'Archive entries').length, 501);
  const cut = Buffer.from(many.subarray(0, many.length - 22 - 4000));
  const tail = Buffer.from(many.subarray(many.length - 22));
  const broken = await inspectFile(Buffer.concat([cut, tail]), 'cut.zip');
  assert.ok(broken.warnings.some((w) => /damaged/.test(w)));
});

test('hostile: malformed XML, entity expansion and deep nesting are refused, not expanded', async () => {
  const good = readZip(await docx());
  const swap = async (body) => {
    const list = [];
    for (const e of good.entries) list.push({ name: e.name, data: e.name === 'word/document.xml' ? enc.encode(body) : await readEntry(good, e) });
    return writeZip(list);
  };
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const laughs = `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><w:document ${W}><w:body><w:p w:rsidR="1"><w:r><w:t>&c;</w:t></w:r></w:p></w:body></w:document>`;
  const deep = `<w:document ${W}><w:body>${'<w:p>'.repeat(5000)}${'</w:p>'.repeat(5000)}</w:body></w:document>`;
  const broken = `<w:document ${W}><w:body><w:p w:rsidR="1"></w:body></w:document>`;
  for (const body of [laughs, deep, broken]) {
    const u8 = await swap(body);
    const r = await inspectFile(u8, 'x.docx');
    assert.equal(r.format, 'DOCX');
    assert.ok(r.warnings.some((w) => /malformed/.test(w)), 'reported as malformed');
    assert.equal((await cleanFile(u8, 'x.docx')).ok, false);
  }
  assert.throws(() => parseXml('<a><b></a>'));
  assert.throws(() => parseXml('<a x="1" x="2"/>'));
  assert.throws(() => parseXml('<a>&undefined;</a>'));
  assert.throws(() => parseXml('<a/><b/>'));
  assert.doesNotThrow(() => parseXml('<a>&nbsp;</a>', { lenient: true }));
});

test('hostile: crafted entry, item and relationship counts stay fast', async () => {
  const many = await rebuild(await odt(), (list) => [...list, ...Array.from({ length: 80000 }, (_, i) => ({ name: `junk/${i}.txt`, data: new Uint8Array(), method: 0 }))]);
  const odtResult = await within(15000, async () => { await inspectFile(many, 'many.odt'); return cleanFile(many, 'many.odt'); });
  assert.ok(odtResult.ok, odtResult.reason);
  assert.equal(readZip(odtResult.data).entries.length, 7);
  const items = Array.from({ length: 80000 }, (_, i) => (i % 2 ? `<item id="r${i}" href="https://cdn.example/${i}.png" media-type="image/png"/>` : `<item id="l${i}" href="missing/${i}.xhtml" media-type="application/xhtml+xml"/>`)).join('');
  const book = await rebuild(await epub(), (list) => list.map((e) => (e.name === 'OEBPS/content.opf' ? { ...e, data: enc.encode(dec.decode(e.data).replace('</manifest>', `${items}</manifest>`)) } : e)));
  const epubResult = await within(15000, async () => { await inspectFile(book, 'big.epub'); return cleanFile(book, 'big.epub'); });
  assert.ok(epubResult.ok, epubResult.reason);
  const chain = 1000;
  const word = await rebuild(await docx(), (list) => {
    const rel = (target) => enc.encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="urn:example:part" Target="${target}"/></Relationships>`);
    const extra = [{ name: 'word/_rels/comments.xml.rels', data: rel('x0.xml') }];
    for (let i = 0; i < chain; i++) extra.push({ name: `word/x${i}.xml`, data: enc.encode('<x/>') }, { name: `word/_rels/x${i}.xml.rels`, data: rel(`x${i + 1}.xml`) });
    return [...list, ...extra.reverse()];
  });
  const docxResult = await within(15000, async () => { await inspectFile(word, 'chain.docx'); return cleanFile(word, 'chain.docx'); });
  assert.ok(docxResult.ok, docxResult.reason);
  assert.ok(![...readZip(docxResult.data).entries].some((e) => /word\/x\d+\.xml/.test(e.name)), 'the whole chain goes with the comments');
});

test('non-ZIP input and a ZIP name on plain data are not claimed', async () => {
  const r = await inspectFile(enc.encode('just some text that is not an archive'), 'fake.docx');
  assert.notEqual(r.format, 'DOCX');
  const empty = await inspectFile(await writeZip([]), 'empty.zip');
  assert.equal(empty.format, 'ZIP');
});
