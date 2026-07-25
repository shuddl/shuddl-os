import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";

// V1 remediation Task 14 (REQ-016/017/030/061/069) — DRIVER OFFLINE CAPTURE → RECONNECT → SERVER SEND,
// in a real browser.
//
// WHAT THIS PROVES THAT THE VITEST SUITE CANNOT.
// packages/driver-core/test/sync.test.ts drives the sync state machine over an in-memory store, and
// workers/api/test/airplane-soak.test.ts replays an offline batch against a real miniflare D1. Neither
// one ever opens IndexedDB, destroys a page, or crosses a real online/offline transition — they cannot,
// because they have no browser. The durability claim in REQ-016 ("a capture taken in a dead zone is
// still there after the phone is locked, killed and reopened") lives entirely in that gap. This spec is
// that claim: real Chromium, real IndexedDB, real `context.setOffline`, and a real page teardown.
//
// WHAT IT DOES NOT PROVE. The server leg is a Playwright-intercepted route, not a deployed worker: the
// driver dev server has no CORS origin in workers/api/src/middleware/cors.ts, the PWA never enrolls its
// device key (POST /v1/devices is uncalled), and `wrangler dev` needs a JWT secret this repo
// deliberately does not carry. Server-side acceptance of these events is proven in-isolate by
// workers/api/test/airplane-soak.test.ts. This spec asserts what the CLIENT durably holds and what it
// eventually puts on the wire — never that a server accepted it.

const DRIVER = "http://localhost:4323/";
const TOKEN_KEY = "shuddl.driver.session.token"; // apps/driver/src/auth/session.ts:19
const DB_NAME = "shuddl-driver"; // apps/driver/src/storage/idb.ts:4
const QUEUE_STORE = "queue";

// A session-shaped bearer. The manifest read is intercepted, so this is never verified — the App only
// requires a non-null token to leave the "Sign in" state.
const BEARER = "e2e.driver.session-token";

// A revealed pickup + a withheld future stop (geo null), exactly as the server's reveal policy serializes
// them (packages/contracts/src/driver-manifest.ts).
function manifest(): unknown {
  return {
    server_ts: 1_784_000_000_000,
    tenant: "tenant-a",
    driver_id: "u-driver",
    stops: [
      { shipment_id: "SHP-E2E-1", seq: 0, kind: "pickup", status: "pending", revealed: true, geo: { lat_e6: 45_515_000, lon_e6: -122_678_000 } },
      { shipment_id: "SHP-E2E-2", seq: 1, kind: "delivery", status: "pending", revealed: false, geo: null },
    ],
  };
}

// Seed the session on the CONTEXT so every page — including one opened after the first is destroyed —
// boots signed in. There is no login screen yet (REQ-069), so a browser test must place the bearer.
async function signIn(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [TOKEN_KEY, BEARER],
  );
}

// Read the durable capture queue straight out of IndexedDB — the same database the PWA writes through
// its IdbQueueStore adapter. This is the durability assertion; nothing in the React tree is consulted,
// which is what lets it run against a page with no application alive on it.
async function queuedIds(page: Page): Promise<string[]> {
  return page.evaluate(
    ([dbName, store]) =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open(dbName as string, 1);
        req.onerror = () => reject(req.error ?? new Error("open failed"));
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(store as string)) return resolve([]);
          const all = db.transaction(store as string, "readonly").objectStore(store as string).getAllKeys();
          all.onsuccess = () => resolve((all.result as IDBValidKey[]).map(String));
          all.onerror = () => reject(all.error ?? new Error("getAllKeys failed"));
        };
      }),
    [DB_NAME, QUEUE_STORE],
  );
}

