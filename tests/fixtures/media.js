// Synthetic audio and video files built in code: containers carry real structure, sample data is filler.
const enc = new TextEncoder();
const u16 = (n, le = false) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
const u32 = (n, le = false) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n >>> 0) : b.writeUInt32BE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const str = (s) => Buffer.from(s, 'latin1');
const utf8 = (s) => Buffer.from(enc.encode(s));
const cat = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? str(p) : Array.isArray(p) && typeof p[0] !== 'number' ? cat(...p) : Buffer.from(p))));
export { u16, u32, cat, str, utf8 };

// A tiny valid JPEG (8×8 grey, baseline) with an optional COM segment.
export function jpeg(comment = '') {
  const hex = 'ffd8ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080008000801011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9';
  const body = Buffer.from(hex, 'hex');
  if (!comment) return body;
  const c = str(comment);
  return cat(body.subarray(0, 2), [0xff, 0xfe], u16(c.length + 2), c, body.subarray(2));
}

// ---------- ISO base media ----------
export const box = (type, ...parts) => { const body = cat(...parts); return cat(u32(8 + body.length), type, body); };
export const full = (type, version, flags, ...parts) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
const MAC = 2082844800;
const qtText = (s) => { const t = utf8(s); return cat(u16(t.length), u16(0x15c7), t); };
const dataBox = (type, value) => full('data', 0, type, u32(0), value);
// Apple mdta item lists name items by their 1-based index into the keys box.
const keyed = (i, value) => { const d = dataBox(1, utf8(value)); return cat(u32(8 + d.length), u32(i), d); };

