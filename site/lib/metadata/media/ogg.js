// Ogg: Vorbis, Opus, FLAC, Speex and Theora streams and their comment headers.
import { Bytes, concat, latin1, fmtBytes } from '../bytes.js';
import { vorbisComment, picture } from './flac.js';
import { duration } from './common.js';

const MAX_PACKET = 32 * 1024 * 1024;

// Ogg's CRC-32: polynomial 0x04C11DB7, not reflected, no final inversion.
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; t[n] = c >>> 0; } return t; })();
export function oggCrc(u8) { let c = 0; for (let i = 0; i < u8.length; i++) c = ((c << 8) ^ TABLE[((c >>> 24) ^ u8[i]) & 0xff]) >>> 0; return c; }

export function oggPage(b, o) {
  if (!b.has(o, 27) || b.ascii(o, 4) !== 'OggS' || b.u8at(o + 4) !== 0) return null;
  const n = b.u8at(o + 26); if (!b.has(o + 27, n)) return null;
  const laces = b.slice(o + 27, n); let body = 0; for (const x of laces) body += x;
  const header = 27 + n; if (!b.has(o + header, body)) return null;
  const lo = b.u32(o + 6, true); const hi = b.u32(o + 10, true);
  return { offset: o, flags: b.u8at(o + 5), granule: hi === 0xffffffff ? -1 : hi * 2 ** 32 + lo, serial: b.u32(o + 14, true), seq: b.u32(o + 18, true), laces, header, body, end: o + header + body };
}

export function codecOf(p) {
  const s = latin1(p.subarray(0, 8));
  if (s.startsWith('\x01vorbis')) return { codec: 'Vorbis', headers: 3 };
  if (s === 'OpusHead') return { codec: 'Opus', headers: 2 };
  if (s.startsWith('\x80theora')) return { codec: 'Theora', headers: 3 };
  if (s === 'Speex   ') return { codec: 'Speex', headers: 2 + (p.length >= 72 ? new Bytes(p).u32(68, true) : 0) };
  if (s.startsWith('\x7fFLAC')) return { codec: 'FLAC', headers: 1 + (p.length >= 9 ? new Bytes(p).u16(7) : 0) };
  if (s.startsWith('fishead')) return { codec: 'Skeleton', headers: 1 };
  return { codec: 'Unknown', headers: 1 };
}

// Reassembles the header packets of every logical stream. Stops once every stream has its headers.
// Header pages must pass their checksum, since a damaged one can hide a comment header from this parser
// while other readers still find it.
export function oggHeaders(b) {
  const streams = new Map(); let o = 0; let pages = 0; let badCrc = false; let orphan = false;
  for (let p; pages < 100000 && (p = oggPage(b, o)); pages++) {
    if (p.flags & 2 && !streams.has(p.serial)) streams.set(p.serial, { serial: p.serial, first: p.offset, packets: [], parts: [], size: 0, start: null, done: false });
    const s = streams.get(p.serial);
    if (!s) orphan = true;
    if (!s || !s.done) {
      const page = new Uint8Array(b.slice(p.offset, p.end - p.offset)); page.fill(0, 22, 26);
      if (oggCrc(page) !== b.u32(p.offset + 22, true)) badCrc = true;
    }
    if (s && !s.done) {
      let at = p.offset + p.header;
      for (const lace of p.laces) {
        if (s.start === null) s.start = p.offset;
        s.parts.push(b.slice(at, lace)); s.size += lace; at += lace;
        if (s.size > MAX_PACKET) { s.done = true; s.oversized = true; break; }
        if (lace < 255) {
          s.packets.push({ data: concat(s.parts), startPage: s.start, endPage: p.end, endsPage: at === p.end });
          s.parts = []; s.size = 0; s.start = null;
          if (s.packets.length === 1) Object.assign(s, codecOf(s.packets[0].data));
          if (s.packets.length >= s.headers) { s.done = true; s.headerEnd = p.end; s.endsPage = at === p.end; break; }
        }
      }
    }
    o = p.end;
    if (streams.size && [...streams.values()].every((x) => x.done) && !(p.flags & 2)) break;
  }
  return { streams: [...streams.values()], stop: o, badCrc, orphan };
}

