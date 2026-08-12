import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// REQ-030 — THE AUTHORITY REGISTRY'S COMPLETENESS TRIPWIRE (audit §326).
//
// `check:authority-coverage` proves each REGISTERED (module, file) pair consults `resolveAuthority`. Its own
// header states the limit: registration is MANUAL, and *"a NEW emitter in a NEW file passes for free until a
// human adds it"*, with completeness deferred to the WP-15 Task-10 exit audit — which has run and closed. So
// the registry was owned once, by a past event, and by nothing recurring (audit §313, filed as a
// repository-owned hold in GO-LIVE-CHECKLIST).
//
// §313 rejected a discovery GATE and was right to: "authoritative" is semantic. A rule keyed on kind-mentions
// misclassifies 4 of 4 unregistered candidates — two readers, one generic append route, one platform-tenant
// emitter — each of which took a file read to adjudicate.
//
// THIS IS NOT THAT GATE. It classifies nothing. It pins the POPULATION and fails when the population moves,
// which puts the adjudication in front of the person who caused it — the §265 shape (membership required
// rather than remembered) and the §294 rule (pin what must be argued). A count cannot be wrong about what a
// file MEANS; it can only be right or wrong about how many there are.

const KINDS = String.raw`"(quote\.priced|invoice\.issued|settlement\.[a-z]+|message\.sent)"`;

/** Files under the worker/agent trees that mention an authoritative event kind, tests excluded. */
function kindReferencingFiles(): string[] {
  const out = execSync(
    `grep -rlE '${KINDS}' workers/*/src packages/agents/src --include="*.ts" 2>/dev/null || true`,
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean).filter((f) => !f.includes(".test.")).sort();
}

// The adjudication as of audit §313, re-verified at §326, extended at §1177. Eight are REGISTERED in
// AUTHORITATIVE_FILES; five are deliberately excluded, each for a stated reason that required reading the file.
const EXPECTED = 13;
const EXCLUDED_WITH_REASON: ReadonlyArray<readonly [string, string]> = [
  ["workers/api/src/routes/kpis.ts", "reader — names kinds to filter on (§272: a mention is not a use)"],
  ["workers/mcp/src/webhooks.ts", "reader — matches kind strings to shape an outbound webhook payload; it appends nothing"],
  ["workers/api/src/routes/events.ts", "the GENERIC append route; the gated-kind consult lives in the sequencer DO, which IS registered under `dispatch`"],
  ["workers/billing/src/credits.ts", "emits on the reserved `_platform` revenue tenant (Stripe credit-pack sale) — platform SaaS revenue, not tenant freight authority"],
  // §1177 — this file entered the population by being made MORE restrictive, which is this tripwire working
  // exactly as designed: the two kinds appear here only inside PLATFORM_CREDIT_KINDS, the allowlist that BOUNDS
  // what the seam may append (previously the body's loose z.record left the kind unbounded).
  //
  // ADJUDICATED EXCLUDE, same category as credits.ts above and for the same reason. It does append an
  // authoritative kind — but against `_platform`, never a tenant freight database. The tenant is the fixed
  // PLATFORM_TENANT_ID sentinel and #resolveDb asserts it, so this seam CANNOT reach a customer D1. Registering
  // it would be actively harmful: `resolveAuthority` fail-closes to 'legacy' ("the incumbent's system is
  // authoritative"), and `_platform` has no incumbent and no migration — the consult would gate SHUDDL's own
  // revenue against a system that does not exist. See the same argument at authority-coverage.ts's deliberate
  // absence; credits.ts CONSTRUCTS these events and this route APPENDS them, two files on one platform path.
  [
    "workers/api/src/routes/internal-platform.ts",
    "the `_platform` credit APPEND PORT — names the two kinds only in §1177's allowlist bounding what it may append; platform SaaS revenue, never a tenant freight database",
  ],
];

describe("REQ-030: the authority registry's completeness has a tripwire", () => {
  const files = kindReferencingFiles();

  it("finds the population at all (non-vacuity)", () => {
    // A broken grep or a moved tree would otherwise make the pin below pass on an empty set — the exact
    // shape this audit rejects repeatedly.
    expect(files.length, "no files reference an authoritative kind — the search is wrong, not the tree").toBeGreaterThan(5);
  });

  it(`exactly ${EXPECTED} files reference an authoritative kind — a change means RE-ADJUDICATE`, () => {
    expect(
      files.length,
      `The authority population moved (was ${EXPECTED}, now ${files.length}):\n${files.join("\n")}\n\n` +
        `This is NOT automatically a defect — it is a decision nobody is otherwise prompted to make. For each ` +
        `NEW file ask: does it APPEND an authoritative kind against a TENANT database?\n` +
        `  yes → add it to AUTHORITATIVE_FILES in tools/checks/authority-coverage.ts, under every module it ` +
        `is authoritative for (a file can be authoritative for more than one).\n` +
        `  no  → add it to EXCLUDED_WITH_REASON here with the reason, so the next reader does not re-derive it.\n` +
        `Then update this count. See audit §313/§326 and the hold in docs/ops/GO-LIVE-CHECKLIST.md.`,
    ).toBe(EXPECTED);
  });

  it("every recorded exclusion still exists and still carries its reason", () => {
    // An exclusion whose file was deleted or renamed is a stale adjudication — it would silently shrink the
    // reviewed set while the count above still balanced.
    for (const [path, reason] of EXCLUDED_WITH_REASON) {
      expect(files, `${path} is recorded as a deliberate exclusion but no longer references an authoritative kind`).toContain(path);
      expect(reason.length, `${path}'s exclusion has no stated reason`).toBeGreaterThan(20);
    }
  });
});
