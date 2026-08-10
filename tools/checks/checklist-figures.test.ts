import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §933 — A CHECKLIST FIGURE THAT NOBODY RE-DERIVES IS A CLAIM WITH AN EXPIRY AND NO ALARM.
//
// The repo-owned section of GO-LIVE-CHECKLIST carries 45 rows, each with an explicit "Evidence expires"
// field naming what would falsify it. Those fields have exactly the standing of a reopen trigger: written
// once at the moment the row was filed, and run never.
//
// MEASURED AT §932: three were re-checked — the ones whose expiry condition names a NUMBER, so it is
// decidable in one command — and TWO had moved. The CONFIRM-GATED count had drifted 14 → 15 (the row's own
// trigger said "when the count changes materially"), and a row asserting "no tolerance implementation in
// tools/ or packages/" was simply false: `parity.ts@PARITY_TOLERANCE_BPS` is typed, tested, and its own
// header claims to BE rule 6's routes gate.
//
// This pins the figures so that decay is loud instead of silent. Each is DERIVED from source here and
// compared to what the checklist states — §830's rule: read one side and COMPUTE the other, never store
// both. A row that changes now fails HERE, in front of whoever changed it.
//
// SCOPE, STATED HONESTLY. This covers the THREE figures §932 verified, not all 45 rows. Most expiry
// conditions name a DECISION ("when the parenthetical is marked illustrative"), which no gate can evaluate.
// A discovery half — "find every numeric claim in the checklist" — is the §831/§833 shape and was measured
// there to produce eight false positives and zero real ones on prose of this kind, which is the profile of
// a gate people learn to silence. So this is a roster, deliberately, and its own incompleteness is the
// reopen trigger rather than a pretence of coverage.

const CHECKLIST = "docs/ops/GO-LIVE-CHECKLIST.md";

/** Count `CONFIRM-GATED` rows in the register — the authority, not a copy of it. */
function confirmGatedRows(root: string): number {
  const csv = readFileSync(`${root}/genesis/09-REQUIREMENTS-REGISTER.csv`, "utf8");
  return csv.split("\n").filter((l) => l.includes("CONFIRM-GATED")).length;
}

/** The canonical-view roster and its ceiling, parsed from the registry that declares them. */
function canonicalViews(root: string): { declared: number; max: number } {
  const src = readFileSync(`${root}/apps/command/src/views/registry.ts`, "utf8");
  const arr = /CANONICAL_VIEWS = \[(.*?)\]\s*as const/s.exec(src);
  const max = /MAX_CANONICAL_VIEWS = (\d+)/.exec(src);
  return {
    declared: arr === null ? -1 : [...(arr[1] as string).matchAll(/"([a-z_]+)"/g)].length,
    max: max === null ? -1 : Number(max[1]),
  };
}

describe("§933: the checklist's numeric claims are re-derived, not remembered", () => {
  const root = repoRoot();
  const checklist = readFileSync(`${root}/${CHECKLIST}`, "utf8");

  it("both derivations produce real values (non-vacuity — two broken parses agree about nothing)", () => {
    // A renamed register column, a restructured registry, or a broken read yields -1/0 and every comparison
    // below passes over nothing — the failure this repo met in four gates (§487/§554/§572).
    expect(confirmGatedRows(root), "no CONFIRM-GATED rows parsed from the register — the scan is broken, not the register").toBeGreaterThan(5);
    const v = canonicalViews(root);
    expect(v.declared, "CANONICAL_VIEWS did not parse — the scan is broken, not the registry").toBeGreaterThan(5);
    expect(v.max, "MAX_CANONICAL_VIEWS did not parse").toBeGreaterThan(0);
  });

  it("the CONFIRM-GATED count the checklist states equals what the register carries", () => {
    // The row's argument (CLAUDE.md names three, the register has many) survives a drift of one — but the
    // row's OWN expiry trigger is "when the count changes materially", so the figure must stay honest.
    const stated = /the register carries ~~\*\*\d+\*\*~~ \*\*(\d+)\*\*|the register carries \*\*(\d+)\*\*/.exec(checklist);
    expect(stated, `${CHECKLIST} no longer states a CONFIRM-GATED count where this gate reads it`).not.toBeNull();
    const n = Number(stated?.[1] ?? stated?.[2]);
    expect(
      n,
      `the checklist states ${n} CONFIRM-GATED rows; the register carries ${confirmGatedRows(root)}. §932 found this ` +
        "figure had drifted 14 → 15 unnoticed. Update the row (striking the old number, not deleting it) so the " +
        "next reader sees the question was asked and answered.",
    ).toBe(confirmGatedRows(root));
  });

  it("the canonical-view usage the checklist states equals the registry (11 declared under a ceiling of 12)", () => {
    const v = canonicalViews(root);
    // The row's whole point is that a ceiling and a usage read alike. If either moves, the row's example
    // stops being true and its argument stops landing.
    expect(checklist, `the checklist's canonical-views row no longer states ${v.declared} declared`).toContain(`declares **${v.declared}**`);
    expect(checklist, `the checklist's canonical-views row no longer states the ceiling ${v.max}`).toContain(`MAX_CANONICAL_VIEWS = ${v.max}`);
  });

  it("§932's correction stands: a routes tolerance DOES exist, so the row may not re-assert otherwise", () => {
    // The row originally claimed "no tolerance implementation in tools/ or packages/". It is false, and the
    // correction is struck-through rather than deleted. If someone reinstates the claim, or the constant it
    // was corrected against disappears, one of these two fails.
    const parity = readFileSync(`${root}/packages/ledger/src/parity.ts`, "utf8");
    // The COLON is load-bearing, and its absence was a defect in this file for one mutation round: a bare
    // `toContain("export const PARITY_TOLERANCE_BPS")` is satisfied by `…_BPS_X`, so renaming the constant away
    // left this GREEN. Second time this session I wrote that exact prefix bug into a tripwire (§920 was the
    // first), which is why it is spelled out here rather than fixed silently. A prefix is not an identifier.
    expect(parity, "PARITY_TOLERANCE_BPS is gone — §932's correction to the routes row rested on it").toContain("export const PARITY_TOLERANCE_BPS:");
    expect(parity, "the rating tolerance is no longer 1_000 bps (±10%) — the routes-gate claim rested on that number").toContain("rating: 1_000");
    expect(
      checklist,
      "the checklist's routes row no longer carries §932's correction. The claim 'no tolerance implementation' " +
        "is FALSE — parity.ts carries one and says it IS rule 6's routes gate. Do not re-assert it without " +
        "resolving whether that comment is right or over-claims.",
    ).toContain("EVIDENCE CORRECTED 2026-08-10 (audit §932)");
  });
});
