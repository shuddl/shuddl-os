import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// REQ-061 — the service worker's CACHE-ADMISSION decision, tested against the file that actually ships.
//
// apps/driver/public/sw.js is hand-rolled and served verbatim (no build step, excluded from eslint + tsc),
// so this suite EVALUATES THAT EXACT SOURCE in a sandbox with stubbed service-worker globals rather than
// re-implementing its logic in a testable copy — a copy could drift from the shipped bytes, which is the
// whole risk here. The named pure predicate `isApiPath` was extracted INSIDE sw.js so the decision can be
// asserted directly; the fetch handler is then driven end-to-end through the same sandbox.
//
// WHAT THIS GUARDS. The driver PWA deploys as Workers Static Assets with
// `not_found_handling = "single-page-application"`: an unmatched same-origin path answers **200 + the HTML
// shell**, never 404. A cache-first service worker that treats `/v1/driver/manifest` like any other
// same-origin GET will therefore store the HTML shell UNDER THE API PATH and keep serving it — across
// redeploys, on a phone whose owner cannot clear a cache. So the worker must never cache-first (or even
// handle) an API-shaped request, no matter what the API base is configured to. This is the second of the
// two layers; the first is the non-same-origin base in src/api/base.ts.

const SW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js");
const ORIGIN = "https://driver.shuddl.example";

interface SwRequest {
  readonly method: string;
  readonly url: string;
  readonly mode: string;
}

interface SwHarness {
  /** The pure predicate extracted inside sw.js — undefined if the shipped file no longer declares it. */
  readonly isApiPath: ((pathname: string) => boolean) | undefined;
  /** Dispatch a fetch event; `handled` is whether the worker called respondWith (i.e. took the request over). */
  dispatchFetch(req: SwRequest): { handled: boolean; response: Promise<unknown> | null };
  /** Every request URL the worker wrote into the cache. */
  readonly cachePuts: string[];
  /** Every request URL the worker passed through to the network. */
  readonly networkCalls: string[];
}

/** A request shape covering the three fields the worker reads (method / url / mode). */
function swRequest(path: string, mode = "cors", method = "GET"): SwRequest {
  return { method, url: `${ORIGIN}${path}`, mode };
}

/** Evaluate the SHIPPED sw.js with stubbed `self` / `caches` / `fetch`, and expose its decision surface. */
function loadServiceWorker(seedCache: Record<string, string> = {}): SwHarness {
  const source = readFileSync(SW_PATH, "utf8");
  const listeners = new Map<string, (event: unknown) => void>();
  const cachePuts: string[] = [];
  const networkCalls: string[] = [];
  const cached = new Map(Object.entries(seedCache));

  const cacheStub = {
    open: (): Promise<unknown> =>
      Promise.resolve({
        put: (req: SwRequest, _res: unknown): Promise<void> => {
          cachePuts.push(req.url);
          return Promise.resolve();
        },
        addAll: (): Promise<void> => Promise.resolve(),
      }),
    match: (req: SwRequest | string): Promise<unknown> =>
      Promise.resolve(cached.get(typeof req === "string" ? `${ORIGIN}${req}` : req.url)),
    keys: (): Promise<string[]> => Promise.resolve([]),
    delete: (): Promise<boolean> => Promise.resolve(true),
  };

  const fetchStub = (req: SwRequest): Promise<unknown> => {
    networkCalls.push(req.url);
    // The SPA-fallback response an unmatched same-origin path really returns: 200 + the HTML shell.
    return Promise.resolve({ ok: true, type: "basic", clone: () => ({ body: "<!doctype html>" }) });
  };

  const selfStub = {
    addEventListener: (type: string, handler: (event: unknown) => void): void => {
      listeners.set(type, handler);
    },
    location: { origin: ORIGIN },
    skipWaiting: (): Promise<void> => Promise.resolve(),
    clients: { claim: (): Promise<void> => Promise.resolve() },
  };

  // `typeof isApiPath` (rather than a bare reference) so a sw.js WITHOUT the predicate still evaluates —
  // the behavioural assertions below must be able to fail on behaviour, not on a ReferenceError.
  const factory = new Function(
    "self",
    "caches",
    "fetch",
    `${source}\nreturn { isApiPath: typeof isApiPath === "function" ? isApiPath : undefined };`,
  ) as (self: unknown, caches: unknown, fetch: unknown) => { isApiPath?: (pathname: string) => boolean };

  const exported = factory(selfStub, cacheStub, fetchStub);

  return {
    isApiPath: exported.isApiPath,
    cachePuts,
    networkCalls,
    dispatchFetch(req: SwRequest) {
      let responded: Promise<unknown> | null = null;
      const event = {
        request: req,
        respondWith: (r: Promise<unknown>): void => {
          responded = r;
        },
        waitUntil: (_p: Promise<unknown>): void => {},
      };
      listeners.get("fetch")?.(event);
      const settled: Promise<unknown> | null = responded;
      return { handled: settled !== null, response: settled };
    },
  };
}

