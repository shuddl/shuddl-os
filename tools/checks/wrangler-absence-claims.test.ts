import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §944 — A "DELIBERATELY ABSENT" COMMENT IS A CLAIM ABOUT THE FILE IT SITS IN, SO IT CAN BE CHECKED.
//
// `workers/agents/wrangler.toml` declared, in the header introducing the staging environment:
//
//     #    RESEND_API_KEY / EVIDENCE_FROM / ALLOW_TEST_SEND are
//     #    DELIBERATELY ABSENT here — … so NO evidence email is ever sent from this deployment
//
// and then, ELEVEN LINES LOWER, under [env.staging.vars]:
//
//     # GO-LIVE (2026-07-14): staging evidence sending is ON.
//     EVIDENCE_FROM = "SHUDDL <pod@send.shuddl.tech>"
//
// `index.ts:237@evidenceSender` returns a ResendSender when RESEND_API_KEY and EVIDENCE_FROM are both
// non-empty, so the header was false about whether a DEPLOYED environment sends real email — to whatever
// address a shipment's party carries. It also silently fired the GO-LIVE-CHECKLIST L417 reopen trigger
// ("when RESEND_API_KEY + EVIDENCE_FROM bind"), leaving that row reading "Dormant while no provider is
// bound" while the branch was live.
//
// The same contradiction had ALREADY been found and fixed one artifact over — DEPLOYMENT.md:3, "evidence
// sending ~~OFF~~ LIVE (corrected 2026-08-01 — this header contradicted its own Sending section below)".
// The document describing the config was swept; the config was not.
//
// MEASURED AT §944: 8 claim-instances across two wrangler configs — 1 false, 7 true-positive controls.
//
// SCOPE, STATED HONESTLY. This verifies the toml does not SET a var the comment says is absent. A secret
// installed out-of-band by `wrangler secret put` is invisible to any repo-side check — which is precisely
// how the prose conclusion ("so NO evidence email is ever sent") drifted from the mechanism while the
// narrow claim about RESEND_API_KEY stayed true. A comment that reasons ONWARD from an absence to a
// behaviour is making a second claim this gate cannot reach; keep such conclusions out of the header, or
// state the binding they depend on.

/** An `[env.<name>...]` section's body, keyed by env — `[env.x]` and `[env.x.vars]` merge into one. */
function envBlocks(toml: string): Map<string, string> {
  const out = new Map<string, string>();
  const heads = [...toml.matchAll(/^\[env\.([A-Za-z0-9_]+)[^\]]*\]/gm)];
  heads.forEach((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? (heads[i + 1] as RegExpMatchArray).index : toml.length;
    const name = h[1] as string;
    out.set(name, (out.get(name) ?? "") + toml.slice(start, end));
  });
  return out;
}

