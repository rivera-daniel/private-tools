# Catalog screenshots

Real Chromium screenshots of shipped tools, captured at source revision 2f3318c6fdf64d81d80da6325733a84e8c7b6198. No UI text, results, or controls were reconstructed or replaced. PNG originals and machine-readable evidence are saved in CAPTURE_DIR (default: a fresh private-tools-previews- directory under the OS temporary directory). WebP conversion changes encoding only.

Refresh with a static server for this checkout:

`BASE=http://127.0.0.1:4198 PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node scripts/capture-catalog-previews.mjs`

Optional: CHROMIUM, CONVERT, CAPTURE_DIR. Requires Node, Chromium, ImageMagick and Playwright Core.

Samples are code-generated, public-safe fictional fixtures: abstract landscape JPEG with Canon/GPS tags pointing to central Austin (not a private residence), synthetic DOCX from existing test fixtures, fictional project PDF generated with MuPDF, plain release notes and a ZIP of those files. Device metadata is synthetic. Screens show actual inspection, completed cleaning, loaded archive listing, and rendered PDF state. These are demonstrations, not security certifications.

1100 x 900 browser, dark system/saved theme. Main populated output is cropped to at most 740px high.

| Asset | Raw PNG SHA-256 | WebP bytes |
|---|---|---|
| image-inspector.webp | 1ff27296bfc3ce723e19b313642ca60ce231756333e1f1e1b20c1e4c9ed190a2 | 34144 |
| file-inspector.webp | 0f7bcc5036d36c5a867b051e80d65c031bd1e792e0bf500a666390eac5e1849e | 32628 |
| metadata-cleaner.webp | 091cd233a09c6b5c62ca7cb5d5b4fd871fb737f2851a5a80b1cf05777cde7a39 | 22646 |
| archiver.webp | 947c2e154a09701604f4528bf556ba14e97f47bc591485327b0898203a55fbc4 | 22910 |
| pdf-editor.webp | d7b6225e796b3dc7f20530a00a03973fd08ec636a0fdc69fdd3b26cb4dea45e7 | 23066 |
