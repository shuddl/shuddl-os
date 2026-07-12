// REQ-061 — the driver PWA service worker: offline-first app-shell caching, no app store. Served from
// the site root so its scope is "/". Hand-rolled (no build step) so the file the browser registers is
// exactly what ships. Strategy: precache the shell on install; cache-first for same-origin assets
// (Vite emits content-hashed filenames, so a cached asset is never stale); network-first for
// navigations with the cached shell as the offline fallback. After the first online visit the app
// loads with no network.
//
// DEFER (add when offline-install becomes load-bearing — Task 9 / WP-06): this file lives under
// apps/driver/public/ and is EXCLUDED from eslint + tsc (a static asset served verbatim, using
// service-worker globals). It is exercised only manually today; when the offline-first guarantee is a
// merge gate, add a headless smoke test (register, go offline, reload → app shell still loads).
const CACHE = "shuddl-driver-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network, fall back to the cached shell so the app opens offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html"))),
    );
    return;
  }

  // Same-origin assets: cache-first (hashed names never go stale), populate the cache on first fetch.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    }),
  );
});
