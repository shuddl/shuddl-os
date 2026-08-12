import { describe, expect, it } from "vitest";
import { AuthorityFlippedPayload, AuthorityLevel, AuthorityModule, LedgerEvent, EventInput, eventFixture } from "../src/index.js";

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
    // DERIVED from the enum, never re-listed (§583). §562 made this exact change in the LEDGER's sibling
    // test and did not sweep for others — a sixth AuthorityModule would silently fall outside a case whose
    // name says "every module".
    for (const module of AuthorityModule.options) {
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

  // §1180 (REQ-008/023/030) — THE AUTHORITY LEVEL'S COMPLETENESS, in the shape lens.test.ts uses for Role.
  //
  // The test above is NEGATIVE: it proves "hybrid" is rejected TODAY. It says nothing about a level that is
  // legitimately ADDED to the enum later — which is the case that matters, because every consumer in the build
  // is a two-way ternary keyed on ONE value:
  //
  //   packages/ledger/src/authority.ts:43   row.authority === "native" ? "native" : "legacy"
  //   packages/ledger/src/authority.ts:64   if (authority === "native") return "native";
  //   workers/api/src/routes/authority.ts   if (to === "native") { … }
  //
  // So a third level collapses into the `legacy` branch. That direction is FAIL-CLOSED — it never grants
  // SHUDDL's native computation authority it was not given — but it is silently WRONG: a genuinely distinct
  // level would be executed as "the incumbent's system is authoritative" with nothing saying so.
  //
  // §1180 swept every enum for this shape. `Role`, `Visibility`, `AuthorityModule` and `MessageChannel` all
  // carry a classification guard; `AuthorityLevel` was the one money-gating enum without one. This is that
  // guard, not a new rule — the adjacent case the existing discipline had not reached.
  /** Levels meaning SHUDDL's native computation is authoritative. */
  const NATIVE_AUTHORITY = ["native"] as const;
  /** Levels meaning the incumbent system is authoritative (resolveAuthority's fail-closed default). */
  const INCUMBENT_AUTHORITY = ["legacy"] as const;

  it("§1180: the declared AuthorityLevel union is exactly what is classified — a new level reds HERE", () => {
    expect(
      [...AuthorityLevel.options].sort(),
      "an AuthorityLevel was added or removed. Classify it: NATIVE_AUTHORITY means SHUDDL's own computation " +
        "governs; INCUMBENT_AUTHORITY means the legacy system does. Doing nothing is not neutral — every " +
        "consumer is a `=== \"native\"` ternary, so an unclassified level silently executes as the incumbent's.",
    ).toEqual([...NATIVE_AUTHORITY, ...INCUMBENT_AUTHORITY].sort());
  });

  it("§1180: every declared level round-trips through the flip payload (derived, never re-listed)", () => {
    for (const from of AuthorityLevel.options) {
      for (const to of AuthorityLevel.options) {
        const p = AuthorityFlippedPayload.parse({ module: "rating", from, to, reason: "manual" });
        expect(p.from).toBe(from);
        expect(p.to).toBe(to);
      }
    }
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
