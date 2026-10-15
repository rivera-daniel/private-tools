import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectFile } from '../site/tools/lib/metadata/index.js';
import { cleanFile } from '../site/tools/lib/clean/index.js';
import { mp4, chunkOffsets, box, id3v2, id3Text, id3Frames, id3v1, apeTag, lyrics3, mp3Frames, adtsFrames, flac, wav, aiff, ogg, readOgg, mkv, crc32, jpeg, cat, u32 } from './fixtures/media.js';

const hl = (r, group, key) => r.highlights.find((g) => g.name === group)?.fields.find((f) => f.key === key)?.value;
const src = (r, source, key) => r.sources.find((g) => g.name === source)?.fields.find((f) => f.key === key)?.value;
const titles = (r) => r.signals.map((s) => s.title);
const has = (u8, s) => Buffer.from(u8).includes(Buffer.from(s, 'latin1'));

// Cleaned output: nothing removable left, only technical sources, no privacy findings, then a second pass is a no-op.
async function assertClean(data, name) {
  const after = await inspectFile(data, name);
  assert.equal(after.cleanable.blocks, 0, JSON.stringify(after.blocks));
  assert.deepEqual(after.sources.filter((s) => !s.technical).map((s) => s.name), []);
  assert.deepEqual(after.signals.filter((s) => s.kind === 'privacy'), []);
  assert.deepEqual(after.warnings, []);
  const again = await cleanFile(data, name);
  assert.ok(again.ok, again.reason);
  assert.deepEqual(Buffer.from(again.data), Buffer.from(data), 'cleaning is idempotent');
  return after;
}

// ---------- MP4 / MOV ----------

test('MP4: location in udta, Apple keys and a metadata track are found', async () => {
  const { file } = mp4();
  const r = await inspectFile(file, 'clip.mp4');
  assert.equal(r.format, 'MP4'); assert.equal(r.category, 'Video');
  assert.equal(r.width, 64); assert.equal(r.height, 48);
  assert.ok(titles(r).includes('Exact location stored'));
  assert.ok(titles(r).includes('Location recorded over time'));
  assert.equal(hl(r, 'Camera', 'Make'), 'Apple');
  assert.equal(hl(r, 'Camera', 'Model'), 'iPhone 15 Pro');
  assert.equal(hl(r, 'Dates', 'Created'), '2024-05-01 10:00:00 UTC');
  const gps = r.highlights.find((g) => g.name === 'Location').fields.filter((f) => f.key === 'GPS coordinates').map((f) => f.value);
  assert.deepEqual(gps.sort(), ['37.33170, -122.03020', '40.71280, -74.00600']);
  assert.equal(src(r, 'QuickTime keys', 'creationdate'), '2024-05-01T12:00:00+0200');
  assert.deepEqual(r.blocks.filter((b) => b.parent === null).map((b) => b.kind).sort(), ['Dates', 'Metadata', 'Metadata track', 'User data']);
  assert.deepEqual(r.warnings, []);
});

for (const moovFirst of [false, true]) for (const co64 of [false, true]) {
  test(`MP4: cleaning keeps every chunk offset on its sample (moov ${moovFirst ? 'before' : 'after'} mdat, ${co64 ? 'co64' : 'stco'})`, async () => {
    const { file, video } = mp4({ moovFirst, co64, trailer: 'TRAILING-SECRET', xmpUuid: true, freeLeftover: 'old caption text' });
    const before = await inspectFile(file, 'clip.mp4');
    assert.ok(before.blocks.some((b) => b.kind === 'Trailer'));
    assert.ok(before.blocks.some((b) => b.kind === 'Padding'));
    const res = await cleanFile(file, 'clip.mp4');
    assert.ok(res.ok, res.reason);
    assert.ok(res.bytesAfter < res.bytesBefore);
    const out = Buffer.from(res.data);
    const offsets = chunkOffsets(out);
    assert.equal(offsets.length, 1, 'the metadata track and its chunk offsets are gone');
    assert.deepEqual(out.subarray(offsets[0], offsets[0] + video[0].length + video[1].length), Buffer.concat(video));
    for (const s of ['+37.3317', '+40.7128', 'iPhone', 'TRAILING-SECRET', 'old caption', 'Premiere', 'LOCATION-SAMPLE']) assert.ok(!has(out, s), `${s} removed`);
    const after = await assertClean(res.data, 'clip.mp4');
    assert.equal(after.width, 64);
    assert.equal(after.format, 'MP4');
  });
}

