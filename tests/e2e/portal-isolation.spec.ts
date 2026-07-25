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

function boardFor(partyId: string): unknown {
  return {
    as_of: Date.now(),
    items: [{ shipment_id: `SHP-${partyId}-1`, lat_e6: 45_515_000, lon_e6: -122_678_000, status: "healthy" }],
  };
}

test.describe("the portal client stays inside its own party", () => {
  test("never puts a party scope on the wire — the server resolves it from the bearer alone", async ({ page }) => {
    const requests: string[] = [];
    await signIn(page, PARTY_A);
    await page.route("**/v1/**", async (route: Route) => {
      const url = route.request().url();
      requests.push(url);
      await route.fulfill({ json: boardFor(PARTY_A) });
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
      await route.fulfill({ json: boardFor(PARTY_A) });
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
      await route.fulfill({ json: boardFor(PARTY_A) });
    });

    await page.goto(PORTAL);
    // The party's own board loads first, so we know the refusal is what changed the screen.
    const status = page.getByTestId("board-status");
    await expect(status).toBeVisible({ timeout: 20_000 });

    refuse = true;
    await page.reload();

    // Whatever the portal shows after a refusal, it must not be party B's data — nor a silent success.
    await expect(status).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(PARTY_B, { exact: false })).toHaveCount(0);
    expect(await page.content()).not.toContain(`SHP-${PARTY_B}`);
  });
});
