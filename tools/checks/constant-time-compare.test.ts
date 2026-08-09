import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §801 — EVERY CONSTANT-TIME COMPARISON MUST ACCUMULATE, NEVER EARLY-RETURN.
//
// This repo verifies secrets in SEVEN places, under FOUR different names — `bytesEqual`, `tokensEqual`,
// `constantTimeEqual`, `timingSafeEqual`. Each protects something a timing oracle would love: the Stripe
// webhook signature, MCP OAuth tokens, the outbound webhook HMAC, the EDI inbound-204 HMAC, TSA/CMS
// signature bytes, merkle proof nodes, and the platform internal secret.
//
// WHY A SOURCE-LEVEL GATE, WHICH THIS REPO OTHERWISE AVOIDS: **behaviour cannot see this property.**
// `constantTimeEqual(a, b)` and `a === b` return the identical boolean for every input in the universe. The
// only difference is WHEN they stop looking — and a test that measured wall-clock would be a flake generator
// on shared CI. So the thing to assert is the shape: length-checked first, then an accumulation over EVERY
// element with no `return` inside the loop.
//
// MEASURED (§801): replacing the api's and the billing worker's implementations with `return a === b` left
// `workers/api` at 810/810 and `workers/billing` at 58/58. Two of seven confirmed unwatched; the gate covers
// all seven so the rest never need the same discovery.
//
// ROSTER, not shape-discovery — the §796 calibration lesson. A detector that finds these BY their accumulate
// shape would stop finding one the moment it was broken, and report a smaller clean set. The roster fails
// LOUDLY when a member disappears.

interface Site {
  readonly file: string;
  readonly fn: string;
  readonly protects: string;
}

const ROSTER: readonly Site[] = [
  { file: "workers/billing/src/billing.ts", fn: "constantTimeEqual", protects: "the STRIPE WEBHOOK signature (internet-facing)" },
  { file: "workers/mcp/src/oauth.ts", fn: "timingSafeEqual", protects: "MCP OAuth tokens" },
  { file: "workers/mcp/src/webhooks.ts", fn: "timingSafeEqual", protects: "the outbound webhook HMAC" },
  { file: "workers/translator/src/inbound.ts", fn: "timingSafeEqual", protects: "the EDI inbound-204 partner HMAC" },
  { file: "workers/api/src/routes/internal-platform.ts", fn: "constantTimeEqual", protects: "the platform internal secret" },
  { file: "workers/agents/src/index.ts", fn: "tokensEqual", protects: "the test-send bearer token" },
  { file: "packages/ledger/src/tsa/cms.ts", fn: "bytesEqual", protects: "TSA/CMS signature bytes" },
  { file: "packages/ledger/src/merkle.ts", fn: "bytesEqual", protects: "merkle proof nodes" },
];

/** The body of `function <fn>(…)` — brace-matched. */
function functionBody(src: string, fn: string): string | undefined {
  const start = src.indexOf(`function ${fn}(`);
  if (start < 0) return undefined;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return undefined;
}

/** The loop body, if any — where an early return would leak. */
function loopBody(body: string): string | undefined {
  const m = /for\s*\([^)]*\)\s*\{/.exec(body);
  if (m) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < body.length; i++) {
      if (body[i] === "{") depth += 1;
      else if (body[i] === "}") {
        depth -= 1;
        if (depth === 0) return body.slice(m.index + m[0].length, i);
      }
    }
  }
  // Single-statement `for (…) diff |= …;` — everything to the end of that line.
  const single = /for\s*\([^)]*\)\s*([^\n{][^\n]*)/.exec(body);
  return single?.[1];
}

