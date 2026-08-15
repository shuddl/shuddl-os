import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §817 — NO FLOAT EVER TOUCHES A MONETARY VALUE (CLAUDE.md money law).
//
// Of the ten laws, this one had NO gate. It was held by review and by the care of the people who wrote
// `packages/rater/src/money.ts` and `packages/ledger/src/money/split.ts` — both of which are exemplary. But
// §816 swept the tree by hand and found two live float divisions producing cents, one of them inside the
// module that carries the PERMANENT $222,084/35-lb net. A hand sweep is a measurement with an expiry date;
// this is the standing check that replaces it.
//
// WHAT IS AND IS NOT A VIOLATION — the distinction the whole gate turns on:
//   · `Math.round(costSum / costN)`      → a monetary VALUE from float division.        VIOLATION.
//   · `avgCostCents / budget.maxCents`   → money ÷ money = a dimensionless RATIO.       LEGITIMATE.
//   · `Math.round(latSum / latN)`        → milliseconds. Not money at all.              NOT SCANNED.
// The law governs values, not arithmetic. A ratio, a percentage and a basis-point figure are not monetary
// values and are allowlisted below WITH the reason, never silently skipped.
//
// THE VOCABULARY IS THE GATE'S REAL BOUNDARY and was MEASURED, not guessed (§803's rule). Each word was run
// alone against the tree and its hits counted:
//   · `cost` → 4 (2 real code, 2 prose)   · `cents`/`Cents` → 1   · `amount` → 1 (an error-message string)
//   · `sell` · `price` · `total` · `charge` · `fee` · `sell_cents` → 0 each.
// The zero-hit words are kept anyway: they cost nothing and they are exactly the identifiers a future money
// computation is most likely to use. A vocabulary tuned only to today's hits would go blind on tomorrow's.
//
// CALIBRATION IS SYNTHETIC, ON PURPOSE (the §796 problem, solved differently). §796 calibrates against a
// known live positive — but §816 and §817 FIXED both real positives, so there is nothing left in the tree to
// calibrate on, and a zero-result scan proves nothing on its own. So the calibration corpus is PLANTED in
// this file: the detector is fed the exact expression §816 deleted and must flag it, and fed the legitimate
// ratio and must not. That calibration cannot rot when the tree is clean, which is the state we want the
// tree to be in.

const MONEY_WORDS = ["cents", "amount", "sell", "cost", "price", "total", "charge", "fee"] as const;
const MONEYISH = String.raw`[\w.]*(?:${MONEY_WORDS.join("|")})[\w.]*`;

/**
 * The CODE SKELETON of a line: trailing `//` comment removed, and the CONTENTS of '…' / "…" string literals
 * blanked. Both patterns run on this, never on the raw line.
 *
 * Measured, in order, on the real tree: raw line → 9 false positives (every `const total_cents = x; // note`,
 * because the `//` opening a comment IS a `/` after an `=`). Comment-stripped → 2 (a `/` inside the message
 * `"…a zero/negative line (I7)"`). Skeleton → 0. Each step was a measurement, not a guess.
 *
 * TEMPLATE LITERALS ARE DELIBERATELY LEFT AS CODE. Blanking them would hide `${totalCents / n}` — an
 * interpolated division is real arithmetic producing a real cent. The cost is one prose false positive
 * (an error message in credits.ts), which is allowlisted with that reason. A false positive carrying an
 * explanation is a better trade than a blind spot carrying none.
 */
function codeSkeleton(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) { quote = null; out += ch; }
      continue; // string CONTENT is dropped
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === "/" && line[i + 1] === "/") break; // trailing comment
    out += ch;
  }
  return out;
}

interface Hit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly site: string; // "path:line" — for the human reading a failure, never for matching
}

/**
 * TWO patterns, because one is not enough — found by planting a probe and watching it come back CLEAN.
 *
 *   P1  a money-ish LEFT OPERAND:      `Math.round(sell_cents / weight_lb)`
 *   P2  a money-ish ASSIGNMENT TARGET: `const per_lb_cents = Math.round(1000 / n)`
 *
 * P1 alone was the first draft, and it misses P2 entirely: the divisor math can be anonymous while the
 * RESULT is the cent. My planted violation `const planted_cents = Math.round(1000 / 3)` sailed straight
 * through a gate I had just written and called green — the money word was left of the `=`, not of the `/`.
 * Worth stating plainly: the gate did not fail, the PROBE did, and the only reason I know is that a planted
 * violation is supposed to go red and this one did not. A calibration that only ever confirms is decoration.
 */
