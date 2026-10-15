import { clean, printable, utf16, fmtBytes } from './bytes.js';

const CLASSES = { scnr: 'Input device', mntr: 'Display device', prtr: 'Output device', link: 'Device link', spac: 'Color space', abst: 'Abstract', nmcl: 'Named color' };
const INTENTS = ['Perceptual', 'Media-relative colorimetric', 'Saturation', 'ICC-absolute colorimetric'];
const XYZ_TAGS = { wtpt: 'Media white point', bkpt: 'Media black point', rXYZ: 'Red colorant', gXYZ: 'Green colorant', bXYZ: 'Blue colorant', lumi: 'Luminance' };
const CURVE_TAGS = { rTRC: 'Red tone curve', gTRC: 'Green tone curve', bTRC: 'Blue tone curve', kTRC: 'Gray tone curve' };
const TEXT_TAGS = { desc: 'Description', cprt: 'Copyright', dmnd: 'Device manufacturer', dmdd: 'Device model', vued: 'Viewing conditions', tech: 'Technology' };

export function parseIcc(b, r) {
  if (b.length < 132) { r.warn('ICC profile is too short.'); return; }
  const src = 'ICC profile';
  const sig = (o) => printable(b.ascii(o, 4));
  r.field(src, 'Profile size', fmtBytes(b.u32(0)));
  r.field(src, 'Preferred CMM', sig(4));
  r.field(src, 'Version', `${b.u8at(8)}.${b.u8at(9) >> 4}.${b.u8at(9) & 15}`);
  r.field(src, 'Profile class', CLASSES[b.ascii(12, 4)] ?? sig(12));
  r.field(src, 'Color space', sig(16));
  r.field(src, 'Connection space', sig(20));
  const y = b.u16(24);
  const two = (o) => String(b.u16(o)).padStart(2, '0');
  if (y) r.field(src, 'Created', `${y}-${two(26)}-${two(28)} ${two(30)}:${two(32)}:${two(34)}`);
  r.field(src, 'Platform', sig(40));
  r.field(src, 'Device manufacturer', sig(48));
  r.field(src, 'Device model', sig(52));
  r.field(src, 'Rendering intent', INTENTS[b.u32(64)] ?? String(b.u32(64)));
  r.field(src, 'Profile creator', sig(80));
  const id = [...b.slice(84, 16)];
  if (id.some(Boolean)) r.field(src, 'Profile ID', id.map((x) => x.toString(16).padStart(2, '0')).join(''));
  const count = Math.min(b.u32(128), 200);
  const tags = []; let description = '';
  for (let i = 0; i < count; i++) {
    const e = 132 + i * 12; if (!b.has(e, 12)) break;
    const tag = b.ascii(e, 4); const off = b.u32(e + 4); const size = b.u32(e + 8);
    tags.push(printable(tag));
    if (!b.has(off, Math.min(size, 12))) continue;
    if (XYZ_TAGS[tag] && b.ascii(off, 4) === 'XYZ ' && b.has(off + 8, 12)) { r.field(src, XYZ_TAGS[tag], [0, 4, 8].map((k) => (b.i32(off + 8 + k) / 65536).toFixed(4)).join(' ')); continue; }
    if (CURVE_TAGS[tag]) { r.field(src, CURVE_TAGS[tag], curve(b, off)); continue; }
    if (tag === 'chad' && b.has(off + 8, 36)) { r.field(src, 'Chromatic adaptation', Array.from({ length: 9 }, (_, k) => (b.i32(off + 8 + k * 4) / 65536).toFixed(4)).join(' ')); continue; }
    if (tag === 'meas' && b.ascii(off, 4) === 'meas' && b.has(off + 8, 28)) {
      r.field(src, 'Measurement observer', ['Unknown', 'CIE 1931', 'CIE 1964'][b.u32(off + 8)] ?? String(b.u32(off + 8)));
      r.field(src, 'Measurement backing', [0, 4, 8].map((k) => (b.i32(off + 12 + k) / 65536).toFixed(4)).join(' '));
      r.field(src, 'Measurement geometry', ['Unknown', '0/45 or 45/0', '0/d or d/0'][b.u32(off + 24)] ?? String(b.u32(off + 24)));
      r.field(src, 'Measurement flare', `${((b.u32(off + 28) / 65536) * 100).toFixed(1)}%`);
      r.field(src, 'Measurement illuminant', ['Unknown', 'D50', 'D65', 'D93', 'F2', 'D55', 'A', 'Equi-Power (E)', 'F8'][b.u32(off + 32)] ?? String(b.u32(off + 32)));
      continue;
    }
    if (tag === 'view' && b.ascii(off, 4) === 'view' && b.has(off + 8, 28)) {
      r.field(src, 'Viewing illuminant', [0, 4, 8].map((k) => (b.i32(off + 8 + k) / 65536).toFixed(4)).join(' '));
      r.field(src, 'Viewing surround', [0, 4, 8].map((k) => (b.i32(off + 20 + k) / 65536).toFixed(4)).join(' '));
      r.field(src, 'Viewing illuminant type', ['Unknown', 'D50', 'D65', 'D93', 'F2', 'D55', 'A', 'Equi-Power (E)', 'F8'][b.u32(off + 32)] ?? String(b.u32(off + 32)));
      continue;
    }
    if (!TEXT_TAGS[tag]) continue;
    const text = readText(b, off, size);
    if (text) { r.field(src, TEXT_TAGS[tag], text); if (tag === 'desc') description = text; }
  }
  r.field(src, 'Tags', tags.join(', '));
  r.add('Color profile', 'Profile', description || 'Present');
}

function curve(b, off) {
  const type = b.ascii(off, 4);
  if (type === 'curv' && b.has(off + 8, 4)) { const n = b.u32(off + 8); return n === 0 ? 'Identity' : n === 1 && b.has(off + 12, 2) ? `Gamma ${(b.u16(off + 12) / 256).toFixed(2)}` : `${n} points`; }
  if (type === 'para' && b.has(off + 8, 8)) return `Parametric (type ${b.u16(off + 8)}, gamma ${(b.i32(off + 12) / 65536).toFixed(3)})`;
  return type.trim();
}

function readText(b, off, size) {
  const type = b.ascii(off, 4);
  if (type === 'desc' && b.has(off + 8, 4)) return clean(b.ascii(off + 12, Math.min(b.u32(off + 8), 512)).replace(/\0/g, ''));
  if (type === 'text') return clean(b.ascii(off + 8, Math.min(size - 8, 2048)).replace(/\0/g, ''));
  if (type === 'mluc' && b.has(off + 16, 12)) { const len = b.u32(off + 20); const at = b.u32(off + 24); return clean(utf16(b.slice(off + at, Math.min(len, 2048)), false).replace(/\0/g, '')); }
  if (type === 'sig ' && b.has(off + 8, 4)) return printable(b.ascii(off + 8, 4));
  return '';
}