test('MP4: a kept track that referenced the removed metadata track loses only that reference', async () => {
  const { file, video } = mp4({ videoRef: true });
  const res = await cleanFile(file, 'clip.mp4');
  assert.ok(res.ok, res.reason);
  assert.ok(!has(res.data, 'tref') && !has(res.data, 'vdep'));
  const [offset] = chunkOffsets(res.data);
  assert.deepEqual(Buffer.from(res.data).subarray(offset, offset + video[0].length), video[0]);
  await assertClean(res.data, 'clip.mp4');
});

test('MP4: GoPro telemetry track and device data', async () => {
  const { file } = mp4({ gopro: true, udta: false, mdta: false });
  const r = await inspectFile(file, 'GX010001.MP4');
  assert.equal(hl(r, 'Location', 'GPS coordinates'), '46.51970, 6.63230');
  assert.equal(src(r, 'GoPro device data', 'Serial number'), 'C3471325208909');
  assert.equal(src(r, 'GoPro telemetry', 'Device name'), 'HERO12 Black');
  assert.ok(titles(r).includes('Device serial number stored'));
  const res = await cleanFile(file, 'GX010001.MP4');
  assert.ok(res.ok, res.reason);
  assert.ok(!has(res.data, 'GPS5') && !has(res.data, 'C3471325208909'));
  await assertClean(res.data, 'GX010001.MP4');
});

test('MOV: a leftover alias path in a self-contained data reference is removed', async () => {
  const { file, video } = mp4({ brand: 'qt  ', alias: true, moovFirst: true, metadataTrack: false, udta: false, mdta: false, times: 0 });
  const r = await inspectFile(file, 'x.mov');
  assert.equal(r.format, 'MOV');
  assert.deepEqual(r.blocks.map((b) => b.kind), ['Data reference']);
  assert.match(src(r, 'Data references', 'Track 1 alis'), /clip-original/);
  const res = await cleanFile(file, 'x.mov');
  assert.ok(res.ok, res.reason);
  assert.ok(!has(res.data, 'clip-original'));
  const [offset] = chunkOffsets(res.data);
  assert.deepEqual(Buffer.from(res.data).subarray(offset, offset + video[0].length), video[0]);
  await assertClean(res.data, 'x.mov');
});

test('MP4: header times are the only finding and still get cleaned', async () => {
  const { file } = mp4({ metadataTrack: false, udta: false, mdta: false });
  const r = await inspectFile(file, 'clip.mp4');
  assert.deepEqual(r.blocks.map((b) => b.kind), ['Dates']);
  const res = await cleanFile(file, 'clip.mp4');
  assert.ok(res.ok, res.reason);
  assert.equal(res.bytesAfter, res.bytesBefore);
  await assertClean(res.data, 'clip.mp4');
});

test('M4A: iTunes items, purchase account and cover art', async () => {
  const { file } = mp4({ brand: 'M4A ', metadataTrack: false, udta: false, mdta: false, times: 0, ilst: true });
  const r = await inspectFile(file, 'song.m4a');
  assert.equal(r.format, 'M4A');
  assert.equal(src(r, 'iTunes metadata', 'Purchase account'), 'buyer-account-7731');
  assert.ok(titles(r).includes('Purchase account stored'));
  assert.match(src(r, 'Cover art', 'Image'), /^JPEG, 8 × 8, \d+ bytes$/);
  assert.equal(src(r, 'Cover art › JPEG comments', 'Comment'), 'cover note');
  assert.ok(r.blocks.some((b) => b.kind === 'Cover art' && b.parent !== null));
  const res = await cleanFile(file, 'song.m4a');
  assert.ok(res.ok, res.reason);
  assert.ok(!has(res.data, 'buyer-account-7731'));
  await assertClean(res.data, 'song.m4a');
});

