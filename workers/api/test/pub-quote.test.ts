import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ensureSchema,
  seedRateConfig,
  seedTransitMatrix,
  TEST_RATE_CONFIG,
  TEST_TRANSIT_MATRIX,
  token,
  TENANT_SLUG,
} from "./helpers.js";

// REQ-051/189 (WP-09 Task 4) — POST /pub/quote: the SECOND no-auth public surface. A stranger prices freight
// with NO account and ZERO ledger residue. "Guest may QUOTE, never BOOK." This is a PURE PREVIEW: it calls the
// rating engine directly and appends NOTHING (no quote.priced, no agent.acted, no stream, no DO). The
// adversarial cases ARE the spec — every case drives the REAL /pub route.
//
// The locked laws under test:
//   GQ-1  margin leak — floors/basis/versions/approval/anomaly reach the stranger NOWHERE; keys ⊆ the 4 allowed.
//   GQ-2  zero ledger residue (Law 2) — N quotes (priced AND unknown) append NOTHING; no q:/s: stream.
//   GQ-3  no price on air (REQ-004) — a weightless body => UNKNOWN, no event, no fabricated transit number.
//   GQ-4  guest cannot book — /pub/quote never emits booking.created; a guest at /v1/rate is 401/403.
//   GQ-5  shipment_id footgun — a body carrying shipment_id is a 400 (.strict rejects it), no append.

// The strict output allowlist — the ONLY top-level keys a PRICED quote may carry (locked design §4).
const ALLOWED_KEYS = new Set(["status", "sell_cents", "lines", "transit"]);
// Every rating internal that must NEVER reach a stranger (the redaction the counterparty lens also strips,
// plus the approval/anomaly gate internals that assessApproval/pricedResponse would have exposed).
const MARGIN_KEYS = [
  "floors",
  "basis",
  "versions",
  "approval",
  "anomaly",
  "cost_cents",
  "gross_sell_cents",
  "executing_share_bps",
  "evaluated_sell_cents",
];
const LINE_ALLOWED = new Set(["kind", "code", "amount_cents"]);

// origin 97201 → Z1, dest 80012 → Z5 (TEST_RATE_CONFIG.zone_tariff); weight+dims present ⇒ PRICED (rg-far).
const DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };
const PRICED_BODY = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: DIMS };
// No weight, no dims ⇒ priceFreight returns UNKNOWN missing_physics (no price on air).
const WEIGHTLESS_BODY = { origin_zip: "97201", dest_zip: "80012" };

