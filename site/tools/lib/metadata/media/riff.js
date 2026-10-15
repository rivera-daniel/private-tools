// WAV (RIFF, RF64, BW64) and AIFF/AIFC chunks.
import { Bytes, latin1, utf8, clean, fmtBytes, bytesValue } from '../bytes.js';
import { parseXmp } from '../xmp.js';
import { parseId3v2 } from './id3.js';
import { text, tag, groupOf, duration, xmlLeaves } from './common.js';

const INFO = {
  INAM: ['Title', 'Description'], IART: ['Artist', 'People'], ICMT: ['Comment', 'Comments'], ICOP: ['Copyright', 'People'], ISFT: ['Software', 'Software'], ICRD: ['Creation date', 'Dates'],
  IENG: ['Engineer', 'People'], ITCH: ['Technician', 'People'], ICMS: ['Commissioned by', 'People'], IPRD: ['Product', 'Description'], IGNR: ['Genre'], IKEY: ['Keywords', 'Description'],
  ISBJ: ['Subject', 'Description'], ISRC: ['Source', 'People'], ISRF: ['Source form'], IARL: ['Archival location', 'Location'], ILNG: ['Language'], IMED: ['Medium'], ITRK: ['Track'],
  IPRT: ['Part'], IDIT: ['Digitization time', 'Dates'], ISMP: ['SMPTE time'], ICNT: ['Country', 'Location'], IDPI: ['Dots per inch'], ILGT: ['Lightness'], IPLT: ['Palette'],
  ISHP: ['Sharpness'], ICRP: ['Cropped'], IDIM: ['Dimensions'], IWRI: ['Writer', 'People'], IPRO: ['Producer', 'People'], IENC: ['Encoded by', 'People'], ICNM: ['Cinematographer', 'People'],
  ISTR: ['Starring', 'People'], IEDT: ['Edited by', 'People'], IRTD: ['Rating'], ITOC: ['Table of contents'], IAS1: ['First language'], TORG: ['Organization', 'People'], TURL: ['URL'], TLEN: ['Length'], TVER: ['Version'], TCOD: ['Start timecode'], TCDO: ['End timecode'],
};
// Chunks playback or editing structure needs. Everything else is metadata or unknown and can go.
const WAV_KEEP = new Set(['fmt ', 'data', 'fact', 'ds64', 'smpl', 'inst', 'cue ', 'plst', 'chna', 'dbmd', 'slnt', 'wavl']);
const AIFF_KEEP = new Set(['COMM', 'SSND', 'FVER', 'MARK', 'INST', 'AESD', 'CHAN', 'SAXL']);
const PADS = new Set(['JUNK', 'junk', 'PAD ', 'FLLR', 'filr']);
const FORMATS = { 1: 'PCM', 2: 'ADPCM', 3: 'IEEE float', 6: 'A-law', 7: 'µ-law', 0x11: 'IMA ADPCM', 0x50: 'MPEG', 0x55: 'MP3', 0xff: 'AAC', 0xfffe: 'Extensible' };

export function parseWav(b, r, ctx) {
  r.format = 'WAV'; r.category = 'Audio';
  const rf64 = b.ascii(0, 4) !== 'RIFF';
  r.field('Container', 'Variant', rf64 ? `${b.ascii(0, 4)} (64-bit sizes)` : 'RIFF');
  let o = 12; let byteRate = 0; let dataSize = 0; let ds64Data = 0;
  const end = rf64 ? b.length : riffEnd(b, b.u32(4, true), true, r);
  for (let i = 0; o < end; i++) {
    if (!readable(b, o, end, r, i)) break;
    const id = b.ascii(o, 4); let size = b.u32(o + 4, true);
    if (id === 'data' && size === 0xffffffff && ds64Data) size = ds64Data;
    const total = 8 + size + (size & 1);
    if (o + 8 + size > b.length) {
      if (id === 'data') { r.warn('The data chunk runs past the end of the file. The file is truncated.'); dataSize = b.length - o - 8; }
      else r.warn(`The ${latin1(b.slice(o, 4))} chunk runs past the end of the file.`);
      break;
    }
    r.struct(id, o, Math.min(total, b.length - o));
    const d = b.slice(o + 8, size); const v = new Bytes(d);
    try {
      if (id === 'fmt ' && size >= 16) {
        const tagId = v.u16(0, true); byteRate = v.u32(8, true);
        r.field('Container', 'Encoding', FORMATS[tagId] ?? `Format 0x${tagId.toString(16)}`);
        r.field('Container', 'Channels', String(v.u16(2, true))); r.field('Container', 'Sample rate', `${v.u32(4, true)} Hz`); r.field('Container', 'Bits per sample', String(v.u16(14, true)));
      } else if (id === 'data') dataSize = size;
      else if (id === 'ds64' && size >= 24) { ds64Data = v.u64(8, true); r.field('Container', 'RF64 data size', fmtBytes(ds64Data)); }
      else if (id === 'cue ' && size >= 4) r.field('Container', 'Cue points', String(v.u32(0, true)));
      else if (id === 'smpl' && size >= 36) r.field('Container', 'Sampler loops', String(v.u32(28, true)));
      else if (!WAV_KEEP.has(id)) wavChunk(id, d, o, Math.min(total, b.length - o), r, ctx);
    } catch { r.field('RIFF', id, `${fmtBytes(size)}, could not be decoded`); }
    o += total;
  }
  if (byteRate && dataSize) r.field('Container', 'Duration', duration(dataSize / byteRate));
  if (!rf64 && end < b.length) trailer(b, end, r);
}

