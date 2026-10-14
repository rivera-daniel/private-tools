import { Bytes, utf8, utf16, clean, fmtBytes, hex, hexPreview, bytesValue } from './bytes.js';
import { parseXmp } from './xmp.js';
import { parseIcc } from './icc.js';
import { parseTiff } from './tiff.js';
import { AI_TOOL_PATTERN } from './signals.js';

const IIM = {
  1: { 0: 'EnvelopeRecordVersion', 5: 'Destination', 20: 'FileFormat', 22: 'FileVersion', 30: 'ServiceIdentifier', 40: 'EnvelopeNumber', 50: 'ProductID', 60: 'EnvelopePriority', 70: 'DateSent', 80: 'TimeSent', 90: 'CodedCharacterSet', 100: 'UniqueObjectName', 120: 'ARMIdentifier', 122: 'ARMVersion' },
  2: {
    0: 'ApplicationRecordVersion', 3: 'ObjectTypeReference', 4: 'ObjectAttributeReference', 5: 'ObjectName', 7: 'EditStatus', 8: 'EditorialUpdate', 10: 'Urgency',
    12: 'SubjectReference', 15: 'Category', 20: 'SupplementalCategories', 22: 'FixtureIdentifier', 25: 'Keywords', 26: 'ContentLocationCode', 27: 'ContentLocationName',
    30: 'ReleaseDate', 35: 'ReleaseTime', 37: 'ExpirationDate', 38: 'ExpirationTime', 40: 'SpecialInstructions', 42: 'ActionAdvised', 45: 'ReferenceService',
    47: 'ReferenceDate', 50: 'ReferenceNumber', 55: 'DateCreated', 60: 'TimeCreated', 62: 'DigitalCreationDate', 63: 'DigitalCreationTime', 65: 'OriginatingProgram',
    70: 'ProgramVersion', 75: 'ObjectCycle', 80: 'By-line', 85: 'By-lineTitle', 90: 'City', 92: 'Sub-location', 95: 'Province-State', 100: 'Country-PrimaryLocationCode',
    101: 'Country-PrimaryLocationName', 103: 'OriginalTransmissionReference', 105: 'Headline', 110: 'Credit', 115: 'Source', 116: 'CopyrightNotice', 118: 'Contact',
    120: 'Caption-Abstract', 121: 'LocalCaption', 122: 'Writer-Editor', 130: 'ImageType', 131: 'ImageOrientation', 135: 'LanguageIdentifier', 184: 'JobID',
    187: 'MasterDocumentID', 188: 'ShortDocumentID', 189: 'UniqueDocumentID', 190: 'OwnerID', 221: 'Prefs', 225: 'ClassifyState', 228: 'SimilarityIndex',
    230: 'DocumentNotes', 231: 'DocumentHistory', 232: 'ExifCameraInfo',
  },
};
const IIM_HIGHLIGHTS = {
  'ObjectName': ['Description', 'Title'], 'Keywords': ['Description', 'Keywords'], 'By-line': ['People', 'By-line'], 'By-lineTitle': ['People', 'By-line title'],
  'City': ['Location', 'City'], 'Sub-location': ['Location', 'Sub-location'], 'Province-State': ['Location', 'State'], 'Country-PrimaryLocationName': ['Location', 'Country'],
  'Headline': ['Description', 'Headline'], 'Credit': ['People', 'Credit'], 'Source': ['People', 'Source'], 'CopyrightNotice': ['People', 'Copyright notice'],
  'Caption-Abstract': ['Description', 'Caption'], 'Writer-Editor': ['People', 'Caption writer'], 'Contact': ['People', 'Contact'], 'DateCreated': ['Dates', 'Date created'],
  'OriginatingProgram': ['Software', 'Originating program'],
};
const IIM_PRIVATE = /By-line|City|Sub-location|Province|Country|Contact|Writer|Credit|CopyrightNotice|Source/;