function floatMoneyDivisions(files: ReadonlyArray<{ path: string; text: string }>): Hit[] {
  const leftOperand = new RegExp(`(${MONEYISH})\\s*/\\s*([\\w.()]+)`, "i");
  const assignedTo = new RegExp(`\\b${MONEYISH}\\s*(?::[^=]*)?=[^=].*/`, "i");
  const re = { test: (s: string) => leftOperand.test(s) || assignedTo.test(s) };
  const out: Hit[] = [];
  // Both patterns run on CODE, never on the raw line. P2 looks for a `/` after an `=`, and the `//` opening
  // a trailing comment is exactly that — so without this, every `const total_cents = x; // note` matched.
  // Nine false positives, all of them a comment marker read as a division. Quote-aware because a `/` inside
  // a string literal (a URL, a "Cost/Rev" label) must not end the code either.
  for (const { path, text } of files) {
    text.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      // Prose, not code. A doc-comment saying "operating ratio (cost/revenue)" is not arithmetic.
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
      // A BigInt context is exact by construction — that is the APPROVED way to divide money.
      if (/\bBigInt\b|\d+n\b/.test(raw)) return;
      if (/https?:\/\//.test(raw)) return;
      const code = codeSkeleton(line);
      if (re.test(code)) out.push({ path, line: i + 1, text: line, site: `${path}:${i + 1}` });
    });
  }
  return out;
}

const isAllowed = (h: Hit): boolean =>
  NOT_A_MONETARY_VALUE.some((a) => a.path === h.path && h.text.includes(a.snippet));

