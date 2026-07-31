import { expect, test, type Page, type Request } from "@playwright/test";

// WHAT A STRANGER SEES ON THE DEPLOYED SURFACES.
//
// A 200 from `curl` proves a bundle was uploaded and nothing else. These assertions cover the two ways a
// deployed surface lies:
//
//   1. IT TALKS TO NOTHING. The API base is baked at BUILD time. A surface built without VITE_API_BASE
//      renders its entire chrome against `api.shuddl.example`, which cannot resolve — every request fails
//      as a NETWORK error rather than an auth error, so the surface shows empty panels and no warning. It
//      looks deployed and calm. tools/deploy/surface-contract.ts gates the bundle; this proves the running
//      page, which is the only thing a user ever meets.
//   2. IT INVENTS DATA. Nobody can sign in yet — prod's control plane holds only the three system tenants
//      from the migration seeds, so every read comes back 401. The correct behaviour is to say so and show
//      NOTHING. A zero rendered as a KPI is a lie about freight.
//
// Every test here therefore asserts on RENDERED CONTENT before it asserts on anything else. A surface that
// served an index.html with a dangling script tag issues no request at all, and a suite built only out of
// "no request went to the wrong host" would pass it — silently, forever. A negative over an empty set is
// not evidence.
//
// FIELD gate: skipped unless PROD_SURFACE_BASE names the zone. `pnpm test:surfaces` routes it through
// tools/harness/playwright-guard.ts, so an all-skipped run is BLOCKED, never a green exit 0 (REQ-288).
const ZONE = process.env["PROD_SURFACE_BASE"];
const API = "https://api.shuddl.tech";

test.skip(ZONE === undefined, "PROD_SURFACE_BASE is unset — this gate drives deployed surfaces only");

/** Every request the page issued to anything that looks like our API, with the status it came back as. */
function watchApi(page: Page): { calls: { url: string; status: number | null }[]; foreign: string[] } {
  const calls: { url: string; status: number | null }[] = [];
  const foreign: string[] = [];
  const isApi = (u: string): boolean => /\/(v1|pub)\//.test(u);

  page.on("request", (r: Request) => {
    const u = r.url();
    // The two hosts that mean "this build is wrong": the synthetic default, and a dev server.
    if (/api\.shuddl\.example|localhost|127\.0\.0\.1/.test(u)) foreign.push(u);
  });
  page.on("requestfinished", (r: Request) => {
    void (async () => {
      if (!isApi(r.url())) return;
      const res = await r.response();
      calls.push({ url: r.url(), status: res?.status() ?? null });
    })().catch(() => {
      // The listener is never detached, so a lookup can still be in flight when the page fixture tears
      // down; `r.response()` then rejects with "Target page, context or browser has been closed". That is
      // teardown, not a finding — unhandled, Playwright would attribute it to whatever test ran next and
      // `retries: 1` would dress the result up as flake.
    });
  });
  page.on("requestfailed", (r: Request) => {
    if (isApi(r.url())) calls.push({ url: r.url(), status: null });
  });
  return { calls, foreign };
}

test("command reaches the real API and admits it has no session", async ({ page }) => {
  const seen = watchApi(page);
  await page.goto(`https://command.${ZONE}/`, { waitUntil: "networkidle" });

  // It reached the REAL API. A NETWORK-class failure here is the `.example` build shipping.
  expect(seen.foreign, `command called a host that cannot serve it: ${seen.foreign.join(", ")}`).toEqual([]);
  const board = seen.calls.filter((c) => c.url.startsWith(`${API}/v1/`));
  expect(board.length, "command made no authenticated API call at all").toBeGreaterThan(0);
  expect(board.every((c) => c.status !== null), "an API call failed at the network layer rather than returning a status").toBe(true);

  // …and the API said 401, which is the truth: there is no session and no user to have one.
  expect(board.some((c) => c.status === 401), `expected a 401 from ${API}; saw ${JSON.stringify(board)}`).toBe(true);

  // The surface must SAY so rather than showing a calm empty board.
  await expect(page.getByText(/SESSION EXPIRED/i)).toBeVisible();
});

test("command invents no freight while unauthenticated", async ({ page }) => {
  await page.goto(`https://command.${ZONE}/`, { waitUntil: "networkidle" });
  await expect(page.getByText(/SESSION EXPIRED/i)).toBeVisible();

  // Nothing that reads as a quantity of real freight may appear. A rendered 0 is not "empty" to a
  // dispatcher — it is a claim that there are no loads, made by a surface that never got to look.
  const digits = await page.locator("body").evaluate((el: HTMLElement) => {
    const text = el.innerText;
    return [...text.matchAll(/\$[\d,]+|\b\d{1,3}(,\d{3})+\b/g)].map((m) => m[0]);
  });
  expect(digits, `unauthenticated command rendered figures: ${digits.join(", ")}`).toEqual([]);
});