test('MP4: hostile and truncated files do not throw and are not cleaned', async () => {
  const { file } = mp4({ moovFirst: true });
  const cut = file.subarray(0, file.length - 20);
  const r = await inspectFile(cut, 'clip.mp4');
  assert.ok(r.warnings.some((w) => /truncated/.test(w)));
  assert.equal((await cleanFile(cut, 'clip.mp4')).ok, false);
  const huge = Buffer.concat([box('ftyp', 'isom', Buffer.alloc(4)), Buffer.from([0xff, 0xff, 0xff, 0xf0]), Buffer.from('moov')]);
  await inspectFile(huge, 'x.mp4');
  const nested = Buffer.concat([box('ftyp', 'isom', Buffer.alloc(4)), [...Array(40)].reduce((inner) => box('udta', inner), Buffer.alloc(0))]);
  await inspectFile(nested, 'x.mp4');
  for (let i = 0; i < 50; i++) {
    const bad = Buffer.from(file); for (let k = 0; k < 20; k++) bad[8 + Math.floor(Math.random() * (bad.length - 8))] = Math.floor(Math.random() * 256);
    await inspectFile(bad, 'x.mp4');
    const res = await cleanFile(bad, 'x.mp4');
    if (res.ok) await inspectFile(res.data, 'x.mp4');
  }
});

// ---------- MP3 / AAC ----------

test('MP3: every ID3v2 frame type, ID3v1, APE and Lyrics3 are found; audio frames come back byte for byte', async () => {
  const audio = mp3Frames();
  const file = cat(id3v2(id3Frames(), { padding: 32 }), audio, apeTag([['Artist', Buffer.from('APE Artist')], ['Cover Art (Front)', cat('front.jpg\0', jpeg('ape cover')), true]]), lyrics3([['IND', '00'], ['AUT', 'Lyric Author'], ['LYR', 'la la la']]), id3v1());
  const r = await inspectFile(file, 'memo.mp3');
  assert.equal(r.format, 'MP3'); assert.equal(r.category, 'Audio');
  assert.deepEqual(r.blocks.filter((b) => b.parent === null).map((b) => b.kind), ['ID3v2', 'ID3v1', 'Lyrics3', 'APE']);
  assert.equal(src(r, 'ID3v2', 'Title'), 'Voice memo');
  assert.equal(src(r, 'ID3v2', 'Comment note (eng)'), 'meet at the station');
  assert.equal(src(r, 'ID3v2', 'Rating'), '196 of 255 by jane-rating-account');
  assert.equal(src(r, 'ID3v2', 'Private frame WM/UniqueFileIdentifier'), 'AMGa_id=R 123456;');
  assert.match(src(r, 'ID3v2', 'Embedded file attachment'), /notes\.txt/);
  assert.equal(src(r, 'ID3v1', 'Track'), '7');
  assert.equal(src(r, 'APE', 'Artist'), 'APE Artist');
  assert.equal(src(r, 'Lyrics3', 'Author'), 'Lyric Author');
  assert.equal(src(r, 'Cover art (Front cover) › JPEG comments', 'Comment'), 'art comment');
  assert.equal(src(r, 'Container', 'Encoder (in the audio stream)'), 'LAME3.100');
  for (const t of ['Private identifiers stored', 'Embedded file stored', 'Names or ownership stored']) assert.ok(titles(r).includes(t), t);
  const res = await cleanFile(file, 'memo.mp3');
  assert.ok(res.ok, res.reason);
  assert.deepEqual(Buffer.from(res.data), audio, 'only the audio frames remain, LAME header included');
  await assertClean(res.data, 'memo.mp3');
});

