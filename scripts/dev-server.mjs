// Local server that behaves like the Vercel deployment: /api/<name> runs api/<name>.js and every
// other path is served from public/ with the same headers, clean URLs and 404 page as vercel.json.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function staticHeaders(urlPath) {
  const out = {};
  for (const rule of config.headers || []) {
    if (new RegExp(`^${rule.source}$`).test(urlPath)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

function resolveStatic(urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p.split('/').some((seg) => seg.startsWith('.'))) return null; // no dotfiles
  if (p.endsWith('/')) p += 'index';
  const candidates = path.extname(p) ? [p] : [`${p}.html`];
  for (const c of candidates) {
    const full = path.resolve(PUBLIC, `.${c}`);
    if (!full.startsWith(PUBLIC + path.sep)) return null;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

const handlers = new Map();
async function apiHandler(name) {
  if (!/^[a-z]+$/.test(name)) return null;
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!fs.existsSync(file)) return null;
  if (!handlers.has(name)) handlers.set(name, (await import(pathToFileURL(file).href)).default);
  return handlers.get(name);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const api = /^\/api\/([^/]+)$/.exec(url.pathname);
    if (api) {
      const fn = await apiHandler(api[1]);
      if (fn) return fn(req, res);
    }
    if (url.pathname.endsWith('.html') && url.pathname !== '/index.html') {
      // cleanUrls: /account.html -> /account
      res.writeHead(308, { Location: url.pathname.slice(0, -5) });
      return res.end();
    }
    const file = url.pathname.startsWith('/api/') ? null : resolveStatic(url.pathname === '/' ? '/index' : url.pathname);
    const headers = staticHeaders(url.pathname);
    if (!file) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(PUBLIC, '404.html')));
    }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`TrolleyScout dev server on http://127.0.0.1:${PORT}`));
