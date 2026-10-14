import { Bytes, utf8, latin1, concat, fmtBytes, bytesValue, clean } from '../bytes.js';
import { parseXmp } from '../xmp.js';
import { parseIcc } from '../icc.js';

export async function parseGif(b, r) {
  r.format = 'GIF';
  const version = b.ascii(0, 6);
  r.width = b.u16(6, true); r.height = b.u16(8, true);
  const flags = b.u8at(10);
  r.field('GIF', 'Version', version);
  r.field('GIF', 'Global color table', flags & 0x80 ? `${2 ** ((flags & 7) + 1)} colors` : 'None');
  r.struct('Header', 0, 13);
  let o = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  if (o > 13) r.struct('Global color table', 13, o - 13);
  let frames = 0; let blocks = 0; let delays = 0;
  while (o < b.length) {
    if (++blocks > 100000) { r.warn('Too many GIF blocks. Inspection stopped early.'); break; }
    const intro = b.u8at(o);
    if (intro === 0x3b) { r.struct('Trailer', o, 1); o++; break; }
    if (intro === 0x2c) {
      frames++;
      const f = b.u8at(o + 9); let p = o + 10 + (f & 0x80 ? 3 * 2 ** ((f & 7) + 1) : 0);
      p++; // LZW minimum code size
      const end = skipSubBlocks(b, p);
      if (frames <= 1 || frames % 100 === 0) r.struct(`Image ${frames}`, o, end - o);
      o = end; continue;
    }
    if (intro !== 0x21) { r.warn('Unexpected byte in the GIF block stream.'); break; }
    const label = b.u8at(o + 1); const start = o;
    if (label === 0xf9) { const size = b.u8at(o + 2); if (size >= 4) delays += b.u16(o + 4, true); o = skipSubBlocks(b, o + 2); continue; }
    if (label === 0xfe) {
      const { data, end } = readSubBlocks(b, o + 2);
      const text = bytesValue(data);
      r.field('GIF comments', 'Comment', text); r.add('Comments', 'GIF comment', text);
      r.block('Comment', start, end - start, { container: 'Comment extension' }); r.struct('Comment', start, end - start); o = end; continue;
    }
    if (label === 0xff) {
      const size = b.u8at(o + 2); const app = latin1(b.slice(o + 3, size)); const { data, end } = readSubBlocks(b, o + 3 + size);
      if (app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') { const loops = data.length >= 3 ? data[1] | (data[2] << 8) : 0; r.field('GIF', 'Loop count', loops ? String(loops) : 'Forever'); }
      else if (app === 'XMP DataXMP') {
        // XMP is stored raw with a 257-byte "magic trailer" so decoders can skip it.
        const raw = b.slice(o + 3 + size, end - (o + 3 + size));
        const xml = utf8.decode(raw.subarray(0, Math.max(0, raw.length - 258)));
        parseXmp(xml, r); r.block('XMP', start, end - start, { container: 'XMP application extension' });
      } else if (app === 'ICCRGBG1012') { parseIcc(new Bytes(data), r); r.block('ICC', start, end - start, { container: 'ICC application extension', removable: false }); }
      else { r.field('GIF', `Application extension ${clean(app)}`, `${fmtBytes(data.length)}, not decoded`); r.block('Application data', start, end - start, { container: clean(app), decoded: false }); }
      r.struct(`Application ${clean(app)}`, start, end - start);
      o = end; continue;
    }
    if (label === 0x01) {
      const { data, end } = readSubBlocks(b, o + 2 + b.u8at(o + 2) + 1);
      r.field('GIF', 'Plain text extension', bytesValue(data)); r.struct('Plain text', start, end - start); o = end; continue;
    }
    o = skipSubBlocks(b, o + 2);
  }
  r.field('GIF', 'Frames', String(frames));
  if (frames > 1) r.field('GIF', 'Total duration', `${(delays / 100).toFixed(2)} s`);
  if (o < b.length) {
    r.struct('Trailing data', o, b.length - o);
    r.block('Trailer', o, b.length - o, { decoded: false, note: 'Data after end of image' });
    r.signal('privacy', 'Hidden data after the image', `${fmtBytes(b.length - o)} follow the GIF trailer. Image viewers do not show it.`, 'GIF trailer', 'hidden data after the image');
  }
}

function skipSubBlocks(b, o) {
  for (let n = 0; n < 1e7; n++) { const size = b.u8at(o); o += 1 + size; if (size === 0) return o; if (o > b.length) throw new RangeError('read past end'); }
  return o;
}

function readSubBlocks(b, o) {
  const parts = []; let total = 0;
  for (;;) {
    const size = b.u8at(o); o++;
    if (size === 0) break;
    if (!b.has(o, size)) throw new RangeError('read past end');
    if (total < 16 * 1024 * 1024) { parts.push(b.slice(o, size)); total += size; }
    o += size;
  }
  return { data: concat(parts), end: o };
}
