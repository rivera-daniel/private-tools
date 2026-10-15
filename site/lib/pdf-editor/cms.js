// X.509 certificates and CMS SignedData (RFC 5652) for PDF signatures: building a detached CAdES-style
// signature, and reading and checking signatures made by any software. Cryptography runs in WebCrypto.
// Nothing here goes to the network: no revocation checks, no timestamps, no fetching of missing certificates.
import { parse, oidOf, bitsOf, octetsOf, stringOf, timeOf, uintBytes, intOf, Asn1Error, seq, set, oid, int, octets, nullValue, explicit, implicit, tlv, concat, compareBytes, ecdsaDerToRaw, ecdsaRawToDer, toHex, bits } from './asn1.js';

export { Asn1Error };

export const OID = {
  data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5',
  signingCertificate: '1.2.840.113549.1.9.16.2.12', signingCertificateV2: '1.2.840.113549.1.9.16.2.47', timeStampToken: '1.2.840.113549.1.9.16.2.14',
  rsaEncryption: '1.2.840.113549.1.1.1', rsaPss: '1.2.840.113549.1.1.10', mgf1: '1.2.840.113549.1.1.8',
  ecPublicKey: '1.2.840.10045.2.1', p256: '1.2.840.10045.3.1.7', p384: '1.3.132.0.34', p521: '1.3.132.0.35',
  sha1: '1.3.14.3.2.26', sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3',
};

const HASH_OID = { 'SHA-1': OID.sha1, 'SHA-256': OID.sha256, 'SHA-384': OID.sha384, 'SHA-512': OID.sha512 };
const HASH_NAME = Object.fromEntries(Object.entries(HASH_OID).map(([k, v]) => [v, k]));
const HASH_SIZE = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 };
const RSA_SIG = { '1.2.840.113549.1.1.5': 'SHA-1', '1.2.840.113549.1.1.11': 'SHA-256', '1.2.840.113549.1.1.12': 'SHA-384', '1.2.840.113549.1.1.13': 'SHA-512', '1.2.840.113549.1.1.14': 'SHA-224' };
const ECDSA_SIG = { '1.2.840.10045.4.1': 'SHA-1', '1.2.840.10045.4.3.2': 'SHA-256', '1.2.840.10045.4.3.3': 'SHA-384', '1.2.840.10045.4.3.4': 'SHA-512' };
const RSA_SIG_OID = Object.fromEntries(Object.entries(RSA_SIG).map(([k, v]) => [v, k]));
const ECDSA_SIG_OID = Object.fromEntries(Object.entries(ECDSA_SIG).map(([k, v]) => [v, k]));
const CURVES = { [OID.p256]: 'P-256', [OID.p384]: 'P-384', [OID.p521]: 'P-521' };
const CURVE_SIZE = { 'P-256': 32, 'P-384': 48, 'P-521': 66 };

// The signer algorithms this tool produces and the digest each one uses.
export const ALGORITHMS = { 'RSASSA-PKCS1-v1_5': 'SHA-256', 'RSA-PSS': 'SHA-256', 'ECDSA-P256': 'SHA-256', 'ECDSA-P384': 'SHA-384' };
export const hashFor = (algorithm) => { const h = ALGORITHMS[algorithm]; if (!h) throw new Error(`Unsupported signature algorithm ${algorithm}.`); return h; };

export async function digest(hash, data) { return new Uint8Array(await crypto.subtle.digest(hash, data)); }

const algId = (o, params) => seq(oid(o), params);
const hashAlgId = (hash) => algId(HASH_OID[hash]);

/* Certificates */

const NAMES = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.9': 'STREET', '2.5.4.5': 'SERIALNUMBER', '2.5.4.12': 'T', '2.5.4.4': 'SN', '2.5.4.42': 'GN', '2.5.4.97': 'organizationIdentifier', '1.2.840.113549.1.9.1': 'E', '0.9.2342.19200300.100.1.25': 'DC', '0.9.2342.19200300.100.1.1': 'UID' };
const KEY_USAGE = ['Digital signature', 'Non-repudiation', 'Key encipherment', 'Data encipherment', 'Key agreement', 'Certificate signing', 'CRL signing', 'Encipher only', 'Decipher only'];
const EKU = { '1.3.6.1.5.5.7.3.1': 'TLS server', '1.3.6.1.5.5.7.3.2': 'TLS client', '1.3.6.1.5.5.7.3.3': 'Code signing', '1.3.6.1.5.5.7.3.4': 'Email protection', '1.3.6.1.5.5.7.3.8': 'Time stamping', '1.3.6.1.5.5.7.3.9': 'OCSP signing', '1.3.6.1.5.5.7.3.36': 'Document signing', '1.3.6.1.4.1.311.10.3.12': 'Document signing (Microsoft)', '1.2.840.113583.1.1.5': 'Adobe Authentic Documents', '2.5.29.37.0': 'Any' };

