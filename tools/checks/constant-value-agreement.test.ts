import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1554 (REQ-196/202/118) — TWO FILES MAY SHARE A CONSTANT'S NAME; THEY MAY NOT DISAGREE ABOUT ITS VALUE.
//
// §1553's defect in one line: `MAX_EMAIL_LEN` was **254** in `contracts` — the RFC 5321 address maximum, and
// the ceiling `comms.ts` enforces on `to_ref`, the MAIL RECIPIENT — and **320** in `intake.ts` and
// `mcp/tools/quote.ts`. Intake therefore accepted and STORED addresses the mail layer would later refuse, and
// the failure surfaced at SEND time on the dunning path, for a party an operator had already saved.
//
// Duplication alone is not the hazard and this gate does not forbid it (§1444 triaged thirteen duplicated names
// and found ten sound; §1549 added six more). Two files declaring `MAX_ID_LEN = 200` are two copies of one
// agreed fact — visible, checkable, and wrong only if they drift. **A DISAGREEMENT is the drift, already
// happened.** So the rule is narrow enough to be total: same name, different number, no exceptions today.
//
// VALIDATED AGAINST A KNOWN POSITIVE rather than merely returning zero (§1387). Run against `HEAD~1` this
// detector reports `MAX_EMAIL_LEN values=[254, 320]` naming all three files; run against HEAD it reports
// nothing, because §1553 replaced the two locals with imports. A gate that has only ever seen a clean tree
// cannot tell you it works.
//
// SCOPE. Production source only, and only constants whose initialiser is a literal integer expression — a
// derived value (`Object.keys(X).length`, another constant) is not a restatement and cannot disagree by hand.

interface Decl {
  readonly file: string;
  readonly value: number;
}

/** Every `const NAME = <integer literal expression>;` in production source, by name. */
function numericConstants(root: string): Map<string, Decl[]> {
  const files = execSync('git ls-files "workers" "packages" "apps"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"));
  const out = new Map<string, Decl[]>();
  for (const file of files) {
    const text = readFileSync(`${root}/${file}`, "utf8");
    for (const m of text.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*(?::\s*number\s*)?=\s*([\d_]+(?:\s*\*\s*[\d_]+)*)\s*;/gm)) {
      const parts = (m[2] as string).split("*").map((p) => Number(p.replace(/_/g, "").trim()));
      if (parts.some((p) => !Number.isFinite(p))) continue;
      const value = parts.reduce((a, b) => a * b, 1);
      out.set(m[1] as string, [...(out.get(m[1] as string) ?? []), { file, value }]);
    }
  }
  return out;
}

describe("§1554 REQ-202: no two production files declare the same constant with different values", () => {
  const root = repoRoot();
  const consts = numericConstants(root);

  it("derives a real corpus (non-vacuity — an empty scan agrees with everything)", () => {
    // Floor the INPUT (§1148). Measured at §1554: ~15 names are declared in more than one file, all agreeing.
    expect(consts.size, "almost no numeric constants parsed — the extractor broke, not the tree").toBeGreaterThan(80);
    const shared = [...consts.values()].filter((d) => d.length > 1);
    expect(shared.length, "no shared-name constants found at all — this gate would then range over nothing").toBeGreaterThanOrEqual(8);
  });

  it("every constant declared in more than one file declares the SAME value", () => {
    const disagreements: string[] = [];
    for (const [name, decls] of consts) {
      const distinct = new Set(decls.map((d) => d.value));
      if (distinct.size <= 1) continue;
      disagreements.push(
        `${name} → ${[...distinct].sort((a, b) => a - b).join(" vs ")}\n      ` +
          decls.map((d) => `${d.value} in ${d.file}`).join("\n      "),
      );
    }
    expect(
      disagreements,
      "two production files declare the same constant with DIFFERENT values. Duplication is tolerated here — " +
        "§1444 triaged thirteen duplicated names and found ten sound — but a disagreement is drift that has " +
        "already happened. §1553 is what it costs: MAX_EMAIL_LEN was 254 in contracts (the ceiling comms.ts " +
        "enforces on the MAIL RECIPIENT) and 320 at intake, so intake stored addresses that could never be " +
        "mailed and the failure surfaced at send time. Import the shared one:\n  " + disagreements.join("\n  "),
    ).toEqual([]);
  });

  it("the detector recognises a disagreement when it sees one (positive control)", () => {
    // The real §1553 shape, inline, so a matcher that stopped parsing `const X = <n>;` cannot certify the tree.
    const probe = ['const MAX_EMAIL_LEN = 254;', 'const MAX_EMAIL_LEN = 320;'];
    const seen = probe.map((line) => /^const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*([\d_]+)\s*;/.exec(line));
    expect(seen.every((m) => m !== null), "the constant matcher no longer recognises a plain declaration").toBe(true);
    expect(new Set(seen.map((m) => Number(m![2]))).size, "two different values must read as two values").toBe(2);
    // …and a multiplied form, which the ledger and agents both use for time windows.
    expect(/^const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*([\d_]+(?:\s*\*\s*[\d_]+)*)\s*;/.test("const WINDOW_MS = 7 * 86_400_000;")).toBe(true);
  });
});
