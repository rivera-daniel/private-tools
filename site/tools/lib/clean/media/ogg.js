// Ogg Vorbis and Opus: replaces the comment header with an empty one, re-paginates the header packets and
// renumbers every later page, recomputing each changed page's CRC. Audio packets are copied unchanged.
import { Bytes, concat } from '../../metadata/bytes.js';
import { oggPage, oggHeaders, oggCrc } from '../../metadata/media/ogg.js';
import { Refusal } from '../index.js';

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
// Empty vendor string, no fields. Vorbis ends its comment header with a framing bit.
const EMPTY = { Vorbis: Uint8Array.from([...ascii('\x03vorbis'), 0, 0, 0, 0, 0, 0, 0, 0, 1]), Opus: Uint8Array.from([...ascii('OpusTags'), 0, 0, 0, 0, 0, 0, 0, 0]) };

export function cleanOgg(u8, report, blocks) {
  if (blocks.some((b) => b.kind !== 'Vorbis comment' && b.kind !== 'Opus tags' && b.kind !== 'Trailer')) throw new Refusal('Only Ogg Vorbis and Opus comments can be cleaned, so the file was left untouched.');
  const b = new Bytes(u8);
  const { streams } = oggHeaders(b);
  const s = streams[0];
  if (streams.length !== 1 || !EMPTY[s?.codec]) throw new Refusal('Only single-stream Ogg Vorbis and Opus files can be cleaned, so the file was left untouched.');
  if (s.packets.length < s.headers || !s.endsPage || s.packets[0].endPage !== s.packets[1].startPage) throw new Refusal('The Ogg headers are laid out unusually, so the file was left untouched.');
  const trailer = blocks.find((x) => x.kind === 'Trailer');
  const end = trailer ? trailer.offset : u8.length;

  // Pages up to the end of the headers are replaced. Count them and check every page belongs to the stream.
  const pages = []; let o = 0;
  for (let p; o < end && (p = oggPage(b, o)); o = p.end) {
    if (p.serial !== s.serial || (p.flags & 2 && p.offset !== 0)) throw new Refusal('The Ogg file holds more than one stream, so it was left untouched.');
    pages.push(p);
  }
  if (o !== end) throw new Refusal('The Ogg pages could not all be read, so the file was left untouched.');
  const first = pages[0]; const last = pages.findIndex((p) => p.end === s.headerEnd);
  if (first.end !== s.packets[0].endPage || last < 1) throw new Refusal('The Ogg headers are laid out unusually, so the file was left untouched.');

  const packets = [EMPTY[s.codec], ...s.packets.slice(2, s.headers).map((p) => p.data)];
  const fresh = paginate(packets, s.serial, 1);
  const delta = fresh.length - last;
  const parts = [u8.subarray(0, first.end), ...fresh];
  for (const p of pages.slice(last + 1)) {
    if (!delta) { parts.push(u8.subarray(p.offset, p.end)); continue; }
    const page = new Uint8Array(u8.subarray(p.offset, p.end)); const view = new DataView(page.buffer);
    view.setUint32(18, (p.seq + delta) >>> 0, true); view.setUint32(22, 0, true); view.setUint32(22, oggCrc(page), true);
    parts.push(page);
  }
  return { data: concat(parts), removed: blocks.map((x) => ({ kind: x.kind, container: x.container ?? '', bytes: x.length })), kept: [`${s.codec} identification${s.codec === 'Vorbis' ? ' and setup' : ''} headers`, 'Audio pages'] };
}

// Lays packets out in pages of up to 255 lacing values. Header pages carry granule position 0, or -1 when no
// packet ends on them.
function paginate(packets, serial, seq) {
  const pages = []; let laces = []; let body = []; let continued = false; let ended = false;
  const flush = () => {
    const data = concat(body); const page = new Uint8Array(27 + laces.length + data.length); const view = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53, 0, continued ? 1 : 0]);
    const granule = ended ? 0 : 0xffffffff; view.setUint32(6, granule, true); view.setUint32(10, granule, true);
    view.setUint32(14, serial, true); view.setUint32(18, seq++, true); page[26] = laces.length; page.set(laces, 27); page.set(data, 27 + laces.length);
    view.setUint32(22, oggCrc(page), true);
    pages.push(page); continued = laces.at(-1) === 255; laces = []; body = []; ended = false;
  };
  for (const p of packets) {
    for (let at = 0; ; at += 255) {
      if (laces.length === 255) flush();
      const n = Math.min(255, p.length - at); laces.push(n); body.push(p.subarray(at, at + n));
      if (n < 255) { ended = true; break; }
    }
  }
  if (laces.length) flush();
  return pages;
}