function wavChunk(id, d, o, total, r, ctx) {
  const v = new Bytes(d); const where = { container: `RIFF ${clean(id)}` };
  if (PADS.has(id)) { if (d.some((x) => x)) { r.block('Padding', o, total, { ...where, decoded: false, note: 'Padding holding leftover data' }); r.field('RIFF', `Leftover data in ${clean(id)}`, fmtBytes(d.length)); } return; }
  if (id === 'LIST') {
    const type = latin1(d.subarray(0, 4));
    const blk = r.block(type === 'INFO' ? 'RIFF INFO' : type === 'adtl' ? 'Labels' : 'RIFF list', o, total, { container: `LIST ${clean(type)}` });
    r.within(blk, () => {
      let p = 4;
      for (let i = 0; p + 8 <= d.length && i < 2000; i++) {
        const sub = latin1(d.subarray(p, p + 4)); const len = v.u32(p + 4, true); const val = d.subarray(p + 8, p + 8 + len);
        if (type === 'INFO') { const k = INFO[sub]; tag(r, 'RIFF INFO', k?.[0] ?? sub, text(val), k ? k[1] ?? null : groupOf(sub), k?.[0] ?? sub); }
        else if (type === 'adtl' && (sub === 'labl' || sub === 'note')) tag(r, 'RIFF labels', `${sub === 'labl' ? 'Label' : 'Note'} for cue ${new Bytes(val).u32(0, true)}`, text(val.subarray(4)), 'Comments');
        else if (type === 'adtl' && sub === 'ltxt' && len >= 20) tag(r, 'RIFF labels', `Text for cue ${new Bytes(val).u32(0, true)}`, text(val.subarray(20)), 'Comments');
        else r.field('RIFF', `LIST ${clean(type)} ${clean(sub)}`, bytesValue(val.subarray(0, 512)));
        p += 8 + len + (len & 1);
      }
    });
    return;
  }
  if (id === 'bext' && d.length >= 346) {
    r.within(r.block('Broadcast WAV', o, total, where), () => {
      const s = (a, n) => clean(latin1(d.subarray(a, a + n)).replace(/\0.*$/s, ''));
      const src = 'Broadcast WAV';
      tag(r, src, 'Description', s(0, 256), 'Description'); tag(r, src, 'Originator', s(256, 32), 'People'); tag(r, src, 'Originator reference', s(288, 32), 'Camera');
      const date = s(320, 10); const time = s(330, 8); tag(r, src, 'Origination date', [date, time].filter(Boolean).join(' '), 'Dates', 'Originated');
      const ref = v.u64(338, true); if (ref) r.field(src, 'Time reference (samples)', String(ref));
      const version = v.u16(346, true); r.field(src, 'Version', String(version));
      if (d.length >= 412 && d.subarray(348, 412).some((x) => x)) r.field(src, 'UMID', [...d.subarray(348, 412)].map((x) => x.toString(16).padStart(2, '0')).join('').replace(/(00)+$/, ''), { flag: 'privacy' });
      if (version >= 2 && d.length >= 422) { const lu = v.i16(412, true); if (lu) r.field(src, 'Loudness', `${lu / 100} LUFS`); }
      if (d.length > 602) tag(r, src, 'Coding history', clean(latin1(d.subarray(602)).replace(/\0+/g, ' ')), 'Software');
    });
    return;
  }
  if (id === 'iXML' || id === 'axml' || id === 'aXML') {
    const xml = utf8.decode(d);
    // ADM metadata in axml describes how object-based audio is rendered, so it stays.
    const adm = /audioFormatExtended/.test(xml);
    r.within(r.block(id === 'iXML' ? 'iXML' : 'XML', o, total, { ...where, ...(adm ? { removable: false, note: 'Audio Definition Model' } : {}) }), () => (/<x:xmpmeta|<rdf:RDF/.test(xml) ? parseXmp(xml, r) : xmlLeaves(xml, r, id)));
    return;
  }
  if (id === '_PMX') { r.within(r.block('XMP', o, total, where), () => parseXmp(utf8.decode(d), r)); return; }
  if (id === 'id3 ' || id === 'ID3 ') { r.within(r.block('ID3v2', o, total, where), () => parseId3v2(new Bytes(d), 0, r, ctx, { record: false })); return; }
  if (id === 'cart' && d.length >= 1024) {
    r.within(r.block('Cart', o, total, where), () => {
      const s = (a, n) => clean(latin1(d.subarray(a, a + n)).replace(/\0.*$/s, ''));
      const src = 'Cart chunk';
      tag(r, src, 'Title', s(4, 64), 'Description'); tag(r, src, 'Artist', s(68, 64), 'People'); tag(r, src, 'Cut ID', s(132, 64)); tag(r, src, 'Client ID', s(196, 64), 'People');
      tag(r, src, 'Category', s(260, 64)); tag(r, src, 'Classification', s(324, 64)); tag(r, src, 'Start', `${s(452, 10)} ${s(462, 8)}`.trim(), 'Dates'); tag(r, src, 'End', `${s(470, 10)} ${s(480, 8)}`.trim(), 'Dates');
      tag(r, src, 'Producer application', `${s(488, 64)} ${s(552, 64)}`.trim(), 'Software'); tag(r, src, 'User defined', s(616, 64));
      if (d.length > 2048) tag(r, src, 'URL', s(1024, 1024)); if (d.length > 2048) tag(r, src, 'Tag text', clean(latin1(d.subarray(2048))), 'Comments');
    });
    return;
  }
  if (id === 'DISP' && d.length > 4) { r.block('Display', o, total, where); tag(r, 'RIFF', 'Display text', v.u32(0, true) === 1 ? text(d.subarray(4)) : `${fmtBytes(d.length - 4)}, not decoded`, 'Description'); return; }
  r.block('Unknown chunk', o, total, { ...where, decoded: false });
  const shown = bytesValue(d.subarray(0, 512));
  r.field('RIFF', clean(id) || '(blank)', /^[0-9a-f]{2}( [0-9a-f]{2})*( …|$)/.test(shown) ? `${fmtBytes(d.length)}, not decoded` : shown);
}