test('MP3: ID3v2.2, ID3v2.4 with unsynchronisation and an appended v2.4 tag', async () => {
  const v22 = cat('ID3', [2, 0, 0], [0, 0, 0, 20], 'TT2', [0, 0, 8], [0], 'Old one', Buffer.alloc(6));
  const body = cat('TIT2', [0, 0, 0, 7], [0, 2], [0], 'Sync\xff\0');
  const v24 = cat('ID3', [4, 0, 0x80], [0, 0, 0, body.length], body);
  const footer = cat('3DI', [4, 0, 0x10], [0, 0, 0, 16]);
  const appended = cat('ID3', [4, 0, 0x10], [0, 0, 0, 16], 'TPE1', [0, 0, 0, 6], [0, 0], [0], 'Tail', [0], footer);
  const file = cat(v22, v24, mp3Frames(), appended);
  const r = await inspectFile(file, 'x.mp3');
  const titlesFound = r.sources.find((s) => s.name === 'ID3v2').fields.filter((f) => f.key === 'Title').map((f) => f.value);
  assert.deepEqual(titlesFound, ['Old one', 'Sync\xff']);
  assert.equal(src(r, 'ID3v2', 'Artist'), 'Tail');
  assert.equal(r.blocks.filter((b) => b.kind === 'ID3v2').length, 3);
  const res = await cleanFile(file, 'x.mp3');
  assert.ok(res.ok, res.reason);
  assert.deepEqual(Buffer.from(res.data), mp3Frames());
});

test('AAC: ADTS stream with ID3 tags', async () => {
  const frames = adtsFrames();
  const file = cat(id3v2([id3Text('TIT2', 'Radio rip')]), frames, id3v1());
  const r = await inspectFile(file, 'x.aac');
  assert.equal(r.format, 'AAC');
  assert.match(src(r, 'Container', 'Codec'), /AAC LC/);
  const res = await cleanFile(file, 'x.aac');
  assert.ok(res.ok, res.reason);
  assert.deepEqual(Buffer.from(res.data), frames);
  await assertClean(res.data, 'x.aac');
});

// ---------- FLAC ----------

test('FLAC: comments, picture, application and padding removed; stream info and seek table kept', async () => {
  const { file, frames, info } = flac({ id3: true, id3end: true });
  const r = await inspectFile(file, 'x.flac');
  assert.equal(r.format, 'FLAC');
  assert.equal(src(r, 'Container', 'Sample rate'), '44100 Hz');
  assert.equal(src(r, 'Container', 'Duration'), '0:01');
  assert.equal(src(r, 'Vorbis comment', 'Vendor'), 'reference libFLAC 1.4.3 20230623');
  assert.equal(src(r, 'Vorbis comment', 'ARTIST'), 'Jane Doe');
  assert.ok(titles(r).includes('Exact location stored'));
  assert.equal(src(r, 'Cover art (Front cover) › JPEG comments', 'Comment'), 'flac cover');
  assert.deepEqual(r.blocks.filter((b) => b.parent === null).map((b) => b.kind), ['ID3v2', 'Vorbis comment', 'Cover art', 'Application data', 'Padding', 'ID3v1']);
  const res = await cleanFile(file, 'x.flac');
  assert.ok(res.ok, res.reason);
  const out = Buffer.from(res.data);
  assert.equal(out.toString('latin1', 0, 4), 'fLaC');
  assert.equal(out[4], 0, 'STREAMINFO first, not last');
  assert.deepEqual(out.subarray(8, 42), info);
  assert.equal(out[42], 0x83, 'SEEKTABLE carries the last-block flag');
  assert.deepEqual(out.subarray(42 + 4 + 18), frames);
  await assertClean(res.data, 'x.flac');
});

// ---------- WAV / AIFF ----------

