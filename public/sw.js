/* GridIron24 PWA service worker — shell cache only */
const CACHE = 'gi24-app-v21';
const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.css?v=21',
  '/app/app.js?v=21',
  '/manifest.webmanifest?v=21',
  '/assets/pwa/icon-192.png?v=21',
  '/assets/pwa/icon-512.png?v=21',
  '/assets/pwa/icon-maskable-512.png?v=21',
  '/assets/pwa/icon-192-transparent.png?v=21',
  '/assets/pwa/apple-touch-icon.png?v=21',
  '/assets/team-logo-placeholder.svg',
  '/assets/gridiron-bowl.png?v=2',
  '/assets/mayors-cup.png?v=4'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Always hit the network for APIs
  if (url.pathname.startsWith('/api/')) return;

  // App shell: network first, fall back to cache
  if (url.pathname === '/app' || url.pathname.startsWith('/app/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          if (url.pathname === '/app' || url.pathname === '/app/') {
            return caches.match('/app/index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        })
    );
  }
});
