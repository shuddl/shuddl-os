import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1221/§1222 (REQ-154/134) — CLAUDE.md's "NO SECRETS EVER IN wrangler.toml", enforced LOCALLY by nothing.
//
// ⚠ CORRECTED AT §1222, and the correction is the point of this header. §1221 first wrote that the rule was
// "enforced by NOTHING for 4 of 9 configs". **That is FALSE.** `.github/workflows/ci.yml` runs a dedicated
// `secrets:` job — history-wide gitleaks (`fetch-depth: 0`, pinned action SHA), itself gated by
// `tools/release/ci-contract.test.ts`. Secrets committed anywhere ARE caught, in CI, before merge.
//
// WHAT IS TRUE, and why this gate still earns its place: **no LOCAL gate scans for secrets.** `verify:merge`
// runs 26 gates and not one of them is a secret scan, and gitleaks is not installed in the dev environment. So
// the check existed only on the far side of a push. This gate moves it to merge time, makes it deterministic
// and locally provable, and covers the corpus by name.
//
// MEASURED, not suspected. A live-shaped `RESEND_API_KEY = "re_live_…"` and `STRIPE_WEBHOOK_SECRET = "whsec_…"`
// were planted in `apps/portal/wrangler.toml` and the whole tools suite was run: **3 failed | 1292 passed** —
// byte-identical to the baseline. That measurement was correct; the INFERENCE drawn from it ("nothing catches
// this") was not. A local suite's silence is a statement about that suite (§1222).
//
// WHY THE GAP EXISTED. Every gate that reads wrangler configs scoped itself to the WORKERS directory:
//   · `wrangler-absence-claims.test.ts` → globSync("workers/*/wrangler.toml")   (5 configs)
//   · `wrangler-scope-parity.test.ts`   → readdirSync("workers")                 (5 configs)
//   · `binding-parity.test.ts`          → git ls-files "workers/*/wrangler.toml" (5 configs)
// Each is correctly scoped FOR ITS OWN SUBJECT — binding parity and absence claims really are about workers.
// But the union of their corpora is not the union of the rule's subjects, and no gate owned the difference:
// `apps/{command,driver,portal}/wrangler.toml` and `packages/ledger/wrangler.test.toml`. All four carry the
// banner "NO SECRETS EVER IN THIS FILE (REQ-154, REQ-134)" — the rule was DECLARED on files nothing read.
//
// That is the audit's standing shape: a scope gap between gates that are each individually right
// (§"an allowlist exempts one rule, not every rule"; §"two mechanisms disagreeing is the finding").
//
// THIS GATE OWNS THE WHOLE CORPUS — every tracked `*wrangler*.toml`, wherever it lives.
//
// DELIBERATELY NOT AN ENTROPY SCANNER. A generic "long high-entropy string" rule would fire on every
// `database_id` (they are UUIDs) and would have to be allowlisted into uselessness. This matches (a) keys NAMED
// like a secret and (b) values carrying a KNOWN VENDOR PREFIX. Both are precise; neither needs an exemption
// today, and an exemption added later is the thing to review.
//
// COMMENTS ARE NOT VIOLATIONS, and this is load-bearing rather than a nicety: all nine configs discuss their
// secrets in prose ("the Stripe webhook secret is operator-injected via `wrangler secret`"). Measured at §1221,
// EVERY secret-name mention in the corpus today is inside a comment — so a rule that read comments would be
// 100% false positives and would be deleted within a week. Only assignments count.

/** Keys whose NAME alone makes a literal value a secret, whatever it looks like. */
const SECRET_KEY = /(SECRET|API_?KEY|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_?KEY|CREDENTIAL)/i;