test('WAV: INFO, bext, iXML, XMP, id3 chunks and trailer removed; RIFF size fixed', async () => {
  const { file, data } = wav({ trailer: 'APPENDED' });
  const r = await inspectFile(file, 'x.wav');
  assert.equal(r.format, 'WAV');
  assert.equal(src(r, 'RIFF INFO', 'Artist'), 'Jane Doe');
  assert.equal(src(r, 'Broadcast WAV', 'Originator'), 'ZOOM H6');
  assert.equal(src(r, 'Broadcast WAV', 'Originator reference'), 'SN-H6-998877');
  assert.equal(src(r, 'Broadcast WAV', 'Origination date'), '2024-05-01 10:30:00');
  assert.match(src(r, 'Broadcast WAV', 'Coding history'), /ZOOM H6/);
  assert.equal(src(r, 'iXML', 'BWFXML › PROJECT'), 'Secret Project');
  assert.equal(src(r, 'ID3v2', 'Artist'), 'Tagged Artist');
  assert.equal(src(r, 'Container', 'Duration'), '0:00.1');
  assert.deepEqual(r.blocks.filter((b) => b.parent === null).map((b) => b.kind), ['RIFF INFO', 'Broadcast WAV', 'iXML', 'XMP', 'ID3v2', 'Trailer']);
  const res = await cleanFile(file, 'x.wav');
  assert.ok(res.ok, res.reason);
  const out = Buffer.from(res.data);
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.deepEqual(out.subarray(out.indexOf('data') + 8, out.indexOf('data') + 8 + data.length), data);
  assert.ok(!has(out, 'ZOOM') && !has(out, 'APPENDED'));
  await assertClean(res.data, 'x.wav');
});

test('AIFF: text, comment, ID3 and application chunks removed; FORM size fixed', async () => {
  const { file, ssnd } = aiff();
  const r = await inspectFile(file, 'x.aiff');
  assert.equal(r.format, 'AIFF');
  assert.equal(src(r, 'Container', 'Sample rate'), '8000 Hz');
  assert.equal(src(r, 'AIFF', 'Author'), 'Jane Doe');
  assert.equal(src(r, 'ID3v2', 'Title'), 'Tagged');
  const res = await cleanFile(file, 'x.aiff');
  assert.ok(res.ok, res.reason);
  const out = Buffer.from(res.data);
  assert.equal(out.readUInt32BE(4), out.length - 8);
  assert.ok(out.includes(ssnd));
  await assertClean(res.data, 'x.aiff');
});

// ---------- Ogg ----------

for (const codec of ['Vorbis', 'Opus']) for (const bigCover of [false, true]) {
  test(`Ogg ${codec}: comment header emptied, pages renumbered with valid CRCs${bigCover ? ' (header spanning many pages)' : ''}`, async () => {
    const { file, audio } = ogg({ codec, bigCover });
    const r = await inspectFile(file, 'x.ogg');
    assert.equal(r.format, codec === 'Opus' ? 'Opus' : 'Ogg');
    const source = codec === 'Opus' ? 'Opus tags' : 'Vorbis comment';
    assert.equal(src(r, source, 'ARTIST'), 'Jane Doe');
    assert.equal(src(r, `Cover art (Front cover) › JPEG comments`, 'Comment'), 'ogg cover');
    assert.ok(src(r, 'Container', 'Duration'));
    const res = await cleanFile(file, 'x.ogg');
    assert.ok(res.ok, res.reason);
    const pages = readOgg(res.data);
    assert.equal(pages.at(-1).flags & 4, 4, 'end of stream flag kept');
    const bodies = Buffer.concat(pages.map((p) => p.body));
    for (const a of audio) assert.ok(bodies.includes(a), 'audio packets unchanged');
    assert.ok(!has(res.data, 'Jane Doe') && !has(res.data, codec === 'Opus' ? 'libopus' : 'libVorbis'));
    await assertClean(res.data, 'x.ogg');
  });
}

// ---------- Matroska / WebM ----------

