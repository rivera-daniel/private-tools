import { Bytes, LIMITS, latin1, utf8, utf16, clean, bytesValue, hex, fmtBytes, startsWith } from './bytes.js';
import { TIFF_TAGS, GPS_TAGS, INTEROP_TAGS, MAKERNOTE_TAGS, SERIAL_NAMES, enumValue } from './tags.js';
import { parseXmp } from './xmp.js';
import { parseIim, parsePhotoshop } from './photoshop.js';
import { parseIcc } from './icc.js';
import { AI_TOOL_PATTERN } from './signals.js';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
const POINTERS = { 0x8769: 'Exif', 0x8825: 'GPS', 0xa005: 'Interop' };
const OFFSET_ARRAYS = new Set([0x0111, 0x0117, 0x0144, 0x0145, 0x0140, 0x012d]);

// Curated key details, drawn from the full tag list.
const HIGHLIGHTS = {
  ImageDescription: ['Description', 'Description'], Make: ['Camera', 'Make'], Model: ['Camera', 'Model'], Software: ['Software', 'Software'],
  DateTime: ['Dates', 'Modified'], Artist: ['People', 'Artist'], Copyright: ['People', 'Copyright'], XPTitle: ['Description', 'Windows title'],
  XPComment: ['Comments', 'Windows comment'], XPAuthor: ['People', 'Windows author'], XPKeywords: ['Description', 'Windows keywords'], XPSubject: ['Description', 'Windows subject'],
  DateTimeOriginal: ['Dates', 'Taken'], DateTimeDigitized: ['Dates', 'Digitized'], OffsetTimeOriginal: ['Dates', 'Time zone'], UserComment: ['Comments', 'User comment'],
  CameraOwnerName: ['People', 'Camera owner'], BodySerialNumber: ['Camera', 'Body serial number'], LensMake: ['Camera', 'Lens make'], LensModel: ['Camera', 'Lens model'],
  LensSerialNumber: ['Camera', 'Lens serial number'], ImageUniqueID: ['Camera', 'Image unique ID'], ExposureTime: ['Camera', 'Exposure'], FNumber: ['Camera', 'F-number'],
  ISO: ['Camera', 'ISO'], FocalLength: ['Camera', 'Focal length'], HostComputer: ['Software', 'Host computer'], Photographer: ['People', 'Photographer'],
  ImageEditor: ['People', 'Image editor'], CameraSerialNumber: ['Camera', 'Body serial number'], UniqueCameraModel: ['Camera', 'Model'], DocumentName: ['Description', 'Document name'],
  OriginalRawFileName: ['File', 'Original raw file name'], OwnerName: ['People', 'Camera owner'], SerialNumber: ['Camera', 'Body serial number'], InternalSerialNumber: ['Camera', 'Internal serial number'], ImageEditingSoftware: ['Software', 'Editing software'], RAWDevelopingSoftware: ['Software', 'Raw developer'],
};
const PRIVATE_TAGS = new Set(['OwnerName', 'SerialNumber', 'InternalSerialNumber', 'CameraOwnerName', 'BodySerialNumber', 'LensSerialNumber', 'Artist', 'XPAuthor', 'CameraSerialNumber', 'Photographer', 'ImageEditor', 'HostComputer', 'OriginalRawFileName', 'DocumentName']);

// label: 'EXIF' inside an image container, 'TIFF' for a TIFF-based file. at: file offset of the TIFF header, when known.
// rootDir: names the first directory when it is not IFD0 (CR3 stores Exif and GPS directories as separate TIFFs).
export function parseTiff(b, r, { label = 'EXIF', at, depth = 0, rootDir = 'IFD0' } = {}) {
  if (depth > 3) { r.warn(`${label} is nested too deeply.`); return; }
  if (b.length < 8) { r.warn(`${label} block is too short.`); return; }
  const order = b.ascii(0, 2);
  if (order !== 'II' && order !== 'MM') { r.warn(`${label} block has an invalid byte order.`); return; }
  const le = order === 'II';
  const magic = b.u16(2, le);
  if (![42, 43, 0x4f52, 0x5352, 0x55].includes(magic)) { r.warn(`${label} block has an invalid TIFF header.`); return; }
  const big = magic === 43;
  const ctx = { b, r, le, label, at, depth, big, visited: new Set(), ifds: 0, gps: {}, make: '' };
  const queue = [{ offset: big ? b.u64(8, le) : b.u32(4, le), dir: rootDir, chain: rootDir === 'IFD0', index: 0 }];
  while (queue.length) {
    const job = queue.shift();
    readDirectory(ctx, job, queue);
  }
  addGps(ctx.gps, r, label);
}

