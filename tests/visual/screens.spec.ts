import { test, expect, type Page } from "@playwright/test";

// The five canonical screens (WP-03 DoD "5 canonical screens match blessed refs"). Each is a REAL
// screen composed from @shuddl/design + @shuddl/map, deterministic (seeded fleet + pinned payloads),
// captured at a fixed 1440×900 viewport with reduced-motion so count-ups/reveals rest at final state
// and trucks sit static — the capture is stable frame to frame. The FIRST run on a browser-capable
// machine writes the blessed refs under tests/visual/blessed/ (commit them); afterwards a mismatch
// writes a diff to test-results/ and is REPORTED, never fatal (REQ-158) — the `pnpm test:visual` guard
// keeps exit 0 unless run with --strict. `expect.soft` captures all five even if an early one drifts.
//
// EACH SCREEN MUST RENDER ITS AUTHED SURFACE. Three of these rotted when Task 10 introduced
// fail-closed states: portal and status were silently capturing "SESSION EXPIRED" and "STATUS
// UNAVAILABLE", and driver was waiting for text that now lives three interactions deep, so it timed
// out instead. A baseline of an error state is a bug promoted to a specification, so each screen now
// carries the session and the pinned server payload its real surface needs. Nothing here fabricates a
// server BEHAVIOUR — the payload shapes are the ones the parsers already enforce (a wrong shape fails
// Zod and renders the very error state this exists to avoid).

const COMMAND = "http://localhost:4321";
const PORTAL = "http://localhost:4322";
const DRIVER = "http://localhost:4323";

const PORTAL_TOKEN_KEY = "shuddl.portal.token"; // apps/portal/src/session.ts
const DRIVER_TOKEN_KEY = "shuddl.driver.session.token"; // apps/driver/src/auth/session.ts

// A synthetic party. Generic by construction — never a real party name (REQ-167).
const PARTY_ID = "p-alpha";

// FIXED epoch stamps. The portal renders the server's freshness as HH:MM:SS from `as_of`
// (api/board.ts freshnessLabel), so a live clock here would repaint the header on every run and make
// the diff permanently red. Pinned ⇒ the same pixels forever.
const AS_OF = 1_784_000_000_000; // 2026-07-13T12:53:20Z
const FAR_FUTURE_EXP = 4_102_444_800; // 2100-01-01, so the session is never mid-expiry

/** A portal session bearer. Never verified client-side (session.ts rule 1); the claims only scope what
 * the UI shows. Deterministic by construction — no clock, no randomness. */
