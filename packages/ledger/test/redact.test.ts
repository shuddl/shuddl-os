import { describe, expect, it } from "vitest";
import { eventFixture, type EventKind, type JsonObject, type LedgerEvent } from "@shuddl/contracts";
import { redactEvent, INTERNAL_NESTED } from "../src/redact.js";
import { KIND_VISIBILITY_DEFAULTS } from "../src/visibility.js";

// REQ-179 / I6 — NESTED counterparty redaction of invoice.issued / invoice.corrected. The portal is the
// FIRST counterparty surface to read these kinds; `division` (top-level) and every `lines[].gl_map`
// (nested inside an array) are MARGIN / chart-of-accounts internals that must NEVER reach a counterparty,
// while the sell/totals/line amounts legitimately stay (a party sees exactly what it owes). The strip is
// STRUCTURAL — it walks arrays + objects at any depth — so it fails closed on an unexpected shape.

describe("redactEvent: nested strip of invoice.issued internals (REQ-179)", () => {
  it("party/driver lens: NO division, NO lines[].gl_map — but amounts/totals remain", () => {
    const e = eventFixture("invoice.issued", { visibility: "counterparty" });
    // sanity: the STORED event carries the internals (else the assertion proves nothing).
    const stored = e.payload as Record<string, unknown>;
    expect(stored.division).toBe("main");
    expect((stored.lines as Array<Record<string, unknown>>)[0]!.gl_map).toBe("4000-REV");

    for (const lens of [{ scope: "party" as const }, { scope: "driver" as const }]) {
      const red = redactEvent(lens, e).payload as Record<string, unknown>;
      // internals gone at every depth
      expect(red.division).toBeUndefined();
      const lines = red.lines as Array<Record<string, unknown>>;
      expect(lines).toHaveLength(1);
      for (const l of lines) expect("gl_map" in l).toBe(false);
      // the sell/totals/line amounts a counterparty legitimately sees are KEPT
      expect(lines[0]!.amount_cents).toBe(120_000);
      expect(lines[0]!.line_no).toBe(1);
      expect(lines[0]!.kind).toBe("freight");
      expect(red.invoice_id).toBeDefined();
      expect(red.party_id).toBeDefined();
      // no trace of the gl_map VALUE anywhere in the projected payload
      expect(JSON.stringify(red)).not.toContain("4000-REV");
    }
    // redaction is a READ projection — the stored event is never mutated.
    expect((e.payload as Record<string, unknown>).division).toBe("main");
    expect(((e.payload as Record<string, unknown>).lines as Array<Record<string, unknown>>)[0]!.gl_map).toBe("4000-REV");
  });

  it("tenant (ops) lens sees the internals UNREDACTED (redaction is per-lens)", () => {
    const e = eventFixture("invoice.issued", { visibility: "counterparty" });
    const red = redactEvent({ scope: "tenant" }, e).payload as Record<string, unknown>;
    expect(red.division).toBe("main");
    expect((red.lines as Array<Record<string, unknown>>)[0]!.gl_map).toBe("4000-REV");
  });

  it("invoice.corrected: reissue_lines[].gl_map stripped for a party lens; reason/amounts kept", () => {
    const e = eventFixture("invoice.corrected", {
      visibility: "counterparty",
      payload: {
        invoice_id: "inv-1",
        corrects_event_id: "evt-orig",
        reason: "reweigh correction",
        reissue_lines: [{ line_no: 1, kind: "freight", amount_cents: 90_000, gl_map: "4000-REV" }],
      },
    });
    const red = redactEvent({ scope: "party" as const }, e).payload as Record<string, unknown>;
    const lines = red.reissue_lines as Array<Record<string, unknown>>;
    for (const l of lines) expect("gl_map" in l).toBe(false);
    expect(lines[0]!.amount_cents).toBe(90_000);
    expect(red.reason).toBe("reweigh correction"); // the correction reason is counterparty-visible
    expect(JSON.stringify(red)).not.toContain("4000-REV");
  });

  it("FAILS CLOSED: strips division/gl_map at ANY depth, even an off-contract nested shape", () => {
    // Hand-built envelope (bypasses the .strict() contract) with the internal keys buried two arrays
    // deep. redactEvent structurally walks the whole payload, so the buried keys are still removed —
    // strip MORE on an unexpected shape, never less.
    const raw = {
      id: "e1",
      stream_id: "s:1",
      shipment_id: "shp-1",
      seq: 0,
      ts: 1,
      recorded_at: 1,
      kind: "invoice.issued",
      actor: { party: "p1" },
      party_refs: ["p2"],
      evidence: [],
      prev_hash: "0".repeat(64),
      hash: "1".repeat(64),
      visibility: "counterparty",
      source: "native",
      confidence: 10_000,
      payload: {
        invoice_id: "inv-x",
        party_id: "p2",
        division: "top-level-div",
        lines: [{ line_no: 1, kind: "freight", amount_cents: 5, gl_map: "L1-GL" }],
        weird: [{ deep: [{ gl_map: "BURIED-GL", division: "BURIED-DIV" }] }],
      },
    } as unknown as LedgerEvent;

    const red = redactEvent({ scope: "party" as const }, raw).payload as Record<string, unknown>;
    const dumped = JSON.stringify(red);
    expect(dumped).not.toContain("gl_map");
    expect(dumped).not.toContain("division");
    expect(dumped).not.toContain("BURIED"); // buried two arrays deep — still stripped
    expect(dumped).not.toContain("L1-GL");
    // the line amount survives the walk
    expect((red.lines as Array<Record<string, unknown>>)[0]!.amount_cents).toBe(5);
  });

  it("INTERNAL_NESTED registers both invoice kinds with division + gl_map (completeness)", () => {
    expect(INTERNAL_NESTED["invoice.issued"]).toEqual(["division", "gl_map"]);
    expect(INTERNAL_NESTED["invoice.corrected"]).toEqual(["division", "gl_map"]);
  });
});

