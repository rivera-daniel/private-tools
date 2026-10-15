// Development server: serves site/ with the response headers declared in site/_headers.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('site');
const port = Number(process.env.PORT || 4176);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
// Like Cloudflare: every matching rule applies in order, and "! Name" removes a header set by an earlier rule.
const rules = (await readFile(path.join(root, '_headers'), 'utf8')).split(/\n(?=\S)/).map((block) => {
  const [pattern, ...lines] = block.trim().split('\n');
  return {
    re: new RegExp(`^${pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
    unset: lines.map((l) => l.trim()).filter((l) => l.startsWith('!')).map((l) => l.slice(1).trim().toLowerCase()),
    headers: lines.map((l) => l.trim().split(/:\s(.+)/)).filter((h) => h[1]),
  };
});
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/tools') { res.writeHead(302, { Location: '/tools/' }); res.end(); return; }
  const filename = path.resolve(root, '.' + decodeURIComponent(url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
  if (!filename.startsWith(root + path.sep) || path.basename(filename) === '_headers') { res.writeHead(404); res.end(); return; }
  try {
    const body = await readFile(filename);
    const headers = { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    for (const rule of rules) {
      if (!rule.re.test(url.pathname)) continue;
      for (const name of rule.unset) for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k];
      for (const [k, v] of rule.headers) headers[k] = v;
    }
    res.writeHead(200, headers); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, host, () => console.log(`Private Tools: http://${host}:${port}/tools/`));