/** Each `DELIBERATELY ABSENT` comment run, the vars it names, and the env section it introduces. */
function absenceClaims(toml: string): { env: string; vars: string[] }[] {
  // Struck spans are CORRECTIONS, not live claims — this repo preserves a falsified claim rather than
  // deleting it, so the strike must be removed BEFORE the phrase is looked for. Stripping afterwards was a
  // real bug in the first version of this gate: the corrected §944 header still NAMES EVIDENCE_FROM while
  // explaining that it IS set, and the parser read that mention as a fresh claim of absence. Caught by the
  // unmutated fixed point going red — which is the whole reason to run one.
  const lines = toml.replace(/~~[\s\S]*?~~/g, "").split("\n");
  const claims: { env: string; vars: string[] }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!(lines[i] as string).includes("DELIBERATELY ABSENT")) continue;
    // Gather the contiguous comment run around this line, then the first env header after it.
    let a = i;
    while (a > 0 && (lines[a - 1] as string).trimStart().startsWith("#")) a -= 1;
    let b = i;
    while (b + 1 < lines.length && (lines[b + 1] as string).trimStart().startsWith("#")) b += 1;
    // SENTENCE-SCOPED, not run-scoped. Taking every ALL-CAPS name in the contiguous comment run was the
    // second bug the fixed point caught: a corrected header legitimately NAMES the var it is un-claiming
    // ("EVIDENCE_FROM is set eleven lines below"), and an adjacent live claim about a DIFFERENT var then
    // dragged it back in. A claim binds only the sentence that makes it.
    const prose = lines.slice(a, b + 1).map((l) => l.replace(/^\s*#\s?/, "")).join(" ");
    const comment = prose
      .split(/(?<=\.)\s+/)
      .filter((sentence) => sentence.includes("DELIBERATELY ABSENT"))
      .join(" ");
    let env: string | undefined;
    for (let k = b + 1; k < lines.length; k += 1) {
      const m = /^\[env\.([A-Za-z0-9_]+)[^\]]*\]/.exec(lines[k] as string);
      if (m) { env = m[1] as string; break; }
      if ((lines[k] as string).startsWith("[")) break; // a non-env section: the claim is file-scoped
    }
    // WILDCARDS ARE REAL CLAIMS. `EDI_TRANSPORT_* are DELIBERATELY ABSENT` binds every var with that
    // prefix. The first version matched exact names only, so planting EDI_TRANSPORT_URL under the env it
    // governs stayed GREEN — found by mutation, not by reading. A claim written as a prefix must be
    // CHECKED as a prefix ("a prefix is not an identifier", inverted).
    const vars = [...new Set([...comment.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)(_?\*)?/g)]
      .filter((m) => (m[1] as string).includes("_"))
      .map((m) => `${m[1] as string}${m[2] === undefined ? "" : "*"}`))];
    if (env !== undefined && vars.length > 0) claims.push({ env, vars });
    i = b;
  }
  return claims;
}

describe("§944: a config's 'DELIBERATELY ABSENT' claims are true of that config", () => {
  const root = repoRoot();
  const files = globSync("workers/*/wrangler.toml", { cwd: root }).sort();

  it("finds wrangler configs and absence claims at all (non-vacuity)", () => {
    expect(files.length, "no workers/*/wrangler.toml found — the scan is broken, not the repo").toBeGreaterThanOrEqual(3);
    const total = files.reduce((n, f) => n + absenceClaims(readFileSync(`${root}/${f}`, "utf8")).length, 0);
    expect(
      total,
      "no DELIBERATELY ABSENT claims parsed. Either the convention was renamed (point this at the new " +
        "wording) or the parser broke — both must fail here rather than certify silence.",
    ).toBeGreaterThanOrEqual(2);
  });

  it.each(["workers/agents/wrangler.toml", "workers/translator/wrangler.toml"])(
    "%s: every var claimed absent is genuinely unset in that env",
    (file) => {
      const toml = readFileSync(`${root}/${file}`, "utf8");
      const blocks = envBlocks(toml);
      const violations: string[] = [];
      for (const { env, vars } of absenceClaims(toml)) {
        const body = blocks.get(env) ?? "";
        for (const v of vars) {
          const wildcard = v.endsWith("*");
          const base = wildcard ? v.slice(0, -1) : v;
          const re = new RegExp(`^\\s*(${base}${wildcard ? "[A-Z0-9_]*" : ""})\\s*=`, "m");
          const hit = re.exec(body);
          if (hit !== null) violations.push(`[env.${env}] ${hit[1] as string}${wildcard ? ` (claimed as ${v})` : ""}`);
        }
      }
      expect(
        violations,
        `${file} claims these are DELIBERATELY ABSENT and then SETS them:\n  ` +
          violations.join("\n  ") +
          "\n\nThat is §944 verbatim: the staging header said EVIDENCE_FROM was absent and 'NO evidence email " +
          "is ever sent', eleven lines above the assignment that turned real sending on. Either delete the " +
          "assignment or correct the comment — and if correcting, STRIKE the old text rather than deleting " +
          "it, as DEPLOYMENT.md did for this same defect.",
      ).toEqual([]);
    },
  );
});
