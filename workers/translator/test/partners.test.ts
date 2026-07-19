import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { dialectStatus } from "@shuddl/edi";
import { allocatePartnerControls, certifyPartner, PartnerControlError, partnerMapping } from "../src/partners.js";
import { applyAll, seedEdiPartner } from "./helpers.js";

// WP-12 Task 9 · REQ-203 / REQ-204 — PARTNER CERTIFICATION + OUTBOUND INTERCHANGE CONTROL-NUMBER STATE.
//   · certifyPartner validates the partner's stored mapping (a malformed mapping must NOT be certified — it
//     would fault every 214 the sweep builds) and marks cert_status='certified' + records the replay fixture ref.
//   · allocatePartnerControls issues SHUDDL's OWN monotonically-increasing outbound ISA13/GS06 per partner,
//     persisted in integrations.config under the reserved `outbound` key (SEPARATE from the partner mapping so
//     resolveMapping's strict() schema never sees it). A number is never issued twice (single atomic UPDATE).
// The `integrations` table is NOT append-only guarded (only events/positions/money_lines are), so the
// certify/allocate UPDATEs are legal. This suite drives the pure D1 functions directly (no worker wiring).

const FIXTURE = "fixtures/edi/roundtrip.json";

async function readConfig(id: string): Promise<Record<string, unknown>> {
  const row = await env.TENANT_A_DB.prepare("SELECT config FROM integrations WHERE kind='edi_partner' AND id=? LIMIT 1").bind(id).first<{ config: string }>();
  return JSON.parse(row!.config) as Record<string, unknown>;
}
async function readCert(id: string): Promise<{ cert_status: string | null; replay_fixture_ref: string | null }> {
  const row = await env.TENANT_A_DB
    .prepare("SELECT cert_status, replay_fixture_ref FROM integrations WHERE kind='edi_partner' AND id=? LIMIT 1")
    .bind(id)
    .first<{ cert_status: string | null; replay_fixture_ref: string | null }>();
  return row!;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
});

describe("REQ-203 — certifyPartner", () => {
  it("validates the mapping, marks cert_status='certified', and stores the replay fixture ref", async () => {
    const id = "partner-cert-ok";
    await seedEdiPartner(env.TENANT_A_DB, id, null, JSON.stringify({ statusDialect: { arrived: "AG" } }));
    await certifyPartner(env.TENANT_A_DB, id, FIXTURE);
    const cert = await readCert(id);
    expect(cert.cert_status).toBe("certified");
    expect(cert.replay_fixture_ref).toBe(FIXTURE);
  });

  it("is idempotent — re-certifying is a no-op-equivalent (still certified, same fixture)", async () => {
    const id = "partner-cert-idem";
    await seedEdiPartner(env.TENANT_A_DB, id, null, "{}");
    await certifyPartner(env.TENANT_A_DB, id, FIXTURE);
    await certifyPartner(env.TENANT_A_DB, id, FIXTURE);
    const cert = await readCert(id);
    expect(cert.cert_status).toBe("certified");
    expect(cert.replay_fixture_ref).toBe(FIXTURE);
  });

  it("can re-certify a partner that has ALREADY allocated numbers (the outbound counter is not a mapping field)", async () => {
    const id = "partner-cert-after-alloc";
    await seedEdiPartner(env.TENANT_A_DB, id, "certified", JSON.stringify({ statusDialect: { arrived: "AG" } }));
    await allocatePartnerControls(env.TENANT_A_DB, id); // config now carries `outbound`
    // certification must still pass — it strips the outbound key before validating the mapping.
    await expect(certifyPartner(env.TENANT_A_DB, id, FIXTURE)).resolves.toBeUndefined();
    expect((await readCert(id)).cert_status).toBe("certified");
  });

  it("REJECTS a malformed mapping — an unusable config cannot be certified (throws; partner stays uncertified)", async () => {
    const id = "partner-cert-bad";
    // `bogus` is an unknown top-level field → resolveMapping's strict() schema rejects it.
    await seedEdiPartner(env.TENANT_A_DB, id, null, JSON.stringify({ bogus: true }));
    await expect(certifyPartner(env.TENANT_A_DB, id, FIXTURE)).rejects.toThrow();
    expect((await readCert(id)).cert_status, "a rejected certification leaves the partner uncertified").not.toBe("certified");
  });

  it("throws PartnerControlError on an unknown partner id (no integrations row)", async () => {
    await expect(certifyPartner(env.TENANT_A_DB, "partner-ghost", FIXTURE)).rejects.toBeInstanceOf(PartnerControlError);
  });
});

