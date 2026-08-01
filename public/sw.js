/* GridIron 24 PWA — app shell cache */
const CACHE = 'gi24-app-v78';
const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.css?v=78',
  '/app/app.js?v=78',
  '/manifest.webmanifest?v=78',
  '/assets/pwa/icon-192.png?v=78',
  '/assets/pwa/icon-512.png?v=78',
  '/assets/pwa/icon-maskable-512.png?v=78',
  '/assets/pwa/icon-192-transparent.png?v=78',
  '/assets/pwa/apple-touch-icon.png?v=78',
  '/assets/team-logo-placeholder.svg',
  '/assets/gridiron24-brand.png?v=3',
  '/assets/aaa-league.png?v=7',
  '/assets/gridiron-bowl.png?v=7',
  '/assets/mayors-cup.png?v=7'
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

  if (url.pathname === '/app' || url.pathname.startsWith('/app/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => {
            if (cached) return cached;
            if (url.pathname === '/app' || url.pathname === '/app/') {
              return caches.match('/app/index.html');
            }
            return undefined;
          })
        )
    );
  }
});
