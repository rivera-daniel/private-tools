// Plain text: encoding detection and hidden Unicode. hiddenRuns() is the single definition of what is
// hidden and what is removable, shared by the inspector and the text cleaner so they always agree.

export const TEXT_LIMIT = 32 * 1024 * 1024;

// { text, encoding, bom, truncated } or null when the bytes do not read as text.
export function decodeText(u8) {
  if (!u8.length) return null;
  const truncated = u8.length > TEXT_LIMIT;
  let bytes = truncated ? u8.subarray(0, TEXT_LIMIT) : u8;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return utf16(bytes, bytes[0] === 0xff, true, truncated);
  const head = bytes.subarray(0, 4096);
  let oddZero = 0; let evenZero = 0;
  for (let i = 0; i + 1 < head.length; i += 2) { if (head[i] === 0) evenZero++; if (head[i + 1] === 0) oddZero++; }
  const pairs = head.length >> 1;
  if (pairs >= 2 && oddZero > pairs * 0.4 && evenZero === 0) return utf16(bytes, true, false, truncated);
  if (pairs >= 2 && evenZero > pairs * 0.4 && oddZero === 0) return utf16(bytes, false, false, truncated);
  // Cut a truncated read back to a character boundary.
  if (truncated) { let end = bytes.length; while (end > bytes.length - 4 && (bytes[end - 1] & 0xc0) === 0x80) end--; if (bytes[end - 1] >= 0xc0) end--; bytes = bytes.subarray(0, end); }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text; let encoding = 'UTF-8';
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch {
    // Legacy single-byte text: no NUL and mostly ASCII.
    let high = 0; for (const x of head) if (x >= 0x80) high++;
    if (high > head.length * 0.3) return null;
    text = new TextDecoder('windows-1252').decode(bytes); encoding = 'Windows-1252';
  }
  if (!plausible(text)) return null;
  return { text, encoding, bom, truncated };
}

function utf16(bytes, le, bom, truncated) {
  const body = bytes.subarray(0, bytes.length & ~1);
  let text;
  try { text = new TextDecoder(le ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(body); } catch { return null; }
  if (!plausible(text)) return null;
  return { text, encoding: le ? 'UTF-16LE' : 'UTF-16BE', bom, truncated };
}

// Text has no NUL and few control characters (escape sequences in logs are allowed).
function plausible(text) {
  let control = 0; const n = Math.min(text.length, 65536);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return false;
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 11 && c !== 0x1b) || c === 0x7f) control++;
  }
  return control <= n * 0.01;
}

