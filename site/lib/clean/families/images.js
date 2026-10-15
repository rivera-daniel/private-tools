// HEIC, HEIF, AVIF and plain TIFF: the container is rewritten around the coded image data, which is copied
// byte for byte. JPEG, PNG, WebP and GIF are cut in place by cleanImage instead.
import { cleanHeif } from '../images/heif.js';
import { cleanTiff } from '../images/tiff.js';
import { Refusal } from '../index.js';

const CLEANERS = { HEIC: cleanHeif, HEIF: cleanHeif, AVIF: cleanHeif, TIFF: cleanTiff };
export const formats = new Set(Object.keys(CLEANERS));

export async function clean(u8, report) {
  const cleaner = CLEANERS[report.format];
  if (!cleaner) throw new Refusal(`${report.format} files cannot be cleaned yet.`);
  return cleaner(u8, report, report.blocks.filter((b) => b.removable !== false && !ancestor(report.blocks, b)));
}

function ancestor(blocks, b) {
  for (let p = b.parent; p !== null && p !== undefined; p = blocks[p]?.parent) if (blocks[p]?.removable !== false) return true;
  return false;
}