interface QRes {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}
async function quote(body: unknown, headers?: Record<string, string>): Promise<QRes> {
  const res = await SELF.fetch("https://api.local/pub/quote", {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

// The tenant-a events table (SHARED across files — isolatedStorage off). GQ-2/3/5 assert a DELTA (unchanged),
// NEVER count===0: other files' events persist. Zero RESIDUE means our calls added nothing.
async function eventCount(): Promise<number> {
  const row = await env.TENANT_A_DB.prepare("SELECT count(*) AS n FROM events").first<{ n: number }>();
  return row?.n ?? 0;
}
// The quote/shipment stream prefixes a booking flow WOULD create (q:… quote stream, s:… shipment stream). A
// pure preview must create neither.
async function quoteStreamCount(): Promise<number> {
  const row = await env.TENANT_A_DB.prepare(
    "SELECT count(*) AS n FROM events WHERE stream_id LIKE 'q:%' OR stream_id LIKE 's:%'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await ensureSchema(env);
  await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
  await seedTransitMatrix(env.TENANT_A_DB, TEST_TRANSIT_MATRIX);
});

// GQ-1 — MARGIN LEAK (most severe). A PRICED body returns sell_cents + transit; every rating internal is
// structurally absent (keys ⊆ the allowlist) AND absent from the serialized bytes.
describe("GQ-1: margin leak", () => {
  it("a PRICED quote carries sell_cents+transit; floors/basis/versions/approval/anomaly appear NOWHERE", async () => {
    const r = await quote(PRICED_BODY);
    expect(r.status).toBe(200);
    const json = r.json!;
    expect(json.status).toBe("PRICED");
    expect(typeof json.sell_cents).toBe("number");
    expect(json.transit).toBeDefined();

    // top-level keys ⊆ the strict allowlist (a fail-closed schema, not a substring)
    for (const k of Object.keys(json)) expect(ALLOWED_KEYS.has(k), `unexpected top-level key ${k}`).toBe(true);

    // no rating internal — not as a key, not as a byte anywhere in the body
    for (const leak of MARGIN_KEYS) {
      expect(leak in json, `top-level ${leak} leaked`).toBe(false);
      expect(r.text, `serialized body leaked ${leak}`).not.toContain(leak);
    }

    // lines are the margin-free itemized preview (kind/code/amount_cents only — mirrors the counterparty
    // quote.priced redaction, which strips floors/basis/versions and keeps sell + lines).
    const lines = json.lines as Array<Record<string, unknown>>;
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const k of Object.keys(line)) expect(LINE_ALLOWED.has(k), `unexpected line key ${k}`).toBe(true);
    }
  });
});

// GQ-2 — ZERO LEDGER RESIDUE (Law 2). N quotes, priced AND unknown, append NOTHING and create no stream.
describe("GQ-2: zero ledger residue", () => {
  it("N priced+unknown quotes leave the event count UNCHANGED and create no q:/s: stream", async () => {
    const beforeEvents = await eventCount();
    const beforeStreams = await quoteStreamCount();
    for (let i = 0; i < 5; i++) {
      expect((await quote(PRICED_BODY)).status).toBe(200);
      expect((await quote(WEIGHTLESS_BODY)).status).toBe(200);
    }
    expect(await eventCount()).toBe(beforeEvents);
    expect(await quoteStreamCount()).toBe(beforeStreams);
  });
});

// GQ-3 — NO PRICE ON AIR (REQ-004). A weightless/dimless body => UNKNOWN, no event, and NO fabricated transit.
describe("GQ-3: no price on air", () => {
  it("a weightless body returns UNKNOWN with no sell_cents, no transit number, and appends nothing", async () => {
    const before = await eventCount();
    const r = await quote(WEIGHTLESS_BODY);
    expect(r.status).toBe(200);
    expect(r.json?.status).toBe("UNKNOWN");
    const json = r.json ?? {};
    expect("sell_cents" in json).toBe(false); // no price on air
    expect("transit" in json).toBe(false); // no fabricated transit window on an UNKNOWN
    expect(await eventCount()).toBe(before);
  });
});

// GQ-4 — GUEST CANNOT BOOK. /pub/quote never books; the authed booking path (/v1/rate) is closed to a guest.
describe("GQ-4: guest cannot book", () => {
  it("a no-auth guest hitting /v1/rate is 401 (missing bearer — auth runs on /v1/*)", async () => {
    const res = await SELF.fetch("https://api.local/v1/rate", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "gq4-noauth" },
      body: JSON.stringify({ shipment_id: "s-guest", origin_zip: "97201", dest_zip: "80012", weight_lb: 1000 }),
    });
    expect(res.status).toBe(401);
  });

  it("a portal-role token hitting /v1/rate is 403 (requireRole ops/admin/finance)", async () => {
    const t = await token({ sub: "guest", tenant: TENANT_SLUG, role: "portal", party_id: "party-consignee" });
    const res = await SELF.fetch("https://api.local/v1/rate", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "content-type": "application/json", "Idempotency-Key": "gq4-portal" },
      body: JSON.stringify({ shipment_id: "s-guest", origin_zip: "97201", dest_zip: "80012", weight_lb: 1000 }),
    });
    expect(res.status).toBe(403);
  });

  it("/pub/quote never emits booking.created — no booking bytes, event count unchanged", async () => {
    const before = await eventCount();
    const r = await quote(PRICED_BODY);
    expect(["PRICED", "UNKNOWN"]).toContain(r.json?.status);
    expect(r.text).not.toContain("booking");
    expect(await eventCount()).toBe(before);
  });
});

// GQ-5 — SHIPMENT_ID FOOTGUN. A guest body carrying shipment_id is a 400 (.strict rejects it), no append. This
// is the whole reason the guest schema does NOT reuse RateBody (which REQUIRES shipment_id): a future rewrite
// can never derive an `s:${shipment_id}` stream for a stranger.
describe("GQ-5: shipment_id footgun", () => {
  it("a body carrying shipment_id is rejected 400 and appends nothing", async () => {
    const before = await eventCount();
    const r = await quote({ shipment_id: "s-guest", origin_zip: "97201", dest_zip: "80012", weight_lb: 1000 });
    expect(r.status).toBe(400);
    expect(await eventCount()).toBe(before);
  });

  it("other ops-only fields (legs / tenant_party / proposed_sell_cents) are also rejected 400", async () => {
    for (const extra of [
      { legs: [{ kind: "linehaul", executor: "x", split_bps: 10_000 }] },
      { tenant_party: "party-carrier" },
      { proposed_sell_cents: 1 },
    ]) {
      const r = await quote({ origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, ...extra });
      expect(r.status, `extra ${JSON.stringify(extra)} should be 400`).toBe(400);
    }
  });
});