test("portal tells an unauthenticated visitor to sign in, and leaks nothing", async ({ page }) => {
  const seen = watchApi(page);
  await page.goto(`https://portal.${ZONE}/`, { waitUntil: "networkidle" });

  expect(seen.foreign, `portal called a host that cannot serve it: ${seen.foreign.join(", ")}`).toEqual([]);
  await expect(page.getByText(/SIGN IN|SESSION EXPIRED/i).first()).toBeVisible();
});

test("the public status page is reachable with no session and refuses an unknown link", async ({ page }) => {
  // track.* is served by the PORTAL worker — the same bundle, routed to its public status screen. This is
  // the only surface a customer meets without credentials, so it must resolve (SPA fallback), call the
  // PUBLIC endpoint, and decline an unknown capability without inventing a shipment.
  const seen = watchApi(page);
  await page.goto(`https://track.${ZONE}/status/not-a-real-capability-token`, { waitUntil: "networkidle" });

  expect(seen.foreign, `track called a host that cannot serve it: ${seen.foreign.join(", ")}`).toEqual([]);
  const pub = seen.calls.filter((c) => c.url.startsWith(`${API}/pub/`));
  expect(pub.length, "the public status page made no /pub/ call — it did not reach the API").toBeGreaterThan(0);
  expect(pub.every((c) => c.status !== null), "a /pub/ call failed at the network layer").toBe(true);

  // No shipment may be rendered for a capability that does not exist.
  await expect(page.getByText(/DELIVERED|IN TRANSIT|PICKED UP/i)).toHaveCount(0);
});

test("the driver PWA runs a real bundle, says it has no session, and never poisons its cache with an API path", async ({ page }) => {
  const seen = watchApi(page);
  // Every same-origin script the page actually pulled. The driver is the one surface where request traffic
  // cannot carry the signal: an unauthenticated driver issues ZERO API calls by construction — App.tsx
  // returns before the manifest read when `session.getToken()` is null, and useSync returns before its
  // first pass for the same reason — so the shipped module bytes are the only place the field can read
  // which host this build was compiled to talk to.
  const scripts: string[] = [];
  page.on("request", (r: Request) => {
    if (r.resourceType() === "script" && r.url().startsWith(`https://driver.${ZONE}/`)) scripts.push(r.url());
  });

  await page.goto(`https://driver.${ZONE}/`, { waitUntil: "networkidle" });

  expect(seen.foreign, `driver called a host that cannot serve it: ${seen.foreign.join(", ")}`).toEqual([]);

  // PROOF OF LIFE, and it comes first because nothing below it means anything without it. Deploy an
  // index.html whose script tag dangles — no bundle, blank page, not one request issued — and every
  // request-shaped assertion in this test passes on an empty array. These two lines are the difference
  // between a working deploy and a shell: they can only be satisfied by JS that parsed, mounted, and ran
  // App's state machine to `case "unauthenticated"` (apps/driver/src/App.tsx).
  await expect(page.getByText(/^\s*Sign in\s*$/i)).toBeVisible();
  await expect(page.getByText(/SIGN IN TO LOAD YOUR DAY/i)).toBeVisible();

  // …and the module that ran is the one built WITH VITE_API_BASE. apps/driver/src/api/base.ts falls back
  // to the synthetic `api.shuddl.example`, a reserved TLD that can never resolve; with no session there is
  // no request on which to catch that, so read the bytes the edge is serving.
  expect(scripts.length, "the driver page loaded no same-origin script — that is a shell, not an app").toBeGreaterThan(0);
  const modules = await Promise.all(scripts.map(async (url) => ({ url, body: await (await page.request.get(url)).text() })));
  expect(
    modules.filter((m) => m.body.includes("api.shuddl.example")).map((m) => m.url),
    "a shipped driver module carries the synthetic `.example` base — this build lost VITE_API_BASE",
  ).toEqual([]);
  expect(modules.some((m) => m.body.includes(API)), `no shipped driver module names ${API} — this build points somewhere else`).toBe(true);

  // The hazard the rest guards: if the driver build ever resolved its API to same-origin, SPA fallback
  // would answer GET /v1/* with 200 + the HTML shell and the service worker would cache-first that shell
  // on a phone — surviving redeploys, unrecoverable without a manual cache clear. Same-origin API traffic
  // is the signal, and there must be none.
  const sameOrigin = seen.calls.filter((c) => c.url.startsWith(`https://driver.${ZONE}/`));
  expect(sameOrigin, `driver issued same-origin API requests: ${JSON.stringify(sameOrigin)}`).toEqual([]);

  // And the shipped worker must still carry the guard, not just the source tree.
  const sw = await page.request.get(`https://driver.${ZONE}/sw.js`);
  expect(sw.status()).toBe(200);
  expect(await sw.text()).toContain("isApiPath");
});
