/* UnGlutened service worker
   Strategy:
   - App shell (HTML/CSS/JS/icons/manifest): cache-first, refreshed in the background.
   - /api/*: network-first (always prefer fresh data), fall back to cache only if offline.
   Bump CACHE_VERSION whenever the shell asset list changes to force an update. */

const CACHE_VERSION = 'unglutened-shell-v3';
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

  // App shell: cache-first with background refresh (stale-while-revalidate).
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      // For navigations, prefer cache but fall back to index.html so deep links work offline.
      if (cached) return cached;
      return networkFetch.then((res) => {
        if (res) return res;
        if (req.mode === 'navigate') return caches.match('/index.html');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
