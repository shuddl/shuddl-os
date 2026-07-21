import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashEvent } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import { resolveRecipient } from "../../agents/src/biller.js";
import {
  TENANT_SLUG,
  ensureSchema,
  post,
  requiredEvidence,
  streamCount as countEvents,
  token,
} from "./helpers.js";

// REQ-042/182 (WP-08 T6; origin REQ-047) — THE BOOKING GATES over the REAL API path (POST
// /v1/shipments/:id/events → sequencer DO → Gatekeeper). REQ-030: enforced SERVER-SIDE in the ledger,
// unbypassable by any client. Context is SERVER-SOURCED from the parties read-model — the BILL_TO party's
// credit_status (REQ-042) and the BILL_TO party's contacts (REQ-182) — NEVER from prior events (booking.created
// is the FIRST event on a fresh stream). The gate checks the bill_to because that is the party the Biller's
// resolveRecipient emails: gating its contact is what guarantees a passing booking has a resolvable evidence
// recipient (the party checked == the party emailed). Every block returns 403 GATE_BLOCKED + ZERO append.

const TENANT = TENANT_SLUG;

// This file's OWN parties — NEVER mutate the shared cast. The bill_to is the gated + emailed party; the
// consignee is irrelevant to these gates (REQ-182 corrected the target off the consignee). `_c` = has a
// deliverable email; `_x` = no contact.
const BILL_HOLD = "t6-bill-hold-c"; // credit 'hold', HAS contact  → only credit can fail
const BILL_CLEAR = "t6-bill-clear-c"; // credit 'clear', HAS contact → happy path
const BILL_NODECISION = "t6-bill-null-c"; // credit NULL, HAS contact
const BILL_NOCONTACT = "t6-bill-clear-x"; // credit 'clear', NO contact → only the recipient gate can fail
const BILL_HOLD_NOCONTACT = "t6-bill-hold-x"; // credit 'hold', NO contact → both gates fail
const CONS_EMAIL = "t6-cons-email"; // a consignee WITH an email — proves it does NOT rescue a no-contact bill_to
const CONS_ANY = "t6-cons-any"; // an arbitrary consignee (its contact is irrelevant to the gate)

const opsTok = (): Promise<string> => token({ sub: "u-t6-ops", tenant: TENANT, role: "ops" });
const withEmail = (addr: string): unknown[] => [{ kind: "billing", email: addr }];

async function seedParty(id: string, kind: string, opts: { credit_status?: string | null; contacts?: unknown[] }): Promise<void> {
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts, credit_status) VALUES (?,?,?,?,?)")
    .bind(id, kind, "{}", JSON.stringify(opts.contacts ?? []), opts.credit_status ?? null)
    .run();
}

// A valid booking.created EventInput. Fresh uuid per call; bill_to (and the opt-out) are the levers.
function bookingInput(
  shipmentId: string,
  billTo: string,
  payloadOver: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
  consignee: string = CONS_ANY,
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "booking.created",
    payload: {
      quote_event_id: "evt-quote-1",
      shipper_party_id: "party-shipper",
      consignee_party_id: consignee,
      bill_to_party_id: billTo,
      division: "main",
      ...payloadOver,
    },
    ...over,
  };
}

async function rawRows(shipmentId: string): Promise<Record<string, string | number | null>[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return res.results as Record<string, string | number | null>[];
}

beforeAll(async () => {
  await ensureSchema(env);
  await seedParty(BILL_HOLD, "broker", { credit_status: "hold", contacts: withEmail("hold@t6.example") });
  await seedParty(BILL_CLEAR, "broker", { credit_status: "clear", contacts: withEmail("clear@t6.example") });
  await seedParty(BILL_NODECISION, "broker", { credit_status: null, contacts: withEmail("null@t6.example") });
  await seedParty(BILL_NOCONTACT, "broker", { credit_status: "clear", contacts: [] });
  await seedParty(BILL_HOLD_NOCONTACT, "broker", { credit_status: "hold", contacts: [] });
  await seedParty(CONS_EMAIL, "consignee", { contacts: withEmail("consignee@t6.example") });
  await seedParty(CONS_ANY, "consignee", { contacts: [] });
});

