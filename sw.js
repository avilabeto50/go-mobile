/**
 * sw.js — Service Worker for Go Mobile PWA
 * Cache-first strategy: all assets cached on install, served offline.
 */

const CACHE_NAME = 'go-mobile-v2';  // bump version to re-cache

const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './gnugo.wasm',
  './gnugo.js',
  './src/style.css',
  './src/rules.js',
  './src/gnugo.js',
  './src/app.js',
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache all assets; gnugo.wasm is large but cached after first load
      return Promise.allSettled(ASSETS.map((url) => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evt) => {
  evt.respondWith(
    caches.match(evt.request).then((cached) => {
      if (cached) return cached;
      return fetch(evt.request).then((response) => {
        if (evt.request.method === 'GET' && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(evt.request, clone));
        }
        return response;
      }).catch(() => {
        if (evt.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