// Options: moovFirst, times (seconds since 1970), metadataTrack, udta, mdta, ilst, xmpUuid, trailer, free.
export function mp4({ moovFirst = false, times = 1714557600, metadataTrack = true, udta = true, mdta = true, ilst = false, xmpUuid = false, trailer = '', freeLeftover = '', brand = 'isom', co64 = false, videoRef = false, gopro = false, alias = false } = {}) {
  const video = [cat(str('VIDEOSAMPLE-ONE-'), Buffer.alloc(40, 0x11)), cat(str('VIDEOSAMPLE-TWO-'), Buffer.alloc(24, 0x22))];
  const meta = [gopro ? gpmf() : cat(str('LOCATION-SAMPLE:+37.3317-122.0302/'))];
  const t = times ? times + MAC : 0;
  const build = (offsets) => {
    const mvhd = full('mvhd', 0, 0, u32(t), u32(t), u32(1000), u32(2000), u32(0x10000), u16(0x100), Buffer.alloc(10), Buffer.alloc(36), Buffer.alloc(24), u32(3));
    const stbl = (entry, sizes, offs) => box('stbl', full('stsd', 0, 0, u32(1), entry), full('stts', 0, 0, u32(1), u32(sizes.length), u32(1000)),
      full('stsc', 0, 0, u32(1), u32(1), u32(sizes.length), u32(1)), full('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map((s) => u32(s))),
      co64 ? full('co64', 0, 0, u32(offs.length), ...offs.map(u64)) : full('stco', 0, 0, u32(offs.length), ...offs.map((o) => u32(o))));
    const trak = (id, handler, entry, samples, offs, w = 0, h = 0, extra = []) => box('trak',
      full('tkhd', 0, 3, u32(t), u32(t), u32(id), u32(0), u32(2000), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), Buffer.alloc(36), u32(w << 16), u32(h << 16)),
      ...extra,
      box('mdia', full('mdhd', 0, 0, u32(t), u32(t), u32(1000), u32(2000), u16(0x55c4), u16(0)), full('hdlr', 0, 0, u32(0), handler, Buffer.alloc(12), 'Handler\0'),
        box('minf', box('dinf', full('dref', 0, 0, u32(1), alias && handler === 'vide' ? full('alis', 0, 1, 'Archive disk:clip-original.mov') : full('url ', 0, 1))), stbl(entry, samples.map((s) => s.length), offs))));
    const avc1 = box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(64), u16(48), u32(0x480000), u32(0x480000), u32(0), u16(1), [9], 'TestCodec', Buffer.alloc(22), u16(24), u16(0xffff));
    const mebx = box('mebx', Buffer.alloc(6), u16(1), box('keys', box(u32(1).toString('latin1'), box('keyd', 'mdta', 'com.apple.quicktime.location.ISO6709'))));
    const parts = [mvhd, trak(1, 'vide', avc1, video, [offsets.video], 64, 48, videoRef ? [box('tref', box('vdep', u32(2)))] : [])];
    if (metadataTrack) parts.push(trak(2, 'meta', gopro ? box('gpmd', Buffer.alloc(6), u16(1)) : mebx, meta, [offsets.meta], 0, 0, [box('tref', box('cdsc', u32(1)))]));
    if (gopro) parts.push(box('udta', box('GPMF', klv('DEVC', 0, 1, [klv('DVNM', 0x63, 12, 'HERO12 Black'), klv('CASN', 0x63, 14, 'C3471325208909')]))));
    if (udta) parts.push(box('udta', box('©xyz', qtText('+37.3317-122.0302+010.000/')), box('©mak', qtText('Apple')), box('©mod', qtText('iPhone 15 Pro')), box('©swr', qtText('17.4.1'))));
    if (mdta) parts.push(box('meta', full('hdlr', 0, 0, u32(0), 'mdta', Buffer.alloc(12), '\0'),
      full('keys', 0, 0, u32(3), box('mdta', 'com.apple.quicktime.location.ISO6709'), box('mdta', 'com.apple.quicktime.model'), box('mdta', 'com.apple.quicktime.creationdate')),
      box('ilst', keyed(1, '+40.7128-074.0060+010.000/'), keyed(2, 'iPhone 15 Pro'), keyed(3, '2024-05-01T12:00:00+0200'))));
    if (ilst) parts.push(box('udta', full('meta', 0, 0, full('hdlr', 0, 0, u32(0), 'mdir', 'appl', Buffer.alloc(8), '\0'),
      box('ilst', box('©nam', dataBox(1, utf8('Secret Title'))), box('apID', dataBox(1, utf8('buyer-account-7731'))), box('covr', dataBox(13, jpeg('cover note')))))));
    if (xmpUuid) parts.push(box('uuid', Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'), '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Premiere"/></rdf:RDF></x:xmpmeta>'));
    if (freeLeftover) parts.push(box('free', freeLeftover));
    return box('moov', ...parts.filter((p) => p.length));
  };
  const ftyp = box('ftyp', brand, u32(0), brand, 'mp41');
  const mdatBody = cat(...video, ...meta);
  const layout = (moovLen) => {
    const mdatStart = moovFirst ? ftyp.length + moovLen + 8 : ftyp.length + 8;
    return { video: mdatStart, meta: mdatStart + video[0].length + video[1].length };
  };
  let moov = build(layout(0));
  moov = build(layout(moov.length));
  const mdat = box('mdat', mdatBody);
  const file = moovFirst ? cat(ftyp, moov, mdat) : cat(ftyp, mdat, moov);
  return { file: cat(file, trailer), video, meta };
}

// GoPro GPMF key-length-value data: key, type, struct size, repeat, payload padded to 4 bytes.
function klv(key, type, size, payload) { const body = Array.isArray(payload) ? cat(...payload) : typeof payload === 'string' ? str(payload) : payload; const repeat = type === 0 ? body.length : body.length / size; return cat(key, [type, type === 0 ? 1 : size], u16(repeat), body, Buffer.alloc((4 - (body.length % 4)) % 4)); }
const i32s = (...v) => Buffer.concat(v.map((x) => { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(x)); return b; }));
const gpmf = () => klv('DEVC', 0, 1, [klv('DVNM', 0x63, 12, 'HERO12 Black'), klv('STRM', 0, 1, [klv('STNM', 0x63, 3, 'GPS'), klv('SCAL', 0x6c, 4, i32s(1e7, 1e7, 1000, 1000, 100)), klv('GPS5', 0x6c, 20, i32s(46.5197 * 1e7, 6.6323 * 1e7, 372000, 0, 0))])]);

// Reads every chunk offset of every stco/co64 box (a flat walk is enough for these fixtures).
export function chunkOffsets(u8) {
  const b = Buffer.from(u8); const out = [];
  for (const type of ['stco', 'co64']) {
    let i = 0;
    while ((i = b.indexOf(type, i)) > 0) {
      const n = b.readUInt32BE(i + 8);
      for (let k = 0; k < n; k++) out.push(type === 'co64' ? Number(b.readBigUInt64BE(i + 12 + k * 8)) : b.readUInt32BE(i + 12 + k * 4));
      i += 4;
    }
  }
  return out;
}