function readDirectory(ctx, { offset, dir, chain, index }, queue) {
  const { b, r, le, label } = ctx;
  if (offset === 0) return;
  if (ctx.visited.has(offset)) { r.warn(`${label} contains a loop between directories. It was skipped.`); return; }
  if (++ctx.ifds > LIMITS.maxIfds) { r.warn(`${label} has too many directories. Inspection stopped early.`); return; }
  ctx.visited.add(offset);
  const entries = readIfd(b, offset, le, 0, r, label, ctx.big);
  if (!entries) return;
  const source = label ? `${label} ${dir}` : dir;
  const isThumbIfd = ctx.label === 'EXIF' && dir === 'IFD1';
  const names = dir === 'GPS' ? GPS_TAGS : dir === 'Interop' ? INTEROP_TAGS : dir.startsWith('Maker notes') ? MAKERNOTE_TAGS.Canon : TIFF_TAGS;
  let thumb = {};
  for (const e of entries) {
    const name = names[e.tag] ?? hex(e.tag);
    // By value, not raw field bytes: a 4-byte pointer sits in the first half of a BigTIFF's 8-byte field.
    if (dir !== 'GPS' && dir !== 'Interop' && POINTERS[e.tag]) { queue.push({ offset: e.unreadable ? 0 : Number(e.value()), dir: POINTERS[e.tag] }); continue; }
    if (e.tag === 0x014a && dir !== 'GPS') { const offs = [].concat(e.value()); offs.slice(0, 16).forEach((o, i) => queue.push({ offset: o, dir: `SubIFD${offs.length > 1 ? i + 1 : ''}` })); r.field(source, name, `${offs.length} sub-image${offs.length === 1 ? '' : 's'}`); continue; }
    if (dir === 'GPS') ctx.gps[e.tag] = e.value();
    if (e.tag === 0x010f && dir.startsWith('IFD')) ctx.make = clean(String(e.value() ?? ''));
    if (e.unreadable) { r.field(source, name, e.unreadable); continue; }
    if (embedded(ctx, e, source, name)) continue;
    if (e.tag === 0x0201) thumb.offset = e.value();
    if (e.tag === 0x0202) thumb.length = e.value();
    const text = formatValue(name, e);
    const flag = PRIVATE_TAGS.has(name) || dir === 'GPS' ? 'privacy' : undefined;
    if (text === '') { r.field(source, name, '(empty)'); continue; }
    r.field(source, name, text, { flag });
    if (!isThumbIfd && HIGHLIGHTS[name] && dir !== 'GPS') {
      const [group, key] = HIGHLIGHTS[name];
      r.add(group, key, text, { flag });
      if (name === 'Software' && AI_TOOL_PATTERN.test(text)) r.signal('clue', 'AI tool named in metadata', `Software: ${text.slice(0, 160)}`, `${label} Software`);
    }
  }
  if (thumb.length && (isThumbIfd || dir.startsWith('IFD'))) {
    r.field(source, 'Embedded thumbnail', fmtBytes(thumb.length), { flag: 'privacy' });
    r.add('File', 'Embedded thumbnail', fmtBytes(thumb.length), { flag: 'privacy' });
    r.signal('privacy', 'Embedded thumbnail preview', 'A small copy of the image is stored in the metadata. After cropping or editing, it can still show the original picture.', `${label} ${dir}`, 'an embedded thumbnail');
  }
  if (chain && entries.next) queue.push({ offset: entries.next, dir: `IFD${index + 1}`, chain: true, index: index + 1 });
}

