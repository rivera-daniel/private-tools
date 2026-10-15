// Test certificates, keys and signers for the PDF signing tests, generated at run time with WebCrypto.
// Nothing here is a real identity; every key lives only for the test run.
import { seq, set, oid, int, octets, nullValue, bits, bool, explicit, utf8String, printableString, time, ecdsaRawToDer } from '../../site/lib/pdf-editor/asn1.js';
import { pdf, basic } from './pdf.js';

const ALG = {
  rsa: { gen: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, sigAlg: () => seq(oid('1.2.840.113549.1.1.11'), nullValue()), sign: { name: 'RSASSA-PKCS1-v1_5' } },
  p256: { gen: { name: 'ECDSA', namedCurve: 'P-256' }, sigAlg: () => seq(oid('1.2.840.10045.4.3.2')), sign: { name: 'ECDSA', hash: 'SHA-256' } },
  p384: { gen: { name: 'ECDSA', namedCurve: 'P-384' }, sigAlg: () => seq(oid('1.2.840.10045.4.3.3')), sign: { name: 'ECDSA', hash: 'SHA-384' } },
};

export async function makeKey(kind) {
  const keys = await crypto.subtle.generateKey(ALG[kind].gen, true, ['sign', 'verify']);
  return { kind, ...keys, spki: new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)), pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)) };
}

async function rawSign(key, data) {
  const sig = new Uint8Array(await crypto.subtle.sign(ALG[key.kind].sign, key.privateKey, data));
  return key.kind === 'rsa' ? sig : ecdsaRawToDer(sig);
}

const name = (cn, o) => seq(set(seq(oid('2.5.4.6'), printableString('US'))), o && set(seq(oid('2.5.4.10'), utf8String(o))), set(seq(oid('2.5.4.3'), utf8String(cn))));
const ext = (id, critical, value) => seq(oid(id), critical ? bool(true) : null, octets(value));
let serialCounter = 1000;

// keyUsage bits: digitalSignature 0x80, nonRepudiation 0x40, keyCertSign 0x04, cRLSign 0x02.
export async function makeCert({ cn, o = 'Private Tools Test', key, issuer = null, ca = false, days = 30, notBefore = new Date(Date.now() - 86400000) }) {
  const signerKey = issuer ? issuer.key : key;
  const issuerName = issuer ? issuer.name : name(cn, o);
  const subject = name(cn, o);
  const ku = ca ? 0x06 : 0xc0;
  const skid = new Uint8Array(await crypto.subtle.digest('SHA-1', key.spki)).subarray(0, 20);
  const exts = [
    ext('2.5.29.19', true, ca ? seq(bool(true)) : seq()),
    ext('2.5.29.15', true, bits(new Uint8Array([ku]))),
    ext('2.5.29.14', false, octets(skid)),
    issuer ? ext('2.5.29.35', false, seq(new Uint8Array([0x80, issuer.skid.length, ...issuer.skid]))) : null,
  ].filter(Boolean);
  const tbs = seq(explicit(0, int(2)), int(serialCounter++), ALG[signerKey.kind].sigAlg(), issuerName, seq(time(notBefore), time(new Date(notBefore.getTime() + days * 86400000))), subject, key.spki, explicit(3, seq(...exts)));
  const der = seq(tbs, ALG[signerKey.kind].sigAlg(), bits(await rawSign(signerKey, tbs)));
  return { der, key, name: subject, skid };
}

// A CA and a leaf signed by it. kind: 'rsa' | 'p256' | 'p384'.
export async function makeIdentity(kind = 'rsa', { cn = 'Test Signer', caKind = kind } = {}) {
  const caKey = await makeKey(caKind);
  const caCert = await makeCert({ cn: `Test Root CA ${caKind}`, key: caKey, ca: true, days: 365 });
  const leafKey = await makeKey(kind);
  const leaf = await makeCert({ cn, key: leafKey, issuer: caCert });
  return { ca: caCert, leaf, key: leafKey };
}

const ALGORITHM = { rsa: 'RSASSA-PKCS1-v1_5', p256: 'ECDSA-P256', p384: 'ECDSA-P384' };
// A signer over a WebCrypto key: it signs the signed-attributes DER, as p12Signer does.
export function keySigner(identity, { algorithm = ALGORITHM[identity.key.kind], chain = true } = {}) {
  return {
    certificates: chain ? [identity.leaf.der, identity.ca.der] : [identity.leaf.der], algorithm,
    async sign(digest, data) {
      if (algorithm === 'RSA-PSS') {
        const k = await crypto.subtle.importKey('pkcs8', identity.key.pkcs8, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
        return new Uint8Array(await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, k, data));
      }
      return rawSign(identity.key, data);
    },
  };
}

export const pem = (label, der) => `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n')}-----END ${label}-----\n`;

// Two pages; the second rotated by 90 degrees.
export const classicPdf = () => pdf({ ...basic(), 2: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>', 6: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' }, { trailer: '/Root 1 0 R' });
export const streamPdf = () => pdf({ ...basic() }, { trailer: '/Root 1 0 R', xrefStream: true, packed: [3] });