const PICTO = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{20E3}]/u;
const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Mongolian}\p{Script=Nko}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Hebrew}\p{Script=Tibetan}\p{Script=Inherited}]/u;
const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const INVISIBLE = /[\u200c\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;
const isVs = (c) => (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef);

export const HIDDEN_KINDS = {
  zw: 'Zero-width characters', bidi: 'Text direction controls', tag: 'Tag characters', vs: 'Variation selector runs',
  filler: 'Invisible filler characters', bom: 'Byte order mark', space: 'Unusual spaces', shy: 'Soft hyphens', control: 'Control characters',
};

// Every hidden or unusual character: { at (string index), end, cp, kind, removable }.
// Removability depends only on neighbours that are never removed themselves, so one pass is a fixed point.
export function hiddenRuns(text, { encoding = 'UTF-8', limit = 200000 } = {}) {
  const out = [];
  const cps = [];
  for (let i = 0; i < text.length;) { const cp = text.codePointAt(i); cps.push([cp, i]); i += cp > 0xffff ? 2 : 1; }
  const rtl = RTL.test(text);
  const ch = (k) => (k >= 0 && k < cps.length ? String.fromCodePoint(cps[k][0]) : '');
  // Neighbours count only when they stay: a joiner next to a character that is itself removed is not legitimate.
  const gone = new Set();
  const push = (k, kind, removable) => { if (removable) gone.add(k); if (out.length < limit) out.push({ at: cps[k][1], end: cps[k][1] + (cps[k][0] > 0xffff ? 2 : 1), cp: cps[k][0], kind, removable }); };
  const joining = (k) => !gone.has(k) && JOINING.test(ch(k)) && !INVISIBLE.test(ch(k));
  for (let k = 0; k < cps.length; k++) {
    const c = cps[k][0];
    if (c === 0xfeff && k === 0) push(k, 'bom', !encoding.startsWith('UTF-16'));
    // XMP packets open with begin="U+FEFF" as an encoding marker.
    else if (c === 0xfeff && /begin=["']$/.test(text.slice(Math.max(0, cps[k][1] - 7), cps[k][1]))) push(k, 'bom', false);
    else if (c === 0x200b || c === 0xfeff || c === 0x2060 || (c >= 0x2061 && c <= 0x2064) || c === 0x180e) push(k, 'zw', true);
    else if (c === 0x200c || c === 0x200d) {
      const prev = ch(k - 1); const next = ch(k + 1);
      const legit = (c === 0x200d && !gone.has(k - 1) && PICTO.test(prev) && /\p{Extended_Pictographic}/u.test(next)) || (joining(k - 1) && joining(k + 1));
      push(k, 'zw', !legit);
    } else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) push(k, 'bidi', true);
    else if (c === 0x200e || c === 0x200f || c === 0x061c) push(k, 'bidi', !rtl);
    else if (c >= 0xe0000 && c <= 0xe007f) {
      // Subdivision flags: black flag, tag letters, cancel tag.
      let s = k; while (s > 0 && cps[s - 1][0] >= 0xe0020 && cps[s - 1][0] <= 0xe007e) s--;
      let e = k; while (e < cps.length && cps[e][0] >= 0xe0020 && cps[e][0] <= 0xe007e) e++;
      const legit = s > 0 && cps[s - 1][0] === 0x1f3f4 && e < cps.length && cps[e][0] === 0xe007f && e - s <= 7;
      push(k, 'tag', !legit);
    } else if (isVs(c)) {
      // One selector after a character is normal. A run of them carries hidden bytes.
      const runStart = isVs(cps[k - 1]?.[0] ?? 0);
      const runNext = isVs(cps[k + 1]?.[0] ?? 0);
      if (runStart || runNext) {
        let s = k; while (s > 0 && isVs(cps[s - 1][0])) s--;
        const keepFirst = (cps[s][0] === 0xfe0e || cps[s][0] === 0xfe0f) && s > 0 && PICTO.test(ch(s - 1));
        if (!(keepFirst && s === k)) push(k, 'vs', true);
      }
    } else if (c === 0x3164 || c === 0xffa0 || c === 0x115f || c === 0x1160) push(k, 'filler', !(HANGUL.test(ch(k - 1)) || HANGUL.test(ch(k + 1))));
    else if (c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) push(k, 'space', false);
    else if (c === 0x00ad) push(k, 'shy', false);
    else if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f)) push(k, 'control', false);
  }
  return out;
}

// Hidden text carried by tag characters (each maps to an ASCII character) and by variation selector
// runs (each selector maps to one byte).
export function decodeHidden(text, runs) {
  let tags = ''; const bytes = [];
  for (const r of runs) {
    if (r.kind === 'tag' && r.cp >= 0xe0020 && r.cp <= 0xe007e) tags += String.fromCharCode(r.cp - 0xe0000);
    if (r.kind === 'vs') bytes.push(r.cp <= 0xfe0f ? r.cp - 0xfe00 : r.cp - 0xe0100 + 16);
  }
  const vs = bytes.length >= 4 ? new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes)) : '';
  return { tags: tags.trim(), selectors: /^[\x20-\x7e\s -￿]*$/.test(vs) && !vs.includes('�') ? vs.trim() : '' };
}

export function encodeText(text, encoding) {
  if (encoding === 'UTF-8') return new TextEncoder().encode(text);
  if (encoding === 'Windows-1252') return null;
  const out = new Uint8Array(text.length * 2); const le = encoding === 'UTF-16LE';
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 * i + (le ? 0 : 1)] = c & 0xff; out[2 * i + (le ? 1 : 0)] = c >> 8; }
  return out;
}

