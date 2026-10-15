// Audio and video: rewrites the container without its metadata. Audio and video data are never re-encoded.
import { cleanMp4 } from '../media/mp4.js';
import { cleanMpeg, cleanWav, cleanAiff, cleanFlac } from '../media/audio.js';
import { cleanOgg } from '../media/ogg.js';
import { cleanMkv } from '../media/mkv.js';
import { Refusal } from '../index.js';

const CLEANERS = { MP4: cleanMp4, MOV: cleanMp4, M4A: cleanMp4, '3GP': cleanMp4, MP3: cleanMpeg, MP2: cleanMpeg, AAC: cleanMpeg, WAV: cleanWav, AIFF: cleanAiff, FLAC: cleanFlac, Ogg: cleanOgg, Opus: cleanOgg, MKV: cleanMkv, WebM: cleanMkv };
export const formats = new Set(Object.keys(CLEANERS));

export async function clean(u8, report, ctx) {
  const cleaner = CLEANERS[report.format];
  if (!cleaner) throw new Refusal(`${report.format} files cannot be cleaned yet.`);
  return cleaner(u8, report, cleanable(report.blocks));
}

// Removable blocks with no removable ancestor: the units the format cleaners act on.
function cleanable(blocks) {
  const ancestor = (b) => { for (let p = b.parent; p !== null && p !== undefined; p = blocks[p]?.parent) if (blocks[p]?.removable !== false) return true; return false; };
  return blocks.filter((b) => b.removable !== false && !ancestor(b));
}
