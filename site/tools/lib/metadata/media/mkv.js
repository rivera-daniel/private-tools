// Matroska and WebM: EBML elements.
import { utf8, clean, fmtBytes, hexPreview } from '../bytes.js';
import { tag, groupOf, duration, isoDate, iso6709, addLocation } from './common.js';

export const ID = {
  EBML: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac, Info: 0x1549a966, Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675, Cues: 0x1c53bb6b, Attachments: 0x1941a469, Chapters: 0x1043a770, Tags: 0x1254c367, Void: 0xec, CRC32: 0xbf,
  SegmentUID: 0x73a4, SegmentFilename: 0x7384, PrevUID: 0x3cb923, PrevFilename: 0x3c83ab, NextUID: 0x3eb923, NextFilename: 0x3e83bb, TimestampScale: 0x2ad7b1, Duration: 0x4489,
  DateUTC: 0x4461, Title: 0x7ba9, MuxingApp: 0x4d80, WritingApp: 0x5741, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, Name: 0x536e, Language: 0x22b59c,
  LanguageBCP47: 0x22b59d, CodecID: 0x86, CodecName: 0x258688, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Tag: 0x7373, Targets: 0x63c0, TargetType: 0x63ca, TargetTypeValue: 0x68ca, SimpleTag: 0x67c8, TagName: 0x45a3, TagString: 0x4487, TagBinary: 0x4485,
  AttachedFile: 0x61a7, FileName: 0x466e, FileMimeType: 0x4660, FileDescription: 0x467e, FileData: 0x465c, EditionEntry: 0x45b9, ChapterAtom: 0xb6, ChapterDisplay: 0x80, ChapString: 0x85,
};
export const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Attachments, ID.Chapters, ID.Tags, ID.EBML, ID.Segment]);
const TRACK_TYPES = { 1: 'Video', 2: 'Audio', 3: 'Complex', 16: 'Logo', 17: 'Subtitles', 18: 'Buttons', 32: 'Control' };
export const LIMIT = { elements: 2000000, depth: 12 };

function vint(b, o) {
  if (!b.has(o, 1)) return null;
  const first = b.u8at(o); if (!first) return null;
  let len = 1; while (!(first & (0x80 >> (len - 1)))) len++;
  if (!b.has(o, len)) return null;
  let value = first & ((0x80 >> (len - 1)) - 1); let ones = value === (0x80 >> (len - 1)) - 1;
  for (let i = 1; i < len; i++) { const x = b.u8at(o + i); value = value * 256 + x; ones = ones && x === 0xff; }
  return { value, len, unknown: ones };
}

// One element header at o. end bounds its parent. Returns null when no element can be read.
export function element(b, o, end) {
  if (o >= end || !b.has(o, 2)) return null;
  const first = b.u8at(o); if (first < 0x10) return null;
  const idLen = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : 4;
  if (!b.has(o, idLen)) return null;
  let id = 0; for (let i = 0; i < idLen; i++) id = id * 256 + b.u8at(o + i);
  const sz = vint(b, o + idLen); if (!sz) return null;
  const header = idLen + sz.len; const start = o + header;
  if (sz.unknown) return { id, offset: o, idLen, sizeLen: sz.len, header, start, end, unknown: true };
  return { id, offset: o, idLen, sizeLen: sz.len, header, start, end: start + sz.value, overflow: start + sz.value > end };
}

// Children of [start, end). Unknown-size clusters (live WebM recordings) end where the next top-level element begins.
export function children(b, start, end, budget = { n: 0 }) {
  const out = []; let o = start;
  while (o < end && budget.n++ < LIMIT.elements) {
    const el = element(b, o, end);
    if (!el) { out.stop = o; break; }
    if (el.unknown) el.end = unknownEnd(b, el, end, budget);
    if (el.overflow) { out.overflow = el; break; }
    out.push(el); o = el.end;
  }
  if (out.stop === undefined) out.stop = o;
  return out;
}

function unknownEnd(b, el, end, budget) {
  let o = el.start;
  while (o < end && budget.n++ < LIMIT.elements) {
    const c = element(b, o, end);
    if (!c || c.unknown || LEVEL1.has(c.id) || c.overflow) return c?.overflow ? end : o;
    o = c.end;
  }
  return Math.min(o, end);
}

