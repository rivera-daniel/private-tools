// Builds small PDF files in memory: classic or stream cross-references, object streams and
// incremental updates.
import { deflateSync } from 'node:zlib';

const bin = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'));

// A stream object: dict is the dictionary source without /Length, which is added.
export const stream = (dict, data, { flate = false } = {}) => ({ dict, data: bin(data), flate });

function body(v) {
  if (typeof v === 'string') return bin(v);
  const data = v.flate ? deflateSync(v.data) : v.data;
  const dict = v.dict.replace(/>>\s*$/, `${v.flate ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>`);
  return Buffer.concat([bin(`${dict}\nstream\n`), data, bin('\nendstream')]);
}

// objects: { num: source string or stream() }. trailer: extra trailer entries. hybrid writes a classic table
// that lists packed objects as free, with an /XRefStm stream that locates them.
export function pdf(objects, { trailer = '', version = '1.7', xrefStream = false, hybrid = false, packed = [], prefix = '' } = {}) {
  const parts = [bin(`${prefix}%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`)];
  let at = parts[0].length;
  const offsets = new Map(); const inStm = new Map();
  const push = (b) => { parts.push(b); at += b.length; };
  const nums = Object.keys(objects).map(Number).sort((a, b) => a - b);
  let size = Math.max(...nums) + 1;
  for (const n of nums) {
    if (packed.includes(n)) continue;
    offsets.set(n, at);
    push(Buffer.concat([bin(`${n} 0 obj\n`), body(objects[n]), bin('\nendobj\n')]));
  }
  if (packed.length) {
    const stm = size++; let head = ''; let data = '';
    packed.forEach((n, i) => { head += `${n} ${data.length} `; data += `${objects[n]}\n`; inStm.set(n, [stm, i]); });
    offsets.set(stm, at);
    push(Buffer.concat([bin(`${stm} 0 obj\n`), body(stream(`<< /Type /ObjStm /N ${packed.length} /First ${head.length} >>`, head + data, { flate: true })), bin('\nendobj\n')]));
  }
  let xrefStm = null;
  if (xrefStream || hybrid) {
    const xref = size++; offsets.set(xref, at); xrefStm = at;
    const rows = [];
    for (let n = 0; n < size; n++) {
      const row = Buffer.alloc(7);
      if (inStm.has(n)) { row[0] = 2; row.writeUInt32BE(inStm.get(n)[0], 1); row.writeUInt16BE(inStm.get(n)[1], 5); }
      else if (offsets.has(n)) { row[0] = 1; row.writeUInt32BE(offsets.get(n), 1); }
      rows.push(row);
    }
    // PNG "Up" predictor rows, as most writers produce.
    const predicted = []; let prev = Buffer.alloc(7);
    for (const row of rows) { const out = Buffer.alloc(8); out[0] = 2; for (let i = 0; i < 7; i++) out[i + 1] = (row[i] - prev[i]) & 0xff; predicted.push(out); prev = row; }
    const dict = `<< /Type /XRef /Size ${size} /W [1 4 2] /DecodeParms << /Predictor 12 /Columns 7 >> ${trailer} >>`;
    push(Buffer.concat([bin(`${xref} 0 obj\n`), body(stream(dict, Buffer.concat(predicted), { flate: true })), bin('\nendobj\n')]));
    if (!hybrid) { push(bin(`startxref\n${offsets.get(xref)}\n%%EOF\n`)); return Buffer.concat(parts); }
  }
  const xref = at;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) table += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 00000 f \n';
  push(bin(`${table}trailer\n<< /Size ${size} ${trailer}${xrefStm === null ? '' : ` /XRefStm ${xrefStm}`} >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

// Appends an incremental update that adds or replaces objects.
export function update(base, objects, trailer = '') {
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(base.toString('latin1'))[1]);
  const parts = [base]; let at = base.length; const offsets = new Map();
  for (const n of Object.keys(objects).map(Number).sort((a, b) => a - b)) {
    offsets.set(n, at);
    const b = Buffer.concat([bin(`${n} 0 obj\n`), body(objects[n]), bin('\nendobj\n')]);
    parts.push(b); at += b.length;
  }
  const size = Math.max(...offsets.keys(), Number(/\/Size (\d+)/.exec(base.toString('latin1'))[1]) - 1) + 1;
  let table = 'xref\n';
  for (const [n, o] of offsets) table += `${n} 1\n${String(o).padStart(10, '0')} 00000 n \n`;
  parts.push(bin(`${table}trailer\n<< /Size ${size} /Prev ${prev} ${trailer} >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

// Catalog 1, pages 2, page 3, content 4, font 5.
export function basic({ catalog = '', page = '', resources = '', content = 'BT /F1 12 Tf 72 720 Td (Hello world) Tj ET', extra = {} } = {}) {
  return {
    1: `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> ${resources} >> /Contents 4 0 R ${page} >>`,
    4: stream('<< >>', content),
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...extra,
  };
}

export const xmp = (inner) => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#" xmlns:xmp="http://ns.adobe.com/xap/1.0/">${inner}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

export const utf16 = (s) => `<FEFF${Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase()}>`;

// Minimal DER: a PKCS#7 SignedData with one certificate and a signing time.
const tlv = (tag, ...parts) => {
  const b = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const len = b.length < 128 ? [b.length] : b.length < 256 ? [0x81, b.length] : [0x82, b.length >> 8, b.length & 255];
  return Buffer.concat([Buffer.from([tag, ...len]), b]);
};
const oid = (s) => {
  const p = s.split('.').map(Number); const out = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) { const enc = [n & 0x7f]; let v = n >>> 7; while (v) { enc.unshift((v & 0x7f) | 0x80); v >>>= 7; } out.push(...enc); }
  return tlv(0x06, out);
};
const dn = (pairs) => tlv(0x30, ...pairs.map(([o, v]) => tlv(0x31, tlv(0x30, oid(o), tlv(0x0c, Buffer.from(v))))));
export function signedData({ cn, org, email, issuer = 'Example CA' }) {
  const subject = dn([['2.5.4.3', cn], ['2.5.4.10', org], ['1.2.840.113549.1.9.1', email]]);
  const iss = dn([['2.5.4.3', issuer]]);
  const serial = tlv(0x02, [0x12, 0x34]);
  const tbs = tlv(0x30, tlv(0xa0, tlv(0x02, [2])), serial, tlv(0x30, oid('1.2.840.113549.1.1.11')), iss, tlv(0x30, tlv(0x17, '250101000000Z'), tlv(0x17, '270101000000Z')), subject, tlv(0x30));
  const cert = tlv(0x30, tbs, tlv(0x30, oid('1.2.840.113549.1.1.11')), tlv(0x03, [0]));
  const attrs = tlv(0xa0, tlv(0x30, oid('1.2.840.113549.1.9.5'), tlv(0x31, tlv(0x17, '261001093000Z'))));
  const signer = tlv(0x30, tlv(0x02, [1]), tlv(0x30, iss, serial), tlv(0x30, oid('2.16.840.1.101.3.4.2.1')), attrs, tlv(0x30, oid('1.2.840.113549.1.1.1')), tlv(0x04, [1, 2, 3]));
  const sd = tlv(0x30, tlv(0x02, [1]), tlv(0x31), tlv(0x30, oid('1.2.840.113549.1.7.1')), tlv(0xa0, cert), tlv(0x31, signer));
  return tlv(0x30, oid('1.2.840.113549.1.7.2'), tlv(0xa0, sd));
}
