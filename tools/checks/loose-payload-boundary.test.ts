import { describe, expect, it } from "vitest";
import { EVENT_KINDS } from "@shuddl/contracts";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1268 (REQ-118) — THE LOOSE-PAYLOAD BOUNDARY IS A FIXED, SWEPT SET.
//
// Doc 10 splits the 35 event kinds into 27 with a strictly-typed payload and 8 carrying a loose `JsonObject`.
// That split is the entire exposure surface for hand-written type guards: where the schema types a field, a
// wrong-typed value cannot reach the reader; where it does not, the reader's own `typeof` IS the guard (§1266).
//
// §1266–§1268 swept all 8 by hand and closed 4 reachable gaps. A sweep is a claim about a moment, and this
// gate is what keeps it from decaying into folklore: a NINTH loose kind, or a new hand-parser, means the sweep
// must be redone — and nothing else in CI would say so. It fails LOUD with the instruction rather than
// silently widening.
//
// This is a tripwire on a PRECONDITION, not a re-derivation of the sweep (§1254): it cannot tell whether a new
// reader guards its fields, only that the set the sweep covered has changed.

const SWEPT_LOOSE_KINDS = [
  "approval.decided",
  "approval.requested",
  "call.transcribed",
  "document.attached",
  "exception.raised",
  "payment.received",
  "quote.expired",
  "settlement.executed",
] as const;

function looseKindsInContract(root: string): string[] {
  const src = readFileSync(`${root}/packages/contracts/src/events.ts`, "utf8");
  return [...src.matchAll(/ev\("([\w.]+)",\s*JsonObject\)/g)].map((m) => m[1]!).sort();
}

describe("§1268 REQ-118: the loose-payload boundary the type-guard sweep covered", () => {
  const root = repoRoot();

  it("the contract still declares EXACTLY the 8 loose kinds that were swept", () => {
    const loose = looseKindsInContract(root);
    // Non-vacuity: a broken matcher yields [] and would make the comparison below meaningless.
    expect(loose.length, "no loose kinds parsed — this gate's matcher is stale, not the contract").toBeGreaterThan(0);
    expect(
      loose,
      "the set of LOOSE `JsonObject` payloads changed. Every field read off one of these is guarded by the " +
        "READER's own `typeof`, not by the schema — which is where §1266 found a gate clearing REQ-050 with no " +
        "photo hash, and §1267 found an invoice settling off a STRING amount. Re-run that sweep for the new " +
        "kind (find its readers, mutate each guard away, keep the ones that RED and gate the precondition of " +
        "the ones that don't), then update this list.",
    ).toEqual([...SWEPT_LOOSE_KINDS]);
  });

  it("every loose kind is a real event kind, and the typed remainder is the rest of the 35", () => {
    const loose = looseKindsInContract(root);
    for (const k of loose) expect(EVENT_KINDS as readonly string[], `${k} is not an event kind`).toContain(k);
    expect(EVENT_KINDS.length - loose.length, "the typed/loose split moved").toBe(27);
  });

  it("`readField` — the defensive reader for loose payloads — still has ONE call site file", () => {
    // §1266 closed the guards in transition-gates.ts. A second file adopting readField is a new hand-parse of
    // an untyped payload, which is exactly the shape that needs the mutation sweep before it ships.
    const files = execSync(`git grep -l 'readField(' -- packages workers || true`, { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f !== "" && !f.includes(".test."));
    expect(files, "readField gained a call site — sweep its guards (§1266) before this list is widened").toEqual([
      "packages/ledger/src/gates/transition-gates.ts",
    ]);
  });
});
