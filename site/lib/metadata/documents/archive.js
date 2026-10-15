// Generic ZIP archives, including packages built on ZIP (JAR, APK, XPI, VSIX and others), which are
// reported as ZIP with a note.
import { fmtBytes } from '../bytes.js';
import { METHODS } from '../../zip/index.js';
import { DOC_LIMITS } from './package.js';

const PACKAGES = [
  [(n) => n.has('androidmanifest.xml') && [...n].some((x) => x.endsWith('.dex')), 'Android app (APK)'],
  [(n) => n.has('extension.vsixmanifest'), 'Visual Studio extension (VSIX)'],
  [(n) => n.has('appxmanifest.xml'), 'Windows app package'],
  [(n) => [...n].some((x) => /^payload\/[^/]+\.app\//.test(x)), 'iOS app (IPA)'],
  [(n) => n.has('manifest.json') && (n.has('meta-inf/mozilla.rsa') || n.has('meta-inf/manifest.mf')), 'Browser extension'],
  [(n) => [...n].some((x) => x.startsWith('web-inf/')), 'Java web application (WAR)'],
  [(n) => n.has('meta-inf/manifest.mf'), 'Java archive (JAR)'],
  [(n) => [...n].some((x) => /\.dist-info\/record$/.test(x)), 'Python wheel'],
  [(n) => n.has('doc.kml'), 'Google Earth (KMZ)'],
  [(n) => n.has('3d/3dmodel.model'), '3D Manufacturing Format (3MF)'],
  [(n) => n.has('[content_types].xml'), 'Open Packaging Conventions package'],
];

// Signatures that cover the archive bytes or its entries. Rewriting the archive would invalidate them.
export function packageSignature(zip) {
  const names = zip.entries.map((e) => e.name);
  const sig = names.find((x) => /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i.test(x) || /^AppxSignature\.p7x$/i.test(x) || /(^|\/)_CodeSignature\//.test(x) || /^package\/services\/digital-signature\//i.test(x));
  if (sig) return sig;
  const at = zip.centralOffset - 16;
  if (at >= 0 && String.fromCharCode(...zip.bytes.subarray(at, at + 16)) === 'APK Sig Block 42') return 'APK signing block';
  return null;
}

export async function parseArchive(zip, r) {
  r.format = 'ZIP'; r.category = 'Archive';
  const names = new Set(zip.entries.map((e) => e.name.toLowerCase()));
  const kind = PACKAGES.find(([test]) => test(names))?.[1];
  if (kind) { r.field('Archive', 'Package type', kind); r.field('Archive', 'Note', 'This is a package built on the ZIP format and is shown as a ZIP archive.'); }
  const signature = packageSignature(zip);
  if (signature) {
    r.field('Archive', 'Signed package', signature);
    r.block('Package signature', zip.centralOffset, zip.centralSize, { container: signature, removable: false, note: 'Rewriting the archive would break the signature' });
  }
  let listed = 0;
  for (const e of zip.entries) {
    if (listed++ >= DOC_LIMITS.maxListed) { r.field('Archive entries', '…', `${zip.entries.length - DOC_LIMITS.maxListed} more entries not listed`); break; }
    const parts = [e.directory ? 'folder' : fmtBytes(e.size)];
    if (!e.directory && e.method !== 0) parts.push(METHODS[e.method] ?? `method ${e.method}`);
    if (e.encrypted) parts.push('encrypted');
    if (e.modified && !(e.dosDate === 33 && e.dosTime === 0)) parts.push(e.modified.toISOString().replace('T', ' ').slice(0, 19));
    r.field('Archive entries', e.name, parts.join(', '));
  }
  const encrypted = zip.entries.filter((e) => e.encrypted);
  if (encrypted.length) r.signal('privacy', 'Encrypted entries', `${encrypted.length} entr${encrypted.length === 1 ? 'y is' : 'ies are'} encrypted. Their names, sizes and dates are still readable.`, 'Archive', 'encrypted entries');
  const unsafe = zip.entries.filter((e) => /^([\\/]|[A-Za-z]:)|(^|[\\/])\.\.([\\/]|$)/.test(e.name));
  if (unsafe.length) { r.field('Archive', 'Unsafe paths', unsafe.slice(0, 5).map((e) => e.name).join(', ')); r.warn('Some entries have an absolute path or "..", which can write outside the folder when extracted.'); }
}
