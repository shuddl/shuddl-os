import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { TENANT_SLUG, ensureSchema, post, requiredEvidence, streamCount as countEvents, token } from "./helpers.js";

// REQ-185 (WP-08 exit audit) — credit.checked is a PRIVILEGED FINANCE DECISION, authorized at the WRITE
// BOUNDARY (POST /v1/shipments/:id/events), BEFORE the DO append. It is client-appendable (unlike a
// server-emitted money kind) but writes the tenant-global parties.credit_status that the REQ-042 credit-hold
// gate reads — so only a finance (or admin) principal may emit it. The exit audit found any driver/ops could
// overwrite an arbitrary party's credit_status and defeat the credit gate (a driver clearing a finance hold =
// a mis-bill; ops clearing it = a segregation-of-duties break). These prove the two-directional boundary:
// (a) driver/ops → 403 ZERO append; (b) finance reaches this route ONLY for a privileged decision.

const TENANT = TENANT_SLUG;
const VICTIM = "party-credit-victim"; // the party a non-finance principal would try to (un)hold

const driverTok = (): Promise<string> => token({ sub: "u-driver", tenant: TENANT, role: "driver" });
const opsTok = (): Promise<string> => token({ sub: "u-ca-ops", tenant: TENANT, role: "ops" });
const financeTok = (): Promise<string> => token({ sub: "u-ca-finance", tenant: TENANT, role: "finance" });
const adminTok = (): Promise<string> => token({ sub: "u-ca-admin", tenant: TENANT, role: "admin" });

// A valid credit.checked EventInput (client-suppliable subset). Fresh uuid per call.
function creditInput(shipmentId: string, partyId: string, status = "hold"): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-carrier" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "credit.checked",
    payload: { party_id: partyId, status },
  };
}

// A valid NON-privileged EventInput (appointment.set) — proves finance is confined to privileged decisions.
function apptInput(shipmentId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "appointment.set",
    payload: { leg_kind: "pickup", facility_id: "fac-x", slot_key: "x", window_start_ts: 1, window_end_ts: 2 },
  };
}

async function creditStatus(partyId: string): Promise<string | null> {
  const row = await env.TENANT_A_DB.prepare("SELECT credit_status FROM parties WHERE id = ?")
    .bind(partyId)
    .first<{ credit_status: string | null }>();
  return row?.credit_status ?? null;
}

async function seedBareParty(id: string, contacts: unknown[] = []): Promise<void> {
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
    .bind(id, "broker", "{}", JSON.stringify(contacts))
    .run();
}

beforeAll(async () => {
  await ensureSchema(env);
  await seedBareParty(VICTIM); // starts with NO credit decision (credit_status NULL)
});

