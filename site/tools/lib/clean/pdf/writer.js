// Writes PDF objects as one fresh revision with a classic cross-reference table.
import { Dict, Name, Str, Ref } from '../../metadata/pdf/syntax.js';

const REGULAR = new Uint8Array(256);
for (let c = 0x21; c <= 0x7e; c++) REGULAR[c] = 1;
for (const c of '()<>[]{}/%#') REGULAR[c.charCodeAt(0)] = 0;

function number(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return Object.is(n, -0) ? '0' : String(n);
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function name(s) {
  let out = '/';
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i) & 0xff; out += REGULAR[c] ? s[i] : `#${c.toString(16).padStart(2, '0')}`; }
  return out;
}

// String bytes are kept exactly. Anything outside printable ASCII is written as an octal escape.
function string(bytes) {
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

export function serialize(v, depth = 0) {
  if (depth > 128) throw new RangeError('objects are nested too deeply');
  if (v === null || v === undefined) return 'null';
  if (v === true || v === false) return String(v);
  if (typeof v === 'number') return number(v);
  if (v instanceof Name) return name(v.name);
  if (v instanceof Str) return string(v.bytes);
  if (v instanceof Ref) return `${v.num} ${v.gen} R`;
  if (Array.isArray(v)) return `[${v.map((x) => serialize(x, depth + 1)).join(' ')}]`;
  if (v instanceof Dict) { let out = '<<'; for (const [k, x] of v) out += `${name(k)} ${serialize(x, depth + 1)}`; return `${out}>>`; }
  return 'null';
}

const ascii = (s) => { const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; };
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

// objects[i] is object number i + 1: a value, or { dict, data } for a stream.
export function writePdf({ version = '1.7', objects, root, id }) {
  const parts = []; let at = 0;
  const push = (u8) => { parts.push(u8); at += u8.length; };
  push(ascii(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`));
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(at);
    if (o && o.data instanceof Uint8Array) {
      const dict = new Dict(o.dict); dict.set('Length', o.data.length);
      push(ascii(`${i + 1} 0 obj\n${serialize(dict)}\nstream\n`)); push(o.data); push(ascii('\nendstream\nendobj\n'));
    } else push(ascii(`${i + 1} 0 obj\n${serialize(o)}\nendobj\n`));
  });
  const xref = at;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const o of offsets) table += `${String(o).padStart(10, '0')} 00000 n\r\n`;
  push(ascii(`${table}trailer\n<</Size ${objects.length + 1}/Root ${root.num} 0 R/ID[<${hex(id)}><${hex(id)}>]>>\nstartxref\n${xref}\n%%EOF\n`));
  const out = new Uint8Array(at); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