// Returns entries with lazy value readers. base: offset that value pointers are relative to.
// big: BigTIFF layout (8-byte counts and offsets, 20-byte entries).
export function readIfd(b, offset, le, base, r, label, big = false) {
  const head = big ? 8 : 2; const width = big ? 20 : 12; const inline = big ? 8 : 4;
  if (!b.has(offset, head)) { r.warn(`${label} directory points past the end of the block.`); return null; }
  const count = big ? b.u64(offset, le) : b.u16(offset, le);
  if (count > LIMITS.maxIfdEntries) { r.warn(`${label} directory declares ${count} entries. It was skipped.`); return null; }
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = offset + head + i * width;
    if (!b.has(e, width)) { r.warn(`${label} directory is truncated.`); break; }
    const tag = b.u16(e, le); const type = b.u16(e + 2, le); const n = big ? b.u64(e + 4, le) : b.u32(e + 4, le);
    const unit = TYPE_SIZE[type];
    const valueAt = e + (big ? 12 : 8);
    const raw = () => (big ? b.u64(valueAt, le) : b.u32(valueAt, le));
    if (!unit) { entries.push({ tag, type, count: n, at: valueAt, size: 0, raw, unreadable: `unreadable (unknown type ${type})`, value: () => null, bytes: () => new Uint8Array() }); continue; }
    const size = unit * n;
    const at = size <= inline ? valueAt : base + raw();
    if (!b.has(at, size)) { entries.push({ tag, type, count: n, at, size, raw, unreadable: `unreadable (${size.toLocaleString('en-US')} bytes point outside the block)`, value: () => null, bytes: () => new Uint8Array() }); continue; }
    entries.push({ tag, type, count: n, at, size, raw, value: () => readValue(b, type, n, at, le), bytes: () => b.slice(at, size) });
  }
  const nextAt = offset + head + count * width;
  entries.next = b.has(nextAt, inline) ? (big ? b.u64(nextAt, le) : b.u32(nextAt, le)) : 0;
  return entries;
}

export function readValue(b, type, n, at, le) {
  if (type === 2) return latin1(b.slice(at, Math.min(n, LIMITS.maxTextChars))).replace(/\0[\s\S]*$/, '');
  if (type === 1 || type === 6 || type === 7) return b.slice(at, Math.min(n, LIMITS.maxTextChars));
  const out = []; const unit = TYPE_SIZE[type];
  const shown = Math.min(n, 64);
  for (let i = 0; i < shown; i++) {
    const o = at + i * unit;
    if (!b.has(o, unit)) break;
    if (type === 3) out.push(b.u16(o, le));
    else if (type === 4 || type === 13) out.push(b.u32(o, le));
    else if (type === 8) out.push(b.i16(o, le));
    else if (type === 9) out.push(b.i32(o, le));
    else if (type === 5) out.push([b.u32(o, le), b.u32(o + 4, le)]);
    else if (type === 10) out.push([b.i32(o, le), b.i32(o + 4, le)]);
    else if (type === 11) out.push(b.f32(o, le));
    else if (type === 12) out.push(b.f64(o, le));
    else if (type === 16 || type === 17 || type === 18) out.push(b.u64(o, le));
  }
  if (n > shown) out.truncated = n;
  return n === 1 ? out[0] : out;
}

// XMP, IPTC, Photoshop, ICC and maker notes stored inside TIFF tags.
function embedded(ctx, e, source, name) {
  const { r, label, depth } = ctx;
  const blockAt = ctx.at !== undefined ? ctx.at + e.at : undefined;
  if (e.tag === 0x02bc) { parseXmp(utf8.decode(e.bytes()), r); r.block('XMP', blockAt, e.size, { container: `${label} tag 0x02BC` }); r.field(source, name, `${fmtBytes(e.size)}, listed under XMP`); return true; }
  if (e.tag === 0x83bb) { parseIim(new Bytes(e.bytes()), r); r.block('IPTC', blockAt, e.size, { container: `${label} tag 0x83BB` }); r.field(source, name, `${fmtBytes(e.size)}, listed under IPTC`); return true; }
  if (e.tag === 0x8649) { parsePhotoshop(new Bytes(e.bytes()), r, { at: blockAt, depth: depth + 1 }); r.field(source, name, `${fmtBytes(e.size)}, listed under Photoshop`); return true; }
  if (e.tag === 0x8773) { parseIcc(new Bytes(e.bytes()), r); r.block('ICC', blockAt, e.size, { container: `${label} tag 0x8773`, removable: false }); r.field(source, name, `${fmtBytes(e.size)}, listed under ICC profile`); return true; }
  if (e.tag === 0x927c) { parseMakerNote(ctx, e, source); return true; }
  if (e.tag === 0x002e && ctx.label === 'TIFF' && e.size > 4 && startsWith(e.bytes(), '\xff\xd8\xff')) { r.embeddedJpeg = { at: (ctx.at ?? 0) + e.at, size: e.size }; r.field(source, 'JpgFromRaw', `${fmtBytes(e.size)} embedded JPEG; its metadata is listed separately`); return true; }
  if (e.tag === 0xc4a5) { r.field(source, name, `${fmtBytes(e.size)} of printer settings`); return true; }
  if (e.tag === 0xc634) { parseDngPrivate(ctx, e, source, name); return true; }
  return false;
}

