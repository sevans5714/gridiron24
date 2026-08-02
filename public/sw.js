/* GridIron 24 PWA — app shell cache */
const CACHE = 'gi24-app-v104';
const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.css?v=104',
  '/app/app.js?v=104',
  '/manifest.webmanifest?v=104',
  '/assets/pwa/icon-192.png?v=104',
  '/assets/pwa/icon-512.png?v=104',
  '/assets/pwa/icon-maskable-512.png?v=104',
  '/assets/pwa/icon-192-transparent.png?v=104',
  '/assets/pwa/apple-touch-icon.png?v=104',
  '/assets/team-logo-placeholder.svg',
  '/assets/gridiron24-brand.png?v=3',
  '/assets/aaa-league.png?v=7',
  '/assets/gridiron-bowl.png?v=7',
  '/assets/mayors-cup.png?v=7'
];

function isCacheableShellResponse(url, res) {
  if (!res || !res.ok || res.type === 'opaqueredirect') return false;
  // Never store the auth gate HTML as JS/CSS
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (url.includes('.js') && !ct.includes('javascript')) return false;
  if (url.includes('.css') && !ct.includes('css')) return false;
  if (url.includes('.webmanifest') && !(ct.includes('json') || ct.includes('manifest'))) return false;
  if (/\.(png|jpe?g|webp|svg)(\?|$)/i.test(url) && !(ct.includes('image') || ct.includes('svg'))) return false;
  return true;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(SHELL.map(async (url) => {
        const res = await fetch(url, { credentials: 'same-origin', redirect: 'follow' });
        if (!isCacheableShellResponse(url, res)) {
          // index.html /app/ may require auth — skip rather than poison the cache
          if (url === '/app/' || url === '/app/index.html') return;
          throw new Error('Bad shell response for ' + url);
        }
        await cache.put(url, res.clone());
      }));
      await self.skipWaiting();
    })
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
          if (isCacheableShellResponse(url.pathname + url.search, res)) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
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
