import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip, readEntry, writeZip, rawEntry, isZip } from '../site/lib/zip/index.js';

const enc = new TextEncoder();

test('ZIP: written archive reads back with names, contents, dates and comments', async () => {
  const when = new Date(Date.UTC(2024, 4, 17, 13, 45, 30));
  const big = enc.encode('a'.repeat(5000));
  const u8 = await writeZip([
    { name: 'mimetype', data: enc.encode('application/epub+zip'), method: 0 },
    { name: 'folder/', data: new Uint8Array() },
    { name: 'folder/notes ü.txt', data: big, modified: when, comment: 'entry note' },
  ], { comment: 'archive note' });
  assert.ok(isZip(u8));
  const zip = readZip(u8);
  assert.deepEqual(zip.entries.map((e) => e.name), ['mimetype', 'folder/', 'folder/notes ü.txt']);
  assert.equal(zip.comment, 'archive note');
  const [mime, dir, file] = zip.entries;
  assert.equal(mime.method, 0); assert.equal(file.method, 8); assert.ok(file.compressedSize < 5000);
  assert.ok(dir.directory);
  assert.equal(file.comment, 'entry note');
  assert.equal(file.modified.toISOString(), when.toISOString());
  assert.equal(mime.modified.toISOString(), '1980-01-01T00:00:00.000Z');
  assert.deepEqual(await readEntry(zip, file), big);
  assert.equal(new TextDecoder().decode(await readEntry(zip, mime)), 'application/epub+zip');
});

test('ZIP: raw entries copy without recompressing, prepended data is tolerated', async () => {
  const first = readZip(await writeZip([{ name: 'a.xml', data: enc.encode('<a>'.repeat(300)) }]));
  const e = first.entries[0];
  const copy = await writeZip([{ name: 'a.xml', raw: rawEntry(first, e), crc: e.crc, size: e.size, method: e.method }]);
  const stub = new Uint8Array([...enc.encode('MZ self-extractor stub'), ...copy]);
  const zip = readZip(stub);
  assert.equal(zip.prefix, 22);
  assert.equal(new TextDecoder().decode(await readEntry(zip, zip.entries[0])), '<a>'.repeat(300));
});

test('ZIP: damaged and hostile archives are refused', async () => {
  assert.throws(() => readZip(enc.encode('not a zip at all, just text padding here')), /end-of-central-directory/);
  const u8 = await writeZip([{ name: 'x.txt', data: enc.encode('hello hello hello') }]);
  const bad = u8.slice(); const zip = readZip(bad); bad[zip.entries[0].dataOffset] ^= 0xff;
  await assert.rejects(readEntry(readZip(bad), readZip(bad).entries[0]));
});