// Maker-note layouts: header signature, IFD position, and what value offsets are relative to
// ('note' = the maker note's own start, 'tiff' = the enclosing TIFF header).
const LAYOUTS = [
  { sig: 'Apple iOS\0', vendor: 'Apple', ifd: 14, base: 'note', order: 'MM' },
  { sig: 'Nikon\0', vendor: 'Nikon', nikon: true },
  { sig: 'FUJIFILM', vendor: 'Fujifilm', fuji: true },
  { sig: 'OLYMPUS\0', vendor: 'Olympus', ifd: 12, base: 'note', orderAt: 8 },
  { sig: 'OM SYSTEM', vendor: 'Olympus', ifd: 16, base: 'note', orderAt: 12 },
  { sig: 'OLYMP\0', vendor: 'Olympus', ifd: 8, base: 'tiff' },
  { sig: 'Panasonic\0', vendor: 'Panasonic', ifd: 12, base: 'tiff' },
  { sig: 'SONY DSC ', vendor: 'Sony', ifd: 12, base: 'tiff' },
  { sig: 'SONY CAM ', vendor: 'Sony', ifd: 12, base: 'tiff' },
  { sig: 'AOC\0', vendor: 'Pentax', ifd: 6, base: 'tiff' },
  { sig: 'PENTAX \0', vendor: 'Pentax', ifd: 10, base: 'note', orderAt: 8 },
  { sig: 'SANYO\0', vendor: 'Sanyo', ifd: 8, base: 'tiff' },
  { sig: 'SIGMA\0', vendor: 'Sigma', ifd: 10, base: 'tiff' },
  { sig: 'FOVEON\0', vendor: 'Sigma', ifd: 10, base: 'tiff' },
  { sig: 'RICOH\0', vendor: 'Ricoh', ifd: 8, base: 'tiff' },
  { sig: 'Ricoh\0', vendor: 'Ricoh', ifd: 8, base: 'tiff' },
  { sig: 'QVC\0', vendor: 'Casio', ifd: 6, base: 'tiff' },
  { sig: 'SAMSUNG', vendor: 'Samsung', ifd: 0, base: 'tiff' },
  { sig: 'LEICA\0', vendor: 'Leica', ifd: 8, base: 'tiff' },
];
const VENDOR_BY_MAKE = [[/^canon/, 'Canon'], [/^nikon/, 'Nikon'], [/^(konica )?minolta/, 'Minolta'], [/^casio/, 'Casio'], [/^sony/, 'Sony'], [/^samsung/, 'Samsung'], [/^kodak|^eastman/, 'Kodak'], [/^(pentax|asahi|ricoh)/, 'Pentax'], [/^hp|^hewlett/, 'HP'], [/^google/, 'Google']];
// Olympus keeps camera and lens identity in sub-directories.
const OLYMPUS_SUBDIRS = { 0x2010: 'Equipment', 0x2020: 'Camera settings', 0x2030: 'Raw development', 0x2031: 'Raw development 2', 0x2040: 'Image processing', 0x2050: 'Focus info' };

// Tries both byte orders; accepts the first that looks like a real directory.
function plausibleIfd(view, at, preferLe) {
  for (const le of [preferLe, !preferLe]) {
    if (!view.has(at, 2)) return null;
    const n = view.u16(at, le);
    if (n < 1 || n > 400 || !view.has(at + 2, n * 12)) continue;
    let ok = true;
    for (let i = 0; i < Math.min(n, 6); i++) { const t = view.u16(at + 2 + i * 12 + 2, le); if (t < 1 || t > 13) { ok = false; break; } }
    if (ok) return le;
  }
  return null;
}