export function parseIim(b, r) {
  let o = 0; let n = 0; const values = new Map();
  while (o + 5 <= b.length && n++ < 5000) {
    if (b.u8at(o) !== 0x1c) break;
    const rec = b.u8at(o + 1); const ds = b.u8at(o + 2); let len = b.u16(o + 3); let head = 5;
    if (len & 0x8000) { const lenBytes = len & 0x7fff; if (lenBytes > 4 || !b.has(o + 5, lenBytes)) break; len = 0; for (let i = 0; i < lenBytes; i++) len = len * 256 + b.u8at(o + 5 + i); head = 5 + lenBytes; }
    if (!b.has(o + head, len)) { r.warn('An IPTC dataset is truncated.'); break; }
    const raw = b.slice(o + head, len);
    const name = IIM[rec]?.[ds] ?? `${rec}:${String(ds).padStart(3, '0')}`;
    const value = (ds === 0 && len === 2) ? String(new Bytes(raw).u16(0)) : rec === 1 && ds === 90 ? hexPreview(raw) : bytesValue(raw);
    const key = `${rec === 1 ? 'Envelope' : rec === 2 ? 'Application' : `Record ${rec}`} › ${name}`;
    const list = values.get(key) ?? []; list.push(clean(value)); values.set(key, list);
    o += head + len;
  }
  for (const [key, list] of values) {
    const name = key.split(' › ')[1];
    const value = list.filter(Boolean).join('; ');
    const flag = IIM_PRIVATE.test(name) ? 'privacy' : undefined;
    r.field('IPTC', key, value, { flag });
    if (IIM_HIGHLIGHTS[name]) r.add(...IIM_HIGHLIGHTS[name], value, { flag });
    if (name === 'OriginatingProgram' && AI_TOOL_PATTERN.test(value)) r.signal('clue', 'AI tool named in metadata', `Originating program: ${value}`, 'IPTC 2:65');
  }
}

const RESOURCES = {
  0x03e8: 'Channels, rows, columns', 0x03e9: 'Print info (Mac)', 0x03ed: 'Resolution info', 0x03ee: 'Alpha channel names', 0x03ef: 'Display info', 0x03f0: 'Caption (Pascal)',
  0x03f1: 'Border info', 0x03f2: 'Background color', 0x03f3: 'Print flags', 0x03f4: 'Grayscale halftoning', 0x03f5: 'Color halftoning', 0x03f6: 'Duotone halftoning',
  0x03f7: 'Grayscale transfer', 0x03f8: 'Color transfer', 0x03f9: 'Duotone transfer', 0x03fa: 'Duotone image info', 0x03fb: 'Effective black and white',
  0x03fd: 'EPS options', 0x03fe: 'Quick mask info', 0x0400: 'Layer state', 0x0402: 'Layer groups', 0x0404: 'IPTC-NAA record', 0x0405: 'Raw format info',
  0x0406: 'JPEG quality', 0x0408: 'Grid and guides', 0x0409: 'Thumbnail (Photoshop 4)', 0x040a: 'Copyright flag', 0x040b: 'URL', 0x040c: 'Thumbnail',
  0x040d: 'Global angle', 0x040f: 'ICC profile', 0x0410: 'Watermark', 0x0411: 'ICC untagged', 0x0412: 'Effects visible', 0x0413: 'Spot halftone',
  0x0414: 'Document ID seed', 0x0415: 'Unicode alpha names', 0x0416: 'Indexed color table count', 0x0417: 'Transparency index', 0x0419: 'Global altitude',
  0x041a: 'Slices', 0x041b: 'Workflow URL', 0x041c: 'Jump to XPEP', 0x041d: 'Alpha identifiers', 0x041e: 'URL list', 0x0421: 'Version info',
  0x0422: 'EXIF data 1', 0x0423: 'EXIF data 3', 0x0424: 'XMP metadata', 0x0425: 'Caption digest', 0x0426: 'Print scale', 0x0428: 'Pixel aspect ratio',
  0x0429: 'Layer comps', 0x042a: 'Alternate duotone colors', 0x042b: 'Alternate spot colors', 0x042d: 'Layer selection IDs', 0x042e: 'HDR toning info',
  0x042f: 'Print info (Windows)', 0x0430: 'Layer groups enabled', 0x0431: 'Color samplers', 0x0432: 'Measurement scale', 0x0433: 'Timeline info',
  0x0434: 'Sheet disclosure', 0x0435: 'Display info (CS3)', 0x0436: 'Onion skins', 0x0438: 'Count info', 0x043a: 'Print info', 0x043b: 'Print style',
  0x043c: 'Mac NSPrintInfo', 0x043d: 'Windows DEVMODE', 0x043e: 'Auto save file path', 0x043f: 'Auto save format', 0x0440: 'Path selection state',
  0x0bb7: 'Clipping path name', 0x0bb8: 'Origin path info', 0x1b58: 'Image Ready variables', 0x1b59: 'Image Ready data sets', 0x2710: 'Print flags info',
};

