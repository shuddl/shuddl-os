import { test, expect, type Page, type Route } from "@playwright/test";

// V1 remediation Task 14 (REQ-025/074/085/073) — PORTAL PARTY ISOLATION, in a real browser.
//
// DIVISION OF PROOF. Server-side isolation — that a party lens can never read another party's rows — is
// proven against a real miniflare D1 in workers/api/test/isolation.test.ts, and it is the authority.
// What no vitest case can see is the BROWSER half: that the shipped client never asks for data outside
// its own party, never smuggles a scope override onto the wire, and, when the server refuses, renders a
// refusal instead of quietly showing whatever it still has in memory. A portal that renders stale
// party-A rows after being told 403 has leaked, no matter how correct the server was.

const PORTAL = "http://localhost:4322/";
const TOKEN_KEY = "shuddl.portal.token";

// Two parties in one tenant. The portal session is party A's, always.
const PARTY_A = "p-alpha";
const PARTY_B = "p-beta";

// A portal session bearer. The board read is intercepted, so the signature is never verified; the claims
// matter only to the client's own session decoding.
function bearer(partyId: string): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: "u-portal",
    tenant: "tenant-a",
    role: "portal",
    party_id: partyId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.e2e-not-verified`;
}

async function signIn(page: Page, partyId: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [TOKEN_KEY, bearer(partyId)],
  );
}

// The board response the portal ACTUALLY parses. Audit §781: this returned `{ as_of, items }` and the client
// declares `z.object({ board: z.array(BoardItem), as_of: z.number() }).strict()` — so the key was wrong AND
// `.strict()` rejected the extra one. Every mocked board in this suite was refused by the portal's own Zod
// parse, which is why the status line never left SYNCING and why the "party A's board loads first" step below
// was asserting nothing. A mock is a contract copy; this one was never compared against the contract.
function boardFor(partyId: string): unknown {
  return {
    as_of: Date.now(),
    board: [{ shipment_id: `SHP-${partyId}-1`, lat_e6: 45_515_000, lon_e6: -122_678_000, status: "healthy" }],
  };
}

// The portal calls MORE than /v1/board (it also reads /v1/invoices), and this suite used to answer every
// `**/v1/**` with the board payload. Two consequences, both measured in §781: the invoices seam received a
// board and — before it was parsed — CRASHED the app outright (`Cannot read properties of undefined`), and
// the board itself was answered with a body whose key was `items` while the client parses `board`, so the
// status line never left SYNCING. Dispatching by path is what lets the assertions below mean anything.
async function fulfillPortalApi(route: Route, partyId: string): Promise<void> {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/v1/invoices")) {
    await route.fulfill({ json: { invoices: [] } });
    return;
  }
  await route.fulfill({ json: boardFor(partyId) });
}

test.describe("the portal client stays inside its own party", () => {
  test("never puts a party scope on the wire — the server resolves it from the bearer alone", async ({ page }) => {
    const requests: string[] = [];
    await signIn(page, PARTY_A);
    await page.route("**/v1/**", async (route: Route) => {
      const url = route.request().url();
      requests.push(url);
      await fulfillPortalApi(route, PARTY_A);
    });

    await page.goto(PORTAL);
    await expect.poll(() => requests.length, { timeout: 20_000 }).toBeGreaterThan(0);

    for (const url of requests) {
      // A client-supplied scope is exactly the shape a confused-deputy read takes. The portal must send
      // none of these: the party comes from the verified JWT, server-side (packages/ledger/src/lens.ts).
      expect(url, `client-supplied scope in ${url}`).not.toMatch(/[?&]party_id=/);
      expect(url, `client-supplied tenant in ${url}`).not.toMatch(/[?&]tenant=/);
    }
  });

  test("a party_id smuggled into the URL never reaches the API", async ({ page }) => {
    const requests: string[] = [];
    await signIn(page, PARTY_A);
    await page.route("**/v1/**", async (route: Route) => {
      requests.push(route.request().url());
      await fulfillPortalApi(route, PARTY_A);
    });

    // An attacker (or a curious user) edits the address bar. The client must ignore it entirely.
    await page.goto(`${PORTAL}?party_id=${PARTY_B}`);
    await expect.poll(() => requests.length, { timeout: 20_000 }).toBeGreaterThan(0);
    for (const url of requests) expect(url).not.toContain(PARTY_B);
  });

  test("a 403 renders a refusal, never another party's rows and never a stale sheet", async ({ page }) => {
    let refuse = false;
    await signIn(page, PARTY_A);
    await page.route("**/v1/**", async (route: Route) => {
      if (refuse) {
        await route.fulfill({ status: 403, json: { code: "FORBIDDEN", message: "cross-party read refused", req_id: "r-1" } });
        return;
      }
      await fulfillPortalApi(route, PARTY_A);
    });

    await page.goto(PORTAL);
    const status = page.getByTestId("board-status");

    // POSITIVE FLOOR (audit §781, closing §724). This step used to assert only `toBeVisible()`, which the
    // status element satisfies in EVERY state — loading, live, empty, stale, unavailable. So the comment that
    // stood here — "the party's own board loads first, so we know the refusal is what changed the screen" —
    // was not established by anything: a portal that never loaded at all would reach the refusal step having
    // shown nothing, and the negatives below would all pass because there is no data of any party on screen.
    //
    // Asserting the LIVE text instead pins the premise the rest of the test rests on. `· LIVE ·` and not
    // `/LIVE/` because "LIVE MAP · UNAVAILABLE" also contains "LIVE" — the delimiters are what distinguish
    // the state from the widget's own name.
    await expect(status, "the board never reached its LIVE state, so a later refusal proves nothing").toHaveText(
      /· LIVE ·/,
      { timeout: 20_000 },
    );
    await expect(page.getByText(`SHP-${PARTY_A}-1`, { exact: false }), "party A's own row must render before the refusal").toHaveCount(1);

    refuse = true;
    await page.reload();

    // The refusal must be RENDERED, not merely "not a leak". `UNAVAILABLE` is the one state the portal draws
    // in the saturated signal token when the server refused; a stale sheet would read `STALE`, and a silent
    // success would read `LIVE`. Without this the three negatives below are also satisfied by a blank page.
    await expect(status, "a 403 must render the refusal state — never a silent success or a stale sheet").toHaveText(
      /UNAVAILABLE/,
      { timeout: 20_000 },
    );

    // Whatever the portal shows after a refusal, it must not be party B's data — nor a silent success.
    await expect(page.getByText(PARTY_B, { exact: false })).toHaveCount(0);
    expect(await page.content()).not.toContain(`SHP-${PARTY_B}`);
  });
});
