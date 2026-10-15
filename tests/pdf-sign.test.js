import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signPdf, verifyPdf, readCertificates, displayedPageSizes, SignError } from '../site/lib/pdf-editor/sign.js';
import { p12Signer, readPkcs12, ciphers, sha1, sha256, P12Error } from '../site/lib/pdf-editor/pkcs12.js';
import { parseCertificate, buildChain } from '../site/lib/pdf-editor/cms.js';
import { parse, oidOf, seq, int, oid, ecdsaRawToDer, ecdsaDerToRaw, time, timeOf, fromHex, toHex } from '../site/lib/pdf-editor/asn1.js';
import { PdfDocument } from '../site/lib/metadata/pdf/document.js';
import { makeIdentity, keySigner, classicPdf, streamPdf, pem } from './fixtures/pdf-sign.js';
import { pdf, basic, update, stream } from './fixtures/pdf.js';

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const PDFSIG = has('pdfsig'); const OPENSSL = has('openssl');
const dir = mkdtempSync(join(tmpdir(), 'pdf-sign-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const latin = (u8) => Buffer.from(u8).toString('latin1');
let fileNo = 0;

// pdfsig output per signature: [{ valid, total }].
function pdfsig(bytes) {
  const path = join(dir, `check-${fileNo++}.pdf`);
  writeFileSync(path, bytes);
  const out = spawnSync('pdfsig', [path], { encoding: 'utf8' }).stdout;
  return out.split(/^Signature #\d+:/m).slice(1).map((s) => ({ valid: /Signature Validation: Signature is Valid\./.test(s), total: /Total document signed/.test(s) && !/Not total document signed/.test(s), text: s }));
}

const identities = {};
const identity = async (kind) => (identities[kind] ??= await makeIdentity(kind));

test('ASN.1 encodes and reads back', () => {
  const der = seq(int(0), int(127), int(128), int(-1 >>> 0), oid('1.2.840.113549.1.9.16.2.47'), time(new Date(Date.UTC(2051, 0, 2, 3, 4, 5))));
  const n = parse(der);
  assert.equal(toHex(n.child(1).content), '7f');
  assert.equal(toHex(n.child(2).content), '0080');
  assert.equal(oidOf(n.child(4)), '1.2.840.113549.1.9.16.2.47');
  assert.equal(n.child(5).tag, 0x18);
  assert.equal(timeOf(n.child(5)).toISOString(), '2051-01-02T03:04:05.000Z');
  const raw = Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? 0x80 : i === 32 ? 0 : i));
  assert.deepEqual(ecdsaDerToRaw(ecdsaRawToDer(raw), 32), raw);
  assert.throws(() => parse(fromHex('3005020101')), /truncated/);
  assert.throws(() => parse(fromHex('30840fffffff')), /length|truncated/);
});

test('DES, RC2 and the synchronous digests match their references', () => {
  const h = fromHex;
  assert.equal(toHex(ciphers.desBlock(h('85e813540f0ab405'), ciphers.desSubkeys(h('133457799bbcdff1')), true)), '0123456789abcdef');
  // RFC 2268 test vectors.
  for (const [key, bitsLen, plain, cipher] of [['0000000000000000', 63, '0000000000000000', 'ebb773f993278eff'], ['ffffffffffffffff', 64, 'ffffffffffffffff', '278b27e42e2f0d49'], ['3000000000000000', 64, '1000000000000001', '30649edf9be7d2c2'], ['88', 64, '0000000000000000', '61a8a244adacccf0']]) {
    assert.equal(toHex(ciphers.rc2DecryptBlock(ciphers.rc2Keys(h(key), bitsLen))(h(cipher))), plain);
  }
  for (const len of [0, 3, 55, 56, 63, 64, 65, 200]) {
    const data = Uint8Array.from({ length: len }, (_, i) => (i * 7) & 0xff);
    assert.equal(toHex(sha1(data)), createHash('sha1').update(data).digest('hex'));
    assert.equal(toHex(sha256(data)), createHash('sha256').update(data).digest('hex'));
  }
});

for (const [kind, algorithm] of [['rsa', 'RSASSA-PKCS1-v1_5'], ['rsa', 'RSA-PSS'], ['p256', 'ECDSA-P256'], ['p384', 'ECDSA-P384']]) {
  for (const [label, make] of [['classic cross-reference table', classicPdf], ['cross-reference stream', streamPdf]]) {
    test(`signs with ${algorithm} into a file with a ${label}, then countersigns`, async () => {
      const id = await identity(kind);
      const original = new Uint8Array(make());
      const once = await signPdf(original, keySigner(id, { algorithm }), { reason: 'Approval', location: 'Austin, TX', contactInfo: 'signer@example.com', rect: { x: 40, y: 40, width: 220, height: 70 }, appearance: { lines: ['Digitally signed by Test Signer', 'Reason: Approval', 'Grüße – “quoted”'] } });
      assert.deepEqual(once.subarray(0, original.length), original, 'earlier bytes unchanged');
      const doc = await PdfDocument.open(once, { warn: (m) => assert.fail(m) });
      assert.equal(doc.sections.length, 2);
      assert.equal(doc.sections[0].kind, label.startsWith('classic') ? 'table' : 'stream');
      const v1 = await verifyPdf(once);
      assert.equal(v1.signatures.length, 1);
      const s = v1.signatures[0];
      assert.equal(s.status, 'valid', s.problems.join(' '));
      assert.ok(s.coversWholeFile);
      assert.equal(s.subFilter, 'ETSI.CAdES.detached');
      assert.equal(s.reason, 'Approval'); assert.equal(s.location, 'Austin, TX');
      assert.equal(s.signer.commonName, 'Test Signer');
      assert.equal(s.hash, algorithm === 'ECDSA-P384' ? 'SHA-384' : 'SHA-256');
      assert.equal(s.trust, 'not-checked');
      assert.equal(s.chain.length, 2); assert.ok(s.chain[1].selfSigned); assert.ok(s.chainComplete);
      assert.deepEqual(s.signer.keyUsage, ['Digital signature', 'Non-repudiation']);
      assert.deepEqual(s.problems, []);

      const twice = await signPdf(once, keySigner(id, { algorithm }), { reason: 'Second', page: 0, rect: { x: 300, y: 500, width: 150, height: 40 }, appearance: { lines: ['Second signer'] } });
      assert.deepEqual(twice.subarray(0, once.length), once);
      const v2 = await verifyPdf(twice);
      assert.deepEqual(v2.signatures.map((x) => x.status), ['valid-later-signed', 'valid']);
      assert.deepEqual(v2.signatures.map((x) => x.field), ['Signature1', 'Signature2']);
      assert.ok(v2.signatures[0].laterChanges.kinds.some((k) => k.kind === 'signature'));
      if (PDFSIG) {
        const r = pdfsig(twice);
        assert.equal(r.length, 2, 'pdfsig sees both signatures');
        assert.ok(r.every((x) => x.valid), r.map((x) => x.text).join('\n'));
        assert.deepEqual(r.map((x) => x.total), [false, true]);
      }
    });
  }
}

test('changing any signed byte breaks the signature', async () => {
  const signed = await signPdf(classicPdf(), keySigner(await identity('p256')), {});
  const text = latin(signed);
  const body = signed.slice(); const at = text.indexOf('Hello world'); body[at] ^= 0x20;
  const r1 = (await verifyPdf(body)).signatures[0];
  assert.equal(r1.status, 'invalid'); assert.equal(r1.digestOk, false);
  assert.match(r1.problems[0], /changed after it was signed/);
  // The last bytes of the signature value, then a byte inside the embedded signer certificate.
  const start = text.indexOf('/Contents <') + 11; const end = text.indexOf('>', start); const used = text.slice(start, end).replace(/0+$/, '').length;
  // Hex is case-insensitive, so swap between 0 and 1 to be sure the value changes.
  const flip = (b) => (b === 0x30 ? 0x31 : 0x30);
  const sig = signed.slice(); sig[start + used - 3] = flip(sig[start + used - 3]);
  const r2 = (await verifyPdf(sig)).signatures[0];
  assert.equal(r2.status, 'invalid'); assert.equal(r2.digestOk, true); assert.equal(r2.signatureOk, false);
  const cert = signed.slice(); cert[start + 400] = flip(cert[start + 400]);
  const r4 = (await verifyPdf(cert)).signatures[0];
  assert.equal(r4.status, 'invalid');
  // A byte range that does not reach the end of the file once garbage is appended.
  const extra = new Uint8Array([...signed, ...Buffer.from('% appended\n')]);
  const r3 = (await verifyPdf(extra)).signatures[0];
  assert.equal(r3.coversWholeFile, false);
  if (PDFSIG) { assert.equal(pdfsig(body)[0].valid, false); assert.equal(pdfsig(sig)[0].valid, false); }
});

test('reports what later incremental updates changed', async () => {
  const signed = Buffer.from(await signPdf(classicPdf(), keySigner(await identity('rsa')), {}));
  const edited = update(signed, { 4: stream('<< >>', 'BT /F1 12 Tf 72 720 Td (Changed) Tj ET'), 30: '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (note) >>' });
  const r = (await verifyPdf(edited)).signatures[0];
  assert.equal(r.status, 'valid-later-changed');
  const kinds = r.laterChanges.kinds.map((k) => k.kind).sort();
  assert.deepEqual(kinds, ['annotation', 'content']);
});

test('places a visible signature on a rotated page and an invisible one', async () => {
  const id = await identity('rsa');
  assert.deepEqual(await displayedPageSizes(classicPdf()), [{ width: 612, height: 792 }, { width: 792, height: 612 }]);
  const signed = await signPdf(classicPdf(), keySigner(id), { page: 1, rect: { x: 10, y: 20, width: 200, height: 50 }, appearance: { lines: ['Signed'], image: { width: 2, height: 1, rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]) } } });
  const doc = await PdfDocument.open(signed);
  const widget = [...doc.entries.keys()].map((n) => doc.get(n)).find((v) => v?.get?.('FT')?.name === 'Sig');
  // Displayed (10, 20) from the top left of a page rotated 90 degrees: user space x = y, y = x.
  assert.deepEqual(widget.get('Rect'), [20, 10, 70, 210]);
  const ap = doc.resolve(widget.get('AP').get('N'));
  assert.deepEqual(ap.dict.get('Matrix'), [0, 1, -1, 0, 0, 0]);
  assert.ok(doc.dict(ap.dict.get('Resources').get('XObject').get('Img')).has('SMask'));
  const page2 = doc.pages()[1].dict;
  assert.equal(doc.resolve(page2.get('Annots')).length, 1);
  assert.equal((await verifyPdf(signed)).signatures[0].status, 'valid');
  const invisible = await signPdf(classicPdf(), keySigner(id), {});
  const d2 = await PdfDocument.open(invisible);
  const w2 = [...d2.entries.keys()].map((n) => d2.get(n)).find((v) => v?.get?.('FT')?.name === 'Sig');
  assert.deepEqual(w2.get('Rect'), [0, 0, 0, 0]);
  assert.equal(d2.catalog().get('AcroForm') instanceof Object, true);
  assert.equal(d2.dict(d2.catalog().get('AcroForm')).get('SigFlags'), 3);
  if (PDFSIG) { assert.ok(pdfsig(signed)[0].valid); assert.ok(pdfsig(invisible)[0].valid); }
});

