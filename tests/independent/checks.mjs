// Reference checks on a cleaned file. None of them use the site's parsers: they run external tools or
// read the bytes with code written here. Each returns { status: 'pass' | 'fail' | 'skip', detail }.
import { writeFileSync } from 'node:fs';
import { run } from './tools.mjs';
import { findSecrets, zipLocalEntries } from './scan.mjs';
import { exiftoolLeftovers, FFPROBE_ALLOW } from './allow.mjs';

const MEDIA = new Set(['mp4', 'mpeg', 'wav', 'aiff', 'flac', 'ogg', 'mkv']);
const ZIPS = new Set(['ooxml', 'odf', 'epub', 'zip']);
const pass = (detail = '') => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });
const skip = (detail) => ({ status: 'skip', detail });

// Planted strings: every one must be in the input (otherwise the corpus is broken) and none in the output.
function secrets({ item, input, output }) {
  if (item.hiddenText) return hiddenText(input, output);
  const all = [...item.secrets, ...item.policy];
  if (!all.length) return skip('no planted strings');
  const before = new Set(findSecrets(input, all).map((h) => h.secret));
  const unplanted = all.filter((s) => !before.has(s));
  const hits = findSecrets(output, all);
  const leaked = new Map();
  for (const h of hits) if (!leaked.has(h.secret)) leaked.set(h.secret, h);
  const failed = item.secrets.filter((s) => leaked.has(s)).map((s) => `${s} (${leaked.get(s).encoding} in ${leaked.get(s).where})`);
  const kept = item.policy.filter((s) => leaked.has(s)).map((s) => `${s} (${leaked.get(s).where})`);
  const notes = [];
  if (kept.length) notes.push(`kept, product decision: ${kept.join(', ')}`);
  if (unplanted.length) return fail(`planting failed, not found in the input: ${unplanted.join(', ')}${failed.length ? `; leaked: ${failed.join(', ')}` : ''}`);
  if (failed.length) return { status: 'fail', detail: `leaked: ${failed.join(', ')}${notes.length ? `; ${notes.join('; ')}` : ''}`, policy: kept };
  return { status: 'pass', detail: `${item.secrets.length} absent${notes.length ? `; ${notes.join('; ')}` : ''}`, policy: kept };
}

// Text files: the secret is the hidden characters themselves.
const HIDDEN = /[\p{Cf}]|[︀-️\u{e0100}-\u{e01ef}]{2,}/gu;
function hiddenText(input, output) {
  const count = (u8) => (Buffer.from(u8).toString('utf8').match(HIDDEN) ?? []).length;
  const before = count(input); const after = count(output);
  if (!before) return fail('planting failed: no hidden characters in the input');
  if (after) return fail(`${after} hidden characters or variation selector runs left (input had ${before})`);
  return pass(`${before} hidden characters removed`);
}

const ARCHIVE_ZIP = /Install Archive::Zip/;
async function exiftool({ item, inPath, outPath, et }) {
  if (!et) return skip('ExifTool not found');
  const [a, b] = [await et.read(inPath), await et.read(outPath)];
  const warnings = (t) => Object.entries(t).filter(([k]) => /^ExifTool:(Warning|Error)/.test(k)).map(([, v]) => String(v));
  const wa = warnings(a.tags); const wb = warnings(b.tags);
  if (ZIPS.has(item.family) && [...wa, ...wb].some((w) => ARCHIVE_ZIP.test(w))) return skip('ExifTool cannot read ZIP contents without Archive::Zip (set PERL5LIB)');
  if (wb.includes('Unknown file type')) return skip('ExifTool does not recognise this format once its tags are gone');
  const { left, policy } = exiftoolLeftovers(item.family, b.tags);
  const control = exiftoolLeftovers(item.family, a.tags).left;
  const fresh = wb.filter((w) => !wa.includes(w));
  const kept = policy.length ? `; kept, product decision: ${policy.join('; ')}` : '';
  if (left.length) return fail(`leftover tags: ${left.join('; ')}${kept}`);
  if (fresh.length) return fail(`new ExifTool warnings: ${fresh.join('; ')}`);
  if (!control.length && item.secrets.length && item.exiftoolControl !== false) return fail('control failed: ExifTool reports no metadata in the input either');
  return pass(`${control.length} tags before, none after${kept}`);
}