// ---------- MPEG audio and tags ----------
const synchsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const id3frame = (id, body, v = 3) => cat(id, v === 4 ? synchsafe(body.length) : u32(body.length), u16(0), body);
export const id3Text = (id, s, v = 3) => id3frame(id, cat([3], utf8(s)), v);
export function id3v2(frames, { version = 3, flags = 0, padding = 0 } = {}) {
  const body = cat(...frames, Buffer.alloc(padding));
  return cat('ID3', [version, 0, flags], synchsafe(body.length), body);
}
export const id3Frames = () => [
  id3Text('TIT2', 'Voice memo'), id3Text('TPE1', 'Jane Doe'), id3Text('TSSE', 'LAME 3.100'), id3Text('TOWN', 'jane.doe'),
  id3frame('COMM', cat([3], 'eng', 'note\0', utf8('meet at the station'))),
  id3frame('TXXX', cat([3], 'MusicBrainz Album Id\0', utf8('1234-5678'))),
  id3frame('PRIV', cat('WM/UniqueFileIdentifier\0', 'AMGa_id=R 123456;')),
  id3frame('POPM', cat('jane-rating-account\0', [196], u32(7))),
  id3frame('GEOB', cat([0], 'text/plain\0', 'notes.txt\0', 'attachment\0', 'private notes')),
  id3frame('APIC', cat([0], 'image/jpeg\0', [3], 'front\0', jpeg('art comment'))),
];
export function id3v1({ title = 'Old Title', artist = 'Old Artist', track = 7 } = {}) {
  const f = (s, n) => Buffer.concat([str(s), Buffer.alloc(n)]).subarray(0, n);
  return cat('TAG', f(title, 30), f(artist, 30), f('Album', 30), '2001', f('v1 comment', 28), [0, track, 12]);
}
export function apeTag(items) {
  const body = cat(...items.map(([k, v, binary]) => cat(u32(v.length, true), u32(binary ? 2 : 0, true), k, [0], v)));
  const footer = (header) => cat('APETAGEX', u32(2000, true), u32(body.length + 32, true), u32(items.length, true), u32(header ? 0xa0000000 : 0x80000000, true), Buffer.alloc(8));
  return cat(footer(true), body, footer(false));
}
export function lyrics3(fields) {
  const body = cat('LYRICSBEGIN', ...fields.map(([id, v]) => cat(id, String(v.length).padStart(5, '0'), v)));
  return cat(body, String(body.length).padStart(6, '0'), 'LYRICS200');
}
// MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono: 417-byte frames. The first one carries a Xing/LAME header.
export function mp3Frames(n = 6) {
  const frame = (i) => { const f = Buffer.alloc(417); f.set([0xff, 0xfb, 0x90, 0xc0]); f.write(i ? `AUDIO-${i}` : 'Info', i ? 40 : 21, 'latin1'); if (!i) { f.writeUInt32BE(1, 25); f.writeUInt32BE(n, 29); f.write('LAME3.100', 33, 'latin1'); } return f; };
  return Buffer.concat(Array.from({ length: n }, (_, i) => frame(i)));
}
export function adtsFrames(n = 6) {
  return Buffer.concat(Array.from({ length: n }, (_, i) => { const len = 32; const f = Buffer.alloc(len); f.set([0xff, 0xf1, 0x50, 0x40 | (len >> 11), (len >> 3) & 255, ((len & 7) << 5) | 0x1f, 0xfc]); f.write(`AAC${i}`, 8, 'latin1'); return f; }));
}

