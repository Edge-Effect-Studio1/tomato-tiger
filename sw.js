'use strict';
// Adams Grower Survey service worker. Its one job: let the survey OPEN with no signal. The form, the
// walk-the-field GPS mode and the on-device draft already work offline once the page is loaded; Submit
// needs a connection and says so.
//
// Rules this file keeps:
//  - It never touches /api/*, /admin*, or any non-GET request. Submissions and the admin page always go
//    straight to the network.
//  - The page itself is NETWORK-FIRST (4 s), so a new deploy always wins when the device is online. The
//    cached copy is only what an offline device falls back to.
//  - Map tiles, the geocoder and everything else cross-origin are never cached (storage, and licensing).
//
// KILL SWITCH: to retire the worker everywhere, deploy this file with VERSION = 'off'. Every device that
// still has it will fetch the new file, clear all its caches, unregister itself and reload the page.
const VERSION = 'v1';
const CACHE = 'adams-survey-' + VERSION;
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-64.png'];
const LIBS = ['https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'];

if (VERSION === 'off') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })()));
} else {
  self.addEventListener('install', event => event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled([
      ...SHELL.map(u => cache.add(new Request(u, { cache: 'reload' }))),
      ...LIBS.map(u => cache.add(new Request(u, { mode: 'cors' }))),
    ]);
    await self.skipWaiting();
  })()));

  self.addEventListener('activate', event => event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k.startsWith('adams-survey-')) await caches.delete(k);
    await self.clients.claim();
  })()));

  const networkFirst = async req => {
    const cache = await caches.open(CACHE);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(req, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res && res.ok && res.type === 'basic') cache.put('/', res.clone());
      return res;
    } catch {
      return (await cache.match('/')) || new Response('Offline. Open this page again when you have signal.\nSin conexión. Vuelva a abrir esta página cuando tenga señal.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  };
  const cacheFirst = async req => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  };

  self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin === self.location.origin) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname === '/sw.js') return;
      if (req.mode === 'navigate' || url.pathname === '/') { event.respondWith(networkFirst(req)); return; }
      if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') { event.respondWith(cacheFirst(req)); return; }
      return;
    }
    if (LIBS.includes(req.url)) event.respondWith(cacheFirst(req));
  });
}
