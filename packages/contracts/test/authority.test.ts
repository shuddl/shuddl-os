import { describe, expect, it } from "vitest";
import { AuthorityFlippedPayload, LedgerEvent, EventInput, eventFixture } from "../src/index.js";

// ─── WP-15 Task 1 (REQ-008/023, Ten Laws L8) — authority.flipped carries a TYPED, self-describing payload:
// the module, the authority BEFORE (`from`) and AFTER (`to`) the flip, and WHY (reason). gate_snapshot and
// drift_ref are OPTIONAL and OMITTED-WHEN-ABSENT (the canonicalizer drops undefined keys → frozen-byte law).
// NO kind is added — authority.flipped is the frozen #35 (events.ts pins .length === 35). ───────────────────
describe("REQ-008/023: AuthorityFlippedPayload is a typed, self-describing flip record", () => {
  const valid = { module: "rating", from: "legacy", to: "native", reason: "promote" } as const;

  it("accepts a minimal valid promote flip (gate_snapshot + drift_ref OMITTED — they are optional)", () => {
    const p = AuthorityFlippedPayload.parse(valid);
    expect(p.module).toBe("rating");
    expect(p.to).toBe("native");
    // omitted-when-absent: the optional keys must NOT materialize as present keys
    expect("gate_snapshot" in p).toBe(false);
    expect("drift_ref" in p).toBe(false);
  });

  it("accepts a drift fallback carrying gate_snapshot + drift_ref", () => {
    const p = AuthorityFlippedPayload.parse({
      module: "invoicing",
      from: "native",
      to: "legacy",
      reason: "drift",
      gate_snapshot: { open_gates: 2, last_check_ts: 1_720_000_000_000 },
      drift_ref: "anom-x",
    });
    expect(p.reason).toBe("drift");
    expect(p.drift_ref).toBe("anom-x");
    expect(p.gate_snapshot).toEqual({ open_gates: 2, last_check_ts: 1_720_000_000_000 });
  });

  it("accepts a manual flip on every module + both authority levels", () => {
    for (const module of ["rating", "invoicing", "dispatch", "settlement", "comms"] as const) {
      expect(AuthorityFlippedPayload.parse({ module, from: "native", to: "legacy", reason: "manual" }).module).toBe(module);
    }
  });

  it("rejects a module outside the authority_map CHECK set", () => {
    expect(() => AuthorityFlippedPayload.parse({ ...valid, module: "billing" })).toThrow();
  });

  it("rejects a bad authority level on from/to", () => {
    expect(() => AuthorityFlippedPayload.parse({ ...valid, to: "hybrid" })).toThrow();
    expect(() => AuthorityFlippedPayload.parse({ ...valid, from: "unknown" })).toThrow();
  });

  it("rejects a bad reason enum value", () => {
    expect(() => AuthorityFlippedPayload.parse({ ...valid, reason: "auto" })).toThrow();
  });

  it("rejects an extra key (.strict)", () => {
    expect(() => AuthorityFlippedPayload.parse({ ...valid, who: "ops" })).toThrow();
  });

  it("rejects a float inside gate_snapshot (integer-only canonical law via JsonObject)", () => {
    expect(() => AuthorityFlippedPayload.parse({ ...valid, gate_snapshot: { drift: 0.5 } })).toThrow();
  });
});

describe("REQ-008/023: authority.flipped is wired into both event unions (kind narrows payload)", () => {
  it("LedgerEvent.parse accepts a valid authority.flipped and REJECTS an empty {} payload (now typed, not JsonObject)", () => {
    const e = eventFixture("authority.flipped");
    expect(LedgerEvent.parse(e).kind).toBe("authority.flipped");
    expect(() => LedgerEvent.parse({ ...e, payload: {} })).toThrow();
  });

  it("EventInput.parse accepts a client-suppliable authority.flipped with the typed payload", () => {
    const parsed = EventInput.parse({
      id: "00000000-0000-4000-8000-0000000000f1",
      ts: 1_720_000_000_000,
      actor: { party: "party-ops" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "authority.flipped",
      payload: { module: "dispatch", from: "legacy", to: "native", reason: "promote" },
    });
    expect(parsed.kind).toBe("authority.flipped");
  });
});
