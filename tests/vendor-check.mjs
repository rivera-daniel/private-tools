// Local check against ExifTool's own vendor test images (not redistributed here).
// Usage: EXIFTOOL_DIR=/path/to/Image-ExifTool node tests/vendor-check.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inspectImage } from '../site/lib/metadata/index.js';
const dir = process.env.EXIFTOOL_DIR;
if (!dir) { console.error('Set EXIFTOOL_DIR to an unpacked Image-ExifTool distribution.'); process.exit(2); }
const files = ['Apple.jpg', 'Canon.jpg', 'Canon1DmkIII.jpg', 'CanonRaw.cr2', 'CanonRaw.cr3', 'FujiFilm.jpg', 'FujiFilm.raf', 'Nikon.jpg', 'NikonD70.jpg', 'Nikon.nef', 'Olympus.jpg', 'OlympusE1.jpg', 'Panasonic.jpg', 'Panasonic.rw2', 'Pentax.jpg', 'Sony.jpg', 'DNG.dng', 'QuickTime.heic', 'GPS.jpg', 'ExtendedXMP.jpg', 'XMP.svg', 'Photoshop.psd', 'RIFF.webp', 'JXL.jxl', 'JXL2.jxl', 'Google.jpg', 'ExifTool.tif', 'GeoTiff.tif', 'PNG.png', 'GIF.gif', 'BMP.bmp', 'BigTIFF.btf', 'IPTC.jpg', 'XMP.jpg', 'Minolta.jpg', 'Kodak.jpg', 'Casio.jpg', 'Ricoh.jpg', 'Sanyo.jpg', 'Sigma.jpg'];
const MAKER = /^(Apple|Canon|Nikon|FujiFilm|Olympus|Panasonic|Pentax|Sony|Minolta|Kodak|Casio|Ricoh|Sanyo|Sigma|MakerNotes|CanonCustom|NikonCustom|Samsung|GE|JVC|HP)/;
let problems = 0;
for (const f of files) {
  const path = `${dir}/t/images/${f}`;
  let ref;
  try { ref = JSON.parse(execFileSync(`${dir}/exiftool`, ['-j', '-a', '-G1', '-n', path]).toString())[0]; } catch { console.log(`skip ${f}`); continue; }
  const r = await inspectImage(readFileSync(path));
  const theirsMaker = Object.keys(ref).filter((k) => MAKER.test(k.split(':')[0]) && ref[k] !== '').length;
  const oursMaker = r.sources.filter((s) => s.name.startsWith('Maker notes')).reduce((n, s) => n + s.fields.length, 0);
  const serialRef = Object.entries(ref).filter(([k, v]) => /SerialNumber|OwnerName/i.test(k) && v !== '' && v !== 0).map(([k, v]) => `${k}=${v}`);
  const oursText = JSON.stringify(r.sources);
  const missingSerial = serialRef.filter((x) => !oursText.includes(String(x.split('=').slice(1).join('=')).replace(/[^\x21-\x7e]+$|\^$/, '').trim()));
  const dims = `${r.width}x${r.height}`;
  const refDims = ref['Composite:ImageSize'] ? String(ref['Composite:ImageSize']).replace(' ', 'x') : '?';
  const flag = (r.warnings.length ? ' WARN' : '') + (missingSerial.length ? ' MISSING-ID' : '') + (theirsMaker && !oursMaker ? ' NO-MAKERNOTE' : '');
  if (flag) problems++;
  console.log(`${f.padEnd(18)} ${String(r.format).padEnd(8)} dims ${dims}/${refDims} maker ${oursMaker}/${theirsMaker} fields ${r.fieldCount}${flag}`);
  if (missingSerial.length) console.log(`   missing: ${missingSerial.join(', ')}`);
  if (r.warnings.length) console.log(`   warnings: ${r.warnings.join(' | ')}`);
}
console.log(problems ? `${problems} files need attention` : 'vendor check clean');