function parseMakerNote(ctx, e, source) {
  const { b, r } = ctx;
  const data = e.bytes();
  const layout = LAYOUTS.find((l) => startsWith(data, l.sig));
  const vendor = layout?.vendor ?? VENDOR_BY_MAKE.find(([re]) => re.test(ctx.make.toLowerCase()))?.[1] ?? '';
  const label = vendor ? `Maker notes (${vendor})` : 'Maker notes';
  const blockAt = ctx.at !== undefined ? ctx.at + e.at : undefined;
  r.block('MakerNote', blockAt, e.size, { container: `${ctx.label} tag 0x927C`, vendor: vendor || 'unknown' });
  // view: bytes the IFD lives in; at: IFD position in view; base: added to value offsets.
  let view = b; let at = e.at; let base = 0; let le = ctx.le;
  try {
    if (layout?.nikon) {
      if (data.length > 18 && data[6] >= 2) { view = new Bytes(data.subarray(10)); le = view.ascii(0, 2) === 'II'; at = view.u32(4, le); }
      else at = e.at + 8;
    } else if (layout?.fuji) { view = new Bytes(data); le = true; at = view.u32(8, true); }
    else if (layout) {
      if (layout.base === 'note') { view = new Bytes(data); at = layout.ifd; } else at = e.at + layout.ifd;
      if (layout.order) le = layout.order === 'II';
      if (layout.orderAt !== undefined) le = data[layout.orderAt] === 0x49;
    }
  } catch { at = -1; }
  if (ctx.makerBase !== undefined && view === b) base = ctx.makerBase;
  const order = at >= 0 ? plausibleIfd(view, at, le) : null;
  const entries = order === null ? null : readIfd(view, at, order, base, { warn: () => {} }, label);
  if (!entries?.length) {
    r.field(source, 'MakerNote', `${fmtBytes(e.size)} of ${vendor || 'manufacturer'} data in a vendor-specific format that is not decoded.`);
    r.field(label, 'Not decoded', `${fmtBytes(e.size)}. This maker note does not use a standard directory layout.`);
    return;
  }
  r.field(source, 'MakerNote', `${fmtBytes(e.size)}, ${entries.length} entries listed under ${label}`);
  listMakerEntries(r, view, entries, order, base, vendor, label, MAKERNOTE_TAGS[vendor] ?? {}, 0);
  r.field(label, 'Note', 'Vendor tag names are not decoded except for identifying fields. Values are shown by tag ID.');
}

function listMakerEntries(r, view, entries, le, base, vendor, label, names, depth) {
  for (const m of entries.slice(0, 500)) {
    const sub = vendor === 'Olympus' && OLYMPUS_SUBDIRS[m.tag];
    if (sub && depth === 0) {
      // Stored as an IFD pointer (type 13 or 4) or as undefined bytes holding the directory.
      const at = m.type === 7 ? m.at : base + m.raw();
      const order = plausibleIfd(view, at, le);
      if (order !== null) {
        const subEntries = readIfd(view, at, order, base, { warn: () => {} }, label);
        if (subEntries?.length) { listMakerEntries(r, view, subEntries, order, base, vendor, `${label} ${sub}`, MAKERNOTE_TAGS[`Olympus ${sub}`] ?? {}, 1); continue; }
      }
    }
    const name = names[m.tag] ?? `Tag ${hex(m.tag)}`;
    let text;
    try { text = m.unreadable ?? formatValue(name, m); } catch { text = 'unreadable'; }
    if (text === '') text = '(empty)';
    const sensitive = SERIAL_NAMES.test(name);
    r.field(label, name, text, { flag: sensitive ? 'privacy' : undefined });
    if (sensitive && /Serial/.test(name) && text !== '(empty)') {
      r.add('Camera', `${vendor} ${name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`, text, { flag: 'privacy' });
      r.signal('privacy', 'Device serial number stored', 'A serial number can link this file to other photos from the same camera.', label, 'a device serial number');
    }
    if (name === 'OwnerName' && text !== '(empty)') r.add('People', 'Camera owner', text, { flag: 'privacy' });
  }
}

// DNG keeps the original camera maker note in DNGPrivateData, with the offset it had in the original file.
function parseDngPrivate(ctx, e, source, name) {
  const { b, r } = ctx;
  const d = e.bytes();
  if (!startsWith(d, 'Adobe\0MakN') || d.length < 20) { r.field(source, name, `${fmtBytes(e.size)} of vendor data, not decoded`); return; }
  const len = new Bytes(d).u32(10);
  const order = latin1(d.subarray(14, 16)) === 'II';
  const original = new Bytes(d).u32(16);
  const start = e.at + 20;
  r.field(source, name, `${fmtBytes(e.size)}, holds the original maker note`);
  // Re-run the maker-note parser on the copied bytes, with value offsets rebased to where they now live.
  const inner = { ...ctx, le: order, makerBase: start - original };
  parseMakerNote(inner, { at: start, size: Math.min(len, b.length - start), bytes: () => b.slice(start, Math.min(len, b.length - start)) }, source);
}

const rational = (v) => (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && !Array.isArray(v[0]) ? (v[1] ? v[0] / v[1] : 0) : null);
const round = (x) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 10000) / 10000));