function parseName(node) {
  node.expect(0x30, 'name');
  const attrs = [];
  for (const rdn of node.children) for (const atv of rdn.children) {
    const type = oidOf(atv.child(0)); let value;
    try { value = stringOf(atv.child(1)); } catch { value = `#${toHex(atv.child(1).der)}`; }
    attrs.push({ type, key: NAMES[type] ?? type, value });
  }
  // Most specific first, as RFC 4514 writes it.
  const text = attrs.slice().reverse().map((a) => `${a.key}=${a.value}`).join(', ');
  const get = (k) => attrs.filter((a) => a.key === k).map((a) => a.value).join(', ');
  return { der: node.der, attrs, text, cn: get('CN'), o: get('O'), get };
}

function parseSpki(node) {
  const alg = node.child(0); const type = oidOf(alg.child(0)); const key = bitsOf(node.child(1));
  if (type === OID.rsaEncryption || type === OID.rsaPss) {
    const rsa = parse(key);
    const modulus = uintBytes(rsa.child(0));
    let bitLen = modulus.length * 8; for (let b = modulus[0]; b < 0x80 && bitLen > 0; b <<= 1) bitLen--;
    // WebCrypto imports RSA keys only with the rsaEncryption identifier.
    const spki = type === OID.rsaEncryption ? node.der : seq(algId(OID.rsaEncryption, nullValue()), bits(key));
    return { type: 'RSA', bits: bitLen, curve: '', spki };
  }
  if (type === OID.ecPublicKey) {
    const params = alg.children[1]; const curve = params?.tag === 0x06 ? CURVES[oidOf(params)] ?? '' : '';
    return { type: 'EC', bits: curve ? Number(curve.slice(2)) : 0, curve, spki: node.der };
  }
  if (type === '1.3.101.112') return { type: 'Ed25519', bits: 256, curve: '', spki: node.der };
  return { type: 'Unknown', bits: 0, curve: '', spki: node.der, oid: type };
}

export function parseCertificate(der) {
  const cert = parse(der instanceof Uint8Array ? der : new Uint8Array(der));
  const tbs = cert.child(0).expect(0x30, 'certificate');
  let i = 0; const f = tbs.children;
  const version = f[0].tag === 0xa0 ? intOf(f[i++].child(0)) + 1 : 1;
  const serial = uintBytes(f[i++]);
  i++; // inner signature algorithm
  const issuer = parseName(f[i++]);
  const validity = f[i++];
  const subject = parseName(f[i++]);
  const key = parseSpki(f[i++]);
  const out = {
    der: cert.der, tbs: tbs.der, version, serial, serialHex: toHex(serial), issuer, subject,
    notBefore: timeOf(validity.child(0)), notAfter: timeOf(validity.child(1)), key,
    sigAlg: cert.child(1), signature: bitsOf(cert.child(2)),
    keyUsage: null, extKeyUsage: null, ca: false, pathLen: null, subjectKeyId: null, authorityKeyId: null,
  };
  const exts = f.find((n) => n.tag === 0xa3);
  if (exts) for (const ext of exts.child(0).children) {
    const id = oidOf(ext.child(0)); const value = parse(octetsOf(ext.children.at(-1)));
    if (id === '2.5.29.15') { const b = bitsOf(value); out.keyUsage = KEY_USAGE.filter((_, k) => b[k >> 3] & (0x80 >> (k & 7))); }
    else if (id === '2.5.29.37') out.extKeyUsage = value.children.map((n) => { const o = oidOf(n); return EKU[o] ?? o; });
    else if (id === '2.5.29.19') { const c = value.children; out.ca = c[0]?.tag === 0x01 && c[0].content[0] !== 0; if (c.find((n) => n.tag === 0x02)) out.pathLen = intOf(c.find((n) => n.tag === 0x02)); }
    else if (id === '2.5.29.14') out.subjectKeyId = toHex(value.content);
    else if (id === '2.5.29.35') { const k = value.children.find((n) => n.tag === 0x80); if (k) out.authorityKeyId = toHex(k.content); }
  }
  out.selfIssued = compareBytes(issuer.der, subject.der) === 0;
  return out;
}

