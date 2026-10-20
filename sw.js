// Offline shell cache. Bump VERSION whenever any cached file changes.
const VERSION = 'tec-v3';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'vendor/supabase.js',
  'vendor/jszip.min.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase and other origins go straight to the network

  // config.js and the page itself: network first so edits always arrive, cache only as the offline fallback.
  const networkFirst = req.mode === 'navigate' || url.pathname.endsWith('/config.js');

  // Page loads: try the network (so updates arrive), fall back to the cached shell when offline.
  if (networkFirst) {
    const isPage = req.mode === 'navigate';
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(isPage ? 'index.html' : req, copy)); }
          return res;
        })
        .catch(() => (isPage ? caches.match('index.html').then((r) => r || caches.match('./')) : caches.match(req)))
    );
    return;
  }

  // Everything else: cached copy first, refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
