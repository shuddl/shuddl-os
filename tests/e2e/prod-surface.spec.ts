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
// FIELD gate: skipped unless PROD_SURFACE_BASE names the zone.
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
    })();
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

test("the driver PWA stays unauthenticated and never poisons its cache with an API path", async ({ page }) => {
  const seen = watchApi(page);
  await page.goto(`https://driver.${ZONE}/`, { waitUntil: "networkidle" });

  expect(seen.foreign, `driver called a host that cannot serve it: ${seen.foreign.join(", ")}`).toEqual([]);

  // The hazard this guards: if the driver build ever resolved its API to same-origin, SPA fallback would
  // answer GET /v1/* with 200 + the HTML shell and the service worker would cache-first that shell on a
  // phone — surviving redeploys, unrecoverable without a manual cache clear. Same-origin API traffic is
  // therefore the signal, and there must be none.
  const sameOrigin = seen.calls.filter((c) => c.url.startsWith(`https://driver.${ZONE}/`));
  expect(sameOrigin, `driver issued same-origin API requests: ${JSON.stringify(sameOrigin)}`).toEqual([]);

  // And the shipped worker must still carry the guard, not just the source tree.
  const sw = await page.request.get(`https://driver.${ZONE}/sw.js`);
  expect(sw.status()).toBe(200);
  expect(await sw.text()).toContain("isApiPath");
});
