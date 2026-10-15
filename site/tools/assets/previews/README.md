# Catalog screenshots

Real Chromium screenshots of shipped tools, captured at source revision c0db5e7654abc4ac90c87257ae9717de0f11635f. No UI text, results, or controls were reconstructed or replaced. PNG originals and machine-readable evidence are saved in CAPTURE_DIR (default: a fresh private-tools-previews- directory under the OS temporary directory). WebP conversion changes encoding only.

Refresh with a static server for this checkout:

`BASE=http://127.0.0.1:4198 PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node scripts/capture-catalog-previews.mjs`

Optional: CHROMIUM, CONVERT, CAPTURE_DIR, IMAGE_INSPECTOR_SAMPLE (path to an operator-approved sample image), IMAGE_INSPECTOR_SAMPLE_NAME (display filename). Requires Node, Chromium, ImageMagick and Playwright Core.

Image Inspector sample: operator-supplied image, original not committed; SHA-256 b0ddcbdda808ff5968f157190b3ea17503f96ccdf6b932ca3160497346fb06a0. Other samples are code-generated, public-safe fictional fixtures: abstract landscape JPEG with Canon/GPS tags pointing to central Austin (not a private residence), synthetic DOCX from existing test fixtures, fictional project PDF generated with MuPDF, plain release notes and a ZIP of those files. Device metadata is synthetic. Screens show actual inspection, completed cleaning, loaded archive listing, and rendered PDF state. These are demonstrations, not security certifications.

760 x 900 browser at 2x pixel density, dark system/saved theme. The top of populated output is cropped to the card’s 11:7 ratio and encoded as lossless WebP.

| Asset | Raw PNG SHA-256 | WebP bytes |
|---|---|---|
| image-inspector.webp | a518f43c6313a8b7a2a877a7fdf8c624fda97702f0caeefffb93710c543c674a | 220108 |
| file-inspector.webp | 1596ddd9d2c41be7f73c8e6dd5c605aecc273acc7f50e953c302d1bce63c0cc5 | 143902 |
| metadata-cleaner.webp | 925a4a96e6992b0e2d4427add5c01103ebe2b92fd3a79fbda86a72f6b7438462 | 44194 |
| archiver.webp | e195c371a7639b3ed6de3d5ef499c165997388c0058bf7bd2bf4c257bbfc45b3 | 80276 |
| pdf-editor.webp | 81fbe5ca3711ce610fa2192d1a717fd962a3e1986920db39aee52e17746ebd05 | 74474 |
