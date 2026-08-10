import { describe, expect, it } from "vitest";
import { SafeInt, JsonObject } from "../src/json.js";

// §913 — THE INTEGER-ONLY CANONICAL LAW REJECTS NEGATIVE ZERO, AND NOTHING PROVED IT.
//
// `SafeInt`'s refine was UNTESTED: neutralising it left all 318 contracts tests green. Found by mutating
// every refine site in the package, not by reading.
//
// What makes this one worth a test rather than a shrug is that the refine's ONLY marginal contribution
// is the -0 rejection — its own comment says so, since `z.number().int()` in Zod 4 already refuses floats
// and unsafe integers. So every green above came from the parts Zod does anyway, and the one behaviour
// the refine exists for had no coverage at all.
//
// -0 is precisely the value that breaks the frozen-byte law: `JSON.stringify(-0)` is `"0"`, so a -0
// entering the ledger would serialise, hash and re-parse as 0 while comparing !== to it under Object.is.
// The canonical layer in packages/ledger rejects it again (defence in depth) — but a boundary that
// silently admits it pushes a hash-fidelity failure one layer deeper before anything notices.
describe("REQ-011/002: SafeInt is the integer-only canonical law at the Zod boundary", () => {
  it("accepts an ordinary integer and POSITIVE zero (the control that isolates the sign)", () => {
    expect(SafeInt.parse(42)).toBe(42);
    expect(SafeInt.parse(0)).toBe(0);
    expect(SafeInt.parse(-7)).toBe(-7);
  });

  it("REJECTS -0 — it stringifies to \"0\" and would hash as 0 while comparing !== under Object.is", () => {
    expect(() => SafeInt.parse(-0)).toThrow(/integer-only canonical law/);
  });

  it("REJECTS a float and an unsafe integer (Zod's own int() does this; pinned so the chain cannot lose it)", () => {
    expect(() => SafeInt.parse(1.5)).toThrow();
    expect(() => SafeInt.parse(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  it("carries the law through the RECURSIVE payload schema — a nested -0 is refused too", () => {
    // 30 of the 35 kinds validate their payload against JsonObject, so the recursion is the path a real
    // -0 would actually take into the ledger. A boundary that only guards the top level guards nothing.
    expect(JsonObject.parse({ a: 1, b: { c: [2, 3] } })).toEqual({ a: 1, b: { c: [2, 3] } });
    expect(() => JsonObject.parse({ a: 1, b: { c: [2, -0] } })).toThrow(/integer-only canonical law/);
  });
});