export async function fingerprint(cert) { return toHex(await digest('SHA-256', cert.der)).toUpperCase().replace(/(..)(?!$)/g, '$1:'); }

// Accepts DER or PEM (one or more CERTIFICATE blocks).
export function readCertificates(bytes) {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 22)));
  const pems = [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  if (pems.length) return pems.map((m) => parseCertificate(Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0))));
  return [parseCertificate(bytes)];
}

/* Signature algorithms */

// Resolves a signature AlgorithmIdentifier (with the digest algorithm of a SignerInfo as a fallback for
// rsaEncryption and ecPublicKey) to WebCrypto parameters.
function signatureScheme(node, fallbackHash) {
  const id = oidOf(node.child(0));
  if (RSA_SIG[id]) return { kind: 'RSA', name: 'RSASSA-PKCS1-v1_5', hash: RSA_SIG[id] };
  if (id === OID.rsaEncryption) return { kind: 'RSA', name: 'RSASSA-PKCS1-v1_5', hash: fallbackHash };
  if (ECDSA_SIG[id]) return { kind: 'EC', name: 'ECDSA', hash: ECDSA_SIG[id] };
  if (id === OID.ecPublicKey) return { kind: 'EC', name: 'ECDSA', hash: fallbackHash };
  if (id === OID.rsaPss) {
    let hash = 'SHA-1'; let mgfHash = 'SHA-1'; let saltLength = 20;
    const params = node.children[1];
    if (params?.tag === 0x30) for (const p of params.children) {
      if (p.tag === 0xa0) hash = HASH_NAME[oidOf(p.child(0).child(0))];
      else if (p.tag === 0xa1) { const m = p.child(0); if (oidOf(m.child(0)) !== OID.mgf1) throw new Error('unsupported RSA-PSS mask'); mgfHash = HASH_NAME[oidOf(m.child(1).child(0))]; }
      else if (p.tag === 0xa2) saltLength = intOf(p.child(0));
    }
    if (hash !== mgfHash) throw new Error('RSA-PSS with different message and mask digests is not supported');
    return { kind: 'RSA', name: 'RSA-PSS', hash, saltLength };
  }
  throw new Error(`unsupported signature algorithm ${id}`);
}

async function verifySignature(key, scheme, signature, data) {
  if (!scheme.hash || scheme.hash === 'SHA-224') throw new Error('unsupported digest algorithm');
  if (scheme.kind !== key.type) throw new Error('the signature algorithm does not match the key');
  if (scheme.kind === 'RSA') {
    const pub = await crypto.subtle.importKey('spki', key.spki, { name: scheme.name, hash: scheme.hash }, false, ['verify']);
    return crypto.subtle.verify(scheme.name === 'RSA-PSS' ? { name: 'RSA-PSS', saltLength: scheme.saltLength } : { name: scheme.name }, pub, signature, data);
  }
  if (!CURVE_SIZE[key.curve]) throw new Error('unsupported elliptic curve');
  const pub = await crypto.subtle.importKey('spki', key.spki, { name: 'ECDSA', namedCurve: key.curve }, false, ['verify']);
  let raw;
  try { raw = ecdsaDerToRaw(signature, CURVE_SIZE[key.curve]); } catch { return false; }
  return crypto.subtle.verify({ name: 'ECDSA', hash: scheme.hash }, pub, raw, data);
}

// True when issuer's key made cert's signature.
export async function certSignedBy(cert, issuer) {
  try { return await verifySignature(issuer.key, signatureScheme(cert.sigAlg, 'SHA-256'), cert.signature, cert.tbs); } catch { return false; }
}

// Builds the chain from the leaf through the pool. trusted: root certificates the user chose to trust.
// trust is 'trusted' when the chain reaches one of them, 'untrusted' when it does not, and 'not-checked'
// when no trusted roots were given.
export async function buildChain(leaf, pool, trusted = []) {
  const chain = [{ cert: leaf, signedByNext: null }]; const candidates = [...pool, ...trusted];
  const isTrusted = (c) => trusted.some((t) => compareBytes(t.der, c.der) === 0);
  let cur = leaf;
  for (let depth = 0; depth < 10 && !isTrusted(cur); depth++) {
    if (cur.selfIssued && await certSignedBy(cur, cur)) { chain.at(-1).selfSigned = true; break; }
    let next = null;
    for (const c of candidates) {
      if (compareBytes(c.subject.der, cur.issuer.der) !== 0 || compareBytes(c.der, cur.der) === 0) continue;
      if (cur.authorityKeyId && c.subjectKeyId && cur.authorityKeyId !== c.subjectKeyId) continue;
      if (await certSignedBy(cur, c)) { next = c; break; }
    }
    if (!next || chain.some((l) => compareBytes(l.cert.der, next.der) === 0)) break;
    chain.at(-1).signedByNext = true;
    chain.push({ cert: next, signedByNext: null });
    cur = next;
  }
  const reached = chain.some((l) => isTrusted(l.cert));
  return { chain, trust: !trusted.length ? 'not-checked' : reached ? 'trusted' : 'untrusted', complete: Boolean(chain.at(-1).selfSigned || reached) };
}