// ---------- FLAC ----------
const flacBlock = (type, body, last = false) => cat([(last ? 0x80 : 0) | type], [(body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255], body);
export function vorbisCommentBody(vendor, fields) { return cat(u32(utf8(vendor).length, true), utf8(vendor), u32(fields.length, true), ...fields.map((f) => cat(u32(utf8(f).length, true), utf8(f)))); }
export function flacPicture(image, type = 3) { return cat(u32(type), u32(10), 'image/jpeg', u32(5), 'front', u32(8), u32(8), u32(24), u32(0), u32(image.length), image); }
export function flac({ id3 = false, id3end = false } = {}) {
  const info = Buffer.alloc(34); info.writeUInt16BE(4096, 0); info.writeUInt16BE(4096, 2);
  info.set([0x0a, 0xc4, 0x40, 0xf0], 10); info.writeUInt32BE(44100, 14); // 44.1 kHz, 1 channel, 16 bits, 44100 samples
  const frames = cat([0xff, 0xf8, 0x69, 0x08], str('FLAC-AUDIO-FRAMES'), Buffer.alloc(64, 0x33));
  const meta = cat('fLaC', flacBlock(0, info), flacBlock(3, cat(u64(0), u64(0), u16(4096))),
    flacBlock(4, vorbisCommentBody('reference libFLAC 1.4.3 20230623', ['TITLE=Interview', 'ARTIST=Jane Doe', 'LOCATION=+48.8584+002.2945/', 'COMMENT=draft'])),
    flacBlock(6, flacPicture(jpeg('flac cover'))), flacBlock(2, cat('riff', 'LIST....INFOISFT')), flacBlock(1, cat(Buffer.alloc(8), 'leftover'), true));
  return { file: cat(id3 ? id3v2([id3Text('TIT2', 'Prepended')]) : '', meta, frames, id3end ? id3v1() : ''), frames, info };
}

// ---------- WAV and AIFF ----------
const riffChunk = (id, body, le = true) => cat(id, u32(body.length, le), body, body.length & 1 ? [0] : []);
export function wav({ trailer = '' } = {}) {
  const fmt = cat(u16(1, true), u16(1, true), u32(8000, true), u32(16000, true), u16(2, true), u16(16, true));
  const data = Buffer.alloc(1600, 0x10);
  const info = cat('INFO', riffChunk('INAM', str('Session 4\0')), riffChunk('IART', str('Jane Doe\0')), riffChunk('ISFT', str('Recorder 2.1\0')), riffChunk('ICRD', str('2024-05-01\0')));
  const bext = Buffer.alloc(602); bext.write('Field recording', 0, 'latin1'); bext.write('ZOOM H6', 256, 'latin1'); bext.write('SN-H6-998877', 288, 'latin1'); bext.write('2024-05-01', 320, 'latin1'); bext.write('10:30:00', 330, 'latin1'); bext.writeUInt16LE(1, 346);
  const body = cat('WAVE', riffChunk('fmt ', fmt), riffChunk('LIST', info), riffChunk('bext', cat(bext, 'A=PCM,F=8000,W=16,M=mono,T=ZOOM H6\r\n')),
    riffChunk('iXML', str('<?xml version="1.0"?><BWFXML><PROJECT>Secret Project</PROJECT><NOTE>take 3</NOTE><USER>jane</USER></BWFXML>')),
    riffChunk('data', data), riffChunk('_PMX', str('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Audition"/></rdf:RDF></x:xmpmeta>')),
    riffChunk('id3 ', id3v2([id3Text('TPE1', 'Tagged Artist')])), riffChunk('JUNK', Buffer.alloc(9)));
  return { file: cat('RIFF', u32(body.length, true), body, trailer), data };
}
export function aiff() {
  const comm = cat(u16(1), u32(800), u16(16), Buffer.from('400bfa00000000000000', 'hex'));
  const ssnd = cat(u32(0), u32(0), Buffer.alloc(1600, 0x20));
  const body = cat('AIFF', riffChunk('COMM', comm, false), riffChunk('NAME', str('Demo take'), false), riffChunk('AUTH', str('Jane Doe'), false), riffChunk('ANNO', str('rough mix'), false),
    riffChunk('SSND', ssnd, false), riffChunk('ID3 ', id3v2([id3Text('TIT2', 'Tagged')]), false), riffChunk('APPL', cat('stoc', 'PRO TOOLS SESSION'), false));
  return { file: cat('FORM', u32(body.length), body), ssnd };
}

// ---------- Ogg ----------
const OGG = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; t[n] = c >>> 0; } return t; })();
export const oggCrc = (u8) => { let c = 0; for (const x of u8) c = ((c << 8) ^ OGG[((c >>> 24) ^ x) & 255]) >>> 0; return c; };
export function oggPage({ flags = 0, granule = 0, serial = 0x1234, seq, laces, body }) {
  const p = cat('OggS', [0, flags], u32(granule >>> 0, true), u32(granule < 0 ? 0xffffffff : 0, true), u32(serial, true), u32(seq, true), u32(0), [laces.length], laces, body);
  p.writeUInt32LE(oggCrc(p), 22); return p;
}
// Packets laid out one after another; a new page starts when 255 lacing values are used or after the packets
// in `breakAfter`. A page's granule position is that of the last packet ending on it, -1 when none does.
export function oggPages(packets, { serial = 0x1234, breakAfter = new Set(), granule = () => 0 } = {}) {
  const pages = []; let laces = []; let body = []; let cont = false; let last = -1; let seq = 0;
  const flush = (eos) => { pages.push(oggPage({ flags: (cont ? 1 : 0) | (seq === 0 ? 2 : 0) | (eos ? 4 : 0), granule: last >= 0 ? granule(last) : -1, serial, seq, laces, body: cat(...body) })); seq++; cont = laces.at(-1) === 255; laces = []; body = []; last = -1; };
  packets.forEach((p, i) => {
    for (let at = 0; ; at += 255) { if (laces.length === 255) flush(); const n = Math.min(255, p.length - at); laces.push(n); body.push(p.subarray(at, at + n)); if (n < 255) { last = i; break; } }
    if (breakAfter.has(i) && i < packets.length - 1) flush();
  });
  flush(true);
  return pages;
}
export function ogg({ codec = 'Vorbis', bigCover = false } = {}) {
  const cover = flacPicture(bigCover ? cat(jpeg('ogg cover'), Buffer.alloc(70000, 0x44)) : jpeg('ogg cover'));
  const fields = ['TITLE=Podcast 12', 'ARTIST=Jane Doe', 'ENCODED_BY=jane', `METADATA_BLOCK_PICTURE=${cover.toString('base64')}`];
  const audio = [cat('AUDIO-PACKET-1', Buffer.alloc(100, 1)), cat('AUDIO-PACKET-2', Buffer.alloc(300, 2)), cat('AUDIO-PACKET-3', Buffer.alloc(50, 3))];
  const headers = codec === 'Vorbis'
    ? [cat([1], 'vorbis', u32(0), [1], u32(44100, true), u32(0), u32(64000, true), u32(0), [0xb8, 1]), cat([3], 'vorbis', vorbisCommentBody('Xiph.Org libVorbis I 20200704', fields), [1]), cat([5], 'vorbis', Buffer.alloc(400, 0x55))]
    : [cat('OpusHead', [1, 1], u16(312, true), u32(48000, true), u16(0), [0]), cat('OpusTags', vorbisCommentBody('libopus 1.4', fields))];
  const n = headers.length;
  const pages = oggPages([...headers, ...audio], { breakAfter: new Set([0, n - 1, n, n + 1]), granule: (i) => Math.max(0, i - n + 1) * 44100 });
  return { file: cat(...pages), audio };
}
// Every page: valid CRC, contiguous sequence numbers. Returns the pages.
export function readOgg(u8) {
  const b = Buffer.from(u8); const pages = []; let o = 0;
  while (o < b.length) {
    if (b.toString('latin1', o, o + 4) !== 'OggS') throw new Error(`no page at ${o}`);
    const n = b[o + 26]; const laces = b.subarray(o + 27, o + 27 + n); const len = laces.reduce((a, x) => a + x, 0);
    const page = Buffer.from(b.subarray(o, o + 27 + n + len)); const crc = page.readUInt32LE(22); page.writeUInt32LE(0, 22);
    if (oggCrc(page) !== crc) throw new Error(`bad CRC at page ${pages.length}`);
    if (b.readUInt32LE(o + 18) !== pages.length) throw new Error(`sequence ${b.readUInt32LE(o + 18)} at page ${pages.length}`);
    pages.push({ flags: b[o + 5], laces: [...laces], body: b.subarray(o + 27 + n, o + 27 + n + len) });
    o += 27 + n + len;
  }
  return pages;
}

