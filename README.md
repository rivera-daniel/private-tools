# Private Tools

Browser-based file utilities that run entirely on your device. Files are processed locally in the browser and are never uploaded.

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

### Metadata Cleaner

Removes the metadata blocks the inspector finds, without decoding or re-encoding the image.

- **Formats:** JPEG, PNG, WebP and GIF, up to 200 MB. Other formats are refused with a reason and never altered.
- **Removed:** EXIF, XMP, IPTC, PNG text chunks, Content Credentials, thumbnails, comments, Photoshop data, unknown application data and any data after the end of the image.
- **Kept:** image data, ICC color profiles and the EXIF Orientation value, which is rewritten as a minimal EXIF block so rotated photos still display upright.
- **Check:** every output is inspected again. If metadata remains, the dimensions change or the parser warns, no file is produced.
- **Limits:** invisible watermarks are not metadata and stay. Removing a phone photo's trailing gain map can flatten an HDR image.

## Roadmap

| Tool | Status | Description |
|---|---|---|
| Image Inspector | Available | Lists image metadata and flags what it exposes. |
| Metadata Cleaner | Available | Removes metadata from JPEG, PNG, WebP and GIF files on your device and re-inspects the result. |
| PDF Privacy Cleaner | Planned | Inspects PDF metadata, hidden content and embedded files, and prepares a cleaner copy to share. |
| Private OCR | Planned | Extracts text from images and scanned documents on your device. |
| Image Converter | Planned | Converts, resizes and compresses images without uploading them. |
| Resume ATS Preview | Planned | Shows the text an applicant tracking system extracts from a resume and flags formatting it cannot read. |

Planned improvements:

- [ ] Metadata Cleaner support for HEIC, AVIF and TIFF
- [ ] Offline support across page reloads (service worker)
- [ ] Content Credentials signature and trust-chain verification
- [ ] Decoding of Brotli-compressed JPEG XL metadata boxes

## Privacy model

- All parsing runs in a Web Worker in the browser. No file data leaves the device.
- Pages are served with a Content Security Policy of `default-src 'self'` and `connect-src 'none'`, so the page cannot make network requests. The site itself loads no third-party scripts, fonts or analytics.
- Opening an inspected image in Metadata Cleaner passes the file through the browser's own storage (IndexedDB). The cleaner deletes it as soon as it reads it, and any tool page deletes a leftover copy when it loads.
- Extracted values are rendered as text only and are never interpreted as HTML.
- Parsers treat every input as hostile: reads are bounds-checked, directory loops are detected, and decompression, nesting depth and field counts are capped.

## Project structure

```
site/                    Deployable static site, served under /tools/
  _headers               Response headers, including the Content Security Policy
  tools/index.html       Tool catalog
  tools/assets/         Shared stylesheet, theme script, fonts and icons
  tools/image-inspector/ Image Inspector page, UI and worker
  tools/metadata-cleaner/ Metadata Cleaner page, UI and worker
  tools/lib/clean/       Lossless metadata removal
  tools/lib/metadata/    Metadata parsers (ES modules, no dependencies)
tests/                   Parser and browser tests, fixtures and reference data
server.js                Development server
wrangler.jsonc           Cloudflare Worker configuration
```

## Development

Requires Node.js 22 or later. The site has no runtime dependencies and no build step.

```sh
npm run dev       # serve site/ at http://127.0.0.1:4176/tools/ with the production headers
npm test          # parser tests
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
