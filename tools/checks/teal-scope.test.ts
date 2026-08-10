import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §856 — REQ-078 IS A SCOPE CLAIM, AND ITS DoD NAMES A GATE THAT ENFORCES A SET.
//
// The row reads "Teal only as progress fills (route remaining/ETA)" with DoD `Color audit CI`. What the
// colour audit actually checks is `auditTokens`: that exactly FIVE colour tokens are defined. That is the
// token SET. It says nothing about WHERE `--progress` may appear — so teal as body text, as an icon, or as a
// status colour would pass the gate the register names.
//
// The rule was stated four times and enforced zero times (§856): `tokens.css` ("progress FILLS only … Never
// text, never icons, never states"), `ProgressLine.tsx` ("The ONE sanctioned teal moment"), `entities.ts`
// ("ONLY on the eta line"), and the register row itself. Four statements, no gate, is the §813 doc↔source
// shape — and unlike REQ-076 the requirement is currently SATISFIED, so this gate starts green and its whole
// job is to keep it that way.
//
// TWO HALVES, because a roster finds only what it lists (§672/§802):
//   · SCOPE  — every file naming teal must be on the roster below, with the reason it may. Discovery: the
//     scan enumerates `git ls-files`, so a NEW file using teal fails without anyone updating anything.
//   · SHAPE  — at each USE site, teal must be a FILL. This is the half that carries "never text, never
//     icons": `color: "var(--progress)"` is on a sanctioned file and would pass a scope-only gate.
//
// Detecting the VIOLATION, not the CLAIM (§845). A file may phrase its teal comment however it likes; the
// reference itself is what gets read.

/** Any mention of the teal token, by CSS custom property, by TS export, or by raw hex. */
const TEAL = /--progress|TOKENS\.progress|00C4B4/i;

/** A line that is wholly a comment — these NAME teal to explain the rule and must not be shape-checked. */
const COMMENT = /^\s*(\/\/|\/\*|\*|")/;

/**
 * Properties teal may be assigned to. A "fill" in the REQ-078 sense is the painted area of a progress mark:
 * a CSS `background` on a bar, or MapLibre's `line-color` on the eta line — which paints the line's own body,
 * not a border around it.
 */
const FILL_PROPERTY = /(\bbackground(Color)?\s*:|"(line|fill)-color"\s*:|\bfill\s*:)/;

/**
 * Every file permitted to name teal, and why. Split by KIND because the two kinds are checked differently:
 * a definition may name the token without painting anything; a use must paint a fill.
 */
const DEFINITIONS: Record<string, string> = {
  "packages/design/tokens.css": "defines --progress; carries the scope rule in its trailing comment.",
  "packages/design/src/tokens.ts": "re-exports the token to TS consumers.",
  "packages/map/greige-style.json":
    'a "//" comment key asserting teal is NOT in the basemap — it names the token to state an EXCLUSION.',
};

const SANCTIONED_USES: Record<string, string> = {
  "apps/driver/src/components/ProgressLine.tsx": "the route-remaining bar — REQ-078's named case.",
  "apps/driver/src/components/DaySheet.tsx": "the same bar, inline in the day sheet.",
  "packages/map/src/entities.ts": "the map's eta line — REQ-078's other named case (route remaining/ETA).",
};

/** Files that reference teal at all, discovered rather than listed. */
function tealFiles(root: string): { path: string; lines: { n: number; text: string }[] }[] {
  const paths = execSync('git ls-files "apps" "packages" "workers"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((p) => /\.(ts|tsx|css|json)$/.test(p) && !/\.(test|spec)\./.test(p));
  const out: { path: string; lines: { n: number; text: string }[] }[] = [];
  for (const path of paths) {
    const lines = readFileSync(`${root}/${path}`, "utf8")
      .split("\n")
      .map((text, i) => ({ n: i + 1, text }))
      .filter((l) => TEAL.test(l.text));
    if (lines.length > 0) out.push({ path, lines });
  }
  return out;
}

describe("§856: REQ-078 — teal only as progress fills", () => {
  const root = repoRoot();
  const found = tealFiles(root);

  it("the scan finds teal at all (non-vacuity — an empty scan satisfies every rule below)", () => {
    // §819's failure mode. A regex typo, a changed token name, or a narrowed glob would silently turn this
    // whole file into a no-op that reports success. Floor is well under the 6 files measured at §856.
    expect(found.length, "no file references --progress — the scan is broken, not the repo").toBeGreaterThanOrEqual(4);
  });

  it("no file names teal without a reason (SCOPE — discovery, not a roster read)", () => {
    const unaccounted = found
      .map((f) => f.path)
      .filter((p) => !(p in DEFINITIONS) && !(p in SANCTIONED_USES));
    expect(
      unaccounted,
      "a file uses teal and is on neither roster. REQ-078 confines teal to progress fills (route " +
        "remaining/ETA) and `tokens.css` spells out the rest: \"Never text, never icons, never states.\" " +
        "If this is a genuine progress fill — a count-up ring or an upload bar, both named as permitted — " +
        "add it to SANCTIONED_USES with its reason. Otherwise use --signal or --ink-dark:\n  " +
        unaccounted.join("\n  "),
    ).toEqual([]);
  });

  it("every teal USE is a fill, never text or an icon (SHAPE — the half scope cannot see)", () => {
    const misshapen: string[] = [];
    for (const f of found.filter((f) => f.path in SANCTIONED_USES)) {
      for (const line of f.lines) {
        if (COMMENT.test(line.text)) continue; // the comments state the rule; they do not paint
        if (!FILL_PROPERTY.test(line.text)) misshapen.push(`${f.path}:${line.n}  ${line.text.trim()}`);
      }
    }
    expect(
      misshapen,
      "teal appears on a sanctioned file but NOT as a fill. This is the assignment REQ-078 forbids — " +
        "`color:`, a border, an icon stroke, or a state colour. Teal is the one saturated extra in a " +
        "greige/coral palette; spending it on anything but a progress fill is what the requirement exists " +
        "to prevent, and a scope-only gate would pass this:\n  " + misshapen.join("\n  "),
    ).toEqual([]);
  });

  it("no roster row outlives its subject (§672 — a stale allowance is a permission nobody audited)", () => {
    // Both rosters. A row for a deleted file, or for one that no longer uses teal, is an allowance that
    // survives its reason — and the next teal use in that path inherits a permission nobody granted it.
    const referencing = new Set(found.map((f) => f.path));
    for (const [path, why] of Object.entries({ ...DEFINITIONS, ...SANCTIONED_USES })) {
      expect(
        referencing.has(path),
        `${path} is rostered as a teal site but no longer references teal — delete the row ("${why.slice(0, 56)}…")`,
      ).toBe(true);
    }
  });
});