// ---------- Matroska ----------
const idBytes = (id) => { const out = []; for (let v = id; v; v = Math.floor(v / 256)) out.unshift(v & 255); return Buffer.from(out); };
const sizeVint = (n) => { for (let len = 1; len <= 8; len++) if (n < 2 ** (7 * len) - 1) { const b = Buffer.alloc(len); let v = n; for (let i = len - 1; i >= 0; i--) { b[i] = v & 255; v = Math.floor(v / 256); } b[0] |= 0x80 >> (len - 1); return b; } throw new Error('too big'); };
export const ebml = (id, ...parts) => { const body = cat(...parts); return cat(idBytes(id), sizeVint(body.length), body); };
export const ebmlUnknown = (id, ...parts) => cat(idBytes(id), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], ...parts);
const euint = (id, n, len = 1) => { const b = Buffer.alloc(len); let v = n; for (let i = len - 1; i >= 0; i--) { b[i] = v & 255; v = Math.floor(v / 256); } return ebml(id, b); };
const estr = (id, s) => ebml(id, utf8(s));
export function crc32(u8) { let c = ~0; for (const x of u8) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; }
export function mkv({ webm = false, live = false } = {}) {
  const infoBody = cat(ebml(0x73a4, Buffer.alloc(16, 0xab)), euint(0x2ad7b1, 1000000, 3), ebml(0x4489, Buffer.from('447a0000', 'hex')), estr(0x7ba9, 'Family dinner'), estr(0x4d80, 'libebml v1.4.4 + libmatroska v1.7.1'), estr(0x5741, "mkvmerge v80.0 ('Roundabout') 64-bit"), ebml(0x4461, u64(767779200000000000)), estr(0x7384, 'dinner-final-cut.mkv'));
  const info = ebml(0x1549a966, ebml(0xbf, u32(crc32(infoBody), true)), infoBody);
  const tracks = ebml(0x1654ae6b, ebml(0xae, euint(0xd7, 1), euint(0x73c5, 99), euint(0x83, 1), estr(0x86, webm ? 'V_VP8' : 'V_MPEG4/ISO/AVC'), estr(0x536e, 'Recorded on Jane’s phone'), ebml(0xe0, euint(0xb0, 320, 2), euint(0xba, 240, 2))));
  const blockData = cat([0x81, 0, 0, 0x80], str('VIDEO-FRAME-DATA'), Buffer.alloc(200, 0x66));
  const cluster = live ? ebmlUnknown(0x1f43b675, euint(0xe7, 0), ebml(0xa3, blockData), ebml(0xa3, blockData)) : ebml(0x1f43b675, euint(0xe7, 0), ebml(0xa3, blockData));
  const attachments = webm ? Buffer.alloc(0) : ebml(0x1941a469, ebml(0x61a7, estr(0x467e, 'poster'), estr(0x466e, 'poster.jpg'), estr(0x4660, 'image/jpeg'), ebml(0x465c, jpeg('attachment note')), euint(0x46ae, 7)));
  const tags = ebml(0x1254c367, ebml(0x7373, ebml(0x63c0, euint(0x68ca, 50)), ebml(0x67c8, estr(0x45a3, 'ARTIST'), estr(0x4487, 'Jane Doe')), ebml(0x67c8, estr(0x45a3, 'RECORDING_LOCATION'), estr(0x4487, '+51.5007-000.1246/')), ebml(0x67c8, estr(0x45a3, 'COMMENT'), estr(0x4487, 'the secret'))));
  const chapters = webm ? Buffer.alloc(0) : ebml(0x1043a770, ebml(0x45b9, ebml(0xb6, euint(0x73c4, 1), euint(0x91, 0), ebml(0x80, estr(0x85, 'Opening')))));
  // The seek head goes first; its positions are relative to the segment data, so lay out twice.
  const seekFor = (positions) => ebml(0x114d9b74, ...positions.map(([id, pos]) => ebml(0x4dbb, ebml(0x53ab, idBytes(id)), euint(0x53ac, pos, 4))));
  const rest = live ? [info, tracks, tags, cluster] : [info, tracks, chapters, cluster, attachments, tags];
  const ids = live ? [0x1549a966, 0x1654ae6b, 0x1254c367] : [0x1549a966, 0x1654ae6b, 0x1043a770, 0x1f43b675, 0x1941a469, 0x1254c367];
  const layout = (seekLen) => { let o = seekLen; const out = []; for (const [i, part] of rest.entries()) { if (ids[i] !== undefined && part.length) out.push([ids[i], o]); o += part.length; } return out; };
  let seek = seekFor(layout(0).map(([id]) => [id, 0])); seek = seekFor(layout(seek.length));
  const body = cat(seek, ...rest);
  const head = ebml(0x1a45dfa3, euint(0x4286, 1), euint(0x42f7, 1), euint(0x42f2, 4), euint(0x42f3, 8), estr(0x4282, webm ? 'webm' : 'matroska'), euint(0x4287, 4), euint(0x4285, 2));
  const segment = live ? ebmlUnknown(0x18538067, body) : ebml(0x18538067, body);
  return { file: cat(head, segment), blockData, info, infoBody };
}