test.describe("driver offline capture survives and reconnects", () => {
  test.use({
    permissions: ["geolocation"],
    geolocation: { latitude: 45.515, longitude: -122.678 },
  });

  test("renders the authenticated day sheet from server data, never a fixture", async ({ page, context }) => {
    await signIn(context);
    await context.route("**/v1/driver/manifest", (route: Route) => route.fulfill({ json: manifest() }));
    await page.goto(DRIVER);

    // Headings, not bare text: the captions repeat these words, and a locator matching two elements is a
    // strict-mode failure rather than an assertion.
    await expect(page.getByRole("heading", { name: "Day sheet" })).toBeVisible();
    // Both stops came from the manifest, and the withheld one renders locked — the old client fixture had
    // different stops entirely.
    await expect(page.getByText("2 STOPS", { exact: false })).toBeVisible();
    await expect(page.getByText("Locked stop")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  });

  test("a 401 clears the session and leaves no stale sheet behind", async ({ page, context }) => {
    await signIn(context);
    await context.route("**/v1/driver/manifest", (route: Route) => route.fulfill({ status: 401, json: { code: "UNAUTHORIZED", message: "no", req_id: "r" } }));
    await page.goto(DRIVER);

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Day sheet" })).toHaveCount(0);
    expect(await page.evaluate((k) => window.localStorage.getItem(k as string), TOKEN_KEY)).toBeNull();
  });

  test("a capture taken offline outlives the page and flushes on reconnect", async ({ page, context }) => {
    const posted: { url: string; auth: string | undefined; idempotency: string | undefined }[] = [];
    // The relaunched app starts draining the moment it boots, which would race the durability read. Hold
    // every append at the network boundary until the read is done: the item stays queued because its
    // request has not been answered, so the assertion is deterministic rather than a timing bet.
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });

    await signIn(context);
    await context.route("**/v1/driver/manifest", (route: Route) => route.fulfill({ json: manifest() }));
    // Record every event POST the sync loop makes once the network is back.
    await context.route("**/v1/shipments/*/events", async (route: Route) => {
      await flushGate;
      const h = route.request().headers();
      posted.push({ url: route.request().url(), auth: h["authorization"], idempotency: h["idempotency-key"] });
      await route.fulfill({ status: 201, json: { event_ids: ["evt-1"] } });
    });
    await context.route("**/v1/evidence**", (route: Route) => route.fulfill({ status: 201, json: { ok: true } }));

    await page.goto(DRIVER);
    await expect(page.getByRole("heading", { name: "Day sheet" })).toBeVisible();

    // Enter the first stop's gated flow and satisfy its first gate while the network is DOWN.
    await context.setOffline(true);
    await page.getByRole("button").filter({ hasText: "pickup" }).first().click();
    const commit = page.getByRole("button").last();
    await expect(commit).toBeVisible();
    await commit.click();

    // The capture is durable the moment the gate is satisfied — not when the network returns.
    await expect.poll(async () => (await queuedIds(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const captured = await queuedIds(page);
    expect(captured.length, "the gated step commits at least one signed event").toBeGreaterThan(0);

    // Destroy the page outright — the browser equivalent of the driver killing the app in a dead zone.
    // Nothing of the application survives this; only the origin's IndexedDB does.
    await page.close();
    await context.setOffline(false);

    // A brand-new page on the same origin: it must find the captures still there and drain them.
    // (IndexedDB is only reachable from a real origin, so the navigation has to come first — which is
    // precisely why the append is held above.)
    const relaunched = await context.newPage();
    await relaunched.goto(DRIVER);
    await expect(relaunched.getByRole("heading", { name: "Day sheet" })).toBeVisible({ timeout: 30_000 });
    expect(await queuedIds(relaunched), "the queue must survive the page that wrote it").toEqual(captured);

    releaseFlush();
    await expect.poll(() => posted.length, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(posted[0]?.auth).toBe(`Bearer ${BEARER}`);
    expect(posted[0]?.idempotency, "every append carries an idempotency key (I1)").toBeTruthy();
    expect(posted[0]?.url).toContain("/v1/shipments/SHP-E2E-1/events");

    // And the queue drains to empty — a loop that posts but never acknowledges would resend forever.
    await expect.poll(async () => (await queuedIds(relaunched)).length, { timeout: 60_000 }).toBe(0);
  });
});
