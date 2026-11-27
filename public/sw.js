// TrolleyScout service worker. Keeps the home page, its files and the latest public prices, so the
// shopping list still opens with a weak signal in the shop. Network first: online, you always get
// fresh pages and prices. It never handles sign-in, account, admin or any other API request.
const CACHE = 'ts-shell-v1';
const SHELL = [
  '/', '/css/app.css', '/js/app.js', '/js/ui.js', '/js/pricing.js', '/js/itemform.js', '/js/report.js', '/js/shop.js',
  '/fonts/anton.woff', '/fonts/fira-400.woff', '/fonts/fira-600.woff', '/fonts/anonpro-400.woff', '/fonts/anonpro-700.woff',
  '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png',
];
const DEALS = '/api/deals';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** The cache key for requests we keep, or null to leave the request alone. */
function keyFor(req) {
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== 'GET') return null;
  if (req.mode === 'navigate') return url.pathname === '/' ? '/' : null;
  if (url.search !== '') return null;
  if (url.pathname === DEALS || SHELL.includes(url.pathname)) return url.pathname;
  return null;
}

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  const live = fetch(req).then(async (res) => {
    if (res.ok && res.type === 'basic' && !res.redirected) await cache.put(key, res.clone());
    return res;
  });
  live.catch(() => {});
  try {
    return await Promise.race([live, new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 5000))]);
  } catch {
    return (await cache.match(key)) || live;
  }
}

self.addEventListener('fetch', (e) => {
  const key = keyFor(e.request);
  if (key) e.respondWith(networkFirst(e.request, key));
});
