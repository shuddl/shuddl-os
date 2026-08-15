import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1547 (REQ-124/118) — THE METERING PERIOD HAS ONE BUILDER.
//
// `usage_credits` is keyed `<slug>:<period>`. The SLUG half was centralised long ago, and the comment above
// `usageCreditsId` says why in the plainest terms: *"§13 fixed the shape but left TWO definitions … This is now
// genuinely the one: the workers re-export it, they do not redefine it."* That discipline was never carried to
// the other half. Measured at §1547 the period existed FOUR times, byte-identical —
// `billing/metering.ts@periodOf`, `mcp/caps.ts@currentPeriod`, `agents/spark-caps.ts@currentPeriod`, and a
// fifth inline form in `api/provision.ts` — and THREE of them carried a comment saying they "mirror" the
// others. A mirror comment is a drift hazard announcing itself: nothing made them agree except that nobody had
// yet edited one. Had one drifted, a tenant's meter row would SPLIT across two ids for the same month, on the
// table Stripe reconciles against.
//
// The rule this gate enforces is deliberately narrow: not "nobody may compute a month" but "nobody may build
// THE METERING PERIOD STRING outside contracts". The two shapes below are the two that existed; a third would
// have to be written on purpose, and a reviewer seeing this gate is the point.
//
// SCOPE. Production source only. `contracts/platform-tenant.ts` is the home and is exempt BY PATH — an
// allowlist keyed to the one file entitled to define it (§1504: key an exemption to its subject, never to a
// name that another file could share).

const HOME = "packages/contracts/src/platform-tenant.ts";
/** `${y}-${m}` from getUTCMonth()+1 padded — the shape all four copies used. */
const UTC_MONTH_BUILD = /getUTCMonth\(\)\s*\+\s*1[\s\S]{0,120}?padStart\(\s*2/;
/** `toISOString().slice(0, 7)` — the inline fifth form in provision.ts. */
const ISO_MONTH_SLICE = /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*7\s*\)/;
/**
 * A METERING PERIOD HAS NO DAY. This is the discriminator, and it was learned by getting it wrong: the first
 * detector matched the *ingredient* (`getUTCMonth() + 1` then a pad) and flagged `edi/src/writer.ts` and
 * `gl/iif.ts`, which format a full YYYYMMDD / MM-DD-YYYY date and use exactly that ingredient on the way to a
 * DAY. Matching an ingredient finds every recipe that contains it; the violation is the *absence* of a day
 * beside a month build. So a hit is discounted when `getUTCDate` appears in the same window — that is a date
 * formatter, a different thing that happens to share two lines. (§1244: a filter fixes mechanical noise, never
 * meaning; the fix is a sharper subject, not an allowlist.)
 */
const HAS_DAY = /getUTCDate\(\)/;
const WINDOW = 6; // lines either side of the month build

function productionFiles(root: string): string[] {
  return execSync('git ls-files "workers" "packages" "apps"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
}

describe("§1547 REQ-124: the metering period is built in exactly one place", () => {
  const root = repoRoot();
  const files = productionFiles(root);

  it("derives a real corpus (non-vacuity — an empty scan certifies every worker)", () => {
    // Floor the INPUT, never the finding (§1148). A broken `git ls-files` must not read as "no offenders".
    expect(files.length, "the production scan found almost nothing — the extractor broke, not the tree").toBeGreaterThan(150);
    expect(files, "the home file must be IN the corpus, or its exemption proves nothing").toContain(HOME);
  });

  it("no production file outside contracts builds a YYYY-MM metering period", () => {
    const offenders = files
      .filter((f) => f !== HOME)
      .filter((f) => {
        const t = readFileSync(`${root}/${f}`, "utf8");
        if (ISO_MONTH_SLICE.test(t)) return true; // a 7-char ISO slice IS a period, unambiguously
        const lines = t.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (!/getUTCMonth\(\)\s*\+\s*1/.test(lines[i] as string)) continue;
          const win = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
          if (UTC_MONTH_BUILD.test(win) && !HAS_DAY.test(win)) return true;
        }
        return false;
      });
    expect(
      offenders,
      "a production file builds the metering period itself instead of calling `billingPeriodOf` from " +
        "@shuddl/contracts. `usage_credits` is keyed `<slug>:<period>`; two builders that disagree by one " +
        "character split a tenant's meter across two rows for the same month, on the table Stripe reconciles " +
        "against. Four byte-identical copies existed at §1547, three of them documenting that they 'mirror' the " +
        "others — which is what a drift hazard looks like BEFORE it drifts. Call the builder:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the home actually exports the builder, and the wrappers delegate rather than reimplement", () => {
    const home = readFileSync(`${root}/${HOME}`, "utf8");
    expect(home, "the single source no longer exports billingPeriodOf").toMatch(/export function billingPeriodOf\(/);
    // The three worker wrappers are kept (tests and callers import them by their local names) but each must be
    // a DELEGATION. A wrapper that grew a body again is the exact regression this section closed.
    for (const [file, fn] of [
      ["workers/billing/src/metering.ts", "periodOf"],
      ["workers/mcp/src/caps.ts", "currentPeriod"],
      ["workers/agents/src/spark-caps.ts", "currentPeriod"],
    ] as const) {
      const body = new RegExp(`export function ${fn}\\([^)]*\\): string \\{([\\s\\S]{0,160}?)\\n\\}`).exec(readFileSync(`${root}/${file}`, "utf8"));
      expect(body, `${file} no longer exports ${fn} — update this gate or the wrapper`).not.toBeNull();
      expect(
        body![1],
        `${file}@${fn} is no longer a one-line delegation to billingPeriodOf — it has grown a body again`,
      ).toMatch(/return billingPeriodOf\(/);
    }
  });

  it("the detector fires on both shapes it exists for (positive control)", () => {
    // Without this, a matcher that stopped recognising either form would certify the tree forever (§1387).
    expect(UTC_MONTH_BUILD.test('const m = String(d.getUTCMonth() + 1).padStart(2, "0");'), "the getUTC shape is unrecognised").toBe(true);
    expect(ISO_MONTH_SLICE.test("new Date(ts).toISOString().slice(0, 7)"), "the toISOString shape is unrecognised").toBe(true);
    expect(UTC_MONTH_BUILD.test("const d = new Date(ts); return d.getUTCFullYear();"), "the detector matches an innocent UTC read").toBe(false);
    // NEGATIVE control — the two real false positives that taught the discriminator. A full-date formatter
    // uses the same two lines on its way to a DAY and must never be read as a metering period.
    const fullDate = [
      'const mm = String(d.getUTCMonth() + 1).padStart(2, "0");',
      'const dd = String(d.getUTCDate()).padStart(2, "0");',
    ].join("\n");
    expect(UTC_MONTH_BUILD.test(fullDate), "the ingredient still matches — which is why HAS_DAY exists").toBe(true);
    expect(HAS_DAY.test(fullDate), "a date formatter must be discounted by the day check").toBe(true);
  });
});