test('refuses encrypted, certified and damaged files, and keys that do not match the certificate', async () => {
  const id = await identity('rsa');
  const encrypted = pdf({ ...basic(), 9: '<< /Filter /Standard /V 2 /R 3 /O (x) /U (y) /P -4 >>' }, { trailer: '/Root 1 0 R /Encrypt 9 0 R /ID [<00><00>]' });
  await assert.rejects(signPdf(encrypted, keySigner(id)), (e) => e instanceof SignError && /password protected/.test(e.message));
  const certified = pdf({ ...basic({ catalog: '/Perms << /DocMDP 9 0 R >>' }), 9: '<< /Type /Sig /Reference [<< /TransformMethod /DocMDP /TransformParams << /P 1 >> >>] >>' }, { trailer: '/Root 1 0 R' });
  await assert.rejects(signPdf(certified, keySigner(id)), /no changes allowed/);
  const damaged = Buffer.from(latin(classicPdf()).replace(/startxref\s+\d+/, 'startxref\n999999'), 'latin1');
  await assert.rejects(signPdf(damaged, keySigner(id)), /damaged/);
  const other = await makeIdentity('rsa');
  const mismatched = { ...keySigner(other), certificates: [id.leaf.der] };
  await assert.rejects(signPdf(classicPdf(), mismatched), /does not match the certificate/);
  await assert.rejects(signPdf(classicPdf(), keySigner(id, { algorithm: 'ECDSA-P256' })), /cannot make ECDSA-P256/);
  assert.deepEqual((await verifyPdf(classicPdf())).signatures, []);
});