for (const [label, opts] of [['MKV', {}], ['WebM', { webm: true }], ['live WebM with unknown sizes', { webm: true, live: true }]]) {
  test(`${label}: metadata voided in place, offsets and CRC stay valid`, async () => {
    const { file, blockData } = mkv(opts);
    const r = await inspectFile(file, 'x.mkv');
    assert.equal(r.format, opts.webm ? 'WebM' : 'MKV');
    assert.equal(r.width, 320); assert.equal(r.height, 240);
    assert.equal(src(r, 'Matroska info', 'Title'), 'Family dinner');
    assert.equal(src(r, 'Matroska info', 'Date'), '2025-05-01 08:00:00 UTC');
    assert.equal(src(r, 'Matroska info', 'Segment file name'), 'dinner-final-cut.mkv');
    assert.equal(src(r, 'Matroska tags', 'ARTIST'), 'Jane Doe');
    assert.ok(titles(r).includes('Exact location stored'));
    if (!opts.webm) assert.equal(src(r, 'Attachment 1 (poster.jpg) › JPEG comments', 'Comment'), 'attachment note');
    assert.deepEqual(r.warnings, []);
    const res = await cleanFile(file, 'x.mkv');
    assert.ok(res.ok, res.reason);
    const out = Buffer.from(res.data);
    assert.equal(out.length, file.length, 'same size, so every offset is still valid');
    assert.equal(out.indexOf(blockData), file.indexOf(blockData));
    for (const s of ['Family dinner', 'mkvmerge', 'libebml', 'Jane Doe', 'dinner-final-cut', 'attachment note']) assert.ok(!has(out, s), s);
    assert.ok(!out.includes(Buffer.from([0x12, 0x54, 0xc3, 0x67])), 'the Tags element and its seek entry are gone');
    // Info's CRC-32 matches its new contents. The first match of its ID is the seek entry.
    const infoId = Buffer.from([0x15, 0x49, 0xa9, 0x66]); const at = out.indexOf(infoId, out.indexOf(infoId) + 1) + 4; const len = out[at] & 0x80 ? 1 : 2;
    const size = len === 1 ? out[at] & 0x7f : ((out[at] & 0x3f) << 8) | out[at + 1];
    assert.equal(out.readUInt32LE(at + len + 2), crc32(out.subarray(at + len + 6, at + len + size)));
    const after = await assertClean(res.data, 'x.mkv');
    assert.equal(after.width, 320);
  });
}

// ---------- Hostile input ----------

test('Audio parsers survive corrupted input', async () => {
  const samples = [cat(id3v2(id3Frames()), mp3Frames(), id3v1()), flac().file, wav().file, aiff().file, ogg().file, mkv().file, mkv({ webm: true, live: true }).file];
  for (const sample of samples) {
    for (let i = 0; i < 40; i++) {
      const bad = Buffer.from(sample); for (let k = 0; k < 12; k++) bad[4 + Math.floor(Math.random() * (bad.length - 4))] = Math.floor(Math.random() * 256);
      const cutAt = Math.floor(Math.random() * bad.length);
      for (const input of [bad, bad.subarray(0, cutAt)]) {
        await inspectFile(input, 'x');
        const res = await cleanFile(input, 'x');
        if (res.ok) assert.equal((await inspectFile(res.data, 'x')).cleanable.blocks, 0);
      }
    }
  }
  // Lengths that claim the whole address space.
  await inspectFile(cat('ID3', [3, 0, 0], [0x7f, 0x7f, 0x7f, 0x7f], 'TIT2', u32(0xffffffff)), 'x.mp3');
  await inspectFile(cat('fLaC', [0x04, 0xff, 0xff, 0xff]), 'x.flac');
  await inspectFile(cat('RIFF', u32(0xffffffff, true), 'WAVE', 'LIST', u32(0xfffffff0, true)), 'x.wav');
  await inspectFile(cat([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xf0]), 'x.mkv');
});

test('Media data misread as a trailer is never cut', async () => {
  const { file } = mp4({ moovFirst: true });
  const bad = Buffer.from(file); const at = bad.indexOf('mdat') - 4; bad.writeUInt32BE(8, at);
  const res = await cleanFile(bad, 'x.mp4');
  assert.equal(res.ok, false);
  const m = Buffer.from(mkv().file); const seg = m.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  m[seg + 4] = 0x40; m[seg + 5] = 0x40;
  const r = await inspectFile(m, 'x.mkv');
  assert.ok(r.warnings.some((w) => /damaged|truncated/.test(w)), r.warnings.join());
  assert.equal((await cleanFile(m, 'x.mkv')).ok, false);
});
