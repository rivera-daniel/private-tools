// Plain text: removes zero-width characters, text direction controls, tag characters, hidden variation
// selector runs and the UTF-8 byte order mark. Every other character and the encoding stay as they were.
import { cleanText, TEXT_LIMIT } from '../../metadata/scan/text.js';
import { Refusal } from '../index.js';

export const formats = new Set(['Text']);

export async function clean(u8) {
  if (u8.length > TEXT_LIMIT) throw new Refusal('Text files larger than 32 MB are not cleaned.');
  const result = cleanText(u8);
  if (!result) throw new Refusal('This file could not be read as text, so it was left untouched.');
  return {
    data: result.data,
    removed: result.removed.map((x) => ({ kind: x.kind, container: 'Text', bytes: x.bytes })),
    kept: result.encoding.startsWith('UTF-16') && (u8[0] === 0xff || u8[0] === 0xfe) ? ['Byte order mark (needed to read UTF-16 text)'] : [],
  };
}
