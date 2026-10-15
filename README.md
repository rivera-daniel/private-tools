# Private Tools

A suite of private tools that run entirely in your browser. Your files never leave your device: nothing is uploaded, processed on a server or stored in a database, and there are no accounts.

Live at [danielrivera.ai/tools](https://danielrivera.ai/tools/).

## Tools

### Image Inspector

Lists the metadata stored in an image file and highlights what it exposes.

- **Formats:** JPEG, PNG, WebP, HEIC/HEIF, AVIF, JPEG XL, GIF, TIFF and BigTIFF, DNG and camera raw (CR2, CR3, NEF, ARW, ORF, RW2, PEF, RAF), PSD/PSB, BMP and SVG, up to 200 MB.
- **Metadata:** EXIF (including vendor maker notes), XMP, IPTC, ICC profiles, Photoshop image resources, PNG text chunks, HEIF item properties, Multi-Picture Format and C2PA Content Credentials. Fields that are not decoded are listed with their tag ID and size rather than omitted.
- **Privacy findings:** GPS location, device serial numbers, names, embedded thumbnails, auxiliary images, hidden Photoshop layers, editor file paths, data after the end of the image, and scripts or external references in SVG files.
- **AI provenance:** IPTC digital source type, Content Credentials, AI content labels and generation settings written by common image generators. Results report what the file declares. They never classify an image as AI-generated or authentic.
- **Limits:** Content Credentials signatures are not verified. Brotli-compressed JPEG XL metadata boxes are listed but not decoded. Invisible watermarks cannot be detected from metadata.

Each metadata block is reported with its byte offset and length.

### File Inspector

Shows what any file reveals, up to 200 MB. Every file gets a general scan, and formats with their own parser get a full report.

- **Any file:** the true type from the file's content (about 90 signatures), names that contradict the content, data appended after the end of the file, files embedded inside it, private keys and certificates, and readable text that looks personal: emails, user names in file paths, network shares, internal host names, IP and MAC addresses, URLs and possible secrets such as API keys and tokens (shown masked).
- **Documents:** Word, Excel and PowerPoint (including macro-enabled and template variants), OpenDocument and EPUB. Properties, authors and editors, template paths, comments and tracked changes with their authors, hidden text, sheets, rows and slides, speaker notes, editing-session IDs, macros, embedded objects, printer names, external links and data connections. Photos inside documents go through the image inspector.
- **Remote content:** templates, images, links and fields that load from the internet when a document or PDF opens, which is how tracking pixels and canary tokens work.
- **PDF:** document information and XMP, earlier versions kept by incremental saves, JavaScript and actions, attachments, comments, filled-in form values, digital signatures and their signers, hidden layers, fonts, encryption settings, photos inside, and text covered by black boxes (reported as a clue).
- **Audio and video:** MP4, MOV, M4A and 3GP (including phone GPS location, make, model, creation dates and metadata tracks), MP3, AAC and MP2 (ID3, APE and Lyrics3 tags), FLAC, Ogg and Opus, WAV and AIFF (including Broadcast WAV and iXML), and Matroska and WebM tags and attachments. Cover art goes through the image inspector.
- **Archives:** ZIP entries, host system, user and group IDs, timestamps, comments, encrypted entries and leftover system files.
- **Programs:** Windows PE, ELF and Mach-O. Build times, compilers, debug file paths (which often contain a user name), version information, libraries, and code signatures with their signers. Signatures are read, not verified.
- **Plain text:** zero-width characters, text direction controls, invisible tag characters with the hidden text decoded, look-alike letters from other alphabets and terminal escape codes.

### Metadata Cleaner

Removes the metadata the inspectors find and copies everything else as is. Pixels, audio and video are never re-encoded.

- **Formats:** photos (JPEG, PNG, WebP, GIF), PDF, Word, Excel and PowerPoint files, OpenDocument files, EPUB, ZIP, audio and video (MP4, MOV, M4A, 3GP, MP3, MP2, AAC, WAV, AIFF, FLAC, Ogg, Opus, MKV, WebM) and plain text, up to 200 MB. Other files are refused with a reason and never altered.
- **Photos:** EXIF, XMP, IPTC, PNG text chunks, Content Credentials, thumbnails, comments, Photoshop data and data after the end of the image are removed. ICC color profiles and the EXIF Orientation value are kept so photos still display upright.
- **Documents:** properties, comments, people lists, editing-session IDs, document variables, thumbnails, printer settings and custom XML are removed, auto-loading remote content is cut off, photos inside are cleaned, and archive timestamps are reset. Hidden sheets, notes and embedded objects are document content and stay.
- **PDF:** the file is saved as one fresh revision, which drops earlier versions and unused objects, along with document information, XMP, JavaScript and automatic actions, attachments and comments. Photos inside are cleaned. Links stay clickable.
- **Audio and video:** tags, cover art, location, device details, metadata tracks and leftover data are removed, and creation times are zeroed. Container offsets are rewritten so the file still plays.
- **Options:** tracked changes, macros, digital signatures and filled-in PDF form fields change what a document says or does, so they stay unless you choose to accept changes, remove macros, remove signatures or clear form fields. A refused file can be retried with the option that applies.
- **Check:** every output is inspected again. If removable metadata remains, the format or dimensions change or the parser warns, no file is produced.
- **Limits:** invisible watermarks are not metadata and stay. Removing a phone photo's trailing gain map can flatten an HDR image. Cleaning a PDF removes fast web view.

### Archiver

Creates and opens archives in the browser.

- **Create:** ZIP (Deflate or Store, ZIP64 for large archives), 7z (LZMA2, up to 1 GB of input), tar and tar.gz, and gzip. Files and whole folders can be added.
- **Extract:** ZIP, 7z, RAR (versions 4 and 5), tar, gzip, xz, bzip2, zstd, lzma, lz4, ISO 9660, CAB, cpio and ar, through [libarchive](https://libarchive.org/) compiled to WebAssembly for the formats beyond ZIP, tar and gzip.
- **Encryption:** ZIP archives can be created and opened with WinZip AES-256. 7z archives encrypted with AES-256 can be opened, including encrypted file names. Legacy ZipCrypto archives open with a warning that the encryption is weak. Encrypted RAR archives cannot be opened.
- **Privacy:** "Remove hidden data" runs each file through Metadata Cleaner before it is added, and entries are written without timestamps, owner IDs, extra fields or comments unless you keep file dates. Any file in an opened archive can be inspected without extracting the rest.
- **Safety:** paths that climb out of the extraction folder are blocked, links are never extracted, and archives whose contents expand far beyond their size are stopped.
- **Limits:** Firefox and Safari keep the output in memory, which caps it at about 2 GB. Chromium writes straight to disk. RAR archives can be opened but not created.

### PDF Editor

Edits PDFs with [MuPDF](https://mupdf.com/) compiled to WebAssembly.

- **View:** continuous pages rendered sharply and only near the screen, page jumps, zoom (fit width, fit page or a percentage), view-only rotation, full screen, find with highlighted matches, text selection and copy, thumbnails, bookmarks and links (links to other sites open only after you confirm). New documents open here.
- **Organize:** merge files, reorder pages by drag or keyboard, rotate, duplicate, delete and insert blank pages, split by ranges, every N pages or one file per page, and extract pages. Undo, redo and reset.
- **Convert:** images to PDF (JPEGs are embedded without recompression and without their metadata) and pages to PNG or JPEG.
- **Protect:** AES-256 encryption with print, copy and edit permissions, and removal of a password you know.
- **Compress:** a lossless rewrite, plus optional lossy image downsampling.
- **Watermark and page numbers:** text watermarks and page-number formats such as "Page 1 of 9".
- **Redact:** search, common patterns (emails, phone numbers, SSNs, card numbers, IBANs, dates) or boxes drawn on the page. Text, image pixels, line art and form values under each box are deleted from the file, the redacted words are scrubbed from bookmarks, accessibility text, labels and links, and the file is rewritten as a single revision. Every result is checked before it is handed back: the redacted text must be gone from every page, object, stream and byte, or no file is produced. A rasterize mode turns marked pages into images. PDFs whose black boxes hide text that can still be copied are flagged.
- **Sign:** PAdES digital signatures (CMS SignedData, `/ETSI.CAdES.detached`) with RSA (PKCS #1 v1.5 or PSS) or ECDSA P-256 and P-384 keys from a .p12/.pfx file, visible in a box drawn on the page (text and an optional image) or invisible. The signature is appended as an incremental update, so earlier signatures stay valid, and the signed file is saved byte for byte. Older .p12 files with 3DES and RC2 encryption open too. Keys are imported into WebCrypto as non-extractable.
- **Verify:** every signature in the document: whether the signed bytes and the cryptographic signature match, what changed in later revisions, the signer's certificate and its chain. Certificates are trusted only when you import their root. Checking is offline: no revocation (CRL, OCSP) or timestamp checks.
- **Smart cards:** CAC, PIV, eID cards and USB tokens can sign through `local/signer/`, a small program you run yourself that serves the site on 127.0.0.1 and talks to the card through PKCS#11 (see its README). The hosted site never shows this option.
- **Save:** edits are applied, then hidden data is removed with Metadata Cleaner, then encryption is added. A freshly signed document is saved unchanged instead.
- **Limits:** existing text cannot be edited in place. Pages copied from a second file keep their content but lose links, comments and form fields. Saving other edits rewrites the file, which invalidates existing digital signatures, so sign last. Visible signature text uses Helvetica and covers Western European characters only. Redaction checks fragments shorter than four characters only in page text.

## Roadmap

| Tool | Status | Description |
|---|---|---|
| Image Inspector | Available | Lists image metadata and flags what it exposes. |
| File Inspector | Available | Shows what any file reveals: its true type, hidden text, user names, build paths, signatures and metadata. |
| Metadata Cleaner | Available | Removes metadata from photos, documents, PDFs, audio and video on your device and re-inspects the result. |
| Archiver | Available | Creates and opens ZIP, 7z, tar and gzip archives and extracts RAR, xz, ISO and more, with AES-256 encryption. |
| PDF Editor | Available | Views, merges, splits, reorders, rotates, protects, compresses, redacts and digitally signs PDFs and checks their signatures, using MuPDF in WebAssembly. Annotations and forms are next. |
| Photo Editor | Planned | A layered image editor with masks, adjustment layers, selections, filters and PSD support, based on the open-source PhotoCraft engine in WebAssembly. |
| Audio Editor | Planned | Records, cuts, mixes and cleans up audio on the device, based on the open-source SoundCraft engine in WebAssembly. |
| Office Viewer | Planned | Opens Word documents, spreadsheets and presentations without uploading them, based on the open-source WordCraft, GridCraft and DeckCraft engines. |
| QR Code Generator | Planned | Creates static QR codes that never expire and never route through a tracking redirect. |
| Image Redactor | Planned | Blurs, pixelates or blacks out faces, plates and account numbers by replacing the pixels, and strips metadata on save. |
| File Encryptor | Planned | Encrypts and decrypts files with a passphrase or public key in the open age format, compatible with the age command-line tool. |
| Background Remover | Planned | Separates the subject of a photo from its background with an openly licensed segmentation model that runs on the device. |
| Data Anonymizer | Planned | Detects personal data in CSV, Excel and JSON columns and masks, hashes, replaces or removes it. |
| Developer Tools | Planned | Formats JSON and YAML, diffs text, encodes Base64 and URLs and tests regular expressions, and warns when a paste contains a secret. |
| Password Generator | Planned | Generates passwords and passphrases with the Web Crypto random generator and estimates their strength offline. |
| PGP Tool | Planned | Encrypts, decrypts, signs and verifies messages and files with OpenPGP keys. |
| 2FA Backup Decoder | Planned | Reads authenticator export QR codes and otpauth links so two-factor accounts can be moved or backed up. |
| Private OCR | Planned | Extracts text from images and scanned documents on your device. |
| Image Converter | Planned | Converts HEIC to JPG and between other formats, resizes and compresses images without uploading them. |
| Resume ATS Preview | Planned | Shows the text an applicant tracking system extracts from a resume and flags formatting it cannot read. |
| Hash & Verify | Planned | Calculates MD5, SHA-1, SHA-256 and SHA-512 hashes of any file and checks them against an expected value. |
| Timestamp Decoder | Planned | Reads a raw number as Unix, Windows FILETIME, Apple, Chrome/WebKit, DOS and GPS time. |
| Email Header Analyzer | Planned | Traces the servers an email passed through and checks SPF, DKIM and DMARC results for spoofing. |
| Link & QR Inspector | Planned | Decodes QR codes, unwraps redirect links, flags look-alike domains and strips tracking parameters without opening the link. |
| Hex Viewer | Planned | Shows a file's raw bytes with the inspector's metadata blocks, hidden data and structures marked. |
| Windows Artifact Viewer | Planned | Parses shortcut files, Jump Lists, Prefetch, event logs, registry hives, thumbnail caches and browser history databases. |
| Packet Capture Viewer | Planned | Lists hosts, DNS queries, TLS server names, HTTP requests and transferred files in PCAP and PCAPNG captures. |
| Certificate & Token Decoder | Planned | Decodes PEM and DER certificates, certificate requests and JSON Web Tokens, with expiry and weak-key warnings. |
| Image Forensics | Planned | Shows JPEG quantization tables, double-compression clues, error level and noise views. Reports evidence, never a verdict. |

Planned improvements:

- [ ] Metadata Cleaner support for HEIC, AVIF and TIFF
- [ ] Offline support across page reloads (service worker)
- [x] PDF Editor: digital signatures with certificate files and signature verification
- [x] Smart card and USB token signing through a local companion program that is not part of the hosted site
- [ ] PDF Editor: annotations, form filling and OCR
- [ ] PDF Editor: signature timestamps and offline revocation data
- [ ] Content Credentials signature and trust-chain verification
- [ ] Decoding of Brotli-compressed JPEG XL metadata boxes

## Privacy model

- All parsing and cleaning runs in a Web Worker in the browser. No file data leaves the device.
- Pages are served with a Content Security Policy of `default-src 'self'` and `connect-src 'none'`, so the page cannot make network requests. The site itself loads no third-party scripts, fonts or analytics.
- Opening a file from one tool in another (for example from File Inspector into Metadata Cleaner) passes it through the browser's own storage. The file is encrypted with a fresh AES-GCM key that is kept only in that tab's session storage, so a copy left behind by an interrupted page change cannot be read after the tab closes. The receiving tool deletes the copy and the key as soon as it reads them, and any tool page deletes a leftover copy when it loads.
- The Archiver and PDF Editor pages also allow `'wasm-unsafe-eval'` and `connect-src 'self'`, so their workers can load their WebAssembly engines (libarchive, MuPDF) from the same site. They still cannot contact any other site.
- Signing keys from .p12/.pfx files stay in the browser as non-extractable WebCrypto keys. The local card signer (`local/signer/`) is not part of the hosted site: it runs on your own computer, listens on 127.0.0.1 only, accepts requests only from the pages it serves (exact Host and Origin checks plus a per-launch token) and receives only the 32- or 48-byte digest to sign, never the document.
- Extracted values are rendered as text only and are never interpreted as HTML.
- Parsers treat every input as hostile: reads are bounds-checked, directory loops are detected, and decompression, nesting depth and field counts are capped.

## Project structure

```
site/                    Deployable static site, served under /tools/
  _headers               Response headers, including the Content Security Policy
  tools/index.html       Tool catalog
  tools/assets/         Shared stylesheet, theme script, fonts and icons
  tools/image-inspector/ Image Inspector page, UI and worker
  tools/file-inspector/  File Inspector page, UI and worker
  tools/metadata-cleaner/ Metadata Cleaner page, UI and worker
  tools/archiver/        Archiver page, UI and workers
  tools/pdf-editor/      PDF Editor page, UI and workers
  tools/lib/metadata/    Parsers: images, families/ (documents, PDF, media, programs, general scan)
  tools/lib/clean/       Metadata removal for each format family
  tools/lib/zip/         ZIP reader and writer, AES encryption
  tools/lib/archive/     tar, gzip and archive handling for the Archiver
  tools/lib/pdf-editor/  PDF editing operations, viewer, redaction, signing (sign.js, cms.js, pkcs12.js, asn1.js)
  tools/vendor/mupdf/    MuPDF.js WebAssembly build
  tools/vendor/libarchive/ libarchive WebAssembly build, its build script and licenses
local/signer/            Local smart card signer (Go, PKCS#11). Not deployed: run it yourself
tests/                   Parser and browser tests, fixtures and reference data
server.js                Development server
wrangler.jsonc           Cloudflare Worker configuration
```

## Development

Requires Node.js 22 or later. The site has no runtime dependencies and no build step.

```sh
npm run dev       # serve site/ at http://127.0.0.1:4176/tools/ with the production headers
npm test          # parser and cleaner tests
```

`HOST` and `PORT` change the development server's address.

### Browser tests

`tests/browser.mjs` runs the inspector in Chromium with the network disabled. It checks that processing makes no network requests, that extracted HTML renders as text, and that the layout works at desktop and mobile widths. It needs `playwright-core` and a Chromium binary.

```sh
BASE=http://127.0.0.1:4176 CHROMIUM=/path/to/chromium npm run test:browser
```

`tests/browser-cleaner.mjs` does the same for the Metadata Cleaner. It cleans files offline, saves them and re-inspects the downloads.

```sh
BASE=http://127.0.0.1:4176 CHROMIUM=/path/to/chromium node tests/browser-cleaner.mjs
```

`tests/browser-files.mjs` checks the File Inspector the same way, with generated documents, PDFs, audio, programs and text files. `tests/browser-archiver.mjs` creates, encrypts and extracts archives in the Archiver. `tests/browser-pdf-editor.mjs`, `tests/browser-pdf-view.mjs`, `tests/browser-pdf-redact.mjs` and `tests/browser-pdf-sign.mjs` cover the PDF Editor, its viewer, its redaction panel and its signing panel. `local/signer/e2e.sh` runs the signing test with a SoftHSM token through the local card signer.

### Reference data

Parser output is compared with [ExifTool](https://exiftool.org/). `tests/fixtures/exiftool-reference.json` is generated by `tests/make-reference.sh`. `tests/vendor-check.mjs` compares maker notes and raw formats against the sample images that ship with ExifTool:

```sh
EXIFTOOL_DIR=/path/to/Image-ExifTool node tests/vendor-check.mjs
```

## Deployment

The site is deployed as a Cloudflare Worker with static assets:

```sh
npm run deploy
```

## License

The code is licensed under the [GNU Affero General Public License v3.0](LICENSE). The Private Tools name and logo are not covered by that license.

Third-party material:

- Some test fixtures come from the [C2PA reference implementation](https://github.com/contentauth/c2pa-rs) under MIT or Apache-2.0. See `tests/fixtures/NOTICE.md`.
- MuPDF.js is licensed under the AGPL-3.0. See `site/tools/vendor/mupdf/NOTICE`.
- libarchive and the compression libraries in its WebAssembly build (zlib, liblzma, bzip2, zstd, lz4) are under permissive licenses. See `site/tools/vendor/libarchive/NOTICE`, which `site/tools/vendor/libarchive/build/build.sh` regenerates.
- The Inter font is licensed under the SIL Open Font License. See `site/tools/assets/fonts/INTER-LICENSE.txt`.
