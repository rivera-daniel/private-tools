// Office Open XML, OpenDocument, EPUB and ZIP archives: rewrites the archive without metadata parts.
import { readZip } from '../../zip/index.js';
import { identify } from '../../metadata/families/documents.js';
import { cleanOoxml } from '../documents/ooxml.js';
import { cleanOdf } from '../documents/odf.js';
import { cleanEpub } from '../documents/epub.js';
import { cleanArchive } from '../documents/archive.js';
import { refuse } from '../documents/common.js';
import { Refusal } from '../index.js';

export const formats = new Set(['DOCX', 'DOCM', 'DOTX', 'DOTM', 'XLSX', 'XLSM', 'XLTX', 'XLTM', 'PPTX', 'PPTM', 'PPSX', 'PPSM', 'POTX', 'POTM', 'ODT', 'ODS', 'ODP', 'ODG', 'OTT', 'OTS', 'OTP', 'OTG', 'EPUB', 'ZIP']);

// An EPUB's package identifier is replaced on every clean, even when nothing else is found.
export const mustRewrite = (report) => report.format === 'EPUB';

export async function clean(u8, report, ctx) {
  const options = ctx.options ?? {};
  let zip;
  try { zip = readZip(u8); } catch (error) { refuse(`The archive could not be read (${error.message}).`); }
  if (zip.entries.some((e) => e.encrypted)) refuse('This archive has encrypted entries. They cannot be rewritten without the password, so the file was left untouched.');
  const id = await identify(zip);
  if (id.format !== report.format) refuse('The file changed type while it was being read, so it was left untouched.');
  const cleaners = { ooxml: cleanOoxml, odf: cleanOdf, epub: cleanEpub, zip: cleanArchive };
  try { return await cleaners[id.kind](zip, report, options); }
  catch (error) { if (error instanceof Refusal) throw error; return refuse(`The file could not be rewritten safely (${error.message}), so it was left untouched.`); }
}