/* Building SignedData */

function signatureAlgId(algorithm) {
  const hash = hashFor(algorithm);
  if (algorithm === 'RSASSA-PKCS1-v1_5') return algId(RSA_SIG_OID[hash], nullValue());
  if (algorithm === 'RSA-PSS') {
    const h = algId(HASH_OID[hash], nullValue());
    return algId(OID.rsaPss, seq(explicit(0, h), explicit(1, algId(OID.mgf1, h)), explicit(2, int(HASH_SIZE[hash]))));
  }
  return algId(ECDSA_SIG_OID[hash]);
}

const attribute = (type, ...values) => seq(oid(type), set(...values));

// signer: { certificates: [leaf DER, ...chain], algorithm, sign(digest, signedAttributesDer) }.
// contentDigest: the digest of the signed bytes with the algorithm's digest. Returns ContentInfo DER.
export async function buildSignedData(signer, contentDigest) {
  const hash = hashFor(signer.algorithm);
  const certs = signer.certificates.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));
  if (!certs.length) throw new Error('The signer has no certificate.');
  const leaf = parseCertificate(certs[0]);
  checkKeyMatchesAlgorithm(leaf, signer.algorithm);
  const issuerSerial = seq(seq(tlv(0xa4, leaf.issuer.der)), int(leaf.serial));
  // ESSCertIDv2 leaves out hashAlgorithm when it is SHA-256, its default.
  const essCertId = seq(octets(await digest('SHA-256', certs[0])), issuerSerial);
  const signedAttrs = set(
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(contentDigest)),
    attribute(OID.signingCertificateV2, seq(seq(essCertId))),
  );
  const attrsDigest = await digest(hash, signedAttrs);
  let signature = new Uint8Array(await signer.sign(attrsDigest, signedAttrs));
  if (signer.algorithm.startsWith('ECDSA') && signature[0] !== 0x30) signature = ecdsaRawToDer(signature);
  if (!(await verifySignature(leaf.key, signatureScheme(parse(signatureAlgId(signer.algorithm)), hash), signature, signedAttrs))) {
    throw new Error('The signature does not match the certificate. The key and the certificate may not belong together.');
  }
  const signerInfo = seq(int(1), seq(leaf.issuer.der, int(leaf.serial)), hashAlgId(hash), implicit(0, signedAttrs), signatureAlgId(signer.algorithm), octets(signature));
  const signedData = seq(int(1), set(hashAlgId(hash)), seq(oid(OID.data)), tlv(0xa0, concat(certs)), set(signerInfo));
  return seq(oid(OID.signedData), explicit(0, signedData));
}

export function checkKeyMatchesAlgorithm(cert, algorithm) {
  const { type, curve } = cert.key;
  const ok = algorithm.startsWith('RSA') ? type === 'RSA' : algorithm === 'ECDSA-P256' ? curve === 'P-256' : algorithm === 'ECDSA-P384' ? curve === 'P-384' : false;
  if (!ok) throw new Error(`The certificate's ${type === 'EC' ? `${curve || 'elliptic curve'} ` : type} key cannot make ${algorithm} signatures.`);
}

// The signer algorithms a certificate's key supports.
export function algorithmsFor(cert) {
  if (cert.key.type === 'RSA') return ['RSASSA-PKCS1-v1_5', 'RSA-PSS'];
  if (cert.key.curve === 'P-256') return ['ECDSA-P256'];
  if (cert.key.curve === 'P-384') return ['ECDSA-P384'];
  return [];
}

/* Reading and checking SignedData */

