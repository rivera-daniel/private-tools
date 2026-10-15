// Writes sw-manifest.json for the service worker and stamps its version into sw.js. Run before every deploy.
// Usage: node scripts/build-sw-manifest.mjs [site directory]
//
// The site directory is the one Cloudflare serves (wrangler.jsonc "assets.directory"). The app is the folder
// in it that holds sw.js, and the URL path it is served under is worked out from where that folder sits, so
// the same script works whether the tools live at /tools/ or at the root of their own host.
//
// The shell is everything the catalog page loads. Each tool group is everything its page loads that is not
// in the shell, found by following the files each page and script references. Paths in the manifest are
// relative to the app folder. Hashes are SHA-256 of the file contents. The version covers every listed
// file and the response headers.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const site = path.resolve(process.argv[2] ?? 'site');
const app = [site, ...readdirSync(site).map((d) => path.join(site, d))].find((d) => existsSync(path.join(d, 'sw.js')));
if (!app) throw new Error(`no sw.js in ${site} or its subfolders`);
const base = path.relative(site, app) ? `/${path.relative(site, app).split(path.sep).join('/')}/` : '/';

const ASSET = /\.(?:m?js|wasm|css|woff2|svg|png)$/;
const SKIP = (rel) => rel.includes('/build/') || rel.endsWith('.d.ts') || rel === 'sw.js' || rel === 'sw-manifest.json';
const fileOf = (rel) => path.join(app, rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel);

// Paths, relative to the app folder, that one file references. Unknown references are ignored, a missing
// file referenced by an absolute path under the app is an error.
function references(rel) {
  const text = readFileSync(fileOf(rel), 'utf8');
  const url = base + rel;
  const found = new Set();
  const add = (ref, required) => {
    const resolved = new URL(ref, `http://x${url}`).pathname;
    if (!resolved.startsWith(base)) return;
    const target = resolved.slice(base.length);
    if (!ASSET.test(target) || SKIP(target)) return;
    if (existsSync(fileOf(target)) && statSync(fileOf(target)).isFile()) found.add(target);
    else if (required) throw new Error(`${url} references missing ${resolved}`);
  };
  const absolute = (ref) => ref.startsWith(base);
  if (fileOf(rel).endsWith('.html')) {
    for (const m of text.matchAll(/\b(?:href|src)="([^"#?:]+)"/g)) add(m[1], absolute(m[1]));
  } else if (rel.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(m[1], absolute(m[1]));
  } else if (rel.endsWith('.js')) {
    // Any string literal that names a file by path: imports, dynamic imports, workers and engine files.
    for (const m of text.matchAll(/(['"`])((?:\.{1,2}\/|\/)[^'"`\s$]+)\1/g)) add(m[2], absolute(m[2]));
    // Paths built from a directory constant, such as `${BASE}libarchive.js`.
    const consts = Object.fromEntries([...text.matchAll(/const (\w+) = '([^']*\/)'/g)].map((m) => [m[1], m[2]]));
    for (const m of text.matchAll(/`\$\{(\w+)\}([\w.-]+)`/g)) if (consts[m[1]]) add(consts[m[1]] + m[2], absolute(consts[m[1]]));
    // Emscripten loaders fetch their .wasm from the same directory by bare name.
    for (const m of text.matchAll(/["']([\w.-]+\.wasm)["']/g)) add('./' + m[1], false);
  }
  return found;
}

function closure(start) {
  const seen = new Set();
  const queue = [...start];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const ref of references(rel)) queue.push(ref);
  }
  return seen;
}

const pages = readdirSync(app).filter((d) => existsSync(path.join(app, d, 'index.html'))).map((d) => `${d}/`).sort();
const shell = closure(['', 'assets/theme.js', 'assets/favicon.svg']);
const tools = Object.fromEntries(pages.map((page) => [page, [...closure([page])].filter((p) => !shell.has(p)).sort()]));

const files = {};
for (const rel of [...shell, ...Object.values(tools).flat()].sort()) files[rel] ??= createHash('sha256').update(readFileSync(fileOf(rel))).digest('hex');
const version = createHash('sha256')
  .update(JSON.stringify(files))
  .update(existsSync(path.join(site, '_headers')) ? readFileSync(path.join(site, '_headers')) : '')
  .digest('hex').slice(0, 16);

const manifest = { version, shell: [...shell].sort(), tools, files };
writeFileSync(path.join(app, 'sw-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const swPath = path.join(app, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const stamped = sw.replace(/^const VERSION = '[^']*';$/m, `const VERSION = '${version}';`);
if (!stamped.includes(`const VERSION = '${version}';`)) throw new Error('sw.js has no VERSION line');
if (stamped !== sw) writeFileSync(swPath, stamped);

const size = (list) => list.reduce((n, rel) => n + statSync(fileOf(rel)).size, 0);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`sw-manifest ${version} for ${base}: shell ${manifest.shell.length} files, ${mb(size(manifest.shell))}`);
for (const [page, list] of Object.entries(tools)) console.log(`  ${page} ${list.length} files, ${mb(size(list))}`);
