import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { TENANT_SLUG, ensureSchema, post, streamCount as countEvents, token } from "./helpers.js";

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

// REQ-183 — the credit.checked→parties.credit_status projection is a SILENT no-op when the party row does not
// exist yet: the UPDATE matches nothing, the hold never lands, and a later booking reads NULL and PASSES the
// credit gate. This proves the end-to-end sequencer path surfaces that miss LOUDLY (a durable `anomalies` row)
// and NEVER fabricates the missing party.
describe("REQ-183 — a credit.checked for an unmaterialized party appends but surfaces a LOUD projection gap", () => {
  async function anomalyRow(id: string): Promise<{ rule: string; object_id: string; severity: string } | null> {
    return env.TENANT_A_DB.prepare("SELECT rule, object_id, severity FROM anomalies WHERE id = ?")
      .bind(id)
      .first<{ rule: string; object_id: string; severity: string }>();
  }

  it("finance posts credit.checked{hold} for a party that does NOT exist → 201, NO party fabricated, gap surfaced", async () => {
    const ghost = "party-183-never-created"; // deliberately NOT seeded — no parties row
    const input = creditInput("ca-183-gap", ghost, "hold");
    const r = await post("ca-183-gap", input, await financeTok());
    expect(r.status).toBe(201); // the credit.checked EVENT is committed truth even though the projection missed

    // no party row was fabricated by the projection (append-only / no-invented-data law)
    const party = await env.TENANT_A_DB.prepare("SELECT 1 AS x FROM parties WHERE id = ?").bind(ghost).first();
    expect(party).toBeNull();
    expect(await creditStatus(ghost)).toBeNull();

    // the projection gap is surfaced LOUDLY on the durable anomalies table (rule + object_id + critical)
    const a = await anomalyRow(`credit-projection-gap:${input.id as string}`);
    expect(a).not.toBeNull();
    expect(a!.rule).toBe("credit_projection_gap");
    expect(a!.object_id).toBe(ghost);
    expect(a!.severity).toBe("critical");
  });

  it("finance posts credit.checked{hold} for an EXISTING party → 201, projects credit_status, NO gap row", async () => {
    const present = "party-183-present-api";
    await seedBareParty(present);
    const input = creditInput("ca-183-present", present, "hold");
    const r = await post("ca-183-present", input, await financeTok());
    expect(r.status).toBe(201);
    expect(await creditStatus(present)).toBe("hold"); // the UPDATE landed
    expect(await anomalyRow(`credit-projection-gap:${input.id as string}`)).toBeNull(); // no gap on a hit
  });
});