function portalBearer(partyId: string): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: "u-portal",
    tenant: "tenant-a",
    role: "portal",
    party_id: partyId,
    exp: FAR_FUTURE_EXP,
  })}.visual-not-verified`;
}

/** Three positioned shipments in the party's own board shape — {board, as_of}, strict (api/board.ts).
 * One exception so the capture also carries the world-dim and the pulse at rest (REQ-077). */
function partyBoard(): unknown {
  return {
    as_of: AS_OF,
    board: [
      { shipment_id: "SHP-0001", lat_e6: 45_515_000, lon_e6: -122_678_000, status: "healthy" },
      { shipment_id: "SHP-0002", lat_e6: 39_739_000, lon_e6: -104_990_000, status: "at-risk" },
      { shipment_id: "SHP-0003", lat_e6: 32_776_000, lon_e6: -96_797_000, status: "exception" },
    ],
  };
}

/** The party's billing summary (GET /v1/invoices), read eagerly by ShipmentList. Left EMPTY so the
 * list rests in its honest empty state rather than a spinner. */
function partyInvoices(): unknown {
  return { invoices: [] };
}

/** The public status payload (GET /pub/status/:cap). Position is city-coarse e6, exactly as the server
 * generalizes it; no eta, because the server sends none and the page must not invent one. */
function publicStatus(): unknown {
  return { state: "delivered", out_for_delivery: false, position: { lat_e6: 45_500_000, lon_e6: -122_700_000 } };
}

/** The driver's day sheet (GET /v1/driver/manifest): one revealed pickup, one withheld future stop —
 * the reveal policy the contract serializes (packages/contracts/src/driver-manifest.ts). */
function driverManifest(): unknown {
  return {
    server_ts: AS_OF,
    tenant: "tenant-a",
    driver_id: "u-driver",
    stops: [
      {
        shipment_id: "SHP-VIS-1",
        seq: 0,
        kind: "pickup",
        status: "pending",
        revealed: true,
        geo: { lat_e6: 45_515_000, lon_e6: -122_678_000 },
      },
      { shipment_id: "SHP-VIS-2", seq: 1, kind: "delivery", status: "pending", revealed: false, geo: null },
    ],
  };
}

/** Seed a localStorage key before ANY app script runs, so the surface boots signed in. */
async function seedSession(page: Page, key: string, value: string): Promise<void> {
  await page.addInitScript(
    ([k, v]) => window.localStorage.setItem(k as string, v as string),
    [key, value],
  );
}

interface Screen {
  name: string;
  url: string;
  /** Session + pinned reads. Runs before navigation. */
  setup?: (page: Page) => Promise<void>;
  /** Resolves when the REAL surface — never a fallback state — has rendered. */
  ready: (page: Page) => Promise<void>;
}

const canvasReady = async (page: Page): Promise<void> => {
  await page.waitForSelector("canvas", { timeout: 30_000 });
};

const SCREENS: readonly Screen[] = [
  {
    name: "command.png",
    url: `${COMMAND}/`,
    ready: canvasReady,
  },
  {
    name: "portal.png",
    url: `${PORTAL}/`,
    setup: async (page) => {
      await seedSession(page, PORTAL_TOKEN_KEY, portalBearer(PARTY_ID));
      await page.route("**/v1/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/v1/board")) return route.fulfill({ json: partyBoard() });
        if (url.includes("/v1/invoices")) return route.fulfill({ json: partyInvoices() });
        // Anything else the board reaches for resolves empty rather than hanging on a dead host.
        return route.fulfill({ json: {} });
      });
    },
    ready: async (page) => {
      await canvasReady(page);
      // The authed board, not the re-auth prompt: the party's own hero is on screen.
      await page.getByRole("heading", { name: PARTY_ID }).waitFor({ timeout: 30_000 });
    },
  },
  {
    name: "status.png",
    url: `${PORTAL}/status/e2e-cap`,
    setup: async (page) => {
      await page.route("**/pub/status/**", (route) => route.fulfill({ json: publicStatus() }));
    },
    ready: async (page) => {
      await canvasReady(page);
      // The resolved public status, not the uniform "STATUS UNAVAILABLE" deny.
      await expect(page.getByText("STATUS UNAVAILABLE")).toHaveCount(0);
    },
  },
  {
    name: "driver.png",
    url: `${DRIVER}/`,
    setup: async (page) => {
      await seedSession(page, DRIVER_TOKEN_KEY, "visual.driver.session-token");
      await page.route("**/v1/driver/manifest", (route) => route.fulfill({ json: driverManifest() }));
    },
    ready: async (page) => {
      // The day sheet itself — "Sign in", "Loading" and "Can't load" all render a MessageScreen instead.
      await page.getByRole("heading", { name: "Day sheet" }).waitFor({ timeout: 30_000 });
    },
  },
  {
    name: "evidence-email.png",
    url: `${PORTAL}/?screen=email`,
    ready: async (page) => {
      await page.waitForSelector("text=DELIVERED", { timeout: 30_000 });
    },
  },
];

async function settle(page: Page): Promise<void> {
  // Let webfonts + the GL canvas paint. Under reduced-motion nothing keeps moving after this, so the
  // basemap tiles failing to load (offline) still yields a stable greige ground + entity layers.
  await page.waitForTimeout(3000);
}

/** Everything served from the public demo tile host: vector tiles AND glyph PBFs (demo.ts DEMO_TILE_URL
 * / DEMO_GLYPHS_URL). */
const THIRD_PARTY_BASEMAP = /tiles\.openfreemap\.org/;

/** Origins the capture is allowed to depend on.
 *
 *  • our own dev servers;
 *  • the SYNTHETIC api host (apps/portal/src/lib/api.ts DEFAULT_API_BASE). `.example` is reserved by
 *    RFC 2606 and can never resolve, so a request to it that FINISHED is proof it was fulfilled by a
 *    pinned payload above — it cannot have come from a real server. An unintercepted read there fails
 *    DNS and never reaches this list.
 *
 * Anything else is a moving target owned by someone else. */
const OURS = /^(http:\/\/localhost:(4321|4322|4323)\/|https:\/\/api\.shuddl\.example\/)/;

for (const s of SCREENS) {
  test(`canonical screen — ${s.name}`, async ({ page }) => {
    // The greige ground, the entity layers and the chrome are OURS and are what the blessed refs assert.
    // The basemap is a live third-party fetch of a moving `latest` build that owns ~3.6% of the frame —
    // more than the 2% diff tolerance — so leaving it in makes a stranger's deploy able to fail our CI.
    // Registered BEFORE the screen's own setup so nothing can navigate ahead of it.
    await page.route(THIRD_PARTY_BASEMAP, (route) => route.abort());

    // Blocking one hostname is only as good as the hostname staying current. Record every request that
    // actually COMPLETED so the assertion below is about what reached the pixels, not about what we
    // intended to block: if the tile host is renamed, self-hosted (REQ-075), or a new third-party asset
    // is introduced into a canonical screen, this fails instead of quietly re-opening the capture.
    const foreign = new Set<string>();
    page.on("requestfinished", (req) => {
      const url = req.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      if (!OURS.test(url)) foreign.add(new URL(url).origin);
    });

    await s.setup?.(page);
    await page.goto(s.url);
    await s.ready(page);
    await settle(page);

    expect(
      [...foreign],
      "a canonical capture may not depend on any origin we do not control",
    ).toEqual([]);
    await expect.soft(page).toHaveScreenshot(s.name);
  });
}
