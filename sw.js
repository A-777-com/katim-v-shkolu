const CACHE_NAME = 'katim-v2';
const TILE_CACHE = 'katim-tiles-v1';
const MAX_TILES = 500;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== TILE_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.hostname.includes('tile.openstreetmap.org')) {
    e.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(e.request).then(r => {
          if (r) return r;
          return fetch(e.request).then(resp => {
            if (resp.ok) {
              cache.put(e.request, resp.clone());
              cache.keys().then(keys => {
                if (keys.length > MAX_TILES) cache.delete(keys[0]);
              });
            }
            return resp;
          }).catch(() => new Response('', { status: 408 }));
        })
      )
    );
    return;
  }

  if (url.hostname.includes('router.project-osrm.org') ||
      url.hostname.includes('nominatim.openstreetmap.org')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});