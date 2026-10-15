// Matroska and WebM: overwrites metadata elements in place with Void elements of the same size, so every
// offset in the file (seek head, cues, cluster positions) stays valid. Mandatory application names are emptied.
import { Bytes, crc32 } from '../../metadata/bytes.js';
import { element, children, ID } from '../../metadata/media/mkv.js';
import { Refusal } from '../index.js';

const VOIDED = new Set(['Tags', 'Attachments', 'Title', 'Date', 'File name', 'Track name']);

// A Void element filling [o, o + total).
function voidAt(out, o, total) {
  out.fill(0, o, o + total);
  out[o] = ID.Void;
  const rest = total - 2;
  if (rest <= 126) out[o + 1] = 0x80 | rest;
  else { const content = total - 9; out[o + 1] = 0x01; for (let i = 0; i < 7; i++) out[o + 8 - i] = Math.floor(content / 256 ** i) % 256; }
}

// Keeps the element's ID and gives it an empty value; leftover bytes become a Void.
function emptyAt(out, el) {
  const total = el.end - el.offset; const rest = total - el.idLen;
  out.fill(0, el.offset + el.idLen, el.end);
  if (rest <= 8) out[el.offset + el.idLen] = 1 << (8 - rest);
  else { out[el.offset + el.idLen] = 0x80; voidAt(out, el.offset + el.idLen + 1, rest - 1); }
}

export function cleanMkv(u8, report, blocks) {
  const b = new Bytes(u8); const out = new Uint8Array(u8); let end = u8.length; const edits = [];
  for (const blk of blocks) {
    const el = element(b, blk.offset, u8.length);
    if (blk.kind === 'Trailer') { end = blk.offset; continue; }
    if (!el || el.end - el.offset !== blk.length || el.unknown) throw new Refusal('A metadata element could not be located safely, so the file was left untouched.');
    if (VOIDED.has(blk.kind) || blk.kind === 'Attachment') voidAt(out, el.offset, blk.length);
    else if (blk.kind === 'Software') emptyAt(out, el);
    else if (blk.kind === 'Padding') out.fill(0, el.start, el.end);
    else throw new Refusal(`The cleaner does not know how to remove ${blk.kind} from this file, so it was left untouched.`);
    edits.push([el.offset, el.end, el.id]);
  }

  // Seek entries that pointed at removed Tags or Attachments are voided too, then CRC-32 elements of every
  // edited top-level element are recomputed.
  const head = element(b, 0, u8.length);
  for (let o = head.end; o < end;) {
    const seg = element(b, o, u8.length);
    if (!seg || seg.id !== ID.Segment) break;
    const segEnd = Math.min(seg.end, u8.length);
    for (const top of children(b, seg.start, segEnd)) {
      if (top.id === ID.SeekHead) {
        for (const seek of children(b, top.start, top.end)) {
          if (seek.id !== ID.Seek) continue;
          let target = null; let pos = null;
          for (const c of children(b, seek.start, seek.end)) {
            if (c.id === ID.SeekID) { target = 0; for (let i = c.start; i < c.end; i++) target = target * 256 + u8[i]; }
            else if (c.id === ID.SeekPosition) { pos = 0; for (let i = c.start; i < c.end; i++) pos = pos * 256 + u8[i]; }
          }
          if ((target === ID.Tags || target === ID.Attachments) && pos !== null && edits.some(([s, , id]) => s === seg.start + pos && id === target)) { voidAt(out, seek.offset, seek.end - seek.offset); edits.push([seek.offset, seek.end, ID.Seek]); }
        }
      }
      const kids = children(b, top.start, top.end);
      const crc = kids[0]?.id === ID.CRC32 && kids[0].end - kids[0].start === 4 ? kids[0] : null;
      if (crc && edits.some(([s, e]) => s >= top.start && e <= top.end && !(s === top.offset))) {
        const value = crc32(out.subarray(crc.end, top.end));
        new DataView(out.buffer).setUint32(crc.start, value, true);
      }
    }
    o = segEnd;
    if (seg.unknown) break;
  }
  return {
    data: end < out.length ? out.subarray(0, end) : out,
    removed: blocks.map((x) => ({ kind: x.kind, container: x.container ?? '', bytes: x.kind === 'Software' || x.kind === 'Padding' ? 0 : x.length })),
    kept: ['Tracks, clusters and cues unchanged', 'Chapters', 'Segment UID', 'Muxing and writing application fields (emptied)'],
  };
}
