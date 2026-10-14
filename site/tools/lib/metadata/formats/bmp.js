import { fmtBytes, latin1, printable } from '../bytes.js';
import { parseIcc } from '../icc.js';

const COMPRESSION = { 0: 'None', 1: 'RLE 8-bit', 2: 'RLE 4-bit', 3: 'Bit fields', 4: 'JPEG', 5: 'PNG', 6: 'Alpha bit fields' };
const HEADERS = { 12: 'BITMAPCOREHEADER', 40: 'BITMAPINFOHEADER', 52: 'BITMAPV2INFOHEADER', 56: 'BITMAPV3INFOHEADER', 64: 'OS/2 BITMAPINFOHEADER2', 108: 'BITMAPV4HEADER', 124: 'BITMAPV5HEADER' };

export async function parseBmp(b, r) {
  r.format = 'BMP';
  const pixels = b.u32(10, true); const dib = b.u32(14, true);
  r.struct('File header', 0, 14); r.struct(HEADERS[dib] ?? 'DIB header', 14, dib);
  r.field('BMP', 'Header', HEADERS[dib] ?? `${dib}-byte header`);
  if (dib === 12) { r.width = b.u16(18, true); r.height = b.u16(20, true); r.field('BMP', 'Bits per pixel', String(b.u16(24, true))); return; }
  r.width = b.i32(18, true); r.height = Math.abs(b.i32(22, true));
  r.field('BMP', 'Row order', b.i32(22, true) < 0 ? 'Top-down' : 'Bottom-up');
  r.field('BMP', 'Bits per pixel', String(b.u16(28, true)));
  r.field('BMP', 'Compression', COMPRESSION[b.u32(30, true)] ?? String(b.u32(30, true)));
  const xppm = b.i32(38, true); const yppm = b.i32(42, true);
  if (xppm) r.field('BMP', 'Resolution', `${Math.round(xppm * 0.0254)} × ${Math.round(yppm * 0.0254)} dpi`);
  if (b.u32(46, true)) r.field('BMP', 'Palette colors', String(b.u32(46, true)));
  if (dib >= 108) {
    const cs = b.ascii(14 + 56, 4).split('').reverse().join('');
    r.field('BMP', 'Color space', { sRGB: 'sRGB', Win: 'Windows default', LINK: 'Linked profile', MBED: 'Embedded profile' }[printable(cs)] ?? printable(cs) ?? String(b.u32(70, true)));
    if (dib >= 124 && (printable(cs) === 'MBED' || printable(cs) === 'LINK')) {
      const off = 14 + b.u32(14 + 112, true); const size = b.u32(14 + 116, true);
      if (b.has(off, size)) {
        r.struct('Color profile', off, size);
        if (printable(cs) === 'MBED') { parseIcc(b.sub(off, size), r); r.block('ICC', off, size, { container: 'BMP V5 profile', removable: false }); }
        else {
          // A linked profile is a file path on the machine that saved the image.
          const path = latin1(b.slice(off, size)).replace(/\0.*$/, '');
          r.field('BMP', 'Linked profile path', path, { flag: 'privacy' }); r.add('File', 'Linked profile path', path, { flag: 'privacy' });
          r.signal('privacy', 'File path stored', `The image links to a color profile at "${path}", a path on the computer that saved it.`, 'BMP header', 'a file path');
          r.block('Profile path', off, size, { container: 'BMP V5 linked profile' });
        }
      }
    }
  }
  if (pixels < b.length) r.struct('Pixel data', pixels, b.length - pixels);
  const declared = b.u32(2, true);
  if (declared && b.length > declared) r.signal('privacy', 'Hidden data after the image', `${fmtBytes(b.length - declared)} follow the size declared in the BMP header.`, 'BMP trailer', 'hidden data after the image');
}
