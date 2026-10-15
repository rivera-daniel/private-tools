// Minimal DER/BER reading for certificates and signatures: X.509 names and validity, PKCS#7 and CMS
// certificate lists. Nothing here verifies a signature. All input is hostile.
import { latin1, utf8 } from '../bytes.js';

const MAX_DEPTH = 32;
const MAX_CHILDREN = 2000;

// Returns { tag, body, end } or null. Indefinite lengths (BER, used by some code signatures) are
// resolved by walking the children to the end-of-contents marker.
export function tlv(u8, o, end = u8.length, depth = 0) {
  if (o + 2 > end || depth > MAX_DEPTH) return null;
  const tag = u8[o];
  if ((tag & 0x1f) === 0x1f) return null;
  let len = u8[o + 1]; let body = o + 2;
  if (len === 0x80) {
    if (!(tag & 0x20)) return null;
    for (let p = body, n = 0; p + 2 <= end && n < MAX_CHILDREN; n++) {
      if (u8[p] === 0 && u8[p + 1] === 0) return { tag, body, end: p + 2, inner: p };
      const child = tlv(u8, p, end, depth + 1);
      if (!child) return null;
      p = child.end;
    }
    return null;
  }
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || body + n > end) return null;
    len = 0; for (let i = 0; i < n; i++) len = len * 256 + u8[body + i];
    body += n;
  }
  if (body + len > end) return null;
  return { tag, body, end: body + len, inner: body + len };
}

export function children(u8, node) {
  const out = [];
  if (!node) return out;
  for (let o = node.body; o < node.inner && out.length < MAX_CHILDREN;) {
    const c = tlv(u8, o, node.inner);
    if (!c) break;
    out.push(c); o = c.end;
  }
  return out;
}

export function oid(u8, node) {
  if (!node || node.tag !== 0x06 || node.inner - node.body > 64) return '';
  const parts = []; let v = 0;
  for (let i = node.body; i < node.inner; i++) {
    v = v * 128 + (u8[i] & 0x7f);
    if (!(u8[i] & 0x80)) { if (!parts.length) parts.push(Math.min(2, Math.floor(v / 40)), v - Math.min(2, Math.floor(v / 40)) * 40); else parts.push(v); v = 0; }
  }
  return parts.join('.');
}

export function text(u8, node) {
  if (!node) return '';
  const bytes = u8.subarray(node.body, node.inner);
  if (node.tag === 0x1e) { let s = ''; for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]); return s; }
  if (node.tag === 0x0c) return utf8.decode(bytes);
  return latin1(bytes);
}

const NAME_KEYS = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.5': 'serialNumber', '1.2.840.113549.1.9.1': 'E', '0.9.2342.19200300.100.1.1': 'UID' };

// X.509 Name: { CN, O, ... } plus a one-line form.
export function name(u8, node) {
  const out = {};
  for (const set of children(u8, node)) for (const pair of children(u8, set)) {
    const [k, v] = children(u8, pair);
    const key = NAME_KEYS[oid(u8, k)];
    if (key && v && !out[key]) out[key] = text(u8, v).slice(0, 300);
  }
  out.line = ['CN', 'O', 'OU', 'L', 'ST', 'C', 'E'].filter((k) => out[k]).map((k) => `${k}=${out[k]}`).join(', ');
  return out;
}

function time(u8, node) {
  if (!node || (node.tag !== 0x17 && node.tag !== 0x18)) return '';
  const s = latin1(u8.subarray(node.body, node.inner));
  const m = node.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?/.exec(s);
  if (!m) return s.slice(0, 40);
  const year = node.tag === 0x17 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
  return `${year}-${m[2]}-${m[3]} ${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ''} UTC`;
}

// Certificate -> { subject, issuer, notBefore, notAfter, serial } or null.
export function certificate(u8, node) {
  if (!node || node.tag !== 0x30) return null;
  const tbs = children(u8, node)[0];
  if (!tbs || tbs.tag !== 0x30) return null;
  const f = children(u8, tbs);
  const i = f[0]?.tag === 0xa0 ? 1 : 0;
  if (f.length < i + 6 || f[i].tag !== 0x02) return null;
  const validity = children(u8, f[i + 3]);
  return {
    serial: [...u8.subarray(f[i].body, f[i].inner)].map((x) => x.toString(16).padStart(2, '0')).join(''),
    issuer: name(u8, f[i + 2]), subject: name(u8, f[i + 4]),
    notBefore: time(u8, validity[0]), notAfter: time(u8, validity[1]),
  };
}

// PKCS#7 / CMS SignedData: the certificates it carries and the signer's certificate when it can be matched.
export function signedData(u8) {
  const info = tlv(u8, 0);
  const [type, wrapped] = children(u8, info);
  if (oid(u8, type) !== '1.2.840.113549.1.7.2') return null;
  const sd = children(u8, wrapped)[0];
  const parts = children(u8, sd);
  const certs = parts.filter((p) => p.tag === 0xa0).flatMap((p) => children(u8, p)).map((c) => certificate(u8, c)).filter(Boolean);
  const signerInfos = parts.at(-1)?.tag === 0x31 ? children(u8, parts.at(-1)) : [];
  let signer = null;
  const sid = children(u8, signerInfos[0])[1];
  if (sid?.tag === 0x30) {
    const serial = children(u8, sid)[1];
    const hex = serial ? [...u8.subarray(serial.body, serial.inner)].map((x) => x.toString(16).padStart(2, '0')).join('') : '';
    signer = certs.find((c) => c.serial === hex) ?? null;
  }
  // Without a match, the leaf is the certificate that issued no other.
  signer ??= certs.find((c) => !certs.some((o) => o !== c && o.issuer.line === c.subject.line)) ?? null;
  return { certs, signer };
}

// Kind of a DER blob that starts at offset 0, for files saved as .der, .cer, .p12 and .key.
export function derKind(u8) {
  const root = tlv(u8, 0);
  if (!root || root.tag !== 0x30 || root.end < u8.length - 2) return null;
  const f = children(u8, root);
  if (f.length < 2) return null;
  const intVal = (n) => (n?.tag === 0x02 && n.inner - n.body === 1 ? u8[n.body] : -1);
  if (intVal(f[0]) === 3 && f[1]?.tag === 0x30) return 'PKCS#12 bundle';
  if (intVal(f[0]) === 0 && f[1]?.tag === 0x30 && f[2]?.tag === 0x04) return 'PKCS#8 private key';
  if (intVal(f[0]) === 0 && f[1]?.tag === 0x02 && f.length >= 9) return 'RSA private key';
  if (intVal(f[0]) === 1 && f[1]?.tag === 0x04) return 'EC private key';
  if (f[1]?.tag === 0x30 && f[0]?.tag === 0x30 && certificate(u8, root)) return 'X.509 certificate';
  if (oid(u8, f[0]) === '1.2.840.113549.1.7.2') return 'PKCS#7 signature';
  return null;
}