// Photoshop image resource blocks (JPEG APP13, PSD, TIFF tag 34377). at: file offset of b, when known.
export function parsePhotoshop(b, r, { at, depth = 0 } = {}) {
  let o = 0; let n = 0;
  while (o + 12 <= b.length && n++ < 2000) {
    const sig = b.ascii(o, 4);
    if (!['8BIM', 'MeSa', 'PHUT', 'AgHg', 'DCSR'].includes(sig)) break;
    const id = b.u16(o + 4);
    const nameLen = b.u8at(o + 6);
    const name = clean(b.ascii(o + 7, nameLen));
    let p = o + 7 + nameLen; if ((nameLen + 1) & 1) p++;
    if (!b.has(p, 4)) break;
    const size = b.u32(p);
    if (!b.has(p + 4, size)) { r.warn('A Photoshop resource declares a length past the end of its block.'); break; }
    const data = b.sub(p + 4, size);
    const blockAt = at !== undefined ? at + p + 4 : undefined;
    const label = RESOURCES[id] ?? (id >= 0x07d0 && id <= 0x0bb6 ? `Path ${id - 0x07d0 + 1}` : `Resource ${hex(id)}`);
    const key = `${hex(id)} ${label}${name ? ` (${name})` : ''}`;
    let value = null;
    try { value = describeResource(id, data, r, blockAt, depth); } catch { r.warn(`Photoshop resource ${hex(id)} could not be read.`); }
    r.field('Photoshop', key, value ?? fmtBytes(size), { flag: [0x040c, 0x0409, 0x043e, 0x040b, 0x041e, 0x041b].includes(id) ? 'privacy' : undefined });
    o = p + 4 + size + (size & 1);
  }
}

function describeResource(id, d, r, at, depth) {
  switch (id) {
    case 0x0404: parseIim(d, r); r.block('IPTC', at, d.length, { container: 'Photoshop 0x0404' }); return `${fmtBytes(d.length)}, listed under IPTC`;
    case 0x0424: parseXmp(utf8.decode(d.u8), r); r.block('XMP', at, d.length, { container: 'Photoshop 0x0424' }); return `${fmtBytes(d.length)}, listed under XMP`;
    case 0x040f: parseIcc(d, r); r.block('ICC', at, d.length, { container: 'Photoshop 0x040F', removable: false }); return `${fmtBytes(d.length)}, listed under ICC profile`;
    case 0x0422: case 0x0423: r.within(r.block('EXIF', at, d.length, { container: `Photoshop ${hex(id)}` }), () => parseTiff(d, r, { label: 'EXIF', at, depth: depth + 1 })); return `${fmtBytes(d.length)}, listed under EXIF`;
    case 0x0409: case 0x040c: {
      r.block('Thumbnail', at, d.length, { container: `Photoshop ${hex(id)}` });
      r.add('File', 'Embedded thumbnail', `${fmtBytes(d.length)} (Photoshop)`, { flag: 'privacy' });
      r.signal('privacy', 'Embedded thumbnail preview', 'A small copy of the image is stored in the metadata. After cropping or editing, it can still show the original picture.', 'Photoshop resource', 'an embedded thumbnail');
      return d.length >= 28 ? `${d.u32(4)} × ${d.u32(8)} JPEG, ${fmtBytes(d.length)}` : fmtBytes(d.length);
    }
    case 0x03ed: return d.length >= 16 ? `${(d.u32(0) / 65536).toFixed(0)} × ${(d.u32(8) / 65536).toFixed(0)} ${d.u16(4) === 2 ? 'pixels/cm' : 'pixels/inch'}` : null;
    case 0x0406: return d.length >= 2 ? `Quality ${d.i16(0) + 4} of 12` : null;
    case 0x040a: return d.length ? (d.u8at(0) ? 'Copyrighted' : 'Not marked') : null;
    case 0x0414: return d.length >= 4 ? String(d.u32(0)) : null;
    case 0x0425: return hexPreview(d.u8, 16);
    case 0x0421: { // Version info names the writer and reader applications.
      if (d.length < 9) return null;
      const s1 = d.u32(5); const writer = clean(utf16(d.slice(9, s1 * 2), false));
      const p = 9 + s1 * 2; const s2 = d.has(p, 4) ? d.u32(p) : 0; const reader = clean(utf16(d.slice(p + 4, s2 * 2), false));
      if (writer) r.add('Software', 'Written by', writer);
      return [writer && `Writer: ${writer}`, reader && `Reader: ${reader}`].filter(Boolean).join(' · ') || null;
    }
    case 0x040b: case 0x041b: case 0x043e: case 0x0bb7: return bytesValue(d.u8);
    case 0x03f0: return clean(utf8.decode(d.slice(1, d.u8at(0))));
    default: return null;
  }
}