const uint = (b, el) => { let v = 0; for (let i = el.start; i < el.end && i < el.start + 8; i++) v = v * 256 + b.u8at(i); return v; };
const float = (b, el) => (el.end - el.start === 4 ? b.f32(el.start) : el.end - el.start === 8 ? b.f64(el.start) : 0);
const str = (b, el) => clean(utf8.decode(b.slice(el.start, el.end - el.start)).replace(/\0+$/, ''));
const hexOf = (b, el) => [...b.slice(el.start, Math.min(32, el.end - el.start))].map((x) => x.toString(16).padStart(2, '0')).join('');
const nonZero = (b, el) => b.u8.subarray(el.start, el.end).some((x) => x);

export function parseMkv(b, r, ctx) {
  r.category = 'Video';
  const budget = { n: 0 };
  const head = element(b, 0, b.length);
  if (!head || head.overflow || head.unknown) { r.warn('The EBML header is damaged.'); return; }
  let doc = 'matroska';
  for (const c of children(b, head.start, head.end, budget)) if (c.id === ID.DocType) doc = str(b, c);
  r.format = doc === 'webm' ? 'WebM' : 'MKV';
  r.field('Container', 'Document type', doc);
  r.struct('EBML header', 0, head.end);
  let o = head.end; let segments = 0;
  while (o < b.length && segments < 16) {
    const seg = element(b, o, b.length);
    if (!seg || seg.id !== ID.Segment) break;
    segments++;
    if (seg.overflow) r.warn('The Matroska segment runs past the end of the file. The file is truncated.');
    const end = Math.min(seg.end, b.length);
    r.struct('Segment', seg.offset, end - seg.offset);
    const top = children(b, seg.start, end, budget);
    let clusters = 0; let clusterBytes = 0; ctx.audio = false; ctx.scale = 1000000;
    for (const el of top) {
      if (el.id === ID.Cluster) { clusters++; clusterBytes += el.end - el.offset; continue; }
      r.struct(Object.keys(ID).find((k) => ID[k] === el.id) ?? `0x${el.id.toString(16)}`, el.offset, el.end - el.offset);
      try {
        if (el.id === ID.Info) info(b, el, r, budget);
        else if (el.id === ID.Tracks) tracks(b, el, r, ctx, budget);
        else if (el.id === ID.Tags) r.within(r.block('Tags', el.offset, el.end - el.offset, { container: 'Matroska Tags' }), () => tags(b, el, r, budget));
        else if (el.id === ID.Attachments) r.within(r.block('Attachments', el.offset, el.end - el.offset, { container: 'Matroska Attachments' }), () => attachments(b, el, r, ctx, budget));
        else if (el.id === ID.Chapters) chapters(b, el, r, budget);
        else if (el.id === ID.Void && nonZero(b, el)) r.block('Padding', el.offset, el.end - el.offset, { container: 'Matroska Void', decoded: false, note: 'Void element holding leftover data' });
        else if (!LEVEL1.has(el.id) && el.id !== ID.Void && el.id !== ID.CRC32) r.field('Container', `Element 0x${el.id.toString(16)}`, fmtBytes(el.end - el.start));
      } catch { r.field('Container', `Element 0x${el.id.toString(16)}`, 'Could not be decoded'); }
    }
    if (clusters) r.struct('Clusters', top.find((x) => x.id === ID.Cluster).offset, clusterBytes, `${clusters} clusters`);
    if (top.overflow) r.warn('A Matroska element runs past the end of its segment. The file is truncated.');
    else if (top.stop < end) r.warn('Part of the Matroska segment could not be read. The file may be damaged.');
    if (budget.n >= LIMIT.elements) r.warn('Too many Matroska elements. Inspection stopped early.');
    o = end;
    if (seg.overflow || seg.unknown) break;
  }
  if (!segments) { r.warn('The file has no Matroska segment. It is damaged.'); return; }
  if (!ctx.video && ctx.audio) r.category = 'Audio';
  const next = element(b, o, b.length);
  if (o < b.length && next && LEVEL1.has(next.id) && next.id !== ID.EBML) r.warn('Matroska elements follow the end of the segment. The file is damaged.');
  else if (o < b.length && hasCluster(b.u8, o)) r.warn('Cluster data follows the end of the segment. The file is damaged.');
  else if (o < b.length) {
    const rest = b.length - o;
    r.block('Trailer', o, rest, { decoded: false, note: 'Data after the last segment' });
    r.field('File', 'Data after the last segment', fmtBytes(rest), { flag: 'privacy' });
    r.signal('privacy', 'Hidden data after the media', `${fmtBytes(rest)} follow the last Matroska segment. Players do not show it.`, 'Matroska trailer', 'hidden data after the media');
  }
}