export function parseOgg(b, r, ctx) {
  r.category = 'Audio'; r.format = 'Ogg';
  const { streams, badCrc, orphan } = oggHeaders(b);
  if (!streams.length) { r.warn('No Ogg pages were found. The file is damaged.'); return; }
  if (badCrc) r.warn('An Ogg header page fails its checksum. The file is damaged.');
  if (streams.some((s) => !s.done)) r.warn('The Ogg stream headers are incomplete. The file is damaged.');
  // Pages of a stream that never began, and a second header that is not the comment header, mean the
  // comments may sit where this parser does not look.
  if (orphan) r.warn('Ogg pages belong to a stream that never began. The file is damaged.');
  const MAGIC = { Vorbis: '\x03vorbis', Opus: 'OpusTags', Theora: '\x81theora' };
  if (streams.some((s) => MAGIC[s.codec] && s.packets[1] && latin1(s.packets[1].data.subarray(0, MAGIC[s.codec].length)) !== MAGIC[s.codec])) r.warn('An Ogg stream lacks its comment header. The file is damaged.');
  if (streams.length === 1 && streams[0].codec === 'Opus') r.format = 'Opus';
  r.field('Container', 'Streams', streams.map((s) => s.codec).join(', '));
  for (const s of streams) {
    const id = s.packets[0]?.data; if (!id) continue;
    const v = new Bytes(id);
    if (s.codec === 'Vorbis' && id.length >= 16) { s.rate = v.u32(12, true); r.field('Container', 'Vorbis', `${v.u8at(11)} ch, ${s.rate} Hz`); }
    else if (s.codec === 'Opus' && id.length >= 16) { s.rate = 48000; s.preskip = v.u16(10, true); r.field('Container', 'Opus', `${v.u8at(9)} ch, input ${v.u32(12, true)} Hz`); }
    else if (s.codec === 'Theora' && id.length >= 20) { r.category = 'Video'; if (r.width === null) { r.width = v.u24(14); r.height = v.u24(17); } r.field('Container', 'Theora', `${v.u24(14)} × ${v.u24(17)}`); }
    else if (s.codec === 'Speex' && id.length >= 40) { s.rate = v.u32(36, true); r.field('Container', 'Speex', `${s.rate} Hz`); }
    else if (s.codec === 'FLAC' && id.length >= 51) { s.rate = (id[27] << 12) | (id[28] << 4) | (id[29] >> 4); r.field('Container', 'FLAC', `${s.rate} Hz`); }
    if (s.oversized) r.field('Container', `${s.codec} headers`, 'Larger than 32 MB, not read');
    comments(s, r, ctx);
  }
  // Duration and trailing data come from the last page, found by scanning back from the end.
  const from = Math.max(0, b.length - 70000); const tail = b.slice(from, b.length - from);
  let last = null;
  for (let i = latin1(tail).lastIndexOf('OggS'); i >= 0 && !last; i = i ? latin1(tail.subarray(0, i)).lastIndexOf('OggS') : -1) last = oggPage(b, from + i);
  if (last) {
    const s = streams.find((x) => x.serial === last.serial);
    if (s?.rate && last.granule > 0) r.field('Container', 'Duration', duration((last.granule - (s.preskip ?? 0)) / s.rate));
    if (last.end < b.length) {
      const rest = b.length - last.end;
      if (b.ascii(last.end, 4) === 'OggS') r.warn('The last Ogg page is truncated.');
      else {
        r.block('Trailer', last.end, rest, { decoded: false, note: 'Data after the last page' });
        r.field('File', 'Data after the last page', fmtBytes(rest), { flag: 'privacy' });
        r.signal('privacy', 'Hidden data after the media', `${fmtBytes(rest)} follow the last Ogg page. Players do not show it.`, 'Ogg trailer', 'hidden data after the media');
      }
    }
  }
}

function comments(s, r, ctx) {
  const block = (kind, p, extra = {}) => r.block(kind, p.startPage, p.endPage - p.startPage, { container: `Ogg ${s.codec} stream ${s.serial}`, ...extra });
  const source = s.codec === 'Opus' ? 'Opus tags' : 'Vorbis comment';
  const run = (p, skip, framing) => {
    const sub = { covers: [] }; const probe = { field() {}, add() {}, signal() {}, warn() {} };
    const info = vorbisComment(p.data.subarray(skip), probe, sub);
    // Only a comment header that still says something counts as removable, so a cleaned file has none.
    if (info && (info.vendor || info.count)) r.within(block(s.codec === 'Opus' ? 'Opus tags' : 'Vorbis comment', p), () => vorbisComment(p.data.subarray(skip), r, ctx, source));
    else if (!info) r.field(source, 'Comment header', 'Malformed');
    if (framing && info && p.data[skip + info.end] !== 1) r.field('Container', 'Comment framing bit', 'Missing');
  };
  const p = s.packets;
  if (s.codec === 'Vorbis' && p[1] && latin1(p[1].data.subarray(0, 7)) === '\x03vorbis') run(p[1], 7, true);
  else if (s.codec === 'Opus' && p[1] && latin1(p[1].data.subarray(0, 8)) === 'OpusTags') run(p[1], 8, false);
  else if (s.codec === 'Theora' && p[1] && latin1(p[1].data.subarray(0, 7)) === '\x81theora') run(p[1], 7, false);
  else if (s.codec === 'Speex' && p[1]) run(p[1], 0, false);
  else if (s.codec === 'FLAC') {
    for (const pk of p.slice(1)) {
      const type = pk.data[0] & 0x7f; const body = pk.data.subarray(4);
      if (type === 4) r.within(block('Vorbis comment', pk), () => vorbisComment(body, r, ctx));
      else if (type === 6) { block('Cover art', pk); picture(body, r, ctx, 'FLAC'); }
      else if (type === 2 || type === 5 || (type === 1 && body.some((x) => x))) block(type === 2 ? 'Application data' : type === 5 ? 'Cue sheet' : 'Padding', pk, { decoded: false });
    }
  }
}
