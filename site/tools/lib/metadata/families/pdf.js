// PDF.
import { indexOfBytes } from '../pdf/syntax.js';
import { inspectPdf } from '../pdf/inspect.js';

// The header may follow up to 1 KB of other data, as PDF readers allow.
export function detect(u8) { return indexOfBytes(u8, '%PDF-', 0, Math.min(u8.length, 1029)) >= 0 ? inspectPdf : null; }
