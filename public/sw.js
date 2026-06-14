/* UnGlutened service worker
   Strategy (this is an always-online, multi-user app — freshness & correctness
   beat offline-first):
   - App shell (HTML/CSS/JS/icons/manifest): NETWORK-FIRST. Always serve the latest
     when online so a deploy is picked up immediately; fall back to cache offline.
   - /api/* and /healthz: NETWORK-ONLY. NEVER cached. Caching authenticated,
     user-specific API responses keyed by URL is unsafe — on a network hiccup the
     SW could serve one user's cached data (or a stale logged-out auth state) to a
     different session. So we never store or serve API responses from cache.
   skipWaiting + clients.claim make a new SW take over right away. */

const CACHE_VERSION = 'unglutened-shell-v5';
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
    // Network-ONLY. Never cache or serve user-specific API data from cache —
    // that could leak one account's data to another or show stale auth state.
    // If offline, the request simply fails and the app surfaces it honestly.
    event.respondWith(fetch(req));
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
