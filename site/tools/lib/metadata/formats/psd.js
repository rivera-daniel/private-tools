import { utf16, latin1, clean } from '../bytes.js';
import { parsePhotoshop } from '../photoshop.js';

const MODES = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };

export async function parsePsd(b, r) {
  const psb = b.u16(4) === 2;
  r.format = psb ? 'PSB' : 'PSD';
  r.height = b.u32(14); r.width = b.u32(18);
  r.field('Photoshop document', 'Channels', String(b.u16(12)));
  r.field('Photoshop document', 'Bit depth', String(b.u16(22)));
  r.field('Photoshop document', 'Color mode', MODES[b.u16(24)] ?? String(b.u16(24)));
  r.struct('Header', 0, 26);
  let o = 26;
  const modeLen = b.u32(o); r.struct('Color mode data', o, 4 + modeLen); o += 4 + modeLen;
  const resLen = b.u32(o);
  r.struct('Image resources', o, 4 + resLen);
  const section = r.block('Photoshop', o, 4 + resLen, { container: 'Image resources section', removable: false, note: 'Individual resources can be removed' });
  if (b.has(o + 4, resLen)) r.within(section, () => parsePhotoshop(b.sub(o + 4, resLen), r, { at: o + 4 }));
  o += 4 + resLen;
  const lmLen = psb ? b.u64(o) : b.u32(o); const lmHead = psb ? 8 : 4;
  r.struct('Layer and mask information', o, lmHead + lmLen);
  try { readLayers(b, o + lmHead, psb, r); } catch (error) { r.warn(`Layer information could not be fully read (${error.message}).`); }
  o += lmHead + lmLen;
  if (o < b.length) r.struct('Image data', o, b.length - o);
}

function readLayers(b, o, psb, r) {
  const infoLen = psb ? b.u64(o) : b.u32(o); o += psb ? 8 : 4;
  if (!infoLen) { r.field('Photoshop document', 'Layers', 'None (flattened)'); return; }
  const count = Math.min(Math.abs(b.i16(o)), 2000); o += 2;
  const names = []; let hidden = 0;
  for (let i = 0; i < count; i++) {
    o += 16;
    const channels = b.u16(o); o += 2 + channels * (psb ? 10 : 6);
    o += 4 + 4 + 1 + 1;
    const flags = b.u8at(o); o += 2;
    if (flags & 0x02) hidden++;
    const extra = b.u32(o); o += 4; const extraEnd = o + extra;
    o += 4 + b.u32(o);
    o += 4 + b.u32(o);
    const nameLen = b.u8at(o);
    let name = latin1(b.slice(o + 1, nameLen));
    o += (1 + nameLen + 3) & ~3;
    // Additional layer information; the Unicode name ("luni") overrides the Pascal name.
    while (o + 12 <= extraEnd) {
      const sig = b.ascii(o, 4); if (sig !== '8BIM' && sig !== '8B64') break;
      const key = b.ascii(o + 4, 4); const len = b.u32(o + 8);
      if (key === 'luni' && len >= 4) { const n = b.u32(o + 12); name = utf16(b.slice(o + 16, Math.min(n * 2, len - 4)), false); }
      o += 12 + len + (len & 1);
    }
    o = extraEnd;
    names.push(`${clean(name) || '(unnamed)'}${flags & 0x02 ? ' (hidden)' : ''}`);
  }
  r.field('Photoshop document', 'Layers', String(count));
  names.forEach((n, i) => r.field('Photoshop layers', `Layer ${i + 1}`, n));
  if (hidden) r.signal('privacy', 'Hidden layers', `${hidden} hidden layer${hidden === 1 ? '' : 's'} are stored in the file. Anyone who opens it in an editor can see them.`, 'Photoshop layers', 'hidden layers');
}