// Chunk IDs are printable. Anything else is audio misread as chunks (an unfinalized recording, a wrong size),
// so the walk stops, and only a run of zero bytes counts as removable padding.
function readable(b, o, end, r, i) {
  if (i >= 10000) { r.warn('Too many chunks. Inspection stopped early.'); return false; }
  if (end - o >= 8 && /^[\x20-\x7e]{4}$/.test(b.ascii(o, 4))) return true;
  if (b.u8.subarray(o, end).every((x) => x === 0)) r.block('Padding', o, end - o, { decoded: false, note: 'Zero bytes after the last chunk' });
  else r.warn('Bytes that are not a chunk follow the last chunk. The file is damaged.');
  return false;
}

// Where the chunks end. A size field that stops short of a valid chunk is wrong rather than a trailer.
function riffEnd(b, declared, le, r) {
  const end = 8 + declared;
  if (end >= b.length) return b.length;
  const next = b.has(end, 8) && /^[\x20-\x7e]{4}$/.test(b.ascii(end, 4)) && end + 8 + b.u32(end + 4, le) <= b.length;
  if (declared >= 4 && !next) return end;
  r.field('Container', 'File size field', 'Smaller than the chunks it holds');
  return b.length;
}

function trailer(b, at, r) {
  const rest = b.length - at;
  r.block('Trailer', at, rest, { decoded: false, note: 'Data after the end of the RIFF' });
  r.field('File', 'Data after the end of the file structure', fmtBytes(rest), { flag: 'privacy' });
  r.signal('privacy', 'Hidden data after the media', `${fmtBytes(rest)} follow the end of the file structure. Players do not show it.`, 'Trailer', 'hidden data after the media');
}

