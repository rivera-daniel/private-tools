# Contributing

Private Tools is a set of privacy tools that run entirely in the browser. Files never leave the device. Every change has to keep that true, so this guide puts the privacy rules first and the mechanics second.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in an issue or pull request.

## Ground rules

1. **No network access.** Pages are served with `connect-src 'none'`. The Archiver and PDF Editor are the only exceptions: they allow `connect-src 'self'` and `'wasm-unsafe-eval'` so they can load their own WebAssembly. Do not add analytics, fonts, CDNs, telemetry or any other request to another origin.
2. **No uploads, accounts or server-side processing.** If a feature needs a server, it does not belong here.
3. **No inline script or style.** The Content Security Policy in `site/_headers` blocks both. Put code in `.js` files and styles in `.css` files.
4. **Treat every input as hostile.** Parsers run in Web Workers, enforce size, depth and time limits, and render extracted values as text, never as HTML.
5. **Tell the truth about what was cleaned.** The cleaner re-inspects every output. If the inspector could not fully read a file, the report is incomplete and the cleaner refuses it rather than guessing. Never report metadata as removed unless the re-inspection confirms it.
6. **Do not break the file.** Remove metadata without touching image, audio, video or document content. When a change could alter content, refuse and name the option that would allow it.
7. **No build step and no runtime dependencies.** `site/` is served as it is.

## Dependencies

Third-party code is vendored under `site/vendor/`, pinned to an exact version, with its license and a `NOTICE` that records where it came from and how it was built. Its license must be compatible with AGPL-3.0. Open an issue before adding one, because every dependency also has to work under the Content Security Policy.

## Development

You need Node.js 22 or later.

```sh
npm run dev       # serve site/ with the production headers; prints the local URL
npm test          # parser, cleaner and editor tests
```

The browser tests need `playwright-core` and a Chromium binary. Each one runs a tool with the network disabled:

```sh
BASE=http://127.0.0.1:4176 CHROMIUM=/path/to/chromium node tests/browser.mjs
```

The README lists every browser suite and what it covers. Run the suites for each tool you change.

## Changes

- Keep a pull request to one change. Open an issue before starting large features or new tools.
- Add tests with the change. Parser and cleaner fixes need a fixture that failed before the fix. Hostile-input fixes need the hostile input or a generator for it.
- Do not commit personal files, real documents or images that carry metadata about real people. Generate fixtures in code where you can.
- Run `node scripts/build-sw-manifest.mjs` after changing any file under `site/` and commit the result. The offline service worker installs only when its manifest matches the files, and `npm test` checks this.
- Update the README when behaviour, formats or limits change.
- Match the surrounding code. There is no formatter, so follow the style of the file you are editing.

### Commit messages

Write the subject as one plain sentence in the imperative that says what the change does for someone using the tools. Start with the tool or area and a colon when the change is confined to one:

```
Archiver: refuse compressed tars whose declared sizes make them bombs
PDF Editor: View mode with continuous pages, zoom and find
Fix MP4 cleaning when a metadata box ends where the trailer starts
```

Do not use type prefixes such as `feat:` or `fix:`. Add a body only when the reason for the change is not obvious from the subject.

### Pull requests

Title the pull request the same way as a commit subject. The template asks what changed, how you tested it, and to confirm the ground rules above. Pull requests are squash-merged, so the title becomes the commit subject on `main`.

## License

Private Tools is licensed under [AGPL-3.0-only](LICENSE). By opening a pull request you agree that your contribution is licensed under the same terms.
