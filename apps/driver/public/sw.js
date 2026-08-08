// REQ-061 — the driver PWA service worker: offline-first app-shell caching, no app store. Served from
// the site root so its scope is "/". Hand-rolled (no build step) so the file the browser registers is
// exactly what ships. Strategy: precache the shell on install; cache-first for same-origin assets
// (Vite emits content-hashed filenames, so a cached asset is never stale); network-first for
// navigations with the cached shell as the offline fallback. After the first online visit the app
// loads with no network.
//
// This file lives under apps/driver/public/ and is EXCLUDED from eslint + tsc (a static asset served
// verbatim, using service-worker globals) — but it is NOT untested: apps/driver/src/sw.test.ts evaluates
// THIS EXACT SOURCE in a sandbox with stubbed service-worker globals and asserts the cache-admission
// decision. (A headless register-and-go-offline smoke test is still the follow-up for the install path.)
const CACHE = "shuddl-driver-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

// The API surface — NEVER cacheable, whatever origin it is reached on. The driver PWA deploys as Workers
// Static Assets with `not_found_handling = "single-page-application"`, so an unmatched same-origin path
// answers 200 + the HTML SHELL rather than 404. Cache-firsting such a response would store the shell under
// an API path in `shuddl-driver-v1` and keep serving it across redeploys — unrecoverable from a driver's
// phone without clearing the browser cache. This worker therefore declines API-shaped requests outright:
// no respondWith, no cache read, no cache write; the page's own fetch talks to the network directly.
// (The API base is also non-same-origin by construction — src/api/base.ts — this is defence in depth.)
function isApiPath(pathname) {
  return /^\/(v1|pub|api)(\/|$)/.test(pathname);
}

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

  // API paths are never cached and never served from cache — checked BEFORE the navigation branch, because
  // a same-origin API URL typed into the address bar arrives in navigate mode and would otherwise be stored
  // under that path by the network-first branch. See isApiPath above.
  if (isApiPath(url.pathname)) return;

  // Navigations: try the network, fall back to the cached shell so the app opens offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
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
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
        }
        return res;
      });
    }),
  );
});
