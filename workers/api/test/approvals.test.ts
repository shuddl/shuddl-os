import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { ensureSchema, seedRateConfig, token, TEST_RATE_CONFIG } from "./helpers.js";

// WP-10 Task 2 (REQ-082/194) — the approvals QUEUE: a durable read-model the sequencer projects from
// approval.requested/approval.decided, a decision route that enforces the matrix required_role SERVER-SIDE
// (ops satisfies "ops", finance satisfies "finance", admin satisfies any), and a lens-scoped read for the
// command queue. approval.requested is seeded through the REAL rate route (below-floor), so the projection
// is proven on the exact event the producer emits. Scopes to its OWN shipment ids; never assumes an empty
// table (isolatedStorage off — files share one D1).

const DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };
const PRICEABLE = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: DIMS };

beforeAll(async () => {
  await ensureSchema(env);
  await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
});

type RateResp = {
  status: string;
  floors?: { contribution: number; full: number; target: number };
  approval?: { approval: string; approvals_required: number; required_role: string | null };
};

async function rate(body: Record<string, unknown>, role = "ops"): Promise<RateResp> {
  const t = await token({ sub: "u-rate", tenant: "tenant-a", role });
  const res = await SELF.fetch("https://api.local/v1/rate", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID(), Authorization: `Bearer ${t}` },
    body: JSON.stringify(body),
  });
  return (await res.json()) as RateResp;
}

// Seed an OPEN approval on a fresh shipment via the real below-floor rate path. proposed_sell_cents at
// contribution ⇒ single (ops); at 1 ⇒ dual (finance). Returns the required_role the matrix assigned.
async function seedApproval(shipmentId: string, kind: "single" | "dual"): Promise<string> {
  const base = await rate({ shipment_id: `${shipmentId}-floors`, ...PRICEABLE });
  const floors = base.floors;
  if (!floors) throw new Error("baseline did not price");
  const proposed = kind === "single" ? floors.contribution : 1;
  const r = await rate({ shipment_id: shipmentId, ...PRICEABLE, proposed_sell_cents: proposed });
  expect(r.approval?.approval).toBe(kind);
  return r.approval?.required_role ?? "";
}

async function listApprovals(status: string, role = "ops"): Promise<{ status: number; approvals: Record<string, unknown>[] }> {
  const t = await token({ sub: "u-list", tenant: "tenant-a", role });
  const res = await SELF.fetch(`https://api.local/v1/approvals?status=${status}`, { headers: { Authorization: `Bearer ${t}` } });
  const json = (await res.json().catch(() => ({ approvals: [] }))) as { approvals?: Record<string, unknown>[] };
  return { status: res.status, approvals: json.approvals ?? [] };
}

