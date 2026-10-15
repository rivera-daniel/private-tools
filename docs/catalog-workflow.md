# Adding tools to the Toolkit

The registry in `site/tools/assets/catalog-data.js` is the source of truth for the catalog, roadmap, category filters and search. Do not hand-edit generated `site/tools/index.html` or `site/tools/roadmap/index.html`.

## Add or release a tool

1. Add a `TOOLS` entry with a unique `name`, a factual `copy` description, an existing `group` ID and an `art` key. Keep descriptions specific to supported behavior. Add a category to `GROUPS` only when needed.
2. For a planned tool, set `stage` to `Next`, `Then`, `Later` or `Last`, omit `href`, and add its illustration as described below. To release it, set `stage: null`, supply its local `/tools/<slug>/` URL, and ensure that page exists. Update the existing entry rather than creating a duplicate.
3. Add a detailed description under `DETAILS[tool.name]` for every released tool. Both descriptions are rendered into static HTML, so they remain readable without JavaScript. Keep the current indexing policy unchanged unless publication requirements explicitly change.
4. Add a matching illustrated icon. Released originals live in `catalog-illustrations.js`; roadmap artwork and palettes live in `roadmap-illustrations.js`, whose keys automatically join `ILLUSTRATION_KINDS`. Add the tile colors and artwork under the same key and use that `art` key in the registry. Cards, hero shortcuts, roadmap rows and search results all use the same renderer. No separate small icon variant is needed.
5. Regenerate, verify, and commit the registry, artwork, generated HTML and any relevant tests together.

```js
// Example registry entry. Only mark available after the tool actually ships.
{ name: 'Example Tool', copy: 'Explain its primary supported operation.',
  group: 'files', stage: null, art: 'example', href: '/tools/example-tool/' }
// In DETAILS:
'Example Tool': 'Describe supported formats and useful capabilities in more detail.'
```

## Visual consistency

- Cards, hero shortcuts, roadmap rows and search results call the same `illustration(art, id)` renderer. Never create separate hero artwork or use screenshots as card decoration.
- Use the existing 128 × 128 SVG canvas, rounded tile, restrained gradient, light paper/objects and soft shadow. Match the current icon proportions and detail. Icons must remain legible at mobile shortcut sizes.
- Use the supplied ID prefix for every SVG gradient/filter reference. Cards use `card-<slug>-`, hero icons use `hero-<slug>-`, roadmap rows use `roadmap-<slug>-` and search uses `search-<index>-`. Duplicate SVG IDs can cause the wrong colors or filters to render.
- Keep card spacing, type, action placement and responsive sizing in `catalog.css`. Do not add inline per-card layout overrides. Site surfaces and text use shared theme tokens.
- The first five available registry entries appear in the hero, in registry order. Every available entry appears in the grid. Reorder deliberately when changing featured shortcuts. The hero does not expand with the catalog.
- Search includes available and planned tools. The roadmap contains planned entries only. Counts and category options derive from the registry.

## Verification

```sh
node scripts/render-catalog.mjs
npm test
# With the checkout served by npm run dev in another terminal:
BASE=http://127.0.0.1:4176 PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs CHROMIUM=/path/to/chromium node tests/browser-catalog.mjs
```

The generator refuses any entry without a registered illustration, and released entries without descriptions or existing local tool pages. Browser checks cover static descriptions, card/hero icon counts, navigation, search, category filtering and light/dark layouts at 320, 390, 820 and 1440px. Review the screenshots in `test-results/catalog` as well, including the new icon at its smallest size. Verify regeneration leaves no uncommitted HTML differences after committing.

Adding a card does not publish a release. Merge, push and deployment remain separate operator-authorized actions.
