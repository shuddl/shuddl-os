import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { scanCorpus } from "./scan-corpus.js";

// REQ-170 §636 — A GUARANTEE MUST NOT BE GATED ON ITS OWN WIRING BEING PRESENT.
//
// §634 found the shape: `if (deps.evidence !== undefined) { ...the byte precondition... }`. When the bucket is
// unwired the check does not fail — it SKIPS, and the Biller issues invoices for PODs whose evidence does not
// exist. §635 swept for more and found none, because this repo has a `NotConfigured*` idiom used TEN TIMES
// (Sender, Parser, Copilot, Transport, Billing, EventSource, FeedReader, Migrator, SecretResolver,
// WebhookTransport) whose adapters REJECT LOUDLY instead of branching quietly. Ten applications, one
// deviation, one defect — and the defect was in the deviation.
//
// §635 then named what nothing enforced: a NEW integration wired with a bare `!== undefined` branch would
// reintroduce it silently. This is that enforcement.
//
// STRUCTURAL, NOT SEMANTIC — deliberately, because §618 proved the semantic version does not work. The signal
// is narrow and mechanical: an optional-dependency guard whose BODY CAN REJECT. That combination is what makes
// absence dangerous, because the rejection is exactly what cannot happen when the dep is missing. A guard that
// merely assembles headers or config is untouched by this rule, which is why it fires on ONE site today and
// not on the nine other `!== undefined` branches §635 catalogued.

const GUARD = /if\s*\(\s*(?:deps|env|opts|config|this\.\w+)\.(\w+)\s*!==\s*undefined\s*\)\s*\{/g;
const REJECT = /(throw new |status:\s*"held"|return\s*\{\s*ok:\s*false|reject\()/;

/**
 * Guards allowed to keep this shape, by `file:dependency`, each with the assertion that compensates for it.
 * An entry is a promise that something else proves the wiring is present in production.
 */
const SANCTIONED: ReadonlyMap<string, string> = new Map([
  [
    "workers/agents/src/biller.ts:evidence",
    "REQ-170 §634 — the gating is correct (a unit test not exercising the byte gate omits the dep). " +
      "tools/checks/evidence-wiring.test.ts asserts the composition root passes `evidence: env.EVIDENCE` AND " +
      "that the R2 binding exists in every deployable scope, so the skip cannot happen in production.",
  ],
]);

/** The block a guard opens, by brace depth. */
function blockAfter(src: string, from: number): string {
  const open = src.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i);
    }
  }
  return src.slice(open);
}

interface Guard {
  key: string;
  where: string;
}

function rejectingGuards(root: string): Guard[] {
  const out: Guard[] = [];
  for (const f of scanCorpus(["workers/*/src/*.ts", "packages/*/src/*.ts"], root, { excludeTests: true })) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    for (const m of src.matchAll(GUARD)) {
      if (!REJECT.test(blockAfter(src, m.index))) continue;
      out.push({ key: `${f}:${m[1]!}`, where: `${f}:${src.slice(0, m.index).split("\n").length}` });
    }
  }
  return out;
}

describe("REQ-170 §636: no unsanctioned guarantee is gated on its own wiring", () => {
  const root = repoRoot();

  it("scans the source corpus (non-vacuity)", () => {
    // scanCorpus throws on an empty glob, so a renamed tree fails loudly rather than reporting clean — the
    // §625 helper doing the job it was built for.
    expect(
      scanCorpus(["workers/*/src/*.ts", "packages/*/src/*.ts"], root, { excludeTests: true }).length,
      "no source files scanned — the scan is broken, not the tree",
    ).toBeGreaterThan(150);
  });

  it("every rejecting optional-dep guard is sanctioned with what compensates for it", () => {
    const unsanctioned = rejectingGuards(root).filter((g) => !SANCTIONED.has(g.key));
    expect(
      unsanctioned.map((g) => g.where),
      "an optional dependency gates a block that can REJECT. When that dep is absent the check does not " +
        "fail — it SKIPS, and the guarantee silently stops applying (§634: invoices issued for PODs whose " +
        "evidence was never stored). Prefer a `NotConfigured*` adapter that rejects loudly — the idiom this " +
        "repo uses ten times. If the gating is genuinely right, add it to SANCTIONED naming the assertion " +
        "that proves the dep is wired in production:\n  " +
        unsanctioned.map((g) => g.where).join("\n  "),
    ).toEqual([]);
  });

  it("nothing sits in SANCTIONED after its guard is gone", () => {
    // §"record holds with expiry triggers": an exemption that outlives its subject is a permanent excuse for
    // a shape nobody is still writing.
    const live = new Set(rejectingGuards(root).map((g) => g.key));
    const stale = [...SANCTIONED.keys()].filter((k) => !live.has(k));
    expect(stale, `SANCTIONED excuses a guard that no longer exists — delete the entry:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
