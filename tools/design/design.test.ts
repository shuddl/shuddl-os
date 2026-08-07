import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../checks/repo-root.js";
import { contrastRatio } from "./contrast.js";
import {
  auditTokens,
  readTokens,
  auditMotion,
  auditCaseAndDividers,
  auditColor,
  auditFont,
  auditGradient,
  auditRepo,
  scannedFiles,
} from "./audit.js";

const ALLOWED_HEX = new Set(Object.values(readTokens(`${repoRoot()}/packages/design/tokens.css`)));

describe("contrast math (WCAG 2.x)", () => {
  it("black on white = 21:1", () => expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0));
  it("identical colors = 1:1", () => expect(contrastRatio("#D5D1CC", "#D5D1CC")).toBeCloseTo(1, 5));
});

describe("REQ-149 / A1: --signal-deep locked at >=4.5:1 on --field", () => {
  it("small-text red passes AA on greige", () => {
    const t = readTokens("packages/design/tokens.css");
    const deep = t["--signal-deep"];
    const field = t["--field"];
    if (!deep || !field) throw new Error("tokens missing");
    expect(contrastRatio(deep, field)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("REQ-145: five color tokens only", () => {
  it("token audit finds exactly the sanctioned palette", () => {
    const result = auditTokens("packages/design/tokens.css");
    expect(result.colorTokens).toEqual(["--field", "--signal", "--signal-deep", "--ink-dark", "--progress"]);
  });
});

describe("REQ-148: motion law", () => {
  it("flags a spring/parallax/particle/shimmer/rotate keyword in css/tsx", () => {
    for (const bad of [
      "transition: transform 200ms cubic-bezier(.34,1.56,.64,1);", // spring overshoot
      "animation: shimmer 1s infinite;",
      "background-attachment: fixed; /* parallax */",
      "transform: rotate(4deg);",
    ]) expect(auditMotion("x.tsx", bad).length).toBeGreaterThan(0);
  });
  it("passes reveal/count-up/opacity motion", () => {
    expect(auditMotion("x.tsx", "transition: opacity 600ms cubic-bezier(.16,1,.3,1);")).toEqual([]);
  });
  it("flags a keyframes/transition file that never references prefers-reduced-motion", () => {
    expect(auditMotion("anim.css", "@keyframes reveal { to { opacity: 1 } }").some((v) => v.includes("reduced-motion"))).toBe(true);
  });
});

describe("REQ-147/146: dividers + case", () => {
  it("flags a border/divider thicker than 1px", () => {
    expect(auditCaseAndDividers("x.tsx", "border-bottom: 2px solid var(--signal);").some((v) => v.includes("1px"))).toBe(true);
  });
  it("flags text-transform other than uppercase on a display/mono element", () => {
    expect(auditCaseAndDividers("x.tsx", "text-transform: capitalize;").some((v) => v.includes("uppercase"))).toBe(true);
  });
});

describe("REQ-147: shadow + radius audits cover JSX camelCase inline styles", () => {
  it("flags a camelCase boxShadow drop shadow (the real bypass)", () => {
    expect(auditCaseAndDividers("x.tsx", `boxShadow: "0 2px 4px #123456"`).some((v) => /shadow/i.test(v))).toBe(true);
  });
  it("passes boxShadow: none", () => {
    expect(auditCaseAndDividers("x.tsx", `boxShadow: "none"`)).toEqual([]);
  });
  it("flags a bare-number borderRadius > 4 (px implied)", () => {
    expect(auditCaseAndDividers("x.tsx", `borderRadius: 12`).some((v) => v.includes("4px"))).toBe(true);
  });
  it("flags a string borderRadius > 4 and parses the max of a shorthand", () => {
    expect(auditCaseAndDividers("x.tsx", `borderRadius: "8px"`).some((v) => v.includes("4px"))).toBe(true);
    expect(auditCaseAndDividers("x.tsx", `borderRadius: "8px 8px 0 0"`).some((v) => v.includes("4px"))).toBe(true);
  });
  it("passes compliant radii (0, 2, 4, '4px')", () => {
    for (const ok of [`borderRadius: 0`, `borderRadius: 2`, `borderRadius: 4`, `borderRadius: "4px"`]) {
      expect(auditCaseAndDividers("x.tsx", ok)).toEqual([]);
    }
  });
  it("a JSX inline-style object with a shadow AND a 12px radius is fully flagged", () => {
    const jsx = `<div style={{ boxShadow: "0 2px 4px #123456", borderRadius: 12 }} />`;
    const out = auditCaseAndDividers("Card.tsx", jsx);
    expect(out.some((v) => /shadow/i.test(v))).toBe(true);
    expect(out.some((v) => v.includes("4px"))).toBe(true);
  });
});

describe("REQ-148: motion audit covers JSX camelCase inline styles", () => {
  it("flags camelCase backgroundAttachment: fixed", () => {
    expect(auditMotion("x.tsx", `backgroundAttachment: "fixed"`).length).toBeGreaterThan(0);
  });
  it("still covers rotate + spring written as JSX string values", () => {
    expect(auditMotion("x.tsx", `transform: "rotate(4deg)"`).length).toBeGreaterThan(0);
    expect(auditMotion("x.tsx", `transition: "transform 200ms cubic-bezier(.34,1.56,.64,1)"`).length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WP-03 exit-audit hardening. A gate is defined by WHAT IT REJECTS: each hole gets a red-path
// test proving the bypass is now caught, and a positive control proving compliant style passes.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("C1/REQ-145: rgb()/hsl()/named colors were completely invisible — now seen", () => {
  it("RED→GREEN: flags rgb(), non-sanctioned rgba(), hsl(), hsla()", () => {
    for (const bad of [
      `color: "rgb(0,0,255)"`,
      `color: "rgba(1,2,3,0.5)"`,
      `color: "hsl(240,100%,50%)"`,
      `color: "hsla(240,100%,50%,0.3)"`,
    ]) expect(auditColor("x.tsx", bad, ALLOWED_HEX).length).toBeGreaterThan(0);
  });
  it("RED→GREEN: flags CSS named colors in a color property", () => {
    for (const bad of [
      `color: "blue"`,
      `background: navy`,
      `color: "rebeccapurple"`,
      `fill: "teal"`,
      `background: "black"`,
      `borderColor: "white"`,
    ]) expect(auditColor("x.tsx", bad, ALLOWED_HEX).length).toBeGreaterThan(0);
  });
  it("ALLOWS the two sanctioned transparents rgba(255,74,51,*) and rgba(26,26,26,*)", () => {
    for (const ok of [
      `color: "rgba(255,74,51,0.55)"`,
      `background: "rgba(255, 74, 51, 0.12)"`,
      `background: "rgba(26,26,26,0.9)"`,
    ]) expect(auditColor("x.tsx", ok, ALLOWED_HEX)).toEqual([]);
  });
  it("ALLOWS var(--token), transparent, currentColor, none, inherit", () => {
    for (const ok of [
      `color: "var(--signal)"`,
      `background: "transparent"`,
      `color: "currentColor"`,
      `background: "none"`,
      `color: "inherit"`,
    ]) expect(auditColor("x.tsx", ok, ALLOWED_HEX)).toEqual([]);
  });
  it("does NOT flag color words in comments, `hexToRgb(`, `.fill(0)`, or a map filter (scoped to values)", () => {
    for (const ok of [
      `/* coral red — teal is progress-only, never gray */`,
      `const [r, g, b] = hexToRgb(TOKENS.signal);`,
      `const base = new Array<number>(n).fill(0);`,
      `filter: ["has", "point_count"],`,
    ]) expect(auditColor("x.ts", ok, ALLOWED_HEX)).toEqual([]);
  });
});

describe("C3/REQ-145: non-6-digit hex (#f00 / #f00a / #11223380) no longer bypasses", () => {
  it("RED→GREEN: flags 3-, 4-, and 8-digit non-token hex", () => {
    for (const bad of [`color: "#f00"`, `color: "#f00a"`, `color: "#11223380"`]) {
      expect(auditColor("x.tsx", bad, ALLOWED_HEX).some((v) => v.includes("outside the five tokens"))).toBe(true);
    }
  });
  it("normalizes 3→6 and strips 8→6, so a token written short or with alpha still PASSES", () => {
    expect(auditColor("x.tsx", `color: "#D5D1CCFF"`, ALLOWED_HEX)).toEqual([]); // --field + opaque alpha
    expect(auditColor("x.tsx", `color: "#1A1A1A80"`, ALLOWED_HEX)).toEqual([]); // --ink-dark + alpha
  });
  it("ALLOWS the six-digit token hexes", () => {
    for (const ok of [`color: "#FF4A33"`, `background: "#1A1A1A"`, `fill: "#00C4B4"`]) {
      expect(auditColor("x.tsx", ok, ALLOWED_HEX)).toEqual([]);
    }
  });
});

describe("C2/M5/REQ-146: camelCase fontFamily + whitelist-escape are caught", () => {
  it("RED→GREEN (C2): flags a camelCase fontFamily with a foreign stack — incl. nested quotes", () => {
    expect(auditFont("x.tsx", `fontFamily: "Papyrus, fantasy"`).length).toBeGreaterThan(0);
    expect(auditFont("x.tsx", `fontFamily: "'Comic Sans MS', sans-serif"`).length).toBeGreaterThan(0);
  });
  it("RED→GREEN (M5): a foreign family that merely ENDS in a generic is still rejected", () => {
    for (const bad of [
      `font-family: 'Comic Sans MS', sans-serif;`,
      `fontFamily: "Papyrus, monospace"`,
      `font-family: Arial, sans-serif;`,
    ]) expect(auditFont("x.tsx", bad).length).toBeGreaterThan(0);
  });
  it("ALLOWS the two sanctioned stacks and var(--display|--mono), kebab or camel", () => {
    for (const ok of [
      `fontFamily: "var(--display)"`,
      `fontFamily: "var(--mono)"`,
      `font-family: var(--display);`,
      `font-family: 'Barlow Condensed', 'Oswald', sans-serif;`,
      `fontFamily: "'JetBrains Mono', 'IBM Plex Mono', monospace"`,
    ]) expect(auditFont("x.tsx", ok)).toEqual([]);
  });
});

describe("C4/REQ-145: the glob reaches .ts / .jsx / .mjs / .html, not only .css/.tsx", () => {
  it("RED→GREEN: scanned set now includes real .ts modules and index.html screens style from", () => {
    const files = scannedFiles();
    expect(files).toContain("apps/command/index.html");
    expect(files.some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))).toBe(true);
    expect(files).toContain("packages/design/src/tokens.ts");
    // still covers the original set
    expect(files.some((f) => f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(".css"))).toBe(true);
  });
});

describe("M1/REQ-147: shadows beyond boxShadow — drop-shadow, textShadow, text-shadow, kebab box-shadow", () => {
  it("RED→GREEN: flags filter drop-shadow, textShadow, text-shadow, and kebab box-shadow", () => {
    for (const bad of [
      `filter: "drop-shadow(0 2px 4px #000)"`,
      `filter: drop-shadow(0 2px 4px black);`,
      `textShadow: "0 1px 2px #000"`,
      `text-shadow: 0 1px 2px rgba(0,0,0,.4);`,
      `box-shadow: 0 2px 4px #000;`,
    ]) expect(auditCaseAndDividers("x.tsx", bad).some((v) => /shadow/i.test(v))).toBe(true);
  });
  it("passes textShadow: none and box-shadow: none", () => {
    expect(auditCaseAndDividers("x.tsx", `textShadow: "none"`)).toEqual([]);
    expect(auditCaseAndDividers("x.css", `box-shadow: none;`)).toEqual([]);
  });
});

describe("M2/REQ-147: radius on EVERY corner, camel + kebab", () => {
  it("RED→GREEN: flags per-corner camelCase radii > 4", () => {
    for (const bad of [
      `borderTopLeftRadius: 12`,
      `borderBottomRightRadius: 8`,
      `borderTopRightRadius: "10px"`,
      `borderBottomLeftRadius: 6`,
    ]) expect(auditCaseAndDividers("x.tsx", bad).some((v) => v.includes("4px"))).toBe(true);
  });
  it("RED→GREEN: flags per-corner kebab radii > 4", () => {
    for (const bad of [`border-top-left-radius: 12px;`, `border-bottom-right-radius: 8px;`]) {
      expect(auditCaseAndDividers("x.css", bad).some((v) => v.includes("4px"))).toBe(true);
    }
  });
  it("passes a compliant per-corner radius (<=4)", () => {
    for (const ok of [`borderTopLeftRadius: 4`, `border-bottom-right-radius: 2px;`, `borderTopLeftRadius: "4px"`]) {
      expect(auditCaseAndDividers("x.tsx", ok)).toEqual([]);
    }
  });
});

describe("M3/REQ-145: gradient audit includes conic-gradient", () => {
  it("RED→GREEN: flags linear/radial/conic and repeating- gradients", () => {
    for (const bad of [
      `background: linear-gradient(#000, #fff)`,
      `background: radial-gradient(circle, #000, #fff)`,
      `background: conic-gradient(from 0deg, #000, #fff)`,
      `background: repeating-linear-gradient(45deg, #000, #fff 10px)`,
    ]) expect(auditGradient("x.tsx", bad).length).toBeGreaterThan(0);
  });
  it("does not flag the bare word 'gradient' in a comment", () => {
    expect(auditGradient("x.tsx", `// no shadows/gradients/teal here`)).toEqual([]);
  });
});

describe("M4/REQ-148: decorative scale(>1) and bob/float infinite keyframes", () => {
  it("RED→GREEN: flags a static transform: scale(>1) outside :hover (camel string + raw CSS)", () => {
    expect(auditMotion("x.tsx", `transform: "scale(1.5)"`).some((v) => /scale/i.test(v))).toBe(true);
    expect(auditMotion("x.css", `.logo { transform: scale(2); }`).some((v) => /scale/i.test(v))).toBe(true);
  });
  it("RED→GREEN: flags a guarded infinite @keyframes that tweens transform (bob/float loop)", () => {
    const css = `@keyframes bob { 0%{transform:translateY(0)} 50%{transform:translateY(-8px)} 100%{transform:translateY(0)} }
      .m { animation: bob 2s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce){ .m{animation:none} }`;
    expect(auditMotion("bob.css", css).some((v) => /infinite|bob|loop/i.test(v))).toBe(true);
  });
  it("does NOT flag the ONE sanctioned entrance — shuddl-reveal runs once (no `infinite`)", () => {
    const css = readFileSync("packages/design/motion.css", "utf8");
    expect(auditMotion("packages/design/motion.css", css)).toEqual([]);
  });
  it("passes scale(1) (identity) — only >1 is decorative growth", () => {
    expect(auditMotion("x.tsx", `transform: "scale(1)"`)).toEqual([]);
  });
});

describe("M6/REQ-146: rendered-case is guaranteed by the primitives, not parsed by the audit", () => {
  // The CSS audit cannot see rendered DOM case; it only rejects bad text-transform VALUES. The
  // uppercase GUARANTEE lives in the Display/Mono primitives (+ the WP-06 screenshot diff). This
  // locks that primitive guarantee so it can't silently regress.
  const src = readFileSync("packages/design/src/primitives.tsx", "utf8");
  it("Display sets textTransform: uppercase", () => {
    expect(/export function Display[\s\S]*?textTransform:\s*"uppercase"/.test(src)).toBe(true);
  });
  it("Mono sets textTransform: uppercase", () => {
    expect(/export function Mono[\s\S]*?textTransform:\s*"uppercase"/.test(src)).toBe(true);
  });
});

describe("Hardened audit must not over-reach: clean on the real repo", () => {
  it("auditRepo() returns zero violations against the shipped tokens/primitives/screens", () => {
    expect(auditRepo()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WP-16 exit-audit reconciliation (REQ-119). Two design-CI blind spots from the 2026-07-15 audit.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("H-3/REQ-206: the runtime basemap style JSON is inside the design scan", () => {
  it("RED→GREEN: scannedFiles() now includes the runtime greige-style.json", () => {
    // The shipped basemap (style.ts imports it) carries RAW paint colors; it must be scanned or an
    // operator could set fill-color:#3388FF (blue water) with zero CI signal even once blocking.
    expect(scannedFiles()).toContain("packages/map/greige-style.json");
  });
  it("a seeded raw (non-token) color in a JSON style layer is caught by the color audit", () => {
    const badLayer = `{ "id": "water", "type": "fill", "paint": { "fill-color": "#3388FF" } }`;
    expect(auditColor("greige-style.json", badLayer, ALLOWED_HEX).some((v) => v.includes("#3388FF"))).toBe(true);
  });
  it("the REAL greige-style.json is token-clean (only the three basemap tokens + the signal transparent)", () => {
    const text = readFileSync("packages/map/greige-style.json", "utf8");
    expect(auditColor("packages/map/greige-style.json", text, ALLOWED_HEX)).toEqual([]);
  });
});

describe("H-4/REQ-207: the 5-color-token hard budget is enforced BY COUNT, not only a hardcoded test", () => {
  const write6 = (): string => {
    const p = join(tmpdir(), `tokens-6-${Date.now()}-${Math.random().toString(36).slice(2)}.css`);
    writeFileSync(
      p,
      ":root{--field:#D5D1CC;--signal:#FF4A33;--signal-deep:#A52F18;--ink-dark:#1A1A1A;--progress:#00C4B4;--brand:#0000FF;}",
    );
    return p;
  };
  const write4 = (): string => {
    const p = join(tmpdir(), `tokens-4-${Date.now()}-${Math.random().toString(36).slice(2)}.css`);
    writeFileSync(p, ":root{--field:#D5D1CC;--signal:#FF4A33;--signal-deep:#A52F18;--ink-dark:#1A1A1A;}");
    return p;
  };
  it("RED→GREEN: a 6th color token fails the audit by count", () => {
    const res = auditTokens(write6());
    expect(res.colorTokens.length).toBe(6);
    expect(res.violations.some((v) => /color token/i.test(v) && v.includes("5"))).toBe(true);
  });
  it("RED→GREEN: a DROPPED token (4) also fails by count", () => {
    const res = auditTokens(write4());
    expect(res.violations.some((v) => /color token/i.test(v) && v.includes("5"))).toBe(true);
  });
  it("the real tokens.css (exactly 5) raises NO count violation", () => {
    const res = auditTokens("packages/design/tokens.css");
    expect(res.colorTokens).toHaveLength(5);
    expect(res.violations.some((v) => /color token/i.test(v))).toBe(false);
  });
});

// THE FONT BUDGET, which had no pin here while the color budget did (audit §287). CLAUDE.md budgets "5
// color tokens · 2 font families"; only the first was counted, and auditRepo() deliberately exempts the
// token SOURCE from font checks — so the one file where a third family may legitimately be authored was the
// one file where nothing counted them. Measured before the fix: a 6th color token RED, a third font GREEN.
describe("REQ-146: the 2-font-family budget is enforced in the token source", () => {
  const tmp = (css: string): string => {
    const p = join(tmpdir(), `tokens-font-${Date.now()}-${Math.random().toString(36).slice(2)}.css`);
    writeFileSync(p, css);
    return p;
  };
  const REAL = readFileSync("packages/design/tokens.css", "utf8");
  const fontViolations = (css: string): string[] => auditTokens(tmp(css)).violations.filter((v) => v.includes("REQ-146"));

  it("the real tokens.css declares exactly --display and --mono, and raises nothing", () => {
    const res = auditTokens("packages/design/tokens.css");
    expect(res.fontTokens).toEqual(["--display", "--mono"]);
    expect(res.violations.filter((v) => v.includes("REQ-146"))).toEqual([]);
  });

  it("RED: a THIRD font token fails, generic fallback or not", () => {
    expect(fontViolations(REAL.replace(":root {", ':root {\n  --script: "Papyrus", cursive;'))).not.toHaveLength(0);
    // No generic family at all — the case a `sans-serif|monospace` regex would miss, which is why the
    // detector classifies by VALUE (not-a-color) rather than by font syntax.
    expect(fontViolations(REAL.replace(":root {", ':root {\n  --script: "Papyrus";'))).not.toHaveLength(0);
  });

  it("RED: ANY extra non-color token fails — the budget is the whole non-color vocabulary", () => {
    expect(fontViolations(REAL.replace(":root {", ":root {\n  --space-4: 4px;"))).not.toHaveLength(0);
  });

  it("RED: renaming a font token fails (the two names are the budget, not the count alone)", () => {
    expect(fontViolations(REAL.replace("--display:", "--headline:"))).not.toHaveLength(0);
  });

  it("RED: a sanctioned NAME carrying an unsanctioned STACK fails", () => {
    const bad = REAL.replace(/--mono:[^;]+;/, '--mono: "Comic Sans MS", monospace;');
    expect(fontViolations(bad).some((v) => v.includes("not one of the two sanctioned stacks"))).toBe(true);
  });

  it("NEGATIVE CONTROL: a further --signal alpha variant is NOT a font violation", () => {
    // Proves the rule is not merely always-red, and does not over-reach onto legitimate color work: the
    // three rgba alphas already in the file are instances of ONE sanctioned transparent, not new families.
    expect(fontViolations(REAL.replace(":root {", ":root {\n  --signal-99: rgba(255, 74, 51, 0.99);"))).toEqual([]);
  });
});

// REQ-118/145–148 §554 — THE DESIGN AUDIT CANNOT CERTIFY AN EMPTY CORPUS.
//
// Every check in `auditRepo()` is a per-file scan, so zero files produces zero violations and prints
// "design audit: clean". That matters more here than in the three gates §487 caught with the same shape:
// this gate is BLOCKING (CLAUDE.md rule 7) and it is the ONLY enforcer of the pixel budgets — 5 color
// tokens, 2 font families, 0 shadows/gradients/radius>4px. MEASURED, not reasoned: neutralising the globs
// with the floor removed printed `design audit: clean` and exited 0 over a corpus of zero files.
//
// It was also CWD-dependent in five places (the corpus scan, the token read, the config read, the per-file
// reads, and the report WRITE). Off-root it happened to crash on the config read — protection by accident,
// which §489 rejects: a graceful default for a missing config would have converted the crash into a clean.
describe("REQ-118 §554: the design audit reads a real corpus, from any directory", () => {
  it("the live corpus is hundreds of files, not a handful", () => {
    const files = scannedFiles();
    expect(files.length, "the design corpus collapsed — fix the scan, do not lower the floor").toBeGreaterThan(50);
    // Both surfaces must be present: a glob that silently drops one half still clears a bare count.
    expect(files.some((f) => f.startsWith("apps/")), "no apps/ files scanned").toBe(true);
    expect(files.some((f) => f.startsWith("packages/")), "no packages/ files scanned").toBe(true);
  });

  it("runs identically from a subdirectory (every path root-anchored)", () => {
    const root = repoRoot();
    // The gate runs from the repo root in CI, so a cwd bug is invisible there and shows up the first time
    // someone runs it from a package. Spawning it is the only check that covers ALL five paths at once.
    const out = execFileSync(
      "node",
      ["--import", "tsx", `${root}/tools/design/audit.ts`],
      { cwd: `${root}/tools/checks`, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out, "off-root run must produce the same verdict as the root run").toContain("design audit: clean");
  });
});