export function parseSignedData(der) {
  const top = parse(der, { trailing: true }).expect(0x30, 'signature');
  if (oidOf(top.child(0)) !== OID.signedData) throw new Error('not a CMS SignedData signature');
  const sd = top.child(1).child(0).expect(0x30, 'signed data');
  const f = sd.children;
  const encap = f[2];
  const eContentType = oidOf(encap.child(0));
  const eContent = encap.children[1] ? octetsOf(encap.children[1].child(0)) : null;
  const certificates = []; const unreadable = [];
  for (const n of f.filter((x) => x.tag === 0xa0)) for (const c of n.children) {
    if (c.tag !== 0x30) continue;
    try { certificates.push(parseCertificate(c.der)); } catch { unreadable.push(c.der); }
  }
  const infos = f.at(-1).expect(0x31, 'signer infos').children;
  const signerInfos = infos.map((si) => {
    const s = si.children; let i = 1;
    const sidNode = s[i++];
    const sid = sidNode.tag === 0x30 ? { issuer: sidNode.child(0).der, serial: uintBytes(sidNode.child(1)) } : { keyId: toHex(sidNode.content) };
    const digestAlg = HASH_NAME[oidOf(s[i++].child(0))] ?? null;
    let signedAttrs = null; const attrs = new Map();
    if (s[i].tag === 0xa0) {
      const node = s[i++];
      // The signature covers the attributes encoded with the SET OF tag, not [0].
      signedAttrs = node.der.slice(); signedAttrs[0] = 0x31;
      for (const a of node.children) attrs.set(oidOf(a.child(0)), a.child(1).children);
    }
    const sigAlg = s[i++]; const signature = octetsOf(s[i++]);
    const unsigned = s[i]?.tag === 0xa1 ? s[i].children.map((a) => oidOf(a.child(0))) : [];
    return { sid, digestAlg, signedAttrs, attrs, sigAlg, signature, unsigned };
  });
  return { eContentType, eContent, certificates, unreadable, signerInfos };
}

function findSigner(sd, si) {
  return sd.certificates.find((c) => (si.sid.keyId ? c.subjectKeyId === si.sid.keyId : compareBytes(c.issuer.der, si.sid.issuer) === 0 && compareBytes(c.serial, si.sid.serial) === 0)) ?? null;
}

// content: the signed bytes (the PDF byte ranges, or the encapsulated content when there is one).
// Returns { digestOk, signatureOk, signer, signingTime, problems[] }.
export async function verifySignedData(sd, content) {
  const problems = [];
  const si = sd.signerInfos[0];
  if (!si) return { digestOk: false, signatureOk: false, signer: null, problems: ['The signature has no signer.'] };
  if (sd.signerInfos.length > 1) problems.push('The signature holds more than one signer. Only the first is checked.');
  const signer = findSigner(sd, si);
  const hash = si.digestAlg;
  if (!hash) return { digestOk: false, signatureOk: false, signer, problems: ['The signature uses a digest algorithm this tool does not support.'] };
  if (hash === 'SHA-1') problems.push('The signature uses SHA-1, which is no longer considered secure.');
  const contentDigest = await digest(hash, content);
  let digestOk; let signed;
  let signingTime = null; let signingCertOk = null;
  if (si.signedAttrs) {
    const md = si.attrs.get(OID.messageDigest)?.[0];
    digestOk = Boolean(md) && compareBytes(octetsOf(md), contentDigest) === 0;
    signed = si.signedAttrs;
    const st = si.attrs.get(OID.signingTime)?.[0];
    if (st) try { signingTime = timeOf(st); } catch { /* unreadable time */ }
    const ct = si.attrs.get(OID.contentType)?.[0];
    if (!ct || oidOf(ct) !== sd.eContentType) problems.push('The content type attribute is missing or does not match.');
    const scv2 = si.attrs.get(OID.signingCertificateV2)?.[0];
    if (scv2 && signer) {
      const id = scv2.child(0).child(0); let h = 'SHA-256'; let k = 0;
      if (id.child(0).tag === 0x30) { h = HASH_NAME[oidOf(id.child(0).child(0))]; k = 1; }
      signingCertOk = Boolean(h) && compareBytes(octetsOf(id.child(k)), await digest(h, signer.der)) === 0;
      if (!signingCertOk) problems.push('The signing certificate attribute does not match the signer certificate.');
    }
  } else { digestOk = true; signed = content; }
  if (!signer) return { digestOk, signatureOk: false, signer: null, signingTime, problems: [...problems, "The signer's certificate is not included in the signature."] };
  let signatureOk = false;
  try { signatureOk = await verifySignature(signer.key, signatureScheme(si.sigAlg, hash), si.signature, signed); }
  catch (error) { problems.push(`The signature could not be checked: ${error.message}.`); }
  return { digestOk, signatureOk, signer, signingTime, signingCertOk, hash, timestamped: si.unsigned.includes(OID.timeStampToken), problems };
}
