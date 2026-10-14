// Builds metadata fixtures in memory on top of small base images generated with ImageMagick.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const here = new URL('./', import.meta.url);
export const base = {
  jpeg: readFileSync(new URL('base.jpg', here)),
  png: readFileSync(new URL('base.png', here)),
  webp: readFileSync(new URL('base.webp', here)),
};
export const sample = (name) => readFileSync(new URL(name, here));

const u16 = (n, le = false) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
const u32 = (n, le = false) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b; };

// TIFF writer: entries are [tag, type, values]. ASCII values are strings, rationals are [num, den] pairs.
export function tiff(ifd0, { exif = [], gps = [], thumbnail = null, le = true } = {}) {
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  const dirs = [{ entries: [...ifd0] }];
  if (exif.length) dirs.push({ entries: exif, pointer: 0x8769 });
  if (gps.length) dirs.push({ entries: gps, pointer: 0x8825 });
  if (thumbnail) dirs.push({ entries: [[0x0201, 4, [0]], [0x0202, 4, [thumbnail.length]]], ifd1: true });
  for (const d of dirs) if (d.pointer) dirs[0].entries.push([d.pointer, 4, [0]]);
  const encode = ([, type, v]) => {
    if (type === 2) return Buffer.from(`${v}\0`, 'latin1');
    if (type === 7 || type === 1) return Buffer.from(v);
    const parts = v.map((x) => (type === 3 ? u16(x, le) : type === 4 ? u32(x, le) : Buffer.concat([u32(x[0], le), u32(x[1], le)])));
    return Buffer.concat(parts);
  };
  const count = (e) => (e[1] === 2 ? Buffer.byteLength(`${e[2]}\0`, 'latin1') : e[1] === 7 || e[1] === 1 ? e[2].length : e[2].length);
  // Layout: header, then each directory followed by its out-of-line data.
  let offset = 8; const layout = [];
  for (const d of dirs) {
    d.entries.sort((a, b) => a[0] - b[0]);
    const dirSize = 2 + d.entries.length * 12 + 4;
    const data = d.entries.map(encode);
    const extra = data.reduce((n, buf) => n + (buf.length > 4 ? buf.length + (buf.length & 1) : 0), 0);
    layout.push({ d, at: offset, data }); offset += dirSize + extra;
  }
  const thumbAt = offset;
  const at = (pointer) => layout.find((l) => l.d.pointer === pointer)?.at ?? 0;
  const out = [Buffer.from(le ? 'II' : 'MM'), u16(42, le), u32(8, le)];
  for (const { d, at: dirAt, data } of layout) {
    let extraAt = dirAt + 2 + d.entries.length * 12 + 4; const extras = [];
    out.push(u16(d.entries.length, le));
    d.entries.forEach((e, i) => {
      let buf = data[i];
      if (e[0] === 0x8769 || e[0] === 0x8825) buf = u32(at(e[0]), le);
      if (e[0] === 0x0201 && d.ifd1) buf = u32(thumbAt, le);
      out.push(u16(e[0], le), u16(e[1], le), u32(count(e), le));
      if (buf.length <= 4) out.push(Buffer.concat([buf, Buffer.alloc(4 - buf.length)]));
      else { out.push(u32(extraAt, le)); extras.push(buf); if (buf.length & 1) extras.push(Buffer.alloc(1)); extraAt += buf.length + (buf.length & 1); }
    });
    const ifd1 = layout.find((l) => l.d.ifd1);
    out.push(u32(d === dirs[0] && ifd1 ? ifd1.at : 0, le), ...extras);
  }
  if (thumbnail) out.push(thumbnail);
  return Buffer.concat(out);
}

export const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);
export const jpegWith = (...segments) => Buffer.concat([base.jpeg.subarray(0, 2), ...segments, base.jpeg.subarray(2)]);
export const exifSegment = (t) => segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]));
export const xmpSegment = (xml) => segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(xml)]));
export const xmpPacket = (inner) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ${inner}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

export function iptcSegment(datasets) {
  const iim = Buffer.concat(datasets.map(([ds, text]) => { const v = Buffer.from(text); return Buffer.concat([Buffer.from([0x1c, 2, ds]), u16(v.length), v]); }));
  const res = Buffer.concat([Buffer.from('8BIM'), u16(0x0404), Buffer.from([0, 0]), u32(iim.length), iim, iim.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  return segment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), res]));
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export const chunk = (type, data) => { const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); return Buffer.concat([u32(data.length), td, u32(crc(td))]); };
export const tEXt = (k, v) => chunk('tEXt', Buffer.concat([Buffer.from(`${k}\0`, 'latin1'), Buffer.from(v, 'latin1')]));
export const zTXt = (k, v) => chunk('zTXt', Buffer.concat([Buffer.from(`${k}\0\0`, 'latin1'), deflateSync(Buffer.isBuffer(v) ? v : Buffer.from(v, 'latin1'))]));
export const iTXt = (k, v, compressed = false) => chunk('iTXt', Buffer.concat([Buffer.from(`${k}\0${compressed ? '\x01' : '\0'}\0\0\0`, 'latin1'), compressed ? deflateSync(Buffer.from(v)) : Buffer.from(v)]));
// Inserts chunks after IHDR (8-byte signature + 25-byte IHDR chunk).
export const pngWith = (...chunks) => Buffer.concat([base.png.subarray(0, 33), ...chunks, base.png.subarray(33)]);

export function webpWith(chunks) {
  const riff = base.webp; const body = riff.subarray(12);
  const vp8 = body;
  const pad = (b) => (b.length & 1 ? Buffer.concat([b, Buffer.alloc(1)]) : b);
  const wchunk = (type, data) => pad(Buffer.concat([Buffer.from(type, 'latin1'), u32(data.length, true), data]));
  const flags = (chunks.EXIF ? 0x08 : 0) | (chunks['XMP '] ? 0x04 : 0);
  const vp8x = wchunk('VP8X', Buffer.concat([Buffer.from([flags, 0, 0, 0]), Buffer.from([15, 0, 0, 11, 0, 0])]));
  const extra = Object.entries(chunks).map(([t, d]) => wchunk(t, d));
  const payload = Buffer.concat([Buffer.from('WEBP'), vp8x, vp8, ...extra]);
  return Buffer.concat([Buffer.from('RIFF'), u32(payload.length, true), payload]);
}

export const dms = (deg) => { const d = Math.floor(deg); const m = Math.floor((deg - d) * 60); const s = Math.round(((deg - d) * 60 - m) * 60 * 100); return [[d, 1], [m, 1], [s, 100]]; };
