# Test fixture sources

- `c2pa-CA.jpg`, `camera-no-manifest.jpg` and every file in `real/` are copied from the test fixtures of the C2PA reference implementation ([contentauth/c2pa-rs](https://github.com/contentauth/c2pa-rs), `sdk/tests/fixtures/`), licensed under MIT or Apache-2.0. `c2pa-CA.jpg` is `CA.jpg`, `camera-no-manifest.jpg` is `no_manifest.jpg`, and `real/purple-square.psd` is `Purple Square.psd`. The other names are unchanged.
- `base.jpg`, `base.png`, `base.webp` and the base images in `formats/` were generated with ImageMagick. The metadata in `formats/pii.*` was written with ExifTool. All names, places and serial numbers in it are fictitious.
- `exiftool-reference.json` is ExifTool output for the files above, produced by `../make-reference.sh`.
- Other inputs are built in memory by `build.js`.
