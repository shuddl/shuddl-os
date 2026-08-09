import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.js";
import { assertPodSigned, GateError } from "../src/gates/invoice-gate.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";

const DB = env.TENANT_A_DB;

let hashSeq = 0;
async function insertEvent(streamId: string, seq: number, kind: string): Promise<void> {
  hashSeq += 1;
  await DB.prepare(
    `INSERT INTO events (stream_id, seq, id, shipment_id, ts, recorded_at, kind, actor_party_id, prev_hash, hash, visibility)
     VALUES (?, ?, ?, NULL, 1000, 1000, ?, 'p:acme', ?, ?, 'internal')`,
  )
    .bind(streamId, seq, `evt-${streamId}-${seq}-${kind}`, kind, "0".repeat(64), hashSeq.toString(16).padStart(64, "0"))
    .run();
}

beforeAll(async () => {
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
  ]);
});

describe("I2 / REQ-030 — assertPodSigned (invoice gate is server-side, every path hits it)", () => {
  it("invoice.issued before pod.signed -> GATE_BLOCKED carrying required_evidence ['pod.signed']", async () => {
    await insertEvent("s:shp-nopod", 0, "booking.created");
    await insertEvent("s:shp-nopod", 1, "custody.transferred");
    await expect(assertPodSigned(DB, "s:shp-nopod")).rejects.toBeInstanceOf(GateError);
    let caught: unknown;
    try {
      await assertPodSigned(DB, "s:shp-nopod");
    } catch (e) {
      caught = e;
    }
    const err = caught as GateError;
    expect(err.required_evidence).toEqual(["pod.signed"]);
    // The DO surfaces this over Workers RPC which preserves only name/message — the machine-
    // readable payload MUST live in the message: "GATE_BLOCKED:" + JSON.
    expect(err.message).toBe('GATE_BLOCKED:{"required_evidence":["pod.signed"]}');
    expect(err.name).toBe("GateError");
  });

  it("passes once a pod.signed exists on the SAME stream", async () => {
    await insertEvent("s:shp-podok", 0, "booking.created");
    await insertEvent("s:shp-podok", 1, "pod.signed");
    await expect(assertPodSigned(DB, "s:shp-podok")).resolves.toBeUndefined();
  });

  it("does not leak across streams — a pod on another stream does not satisfy the gate", async () => {
    await insertEvent("s:shp-other", 0, "pod.signed");
    await insertEvent("s:shp-mine", 0, "booking.created");
    await expect(assertPodSigned(DB, "s:shp-mine")).rejects.toBeInstanceOf(GateError);
  });

  it("tenant policy exception class passes without a pod (invoice_without_pod_classes)", async () => {
    await insertEvent("s:shp-blind", 0, "booking.created");
    const policy = { gates: { invoice_without_pod_classes: ["blind_ship", "will_call"] } };
    await expect(assertPodSigned(DB, "s:shp-blind", policy, "blind_ship")).resolves.toBeUndefined();
    // A class NOT on the exception list still blocks.
    await expect(assertPodSigned(DB, "s:shp-blind", policy, "standard")).rejects.toBeInstanceOf(GateError);
  });
});

// REQ-030 §739 — THE EXEMPTION DEFAULT, PINNED. `assertPodSigned` reads the waiver list as
// `policy?.gates?.invoice_without_pod_classes ?? []`, and the `?? []` IS the guarantee: absent policy means NO
// service class is exempt, so the POD gate applies to everyone. The behaviour was correct and
// MUTATION-MEASURED as unpinned — replacing the default with `[serviceClass]` (every caller exempt) left the
// whole ledger suite at 661/661 GREEN.
//
// That is the worst direction for this particular default to fail in: I2 / REQ-030 says the invoice gate is
// server-side and EVERY path hits it, and a silently-permissive waiver list would mint invoices with no proof
// of delivery — the exact thing `no price on air` and the POD gate exist to prevent.
describe("REQ-030 §739: an absent exemption policy exempts NOBODY", () => {
  it("a serviceClass with NO policy still hits the gate", async () => {
    await insertEvent("s:shp-noplcy", 0, "booking.created");
    // The mutation this pins made the default `[serviceClass]`, which would return early right here.
    await expect(assertPodSigned(DB, "s:shp-noplcy", undefined, "LTL")).rejects.toBeInstanceOf(GateError);
  });

  it("a policy with NO invoice_without_pod_classes list still hits the gate", async () => {
    await insertEvent("s:shp-emptyplcy", 0, "booking.created");
    await expect(assertPodSigned(DB, "s:shp-emptyplcy", { gates: {} }, "LTL")).rejects.toBeInstanceOf(GateError);
  });

  it("and the exemption DOES work when actually configured (non-vacuity)", async () => {
    // Without this, a gate that threw unconditionally would satisfy both assertions above. This proves the two
    // are failing because the list is EMPTY, not because the exemption path is broken or unreachable.
    await insertEvent("s:shp-exempt", 0, "booking.created");
    await expect(
      assertPodSigned(DB, "s:shp-exempt", { gates: { invoice_without_pod_classes: ["LTL"] } }, "LTL"),
    ).resolves.toBeUndefined();
  });
});

