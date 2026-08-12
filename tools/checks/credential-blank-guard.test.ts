import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { EXPECTED_EMPTY_GLOBS, SOURCE_SCAN_GLOBS, isTestPath, stripComments } from "./source-corpus.js";
import { repoRoot } from "./repo-root.js";

// §1148 (REQ-154/134) — A BLANK CREDENTIAL MUST NOT READ AS A CONFIGURED ONE.
//
// §1108 swept all seven credentials and found every composition root testing `!== undefined` AND `!== ""`.
// The empty-string half is the non-obvious one and it is the half that matters: `wrangler secret put` with
// empty input, or a var set to "", satisfies a presence check and yields a LIVE client holding a BLANK
// credential — a fail-open that looks configured. The undefined half fails safe on its own; the empty half is
// the only thing standing between "not configured" and "configured with nothing".
//
// That was a READ (§1146's middle class): true, and not re-runnable. This is the gate, built to §1147's
// pattern — positive-match the danger, floor the corpus, pin the boundary, and carry its own sensitivity test.
//
// THE RULE: a local bound from an `*_SECRET` / `*_KEY` / `*_TOKEN` env binding must be compared against the
// empty string somewhere in its file. POLARITY IS NOT PRESCRIBED, because this build legitimately uses both:
//
//   workers/billing/src/billing.ts   secret !== undefined && secret !== ""        (positive selector)
//   workers/agents/src/index.ts:341  if (token === undefined || token === "")     (inverted early return)
//
// A gate that demanded one form would red the other, so it demands only that the COMPARISON EXISTS. What it
// cannot see is a check hidden behind a helper (`isBlank(token)`); that is a real bound, stated rather than
// papered over — the §1145 rule that an unsound mechanisation is worse than an honest one.

const CREDENTIAL_BINDING = /const\s+(\w+)\s*=\s*\w*[Ee]nv\.(\w*(?:SECRET|_KEY|TOKEN)\w*)\s*;/g;

export interface Unguarded { readonly file: string; readonly local: string; readonly binding: string }

/** Credential locals in `text` with no empty-string comparison anywhere in the file (either polarity). */
export function unguardedCredentials(file: string, text: string): Unguarded[] {
  const src = stripComments(text);
  const out: Unguarded[] = [];
  for (const m of src.matchAll(CREDENTIAL_BINDING)) {
    const local = m[1] as string;
    const binding = m[2] as string;
    // `local === ""` or `local !== ""` — the comparison itself, in whichever direction the site is written.
    const blankCheck = new RegExp(`\\b${local}\\s*[!=]==\\s*""`);
    if (!blankCheck.test(src)) out.push({ file, local, binding });
  }
  return out;
}

function corpus(): { path: string; text: string }[] {
  const root = repoRoot();
  const files: { path: string; text: string }[] = [];
  for (const g of SOURCE_SCAN_GLOBS) {
    const hits = globSync(g, { cwd: root }).filter((p) => !isTestPath(p));
    if (hits.length === 0 && !EXPECTED_EMPTY_GLOBS.has(g)) {
      throw new Error(`credential-blank-guard: glob matched ZERO files — ${g} (a broken pattern reads as a clean scan)`);
    }
    for (const p of hits) files.push({ path: p, text: readFileSync(`${root}/${p}`, "utf8") });
  }
  return files;
}

describe("§1148 REQ-154: a blank credential is not a configured credential", () => {
  const files = corpus();
  const bindings = files.flatMap((f) => [...stripComments(f.text).matchAll(CREDENTIAL_BINDING)].map((m) => `${f.path}:${m[2] as string}`));

  it("finds the credential bindings at all (non-vacuity — §968's rule)", () => {
    // Five measured at §1148 (RESEND_API_KEY ×2, ANTHROPIC_API_KEY, TEST_SEND_TOKEN, STRIPE_WEBHOOK_SECRET).
    expect(bindings.length, "no credential bindings found — the scan is broken, not the code").toBeGreaterThanOrEqual(4);
  });

  it("SENSITIVITY: a binding checked only for undefined is flagged", () => {
    // The fail-open this gate exists for: presence satisfied, blank credential live.
    const planted = "const apiKey = env.RESEND_API_KEY;\nif (apiKey !== undefined) { return new Sender(apiKey); }";
    expect(unguardedCredentials("planted.ts", planted)).toHaveLength(1);
  });

  it("BOUNDARY: both polarities pass — a positive selector and an inverted early return", () => {
    const positive = 'const secret = env.STRIPE_WEBHOOK_SECRET;\nreturn secret !== undefined && secret !== "" ? live() : dark();';
    const inverted = 'const token = env.TEST_SEND_TOKEN;\nif (token === undefined || token === "") return json(500, {});';
    expect(unguardedCredentials("a.ts", positive)).toEqual([]);
    expect(unguardedCredentials("b.ts", inverted)).toEqual([]);
  });

  it("a blank check discussed in a COMMENT does not satisfy the rule", () => {
    const commented = 'const apiKey = env.RESEND_API_KEY;\n// we should test apiKey !== "" here one day\nif (apiKey !== undefined) live();';
    expect(unguardedCredentials("c.ts", commented)).toHaveLength(1);
  });

  it("every credential binding in production source is blank-guarded", () => {
    expect(files.flatMap((f) => unguardedCredentials(f.path, f.text))).toEqual([]);
  });
});
