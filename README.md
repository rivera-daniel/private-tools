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

## Roadmap

| Tool | Status | Description |
|---|---|---|
| Image Inspector | Available | Lists image metadata and flags what it exposes. |
| File Inspector | Available | Shows what any file reveals: its true type, hidden text, user names, build paths, signatures and metadata. |
| Metadata Cleaner | Available | Removes metadata from photos, documents, PDFs, audio and video on your device and re-inspects the result. |
| Private OCR | Planned | Extracts text from images and scanned documents on your device. |
| Image Converter | Planned | Converts, resizes and compresses images without uploading them. |
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
- [ ] Content Credentials signature and trust-chain verification
- [ ] Decoding of Brotli-compressed JPEG XL metadata boxes

## Privacy model

- All parsing and cleaning runs in a Web Worker in the browser. No file data leaves the device.
- Pages are served with a Content Security Policy of `default-src 'self'` and `connect-src 'none'`, so the page cannot make network requests. The site itself loads no third-party scripts, fonts or analytics.
- Opening an inspected file in Metadata Cleaner passes the file through the browser's own storage (IndexedDB). The cleaner deletes it as soon as it reads it, and any tool page deletes a leftover copy when it loads.
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
  tools/lib/metadata/    Parsers: images, families/ (documents, PDF, media, programs, general scan)
  tools/lib/clean/       Metadata removal for each format family
  tools/lib/zip/         ZIP reader and writer
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

`tests/browser-files.mjs` checks the File Inspector the same way, with generated documents, PDFs, audio, programs and text files.

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
- The Inter font is licensed under the SIL Open Font License. See `site/tools/assets/fonts/INTER-LICENSE.txt`.
