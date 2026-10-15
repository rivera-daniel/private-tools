// PDF.
import { indexOfBytes } from '../pdf/syntax.js';
import { inspectPdf } from '../pdf/inspect.js';

// The header may follow up to 1 KB of other data, as PDF readers allow.
// A header after other data must be followed by an object, so text that merely mentions %PDF- is not a PDF.
export function detect(u8) {
  const at = indexOfBytes(u8, '%PDF-', 0, Math.min(u8.length, 1029));
  if (at < 0) return null;
  return at === 0 || /\d+\s+\d+\s+obj\b/.test(String.fromCharCode(...u8.subarray(at, at + 4096))) ? inspectPdf : null;
}
