// Lossy image compression: images larger than they need to be for the chosen resolution are scaled down,
// and photos are re-encoded as JPEG at the chosen quality. An image is replaced only when the result is
// smaller. Masks, images with transparency and 1-bit images are left alone.
import { mupdf } from './index.js';

const MAX_DEPTH = 8;

// Every image XObject used by the pages, with the largest size in pixels it needs at `dpi`: the longer
// side of the largest page that shows it.
function collectImages(doc, dpi) {
  const need = new Map();
  const seenForms = new Set();
  const visit = (resources, limit, depth) => {
    const xobjects = resources.get('XObject');
    if (!xobjects.isDictionary()) return;
    xobjects.forEach((ref) => {
      if (!ref.isIndirect()) return;
      const obj = ref.resolve();
      const subtype = obj.get('Subtype').isName() ? obj.get('Subtype').asName() : '';
      const num = ref.asIndirect();
      if (subtype === 'Image') need.set(num, { ref, limit: Math.max(limit, need.get(num)?.limit ?? 0) });
      else if (subtype === 'Form' && depth < MAX_DEPTH && !seenForms.has(`${num}:${limit}`)) {
        seenForms.add(`${num}:${limit}`);
        const inner = obj.get('Resources');
        if (inner.isDictionary()) visit(inner, limit, depth + 1);
      }
    });
  };
  for (let i = 0, n = doc.countPages(); i < n; i++) {
    const page = doc.loadPage(i);
    try {
      const [x0, y0, x1, y1] = page.getBounds();
      const limit = Math.ceil((Math.max(x1 - x0, y1 - y0) / 72) * dpi);
      const resources = page.getObject().getInheritable('Resources');
      if (resources.isDictionary()) visit(resources, limit, 0);
    } finally { page.destroy(); }
  }
  return [...need.values()];
}

const nameOf = (obj, key) => (obj.get(key).isName() ? obj.get(key).asName() : null);
function filters(obj) {
  const f = obj.get('Filter');
  if (f.isName()) return [f.asName()];
  if (f.isArray()) { const out = []; f.forEach((v) => { if (v.isName()) out.push(v.asName()); }); return out; }
  return [];
}

// Returns { replaced, skipped, before, after } where before and after are the image stream bytes.
export function downsampleImages(doc, { dpi = 150, quality = 75 } = {}) {
  let replaced = 0; let skipped = 0; let before = 0; let after = 0;
  for (const { ref, limit } of collectImages(doc, dpi)) {
    const obj = ref.resolve();
    if (obj.get('ImageMask').isBoolean() && obj.get('ImageMask').asBoolean()) { skipped++; continue; }
    if (!obj.get('Mask').isNull() || !obj.get('SMask').isNull() || obj.get('BitsPerComponent').asNumber() === 1) { skipped++; continue; }
    const isJpeg = filters(obj).includes('DCTDecode');
    let image; let out; let device;
    try {
      image = doc.loadImage(ref);
      const w = image.getWidth(); const h = image.getHeight();
      const scale = Math.min(1, limit / Math.max(w, h));
      if (scale >= 1 && !isJpeg) { skipped++; continue; }
      const tw = Math.max(1, Math.round(w * scale)); const th = Math.max(1, Math.round(h * scale));
      const cs = image.getColorSpace();
      const gray = Boolean(cs && cs.isGray()) || nameOf(obj, 'ColorSpace') === 'DeviceGray';
      const target = gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
      out = new mupdf.Pixmap(target, [0, 0, tw, th], false);
      out.clear(255);
      device = new mupdf.DrawDevice(mupdf.Matrix.identity, out);
      device.fillImage(image, [tw, 0, 0, th, 0, 0], 1);
      device.close();
      const jpeg = out.asJPEG(quality);
      const old = ref.readRawStream(); const oldLength = old.getLength(); old.destroy();
      before += oldLength;
      if (jpeg.length >= oldLength) { after += oldLength; skipped++; continue; }
      ref.writeRawStream(jpeg);
      ref.put('Filter', doc.newName('DCTDecode'));
      ref.put('Width', tw); ref.put('Height', th); ref.put('BitsPerComponent', 8);
      ref.put('ColorSpace', doc.newName(gray ? 'DeviceGray' : 'DeviceRGB'));
      for (const key of ['DecodeParms', 'Decode', 'Intent', 'Alternates']) ref.delete(key);
      after += jpeg.length; replaced++;
    } catch { skipped++; }
    finally { device?.destroy(); out?.destroy(); image?.destroy(); }
  }
  return { replaced, skipped, before, after };
}