describe("§801: every constant-time comparison accumulates instead of short-circuiting", () => {
  const root = repoRoot();

  it.each(ROSTER)("$file :: $fn — protects $protects", ({ file, fn }) => {
    const body = functionBody(readFileSync(`${root}/${file}`, "utf8"), fn);
    expect(
      body,
      `${fn} was not found in ${file}. It was renamed, moved, or deleted — re-verify that whatever now ` +
        "compares that secret is still constant-time, then update this roster. Do not simply drop the row.",
    ).toBeDefined();

    // 1. A length check FIRST — unequal lengths are a definite non-match and must not reach the loop.
    expect(body!, `${file}::${fn} lost its length check — the loop would read past one operand`).toMatch(/\.length\s*!==\s*\w+\.length/);

    // 2. An accumulation, not a comparison: XOR into a running value.
    expect(body!, `${file}::${fn} no longer accumulates with ^ — it may be short-circuiting`).toMatch(/\^/);
    expect(body!, `${file}::${fn} no longer folds with |= or +=`).toMatch(/\|=|\+=/);

    // 3. THE LOAD-BEARING ONE: no `return` inside the loop. That is the difference between constant-time and
    //    `a === b`, and it is the difference no behavioural test can observe.
    const loop = loopBody(body!);
    expect(loop, `${file}::${fn} has no comparison loop — it was rewritten; re-verify it is still constant-time`).toBeDefined();
    expect(
      /\breturn\b/.test(loop!),
      `${file}::${fn} RETURNS INSIDE ITS COMPARISON LOOP. That short-circuits on the first differing byte and ` +
        "leaks the secret one byte at a time to anyone who can measure response time. Accumulate over every " +
        "element and compare once at the end.",
    ).toBe(false);
  });

  // ── §802 — THE DISCOVERY HALF, closing the residual §801 named ("this gate cannot find a ninth") ──────
  //
  // The roster above cannot discover a NEW secret comparison. This can, by detecting the DEFECT shape rather
  // than the correct one: a secret-ish value compared to ANOTHER value with `===`/`!==`. A constant-time
  // helper never appears in that form, so any hit is either a genuine short-circuit or a comparison of
  // something that is not secret — and the second case is exactly what the allowlist below records.
  //
  // MEASURED (§802): 21 secret-ish strict comparisons exist, and 19 are PRESENCE checks (`=== undefined`,
  // `=== ""`, `=== null`). Comparing against a constant sentinel leaks nothing, so those are excluded by
  // construction rather than by allowlist. That leaves TWO, both legitimate and both recorded below.
  // THE VOCABULARY IS THE GATE'S REAL BOUNDARY, and it was measured rather than guessed (§803). Each
  // candidate word was added in isolation and the NEW hits counted:
  //   · `nonce`  → +1, and it is REAL (tsa/client.ts:68, allowlisted below) — so it is IN.
  //   · `key`    → +1, pure noise (`slot_key`, a dock-slot identifier) — so it is OUT.
  //   · cred · credential · otp · pin · salt · seed · privateKey · priv · jwk · auth · hash → +0 each.
  // §802 asserted "every widening word added noise without adding a hit"; that was WRONG for `nonce`, which
  // is why the list above is a measurement and not a sentence.
  const SECRETISH = String.raw`[\w.]*(?:secret|token|signature|sig|hmac|mac|digest|imprint|nonce|password|apiKey|bearer)[\w.]*`;

  /** Value-vs-value strict comparisons of secret-ish operands — the shape a constant-time helper never has. */
  function secretValueComparisons(root: string): string[] {
    const files = execSync('git ls-files "workers" "packages"', { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.ts$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
    const re = new RegExp(`(${SECRETISH})\\s*(?:===|!==)\\s*(${SECRETISH})`, "i");
    const out: string[] = [];
    for (const f of files) {
      readFileSync(`${root}/${f}`, "utf8").split("\n").forEach((raw, i) => {
        const line = raw.trim();
        if (line.startsWith("//") || line.startsWith("*")) return;
        const m = re.exec(raw);
        if (m && m[2] !== "undefined" && m[2] !== "null") out.push(`${f}:${i + 1}`);
      });
    }
    return out;
  }

  /** The two legitimate value comparisons — NOT secrets, and the reason each is safe. */
  const NON_SECRET_COMPARISONS: Record<string, string> = {
    "packages/ledger/src/tsa/client.ts:65":
      "imprint digest echo-check. An imprint is SHA-256(document) — the CALLER computed it and put it in the request; the TSA echoes it back. Nothing secret on either side, and the error prints BOTH values, which would be absurd if either were.",
    "packages/ledger/src/tsa/cms.ts:431":
      "the signature-bound imprint vs the caller's expected imprint. Same reasoning; the actual SIGNATURE bytes in this very file use `bytesEqual` (rostered above), so the distinction here is deliberate.",
    "packages/ledger/src/tsa/client.ts:68":
      "TSA nonce echo-check (§803). The nonce is generated BY THIS CLIENT, sent in the request, and echoed back; comparing it detects a replayed/substituted response. Nothing secret on either side — same class as the imprint check three lines above, and the error prints BOTH values.",
  };

  it("§802: no NEW secret value is compared with === (the discovery half the roster cannot do)", () => {
    const found = secretValueComparisons(repoRoot());
    // Calibration: the two known-legitimate sites must still be found, or the detector has broken and its
    // silence would mean nothing (§796).
    for (const known of Object.keys(NON_SECRET_COMPARISONS)) {
      expect(found, `the detector no longer finds ${known} — it broke, or that line moved; re-verify before trusting a clean scan`).toContain(known);
    }
    const novel = found.filter((f) => !(f in NON_SECRET_COMPARISONS));
    expect(
      novel,
      "a secret-ish value is compared to another value with ===/!==. That short-circuits on the first " +
        "differing byte. Either use a constant-time comparison and add it to the ROSTER above, or — if the " +
        "operands are not secret (a public digest, an echo-check) — record it in NON_SECRET_COMPARISONS with " +
        "the reason it is safe:\n  " +
        novel.join("\n  "),
    ).toEqual([]);
  });

  it("the roster is non-empty and every file exists (non-vacuity)", () => {
    expect(ROSTER.length).toBeGreaterThanOrEqual(8);
    for (const s of ROSTER) expect(() => readFileSync(`${root}/${s.file}`, "utf8"), `${s.file} is gone`).not.toThrow();
  });
});
