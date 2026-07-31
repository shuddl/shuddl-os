// REQ-030/167 — the driver PWA's API origin, resolved ONCE for every server read (the manifest client and
// the offline sync loop both take it). It follows the SAME discipline as the command/portal clients
// (apps/command/src/lib/api.ts, apps/portal/src/lib/api.ts): a build-time VITE_API_BASE, defaulting to a
// SYNTHETIC `.example` host — never the empty string.
//
// WHY NOT SAME-ORIGIN: the three surfaces deploy as Workers Static Assets with
// `not_found_handling = "single-page-application"`, so an unmatched same-origin path answers **200 + the
// HTML shell**, not 404. With an empty base, a build that forgot VITE_API_BASE would send
// `GET driver.shuddl.tech/v1/driver/manifest` to its OWN origin, get 200-with-HTML, and the service worker
// would cache-first that shell UNDER THE API PATH — surviving redeploys until the driver clears the browser
// cache by hand. `.example` is a reserved TLD (RFC 2606): it can never resolve, so a misconfigured build
// fails LOUDLY into the honest `unavailable` state instead of poisoning a phone's cache. (The service worker
// refuses to cache API paths regardless — apps/driver/public/sw.js — this is the first of the two layers.)
const DEFAULT_API_BASE = "https://api.shuddl.example";

/** The API origin, read LAZILY so a build-time VITE_API_BASE (or a test stub) always wins. No trailing slash. */
export function apiBase(): string {
  const configured = import.meta.env.VITE_API_BASE;
  return (configured ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}
