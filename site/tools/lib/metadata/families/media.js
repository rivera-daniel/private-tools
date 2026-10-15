// Audio and video: MP3, AAC, FLAC, Ogg, Opus, WAV, AIFF, MP4, MOV, M4A, 3GP, Matroska and WebM.
import { Bytes, startsWith } from '../bytes.js';
import { inspectCover } from '../media/common.js';
import { parseMp4 } from '../media/mp4.js';
import { parseMp3, parseAdts, mpegHeader, adtsHeader, findSync } from '../media/mpeg.js';
import { parseFlac } from '../media/flac.js';
import { parseOgg } from '../media/ogg.js';
import { parseWav, parseAiff } from '../media/riff.js';
import { parseMkv } from '../media/mkv.js';

const QT_TOP = /^(moov|mdat|free|skip|wide|pnot)$/;

export function detect(u8, name) {
  const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (startsWith(u8, 'ftyp', 4) || (u8.length >= 8 && QT_TOP.test(ascii(4, 4)) && ((u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3]) >>> 0 >= 8)) return run(parseMp4);
  if (startsWith(u8, '\x1a\x45\xdf\xa3')) return run(parseMkv);
  if (startsWith(u8, 'OggS')) return run(parseOgg);
  if (startsWith(u8, 'fLaC')) return run(parseFlac);
  if ((startsWith(u8, 'RIFF') || startsWith(u8, 'RF64') || startsWith(u8, 'BW64')) && startsWith(u8, 'WAVE', 8)) return run(parseWav);
  if (startsWith(u8, 'FORM') && (startsWith(u8, 'AIFF', 8) || startsWith(u8, 'AIFC', 8))) return run(parseAiff);
  const b = new Bytes(u8);
  let o = 0;
  // ID3v2 tags can precede MP3, AAC and FLAC data.
  for (let i = 0; i < 8 && b.has(o, 10) && startsWith(u8, 'ID3', o); i++) { const s = [6, 7, 8, 9].map((k) => u8[o + k]); if (s.some((x) => x & 0x80)) break; o += 10 + ((s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]) + (u8[o + 3] === 4 && u8[o + 5] & 0x10 ? 10 : 0); }
  if (startsWith(u8, 'fLaC', o)) return run(parseFlac);
  const window = o || /\.(mp3|mp2|aac)$/i.test(name) ? 65536 : 4096;
  const mp3 = findSync(b, o, u8.length, mpegHeader, 3, window); const aac = findSync(b, o, u8.length, adtsHeader, 3, window);
  if (aac >= 0 && (mp3 < 0 || aac <= mp3)) return run(parseAdts);
  if (mp3 >= 0 || o) return run(parseMp3);
  return null;
}

// Parsers run synchronously and queue the asynchronous work (compressed frames, embedded images) in ctx.
const run = (parse) => async (b, r) => {
  const ctx = { covers: [], pending: [] };
  try { parse(b, r, ctx); }
  finally {
    for (const job of ctx.pending.splice(0, 64)) await job();
    for (const [u8, label] of ctx.covers.slice(0, 32)) await inspectCover(u8, r, label);
  }
};
