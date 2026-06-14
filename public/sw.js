/* UnGlutened service worker
   Strategy (this is an always-online app — freshness beats offline-first):
   - App shell (HTML/CSS/JS/icons/manifest): NETWORK-FIRST. Always serve the latest
     when online so a deploy is picked up immediately; fall back to cache offline.
     (Cache-first previously left returning visitors on a stale build until a reload.)
   - /api/*: network-first, fall back to cache only if offline.
   skipWaiting + clients.claim make a new SW take over right away. */

const CACHE_VERSION = 'unglutened-shell-v4';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/') || url.pathname === '/healthz';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET; never cache mutating requests or cross-origin calls.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isApiRequest(url)) {
    // Network-first for API + health: freshness matters more than offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Cache successful, non-opaque responses for offline fallback.
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // App shell: network-first — always prefer the freshest build when online,
  // and refresh the cache copy. Fall back to cache (then index.html) only offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('/index.html');
          return new Response('', { status: 504, statusText: 'offline' });
        })
      )
  );
});