function hasCluster(u8, from) {
  for (let i = from; i + 4 <= u8.length; i++) if (u8[i] === 0x1f && u8[i + 1] === 0x43 && u8[i + 2] === 0xb6 && u8[i + 3] === 0x75) return true;
  return false;
}

function info(b, el, r, budget) {
  const src = 'Matroska info'; let scale = 1000000; let dur = 0;
  for (const c of children(b, el.start, el.end, budget)) {
    const at = [c.offset, c.end - c.offset];
    if (c.id === ID.TimestampScale) scale = uint(b, c);
    else if (c.id === ID.Duration) dur = float(b, c);
    else if (c.id === ID.SegmentUID) r.field('Container', 'Segment UID', hexOf(b, c));
    else if (c.id === ID.PrevUID || c.id === ID.NextUID) r.field('Container', c.id === ID.PrevUID ? 'Previous segment UID' : 'Next segment UID', hexOf(b, c));
    else if (c.id === ID.Title) { const v = str(b, c); r.block('Title', ...at, { container: 'Matroska Info Title' }); tag(r, src, 'Title', v || '(empty)', 'Description'); }
    else if (c.id === ID.DateUTC) {
      const raw = c.end - c.start === 8 ? Number(b.view.getBigInt64(c.start)) : 0;
      r.block('Date', ...at, { container: 'Matroska Info DateUTC' });
      tag(r, src, 'Date', isoDate(new Date(Date.UTC(2001, 0, 1) + raw / 1e6)) || 'Malformed', 'Dates', 'Muxed');
    } else if (c.id === ID.SegmentFilename || c.id === ID.PrevFilename || c.id === ID.NextFilename) {
      r.block('File name', ...at, { container: 'Matroska Info file name' });
      tag(r, src, { [ID.SegmentFilename]: 'Segment file name', [ID.PrevFilename]: 'Previous file name', [ID.NextFilename]: 'Next file name' }[c.id], str(b, c), 'File');
    } else if (c.id === ID.MuxingApp || c.id === ID.WritingApp) {
      const v = str(b, c);
      // Both are mandatory, so cleaning empties them instead of removing them. Only a non-empty value is a block.
      if (v) { r.block('Software', ...at, { container: `Matroska Info ${c.id === ID.MuxingApp ? 'MuxingApp' : 'WritingApp'}` }); tag(r, src, c.id === ID.MuxingApp ? 'Muxing application' : 'Writing application', v, 'Software'); }
    } else if (c.id === ID.Void && nonZero(b, c)) r.block('Padding', ...at, { container: 'Matroska Void', decoded: false });
  }
  if (dur) r.field('Container', 'Duration', duration((dur * scale) / 1e9));
}

function tracks(b, el, r, ctx, budget) {
  let n = 0;
  for (const t of children(b, el.start, el.end, budget)) {
    if (t.id === ID.Void && nonZero(b, t)) { r.block('Padding', t.offset, t.end - t.offset, { container: 'Matroska Void', decoded: false }); continue; }
    if (t.id !== ID.TrackEntry) continue;
    n++; const d = []; let type = 0;
    for (const c of children(b, t.start, t.end, budget)) {
      if (c.id === ID.TrackType) { type = uint(b, c); d.unshift(TRACK_TYPES[type] ?? `Type ${type}`); }
      else if (c.id === ID.CodecID) d.push(str(b, c));
      else if (c.id === ID.Language || c.id === ID.LanguageBCP47) { const v = str(b, c); if (v && v !== 'und') d.push(v); }
      else if (c.id === ID.CodecName) r.field('Container', `Track ${n} codec name`, str(b, c));
      else if (c.id === ID.Name) { r.block('Track name', c.offset, c.end - c.offset, { container: `Matroska track ${n} Name` }); tag(r, 'Matroska tracks', `Track ${n} name`, str(b, c) || '(empty)', 'Description'); }
      else if (c.id === ID.Video) {
        let w = 0; let h = 0;
        for (const v of children(b, c.start, c.end, budget)) { if (v.id === ID.PixelWidth) w = uint(b, v); else if (v.id === ID.PixelHeight) h = uint(b, v); }
        if (w && h) { d.push(`${w} × ${h}`); if (!ctx.video) { r.width = w; r.height = h; } }
        ctx.video = true;
      } else if (c.id === ID.Audio) {
        ctx.audio = true;
        for (const a of children(b, c.start, c.end, budget)) { if (a.id === ID.SamplingFrequency) d.push(`${Math.round(float(b, a))} Hz`); else if (a.id === ID.Channels) d.push(`${uint(b, a)} ch`); }
      } else if (c.id === ID.Void && nonZero(b, c)) r.block('Padding', c.offset, c.end - c.offset, { container: 'Matroska Void', decoded: false });
    }
    if (type === 1) ctx.video = true;
    r.field('Container', `Track ${n}`, d.join(' · '));
  }
}

