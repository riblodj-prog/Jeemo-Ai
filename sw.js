/**
 * Jeemo Service Worker
 * Caches Pyodide files permanently after first download.
 * On subsequent loads, Pyodide loads instantly from cache.
 */
const CACHE = 'jeemo-pyodide-v1';
const PYODIDE_ORIGIN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Only cache Pyodide CDN files (JS, WASM, data files)
  if (url.startsWith(PYODIDE_ORIGIN) && url.includes('pyodide')) {
    e.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) return cached; // instant from cache
        // Not cached yet — fetch, store, return
        const response = await fetch(e.request);
        if (response.ok) cache.put(e.request, response.clone());
        return response;
      }).catch(() => fetch(e.request))
    );
  }
});