// REQ-192 (WP-09 exit audit) — the OTHER counterparty-default kinds carrying an internal field. The portal is
// the FIRST surface a counterparty reads booking.created / dispatch.assigned through, so their internal
// dimensions (the org/margin `division`, the internal `driver_user_id`) must be stripped for the party lens
// exactly as invoice.issued's are. The GENERAL guard is the anti-regression: no known-internal key may survive
// the party lens for ANY counterparty-default kind, so a future leak can never go live silently.
describe("redactEvent: booking.created + dispatch.assigned internals (REQ-192)", () => {
  it("booking.created — party/driver lens strips division; the tenant lens keeps it", () => {
    const e = eventFixture("booking.created", { visibility: "counterparty" });
    expect((e.payload as Record<string, unknown>).division).toBeDefined(); // stored carries the org dimension
    for (const scope of ["party", "driver"] as const) {
      const red = redactEvent({ scope }, e).payload as Record<string, unknown>;
      expect(red.division).toBeUndefined();
      expect(red.bill_to_party_id).toBeDefined(); // the party FKs a counterparty legitimately sees stay
    }
    expect((redactEvent({ scope: "tenant" }, e).payload as Record<string, unknown>).division).toBeDefined();
  });

  it("dispatch.assigned — party/driver lens strips driver_user_id (REQ-167); the tenant lens keeps it", () => {
    const e = eventFixture("dispatch.assigned", { visibility: "counterparty" });
    expect((e.payload as Record<string, unknown>).driver_user_id).toBeDefined();
    for (const scope of ["party", "driver"] as const) {
      expect((redactEvent({ scope }, e).payload as Record<string, unknown>).driver_user_id).toBeUndefined();
    }
    expect((redactEvent({ scope: "tenant" }, e).payload as Record<string, unknown>).driver_user_id).toBeDefined();
  });

  it("GENERAL fail-closed guard: NO known-internal key survives the party lens for ANY counterparty-default kind", () => {
    const KNOWN_INTERNAL = ["gl_map", "division", "driver_user_id", "cost", "buy_rate"];
    // Loose-JsonObject counterparty kinds (payment.received / settlement.executed) build a minimal `{}` payload,
    // so the guard would pass TRIVIALLY on them. Seed a known-internal `division` (the org/margin dimension their
    // money projection reads, money.ts:234/258) so the guard genuinely EXERCISES the strip on these kinds too.
    const INTERNAL_SEED: Partial<Record<EventKind, JsonObject>> = {
      "payment.received": { method: "ach", amount_cents: 120_000, division: "leak-canary" },
      "settlement.executed": { fee_cents: 2_500, division: "leak-canary" },
    };
    const hasKeyDeep = (node: unknown, key: string): boolean => {
      if (Array.isArray(node)) return node.some((n) => hasKeyDeep(n, key));
      if (node === null || typeof node !== "object") return false;
      const obj = node as Record<string, unknown>;
      return key in obj || Object.values(obj).some((v) => hasKeyDeep(v, key));
    };
    const counterpartyKinds = (Object.keys(KIND_VISIBILITY_DEFAULTS) as EventKind[]).filter(
      (k) => KIND_VISIBILITY_DEFAULTS[k] === "counterparty",
    );
    for (const kind of counterpartyKinds) {
      const seed = INTERNAL_SEED[kind];
      let e: LedgerEvent;
      try {
        e = eventFixture(kind, seed ? { visibility: "counterparty", payload: seed } : { visibility: "counterparty" });
      } catch {
        continue; // a kind eventFixture can't build with a bare visibility override — not this guard's target
      }
      // If we seeded an internal field, the STORED payload must actually carry it (else the guard is vacuous).
      if (seed !== undefined) expect(hasKeyDeep(e.payload, "division")).toBe(true);
      const red = redactEvent({ scope: "party" }, e).payload;
      for (const bad of KNOWN_INTERNAL) {
        if (hasKeyDeep(red, bad)) {
          throw new Error(`counterparty-default kind '${kind}' leaks internal key '${bad}' to the party lens — register it in INTERNAL_NESTED (REQ-192)`);
        }
      }
    }
  });
});

