// Catalog and roadmap share one tool registry. Search includes available and planned tools.
// stage is null for available tools.
export const GROUPS = [
  { id: 'inspect', name: 'Inspect and clean', short: 'Inspect and clean' },
  { id: 'documents', name: 'Documents and PDF', short: 'Documents' },
  { id: 'images', name: 'Images', short: 'Images' },
  { id: 'files', name: 'Files and archives', short: 'Files' },
  { id: 'security', name: 'Security', short: 'Security' },
  { id: 'forensics', name: 'Forensics', short: 'Forensics' },
  { id: 'media', name: 'Media', short: 'Media' },
];
export const STAGES = { Next: 'Next', Then: 'Soon', Later: 'Later', Last: 'Further out' };
export const TOOLS = [
  { name: 'Image Inspector', copy: 'See every piece of metadata in an image: location, camera, people, software and AI provenance.', group: 'inspect', stage: null, art: 'inspector', href: '/image-inspector/' },
  { name: 'File Inspector', copy: 'See what any file reveals: its true type, hidden text, user names, build paths, signatures and metadata.', group: 'inspect', stage: null, art: 'files', href: '/file-inspector/' },
  { name: 'Metadata Cleaner', copy: 'Remove location, names, hidden text and other sensitive metadata from photos, documents, PDFs, audio and video.', group: 'inspect', stage: null, art: 'cleaner', href: '/metadata-cleaner/' },
  { name: 'Archiver', copy: 'Create and open ZIP, 7z, tar and gzip archives, extract RAR, xz, ISO and more, with AES-256 passwords and hidden data removed.', group: 'files', stage: null, art: 'archiver', href: '/archiver/' },
  { name: 'PDF Editor', copy: 'View, merge, split, reorder, compress, password-protect, redact and digitally sign PDFs, all on your device.', group: 'documents', stage: null, art: 'pdfedit', href: '/pdf-editor/' },
  { name: 'Photo Editor', copy: 'A full layered image editor in your browser: layers, masks, adjustment layers, selections, filters and PSD files.', group: 'images', stage: 'Last', art: 'photo', beta: true },
  { name: 'Audio Editor', copy: 'Record, cut, mix and clean up audio in your browser, without uploading your recordings.', group: 'media', stage: 'Last', art: 'wave' },
  { name: 'Office Viewer', copy: 'Open Word documents, spreadsheets and slide decks privately, without uploading them to an online office suite.', group: 'documents', stage: 'Next', art: 'office' },
  { name: 'QR Code Generator', copy: 'Make static QR codes that never expire and never route through a tracking server.', group: 'security', stage: 'Then', art: 'qr' },
  { name: 'Image Redactor', copy: 'Blur, pixelate or black out faces, plates and account numbers. The pixels are replaced, not covered.', group: 'images', stage: 'Next', art: 'imgredact' },
  { name: 'File Encryptor', copy: 'Encrypt any file with a passphrase or public key before you share it, in the open age format.', group: 'files', stage: 'Then', art: 'lock' },
  { name: 'Background Remover', copy: 'Cut out the subject of a photo with a model that runs on your device.', group: 'images', stage: 'Later', art: 'cutout' },
  { name: 'Data Anonymizer', copy: 'Find names, emails, phone numbers and IDs in CSV, Excel and JSON files, then mask, hash or remove them.', group: 'security', stage: 'Then', art: 'table' },
  { name: 'Developer Tools', copy: 'Format JSON and YAML, diff text, encode Base64 and URLs and test regular expressions without pasting secrets into a website.', group: 'security', stage: 'Then', art: 'code' },
  { name: 'Password Generator', copy: 'Generate strong passwords and passphrases with your browser’s secure random generator and check their strength.', group: 'security', stage: 'Then', art: 'key' },
  { name: 'PGP Tool', copy: 'Encrypt, decrypt, sign and verify messages and files with OpenPGP keys.', group: 'security', stage: 'Then', art: 'pgp' },
  { name: '2FA Backup Decoder', copy: 'Read authenticator export QR codes and otpauth links to move or back up your two-factor accounts.', group: 'security', stage: 'Then', art: 'otp' },
  { name: 'Private OCR', copy: 'Extract text from images and scanned documents on your device.', group: 'documents', stage: 'Next', art: 'ocr' },
  { name: 'Resume ATS Preview', copy: 'Preview the text an applicant tracking system extracts from your resume and spot formatting it cannot read.', group: 'documents', stage: 'Later', art: 'resume' },
  { name: 'Image Converter', copy: 'Convert HEIC to JPG and between other formats, resize and compress images without uploading them.', group: 'images', stage: 'Next', art: 'converter' },
  { name: 'Hash & Verify', copy: 'Calculate MD5, SHA-1, SHA-256 and SHA-512 hashes of any file and check them against an expected value.', group: 'forensics', stage: 'Later', art: 'hash' },
  { name: 'Timestamp Decoder', copy: 'Read a raw number as every common timestamp format: Unix, Windows, Apple, Chrome, DOS and GPS time.', group: 'forensics', stage: 'Later', art: 'clock' },
  { name: 'Email Header Analyzer', copy: 'Trace the servers an email passed through and check SPF, DKIM and DMARC results for signs of spoofing.', group: 'forensics', stage: 'Later', art: 'mail' },
  { name: 'Link & QR Inspector', copy: 'Decode QR codes, unwrap redirect links, spot look-alike domains and remove tracking without opening the link.', group: 'security', stage: 'Then', art: 'link' },
  { name: 'Hex Viewer', copy: 'View the raw bytes of a file with its metadata, hidden data and structures marked on them.', group: 'forensics', stage: 'Later', art: 'hex' },
  { name: 'Windows Artifact Viewer', copy: 'Read shortcut files, Jump Lists, Prefetch, event logs, registry hives, thumbnail caches and browser history.', group: 'forensics', stage: 'Later', art: 'artifacts' },
  { name: 'Packet Capture Viewer', copy: 'Explore PCAP files: hosts, DNS queries, visited sites, HTTP requests and files carried in the traffic.', group: 'forensics', stage: 'Later', art: 'network' },
  { name: 'Certificate & Token Decoder', copy: 'Decode certificates, certificate requests and JSON Web Tokens, with expiry and weak-key warnings.', group: 'forensics', stage: 'Later', art: 'certificate' },
  { name: 'Image Forensics', copy: 'Examine JPEG compression traces, resave clues, error levels and noise. Shows evidence, never a verdict.', group: 'forensics', stage: 'Later', art: 'lens' },
];


export const DETAILS = {
  "Image Inspector": "Inspect EXIF, XMP, IPTC and Content Credentials in JPEG, PNG, WebP, HEIC and other image formats.",
  "File Inspector": "Examine documents, PDFs, media, archives and executables for authors, comments, hidden content, embedded files and external references.",
  "Metadata Cleaner": "Supported files are inspected again before saving, while image, audio and video content is copied without re-encoding.",
  "Archiver": "Add files or whole folders, inspect individual archive entries, and remove hidden metadata before creating a shareable archive.",
  "PDF Editor": "Rotate pages, add watermarks and page numbers, and turn images into PDFs or export PDF pages as images."
};