describe("REQ-203/204 — allocatePartnerControls (outbound interchange numbers)", () => {
  it("returns a 9-digit zero-padded ISA13 that increases MONOTONICALLY and PERSISTS across a fresh read", async () => {
    const id = "partner-alloc-mono";
    await seedEdiPartner(env.TENANT_A_DB, id, "certified", "{}"); // no seeded counter → starts at 0
    expect(await allocatePartnerControls(env.TENANT_A_DB, id)).toEqual({ isaControl: "000000001", gsControl: "1" });
    expect(await allocatePartnerControls(env.TENANT_A_DB, id)).toEqual({ isaControl: "000000002", gsControl: "2" });
    // persisted: a FRESH statement sees the advanced counter (the number lives in integrations.config).
    expect(await readConfig(id)).toMatchObject({ outbound: { isa: 2, gs: 2 } });
    expect((await allocatePartnerControls(env.TENANT_A_DB, id)).isaControl).toBe("000000003");
  });

  it("is DETERMINISTIC given a seeded counter (tests can seed integrations.config)", async () => {
    const id = "partner-alloc-seed";
    await seedEdiPartner(env.TENANT_A_DB, id, "certified", JSON.stringify({ outbound: { isa: 41, gs: 41 } }));
    expect(await allocatePartnerControls(env.TENANT_A_DB, id)).toEqual({ isaControl: "000000042", gsControl: "42" });
  });

  it("PRESERVES the partner's mapping config while advancing the counter (no clobber of statusDialect)", async () => {
    const id = "partner-alloc-map";
    await seedEdiPartner(env.TENANT_A_DB, id, "certified", JSON.stringify({ statusDialect: { arrived: "AG" } }));
    await allocatePartnerControls(env.TENANT_A_DB, id);
    const cfg = await readConfig(id);
    expect(cfg).toMatchObject({ statusDialect: { arrived: "AG" }, outbound: { isa: 1, gs: 1 } });
    // partnerMapping still resolves the custom dialect (it strips the outbound counter before resolveMapping).
    expect(dialectStatus("arrived", partnerMapping(JSON.stringify(cfg)))).toBe("AG");
  });

  it("throws PartnerControlError on an unknown partner id (no row to increment)", async () => {
    await expect(allocatePartnerControls(env.TENANT_A_DB, "partner-ghost-2")).rejects.toBeInstanceOf(PartnerControlError);
  });
});

describe("partnerMapping — resolves the stored mapping, IGNORING the outbound counter", () => {
  it("falls back to DEFAULT_004010 for an empty config AND for a config carrying only the outbound counter", () => {
    expect(dialectStatus("arrived", partnerMapping("{}"))).toBe("X3"); // DEFAULT_004010.statusDialect.arrived
    expect(dialectStatus("arrived", partnerMapping(JSON.stringify({ outbound: { isa: 9, gs: 9 } })))).toBe("X3");
  });

  it("resolves a partner override that COEXISTS with an outbound counter", () => {
    expect(dialectStatus("arrived", partnerMapping(JSON.stringify({ statusDialect: { arrived: "AG" }, outbound: { isa: 3, gs: 3 } })))).toBe("AG");
  });

  it("falls back to DEFAULT_004010 on a malformed stored config (never throws — the sweep must not fault)", () => {
    expect(dialectStatus("arrived", partnerMapping("not-json-at-all"))).toBe("X3");
    expect(dialectStatus("arrived", partnerMapping(JSON.stringify({ bogus: true })))).toBe("X3");
  });
});
