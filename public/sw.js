const CACHE_NAME = 'order-report-shell-v8';
const SHELL = ['./', './index.html', './styles.css', './app.js', './shared/domain.js', './manifest.webmanifest'];
const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, self.location.href).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((key) => key.startsWith('order-report-shell') && key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only the immutable application shell belongs in this cache. In particular,
  // never intercept authenticated sync URLs: apiBase may point at a same-origin
  // subpath whose pathname does not start with `/api/`.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin
    || event.request.headers.has('X-Sync-Token') || !SHELL_URLS.has(url.href)) return;
  event.respondWith(fetch(event.request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
      }
      return response;
    })
    .catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return Response.error();
    }));
});
