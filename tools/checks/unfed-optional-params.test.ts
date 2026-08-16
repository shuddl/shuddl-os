import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1679 (REQ-118/119) — AN OPTIONAL PARAMETER NOTHING SUPPLIES IS A QUESTION, NOT A FACT.
//
// §796 swept the SCHEMA-field form of parsed-but-unconsumed (203 Zod fields → exactly one live instance) and
// gated it. This is the PARAMETER form, a different declaration site, and it went unswept until §1678 found
// one the hard way: `detectAnomaly(input, caps?)` documented its second parameter as "the tenant-policy seam
// Task 10 feeds from config" while every production call site omitted it — so the default was the operative
// value for every tenant and the comment described a wiring that never existed.
//
// THE DISCRIMINATOR IS THE DECLARATION, not the call count. A parameter with a DEFAULT (`alias = "e"`,
// `cwd = repoRoot()`, `zone = "shuddl.tech"`) is legitimately unfed — the default IS the intended value, and
// every caller wanting it is the normal case. A bare `?:` with no default and no feeder is the shape: the
// author wrote an affordance, nothing took it, and the type still advertises it. Measured at §1679: 39
// exported functions declare an optional parameter, 5 are never supplied, and splitting on this rule leaves
// exactly the two real ones.
//
// FROZEN AT 2, both documented at their declarations:
//   · `detectAnomaly`  caps?  — kept deliberately (§1678): its validation is what makes a future feeder safe,
//                               and wiring a tenant cap needs a register amendment.
//   · `setEntityState` risk?  — a map reason-code with no producer AND no paint expression reading it (§1679).
//
// A THIRD is what this gate exists to stop: a new `?:` that nothing passes is either scope that was never
// wired or an affordance nobody wanted, and both deserve a sentence before they deserve a merge.

const FROZEN_UNFED = 2;

interface Sig {
  readonly name: string;
  readonly file: string;
  readonly required: number;
  readonly optionalNames: readonly string[];
}

/** PURE: top-level comma split honouring (), [], {}, <> and strings — a parameter list is not `split(",")`. */
export function splitArgs(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of src) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ("([{<".includes(ch)) depth += 1;
    // `>` closes a generic — EXCEPT in `=>`, where it is an arrow. Counting that one decremented depth past
    // zero and swallowed the following top-level comma, so a callback parameter merged with its neighbour
    // (caught by this file's own positive control before the gate ever ran).
    else if (")]}".includes(ch) || (ch === ">" && cur.at(-1) !== "=")) depth -= 1;
    if (ch === "," && depth === 0) {
      if (cur.trim().length > 0) parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim().length > 0) parts.push(cur.trim());
  return parts;
}

/** The substring inside the parens beginning at `open`, or null if unbalanced. */
function inParens(text: string, open: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** A parameter is BARE-OPTIONAL when its name carries `?` and it has no `=` default. */
function bareOptional(param: string): boolean {
  const head = param.split(":")[0] ?? "";
  return head.includes("?") && !param.includes("=");
}

function productionSources(root: string): string[] {
  return execSync('git ls-files "packages" "workers" "apps" "tools"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts") && !f.includes(".test.") && !f.includes("/test/"));
}

function unfedBareOptionals(root: string): string[] {
  const files = productionSources(root);
  const texts = new Map(files.map((f) => [f, readFileSync(`${root}/${f}`, "utf8")]));

  const sigs: Sig[] = [];
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/export (?:async )?function (\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const got = inParens(text, open);
      if (got === null) continue;
      const params = splitArgs(got.inner);
      const optional = params.filter((p) => bareOptional(p));
      if (optional.length === 0) continue;
      sigs.push({
        name: m[1] as string,
        file,
        required: params.length - params.filter((p) => bareOptional(p) || p.includes("=")).length,
        optionalNames: optional.map((p) => (p.split(":")[0] ?? p).trim()),
      });
    }
  }

  const out: string[] = [];
  for (const sig of sigs) {
    let sites = 0;
    let maxArgs = 0;
    for (const [, text] of texts) {
      for (const m of text.matchAll(new RegExp(`(?<![\\w.])${sig.name}\\s*\\(`, "g"))) {
        if (/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
        const got = inParens(text, m.index + m[0].length - 1);
        if (got === null) continue;
        sites += 1;
        maxArgs = Math.max(maxArgs, splitArgs(got.inner).length);
      }
    }
    // No call sites at all is a DIFFERENT finding (an unused export) that other gates own — not this one.
    if (sites > 0 && maxArgs <= sig.required) out.push(`${sig.file} ${sig.name}(… ${sig.optionalNames.join(", ")})`);
  }
  return out.sort();
}

describe("§1679 REQ-118: an optional parameter that nothing supplies is recorded, not accumulated", () => {
  const root = repoRoot();

  it("splits a parameter list at the TOP level only (positive control)", () => {
    // Without this, a naive `split(",")` would shred `Record<string, number>` into two parameters and the
    // required-count would be wrong for every generic signature — over-reporting, which reads as a finding.
    expect(splitArgs("a: string, b: Record<string, number>, c?: number")).toHaveLength(3);
    expect(splitArgs('x: (n: number, m: number) => void, y = ","')).toHaveLength(2);
    expect(bareOptional("caps?: { max_cents_per_lb?: number }")).toBe(true);
    expect(bareOptional('alias = "e"'), "a DEFAULT is legitimately unfed — the default is the value").toBe(false);
  });

  it("reads a real corpus (non-vacuity — an empty scan supplies nothing either)", () => {
    // LIVE at §1679: 221 production sources, 39 exported functions declaring an optional parameter.
    expect(productionSources(root).length, "almost no sources parsed — the glob broke, not the tree").toBeGreaterThan(150);
  });

  it("no NEW unfed bare-optional parameter is added", () => {
    const unfed = unfedBareOptionals(root);
    expect(
      unfed.length,
      `${unfed.length} exported functions declare a bare \`?:\` parameter that NO production call site ever ` +
        `supplies, frozen at ${FROZEN_UNFED} by §1679. Each is either scope that was never wired or an ` +
        "affordance nobody wanted, and the type advertises it either way — §1678's was documented as " +
        "config-fed while nothing fed it. Feed it, delete it, or document it at the declaration and raise " +
        "this number in the same commit. If you removed one, lower it — this may fall, never grow:\n  " +
        unfed.join("\n  "),
    ).toBeLessThanOrEqual(FROZEN_UNFED);
  });
});