test('trust comes only from imported roots', async () => {
  const id = await identity('p256');
  const signed = await signPdf(streamPdf(), keySigner(id), {});
  const root = readCertificates(Buffer.from(pem('CERTIFICATE', id.ca.der)));
  assert.equal((await verifyPdf(signed, { trusted: root })).signatures[0].trust, 'trusted');
  const stranger = await makeIdentity('p256');
  assert.equal((await verifyPdf(signed, { trusted: [parseCertificate(stranger.ca.der)] })).signatures[0].trust, 'untrusted');
  // Without the CA in the signature the chain stops at the leaf but the imported root still anchors it.
  const leafOnly = await signPdf(streamPdf(), keySigner(id, { chain: false }), {});
  const r = (await verifyPdf(leafOnly, { trusted: root })).signatures[0];
  assert.equal(r.trust, 'trusted'); assert.equal(r.chain.length, 2);
  const unanchored = await buildChain(parseCertificate(id.leaf.der), []);
  assert.equal(unanchored.complete, false);
});

test('opens .p12 files: AES with HMAC-SHA-256, PBMAC1 and legacy 3DES/RC2', { skip: !OPENSSL && 'openssl not installed' }, async () => {
  const id = await identity('rsa');
  writeFileSync(join(dir, 'key.pem'), pem('PRIVATE KEY', id.key.pkcs8));
  writeFileSync(join(dir, 'leaf.pem'), pem('CERTIFICATE', id.leaf.der));
  writeFileSync(join(dir, 'ca.pem'), pem('CERTIFICATE', id.ca.der));
  const variants = [['aes', []], ['pbmac1', ['-pbmac1_pbkdf2']], ['legacy', ['-legacy']], ['3des-nomac', ['-nomac', '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES']]];
  let made = 0;
  for (const [label, extra] of variants) {
    const out = join(dir, `${label}.p12`);
    // The CA goes first so the leaf has to be found by its key, not by position.
    const r = spawnSync('openssl', ['pkcs12', '-export', '-inkey', join(dir, 'key.pem'), '-in', join(dir, 'leaf.pem'), '-certfile', join(dir, 'ca.pem'), '-name', 'Test signing key', '-out', out, '-passout', 'pass:correct horse ü', ...extra]);
    if (r.status !== 0) { console.log(`# skipping ${label}: this openssl cannot write it`); continue; }
    made++;
    const file = readFileSync(out);
    const signer = await p12Signer(file, 'correct horse ü');
    assert.equal(signer.certificate.subject.cn, 'Test Signer', label);
    assert.equal(signer.chain.length, 2);
    assert.equal(signer.friendlyName, 'Test signing key');
    assert.deepEqual(signer.algorithms, ['RSASSA-PKCS1-v1_5', 'RSA-PSS']);
    const signed = await signPdf(classicPdf(), signer.withAlgorithm('RSA-PSS'), {});
    assert.equal((await verifyPdf(signed)).signatures[0].status, 'valid', label);
    if (PDFSIG) assert.ok(pdfsig(signed)[0].valid, label);
    await assert.rejects(p12Signer(file, 'wrong'), (e) => e instanceof P12Error && /password is wrong/.test(e.message));
    const { keys } = await readPkcs12(file, 'correct horse ü');
    assert.equal(keys.length, 1);
  }
  assert.ok(made >= 2);
  await assert.rejects(p12Signer(new Uint8Array([1, 2, 3]), ''), /not a .p12/);
});

test('signs files rebuilt by MuPDF (as the editor saves them) and hybrid cross-reference files', async () => {
  const mupdf = await import('../site/vendor/mupdf/mupdf.js');
  const id = await identity('p256');
  const inputs = [['hybrid', pdf(basic(), { trailer: '/Root 1 0 R', hybrid: true, packed: [3] })]];
  for (const opts of ['', 'garbage,compress', 'garbage=deduplicate,compress,objstms']) {
    const doc = mupdf.Document.openDocument(classicPdf(), 'application/pdf');
    const buf = doc.saveToBuffer(opts);
    inputs.push([`MuPDF ${opts || 'plain'}`, buf.asUint8Array().slice()]);
    buf.destroy(); doc.destroy();
  }
  for (const [label, bytes] of inputs) {
    const signed = await signPdf(bytes, keySigner(id), { rect: { x: 20, y: 20, width: 120, height: 40 }, appearance: { lines: ['Signed'] } });
    assert.deepEqual((await verifyPdf(signed)).signatures.map((x) => x.status), ['valid'], label);
    if (PDFSIG) assert.ok(pdfsig(signed)[0]?.valid, label);
  }
});