// REQ-210 / REQ-119 (WP-16 launch audit) — the FORWARD-GUARD for the two OTHER counterparty-default money kinds whose
// money projection reads payload.division (money.ts:234/258): payment.received and settlement.executed. Both are
// loose JsonObject payloads, so a real-tenant emitter that ever stamps `division` on one would leak the org/margin
// dimension to the PARTY lens unless division is registered in INTERNAL_NESTED. Not reachable today (the only
// payment.received emitter is _platform billing with no division; settlement.executed is CONFIRM-gated/dormant) —
// this closes it before it can go live.
describe("redactEvent: payment.received + settlement.executed division forward-guard (REQ-210)", () => {
  for (const kind of ["payment.received", "settlement.executed"] as const) {
    it(`${kind} — party/driver lens strips payload.division; the tenant lens keeps it`, () => {
      const e = eventFixture(kind, {
        visibility: "counterparty",
        payload: { method: "ach", amount_cents: 120_000, fee_cents: 2_500, division: "north" },
      });
      // sanity: the STORED event carries the internal dimension (else the assertion proves nothing).
      expect((e.payload as Record<string, unknown>).division).toBe("north");
      for (const scope of ["party", "driver"] as const) {
        const red = redactEvent({ scope }, e).payload as Record<string, unknown>;
        expect(red.division).toBeUndefined(); // the org/margin dimension never reaches a counterparty
        expect(red.amount_cents ?? red.fee_cents).toBeDefined(); // the money a party legitimately sees stays
        expect(JSON.stringify(red)).not.toContain("north");
      }
      // redaction is per-lens: the tenant (ops/finance) lens sees the unredacted dimension.
      expect((redactEvent({ scope: "tenant" }, e).payload as Record<string, unknown>).division).toBe("north");
      // and the stored event is never mutated (READ projection).
      expect((e.payload as Record<string, unknown>).division).toBe("north");
    });
  }

  it("INTERNAL_NESTED registers payment.received + settlement.executed with division (completeness)", () => {
    expect(INTERNAL_NESTED["payment.received"]).toEqual(["division"]);
    expect(INTERNAL_NESTED["settlement.executed"]).toEqual(["division"]);
  });
});

// REQ-074 (doc 07 §02, WP-16 verify) — the SERVER-SIDE geo-privacy boundary. The WP-03 threat-model flagged
// that `generalizePosition` was "client-consumed" and the "true boundary is server-side scoping (WP-02 lens)".
// It IS the lens boundary: redactEvent (server-side) coarsens PARTY geo to ~11 km + drops accuracy until
// out-for-delivery; DRIVER + TENANT keep exact geo (an ops/driver privilege). Proven here so no
// party-reachable read can leak an exact microdegree coordinate (a REQ-074 breach). The coarsening walk is
// STRUCTURAL (top-level lat_e6/lon_e6 AND nested `geo`), so a future geo-bearing kind cannot silently reopen it.
describe("redactEvent: party geo-privacy is generalized SERVER-SIDE (REQ-074)", () => {
  const RAW = { lat_e6: 39_712_345, lon_e6: -104_987_654, accuracy_m: 5 };
  const posEvent = (): LedgerEvent => ({ kind: "position.updated", payload: { ...RAW } }) as unknown as LedgerEvent;

  it("PARTY lens coarsens lat/lon to ~11 km + drops accuracy — the exact coordinate never reaches a consignee", () => {
    const red = redactEvent({ scope: "party" }, posEvent()).payload as Record<string, unknown>;
    expect(red.lat_e6).toBe(39_700_000); // 0.1-deg grid (100_000 microdeg ≈ 11 km)
    expect(red.lon_e6).toBe(-105_000_000);
    expect("accuracy_m" in red).toBe(false); // the precision signal is dropped with the coords
    expect(red.lat_e6).not.toBe(RAW.lat_e6); // the raw microdegree never survives the party lens
  });

  it("DRIVER + TENANT lenses keep EXACT geo (an ops/driver privilege)", () => {
    for (const scope of ["driver", "tenant"] as const) {
      const red = redactEvent({ scope }, posEvent()).payload as Record<string, unknown>;
      expect(red.lat_e6).toBe(RAW.lat_e6);
      expect(red.lon_e6).toBe(RAW.lon_e6);
    }
  });

  it("PARTY lens unlocks exact geo ONLY at out-for-delivery (the forwardable-cap boundary)", () => {
    const red = redactEvent({ scope: "party" }, posEvent(), true).payload as Record<string, unknown>;
    expect(red.lat_e6).toBe(RAW.lat_e6);
  });

  it("nested `geo` (pod.signed) is coarsened for a party lens — structural, not kind-enumerated", () => {
    const podEvent = { kind: "pod.signed", payload: { geo: { ...RAW } } } as unknown as LedgerEvent;
    const geo = (redactEvent({ scope: "party" }, podEvent).payload as Record<string, unknown>).geo as Record<string, unknown>;
    expect(geo.lat_e6).toBe(39_700_000);
    expect("accuracy_m" in geo).toBe(false);
  });
});