export function formatValue(name, e) {
  if (OFFSET_ARRAYS.has(e.tag) && e.count > 1) return `${e.count.toLocaleString('en-US')} values`;
  const v = e.value();
  if (v === null || v === undefined) return '';
  if (v instanceof Uint8Array) {
    if (/^XP/.test(name)) return clean(utf16(v, true).replace(/\0+$/, ''));
    if (name === 'UserComment' || name === 'GPSProcessingMethod' || name === 'GPSAreaInformation') return decodeComment(v);
    if (/Version$/.test(name) && v.length === 4 && v.every((x) => x >= 0x30 && x <= 0x39)) return latin1(v);
    if (name === 'GPSVersionID' || name === 'DNGVersion' || name === 'DNGBackwardVersion') return [...v].join('.');
    if (name === 'ComponentsConfiguration') return [...v].map((x) => ['-', 'Y', 'Cb', 'Cr', 'R', 'G', 'B'][x] ?? '?').join(', ');
    if (name === 'FileSource' || name === 'SceneType') return enumValue(name, v[0]) ?? (name === 'SceneType' && v[0] === 1 ? 'Directly photographed' : String(v[0]));
    if (e.type === 1 && v.length <= 8) return [...v].join(', ');
    return bytesValue(v);
  }
  if (typeof v === 'string') return clean(v);
  const en = enumValue(name, Array.isArray(v) ? undefined : v);
  if (en) return en;
  if (name === 'ExposureTime') { const x = rational(v); return x ? (x < 1 ? `1/${Math.round(1 / x)} s` : `${round(x)} s`) : ''; }
  if (name === 'FNumber') { const x = rational(v); return x ? `f/${x.toFixed(1)}` : ''; }
  if (name === 'FocalLength') { const x = rational(v); return x ? `${round(x)} mm` : ''; }
  if (/^GPS(Dest)?(Latitude|Longitude)$/.test(name) && Array.isArray(v) && v.length === 3) { const [d, m, s] = v.map(rational); return `${d}° ${m}' ${round(s)}"`; }
  if (name === 'GPSTimeStamp' && Array.isArray(v) && v.length === 3) return v.map((x) => String(Math.floor(rational(x))).padStart(2, '0')).join(':');
  const one = (x) => (Array.isArray(x) ? (rational(x) === null ? '' : round(rational(x))) : typeof x === 'number' ? round(x) : String(x));
  if (!Array.isArray(v) || rational(v) !== null) return one(v);
  const shown = v.slice(0, 16).map(one).join(', ');
  return v.length > 16 || v.truncated ? `${shown} … (${(v.truncated ?? v.length).toLocaleString('en-US')} values)` : shown;
}

function decodeComment(raw) {
  const head = latin1(raw.subarray(0, 8));
  const body = raw.subarray(8);
  if (head.startsWith('UNICODE')) { const be = body[0] === 0 && body[1] !== 0; return clean(utf16(body, !be)); }
  if (head.startsWith('ASCII') || head === '\0\0\0\0\0\0\0\0') return clean(utf8.decode(body));
  return bytesValue(raw);
}

function addGps(gps, r, label) {
  const toDeg = (v) => (Array.isArray(v) && v.length === 3 ? v.map(rational) : null);
  const lat = toDeg(gps[2]); const lon = toDeg(gps[4]);
  if (lat && lon && lat.every(Number.isFinite) && lon.every(Number.isFinite)) {
    const sign = (ref, neg) => (String(ref ?? '').trim().toUpperCase() === neg ? -1 : 1);
    const la = sign(gps[1], 'S') * (lat[0] + lat[1] / 60 + lat[2] / 3600);
    const lo = sign(gps[3], 'W') * (lon[0] + lon[1] / 60 + lon[2] / 3600);
    if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
      const text = `${la.toFixed(5)}, ${lo.toFixed(5)}`;
      r.add('Location', 'GPS coordinates', text, { flag: 'privacy' });
      r.signal('privacy', 'Exact location stored', `GPS coordinates ${text} are embedded. Anyone with the file can see where it was taken.`, `${label} GPS`, 'exact location');
    } else r.warn('GPS coordinates are out of range.');
  }
  const alt = rational(gps[6]);
  if (alt !== null && Number.isFinite(alt)) r.add('Location', 'Altitude', `${Math.round((gps[5] === 1 ? -alt : alt) * 10) / 10} m`, { flag: 'privacy' });
  if (typeof gps[0x1d] === 'string' && gps[0x1d]) r.add('Location', 'GPS date', clean(gps[0x1d]), { flag: 'privacy' });
}