// ─── REQ-042 — a bill_to credit HOLD blocks booking.created (server-side, zero append) ───────────────
describe("credit-hold booking gate (REQ-042)", () => {
  it("bill_to on credit HOLD → 403 GATE_BLOCKED ['credit_clear'], ZERO append", async () => {
    const shp = "t6-credit-hold";
    const before = await countEvents(shp);
    const r = await post(shp, bookingInput(shp, BILL_HOLD), await opsTok());
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(r)).toEqual(["credit_clear"]);
    expect(await countEvents(shp)).toBe(before); // the shipment stream was never opened
  });

  it("a named override (elevated role) releases the hold → 201 + override stamped to the authenticated author", async () => {
    const shp = "t6-credit-override";
    const clientClaim = { by: "not-the-author", reason: "prepay wired; hold released by finance" };
    const r = await post(shp, bookingInput(shp, BILL_HOLD, {}, { override: clientClaim }), await opsTok());
    expect(r.status).toBe(201);
    const stamped = { by: "u-t6-ops", reason: clientClaim.reason };
    expect(r.json?.override).toEqual(stamped);
    // Permanently visible on the STORED, hashed event (REQ-049).
    const rows = await rawRows(shp);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(JSON.parse(String(row.override_json))).toEqual(stamped);
    expect(await hashEvent(rowToEvent(row))).toBe(row.hash);
  });

  it("bill_to 'clear' → 201", async () => {
    const shp = "t6-credit-clear";
    expect((await post(shp, bookingInput(shp, BILL_CLEAR), await opsTok())).status).toBe(201);
    expect(await countEvents(shp)).toBe(1);
  });

  it("bill_to with NO credit decision on file (NULL) → 201", async () => {
    const shp = "t6-credit-null";
    expect((await post(shp, bookingInput(shp, BILL_NODECISION), await opsTok())).status).toBe(201);
  });
});

// ─── REQ-191 (WP-09 exit audit C-2) — booking.created is IDEMPOTENT PER STREAM, server-side ───────────
describe("booking is idempotent per stream (REQ-191)", () => {
  it("a SECOND booking.created on an already-booked shipment → 400 VALIDATION_FAILED, still exactly ONE booking, ZERO regression", async () => {
    const shp = "t6-rebook-c2";
    // first booking commits (credit-clear bill_to, deliverable contact → passes the gates)
    expect((await post(shp, bookingInput(shp, BILL_CLEAR), await opsTok())).status).toBe(201);
    // a second booking.created (a fresh event id) on the SAME stream — the exploit's final append. The DO gate
    // rejects it BEFORE the credit/contact checks so the reason is the invariant, not a credit reason.
    const r2 = await post(shp, bookingInput(shp, BILL_CLEAR), await opsTok());
    expect(r2.status).toBe(400);
    expect(r2.json?.code).toBe("VALIDATION_FAILED");
    const bookings = (await rawRows(shp)).filter((row) => row.kind === "booking.created");
    expect(bookings).toHaveLength(1); // the append-only ledger never gained a duplicate
  });
});