// 80-bit IEEE extended float (AIFF sample rate).
function extended(v, o) {
  const exp = v.u16(o) & 0x7fff; const hi = v.u32(o + 2); const lo = v.u32(o + 6);
  if (!exp && !hi && !lo) return 0;
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

export function parseAiff(b, r, ctx) {
  r.format = 'AIFF'; r.category = 'Audio';
  const aifc = b.ascii(8, 4) === 'AIFC';
  r.field('Container', 'Variant', aifc ? 'AIFF-C' : 'AIFF');
  const end = riffEnd(b, b.u32(4), false, r); let o = 12; let frames = 0; let rate = 0;
  for (let i = 0; o < end; i++) {
    if (!readable(b, o, end, r, i)) break;
    const id = b.ascii(o, 4); const size = b.u32(o + 4); const total = Math.min(8 + size + (size & 1), b.length - o);
    if (o + 8 + size > b.length) { r.warn(`The ${latin1(b.slice(o, 4))} chunk runs past the end of the file. The file is truncated.`); break; }
    r.struct(id, o, Math.min(total, b.length - o));
    const d = b.slice(o + 8, size); const v = new Bytes(d); const where = { container: `AIFF ${clean(id)}` };
    try {
      if (id === 'COMM' && size >= 18) {
        frames = v.u32(2); rate = extended(v, 8);
        r.field('Container', 'Channels', String(v.u16(0))); r.field('Container', 'Bits per sample', String(v.u16(6))); r.field('Container', 'Sample rate', `${Math.round(rate)} Hz`);
        if (aifc && size >= 22) r.field('Container', 'Compression', `${clean(latin1(d.subarray(18, 22)))}${size > 23 ? ` (${clean(latin1(d.subarray(23, 23 + d[22])))})` : ''}`);
      } else if (id === 'MARK' && size >= 2) r.field('Container', 'Markers', String(v.u16(0)));
      else if (AIFF_KEEP.has(id)) { /* structural */ }
      else if (id === 'NAME' || id === 'AUTH' || id === '(c) ' || id === 'ANNO') {
        const k = { NAME: ['Name', 'Description'], AUTH: ['Author', 'People'], '(c) ': ['Copyright', 'People'], ANNO: ['Annotation', 'Comments'] }[id];
        r.within(r.block('Text', o, total, where), () => tag(r, 'AIFF', k[0], text(d), k[1]));
      } else if (id === 'COMT') {
        r.within(r.block('Comments', o, total, where), () => {
          let p = 2;
          for (let k = 0; k < Math.min(v.u16(0), 1000) && p + 8 <= d.length; k++) { const len = v.u16(p + 6); tag(r, 'AIFF', `Comment ${k + 1}`, text(d.subarray(p + 8, p + 8 + len)), 'Comments', 'Comment'); r.field('AIFF', `Comment ${k + 1} time`, macTime(v.u32(p))); p += 8 + len + (len & 1); }
        });
      } else if (id === 'ID3 ' || id === 'id3 ') r.within(r.block('ID3v2', o, total, where), () => parseId3v2(new Bytes(d), 0, r, ctx, { record: false }));
      else if (id === 'APPL' && size >= 4) {
        const sig = latin1(d.subarray(0, 4));
        r.within(r.block('Application data', o, total, { ...where, container: `AIFF APPL ${clean(sig)}`, decoded: sig === 'XMP ' }), () => (sig === 'XMP ' ? parseXmp(utf8.decode(d.subarray(4)), r) : r.field('AIFF', `Application ${clean(sig)}`, `${fmtBytes(size - 4)}, not decoded`)));
      } else {
        r.block('Unknown chunk', o, total, { ...where, decoded: false });
        r.field('AIFF', clean(id) || '(blank)', `${fmtBytes(size)}, not decoded`);
      }
    } catch { r.field('AIFF', id, `${fmtBytes(size)}, could not be decoded`); }
    o += total;
  }
  if (frames && rate) r.field('Container', 'Duration', duration(frames / rate));
  if (end < b.length) trailer(b, end, r);
}

const macTime = (s) => new Date((s - 2082844800) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