// ── GQ-6 (§1471, REQ-051/189/004) — THE GUEST TWIN AND /v1/rate PRICE THE SAME INPUT IDENTICALLY ──────────────
//
// `routes/rate.ts` and `pub/quote.ts` name each other as twins in comments — *"the guest twin (src/pub/quote.ts)
// declares these fields EXCLUDED forever for the same reason"*, *"Mirrors routes/rate.ts"* — and one half of that
// coupling is genuinely SHARED (rate.ts EXPORTS its transit-window mapper so the no-auth surface maps through the
// same function). The other half is behavioural and was pinned by nothing.
//
// Everything in this file until now tests the guest surface in ISOLATION: margin leak, zero residue, no price on
// air, guest-cannot-book, the shipment_id footgun. The five `/v1/rate` references are all AUTH assertions (401 for
// no bearer, 403 for a portal role) — none compares a PRICE. So the twinning was asserted about the SHAPE of the
// two surfaces and never about their ANSWER.
//
// Both call the same `priceShipment(request, config)`, which is exactly what makes a divergence plausible rather
// than absurd: the engine is shared, so a drift lives in how each surface BUILDS the request or which config it
// loads, and each side's own tests would stay green through it. What it would cost is acceptance demo #2 — a
// stranger quotes 
// a number, then hears a different one from a CSR pricing the same freight.
//
// One body, both surfaces, same answer.
describe("GQ-6: the guest twin and /v1/rate price the SAME physics identically (§1471)", () => {
  it("one body through both surfaces yields the same status, sell_cents and transit", async () => {
    // §1471 — the body carries an ACCESSORIAL on purpose. The first cut used PRICED_BODY, which has none, and
    // a mutation dropping the accessorial mapping from the guest surface reded NOTHING: the corpus could not
    // reach the code the test claimed to cover. `liftgate` is priced by TEST_RATE_CONFIG (3500), so the two
    // surfaces now have to agree about a charge line, not just a linehaul.
    const PARITY_BODY = { ...PRICED_BODY, accessorials: ["liftgate"] };
    const guest = await quote(PARITY_BODY);
    expect(guest.status, "the guest surface must price this body").toBe(200);
    expect(guest.json?.status).toBe("PRICED");

    const opsTok = await token({ sub: "u-gq6-ops", tenant: TENANT_SLUG, role: "ops" });
    const authed = await SELF.fetch("https://api.local/v1/rate", {
      method: "POST",
      headers: { Authorization: `Bearer ${opsTok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      // The SAME physics — only `shipment_id` differs, which is the ops-only field the guest surface rejects.
      // It is passed BARE: the route builds the stream as `s:${shipment_id}`, so an `s:`-prefixed value here
      // yields `s:s:…` and trips STREAM_ID_RE (measured — a 400 'malformed stream id', not a pricing failure)
      // by design (GQ-5). Nothing else may differ, or this stops being a comparison.
      body: JSON.stringify({ shipment_id: "gq6-parity", ...PARITY_BODY }),
    });
    expect(authed.status, "the authenticated surface must price the same body").toBe(200);
    const rate = (await authed.json()) as { status: string; sell_cents: number; transit?: unknown };

    expect(rate.status, "the two surfaces disagree on whether this freight is priceable at all").toBe(guest.json?.status);
    expect(
      rate.sell_cents,
      "the guest twin and /v1/rate returned DIFFERENT sell_cents for identical physics. Both call the same " +
        "priceShipment, so the drift is in how one surface builds its RateRequest or which rate_config it loads — " +
        "and a stranger who is quoted one number, then hears another from a CSR, is acceptance demo #2 failing in " +
        "the only way that matters commercially.",
    ).toBe(guest.json?.sell_cents);
    expect(rate.transit, "the two surfaces disagree on transit for identical physics").toEqual(guest.json?.transit);
  });
});