const encodedLength = (s, encoding) => (encoding.startsWith('UTF-16') ? s.length * 2 : new TextEncoder().encode(s).length);

// Removes every removable hidden character and keeps all other content and the encoding. The UTF-16
// byte order mark stays: without it many readers mistake the encoding.
// Returns { data, removed: [{ kind, count, bytes }], encoding } or null when the bytes are not text.
export function cleanText(u8) {
  const decoded = decodeText(u8);
  if (!decoded || decoded.truncated || decoded.encoding === 'Windows-1252') return decoded && !decoded.truncated ? { data: u8, removed: [], encoding: decoded.encoding } : null;
  const { encoding } = decoded;
  let text = decoded.bom && encoding.startsWith('UTF-16') ? `﻿${decoded.text}` : decoded.text;
  const totals = new Map();
  for (let pass = 0; pass < 4; pass++) {
    const runs = hiddenRuns(text, { encoding, limit: Infinity }).filter((r) => r.removable);
    if (!runs.length) break;
    let out = ''; let at = 0;
    for (const r of runs) {
      out += text.slice(at, r.at); at = r.end;
      const t = totals.get(r.kind) ?? { kind: HIDDEN_KINDS[r.kind], count: 0, bytes: 0 };
      t.count++; t.bytes += encodedLength(text.slice(r.at, r.end), encoding); totals.set(r.kind, t);
    }
    text = out + text.slice(at);
  }
  if (!totals.size) return { data: u8, removed: [], encoding };
  return { data: encodeText(text, encoding), removed: [...totals.values()], encoding };
}

// Words that mix Latin letters with look-alike Cyrillic or Greek letters, a common spoofing trick.
export function mixedScriptWords(text, max = 10) {
  const found = new Set(); let count = 0;
  const re = /[\p{L}\p{M}]{2,40}/gu; let m;
  const sample = text.length > 4000000 ? text.slice(0, 4000000) : text;
  while ((m = re.exec(sample))) {
    const w = m[0];
    if (/\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w)) { count++; if (found.size < max) found.add(w); }
  }
  return { count, samples: [...found] };
}

// Kind of text from content first, then the extension.
export function textKind(text, ext) {
  const head = text.slice(0, 4096).replace(/^﻿/, '').trimStart();
  if (/^-----BEGIN [A-Z0-9 ]+-----/m.test(head)) return 'PEM';
  if (/^BEGIN:VCARD/i.test(head)) return 'vCard contacts';
  if (/^BEGIN:VCALENDAR/i.test(head)) return 'iCalendar';
  if (/^PuTTY-User-Key-File-/.test(head)) return 'PuTTY key';
  if (/^(Received|Return-Path|From|Message-ID|Delivered-To|MIME-Version):/im.test(head.slice(0, 600)) && /^(From|To|Subject|Date):/im.test(head)) return 'Email message';
  if (/^<!doctype html|^<html[\s>]/i.test(head)) return 'HTML';
  if (/^<\?xml|^<[A-Za-z_][\w.-]*[\s>]/.test(head) && /<\/[A-Za-z]|\/>/.test(head)) return /plist/i.test(head.slice(0, 400)) ? 'Property list (XML)' : 'XML';
  if (/^#!/.test(head)) return 'Script';
  if (/^[[{]/.test(head) && (ext === 'json' || /^[[{]\s*["[{\]}]/.test(head))) return 'JSON';
  const known = { csv: 'CSV', tsv: 'TSV', md: 'Markdown', markdown: 'Markdown', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'Settings', cfg: 'Settings', conf: 'Settings', env: 'Environment settings', log: 'Log', srt: 'Subtitles', vtt: 'Subtitles', sql: 'SQL', svg: 'SVG' };
  if (known[ext]) return known[ext];
  if (/^(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|c|h|cc|cpp|hpp|cs|java|kt|swift|php|pl|sh|bash|zsh|ps1|bat|cmd|css|scss|lua)$/.test(ext)) return 'Source code';
  return 'Plain text';
}

export function lineCol(text, index) {
  let line = 1; let last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) { line++; last = i; }
  return `line ${line}, column ${index - last}`;
}