function tags(b, el, r, budget) {
  const simple = (st, path, depth) => {
    let name = ''; let value = ''; const nested = [];
    for (const c of children(b, st.start, st.end, budget)) {
      if (c.id === ID.TagName) name = str(b, c);
      else if (c.id === ID.TagString) value = str(b, c);
      else if (c.id === ID.TagBinary) value = hexPreview(b.slice(c.start, c.end - c.start));
      else if (c.id === ID.SimpleTag) nested.push(c);
    }
    const key = [...path, name].filter(Boolean).join(' › ');
    if (value) {
      tag(r, 'Matroska tags', key, value, /^_STATISTICS/.test(name) ? null : groupOf(name));
      if (/LOCATION|GPS|COORDINATES/i.test(name)) { const p = iso6709(value); if (p) addLocation(r, p.lat, p.lon, p.alt, `Matroska tags ${name}`); }
    }
    if (depth < 8) for (const c of nested) simple(c, [...path, name], depth + 1);
  };
  for (const t of children(b, el.start, el.end, budget)) {
    if (t.id !== ID.Tag) continue;
    let target = '';
    for (const c of children(b, t.start, t.end, budget)) {
      if (c.id === ID.Targets) for (const x of children(b, c.start, c.end, budget)) { if (x.id === ID.TargetType) target = str(b, x); }
      else if (c.id === ID.SimpleTag) simple(c, target ? [target] : [], 0);
    }
  }
}

function attachments(b, el, r, ctx, budget) {
  let n = 0;
  for (const f of children(b, el.start, el.end, budget)) {
    if (f.id !== ID.AttachedFile) continue;
    n++; let name = ''; let mime = ''; let desc = ''; let data = null;
    for (const c of children(b, f.start, f.end, budget)) {
      if (c.id === ID.FileName) name = str(b, c);
      else if (c.id === ID.FileMimeType) mime = str(b, c);
      else if (c.id === ID.FileDescription) desc = str(b, c);
      else if (c.id === ID.FileData) data = c;
    }
    const size = data ? data.end - data.start : 0;
    r.block('Attachment', f.offset, f.end - f.offset, { container: `Matroska attachment ${n}`, note: [name, mime].filter(Boolean).join(', ') });
    r.field('Matroska attachments', `Attachment ${n}`, [name || 'unnamed', mime, fmtBytes(size), desc && `"${desc}"`].filter(Boolean).join(', '), { flag: 'privacy' });
    if (data && /^image\//i.test(mime)) ctx.covers.push([b.slice(data.start, size), `Attachment ${n}${name ? ` (${name})` : ''}`]);
    else if (!/font|truetype|opentype/i.test(mime)) r.signal('privacy', 'Embedded file stored', `The video carries an attached file${name ? ` named "${name}"` : ''}.`, 'Matroska attachments', 'an embedded file');
  }
}

function chapters(b, el, r, budget) {
  const titles = [];
  const atom = (a, depth) => {
    for (const c of children(b, a.start, a.end, budget)) {
      if (c.id === ID.ChapterDisplay) for (const s of children(b, c.start, c.end, budget)) { if (s.id === ID.ChapString && titles.length < 500) titles.push(str(b, s)); }
      else if (c.id === ID.ChapterAtom && depth < 8) atom(c, depth + 1);
    }
  };
  for (const e of children(b, el.start, el.end, budget)) if (e.id === ID.EditionEntry) atom(e, 0);
  r.field('Container', 'Chapters', titles.length ? titles.join('; ') : 'Present');
}