// ─── REQ-182 — the EVIDENCE RECIPIENT (bill_to) must have a deliverable contact, or a named opt-out ────
describe("evidence-recipient booking gate (REQ-182)", () => {
  it("bill_to with NO deliverable contact + no opt-out → 403 GATE_BLOCKED ['evidence_recipient'], ZERO append", async () => {
    const shp = "t6-recip-nomail";
    const before = await countEvents(shp);
    const r = await post(shp, bookingInput(shp, BILL_NOCONTACT), await opsTok());
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(r)).toEqual(["evidence_recipient"]);
    expect(await countEvents(shp)).toBe(before);
  });

  it("BROKER case (C1/REQ-182): a consignee WITH an email does NOT rescue a bill_to with no contact → 403", async () => {
    // The whole point of REQ-182: the evidence email goes to the bill_to, so the consignee's contact is
    // irrelevant. Under the old consignee gate this booking wrongly passed and then the email silently HELD.
    const shp = "t6-broker-billto-nomail";
    const r = await post(shp, bookingInput(shp, BILL_NOCONTACT, {}, {}, CONS_EMAIL), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["evidence_recipient"]);
    expect(await countEvents(shp)).toBe(0);
  });

  it("a bill_to WITH a deliverable email → 201", async () => {
    const shp = "t6-recip-email";
    expect((await post(shp, bookingInput(shp, BILL_CLEAR), await opsTok())).status).toBe(201);
    expect(await countEvents(shp)).toBe(1);
  });

  it("the payload opt-out flag books a no-contact recipient → 201 (the deliberate escape, recorded on the event)", async () => {
    const shp = "t6-recip-optout";
    const r = await post(shp, bookingInput(shp, BILL_NOCONTACT, { evidence_contact_opt_out: true }), await opsTok());
    expect(r.status).toBe(201);
    const rows = await rawRows(shp);
    expect(JSON.parse(String(rows[0]!.payload)).evidence_contact_opt_out).toBe(true);
  });
});

// ─── the two gates COMPOSE; the block reason order is deterministic; the opt-out is NOT an override ───
describe("both gates compose (REQ-042 + REQ-182)", () => {
  it("hold + no-contact → 403, credit is reported FIRST (deterministic order), ZERO append", async () => {
    const shp = "t6-both-blocked";
    const before = await countEvents(shp);
    const r = await post(shp, bookingInput(shp, BILL_HOLD_NOCONTACT), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["credit_clear"]); // credit runs before the recipient gate
    expect(await countEvents(shp)).toBe(before);
  });

  it("a credit override does NOT rescue a no-contact recipient — still 403 ['evidence_recipient'], ZERO append", async () => {
    // The override releases the credit hold, but the recipient gate is non-overridable: a booking must never
    // ship with no way to reach the evidence recipient. Only the payload opt-out is that escape.
    const shp = "t6-override-not-recip";
    const before = await countEvents(shp);
    const r = await post(shp, bookingInput(shp, BILL_HOLD_NOCONTACT, {}, { override: { by: "x", reason: "prepay wired" } }), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["evidence_recipient"]);
    expect(await countEvents(shp)).toBe(before);
  });

  it("hold cleared by override + recipient opt-out → 201 (both escapes together open the booking)", async () => {
    const shp = "t6-override-plus-optout";
    const r = await post(
      shp,
      bookingInput(shp, BILL_HOLD_NOCONTACT, { evidence_contact_opt_out: true }, { override: { by: "x", reason: "prepay wired" } }),
      await opsTok(),
    );
    expect(r.status).toBe(201);
    expect(await countEvents(shp)).toBe(1);
  });
});