/** Values carrying a known vendor prefix — a live credential regardless of what the key is called. */
const SECRET_VALUE =
  /(sk-ant-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;

/**
 * Assignment lines that put a secret in a config. Comment lines are skipped entirely (see header). Returned as
 * `line:text` so a failure names the place, not just the count.
 */
export function offendingLines(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.trimStart().startsWith("#")) return;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(raw);
    if (m === null) return;
    const [, key, value] = m as unknown as [string, string, string];
    if (SECRET_KEY.test(key) || SECRET_VALUE.test(value)) out.push(`${i + 1}:${raw.trim()}`);
  });
  return out;
}

function configs(root: string): string[] {
  return execSync('git ls-files "*wrangler*.toml"', { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f !== "");
}

describe("§1221 REQ-154/134: no tracked wrangler config assigns a secret", () => {
  const root = repoRoot();
  const files = configs(root);

  it("finds the WHOLE corpus, including configs outside workers/ (the gap this gate exists to close)", () => {
    // Floor the INPUT, not the finding. A broken glob yields zero files and "no secrets" over an empty set is
    // the false clean this repo has spent scores of phases on.
    expect(files.length, "no wrangler configs found — the glob is broken, not the tree").toBeGreaterThanOrEqual(5);
    // The specific regression: someone re-narrows this to `workers/*` and the gate silently stops covering the
    // four files the rule was declared on but nothing read. That must fail here, loudly.
    const outsideWorkers = files.filter((f) => !f.startsWith("workers/"));
    expect(
      outsideWorkers,
      "this gate exists BECAUSE the workers/-only corpora missed these; a corpus with none of them is the old gap",
    ).not.toHaveLength(0);
  });

  it("no config assigns a secret-named key or a vendor-prefixed value", () => {
    const violations = files.flatMap((f) => offendingLines(readFileSync(`${root}/${f}`, "utf8")).map((l) => `${f}:${l}`));
    expect(
      violations,
      "SECRET(S) IN A TRACKED wrangler.toml — REQ-154/134 forbids this without exception:\n  " +
        violations.join("\n  ") +
        "\n\nSecrets are operator-injected with `wrangler secret put` (or OIDC), never committed. Remove the " +
        "assignment, rotate the exposed value, and bind it at deploy time.",
    ).toEqual([]);
  });

  it("the detector fires on the planted forms (non-vacuity — a dead regex would pass everything)", () => {
    // The exact two lines that went UNDETECTED through the full suite at §1221, plus a key-named case whose
    // value looks innocuous — proving the two rules are independent rather than one doing all the work.
    expect(offendingLines('RESEND_API_KEY = "re_live_PLANTEDSECRET"'), "vendor-prefix rule is dead").toHaveLength(1);
    expect(offendingLines('STRIPE_WEBHOOK_SECRET = "whsec_PLANTEDX"'), "secret-key rule is dead").toHaveLength(1);
    expect(offendingLines('JWT_SECRET = "hunter2"'), "a secret-NAMED key must fail on any value").toHaveLength(1);
    expect(offendingLines('ANTHROPIC_KEY = "sk-ant-api03-AAAAAAAA"'), "vendor prefix alone must fail").toHaveLength(1);
  });

  it("does NOT fire on the corpus's real shapes — comments, ids, and plain vars", () => {
    // Guarding against the false-positive that would get this gate deleted. Each line below is drawn from the
    // real configs: a prose mention of a secret, a UUID database_id (why there is no entropy rule), and the
    // three uppercase vars that legitimately exist.
    const benign = [
      "# NO SECRETS here — the Stripe webhook secret is a `wrangler secret`.",
      '#   STRIPE_WEBHOOK_SECRET and PLATFORM_INTERNAL_SECRET are operator-injected',
      'database_id = "0f5a1b2c-3d4e-5f60-7189-abcdef012345"',
      'ENVIRONMENT = "prod"',
      'EVIDENCE_FROM = "evidence@example.test"',
      'REFERRAL_BASE = "https://example.test/r"',
    ].join("\n");
    expect(offendingLines(benign), "a false positive here is how this gate gets deleted").toEqual([]);
  });
});
