import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sweepTenantCreditGaps } from "../src/credit-recon-sweep.js";
import { CREDIT_PROJECTION_GAP_RULE } from "@shuddl/ledger/projection/status-cache";
import { applyAll, seedEvent } from "./helpers.js";

// REQ-042/183 §791 — THE CREDIT-GAP SWEEP, RUN AGAINST AN ACTUAL GAP.
//
// This sweep is the ONLY automatic mechanism that closes a `credit_projection_gap`. The gap is what makes the
// REQ-042 booking credit-hold BLOCK (assertBookingCredit's `creditGapUnresolved` throws while it is open), so
// if the sweep resolves nothing, every gapped booking stays blocked forever with no recovery — fail-closed,
// but permanently stuck freight.
//
// It had NEVER been run against a gap. `recon-sweep-cron.test.ts` says so in its own header — *"With no open
// credit_projection_gap anomalies…"* — and only asserted the wrapper iterates tenants and that `scheduled()`
// drives it. MEASURED (§791): binding the SELECT to a non-existent rule, and separately deleting the entire
// loop body, BOTH left `workers/agents` at 127/127 GREEN. Its SELECT, its loop and its counter were all
// unexercised — the `assertions: 0 over an empty corpus` shape (§731) arriving at a cron sweep.
//
// §777 pinned `reconcileCreditForParty` (the reconciler this calls). This pins the SWEEP: that it FINDS the
// gap, applies the decision, and does not close a gap it could not fix.
//
// STILL UNEXERCISED, stated rather than implied: the per-party `catch`. `reconcileCreditForParty`
// fail-closed-RETURNS instead of throwing, so no fixture of real rows can reach it — measured, by making the
// catch rethrow and watching these three stay green. Reaching it needs an injected db that throws, and this
// suite has no seam for one. The third test below pins the weaker true statement, and says so.

const PARTY = "party-791-gap";
const OTHER = "party-791-other";

async function seedParty(id: string): Promise<void> {
  await env.TENANT_A_DB.prepare("INSERT OR REPLACE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
    .bind(id, "broker", "{}", "[]")
    .run();
}

async function seedGap(anomalyId: string, partyId: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR REPLACE INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open')",
  )
    .bind(anomalyId, CREDIT_PROJECTION_GAP_RULE, "party", partyId, "critical", "{}")
    .run();
}

async function seedCreditDecision(shipmentId: string, partyId: string, status: string): Promise<void> {
  await seedEvent(env.TENANT_A_DB, "credit.checked", {
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq: 0,
    visibility: "internal",
    payload: { party_id: partyId, status },
  });
}

async function creditStatusOf(partyId: string): Promise<string | null> {
  const r = await env.TENANT_A_DB.prepare("SELECT credit_status FROM parties WHERE id = ?").bind(partyId).first<{ credit_status: string | null }>();
  return r?.credit_status ?? null;
}
async function anomalyStatusOf(id: string): Promise<string | null> {
  const r = await env.TENANT_A_DB.prepare("SELECT status FROM anomalies WHERE id = ?").bind(id).first<{ status: string }>();
  return r?.status ?? null;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
});

describe("REQ-042/183 §791 — the credit-gap sweep against a REAL gap", () => {
  it("FINDS an open gap and resolves it — the counter reflects work, not an empty scan", async () => {
    await seedParty(PARTY);
    await seedCreditDecision("shp-791-a", PARTY, "hold");
    await seedGap("credit-projection-gap:791-a", PARTY);

    const res = await sweepTenantCreditGaps(env.TENANT_A_DB);

    // scanned > 0 is the non-vacuity that the old cron test could never have: it proves the SELECT matched.
    expect(res.scanned, "the sweep's SELECT found no open gap — it would never close one in production").toBeGreaterThan(0);
    expect(res.resolved, "the sweep scanned a gap and reconciled nothing").toBeGreaterThan(0);
    // …and the two rows the REQ-042 gate actually reads.
    expect(await creditStatusOf(PARTY), "the decision was never applied to the party").toBe("hold");
    expect(await anomalyStatusOf("credit-projection-gap:791-a"), "the gap stayed open — the booking stays blocked forever").toBe("resolved");
  });

  it("a party whose gap CANNOT yet be reconciled is left open — the sweep never forces a resolve", async () => {
    // No party row and no decision: `reconcileCreditForParty` is a fail-closed no-op (§777). The sweep must
    // report it as scanned-but-unresolved rather than closing an anomaly it did not fix — an anomaly resolved
    // without a decision is the silent-defeat this whole mechanism exists to prevent.
    await seedGap("credit-projection-gap:791-b", "party-791-absent");

    const res = await sweepTenantCreditGaps(env.TENANT_A_DB);
    expect(res.scanned).toBeGreaterThan(0);
    expect(await anomalyStatusOf("credit-projection-gap:791-b"), "an unreconcilable gap was closed anyway").toBe("open");
  });

  it("an unreconcilable gap does not stop the sweep reaching a later, reconcilable one", async () => {
    // SCOPE, stated honestly: this exercises the LOOP's continuation, NOT the `catch`. `reconcileCreditForParty`
    // fail-closed-RETURNS for an absent party (§777) rather than throwing, so no fixture built from real rows
    // can reach the per-party catch — proving that would need an injected db that throws, which this suite has
    // no seam for. The comment in the source claims "a per-party fault is contained + logged"; what is pinned
    // here is the weaker, true statement: a party the sweep cannot help does not cost the ones it can.
    //
    // The bad gap sorts FIRST by id, so a sweep that abandoned the iteration would never reach the good one.
    await seedParty(OTHER);
    await seedCreditDecision("shp-791-c", OTHER, "clear");
    await seedGap("credit-projection-gap:791-aaa-bad", "party-791-nonexistent");
    await seedGap("credit-projection-gap:791-zzz-good", OTHER);

    const res = await sweepTenantCreditGaps(env.TENANT_A_DB);

    expect(res.scanned).toBeGreaterThanOrEqual(2);
    expect(await creditStatusOf(OTHER), "the reachable party was never reconciled — the sweep stopped early").toBe("clear");
    expect(await anomalyStatusOf("credit-projection-gap:791-zzz-good")).toBe("resolved");
    expect(await anomalyStatusOf("credit-projection-gap:791-aaa-bad"), "the unreconcilable gap must stay open").toBe("open");
  });
});
