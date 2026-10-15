// Office Open XML (DOCX, XLSX, PPTX), OpenDocument, EPUB and ZIP archives.
import { readZip, isZip } from '../../zip/index.js';
import { utf8 } from '../bytes.js';
import { inspectArchive, inspectImages } from '../documents/package.js';
import { parseArchive } from '../documents/archive.js';
import { parseOoxml, ooxmlFormat } from '../documents/ooxml.js';
import { parseOdf, ODF_TYPES } from '../documents/odf.js';
import { parseEpub } from '../documents/epub.js';

// Archives with data in front (self-extracting stubs, polyglots) are claimed only when the name says ZIP.
const ZIP_NAMES = /\.(zip|docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|ppsx|ppsm|potx|potm|odt|ods|odp|odg|ott|ots|otp|otg|epub|jar|apk|xpi|vsix)$/i;

export function detect(u8, name = '') {
  if (isZip(u8)) return parse;
  if (ZIP_NAMES.test(name) && hasEndRecord(u8)) return parse;
  return null;
}

function hasEndRecord(u8) {
  for (let o = u8.length - 22; o >= Math.max(0, u8.length - 22 - 65535); o--) if (u8[o] === 0x50 && u8[o + 1] === 0x4b && u8[o + 2] === 5 && u8[o + 3] === 6) return true;
  return false;
}

// Which kind of package the archive holds, decided from the declared type of the main part only, so
// removing metadata parts can never change the answer.
export async function identify(zip) {
  const mimetype = zip.entries.find((e) => e.name === 'mimetype');
  if (mimetype && !mimetype.encrypted && mimetype.method === 0 && mimetype.size < 200 && mimetype.dataOffset !== null) {
    const type = utf8.decode(zip.bytes.subarray(mimetype.dataOffset, mimetype.dataOffset + mimetype.compressedSize)).trim();
    if (type === 'application/epub+zip') return { kind: 'epub', format: 'EPUB' };
    if (ODF_TYPES[type]) return { kind: 'odf', format: ODF_TYPES[type], mediaType: type };
  }
  if (zip.entries.some((e) => e.name === '[Content_Types].xml')) {
    const format = await ooxmlFormat(zip);
    if (format) return { kind: 'ooxml', format };
  }
  return { kind: 'zip', format: 'ZIP' };
}

async function parse(b, r) {
  let zip;
  try { zip = readZip(b.u8); }
  catch (error) { r.format = 'ZIP'; r.category = 'Archive'; r.warn(`The archive is damaged and could not be read (${error.message}).`); return; }
  const id = await identify(zip);
  r.format = id.format;
  r.category = id.kind === 'zip' ? 'Archive' : 'Document';
  inspectArchive(zip, r);
  if (id.kind === 'zip') { await parseArchive(zip, r); return; }
  const parsers = { ooxml: parseOoxml, odf: parseOdf, epub: parseEpub };
  const media = await parsers[id.kind](zip, r, id);
  if (media?.length) await inspectImages(r, zip, media);
}
