import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1253 (REQ-092/095) — EVERY quote.requested APPEND IS PRECEDED BY ITS SLA STAMP.
//
// `concierge.ts` states the coupling as LOAD-BEARING and explains the failure exactly: a reply that dies
// mid-flight must ALREADY carry its `sla_due_ts`, or `sla-sweep.ts` cannot find it and a stranded inbound loses
// its only backstop — it is never answered and nothing says so. The two halves live in different files and only
// work together.
//
// WHAT WAS AND WAS NOT PINNED. `workers/api/test/concierge.test.ts` stages a real crash mid-append and asserts
// the stamp survived — a genuinely strong test, and it exercises ONE branch. Measured at §1253 there are FOUR
// call sites, and the source comment said "three" (corrected in the same commit). So the property was proved
// once and assumed three more times, and a FIFTH site added later would be covered by nothing.
//
// This is the §1251 question — *does the rule apply at every site* — asked of a code pattern instead of a lint
// rule, and it is a source-shape check for the same reason §1248's was: the failure needs a process death
// between two statements, which no fixture separates. It lives in `tools/` because the workers pool has no
// `node:fs`.

const CONCIERGE = "workers/agents/src/concierge.ts";

/** Append sites whose immediately-preceding statement is not the SLA stamp. */
export function unstampedAppends(text: string): string[] {
  const lines = text.split("\n");
  const bad: string[] = [];
  lines.forEach((line, i) => {
    if (!/\bawait\s+appendQuoteRequested\s*\(/.test(line)) return;
    if (line.trim().startsWith("//")) return;
    // Walk back over blank/comment lines to the previous statement.
    let j = i - 1;
    while (j >= 0 && (lines[j]!.trim() === "" || lines[j]!.trim().startsWith("//"))) j -= 1;
    if (j < 0 || !/\bawait\s+setInboundSla\s*\(/.test(lines[j]!)) {
      bad.push(`${CONCIERGE}:${i + 1} — preceding statement is ${j >= 0 ? `\`${lines[j]!.trim().slice(0, 48)}\`` : "(start of file)"}`);
    }
  });
  return bad;
}

describe("§1253 REQ-092/095: the SLA stamp precedes every quote.requested append", () => {
  const text = readFileSync(`${repoRoot()}/${CONCIERGE}`, "utf8");

  it("finds the append sites at all (non-vacuity — a rename must fail HERE, not silently pass)", () => {
    const n = (text.match(/\bawait\s+appendQuoteRequested\s*\(/g) ?? []).length;
    expect(n, "no appendQuoteRequested call sites found — this gate lost its subject to a rename").toBeGreaterThanOrEqual(4);
  });

  it("every append is immediately preceded by setInboundSla", () => {
    const bad = unstampedAppends(text);
    expect(
      bad,
      "quote.requested append(s) NOT preceded by the SLA stamp. A reply that dies mid-append without a " +
        "`sla_due_ts` is invisible to sla-sweep.ts: the inbound is never answered and nothing surfaces it " +
        "(REQ-092):\n  " +
        bad.join("\n  "),
    ).toEqual([]);
  });

  it("the detector fires on an unstamped append, and not on a stamped one (both controls)", () => {
    expect(unstampedAppends("  await somethingElse(x);\n  await appendQuoteRequested(a, b);"), "an unstamped append is not detected").toHaveLength(1);
    expect(unstampedAppends("  await setInboundSla(db, id, ts);\n  await appendQuoteRequested(a, b);"), "a correctly stamped append is flagged").toEqual([]);
    // A comment between the two is fine — the walk-back must skip it rather than report a false positive.
    expect(unstampedAppends("  await setInboundSla(db, id, ts);\n  // note\n\n  await appendQuoteRequested(a, b);")).toEqual([]);
  });
});
