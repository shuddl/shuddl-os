import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { token } from "./helpers.js";

// §1552 (REQ-030/202/118) — THE `… ID TOO LONG` GUARDS, SWEPT AT LAST.
//
// `GO-LIVE-CHECKLIST`'s replicated-guard row has carried *"`SHIPMENT ID TOO LONG` x5"* as **still-unswept**
// since §377. §1550's size-bound re-measurement reached the same seven guards from the other side — a batch
// mutation raising every `MAX_*_ID_LEN` in `workers/api/src/routes/` to 9,000,000 reded **2 of 14**, and NO test
// anywhere names the string "TOO LONG". This closes that residual.
//
// WHAT THE GUARDS ARE FOR, in their own words: *"bound length BEFORE the DO name / any query (400, not 500)"*.
// A path segment becomes a Durable Object name, a KV idempotency key and a D1 parameter; each has its own
// ceiling and each fails as a 500 rather than a refusal. Two guards already had a case — `rate.ts` (*"capped
// before the DO name"*) and `events.ts` (*"KV idempotency-key overflow"*) — and they are included below so the
// roster is the whole family and their coverage cannot be deleted without this failing.
//
// THE MESSAGE IS THE DISCRIMINATOR, not the status (§1500). Four of these routes are POSTs that would answer
// 400 for a malformed body too, so asserting only `400` would credit the length guard for a sibling's refusal.
// Each case asserts the envelope's `message` names the length, which no other guard on these routes emits.

const OPS = { sub: "u-len", tenant: "tenant-a", role: "ops" as const };

interface Guard {
  readonly what: string;
  readonly method: "GET" | "POST";
  /** `{id}` is replaced by the over-long value. */
  readonly path: string;
  readonly cap: number;
  readonly role?: string;
  readonly body?: unknown;
}

// Every `… ID TOO LONG` guard in workers/api/src/routes, with the cap its own file declares.
const GUARDS: readonly Guard[] = [
  { what: "documents.ts:43 shipment id", method: "GET", path: "/v1/shipments/{id}/documents", cap: 200 },
  { what: "documents.ts:71 document id", method: "GET", path: "/v1/documents/{id}/url", cap: 300 },
  { what: "approvals.ts:112 shipment id", method: "POST", path: "/v1/shipments/{id}/approval-decision", cap: 200, body: { decision: "approved" } },
  { what: "dunning.ts:448 draft id", method: "POST", path: "/v1/dunning/{id}/send", cap: 200, body: {} },
  { what: "portal-actions.ts:125 shipment id", method: "POST", path: "/v1/shipments/{id}/accept-quote", cap: 200, body: { quote_event_id: "q1" } },
  { what: "portal-actions.ts:163 shipment id", method: "POST", path: "/v1/shipments/{id}/claim", cap: 200, body: { reason: "damaged" } },
  { what: "events.ts:184 shipment id (already pinned — kept so the roster is the family)", method: "POST", path: "/v1/shipments/{id}/events", cap: 200, body: {} },
];

async function call(g: Guard, id: string): Promise<{ status: number; message: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${await token({ ...OPS, ...(g.role !== undefined ? { role: g.role } : {}) })}`,
  };
  if (g.method === "POST") headers["Idempotency-Key"] = crypto.randomUUID();
  const res = await SELF.fetch(`https://api.local${g.path.replace("{id}", id)}`, {
    method: g.method,
    headers,
    ...(g.method === "POST" ? { body: JSON.stringify(g.body ?? {}) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  return { status: res.status, message: json.message ?? "" };
}

describe("§1552 REQ-030: every `… ID TOO LONG` guard refuses, and says so", () => {
  it("covers the whole family (non-vacuity — a shrinking roster must fail here, not cover less)", () => {
    // Floor the INPUT (§1148). Seven guards were measured across five route files; a deleted case is a
    // shrinking roster, which is exactly what §377 left unswept for five months.
    expect(GUARDS.length, "the guard roster shrank — a case was removed rather than a guard").toBeGreaterThanOrEqual(7);
  });

  for (const g of GUARDS) {
    it(`${g.what}: ${g.cap + 1} chars → 400 naming the length`, async () => {
      const over = await call(g, "x".repeat(g.cap + 1));
      expect(over.status, `${g.what} did not refuse an over-long id — it becomes a DO name and a KV key downstream`).toBe(400);
      expect(
        over.message,
        `${g.what} refused with 400 but the message does not name the LENGTH, so this case cannot tell the ` +
          `length guard from a sibling 400 on the same route (a malformed body, a missing field).`,
      ).toMatch(/TOO LONG/i);
    });
  }
});

// §1553 (REQ-196/202/118) — ONE EMAIL CEILING, NOT THREE.
//
// `intake.ts` declared `MAX_EMAIL_LEN = 320` (the theoretical 64+1+255) while `contracts@MAX_EMAIL_LEN` is
// **254**, the RFC 5321 address maximum — and 254 is what `comms.ts` enforces on `to_ref`, the MAIL RECIPIENT.
// So intake accepted and STORED addresses the mail layer would later refuse: the failure surfaced at send time,
// on the dunning/evidence path, for a party an operator had already saved. `mcp/tools/quote.ts` had the same
// 320, and `concierge/parse.ts` had it as a bare inline literal.
//
// §1515 fixed exactly this shape for zips — *"the shared ceiling, not a local 16: three surfaces had three
// answers for one field"* — and stopped at zips. This is the same sentence about emails.
describe("§1553 the email ceiling is the SHARED one, so what intake stores the mail layer can send", () => {
  it("intake refuses an address one character over the shared ceiling, and admits one at it", async () => {
    const post = async (email: string): Promise<number> => {
      const res = await SELF.fetch("https://api.local/v1/parties", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          Authorization: `Bearer ${await token(OPS)}`,
        },
        body: JSON.stringify({ name: "Acme", email, kind: "shipper" }),
      });
      return res.status;
    };
    const local = (n: number): string => `${"a".repeat(n - 12)}@example.com`;
    expect(await post(local(255)), "intake accepted an address the mail layer (comms to_ref, 254) will refuse").toBe(400);
    expect(await post(local(254)), "intake rejected an address AT the shared ceiling — the refusal above proves nothing").not.toBe(400);
  });
});
