import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, ensureTenantBSchema, token, TENANT_SLUG } from "./helpers.js";
import { eventFixture, type EventKind, type LedgerEvent } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { computeModuleParity } from "@shuddl/ledger/parity";
import { resolveAuthority } from "@shuddl/ledger/authority";

// WP-15 Task 3 (REQ-023/030, Ten Laws L8) — the Gatekeeper FLIP GUARD. A per-module authority flip is a
// SERVER-SIDE Gatekeeper decision, never a UI toggle: POST /v1/authority/:module/flip evaluates the gate
// FRESH and either promotes a module to native (FORWARD, blocked until parity is proven green) or falls back
// to legacy (BACKWARD, always allowed), recording the decision as a co-signed, append-only authority.flipped
// event on the tenant-level t:root stream. authority_map changes ONLY via that projected event — never a
// direct write from the route.
//
// The api test D1 is SHARED across files (isolatedStorage off, singleWorker sequential), so parity for a
// module reflects other suites' native events. The green-setup helper below is robust to that: it seeds a
// native event, READS the current native aggregate, and matches the legacy side to it (drift 0 ⇒ within_gate)
// — never assuming an empty table.

let hashN = 0xb22000;
const nextHash = (): string => (hashN++).toString(16).padStart(64, "0");
let uidN = 0;
const uid = (p: string): string => `${p}-${Date.now()}-${uidN++}`;