// §1189 — WHY THIS CORPUS EXCLUDES `apps/`, stated because it was previously just a default.
//
// §843 below scans `packages/ workers/ apps/`; this scan does not, and nothing said why. A corpus is a choice,
// and an unstated one is indistinguishable from an oversight (§1188 found a gate whose markdown-only corpus
// hid five live defects for exactly that reason).
//
// MEASURED at §1189 by widening this function to include `apps` and running the gate: **exactly one hit, and
// it is a false positive** — `api.get(`/v1/shipments/${id}/events?limit=200`)`, whose `/` are URL path
// separators. Zero real findings.
//
// The false positive is STRUCTURAL, not fixable by a better pattern. `codeSkeleton` deliberately does NOT
// blank template literals, because a template literal can carry real interpolated arithmetic (`${a / b}`) and
// blanking it would hide the very thing this gate exists to catch — the allowlist entry at
// `workers/billing/src/credits.ts` records that decision. Front-end code is dense with relative API paths
// inside template literals, so widening trades a permanent false-positive stream for coverage of a tree where
// money is DISPLAYED rather than computed (money is a projection of physics; the arithmetic is server-side).
//
// `apps/` is not unguarded: §843 covers it at the identifier level — no `*CENTS*` identifier may hold a
// fractional value, scanned across all three trees and green. The split is deliberate, and now written down.
// Revisit if app-side money arithmetic ever appears, or if the skeleton learns to distinguish a URL path from
// an interpolation.
// §1505 — THE TREE DECISION ABOVE WAS ARGUED; THE EXTENSION DECISION WAS NOT. `/\.ts$/` dropped every `.tsx`
// inside the trees this corpus explicitly INCLUDES — and one of them is `biller/evidence-email-view.tsx`,
// whose `formatCents` turns integer cents into the dollar string printed on every customer invoice, under a
// header that states this gate's exact rule: *"Integer/string arithmetic ONLY — no float division, no
// toFixed."* MEASURED at §1505: a planted `cents / 100` in `collector/dunning.tsx` left this suite 10/10
// green. The §1189 reasoning above ("money is DISPLAYED in apps, computed server-side") is about the APPS
// tree and does not reach these — they are server-side renderers in an included tree, dropped by a filter
// nobody argued for. `.tsx` is now in; the apps exclusion, which IS argued, stands.
function prodSources(root: string): Array<{ path: string; text: string }> {
  return execSync('git ls-files "packages" "workers"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"))
    .map((f) => ({ path: f, text: readFileSync(`${root}/${f}`, "utf8") }));
}

/**
 * Sites that MATCH the shape but are not monetary values. Each carries the reason it is safe — the §802
 * idiom. An entry here is a claim someone can check, which a bare skip-list is not.
 *
 * KEYED BY CODE, NOT BY LINE NUMBER — decided the hard way. The first draft used `path:line` anchors, and
 * they went stale TWICE inside this one phase: adding four explanatory comment lines above the watchtower
 * ratio moved it 348 → 349, and adding five more moved it 349 → 354. §805 calls bare line numbers into
 * high-churn files fragile; two breaks in an hour is that lesson arriving with a bill. A `path` + code
 * `snippet` key cannot be moved by an edit somewhere else in the file, and it fails loudly if the code it
 * names is actually changed — which is exactly when a human should re-read the reason.
 */
interface Allowance {
  readonly path: string;
  readonly snippet: string; // matched against the trimmed source line — stable under insertion above it
  readonly why: string;
}

const NOT_A_MONETARY_VALUE: readonly Allowance[] = [
  {
    path: "workers/agents/src/watchtower.ts",
    snippet: "avgCostCents / budget.maxAvgCostCents",
    why: "money DIVIDED BY money is a dimensionless ratio, used only to rank alarm severity. No cent is produced, so there is no cent to misround. The sibling above computes an actual cent and uses roundHalfUp (§817).",
  },
  {
    path: "workers/billing/src/credits.ts",
    snippet: "amount_paid/amount_received",
    why: "prose inside a TEMPLATE literal, naming the two Stripe fields. The skeleton deliberately does not blank template literals (see codeSkeleton) so an interpolated `${cents / n}` cannot hide; this false positive is the price of that, and it is the whole price — measured, it is the only one.",
  },
];

describe("§817: no float division ever produces a monetary value (CLAUDE.md money law)", () => {
  const files = prodSources(repoRoot());

  it("the detector flags the known-bad shape and clears the legitimate ones (PLANTED calibration)", () => {
    // The exact expression §816 deleted from detectAnomaly. If this stops being flagged, the gate has gone
    // blind and every clean scan below it means nothing.
    const bad = floatMoneyDivisions([
      { path: "planted.ts", text: "const per_lb_cents = Math.round(sell_cents / weight_lb);" },
    ]);
    expect(
      bad.map((h) => h.site),
      "the detector no longer flags the §816 defect — it is broken, not the tree",
    ).toEqual(["planted.ts:1"]);

    // And the shapes it must NOT flag, or the gate becomes noise someone silences.
    const good = floatMoneyDivisions([
      { path: "ratio.ts", text: "const ratio = avgCostCents / budget.maxAvgCostCents;" }, // money÷money
      { path: "ms.ts", text: "const avgLatencyMs = Math.round(latSum / latN);" }, // not money
      { path: "exact.ts", text: "const q = BigInt(totalCents) / BigInt(n);" }, // exact by construction
    ]);
    expect(
      good.map((h) => h.site),
      "money÷money ratios, non-money units and BigInt arithmetic must not be flagged",
    ).toEqual(["ratio.ts:1"]);
    // NOTE, stated rather than hidden: the ratio line IS flagged by the regex — the shape is genuinely
    // ambiguous to a text scanner, because `a / b` looks identical whether the result is a cent or a ratio.
    // That is precisely why NOT_A_MONETARY_VALUE exists and why every entry must carry a reason. The gate
    // does not pretend to tell values from ratios; it forces a HUMAN to say which one each site is.
  });

  it("no NEW float division produces a monetary value", () => {
    const novel = floatMoneyDivisions(files).filter((h) => !isAllowed(h)).map((h) => `${h.site}  ${h.text}`);
    expect(
      novel,
      "a monetary value is being produced by float division. CLAUDE.md's money law admits no fractional " +
        "cent: `Math.round(a / b)` on cents loses exactness past 2^53 and does not follow the shared " +
        "half-up rule. Use `roundHalfUp(a, b)` / `mulDivHalfUp(a, b, d)` from @shuddl/rater, or " +
        "`allocateCents`/`apportion` from @shuddl/ledger for a split. If the result is NOT a monetary " +
        "value (a ratio, a percentage, a unit that is not money), record it in NOT_A_MONETARY_VALUE with " +
        "the reason:\n  " +
        novel.join("\n  "),
    ).toEqual([]);
  });

  it("every allowlist entry still MATCHES a real line (a stale reason is a lie, and must be loud)", () => {
    // Without this, fixing or moving an allowlisted line leaves a reason behind that describes nothing, and
    // the next reader trusts it. §794's roster lesson: assert membership BOTH ways.
    const hits = floatMoneyDivisions(files);
    for (const a of NOT_A_MONETARY_VALUE) {
      expect(
        hits.some((h) => h.path === a.path && h.text.includes(a.snippet)),
        `${a.path} no longer contains an allowlisted line matching \`${a.snippet}\` — the code changed, so ` +
          `re-read the reason ("${a.why.slice(0, 60)}…") and delete or update this entry. Never re-anchor blindly.`,
      ).toBe(true);
    }
  });

  it("the scan actually read the tree (non-vacuity)", () => {
    // A glob that silently matched nothing would make every assertion above pass. Measured 300+ at §817.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.path.includes("rater/src/money.ts"))).toBe(true);
  });
});
// ── §843 — THE ROOT CAUSE: a `*CENTS*` IDENTIFIER BOUND TO A FRACTIONAL VALUE ─────────────────────────
//
// The two patterns above match a money-ish LEFT OPERAND of `/` and a money-ish ASSIGNMENT TARGET. Neither
// could see the last real defect: `STORAGE_COST_CENTS_PER_GB_MONTH = 1.5` in retention.ts, multiplied into
// `Math.round((bytes / BYTES_PER_GB) * RATE)`. The division's left operand is `bytes` — not a money word —
// and the result is a bare `return`, not an assignment. §817's note said "the vocabulary is the gate's real
// boundary"; this was the boundary, found from the other side.
//
// So this does not add a third ARITHMETIC shape. It catches the ROOT CAUSE, one step earlier and with no
// judgement: an identifier whose name says cents, holding a value that cannot be cents. Measured across
// `packages/ workers/ apps/` — exactly one hit, now fixed, and zero false positives.

describe("§843: no `*CENTS*` identifier holds a fractional value", () => {
  const FRACTIONAL_CENTS = /\b(\w*(?:CENTS|Cents|cents)\w*)\s*(?::[^=]*)?=\s*(-?\d+\.\d+)/;

  function fractionalCentsConstants(root: string): string[] {
    return execSync('git ls-files "packages" "workers" "apps"', { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"))
      .flatMap((f) => {
        const out: string[] = [];
        readFileSync(`${root}/${f}`, "utf8").split("\n").forEach((raw, i) => {
          const line = raw.trim();
          if (line.startsWith("//") || line.startsWith("*")) return;
          const m = FRACTIONAL_CENTS.exec(raw);
          if (m) out.push(`${f}:${i + 1}  ${m[1]} = ${m[2]}`);
        });
        return out;
      });
  }

  it("the detector fires on the shape it exists for (calibration)", () => {
    // Planted, because the one real instance is fixed — a zero-result scan proves nothing on its own (§796).
    const planted = "const STORAGE_COST_CENTS_PER_GB_MONTH = 1.5;";
    expect(FRACTIONAL_CENTS.test(planted), "the detector no longer matches the §843 defect").toBe(true);
    // And the shapes it must NOT flag: an integer cents constant, and a fractional non-money constant.
    expect(FRACTIONAL_CENTS.test("const MIN_CHARGE_CENTS = 8500;")).toBe(false);
    expect(FRACTIONAL_CENTS.test("const FRAME_BUDGET_MS = 18.18;")).toBe(false);
  });

  it("no cents-named identifier in the tree holds a fractional value", () => {
    expect(
      fractionalCentsConstants(repoRoot()),
      "an identifier whose name says CENTS holds a value that cannot be cents. A fractional cent is not a " +
        "money value the ledger can carry — it becomes one only after a float multiplication, which is what " +
        "CLAUDE.md's money law forbids. If the underlying RATE is genuinely sub-cent, express it as an exact " +
        "integer ratio (retention.ts uses tenths of a cent per GB) and compute with mulDivHalfUp:",
    ).toEqual([]);
  });

  it("the scan reads the tree (non-vacuity)", () => {
    const files = execSync('git ls-files "packages" "workers" "apps"', { cwd: repoRoot(), encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
    expect(files.length, "no source files scanned — the glob is stale, not the tree").toBeGreaterThan(200);
  });
});
// ── §845 — DETECT THE VIOLATION, NOT THE CLAIM ────────────────────────────────────────────────────────
//
// §835 and §844 each widened a PROSE vocabulary to find modules claiming purity, and each left the same
// hole: a claim can be phrased in unboundedly many ways ("no Date, no random", "no clock", "no I/O"), so a
// detector reading English can never be complete. §844 stated that bound honestly and could not close it.
//
// This inverts the question. "Which modules READ an ambient clock or randomness?" is bounded, mechanical and
// independent of what any header says. A module may now adopt any phrasing it likes for its purity claim —
// the clock read itself is gated either way.
//
// SCOPE: `packages/**` only, and `workers/**` is excluded BY DESIGN rather than allowlisted file by file.
// Measured (§845): 58 ambient reads in production, **57 of them in workers** — which is the CORRECT pattern.
// A worker is a composition root: it reads the clock at the entry point and injects it downward, which is
// exactly what makes everything below it testable. A gate that flagged 57 correct reads would be turned off
// inside a week, and would take the two that matter with it.

describe("§845: the pure layer reads no ambient clock or randomness", () => {
  const AMBIENT = /\bDate\.now\(\)|\bnew Date\(\s*\)|\bMath\.random\(\)|crypto\.randomUUID\(\)/;

  /** Ambient reads in `packages/**`, ignoring comment lines and trailing `//` comments. */
  function ambientReads(root: string): string[] {
    return execSync('git ls-files "packages"', { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"))
      .flatMap((f) => {
        const out: string[] = [];
        readFileSync(`${root}/${f}`, "utf8").split("\n").forEach((raw, i) => {
          const line = raw.trim();
          if (line.startsWith("//") || line.startsWith("*")) return;
          // A trailing `//` comment is not code. `metrics.ts` reads `now: number; // … passes Date.now()`,
          // which a naive line filter counts as a violation — measured as a false positive at §845.
          const code = line.split("//")[0]!;
          const m = AMBIENT.exec(code);
          if (m) out.push(`${f}:${i + 1}  ${m[0]}`);
        });
        return out;
      });
  }

  /** The two package-level reads that are CONTROLS, not conveniences. */
  const JUSTIFIED: Record<string, string> = {
    "packages/agents/src/migrator/guess.ts":
      "nonceFence mints an UNPREDICTABLE per-call nonce so a header containing the fixed terminator cannot close the prompt fence early and smuggle instructions. Determinism here would be the vulnerability — this is why `packages/agents` is allowed crypto.randomUUID while `packages/adapters` bans it (§815's superset, explained in §845).",
    "packages/driver-core/src/capture.ts":
      "mints a new event id. Deterministic ids from identical input would collide, which is the opposite of what an append-only ledger needs.",
  };

  it("the scan reads the pure layer (non-vacuity)", () => {
    const files = execSync('git ls-files "packages"', { cwd: repoRoot(), encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
    expect(files.length, "no package sources scanned — the glob is stale, not the tree").toBeGreaterThan(80);
    expect(AMBIENT.test("const t = Date.now();"), "the pattern stopped matching an ambient read").toBe(true);
    expect(AMBIENT.test("const d = new Date(ms);"), "a CONVERSION must not read as an ambient read").toBe(false);
  });

  it("no package reads an ambient clock or randomness outside the justified two", () => {
    const novel = ambientReads(repoRoot()).filter((h) => !Object.keys(JUSTIFIED).some((f) => h.startsWith(`${f}:`)));
    expect(
      novel,
      "a module under `packages/**` reads the wall clock or randomness directly. The pure layer takes its " +
        "clock from its caller — inject it as `opts.now`, the way metrics.ts and billing.ts already do — so " +
        "that everything below a composition root stays testable without freezing time. If the randomness is " +
        "a CONTROL rather than a convenience (an unpredictable nonce, a minted id), record it in JUSTIFIED " +
        "with what it protects:\n  " +
        novel.join("\n  "),
    ).toEqual([]);
  });

  it("no JUSTIFIED entry outlives its subject (§672)", () => {
    const files = new Set(ambientReads(repoRoot()).map((h) => h.split(":")[0]!));
    for (const f of Object.keys(JUSTIFIED)) {
      expect(files, `${f} no longer reads randomness — delete its exception rather than leaving a reason for nothing`).toContain(f);
    }
  });
});
