import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";

// REQ-167/111 §1768 — RUNTIME LOGS CARRY IDS, NEVER THE PERSON BEHIND THEM.
//
// The identity-leak lint (REQ-167) scans REPO ARTIFACTS. It cannot see what a Worker writes to stdout at
// runtime, and that output leaves the trust boundary: Cloudflare retains it, operators read it, and it is the
// classic place a counterparty's email address escapes a system that is otherwise careful with them.
//
// MEASURED FIRST (§1768), because a ratchet on an empty or already-broken corpus is theatre. All 97
// production `console.*` sites: 19 interpolate nothing, 77 interpolate ids/slugs only (`shipment_id`,
// `party_id`, `invoice_id`, `event_id`, tenant slugs), and 1 matched a PII keyword — `${name}`, which is a
// SWEEP name ("sla", "recon"), not a person's. **Zero logs carry a value that identifies anyone.** That is
// the property this file freezes; it is not a backlog.
//
// The discipline is real and worth naming, because the code shows it deliberately: the Biller's
// recipient-unresolved log says *"bill-to party <id> has no contact email"* — it names the GAP and the ID and
// declines to echo the address it was looking for.
//
// WHY THE TERM LIST IS SHORT AND WHY `name` IS NOT IN IT. A detector whose boundary is English can never be
// complete, so this one is tuned for PRECISION over recall and built from the corpus rather than from
// vocabulary: `name` was in the first draft, produced exactly one hit, and that hit was a false positive.
// Keeping it would have made the gate's first real firing a false alarm — the cry-wolf mode this repo has
// already paid for. Each term below is here because it names a value that identifies a PERSON or reproduces
// message CONTENT, and because it produced zero hits when measured.
const PII_TERMS = [
  "email", // an address identifies a counterparty directly
  "recipient", // ditto, and the Biller/Concierge both compute one
  "contacts", // parties.contacts is the address book column
  "address", // postal identification
  "phone",
  "subject", // message content, not a reference to it
  "body_text", // ditto — note `body_ref` is a POINTER and is fine
] as const;

/** `${…}` expressions inside a console.* / logEvent call on one line. */
function interpolations(line: string): string[] {
  const call = /(?:console\.\w+|logEvent)\((.*)/.exec(line);
  if (call === null) return [];
  return [...call[1]!.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!);
}

const hits = (expr: string): string[] =>
  PII_TERMS.filter((t) => new RegExp(`\\b${t}\\b`, "i").test(expr));

describe("REQ-167/111 §1768: no runtime log interpolates a value that identifies a person", () => {
  const root = repoRoot();
  const lines = execSync(
    "git grep -n -E '(console\\.(log|error|warn|info)|logEvent)\\(' -- " +
      "'workers/**/*.ts' 'packages/**/*.ts' " +
      "':(exclude)**/test/**' ':(exclude)**/*.test.ts' ':(exclude)**/perf/**'",
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);

  it("the corpus floor — a glob that matched nothing would report a clean sweep", () => {
    // §1768 measured 97 sites. The floor is deliberately well under that so ordinary churn does not trip it,
    // and well above zero so a broken pathspec cannot pass. Floor the INPUT, never the findings.
    expect(lines.length, "the console/logEvent corpus collapsed — fix the pathspec before trusting a green").toBeGreaterThan(60);
    // …and at least some of them must interpolate, or the detector is being handed nothing to detect.
    expect(lines.filter((l) => interpolations(l).length > 0).length).toBeGreaterThan(30);
  });

  it("POSITIVE CONTROL — the detector fires on a log that does leak (a green means nothing without this)", () => {
    const leak = 'console.error(`biller: could not send to ${recipient.email} for party ${id}`);';
    expect(interpolations(leak).length, "the interpolation reader failed, not the term list").toBeGreaterThan(0);
    expect(interpolations(leak).flatMap(hits)).toContain("email");
    // And the shape the codebase actually uses must NOT fire, or the gate is noise:
    const ok = "console.error(`biller: bill-to party ${shipment.bill_to_party_id} has no contact email — HELD`);";
    expect(interpolations(ok).flatMap(hits), "an id-only interpolation must stay silent").toEqual([]);
  });

  it("every production log interpolates ids only — no address, contact, or message body", () => {
    const problems: string[] = [];
    for (const line of lines) {
      const at = line.indexOf(":");
      const loc = line.slice(0, line.indexOf(":", at + 1));
      for (const expr of interpolations(line)) {
        const matched = hits(expr);
        if (matched.length === 0) continue;
        problems.push(
          `${loc}: a log interpolates \`${expr.trim()}\` (matches ${matched.join(", ")}). Runtime logs leave the ` +
            "trust boundary. Log the ID and the GAP, the way biller.ts does — \"party <id> has no contact " +
            "email\" — never the value itself. If this is a false positive, narrow the expression or record " +
            "the reason here; do not widen the term list.",
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("the one arbitrary-text log is still the ONLY one, and still bounded to a message", () => {
    // `logEvent("error.unhandled", { message: err.message })` is the single place a log carries text this gate
    // cannot reason about — an Error message is arbitrary. It is acceptable BECAUSE it is one site with a
    // known shape: the response says only "INTERNAL ERROR" and the text stays in the log. If a second
    // arbitrary-text logger appears, that argument stops holding and this fails so someone re-makes it.
    const callers = execSync(
      "git grep -c 'logEvent(' -- 'workers/**/*.ts' ':(exclude)**/test/**' ':(exclude)**/*.test.ts'",
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    // one definition site + one call site
    expect(callers.length, `logEvent gained or lost a file: ${callers.join(" | ")}`).toBe(2);
    expect(callers.some((c) => c.startsWith("workers/api/src/log.ts:"))).toBe(true);
    expect(callers.some((c) => c.startsWith("workers/api/src/middleware/error.ts:"))).toBe(true);
  });
});
