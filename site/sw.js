// Service worker that keeps Private Tools working offline after a page has been opened once.
//
// It only ever stores the site's own files, listed with their SHA-256 hashes in sw-manifest.json. Files you
// open in a tool never pass through it: they are read from disk by the page and never requested over the network.
//
// - Install stores the shell (catalog, shared styles, scripts, font and icon) in a cache named after the version.
// - Opening a tool page stores that tool's files, including its WebAssembly engine, in the same cache.
// - Every stored file is checked against its hash, so one cache never holds files from two deploys.
// - Pages and files are served from the cache first and from the network until they are stored.
// - A new deploy changes VERSION, so the browser installs a new worker. It reuses unchanged files from the old
//   cache, downloads the rest and waits. The next page load with only one tab open asks it to take over and
//   reloads (see theme.js). The old cache is deleted when it takes over.
//
// Paths in the manifest are relative to the worker's scope, so the site can be served under any path.
const VERSION = '3e812b43d96fb3e9';
const PREFIX = 'private-tools-';
const CACHE = PREFIX + VERSION;
const SCOPE = self.registration.scope;
const MANIFEST = new URL('sw-manifest.json', SCOPE).href;
const SELF = new URL('sw.js', SCOPE).href;
const PARALLEL = 4;
const at = (path) => new URL(path, SCOPE).href;

let current; // this version's manifest, once read
const pending = new Map(); // group fills in progress, by page

async function manifest() {
  if (current) return current;
  const stored = await (await caches.open(CACHE)).match(MANIFEST);
  if (!stored) throw new Error('not installed');
  return (current = await stored.json());
}

async function hex(buffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const storedUrls = async (cache) => new Set((await cache.keys()).map((r) => r.url));

// The newest other version's cache and manifest, to copy unchanged files from.
async function previous() {
  for (const name of (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== CACHE).reverse()) {
    const cache = await caches.open(name);
    const stored = await cache.match(MANIFEST);
    if (stored) return { cache, manifest: await stored.json(), urls: await storedUrls(cache) };
  }
  return null;
}

// Stores every listed file that is not stored yet. Throws if any file cannot be fetched or fails its hash.
async function fill(cache, m, list, old) {
  const have = await storedUrls(cache);
  const todo = list.filter((p) => !have.has(at(p)));
  const one = async (p) => {
    if (old && old.manifest.files[p] === m.files[p]) {
      const copy = await old.cache.match(at(p));
      if (copy) return cache.put(at(p), copy);
    }
    const res = await fetch(at(p), { cache: 'reload', credentials: 'same-origin', redirect: 'error' });
    if (res.status !== 200 || res.type !== 'basic') throw new Error(`${p}: ${res.status}`);
    const body = await res.arrayBuffer();
    if (await hex(body) !== m.files[p]) throw new Error(`${p}: content does not match this version`);
    // The body is stored decoded, so the transfer headers no longer describe it. The rest, including the
    // page's Content Security Policy, is kept and applies when the page is served from the cache.
    const headers = new Headers(res.headers);
    headers.delete('Content-Encoding');
    headers.delete('Content-Length');
    await cache.put(at(p), new Response(body, { status: 200, headers }));
  };
  await Promise.all(Array.from({ length: PARALLEL }, async () => { while (todo.length) await one(todo.shift()); }));
}

async function install() {
  const m = await (await fetch(MANIFEST, { cache: 'no-store', credentials: 'same-origin' })).json();
  if (m.version !== VERSION) throw new Error('sw.js and sw-manifest.json are from different deploys');
  const cache = await caches.open(CACHE);
  const old = await previous();
  await fill(cache, m, m.shell, old);
  // Tools that were available offline before stay available. A tool that cannot be refreshed now is
  // stored again the next time its page opens.
  if (old) {
    for (const [page, list] of Object.entries(m.tools)) {
      const before = old.manifest.tools[page];
      if (before && before.every((p) => old.urls.has(at(p)))) await fill(cache, m, list, old).catch(() => {});
    }
  }
  // Written last: a cache with a manifest is complete for its shell.
  await cache.put(MANIFEST, new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }));
}

self.addEventListener('install', (event) => event.waitUntil(install()));

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
})()));

// Stores the files a page needs. Resolves true once the page works offline.
function cachePage(page) {
  if (!pending.has(page)) {
    pending.set(page, (async () => {
      const m = await manifest();
      const list = page === '' ? [] : m.tools[page];
      if (!list) return false;
      await fill(await caches.open(CACHE), m, [...m.shell, ...list], null);
      return true;
    })().catch(() => false).finally(() => pending.delete(page)));
  }
  return pending.get(page);
}

self.addEventListener('message', (event) => {
  const { type, url } = event.data ?? {};
  const port = event.ports[0];
  if (type === 'cache' && port && typeof url === 'string' && url.startsWith(SCOPE)) {
    const page = new URL(url).pathname.slice(new URL(SCOPE).pathname.length);
    event.waitUntil(cachePage(page).then((ok) => port.postMessage({ ok })));
  } else if (type === 'tabs' && port) {
    event.waitUntil(self.clients.matchAll({ type: 'window' }).then((tabs) => port.postMessage({ count: tabs.length })));
  } else if (type === 'activate') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  url.search = ''; url.hash = '';
  if (!url.href.startsWith(SCOPE) || url.href === SELF || url.href === MANIFEST) return;
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(url.href)).then((hit) => hit ?? fetch(request)));
});
