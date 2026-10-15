// MP3, AAC, WAV, AIFF and FLAC: the metadata units are whole tags, chunks or metadata blocks, so cleaning cuts
// them out and fixes the container's size fields. Audio bytes are copied unchanged.
import { Bytes, concat } from '../../metadata/bytes.js';
import { flacAudioStart } from '../../metadata/media/flac.js';
import { Refusal } from '../index.js';

const removedList = (blocks) => blocks.map((b) => ({ kind: b.kind, container: b.container ?? '', bytes: b.length }));

function cut(u8, blocks) {
  const ranges = blocks.map((b) => {
    if (!Number.isInteger(b.offset) || !Number.isInteger(b.length) || b.offset < 0 || b.length <= 0 || b.offset + b.length > u8.length) throw new Refusal('A metadata block could not be located safely, so the file was left untouched.');
    return [b.offset, b.offset + b.length];
  }).sort((a, c) => a[0] - c[0]);
  const parts = []; let at = 0;
  for (const [s, e] of ranges) { if (s > at) parts.push(u8.subarray(at, s)); at = Math.max(at, e); }
  parts.push(u8.subarray(at));
  return concat(parts);
}

export function cleanMpeg(u8, report, blocks) {
  const encoder = report.sources.flatMap((x) => x.fields).find((f) => f.key === 'Encoder (in the audio stream)')?.value;
  return { data: cut(u8, blocks), removed: removedList(blocks), kept: [`Audio frames, including the encoder header frame${encoder ? ` (names the encoder: ${encoder})` : ''}`] };
}

// The audio payload must come out byte for byte, or the cut touched it.
function payload(u8, id, le) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let o = 12, i = 0; o + 8 <= u8.length && i < 10000; i++) {
    let size = v.getUint32(o + 4, le);
    if (String.fromCharCode(...u8.subarray(o, o + 4)) === id) { if (size === 0xffffffff) size = u8.length - o - 8; return u8.subarray(o + 8, Math.min(u8.length, o + 8 + size)); }
    o += 8 + size + (size & 1);
  }
  return null;
}
function sameAudio(a, b, id, le) {
  const x = payload(a, id, le); const y = payload(b, id, le);
  if (!x || !y || x.length !== y.length || x.some((v, i) => v !== y[i])) throw new Refusal('The audio data would not have survived unchanged, so the file was left untouched.');
}

export function cleanWav(u8, report, blocks) {
  const out = cut(u8, blocks);
  sameAudio(u8, out, 'data', true); const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (String.fromCharCode(...out.subarray(0, 4)) === 'RIFF') view.setUint32(4, out.length - 8, true);
  else {
    // RF64 and BW64 keep the real file size in the ds64 chunk.
    if (String.fromCharCode(...out.subarray(12, 16)) !== 'ds64') throw new Refusal('The 64-bit WAV size chunk is missing, so the file was left untouched.');
    const size = out.length - 8; view.setUint32(20, size >>> 0, true); view.setUint32(24, Math.floor(size / 2 ** 32), true);
  }
  return { data: out, removed: removedList(blocks), kept: ['Format, audio data, cue points, sampler and instrument chunks'] };
}

export function cleanAiff(u8, report, blocks) {
  const out = cut(u8, blocks);
  sameAudio(u8, out, 'SSND', false);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, out.length - 8);
  return { data: out, removed: removedList(blocks), kept: ['Common, sound data, marker and instrument chunks'] };
}

// FLAC keeps STREAMINFO and SEEKTABLE, with the last-block flag moved to whichever comes last.
export function cleanFlac(u8, report, blocks) {
  const info = flacAudioStart(new Bytes(u8));
  if (!info || info.blocks[0]?.type !== 0) throw new Refusal('The FLAC metadata could not be read safely, so the file was left untouched.');
  const end = Math.min(u8.length, ...blocks.filter((b) => b.offset >= info.audio).map((b) => b.offset));
  if (blocks.some((b) => b.offset < info.audio && b.offset + b.length > info.audio) || blocks.some((b) => b.offset >= info.audio && b.offset + b.length > u8.length)) throw new Refusal('A metadata block overlaps the audio, so the file was left untouched.');
  const kept = info.blocks.filter((b) => b.type === 0 || b.type === 3).map((b) => new Uint8Array(u8.subarray(b.offset, b.offset + b.length)));
  kept.forEach((b, i) => { b[0] = (b[0] & 0x7f) | (i === kept.length - 1 ? 0x80 : 0); });
  const tail = cut(u8, blocks.filter((b) => b.offset >= end)).subarray(info.audio);
  return { data: concat([u8.subarray(info.signature, info.signature + 4), ...kept, tail]), removed: removedList(blocks), kept: ['Stream info and seek table', 'Audio frames'] };
}
