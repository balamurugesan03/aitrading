// VelocityX service worker: caches the app shell so the PWA opens instantly and offline.
// API calls and live data always go to the network (never served stale).
// Bump the version to drop every old cache on the next visit (v1 kept every build's files forever).
const CACHE = 'velocityx-shell-v2';
const MAX_ASSETS = 60; // old builds' /assets/ files are trimmed, oldest first, so the cache cannot keep growing
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/logo.png', '/favicon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  // Navigation: network first, fall back to the cached shell when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  // Static assets (hashed by Vite): cache first.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && url.pathname.startsWith('/assets/')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy).then(() => trimAssets(c)));
      }
      return res;
    })),
  );
});

// Keeps only the newest MAX_ASSETS hashed files (cache.keys() lists entries oldest first).
async function trimAssets(cache) {
  const assets = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith('/assets/'));
  await Promise.all(assets.slice(0, Math.max(0, assets.length - MAX_ASSETS)).map((r) => cache.delete(r)));
}