async function decide(shipmentId: string, decision: "approved" | "denied", role: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const t = await token({ sub: `u-${role}`, tenant: "tenant-a", role });
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/approval-decision`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID(), Authorization: `Bearer ${t}` },
    body: JSON.stringify({ decision }),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

async function streamKinds(shipmentId: string): Promise<string[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return (res.results as Record<string, string | number | null>[]).map((r) => (rowToEvent(r) as LedgerEvent).kind);
}

async function approvalRow(shipmentId: string): Promise<Record<string, unknown> | null> {
  return env.TENANT_A_DB.prepare("SELECT * FROM approvals WHERE object_id = ? LIMIT 1").bind(shipmentId).first();
}

describe("approvals projection (REQ-082)", () => {
  it("approval.requested projects an OPEN approvals row that GET /v1/approvals?status=open lists", async () => {
    const shp = "appr-open-1";
    const requiredRole = await seedApproval(shp, "single");
    expect(requiredRole).toBe("ops");

    const row = await approvalRow(shp);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("open");
    expect(row?.object_id).toBe(shp);
    expect(row?.required_role).toBe("ops");
    expect(row?.rule).toBe("below_target_or");
    expect(typeof row?.requested_event_id).toBe("string");
    expect(row?.decided_event_id).toBeNull();

    const listed = await listApprovals("open");
    expect(listed.status).toBe(200);
    expect(listed.approvals.some((a) => a.object_id === shp && a.status === "open")).toBe(true);
  });
});

describe("approval decision route (REQ-194) — server-side required_role", () => {
  it("FINANCE decides a dual (finance-required) approval → 201, row flips to decided, approval.decided on the stream", async () => {
    const shp = "appr-dual-fin";
    const requiredRole = await seedApproval(shp, "dual");
    expect(requiredRole).toBe("finance");

    const res = await decide(shp, "approved", "finance");
    expect(res.status).toBe(201);
    expect(res.json?.kind).toBe("approval.decided");

    expect(await streamKinds(shp)).toContain("approval.decided");
    const row = await approvalRow(shp);
    expect(row?.status).toBe("decided");
    expect(typeof row?.decided_event_id).toBe("string");

    // no longer in the open queue; present in the decided list
    const open = await listApprovals("open");
    expect(open.approvals.some((a) => a.object_id === shp)).toBe(false);
    const decided = await listApprovals("decided");
    expect(decided.approvals.some((a) => a.object_id === shp && a.status === "decided")).toBe(true);
  });

  it("an OPS caller on a finance-required (dual) approval → 403, NOTHING appended", async () => {
    const shp = "appr-dual-ops-403";
    await seedApproval(shp, "dual");

    const before = await streamKinds(shp);
    const res = await decide(shp, "approved", "ops");
    expect(res.status).toBe(403);
    expect(await streamKinds(shp)).toEqual(before); // no approval.decided appended
    expect((await approvalRow(shp))?.status).toBe("open"); // still open
  });

  it("OPS decides an ops-required (single) approval → 201 (ops satisfies ops)", async () => {
    const shp = "appr-single-ops";
    const requiredRole = await seedApproval(shp, "single");
    expect(requiredRole).toBe("ops");
    const res = await decide(shp, "approved", "ops");
    expect(res.status).toBe(201);
    expect((await approvalRow(shp))?.status).toBe("decided");
  });

  it("ADMIN decides a finance-required approval → 201 (admin satisfies any)", async () => {
    const shp = "appr-dual-admin";
    await seedApproval(shp, "dual");
    const res = await decide(shp, "denied", "admin");
    expect(res.status).toBe(201);
    expect((await approvalRow(shp))?.status).toBe("decided");
  });

  it("re-deciding an already-decided approval is idempotent (already-decided, no duplicate approval.decided)", async () => {
    const shp = "appr-idem";
    await seedApproval(shp, "single");
    const first = await decide(shp, "approved", "ops");
    expect(first.status).toBe(201);
    const afterFirst = await streamKinds(shp);

    const second = await decide(shp, "denied", "ops");
    expect(second.status).toBe(200);
    expect(second.json?.status).toBe("already_decided");
    // exactly one approval.decided on the stream — no duplicate
    expect(await streamKinds(shp)).toEqual(afterFirst);
    expect((await streamKinds(shp)).filter((k) => k === "approval.decided")).toHaveLength(1);
  });

  it("approval.decided is REFUSED on the general events route (blessed-path only)", async () => {
    const shp = "appr-general-refuse";
    const t = await token({ sub: "u-ops", tenant: "tenant-a", role: "ops" });
    const res = await SELF.fetch(`https://api.local/v1/shipments/${shp}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID(), Authorization: `Bearer ${t}` },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        shipment_id: shp,
        ts: Date.now(),
        actor: { party: "party-shipper" },
        party_refs: [],
        evidence: [],
        source: "native",
        confidence: 10000,
        kind: "approval.decided",
        payload: { requested_event_id: "x", decision: "approved", decider: "attacker" },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("a decision on a shipment with no open approval → 404", async () => {
    const res = await decide("appr-nonexistent", "approved", "ops");
    expect(res.status).toBe(404);
  });
});
