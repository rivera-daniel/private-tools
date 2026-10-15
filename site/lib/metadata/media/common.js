// Helpers shared by the audio and video parsers.
import { utf8, latin1, utf16, clean, fmtBytes, pad, LIMITS } from '../bytes.js';
import { inspectImage } from '../index.js';
import { AI_TOOL_PATTERN } from '../signals.js';

// Text of unknown encoding: UTF-8 when it decodes cleanly, otherwise Latin-1.
export function text(u8) {
  let end = u8.length; while (end > 0 && u8[end - 1] === 0) end--;
  const s = utf8.decode(u8.subarray(0, end));
  return clean(s.includes('�') ? latin1(u8.subarray(0, end)) : s);
}

// UTF-16 with an optional byte order mark (big-endian when there is none).
export function text16(u8, le = false) {
  if (u8[0] === 0xff && u8[1] === 0xfe) return clean(utf16(u8.subarray(2), true));
  if (u8[0] === 0xfe && u8[1] === 0xff) return clean(utf16(u8.subarray(2), false));
  return clean(utf16(u8, le));
}

export const isoDate = (d) => (Number.isFinite(d?.getTime?.()) ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC` : '');
// QuickTime and ISO media count seconds from 1904-01-01.
export const macDate = (seconds) => isoDate(new Date((seconds - 2082844800) * 1000));

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds * 1000) / 1000; const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return `${h ? `${h}:${pad(m)}` : m}:${sec < 10 ? '0' : ''}${sec % 1 ? sec.toFixed(3).replace(/0+$/, '') : sec}`;
}

// ISO 6709 point, e.g. "+37.3317-122.0302+012.000/". Degrees, degrees-minutes or degrees-minutes-seconds.
export function iso6709(s) {
  const m = /^\s*([+-]\d+(?:\.\d*)?)([+-]\d+(?:\.\d*)?)([+-]\d+(?:\.\d*)?)?/.exec(String(s));
  if (!m) return null;
  const part = (t, deg) => {
    const sign = t[0] === '-' ? -1 : 1; const [i, f = ''] = t.slice(1).split('.'); const frac = f ? Number(`0.${f}`) : 0;
    if (i.length <= deg) return sign * (Number(i) + frac);
    if (i.length === deg + 2) return sign * (Number(i.slice(0, deg)) + (Number(i.slice(deg)) + frac) / 60);
    if (i.length === deg + 4) return sign * (Number(i.slice(0, deg)) + Number(i.slice(deg, deg + 2)) / 60 + (Number(i.slice(deg + 2)) + frac) / 3600);
    return NaN;
  };
  const lat = part(m[1], 2); const lon = part(m[2], 3);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, alt: m[3] ? Number(m[3]) : null };
}

export function addLocation(r, lat, lon, alt, source) {
  const where = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  r.add('Location', 'GPS coordinates', where, { flag: 'privacy' });
  if (alt !== null && alt !== undefined && Number.isFinite(alt)) r.add('Location', 'Altitude', `${Math.round(alt * 10) / 10} m`, { flag: 'privacy' });
  r.signal('privacy', 'Exact location stored', `GPS coordinates ${where} are embedded. Anyone with the file can see where it was recorded.`, source, 'exact location');
}

// One decoded value: a field in its source and, when it says something about people, place, device or
// software, a highlight. group: People, Dates, Camera, Software, Description, Location, File or Comments.
export function tag(r, source, key, value, group = null, label = key) {
  if (value === undefined || value === null || value === '') return;
  const flag = group === 'People' || group === 'Location' ? 'privacy' : undefined;
  r.field(source, key, value, flag ? { flag } : {});
  if (group) r.add(group, label, String(value), flag ? { flag } : {});
  if (group === 'Software' && AI_TOOL_PATTERN.test(String(value))) r.signal('clue', 'AI tool named in metadata', `${key}: ${String(value).slice(0, 160)}`, `${source} ${key}`);
}

// Classifies free-form tag names (Vorbis comments, APE items, Matroska tags, Apple keys, RIFF INFO).
export function groupOf(name) {
  const n = String(name).toLowerCase().replace(/^.*\./, '');
  if (/location|iso6709|gps|latitude|longitude|place|city|country/.test(n)) return 'Location';
  if (/serial|identifier|uuid|uid$/.test(n)) return 'Camera';
  if (/^(make|manufacturer|model|camera|device|lens)/.test(n)) return 'Camera';
  if (/encoder|encoded_?by|software|writing|muxing|tool|vendor|application|version|firmware|^isft$/.test(n)) return 'Software';
  if (/date|time|year|^icrd$|^idit$/.test(n)) return 'Dates';
  if (/artist|author|composer|performer|conductor|lyricist|writer|copyright|owner|publisher|producer|director|engineer|creator|contact|email|license|label|organization|originator|^iart$|^icop$|^ieng$|^itch$|^icms$/.test(n)) return 'People';
  if (/title|album|comment|description|subject|keyword|genre|summary|synopsis|lyrics|^inam$|^icmt$|^iprd$/.test(n)) return 'Description';
  return null;
}

// Embedded cover art and attachments go through the image inspector. What it finds is listed under label.
const coverBudget = new WeakMap();
export async function inspectCover(u8, r, label) {
  const used = coverBudget.get(r) ?? 0;
  if (used >= 8) { r.field(label, 'Image', `${fmtBytes(u8.length)}, not inspected (more than 8 embedded images)`); return; }
  coverBudget.set(r, used + 1);
  let sub;
  try { sub = await inspectImage(u8); } catch { sub = null; }
  if (!sub?.format) { r.field(label, 'Image', `${fmtBytes(u8.length)}, not an image format the inspector reads`); return; }
  r.field(label, 'Image', `${sub.format}${sub.width ? `, ${sub.width} × ${sub.height}` : ''}, ${fmtBytes(u8.length)}`);
  for (const s of sub.sources) if (!s.technical) for (const f of s.fields.slice(0, 500)) r.field(`${label} › ${s.name}`, f.key, f.value, f.flag ? { flag: f.flag } : {});
  for (const h of sub.highlights) for (const f of h.fields) r.add(h.name, f.key, f.value, f.flag ? { flag: f.flag } : {});
  for (const s of sub.signals) r.signal(s.kind, s.title, `${label}: ${s.detail}`, `${label} ${s.source}`, s.short);
  for (const c of sub.c2pa) r.c2pa.push(c);
}

// Flat XML (iXML, axml, aXML): every leaf element becomes a field named by its last two element names.
export function xmlLeaves(xml, r, source) {
  if (xml.length > LIMITS.maxXmpChars) xml = xml.slice(0, LIMITS.maxXmpChars);
  const stack = []; let i = 0; let count = 0;
  while (i < xml.length && count < 1000) {
    const lt = xml.indexOf('<', i); if (lt < 0) break;
    if (lt > i && stack.length) {
      const value = xml.slice(i, lt).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
      if (value) { const key = stack.slice(-2).join(' › '); r.field(source, key, value, groupOf(stack.at(-1)) === 'People' ? { flag: 'privacy' } : {}); count++; const g = groupOf(stack.at(-1)); if (g) r.add(g, key, value, g === 'People' || g === 'Location' ? { flag: 'privacy' } : {}); }
    }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); i = e < 0 ? xml.length : e + 3; continue; }
    const gt = xml.indexOf('>', lt); if (gt < 0) break;
    const t = xml.slice(lt + 1, gt); i = gt + 1;
    if (t[0] === '?' || t[0] === '!') continue;
    if (t[0] === '/') { stack.pop(); continue; }
    if (!t.endsWith('/') && stack.length < 32) stack.push(/^[^\s/>]+/.exec(t)?.[0] ?? '');
  }
}

// base64 without atob's tolerance quirks; returns null on malformed input.
export function base64(s) {
  const clean64 = String(s).replace(/[\s]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean64)) return null;
  try { const bin = atob(clean64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; } catch { return null; }
}

export const PICTURE_TYPES = ['Other', 'File icon', 'Other file icon', 'Front cover', 'Back cover', 'Leaflet page', 'Media', 'Lead artist', 'Artist', 'Conductor', 'Band', 'Composer', 'Lyricist', 'Recording location', 'During recording', 'During performance', 'Screen capture', 'Bright coloured fish', 'Illustration', 'Band logo', 'Publisher logo'];