describe("credit.checked requires finance-role authorization (REQ-185)", () => {
  it("an OPS user posting credit.checked → 403 FORBIDDEN, ZERO append, credit_status untouched", async () => {
    // ops has no driver-scope, so a 403 here is UNAMBIGUOUSLY the privileged-decision boundary (not a scope
    // miss). This is the segregation-of-duties proof: ops must not be able to clear a finance hold.
    const shp = "ca-ops";
    const before = await countEvents(shp);
    const beforeStatus = await creditStatus(VICTIM);
    const r = await post(shp, creditInput(shp, VICTIM, "clear"), await opsTok());
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("FORBIDDEN"); // NOT GATE_BLOCKED — refused at the route, before the DO
    expect(await countEvents(shp)).toBe(before); // nothing appended
    expect(await creditStatus(VICTIM)).toBe(beforeStatus); // credit_status never projected
  });

  it("a DRIVER posting credit.checked → 403, ZERO append, credit_status untouched", async () => {
    const shp = "ca-driver";
    const before = await countEvents(shp);
    const beforeStatus = await creditStatus(VICTIM);
    const r = await post(shp, creditInput(shp, VICTIM, "clear"), await driverTok());
    expect(r.status).toBe(403);
    expect(await countEvents(shp)).toBe(before);
    expect(await creditStatus(VICTIM)).toBe(beforeStatus);
  });

  it("a FINANCE user posting credit.checked{hold} → 201 and projects credit_status='hold'", async () => {
    const shp = "ca-finance-hold";
    const r = await post(shp, creditInput(shp, VICTIM, "hold"), await financeTok());
    expect(r.status).toBe(201);
    expect(await creditStatus(VICTIM)).toBe("hold");
  });

  it("an ADMIN posting credit.checked → 201 (admin is unrestricted)", async () => {
    const shp = "ca-admin";
    const r = await post(shp, creditInput(shp, VICTIM, "clear"), await adminTok());
    expect(r.status).toBe(201);
    expect(await creditStatus(VICTIM)).toBe("clear");
  });

  it("FINANCE may emit ONLY a privileged decision — a finance-posted non-privileged kind → 403, ZERO append", async () => {
    const shp = "ca-finance-nonpriv";
    const before = await countEvents(shp);
    const r = await post(shp, apptInput(shp), await financeTok());
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("FORBIDDEN");
    expect(await countEvents(shp)).toBe(before);
  });

  it("BINDING: a finance hold then BLOCKS that party's booking.created (the REQ-042 chain the audit demanded)", async () => {
    const party = "party-credit-chain";
    await seedBareParty(party, [{ kind: "billing", email: "chain@ca.example" }]); // deliverable, so ONLY credit can fail
    expect((await post("ca-chain-hold", creditInput("ca-chain-hold", party, "hold"), await financeTok())).status).toBe(201);
    expect(await creditStatus(party)).toBe("hold");
    // now an ops booking billing that held party is blocked by the credit gate (server-side, zero append)
    const booking = {
      id: crypto.randomUUID(),
      shipment_id: "ca-chain-book",
      ts: 1_720_000_000_000,
      actor: { party: "party-shipper" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "booking.created",
      payload: {
        quote_event_id: "evt-q",
        shipper_party_id: "party-shipper",
        consignee_party_id: "party-consignee",
        bill_to_party_id: party,
        division: "main",
      },
    };
    const rb = await post("ca-chain-book", booking, await opsTok());
    expect(rb.status).toBe(403);
    expect(rb.json?.code).toBe("GATE_BLOCKED");
    expect(await countEvents("ca-chain-book")).toBe(0);
  });
});

// Task 6 (REQ-042/183/185) — a NATIVE credit.checked writes tenant-global parties.credit_status that the
// REQ-042 booking credit-hold gate reads. A decision for an absent party USED to append + surface a projection
// GAP (silent-defeat risk: a later booking read NULL and passed as if clear). The fix FAILS CLOSED at the write
// boundary: reject the native write before any append, so an unresolvable credit decision produces ZERO events
// and never fabricates a party. The projection-gap mechanism stays for historical/imported (source≠native) rows,
// which the reconcile + booking-gate block then resolve fail-closed.
describe("Task 6 (REQ-042/183) — a NATIVE credit.checked for an unmaterialized party FAILS CLOSED at the write boundary", () => {
  it("finance posts credit.checked{hold} for a party that does NOT exist → 400 VALIDATION_FAILED, ZERO append, NO party fabricated", async () => {
    const ghost = "party-t6-never-created"; // deliberately NOT seeded — no parties row
    const shp = "ca-t6-reject";
    const before = await countEvents(shp);
    const input = creditInput(shp, ghost, "hold");
    const r = await post(shp, input, await financeTok());
    expect(r.status).toBe(400); // rejected at the DO before append (VALIDATION_FAILED → 400)
    expect(r.json?.code).toBe("VALIDATION_FAILED");

    // ZERO append — nothing committed for an unresolvable credit decision
    expect(await countEvents(shp)).toBe(before);
    // no party row fabricated, credit_status still null
    const party = await env.TENANT_A_DB.prepare("SELECT 1 AS x FROM parties WHERE id = ?").bind(ghost).first();
    expect(party).toBeNull();
    expect(await creditStatus(ghost)).toBeNull();
  });

  it("finance posts credit.checked{hold} for an EXISTING party → 201, projects credit_status (the honest path is unchanged)", async () => {
    const present = "party-t6-present-api";
    await seedBareParty(present);
    const input = creditInput("ca-t6-present", present, "hold");
    const r = await post("ca-t6-present", input, await financeTok());
    expect(r.status).toBe(201);
    expect(await creditStatus(present)).toBe("hold"); // the UPDATE landed
  });
});

// Task 6 (REQ-042/183) — an UNRESOLVED credit_projection_gap for the bill_to FAILS CLOSED: the booking gate
// consults open gaps scoped to the bill_to (after attempting reconciliation) and blocks with the DISTINCT
// ['credit_unresolved'] reason — the credit_status read is unreliable when a decision may not have landed. Zero
// append, unbypassable by any API path (REQ-030).
describe("Task 6 — an unresolved credit projection gap for the bill_to BLOCKS booking.created", () => {
  it("bill_to with an OPEN gap and no landed decision → booking GATE_BLOCKED ['credit_unresolved'], ZERO append", async () => {
    // The bill_to EXISTS and has a deliverable contact (so ONLY credit can fail), but carries an UNRESOLVED
    // credit_projection_gap and NO credit.checked decision on the ledger → reconcile cannot clear it → fail closed.
    const party = "party-t6-gap-bill";
    await seedBareParty(party, [{ kind: "billing", email: "gap@ca.example" }]);
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open')",
    )
      .bind("credit-projection-gap:t6-seed-gap", "credit_projection_gap", "party", party, "critical", "{}")
      .run();

    const booking = {
      id: crypto.randomUUID(),
      shipment_id: "ca-t6-gap-book",
      ts: 1_720_000_000_000,
      actor: { party: "party-shipper" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "booking.created",
      payload: {
        quote_event_id: "evt-q",
        shipper_party_id: "party-shipper",
        consignee_party_id: "party-consignee",
        bill_to_party_id: party,
        division: "main",
      },
    };
    const rb = await post("ca-t6-gap-book", booking, await opsTok());
    expect(rb.status).toBe(403);
    expect(rb.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(rb)).toEqual(["credit_unresolved"]);
    expect(await countEvents("ca-t6-gap-book")).toBe(0);
  });
});
