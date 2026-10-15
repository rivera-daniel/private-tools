// MPEG audio (MP3, MP2) and ADTS AAC streams, with their ID3, APE and Lyrics3 tags.
import { printable, fmtBytes } from '../bytes.js';
import { parseId3v2, trailingTags } from './id3.js';
import { duration } from './common.js';

const BR1 = { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] };
const BR2 = { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MODES = ['Stereo', 'Joint stereo', 'Dual channel', 'Mono'];
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_PROFILES = ['Main', 'LC', 'SSR', 'LTP'];

export function mpegHeader(b, o) {
  if (!b.has(o, 4)) return null;
  const h = b.u32(o);
  if (h >>> 21 !== 0x7ff) return null;
  const ver = (h >>> 19) & 3; const lb = (h >>> 17) & 3; const bi = (h >>> 12) & 15; const si = (h >>> 10) & 3;
  if (ver === 1 || lb === 0 || bi === 0 || bi === 15 || si === 3) return null;
  const layer = 4 - lb; const v1 = ver === 3; const bitrate = (v1 ? BR1 : BR2)[layer][bi] * 1000; const rate = RATES[ver][si]; const pad = (h >>> 9) & 1;
  const length = layer === 1 ? (Math.floor((12 * bitrate) / rate) + pad) * 4 : Math.floor(((layer === 3 && !v1 ? 72 : 144) * bitrate) / rate) + pad;
  return { ver, layer, v1, bitrate, rate, mode: (h >>> 6) & 3, length, samples: layer === 1 ? 384 : layer === 3 && !v1 ? 576 : 1152, crc: !((h >>> 16) & 1) };
}

export function adtsHeader(b, o) {
  if (!b.has(o, 7) || b.u8at(o) !== 0xff || (b.u8at(o + 1) & 0xf6) !== 0xf0) return null;
  const sf = (b.u8at(o + 2) >> 2) & 15; if (sf > 12) return null;
  const length = ((b.u8at(o + 3) & 3) << 11) | (b.u8at(o + 4) << 3) | (b.u8at(o + 5) >> 5);
  if (length < 7) return null;
  return { length, rate: AAC_RATES[sf], channels: ((b.u8at(o + 2) & 1) << 2) | (b.u8at(o + 3) >> 6), profile: b.u8at(o + 2) >> 6, mpeg2: !!(b.u8at(o + 1) & 8) };
}

// First offset in [from, from + window) where `frames` consecutive headers chain together.
export function findSync(b, from, end, read, frames = 3, window = 65536) {
  for (let o = from; o < Math.min(end, from + window); o++) {
    if (b.u8.at(o) !== 0xff) continue;
    let at = o; let n = 0; const first = read(b, o);
    while (n < frames) {
      const h = read(b, at);
      if (!h || (n && (h.rate !== first.rate || h.layer !== first.layer))) break;
      n++; at += h.length;
      // A frame cut off by the end of the file counts only after a whole one, so two sync bytes alone
      // (a UTF-16 byte order mark, for example) are not audio.
      if (at >= end) { if (n >= 2 || at === end) n = frames; break; }
    }
    if (n >= frames) return o;
  }
  return -1;
}

export function leadingTags(b, r, ctx) {
  let o = 0;
  for (let i = 0; i < 8; i++) { const n = parseId3v2(b, o, r, ctx); if (!n) break; o += n; }
  return o;
}

export function parseMp3(b, r, ctx) {
  r.category = 'Audio';
  const start = leadingTags(b, r, ctx);
  const end = trailingTags(b, r, ctx, b.length);
  const first = findSync(b, start, end, mpegHeader);
  const h = first >= 0 ? mpegHeader(b, first) : null;
  r.format = h?.layer === 2 ? 'MP2' : 'MP3';
  if (!h) { r.field('Container', 'Audio', 'No MPEG audio frames found'); return; }
  r.struct('Audio frames', first, end - first);
  r.field('Container', 'Codec', `MPEG-${h.v1 ? '1' : h.ver === 2 ? '2' : '2.5'} Layer ${['', 'I', 'II', 'III'][h.layer]}`);
  r.field('Container', 'Sample rate', `${h.rate} Hz`);
  r.field('Container', 'Channels', MODES[h.mode]);
  // Xing/Info and VBRI headers sit in the first frame. The LAME extension names the encoder.
  const side = h.v1 ? (h.mode === 3 ? 17 : 32) : h.mode === 3 ? 9 : 17;
  let frames = 0; let vbr = false;
  for (const at of [first + 4 + side, first + 6 + side]) {
    const id = b.has(at, 8) ? b.ascii(at, 4) : '';
    if (id !== 'Xing' && id !== 'Info') continue;
    const flags = b.u32(at + 4); let p = at + 8; vbr = id === 'Xing';
    if (flags & 1) { frames = b.u32(p); p += 4; }
    if (flags & 2) p += 4;
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    const encoder = b.has(p, 9) ? printable(b.ascii(p, 9)) : '';
    if (encoder) r.field('Container', 'Encoder (in the audio stream)', encoder);
    break;
  }
  if (b.has(first + 36, 18) && b.ascii(first + 36, 4) === 'VBRI') { frames = b.u32(first + 50); vbr = true; r.field('Container', 'VBR header', `VBRI version ${b.u16(first + 40)}`); }
  r.field('Container', 'Bitrate', vbr ? 'Variable' : `${h.bitrate / 1000} kbps`);
  r.field('Container', 'Duration', duration(frames ? (frames * h.samples) / h.rate : ((end - first) * 8) / h.bitrate));
  if (first > start) r.field('Container', 'Bytes before the first frame', fmtBytes(first - start));
}

export function parseAdts(b, r, ctx) {
  r.category = 'Audio'; r.format = 'AAC';
  const start = leadingTags(b, r, ctx);
  const end = trailingTags(b, r, ctx, b.length);
  const first = findSync(b, start, end, adtsHeader);
  const h = first >= 0 ? adtsHeader(b, first) : null;
  if (!h) { r.field('Container', 'Audio', 'No ADTS frames found'); return; }
  let frames = 0; let o = first;
  for (let x; frames < 4000000 && (x = adtsHeader(b, o)) && o + x.length <= end; frames++) o += x.length;
  r.struct('Audio frames', first, end - first);
  r.field('Container', 'Codec', `AAC ${AAC_PROFILES[h.profile]} (ADTS, MPEG-${h.mpeg2 ? 2 : 4})`);
  r.field('Container', 'Sample rate', `${h.rate} Hz`);
  r.field('Container', 'Channels', String(h.channels));
  r.field('Container', 'Duration', duration((frames * 1024) / h.rate));
}
