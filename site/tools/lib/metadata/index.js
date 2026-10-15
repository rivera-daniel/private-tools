// Entry point. Every format module is imported statically so the worker loads them all with the page.
import { Bytes, LIMITS, startsWith } from './bytes.js';
import { Report } from './report.js';
import { analyze } from './signals.js';
import { parseJpeg } from './formats/jpeg.js';
import { parsePng } from './formats/png.js';
import { parseWebp } from './formats/webp.js';
import { parseIsobmff } from './formats/isobmff.js';
import { parseJxl } from './formats/jxl.js';
import { parseGif } from './formats/gif.js';
import { parseTiffFile, parseRaf } from './formats/tiff-file.js';
import { parseBmp } from './formats/bmp.js';
import { parsePsd } from './formats/psd.js';
import { parseSvg } from './formats/svg.js';
import * as documents from './families/documents.js';
import * as pdf from './families/pdf.js';
import * as media from './families/media.js';
import * as programs from './families/programs.js';
import { scanFile } from './families/scan.js';

export { LIMITS };
export const SUPPORTED = 'JPEG, PNG, WebP, HEIC, HEIF, AVIF, JPEG XL, GIF, TIFF, DNG and camera raw (CR2, CR3, NEF, ARW, ORF, RW2, PEF, RAF), PSD, BMP and SVG';
const ISO_BRANDS = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis|crx |miaf|MiHE|MiHB)$/;

export function detect(u8) {
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return parseJpeg;
  if (startsWith(u8, '\x89PNG\r\n\x1a\n')) return parsePng;
  if (startsWith(u8, 'RIFF') && startsWith(u8, 'WEBP', 8)) return parseWebp;
  if (startsWith(u8, 'ftyp', 4) && ISO_BRANDS.test(String.fromCharCode(...u8.subarray(8, 12)))) return parseIsobmff;
  if (startsWith(u8, '\0\0\0\x0cJXL \r\n\x87\n') || (u8[0] === 0xff && u8[1] === 0x0a)) return parseJxl;
  if (startsWith(u8, 'GIF87a') || startsWith(u8, 'GIF89a')) return parseGif;
  if (startsWith(u8, 'II*\0') || startsWith(u8, 'MM\0*') || startsWith(u8, 'IIRO') || startsWith(u8, 'IIRS') || startsWith(u8, 'IIU\0') || startsWith(u8, 'II+\0') || startsWith(u8, 'MM\0+')) return parseTiffFile;
  if (startsWith(u8, 'FUJIFILMCCD-RAW')) return parseRaf;
  if (startsWith(u8, '8BPS')) return parsePsd;
  if (startsWith(u8, 'BM') && u8.length > 26) return parseBmp;
  if (looksLikeSvg(u8)) return parseSvg;
  return null;
}

function looksLikeSvg(u8) {
  const head = new TextDecoder().decode(u8.subarray(0, 4096)).replace(/^﻿/, '').trimStart();
  return (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--') || head.startsWith('<!DOCTYPE svg')) && /<svg[\s>]/i.test(head);
}

export async function inspectImage(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Report(u8.length);
  if (u8.length > LIMITS.maxFileBytes) { r.warn('File exceeds the 200 MB limit and was not inspected.'); return r.toJSON(); }
  const parser = detect(u8);
  if (!parser) {
    r.warn(startsWith(u8, 'ftyp', 4) ? 'This ISO media file is not an image format the inspector reads (it may be a video).' : `This file is not a supported image. Supported formats: ${SUPPORTED}.`);
    return r.toJSON();
  }
  try { await parser(new Bytes(u8), r); }
  catch (error) { r.warn(`The file is damaged or truncated. Results may be incomplete (${error.message}).`); }
  if (r.width === null) {
    const exif = r.sources.get('EXIF Exif') ?? [];
    const w = Number(exif.find((f) => f.key === 'PixelXDimension')?.value); const h = Number(exif.find((f) => f.key === 'PixelYDimension')?.value);
    if (w && h) { r.width = w; r.height = h; }
  }
  analyze(r);
  return r.toJSON();
}

// Each family module exports detect(u8, name), returning an async parser(b, r, ctx) or null.
const FAMILIES = [documents, pdf, media, programs];

// Any file: the format's own parser when one matches, then the generic scan every file gets.
export async function inspectFile(input, name = '') {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Report(u8.length);
  if (u8.length > LIMITS.maxFileBytes) { r.warn('File exceeds the 200 MB limit and was not inspected.'); return r.toJSON(); }
  const image = detect(u8);
  if (image) r.category = 'Image';
  let parser = image;
  for (const family of FAMILIES) { if (parser) break; parser = family.detect(u8, name); }
  const b = new Bytes(u8);
  if (parser) {
    try { await parser(b, r, { name }); }
    catch (error) { r.warn(`The file is damaged or truncated. Results may be incomplete (${error.message}).`); }
  }
  try { await scanFile(b, r, { name }); }
  catch (error) { r.warn(`The general scan stopped early (${error.message}).`); }
  if (r.category === 'Image' && r.width === null) {
    const exif = r.sources.get('EXIF Exif') ?? [];
    const w = Number(exif.find((f) => f.key === 'PixelXDimension')?.value); const h = Number(exif.find((f) => f.key === 'PixelYDimension')?.value);
    if (w && h) { r.width = w; r.height = h; }
  }
  analyze(r);
  return r.toJSON();
}