// ─── REQ-060 — HAZMAT booking requires per-tenant WORKSPACE enablement (server-side, control-plane flag) ──
// A booking DECLARED hazmat (payload.hazmat === true) is REFUSED unless THIS tenant's control-plane policy
// carries hazmat_enabled=true. The entitlement is read from the SERVER control plane keyed off the DO's pinned
// tenant — never the client event body — so the flag is prompt/client-independent (REQ-030). Default OFF /
// fail-closed. Each case uses a FRESH shipment id → a fresh sequencer DO → a fresh #policy read, so the ON case
// sees the toggled policy; the ON case restores the shared {} policy so the rest of the suite is unaffected.
describe("hazmat entitlement booking gate (REQ-060)", () => {
  const HAZMAT_ON = '{"hazmat_enabled":true}';
  const HAZMAT_OFF = "{}";
  const setPolicy = (p: string): Promise<unknown> =>
    env.CONTROL_DB.prepare("UPDATE tenants SET policy = ? WHERE slug = ?").bind(p, TENANT).run();

  it("a DECLARED-hazmat booking for a NON-enabled tenant (default OFF) → 403 FORBIDDEN, ZERO append", async () => {
    await setPolicy(HAZMAT_OFF);
    const shp = "t9-hazmat-off";
    const before = await countEvents(shp);
    const r = await post(shp, bookingInput(shp, BILL_CLEAR, { hazmat: true }), await opsTok());
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("FORBIDDEN");
    expect(await countEvents(shp)).toBe(before); // the shipment stream was never opened
  });

  it("the SAME booking for an ENABLED tenant (policy.hazmat_enabled=true) → 201; the declaration rides the append-only payload", async () => {
    await setPolicy(HAZMAT_ON);
    try {
      const shp = "t9-hazmat-on";
      const r = await post(shp, bookingInput(shp, BILL_CLEAR, { hazmat: true }), await opsTok());
      expect(r.status).toBe(201);
      expect(await countEvents(shp)).toBe(1);
      const rows = await rawRows(shp);
      expect(JSON.parse(String(rows[0]!.payload)).hazmat).toBe(true);
    } finally {
      await setPolicy(HAZMAT_OFF); // restore the shared tenant policy (the rest of the suite assumes {})
    }
  });

  it("the entitlement is CONTROL-PLANE, not a client field: a payload cannot smuggle hazmat_enabled (.strict) → ZERO append", async () => {
    await setPolicy(HAZMAT_OFF); // tenant NOT enabled
    const shp = "t9-hazmat-spoof";
    // hazmat_enabled is NOT a booking payload field — the strict payload rejects it (400); even if it parsed, the
    // gate reads the SERVER control plane, never the body. Either way the tenant cannot self-grant → no append.
    const r = await post(shp, bookingInput(shp, BILL_CLEAR, { hazmat: true, hazmat_enabled: true }), await opsTok());
    expect([400, 403]).toContain(r.status);
    expect(await countEvents(shp)).toBe(0);
  });

  it("a NON-hazmat booking is UNAFFECTED — the gate fires ONLY on payload.hazmat === true", async () => {
    await setPolicy(HAZMAT_OFF); // tenant NOT hazmat-enabled, yet a plain booking still commits
    const shp = "t9-hazmat-none";
    const r = await post(shp, bookingInput(shp, BILL_CLEAR), await opsTok());
    expect(r.status).toBe(201);
    expect(await countEvents(shp)).toBe(1);
  });
});

// ─── BINDING (C1/REQ-182): a gate-PASSING booking yields a RESOLVABLE evidence recipient ──────────────
// The gate and the Biller are wired to the SAME party (bill_to) via the SAME predicate. This proves the
// end-to-end guarantee directly: a booking that passes the gate (without opting out) is one whose bill_to
// resolveRecipient — the exact function the Biller uses to address the invoice + evidence email — returns a
// real address. This is the anti-regression for GA-6's intent ("the evidence email has a recipient").
describe("binding: gate-pass ⇒ resolveRecipient(bill_to) is non-null (REQ-182)", () => {
  it("a booking that PASSES the gate resolves an evidence recipient for its bill_to", async () => {
    const shp = "t6-binding-ok";
    expect((await post(shp, bookingInput(shp, BILL_CLEAR), await opsTok())).status).toBe(201);
    const recipient = await resolveRecipient(env.TENANT_A_DB, BILL_CLEAR);
    expect(typeof recipient).toBe("string");
    expect(recipient).toContain("@");
  });

  it("the party the gate BLOCKS is exactly the party resolveRecipient could not reach (no recipient)", async () => {
    // The blocked bill_to is the one whose resolveRecipient is undefined — the gate blocked precisely the
    // booking the Biller could not have emailed. (Opt-out is the acknowledged exception, not tested here.)
    const shp = "t6-binding-block";
    const r = await post(shp, bookingInput(shp, BILL_NOCONTACT), await opsTok());
    expect(r.status).toBe(403);
    expect(await resolveRecipient(env.TENANT_A_DB, BILL_NOCONTACT)).toBeUndefined();
  });
});
