// Service worker: offline app shell, plus the on-device OCR engine and model
// cached on install so receipts can be scanned in the store without signal.
// The build replaces the two lists and the version below.

const VERSION = '__VERSION__';
const SHELL = __SHELL__;
const OCR = __OCR__;
const CACHE = `receipts-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // Best effort: the OCR files are large; a failure here only means they
    // download on first scan instead.
    await Promise.allSettled(OCR.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('receipts-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // never touch API calls
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put('./', res.clone());
        return res;
      } catch {
        return (await cache.match('./')) || (await cache.match('index.html'));
      }
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && url.pathname.includes('/vendor/')) cache.put(req, res.clone());
    return res;
  })());
});
