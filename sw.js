/* QR Studio service worker — enables "Add to Home Screen" install + offline use.
   Strategy:
   - app document (navigation): network-first, so a redeploy shows up immediately;
     falls back to the cached page when offline.
   - same-origin assets (icons, manifest): cache-first.
   - cross-origin libs/fonts (qrcodejs, Google Fonts): stale-while-revalidate,
     so QR generation keeps working offline once the page has been visited.
   - ad / analytics requests: never intercepted — always go straight to the network. */

/* NOTE: bump VERSION whenever an unhashed same-origin asset (manifest.json or any
   icon-*.png) changes — same-origin assets are served cache-first below, so a version
   bump is what evicts the old copy via the activate handler. */
const VERSION = 'v4';
const CACHE = 'qr-studio-' + VERSION;
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './qrcode.min.js',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './icon-180.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Pre-cache per item, not via addAll(): addAll is atomic, so one missing/redirecting
    // URL would void the whole shell and silently break offline. Per-item add() caches
    // whatever is reachable; the navigation network-first path repopulates index.html.
    await Promise.all(APP_SHELL.map((u) => cache.add(u).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

function isAdOrAnalytics(host) {
  // Keep ALL AdSense / consent / measurement / ad-quality traffic on the network and
  // out of CacheStorage: adds fundingchoices (Funding Choices GDPR consent) and
  // adtrafficquality (ad-traffic-quality verification beacons fired by adsbygoogle.js).
  return /googlesyndication|doubleclick|googleadservices|googleads|google-analytics|googletagmanager|adservice|adtrafficquality|fundingchoices|pagead/i.test(host);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (isAdOrAnalytics(url.host)) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Cache the fresh page off the return path: only store a genuinely storable
        // response, and never let a cache.put rejection (opaqueredirect, 206, certain
        // hosting responses) fall through to the catch and serve a STALE page.
        if (fresh && fresh.ok && fresh.type !== 'opaqueredirect') {
          const clone = fresh.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', clone)).catch(() => {});
        }
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               (await cache.match(req)) ||
               Response.error();
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // Cross-origin: stale-while-revalidate, but only STORE responses from the known-needed
  // hosts (qrcodejs on cdnjs + Google Fonts). Caching every opaque response is a quota
  // blowup — opaque entries are heavily padded (~7MB each in Chromium) and never expire,
  // so cache-busted beacon URLs would silently exhaust storage and break legit caching.
  const cacheableHost = /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/i.test(url.host);
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      try {
        if (res && cacheableHost && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      } catch (e) {}
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