/** Let the worker's floating cache-population promises settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("driver service worker — API responses are NEVER cached (REQ-061)", () => {
  it("declares a pure isApiPath predicate that matches the API surface and nothing else", () => {
    const sw = loadServiceWorker();
    expect(typeof sw.isApiPath).toBe("function");
    const isApiPath = sw.isApiPath as (pathname: string) => boolean;

    for (const apiPath of ["/v1", "/v1/driver/manifest", "/v1/events", "/pub/quote", "/api/anything"]) {
      expect(isApiPath(apiPath)).toBe(true);
    }
    // The app shell + hashed assets stay cacheable — offline-first is the whole point of this worker.
    for (const shellPath of ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/assets/index-a1b2c3.js", "/v10/x", "/version1"]) {
      expect(isApiPath(shellPath)).toBe(false);
    }
  });

  it("does not take over — or cache — a same-origin API GET (the SPA fallback's 200-HTML poisoning)", async () => {
    const sw = loadServiceWorker();

    const { handled } = sw.dispatchFetch(swRequest("/v1/driver/manifest"));
    await flush();

    expect(handled).toBe(false); // the worker stays out of the way; the page's own fetch reaches the network
    expect(sw.cachePuts).toEqual([]); // nothing about an API path may ever enter shuddl-driver-v1
  });

  it("does not cache an API path reached in NAVIGATE mode either (address bar / deep link)", async () => {
    const sw = loadServiceWorker();

    const { handled } = sw.dispatchFetch(swRequest("/v1/driver/manifest", "navigate"));
    await flush();

    // The navigation branch is network-first WITH cache population — it would otherwise store the SPA
    // shell under the API URL just as durably as the cache-first branch does.
    expect(handled).toBe(false);
    expect(sw.cachePuts).toEqual([]);
  });

  it("never SERVES a previously-poisoned API entry, even if one is already in the cache", async () => {
    // A phone that installed the broken worker already has the shell stored at the API path. The fixed
    // worker must not keep serving it — it must ignore the request entirely so the network answers.
    const sw = loadServiceWorker({ [`${ORIGIN}/v1/driver/manifest`]: "<!doctype html>" });

    const { handled } = sw.dispatchFetch(swRequest("/v1/driver/manifest"));
    await flush();

    expect(handled).toBe(false);
  });

  it("still cache-firsts a hashed app asset (the offline-first guarantee is intact)", async () => {
    const sw = loadServiceWorker();

    const { handled } = sw.dispatchFetch(swRequest("/assets/index-a1b2c3.js"));
    await flush();

    expect(handled).toBe(true);
    expect(sw.networkCalls).toEqual([`${ORIGIN}/assets/index-a1b2c3.js`]);
    expect(sw.cachePuts).toEqual([`${ORIGIN}/assets/index-a1b2c3.js`]);
  });

  it("still network-firsts + caches a real navigation (the offline app shell)", async () => {
    const sw = loadServiceWorker();

    const { handled } = sw.dispatchFetch(swRequest("/", "navigate"));
    await flush();

    expect(handled).toBe(true);
    expect(sw.cachePuts).toEqual([`${ORIGIN}/`]);
  });
});
