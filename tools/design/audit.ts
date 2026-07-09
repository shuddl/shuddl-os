import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { contrastRatio } from "./contrast.js";

// Squint-test CI, operationalized (doc 07 §06): color / contrast / radius / shadow /
// gradient / font audits. Screenshot diffing (audit #6) lands at WP-03 with real screens.
// REQ-158: advisory (report-only) until WP-10 exits; blocking thereafter (mode file).
type Mode = { mode: "advisory" | "blocking" };

export function readTokens(path: string): Record<string, string> {
  const css = readFileSync(path, "utf8");
  const tokens: Record<string, string> = {};
  for (const m of css.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) tokens[m[1] as string] = (m[2] as string).toUpperCase();
  return tokens;
}

export function auditTokens(path: string): { colorTokens: string[]; violations: string[] } {
  const tokens = readTokens(path);
  const violations: string[] = [];
  const colorTokens = Object.keys(tokens).filter((k) => k !== "--field-on-dark");
  const deep = tokens["--signal-deep"];
  const field = tokens["--field"];
  if (deep && field && contrastRatio(deep, field) < 4.5) {
    violations.push(`A1/REQ-149: --signal-deep ${deep} on --field ${field} = ${contrastRatio(deep, field).toFixed(2)}:1 < 4.5:1`);
  }
  return { colorTokens, violations };
}

// Repo-wide audits per doc 07 §06 — scans css/tsx under apps + packages (REQ-145/146/147).
export function auditRepo(): string[] {
  const violations: string[] = [];
  const files = execSync(`git ls-files "apps/**/*.css" "apps/**/*.tsx" "packages/**/*.css" "packages/**/*.tsx"`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const allowedHex = new Set(Object.values(readTokens("packages/design/tokens.css")));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (!f.endsWith("tokens.css")) {
      for (const m of text.matchAll(/#[0-9A-Fa-f]{6}\b/g)) {
        if (!allowedHex.has((m[0] as string).toUpperCase())) violations.push(`${f}: color ${m[0]} outside the five tokens`);
      }
    }
    for (const m of text.matchAll(/border-radius:\s*(\d+)px/g)) {
      if (Number(m[1]) > 4) violations.push(`${f}: border-radius ${m[1]}px > 4px`);
    }
    if (/box-shadow:(?!\s*none)/.test(text)) violations.push(`${f}: box-shadow`);
    if (/linear-gradient|radial-gradient/.test(text)) violations.push(`${f}: gradient`);
    if (/font-family:(?![^;]*(Barlow Condensed|Oswald|JetBrains Mono|IBM Plex Mono|monospace|sans-serif|var\(--))/.test(text)) {
      violations.push(`${f}: font outside the two stacks`);
    }
  }
  return violations;
}

function main(): void {
  const { mode } = JSON.parse(readFileSync("tools/design/design-ci.json", "utf8")) as Mode;
  const tokenResult = auditTokens("packages/design/tokens.css");
  const violations = [...tokenResult.violations, ...auditRepo()];
  writeFileSync("tools/design/report.json", JSON.stringify({ mode, violations }, null, 2));
  if (violations.length > 0) {
    console.error(`design audit: ${violations.length} violation(s) [mode=${mode}]`);
    for (const v of violations) console.error(`  ${v}`);
    if (mode === "blocking") process.exit(1);
    console.error("REQ-158: advisory until WP-10 exit — reported, not blocking.");
  } else {
    console.log("design audit: clean");
  }
}
if (process.argv[1]?.endsWith("audit.ts")) main();
