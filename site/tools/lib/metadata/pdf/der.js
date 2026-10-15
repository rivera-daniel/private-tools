// Just enough DER/BER to read who signed a PDF: certificate subjects and the signing time from a
// PKCS#7 / CMS SignedData blob. Nothing here checks a signature.
import { latin1, utf8, utf16 } from '../bytes.js';

const MAX_NODES = 20000;
const NAMES = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '1.2.840.113549.1.9.1': 'Email', '2.5.4.5': 'Serial number', '2.5.4.12': 'Title', '2.5.4.4': 'Surname', '2.5.4.42': 'Given name' };

function node(u8, pos, end, depth, budget) {
  if (depth > 32 || pos + 2 > end || --budget.n < 0) return null;
  const tag = u8[pos]; let p = pos + 1;
  if ((tag & 0x1f) === 0x1f) { while (p < end && u8[p] & 0x80) p++; p++; }
  if (p >= end) return null;
  let len = u8[p++];
  if (len === 0x80) {
    // Indefinite length (BER): children until an end-of-contents marker.
    if (!(tag & 0x20)) return null;
    let q = p;
    while (q + 2 <= end && !(u8[q] === 0 && u8[q + 1] === 0)) { const c = node(u8, q, end, depth + 1, budget); if (!c) return null; q = c.next; }
    return { tag, start: p, end: q, next: q + 2 };
  }
  if (len & 0x80) {
    const n = len & 0x7f; if (n > 4 || p + n > end) return null;
    len = 0; for (let i = 0; i < n; i++) len = len * 256 + u8[p++];
  }
  if (p + len > end) return null;
  return { tag, start: p, end: p + len, next: p + len };
}

function kids(u8, n, budget) {
  const out = []; let p = n.start;
  while (p < n.end && out.length < 1000) { const c = node(u8, p, n.end, 1, budget); if (!c) break; out.push(c); p = c.next; }
  return out;
}

function oid(u8, n) {
  const b = u8.subarray(n.start, n.end); if (!b.length) return '';
  const parts = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}

function str(u8, n) {
  const b = u8.subarray(n.start, n.end);
  if (n.tag === 0x0c) return utf8.decode(b);
  if (n.tag === 0x1e) return utf16(b, false);
  return latin1(b);
}

function time(u8, n) {
  const s = latin1(u8.subarray(n.start, n.end));
  const m = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(s);
  if (!m) return s;
  const year = m[1].length === 2 ? (Number(m[1]) < 50 ? `20${m[1]}` : `19${m[1]}`) : m[1];
  return `${year}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}${s.endsWith('Z') ? ' UTC' : ''}`;
}

function name(u8, n, budget) {
  const out = {};
  for (const set of kids(u8, n, budget)) for (const atv of kids(u8, set, budget)) {
    const [o, v] = kids(u8, atv, budget);
    if (!o || !v || o.tag !== 0x06) continue;
    const key = NAMES[oid(u8, o)]; if (!key) continue;
    out[key] = out[key] ? `${out[key]}, ${str(u8, v)}` : str(u8, v);
  }
  return out;
}

const hexOf = (u8, n) => [...u8.subarray(n.start, n.end)].map((x) => x.toString(16).padStart(2, '0')).join('');

function certificate(u8, cert, budget) {
  let parts = kids(u8, kids(u8, cert, budget)[0] ?? { start: 0, end: 0 }, budget);
  if (parts[0]?.tag === 0xa0) parts = parts.slice(1);
  const [serial, , issuer, validity, subject] = parts;
  if (!serial || !issuer || !subject) return null;
  const [from, to] = validity ? kids(u8, validity, budget) : [];
  return { serial: hexOf(u8, serial), issuer: name(u8, issuer, budget), subject: name(u8, subject, budget), notBefore: from ? time(u8, from) : '', notAfter: to ? time(u8, to) : '' };
}

// Returns { signer, certificates, signingTime } or null when the bytes are not a SignedData structure.
export function parseSignedData(u8) {
  const budget = { n: MAX_NODES };
  const top = node(u8, 0, u8.length, 0, budget);
  if (!top || top.tag !== 0x30) return null;
  const [type, content] = kids(u8, top, budget);
  if (!type || type.tag !== 0x06) {
    // A bare certificate (adbe.x509.rsa_sha1 keeps it in /Cert).
    const cert = certificate(u8, top, budget);
    return cert ? { signer: cert, certificates: [cert], signingTime: '' } : null;
  }
  if (oid(u8, type) !== '1.2.840.113549.1.7.2' || !content) return null;
  const sd = kids(u8, content, budget)[0]; if (!sd) return null;
  const parts = kids(u8, sd, budget);
  const certs = []; let signerInfos = null;
  for (const p of parts) {
    if (p.tag === 0xa0) for (const c of kids(u8, p, budget)) { const cert = certificate(u8, c, budget); if (cert) certs.push(cert); }
    if (p.tag === 0x31) signerInfos = p;
  }
  let signer = null; let signingTime = '';
  const info = signerInfos ? kids(u8, signerInfos, budget).at(-1) : null;
  if (info) {
    const fields = kids(u8, info, budget);
    const sid = fields[1];
    if (sid?.tag === 0x30) { const serial = kids(u8, sid, budget)[1]; if (serial) signer = certs.find((c) => c.serial === hexOf(u8, serial)) ?? null; }
    const attrs = fields.find((f) => f.tag === 0xa0);
    if (attrs) for (const a of kids(u8, attrs, budget)) {
      const [o, set] = kids(u8, a, budget);
      if (o?.tag === 0x06 && oid(u8, o) === '1.2.840.113549.1.9.5' && set) { const t = kids(u8, set, budget)[0]; if (t) signingTime = time(u8, t); }
    }
  }
  return { signer: signer ?? certs[0] ?? null, certificates: certs, signingTime };
}