async function seedEvent(
  db: D1Database,
  kind: EventKind,
  o: { shipmentId: string; seq: number; source: LedgerEvent["source"]; payload?: Record<string, unknown> },
): Promise<void> {
  const overrides: Record<string, unknown> = {
    id: crypto.randomUUID(),
    stream_id: `s:${o.shipmentId}`,
    shipment_id: o.shipmentId,
    seq: o.seq,
    source: o.source,
    visibility: "internal",
    party_refs: [],
  };
  if (o.payload !== undefined) overrides.payload = o.payload;
  const e = eventFixture(kind, overrides);
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await db
    .prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

// The per-module payload whose metric aggregates to `v` (rating: sum of quote.priced sell; invoicing: Σ
// invoice line amount_cents). UNITs are large so the native seed dominates any legacy pollution ⇒ the
// legacy-deficit below is always positive.
const RATING_UNIT = 5_000_000;
const SETTLEMENT_UNIT = 500_000_000;
// A valid QuotePricedPayload whose sell (and single line, Σ === sell per the penny-parity refine) is `v`.
const ratingPayload = (v: number): Record<string, unknown> => ({
  sell: v,
  lines: [{ kind: "freight", code: "freight", amount_cents: v }],
  floors: { contribution: 0, full: 0, target: 0 },
  versions: { rate_config_ids: ["rc-test"] },
  basis: {},
});
// settlement.executed has a LOOSE JsonObject payload; the settlement metric reads total_cents/fee_cents. Used for
// the MONEY-module gate test (settlement is a money module) — and NOT invoicing, whose tenant-a legacy side the
// isolation + parity suites pin, so this suite never seeds an invoicing legacy mirror into the shared D1.
const settlementPayload = (v: number): Record<string, unknown> => ({ fee_cents: v });

// Make a module's parity GREEN (both sides present + drift 0) robustly against the shared D1: seed one native
// event, read the CURRENT native aggregate, then seed a legacy event equal to the native−legacy deficit so the
// two totals match exactly (drift 0 ⇒ within_gate true). Re-callable — it always re-matches the live native.
async function forceParityGreen(
  db: D1Database,
  module: "rating" | "settlement",
  kind: EventKind,
  mkPayload: (v: number) => Record<string, unknown>,
  unit: number,
): Promise<void> {
  await seedEvent(db, kind, { shipmentId: uid("nat"), seq: 0, source: "native", payload: mkPayload(unit) });
  const p1 = await computeModuleParity(db, module);
  const nativeAgg = p1.native_value as number;
  const legacyNow = p1.legacy_value === "UNKNOWN" ? 0 : (p1.legacy_value as number);
  const deficit = nativeAgg - legacyNow;
  if (deficit > 0) {
    await seedEvent(db, kind, { shipmentId: uid("leg"), seq: 0, source: "legacy", payload: mkPayload(deficit) });
  }
  const p = await computeModuleParity(db, module);
  expect(p.within_gate).toBe(true); // the setup actually produced a green module
}

async function flippedCount(db: D1Database, module: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = 't:root' AND kind = 'authority.flipped' AND json_extract(payload,'$.module') = ?")
    .bind(module)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

type FlipRes = { status: number; json: Record<string, unknown> | null };
async function flip(module: string, body: unknown, tok: string, query = ""): Promise<FlipRes> {
  const res = await SELF.fetch(`https://api.local/v1/authority/${module}/flip${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const payloadOf = (r: FlipRes): Record<string, unknown> => (r.json?.payload as Record<string, unknown>) ?? {};

// The shared api D1 (isolatedStorage off) is written by other suites — including files that flip authority for
// rating/dispatch/comms (sequencer.test, lens-adversarial.test) and run in a NON-deterministic order relative to
// this one. So a test may NOT assume a module's starting authority. setLegacy forces it to legacy first (a
// BACKWARD flip is always allowed and is idempotent to legacy), giving every forward/no-op case a known baseline.
async function setLegacy(module: string, tok: string): Promise<void> {
  await flip(module, { to: "legacy" }, tok);
}

beforeAll(async () => {
  await ensureSchema(env);
  await ensureTenantBSchema(env);
});

describe("POST /v1/authority/:module/flip — the Gatekeeper flip guard (REQ-023/030, L8)", () => {
  it("FORWARD flip with parity NOT green (no legacy mirror ⇒ UNKNOWN) → 403 GATE_BLOCKED, NO event appended, map unchanged", async () => {
    const admin = await token({ sub: "flip-admin-blocked", tenant: TENANT_SLUG, role: "admin" });
    await setLegacy("dispatch", admin); // known baseline (other suites may have promoted it)
    // dispatch has no legacy mirror anywhere in the shared D1 ⇒ parity UNKNOWN ⇒ within_gate false.
    const p = await computeModuleParity(env.TENANT_A_DB, "dispatch");
    expect(p.within_gate).toBe(false); // precondition: not green (fail-closed)
    const before = await flippedCount(env.TENANT_A_DB, "dispatch");

    const r = await flip("dispatch", { to: "native" }, admin);

    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("GATE_BLOCKED");
    expect(await flippedCount(env.TENANT_A_DB, "dispatch")).toBe(before); // NOTHING partial was appended
    expect(await resolveAuthority(env.TENANT_A_DB, "dispatch")).toBe("legacy"); // authority_map untouched
  });

  it("FORWARD flip with parity GREEN (non-money rating) → 201 authority.flipped{to:native,reason:promote} on t:root + map native", async () => {
    const admin = await token({ sub: "flip-admin-promote", tenant: TENANT_SLUG, role: "admin" });
    await setLegacy("rating", admin); // known baseline for a real legacy→native transition
    await forceParityGreen(env.TENANT_A_DB, "rating", "quote.priced", ratingPayload, RATING_UNIT);
    expect(await resolveAuthority(env.TENANT_A_DB, "rating")).toBe("legacy"); // starts legacy
    const before = await flippedCount(env.TENANT_A_DB, "rating");

    const r = await flip("rating", { to: "native" }, admin);

    expect(r.status).toBe(201);
    expect(r.json?.stream_id).toBe("t:root");
    expect(r.json?.shipment_id).toBeUndefined(); // t:root carries no shipment_id
    expect(r.json?.source).toBe("native");
    expect(payloadOf(r).module).toBe("rating");
    expect(payloadOf(r).from).toBe("legacy");
    expect(payloadOf(r).to).toBe("native");
    expect(payloadOf(r).reason).toBe("promote");
    // the FRESH gate evaluation is snapshotted as the audit record of WHY the flip was allowed.
    const snap = payloadOf(r).gate_snapshot as Record<string, unknown>;
    expect(snap).toBeDefined();
    expect(snap.parity_within_gate).toBe(true);
    expect(typeof snap.drift_bps).toBe("number");
    expect(await flippedCount(env.TENANT_A_DB, "rating")).toBe(before + 1); // exactly one appended
    expect(await resolveAuthority(env.TENANT_A_DB, "rating")).toBe("native"); // map flipped via the projection
  });

  it("MONEY module (settlement) FORWARD flip, parity green but <2 clean closes → BLOCKED (money gate; closes unrepresentable in-repo)", async () => {
    const admin = await token({ sub: "flip-admin-money", tenant: TENANT_SLUG, role: "admin" });
    await setLegacy("settlement", admin); // baseline: a native settlement would make to:native a no-op, not a block
    await forceParityGreen(env.TENANT_A_DB, "settlement", "settlement.executed", settlementPayload, SETTLEMENT_UNIT);
    const p = await computeModuleParity(env.TENANT_A_DB, "settlement");
    expect(p.within_gate).toBe(true); // parity IS green
    const before = await flippedCount(env.TENANT_A_DB, "settlement");

    const r = await flip("settlement", { to: "native" }, admin);

    expect(r.status).toBe(403); // blocked by the clean-closes gate despite green parity
    expect(r.json?.code).toBe("GATE_BLOCKED");
    expect((r.json?.gate as { required_evidence?: string[] })?.required_evidence).toContain("clean_closes>=2");
    expect(await flippedCount(env.TENANT_A_DB, "settlement")).toBe(before); // nothing appended
    expect(await resolveAuthority(env.TENANT_A_DB, "settlement")).toBe("legacy"); // still legacy — money authority unearned
  });

  it("BACKWARD flip (native→legacy) is ALWAYS allowed — even with parity RED → 201 authority.flipped{to:legacy,reason:manual} + map legacy", async () => {
    const admin = await token({ sub: "flip-admin-fallback", tenant: TENANT_SLUG, role: "admin" });
    // ensure rating is native (green + forward flip if not already), then BREAK parity so it is red.
    await forceParityGreen(env.TENANT_A_DB, "rating", "quote.priced", ratingPayload, RATING_UNIT);
    if ((await resolveAuthority(env.TENANT_A_DB, "rating")) !== "native") {
      const up = await flip("rating", { to: "native" }, admin);
      expect(up.status).toBe(201);
    }
    // break parity: a huge native quote skews drift far past tolerance ⇒ within_gate false (red).
    await seedEvent(env.TENANT_A_DB, "quote.priced", { shipmentId: uid("break"), seq: 0, source: "native", payload: ratingPayload(999_000_000) });
    expect((await computeModuleParity(env.TENANT_A_DB, "rating")).within_gate).toBe(false);
    const before = await flippedCount(env.TENANT_A_DB, "rating");

    const r = await flip("rating", { to: "legacy" }, admin); // fallback — no gate consulted

    expect(r.status).toBe(201);
    expect(payloadOf(r).to).toBe("legacy");
    expect(payloadOf(r).reason).toBe("manual");
    expect(payloadOf(r).gate_snapshot).toBeUndefined(); // fallback records no gate snapshot
    expect(await flippedCount(env.TENANT_A_DB, "rating")).toBe(before + 1);
    expect(await resolveAuthority(env.TENANT_A_DB, "rating")).toBe("legacy");
  });

  it("IDEMPOTENT: to === from (already legacy) → 200 no-op, NO event", async () => {
    const admin = await token({ sub: "flip-admin-noop", tenant: TENANT_SLUG, role: "admin" });
    await setLegacy("dispatch", admin); // ensure from === 'legacy' so to:'legacy' is a genuine no-op
    expect(await resolveAuthority(env.TENANT_A_DB, "dispatch")).toBe("legacy");
    const before = await flippedCount(env.TENANT_A_DB, "dispatch");

    const r = await flip("dispatch", { to: "legacy" }, admin);

    expect(r.status).toBe(200);
    expect(await flippedCount(env.TENANT_A_DB, "dispatch")).toBe(before); // no event on a no-op
    expect(await resolveAuthority(env.TENANT_A_DB, "dispatch")).toBe("legacy");
  });

  it("CO-SIGNED + append-only: the event records the deciding admin, and authority_map changes ONLY via the projected event", async () => {
    const admin = await token({ sub: "flip-admin-cosign", tenant: TENANT_SLUG, role: "admin" });
    await setLegacy("rating", admin); // baseline ⇒ the forward flip below is guaranteed a real 201 promote
    await forceParityGreen(env.TENANT_A_DB, "rating", "quote.priced", ratingPayload, RATING_UNIT);
    const r = await flip("rating", { to: "native" }, admin);
    expect(r.status).toBe(201);
    const actor = r.json?.actor as { party: string; user?: string };
    expect(actor.user).toBe("flip-admin-cosign"); // the co-sign: WHO flipped it, recorded permanently
    const eventId = r.json?.id as string;
    // authority_map reflects the event AND links it in flipped_events (the projection is its only writer).
    const row = await env.TENANT_A_DB.prepare("SELECT authority, flipped_events FROM authority_map WHERE module = 'rating'").first<{
      authority: string;
      flipped_events: string;
    }>();
    expect(row?.authority).toBe("native");
    expect(JSON.parse(row?.flipped_events ?? "[]")).toContain(eventId);
  });

  it("ROLE: a non-admin (ops) → 403", async () => {
    const ops = await token({ sub: "flip-ops", tenant: TENANT_SLUG, role: "ops" });
    const r = await flip("rating", { to: "legacy" }, ops);
    expect(r.status).toBe(403);
  });

  it("VALIDATION: an unknown :module → 400", async () => {
    const admin = await token({ sub: "flip-admin-badmod", tenant: TENANT_SLUG, role: "admin" });
    const r = await flip("teleport", { to: "native" }, admin);
    expect(r.status).toBe(400);
  });

  it("TENANT ISOLATION: a ?tenant=tenant-b is ignored — the flip binds the JWT tenant (tenant-a); tenant-b's ledger is untouched", async () => {
    const admin = await token({ sub: "flip-admin-iso", tenant: TENANT_SLUG, role: "admin" });
    await forceParityGreen(env.TENANT_A_DB, "rating", "quote.priced", ratingPayload, RATING_UNIT);
    // a cross-tenant query param must NOT redirect the append into tenant-b.
    await flip("rating", { to: "native" }, admin, "?tenant=tenant-b");
    // tenant-b never received ANY authority flip (this suite is the only authority-flip writer in the harness).
    const bCount = await env.TENANT_B_DB
      .prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = 't:root' AND kind = 'authority.flipped'")
      .first<{ n: number }>();
    expect(bCount?.n ?? 0).toBe(0);
    expect(await resolveAuthority(env.TENANT_B_DB, "rating")).toBe("legacy"); // tenant-b map untouched
  });
});