function ffprobeJson(tools, path) {
  const r = run(tools.ffprobe.cmd[0], ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', path]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.toString()); } catch { return null; }
}

// Empty values carry nothing and pass. In MP4 the stream "encoder" tag is the compressor name in the
// sample description, and a "text" data stream is the chapter track; both are reported, not failed.
function ffprobeLeftovers(j, family) {
  const out = []; const notes = [];
  const chapterTrack = (s) => family === 'mp4' && s.codec_type === 'data' && s.codec_tag_string === 'text' && (j.chapters ?? []).length > 0;
  for (const [k, v] of Object.entries(j.format?.tags ?? {})) if (v !== '' && !FFPROBE_ALLOW.format.has(k.toLowerCase())) out.push(`format ${k}=${v}`);
  for (const s of j.streams ?? []) {
    if (s.codec_type === 'attachment') out.push(`attachment stream ${s.index} (${s.tags?.filename ?? s.codec_name})`);
    if (s.codec_type === 'data') (chapterTrack(s) ? notes : out).push(`data stream ${s.index} (${s.codec_tag_string})`);
    if (s.disposition?.attached_pic) out.push(`cover art stream ${s.index}`);
    for (const [k, v] of Object.entries(s.tags ?? {})) {
      if (v === '') continue;
      if (FFPROBE_ALLOW.stream.has(k.toLowerCase())) { if (k === 'handler_name' && /PTsec/.test(v)) notes.push(`stream ${s.index} handler_name=${v}`); continue; }
      if (family === 'mp4' && k === 'encoder') { notes.push(`stream ${s.index} compressor name ${v}`); continue; }
      out.push(`stream ${s.index} ${k}=${v}`);
    }
  }
  for (const c of j.chapters ?? []) notes.push(`chapter ${c.id}${c.tags?.title ? ` "${c.tags.title}"` : ''}`);
  return { out, notes };
}

function ffprobe({ item, inPath, outPath, tools }) {
  if (!MEDIA.has(item.family)) return null;
  if (!tools.ffprobe) return skip('ffprobe not found');
  const a = ffprobeJson(tools, inPath); const b = ffprobeJson(tools, outPath);
  if (!a && !b) return skip('ffprobe cannot read this synthetic file');
  if (a && !b) return fail('ffprobe reads the input but not the output');
  const { out, notes } = ffprobeLeftovers(b, item.family);
  if (out.length) return fail(`leftover: ${out.join('; ')}`);
  const control = a ? ffprobeLeftovers(a, item.family).out.length : 0;
  return pass(`${control} tags or extra streams before, none after${notes.length ? `; kept, product decision: ${notes.join(', ')}` : ''}`);
}

function decodeErrors(tools, path) {
  const r = run(tools.ffmpeg.cmd[0], ['-v', 'error', '-i', path, '-map', '0:V?', '-map', '0:a?', '-f', 'null', '-'], { timeout: 120000 });
  return r.status === 0 ? r.stderr.split('\n').filter(Boolean) : [`exit ${r.status}: ${r.stderr.trim().split('\n').at(-1)}`];
}

function decode({ item, inPath, outPath, tools }) {
  if (!MEDIA.has(item.family)) return null;
  if (!tools.ffmpeg) return skip('ffmpeg not found');
  const a = decodeErrors(tools, inPath); const b = decodeErrors(tools, outPath);
  if (!b.length) return pass(a.length ? `clean decode (input had ${a.length} errors)` : 'clean decode');
  if (a.length && b.length <= a.length) return skip(`synthetic samples do not decode (input ${a.length} errors, output ${b.length})`);
  return fail(`decode errors after cleaning: ${b.slice(0, 3).join(' | ')}`);
}

// Per-packet MD5 of every audio and video stream, copied without decoding. Stream numbers are dropped,
// because removing a cover or metadata track renumbers the rest.
function packetHashes(tools, path) {
  const r = run(tools.ffmpeg.cmd[0], ['-v', 'error', '-i', path, '-map', '0:V?', '-map', '0:a?', '-c', 'copy', '-f', 'framemd5', '-'], { timeout: 120000 });
  if (r.status !== 0) return null;
  const lines = r.stdout.toString().split('\n').filter((l) => l && !l.startsWith('#'));
  return lines.map((l) => l.split(',').map((x) => x.trim()));
}

function packets({ item, inPath, outPath, tools }) {
  if (!MEDIA.has(item.family)) return null;
  if (!tools.ffmpeg) return skip('ffmpeg not found');
  if (item.packetReference) { inPath = `${inPath}.reference`; writeFileSync(inPath, item.packetReference); }
  const a = packetHashes(tools, inPath); const b = packetHashes(tools, outPath);
  if (!a && !b) return skip('ffmpeg cannot demux this synthetic file');
  if (!a || !b) return fail(`ffmpeg demuxes only the ${a ? 'input' : 'output'}`);
  if (!a.length) return skip('no audio or video packets');
  const key = (rows) => { const per = new Map(); for (const [s, , , , size, hash] of rows) { if (!per.has(s)) per.set(s, []); per.get(s).push(`${size}:${hash}`); } return [...per.values()].map((v) => v.join(' ')); };
  const ka = key(a); const kb = key(b);
  if (ka.length !== kb.length) return fail(`${ka.length} streams before, ${kb.length} after`);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return fail(`stream ${i} packets differ (re-encoded or damaged)`);
  const timing = (rows) => rows.map(([s, dts, pts, dur]) => `${s}:${dts}:${pts}:${dur}`).join(' ');
  return pass(`${a.length} packets identical${timing(a) === timing(b) ? '' : ' (timestamps changed)'}`);
}

function qpdf({ item, outPath, tools }) {
  if (item.family !== 'pdf') return null;
  if (!tools.qpdf) return skip('qpdf not found');
  const r = run(tools.qpdf.cmd[0], ['--check', outPath]);
  if (r.status === 0) return pass('no errors or warnings');
  return fail(`exit ${r.status}: ${(r.stdout.toString() + r.stderr).split('\n').filter((l) => /WARNING|ERROR|error/i.test(l)).slice(0, 4).join(' | ')}`);
}

const PDFINFO_ALLOW = new Set(['Custom Metadata', 'Metadata Stream', 'Tagged', 'UserProperties', 'Suspects', 'Form', 'JavaScript', 'Pages', 'Encrypted', 'Page size', 'Page rot', 'File size', 'Optimized', 'PDF version']);
function pdfinfo({ item, inPath, outPath, tools }) {
  if (item.family !== 'pdf') return null;
  if (!tools.pdfinfo) return skip('pdfinfo not found');
  const fields = (path) => {
    const r = run(tools.pdfinfo.cmd[0], [path]);
    const m = new Map();
    for (const l of r.stdout.toString().split('\n')) { const at = l.indexOf(':'); if (at > 0) m.set(l.slice(0, at).trim(), l.slice(at + 1).trim()); }
    return { ok: r.status === 0, m, meta: run(tools.pdfinfo.cmd[0], ['-meta', path]).stdout.toString().trim() };
  };
  const a = fields(inPath); const b = fields(outPath);
  if (!b.ok) return fail('pdfinfo cannot read the output');
  const bad = [...b.m].filter(([k, v]) => !PDFINFO_ALLOW.has(k) || (['Custom Metadata', 'Metadata Stream', 'JavaScript'].includes(k) && v !== 'no')).map(([k, v]) => `${k}: ${v}`);
  if (b.meta) bad.push(`XMP: ${b.meta.slice(0, 60)}`);
  if (bad.length) return fail(bad.join('; '));
  const control = [...a.m].filter(([k, v]) => !PDFINFO_ALLOW.has(k) || (['Custom Metadata', 'Metadata Stream', 'JavaScript'].includes(k) && v !== 'no')).length + (a.meta ? 1 : 0);
  return pass(`${control} info fields before, none after`);
}

function pdfsig({ item, outPath, tools }) {
  if (item.family !== 'pdf') return null;
  if (!tools.pdfsig) return skip('pdfsig not found');
  const r = run(tools.pdfsig.cmd[0], [outPath]);
  const text = r.stdout.toString() + r.stderr;
  if (/does not contain any signatures/.test(text)) return pass('no signatures');
  if (/Signature #\d/.test(text)) return fail(`signatures left: ${text.split('\n').filter((l) => /Signer|Signature #/.test(l)).join(' | ')}`);
  return fail(`unexpected pdfsig output: ${text.trim().split('\n')[0]}`);
}

function pdfdetach({ item, outPath, tools }) {
  if (item.family !== 'pdf') return null;
  if (!tools.pdfdetach) return skip('pdfdetach not found');
  const r = run(tools.pdfdetach.cmd[0], ['-list', outPath]);
  const m = /^(\d+) embedded files/m.exec(r.stdout.toString());
  if (m && m[1] === '0') return pass('no attachments');
  return fail(m ? `${m[1]} attachments left` : `unexpected pdfdetach output: ${(r.stdout.toString() + r.stderr).trim().split('\n')[0]}`);
}

// ZIP structure read from the bytes: end record, central directory and every local header.
function zipStructure({ item, output }) {
  if (!ZIPS.has(item.family)) return null;
  const u8 = Buffer.from(output);
  let eocd = -1;
  for (let o = u8.length - 22; o >= Math.max(0, u8.length - 22 - 65535); o--) if (u8.readUInt32LE(o) === 0x06054b50) { eocd = o; break; }
  if (eocd < 0) return fail('no end of central directory record');
  const problems = [];
  const count = u8.readUInt16LE(eocd + 10); const cdSize = u8.readUInt32LE(eocd + 12); const cdOffset = u8.readUInt32LE(eocd + 16); const commentLen = u8.readUInt16LE(eocd + 20);
  if (commentLen) problems.push(`archive comment (${commentLen} bytes)`);
  if (eocd + 22 + commentLen !== u8.length) problems.push(`${u8.length - eocd - 22 - commentLen} bytes after the archive`);
  const offsets = new Set();
  let first = Infinity;
  for (let i = 0, o = cdOffset; i < count; i++) {
    if (o + 46 > u8.length || u8.readUInt32LE(o) !== 0x02014b50) { problems.push(`central entry ${i} missing`); break; }
    const time = u8.readUInt16LE(o + 12); const date = u8.readUInt16LE(o + 14);
    const nl = u8.readUInt16LE(o + 28); const xl = u8.readUInt16LE(o + 30); const cl = u8.readUInt16LE(o + 32); const local = u8.readUInt32LE(o + 42);
    const name = u8.toString('utf8', o + 46, o + 46 + nl);
    if (date !== 0x21 || time !== 0) problems.push(`${name}: time not 1980-01-01`);
    if (xl) problems.push(`${name}: central extra field`);
    if (cl) problems.push(`${name}: entry comment`);
    offsets.add(local); first = Math.min(first, local);
    if (u8.readUInt32LE(local) !== 0x04034b50) problems.push(`${name}: no local header at ${local}`);
    else {
      const lnl = u8.readUInt16LE(local + 26); const lxl = u8.readUInt16LE(local + 28);
      if (u8.toString('utf8', local + 30, local + 30 + lnl) !== name) problems.push(`${name}: local name differs`);
      if (lxl) problems.push(`${name}: local extra field`);
      if (u8.readUInt16LE(local + 12) !== 0x21 || u8.readUInt16LE(local + 10) !== 0) problems.push(`${name}: local time not 1980-01-01`);
    }
    o += 46 + nl + xl + cl;
  }
  if (count && first !== 0) problems.push(`${first} bytes before the first entry`);
  if (cdOffset + cdSize !== eocd) problems.push('gap between central directory and end record');
  const orphans = zipLocalEntries(u8).filter((e) => !offsets.has(e.offset) && e.offset < cdOffset);
  if (orphans.length) problems.push(`local entries outside the directory: ${orphans.map((e) => e.name).join(', ')}`);
  return problems.length ? fail(problems.slice(0, 8).join('; ')) : pass(`${count} entries, no times, extras or comments`);
}

const PY_ZIP = String.raw`
import sys, zipfile, json, xml.etree.ElementTree as ET
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
problems = []
if bad: problems.append('CRC error in ' + bad)
xmlish = ('.xml', '.rels', '.opf', '.ncx', '.xhtml', '.svg', '.htm', '.html')
checked = 0
for i in z.infolist():
    if i.filename.lower().endswith(xmlish) and not i.filename.endswith('/'):
        data = z.read(i)
        if i.filename.lower().endswith(('.htm', '.html')) and not data.lstrip().startswith(b'<?xml'): continue
        checked += 1
        try: ET.fromstring(data)
        except ET.ParseError as e: problems.append(i.filename + ': ' + str(e))
print(json.dumps({'problems': problems, 'checked': checked, 'entries': len(z.infolist())}))
`;
function zipPython({ item, outPath, tools }) {
  if (!ZIPS.has(item.family)) return null;
  if (!tools.python) return skip('Python not found');
  const r = run(tools.python.cmd[0], ['-c', PY_ZIP, outPath]);
  if (r.status !== 0) return fail(`Python zipfile: ${r.stderr.trim().split('\n').at(-1)}`);
  const j = JSON.parse(r.stdout.toString());
  return j.problems.length ? fail(j.problems.slice(0, 5).join('; ')) : pass(`testzip ok, ${j.checked} XML parts well-formed`);
}

export const CHECKS = [
  ['secrets', secrets], ['exiftool', exiftool], ['ffprobe', ffprobe], ['decode', decode], ['packets', packets],
  ['qpdf', qpdf], ['pdfinfo', pdfinfo], ['pdfsig', pdfsig], ['pdfdetach', pdfdetach], ['zip', zipStructure], ['zipfile+xml', zipPython],
];
