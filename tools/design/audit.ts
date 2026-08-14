import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { contrastRatio } from "./contrast.js";
import { bannedMotion } from "./motion.js";
import { repoRoot } from "../checks/repo-root.js";

// Squint-test CI, operationalized (doc 07 §06): color / contrast / radius / shadow /
// gradient / font / motion audits. Screenshot diffing (audit #6) lands at WP-03 with real
// screens. REQ-158: advisory (report-only) until WP-10 exits; blocking thereafter (mode file).
//
// A gate is DEFINED BY WHAT IT REJECTS. Every detector below has a red-path test in
// design.test.ts; the positive controls (a token hex, `var(--…)`, `rgba(255,74,51,.5)`, an
// allowed font stack, `borderRadius:4`) prove it does not over-reach onto compliant style.
type Mode = { mode: "advisory" | "blocking" };

export function readTokens(path: string): Record<string, string> {
  const css = readFileSync(path, "utf8");
  const tokens: Record<string, string> = {};
  for (const m of css.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) tokens[m[1] as string] = (m[2] as string).toUpperCase();
  return tokens;
}

// Every custom property in the token source whose VALUE is not a color. Classified by value rather than by
// font syntax on purpose: `--script: "Papyrus"` carries no generic family, so a regex keyed on
// `sans-serif|monospace|…` would miss precisely the token a person would hand-add. Colors are excluded in
// all the forms this file actually uses — hex AND the rgba() alpha variants of --signal.
//
// The first cut of this excluded only `#`, and the clean tree immediately went red on --signal-07/12/55.
// The cause was my own inventory: I had enumerated the vocabulary with `--[a-z-]+`, whose character class
// drops DIGITS, so three declarations never appeared in the list I designed against (audit §287).
const COLOR_VALUE = /^(?:#|rgba?\(|hsla?\(|color\()/i;
export function readNonColorTokens(path: string): Record<string, string> {
  const css = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) {
    const name = m[1] as string;
    const value = (m[2] as string).trim();
    if (!COLOR_VALUE.test(value)) out[name] = value;
  }
  return out;
}

export function auditTokens(path: string): { colorTokens: string[]; fontTokens: string[]; violations: string[] } {
  const tokens = readTokens(path);
  const violations: string[] = [];
  const colorTokens = Object.keys(tokens).filter((k) => k !== "--field-on-dark");
  // H-4 (REQ-207): the "5 color tokens" hard budget is enforced BY THE GATE here, by COUNT — a 6th
  // token (or a dropped one) fails the audit itself, not just a hardcoded `toEqual` in the test.
  if (colorTokens.length !== 5) {
    violations.push(`REQ-145/207: ${colorTokens.length} color token(s) defined — the hard budget is exactly 5 (${colorTokens.join(", ")})`);
  }
  // THE SIBLING PIN THE COLOR BUDGET HAD AND THIS ONE DID NOT (audit §287). CLAUDE.md budgets "5 color
  // tokens · 2 font families"; only the first was counted. MEASURED by mutation: a 6th color token in this
  // file goes RED, a THIRD FONT TOKEN went GREEN. The repo-wide font audit cannot cover it either, because
  // auditRepo() deliberately exempts the token SOURCE from color+font checks ("where the raw hexes and font
  // stacks legitimately live") — so the ONE place a third family may legitimately be authored was the one
  // place nothing counted them. An exemption is only as safe as the bound on its subject.
  const nonColor = readNonColorTokens(path);
  const fontTokens = Object.keys(nonColor).sort();
  if (fontTokens.join(",") !== "--display,--mono") {
    violations.push(
      `REQ-146: non-color token(s) [${fontTokens.join(", ") || "none"}] — the only non-color tokens are the 2 font ` +
        `families, --display and --mono. A third family is a register amendment, not a token.`,
    );
  }
  // …and the VALUES must be sanctioned stacks. Reuses ALLOWED_FONT/normFont so the two stacks live in
  // exactly one place — a second copy here is the defect this audit keeps finding elsewhere.
  for (const [name, value] of Object.entries(nonColor)) {
    if (!ALLOWED_FONT.has(normFont(value))) {
      violations.push(`REQ-146: ${name} = ${JSON.stringify(value)} — not one of the two sanctioned stacks`);
    }
  }
  const deep = tokens["--signal-deep"];
  const field = tokens["--field"];
  if (deep && field && contrastRatio(deep, field) < 4.5) {
    violations.push(`A1/REQ-149: --signal-deep ${deep} on --field ${field} = ${contrastRatio(deep, field).toFixed(2)}:1 < 4.5:1`);
  }
  return { colorTokens, fontTokens, violations };
}

// ── Color audit (REQ-145) — hex (any length), rgb()/rgba()/hsl()/hsla(), and CSS named colors.
// The only colors that may ship: the five token hexes, the two sanctioned transparents
// (rgba(255,74,51,*) signal + rgba(26,26,26,*) ink), `transparent`, `currentColor`, `inherit`,
// `none`, and `var(--*)`. Everything else is a raw color and a violation.

// The 148 CSS Color-Module-Level-4 named colors. `transparent` and `currentcolor` are NOT here
// — they are explicitly allowed. Any of these as a color-property VALUE is a violation.
const NAMED_COLORS = new Set<string>([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
  "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse",
  "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta",
  "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
  "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow",
  "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
  "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
  "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream",
  "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred",
  "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple",
  "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell",
  "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
  "whitesmoke", "yellow", "yellowgreen",
]);

// C3 — normalize a raw hex body (no `#`) to a 6-digit uppercase `#RRGGBB`, dropping any alpha.
// 3→6 (`f00`→`FF0000`), 4→6 (RGBA short, drop alpha), 6→6, 8→6 (drop alpha). 5/7 are invalid.
function normalizeHex(body: string): string | null {
  const s = body.toUpperCase();
  const dbl = (c: string): string => `${c}${c}`;
  if (s.length === 3 || s.length === 4) return `#${dbl(s[0] as string)}${dbl(s[1] as string)}${dbl(s[2] as string)}`;
  if (s.length === 6) return `#${s}`;
  if (s.length === 8) return `#${s.slice(0, 6)}`;
  return null;
}

// Only the two sanctioned transparents pass: rgba(255,74,51,*) and rgba(26,26,26,*). Any other
// rgb()/rgba()/hsl()/hsla() is raw color. (An alpha arg is required — `rgb(255,74,51)` is not it.)
function isSanctionedRgba(fn: string): boolean {
  const n = fn.replace(/\s+/g, "").toLowerCase();
  return /^rgba\(255,74,51,[^)]+\)$/.test(n) || /^rgba\(26,26,26,[^)]+\)$/.test(n);
}

// Color-bearing property declarations (camelCase JSX + kebab CSS), value captured. The scan is
// scoped to these so a stray "coral"/"teal" in a COMMENT, or an `Array.fill(0)` call, or a
// `filter: ["has", …]` map expression, is never mistaken for a named color.
function colorDecls(text: string): string[] {
  const re =
    /\b(?:background(?:-color|Color)?|backgroundImage|background-image|color|border(?:Top|Right|Bottom|Left)?(?:Color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color|Color)?|fill|stroke|caretColor|caret-color|columnRuleColor|column-rule-color|textDecorationColor|text-decoration-color|floodColor|flood-color|stopColor|stop-color|boxShadow|box-shadow|textShadow|text-shadow)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^;,{}\n]+))/gi;
  const vals: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) vals.push(m[1] ?? m[2] ?? m[3] ?? "");
  return vals;
}

export function auditColor(file: string, text: string, allowedHex: Set<string>): string[] {
  const v: string[] = [];
  // C3 — hex of any valid length, normalized to 6-digit RGB before the token comparison.
  for (const m of text.matchAll(/#([0-9A-Fa-f]{3,8})\b/g)) {
    const norm = normalizeHex(m[1] as string);
    if (norm && !allowedHex.has(norm)) v.push(`${file}: color ${m[0]} (→ ${norm}) outside the five tokens (REQ-145)`);
  }
  // C1 — functional colors. Case-SENSITIVE lowercase so `hexToRgb(` / `toRgb(` is never a hit.
  for (const m of text.matchAll(/\b(?:rgba?|hsla?)\([^)]*\)/g)) {
    if (!isSanctionedRgba(m[0])) v.push(`${file}: color ${m[0]} outside the five tokens — only rgba(255,74,51,*)/rgba(26,26,26,*) transparents pass (REQ-145)`);
  }
  // C1 — CSS named colors, scoped to color-property values (transparent/currentColor/none stay legal).
  for (const val of colorDecls(text)) {
    for (const tok of val.split(/[\s,()/]+/)) {
      if (tok && NAMED_COLORS.has(tok.toLowerCase())) v.push(`${file}: named color "${tok}" outside the five tokens — use var(--token) (REQ-145)`);
    }
  }
  return v;
}

// ── Font audit (REQ-146) — kebab `font-family:` + camelCase `fontFamily:`. The value must be
// one of the two sanctioned stacks EXACTLY, or `var(--display)`/`var(--mono)`. A value that
// merely ends in a generic (`'Comic Sans MS', sans-serif`) is rejected — naming any family
// outside the allowed set is the violation, generic fallback or not.
function normFont(v: string): string {
  return v.replace(/["']/g, "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).join(",");
}
const ALLOWED_FONT = new Set<string>([
  "barlow condensed,oswald,sans-serif",
  "barlow condensed,oswald,arial narrow,roboto condensed,sans-serif",
  "jetbrains mono,ibm plex mono,monospace",
  "jetbrains mono,ibm plex mono,ui-monospace,menlo,consolas,monospace",
]);
const VAR_FONT = /^var\(\s*--(?:display|mono)\s*\)$/i;

export function auditFont(file: string, text: string): string[] {
  const v: string[] = [];
  const check = (raw: string): void => {
    const val = raw.trim();
    if (!val) return;
    if (VAR_FONT.test(val)) return;
    if (ALLOWED_FONT.has(normFont(val))) return;
    v.push(`${file}: font-family ${JSON.stringify(val)} — not a sanctioned stack nor var(--display|--mono) (REQ-146)`);
  };
  for (const m of text.matchAll(/font-family\s*:\s*([^;{}]+?)\s*[;}]/gi)) check(m[1] ?? "");
  // camelCase value may be double-quoted with single-quoted family names inside (or vice-versa),
  // so match on the OUTER quote — `"([^"]*)"|'([^']*)'` — not a `["']…["']` that stops at the
  // first inner quote (which would silently read an empty family and pass).
  for (const m of text.matchAll(/fontFamily\s*:\s*(?:"([^"]*)"|'([^']*)')/gi)) check(m[1] ?? m[2] ?? "");
  return v;
}

// ── Gradient audit (REQ-145, M3) — surfaces are flat --field. linear/radial/conic (incl.
// repeating-) are all banned. The bare word "gradient" in a comment is not matched.
export function auditGradient(file: string, text: string): string[] {
  return /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i.test(text)
    ? [`${file}: gradient — every surface is flat --field (REQ-145)`]
    : [];
}

// Audit #5 — motion law (REQ-148). Flags springs/parallax/rotation/particles/shimmer/decorative
// scale/bob loops, and requires any file DEFINING `@keyframes` to carry its OWN `@media
// (prefers-reduced-motion: reduce)` rest state (A5). The guard is per-file: a keyframes file
// must self-document how it goes calm — the shared packages/design/motion.css does exactly that.
export function auditMotion(file: string, text: string): string[] {
  const violations: string[] = [];
  for (const reason of bannedMotion(text)) violations.push(`${file}: ${reason} (REQ-148)`);
  if (/@keyframes/i.test(text) && !/prefers-reduced-motion/i.test(text)) {
    violations.push(`${file}: @keyframes with no prefers-reduced-motion guard in the same file (REQ-148 reduced-motion)`);
  }
  return violations;
}

// Audit #6 — case + dividers + flat chrome (REQ-146/147). Rendered text is uppercased via CSS
// `text-transform` (A5 keeps the DOM normal-case for screen readers), so only uppercase/none/
// inherit are legal. Dividers are 1px --signal-12, so any border wider than 1px is chrome we do
// not ship. Zero shadows (box/text/drop) and radius ≤4px on every corner (camel + kebab).
//
// M6 — HONEST BOUNDARY: a static text-audit cannot see RENDERED DOM case (text-transform is
// applied at paint time, and the DOM string stays normal-case by design). So this audit enforces
// only "no forbidden text-transform value present"; it does NOT — and cannot — assert that a
// given string renders uppercase. That guarantee is carried by two other layers: the Display/Mono
// primitives, which hard-set `text-transform: uppercase` (locked by a test in design.test.ts so
// it can't regress), and the WP-06 blessed-screenshot diff. Parsing rendered case here would be
// theatre; we state the seam instead.
const ALLOWED_TRANSFORM = new Set(["uppercase", "none", "inherit"]);
export function auditCaseAndDividers(file: string, text: string): string[] {
  const violations: string[] = [];
  const flagBorder = (val: string): void => {
    const px = /(\d+(?:\.\d+)?)px/.exec(val);
    if (px && Number(px[1]) > 1) violations.push(`${file}: border ${px[1]}px > 1px — dividers are 1px --signal-12 (REQ-147)`);
  };
  const flagRadius = (nums: string): void => {
    let max = 0;
    for (const n of nums.matchAll(/\d+(?:\.\d+)?/g)) max = Math.max(max, Number(n[0]));
    if (max > 4) violations.push(`${file}: borderRadius ${max}px > 4px (REQ-147)`);
  };
  // Raw CSS: `border[-side]: <value>;` — value is unquoted and terminated by `;`
  // (border-radius is excluded — it's the radius audit's job, not a divider).
  for (const m of text.matchAll(
    /border(?:-(?:top|right|bottom|left|width|block|inline|block-start|block-end|inline-start|inline-end))?\s*:\s*([^;"'{}]*);/gi,
  )) {
    flagBorder(m[1] ?? "");
  }
  // CSS-in-JS: `border[Side]: "<value>"` — quoted; matches kebab or camelCase, so a `2px`
  // border in a JSX inline-style object is caught without gobbling neighbouring properties.
  for (const m of text.matchAll(/border(?:-?(?:top|right|bottom|left|width))?\s*:\s*["']([^"'{}]*)["']/gi)) {
    flagBorder(m[1] ?? "");
  }
  // M1 — shadows. box-shadow (kebab + camelCase boxShadow), text-shadow (kebab + textShadow),
  // and `filter: drop-shadow(…)` — all banned unless the value is exactly `none`.
  for (const m of text.matchAll(/box-shadow\s*:\s*([^;{}]*)[;}]/gi)) {
    if ((m[1] ?? "").trim().toLowerCase() !== "none") violations.push(`${file}: box-shadow — no shadows (REQ-147)`);
  }
  for (const m of text.matchAll(/boxShadow\s*:\s*["']([^"']*)["']/g)) {
    if ((m[1] ?? "").trim().toLowerCase() !== "none") violations.push(`${file}: boxShadow — no shadows (REQ-147)`);
  }
  for (const m of text.matchAll(/text-shadow\s*:\s*([^;{}]*)[;}]/gi)) {
    if ((m[1] ?? "").trim().toLowerCase() !== "none") violations.push(`${file}: text-shadow — no shadows (REQ-147)`);
  }
  for (const m of text.matchAll(/textShadow\s*:\s*["']([^"']*)["']/g)) {
    if ((m[1] ?? "").trim().toLowerCase() !== "none") violations.push(`${file}: textShadow — no shadows (REQ-147)`);
  }
  if (/\bdrop-shadow\s*\(/i.test(text)) violations.push(`${file}: filter: drop-shadow — no shadows (REQ-147)`);
  // M2 — radius on EVERY corner. CSS-in-JS `border[Corner]Radius: 12` (px implied) or
  // `borderRadius: "8px 8px 0 0"` (max of the shorthand); raw-CSS `border-[side-]radius: 12px`.
  for (const m of text.matchAll(/border[A-Za-z]*Radius\s*:\s*(?:(\d+(?:\.\d+)?)|["']([^"']*)["'])/g)) {
    flagRadius(m[1] ?? m[2] ?? "");
  }
  for (const m of text.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;{}]*)[;}]/gi)) {
    flagRadius(m[1] ?? "");
  }
  for (const m of text.matchAll(/text-transform\s*:\s*([a-z-]+)/gi)) {
    const val = (m[1] ?? "").toLowerCase();
    if (!ALLOWED_TRANSFORM.has(val)) violations.push(`${file}: text-transform: ${val} — must be uppercase/none/inherit (REQ-146 A5)`);
  }
  for (const m of text.matchAll(/textTransform\s*:\s*['"]([a-z-]+)['"]/gi)) {
    const val = (m[1] ?? "").toLowerCase();
    if (!ALLOWED_TRANSFORM.has(val)) violations.push(`${file}: textTransform: ${val} — must be uppercase/none/inherit (REQ-146 A5)`);
  }
  return violations;
}

// A file whose RAW hexes and RAW font stacks are legitimate: the token SOURCE (tokens.css and
// tokens.ts). Everything else must reach the palette through var(--token) / the TOKENS const.
function isTokenSource(f: string): boolean {
  return /(?:^|\/)tokens\.(?:css|ts)$/.test(f);
}

// The scanned file set: css/tsx/ts/jsx/mjs/html under apps + packages, so a screen styling from
// a `.ts` module or an `index.html` <style> block can't slip past the glob (C4). node_modules/
// dist stay excluded (never git-tracked here anyway). H-3 (REQ-206): the runtime map-style JSON
// (`*-style.json`, e.g. packages/map/greige-style.json — the shipped basemap with RAW paint
// colors, imported by style.ts) is scanned too, so a non-token color in the basemap is caught by
// the color-token audit. Only `*-style.json` is added, not every `.json`, so package/tsconfig
// manifests can't false-positive.
export function scanPatterns(): string[] {
  // §1386 — DERIVED as TREES x EXTENSIONS, so the two trees cannot drift apart. They had: `apps` scanned
  // `.js` and `packages` did not, an asymmetry safe only because zero `.js` files are tracked under
  // `packages/` today (measured). A build shim, a vendored polyfill or a generated module landing there would
  // have escaped a CONSTITUTIONAL, blocking gate (CLAUDE.md rule 7) with no failure anywhere — the same
  // accident-not-design shape as §1369's glob and §1370's pathspecs. A cross-product cannot be asymmetric.
  const TREES = ["apps", "packages"] as const;
  const EXTENSIONS = ["css", "tsx", "ts", "jsx", "mjs", "js", "html"] as const;
  const patterns = [
    ...TREES.flatMap((t) => EXTENSIONS.map((e) => `${t}/**/*.${e}`)),
    // H-3 (REQ-206): only `*-style.json`, never every `.json`, so package/tsconfig manifests cannot false-positive.
    ...TREES.map((t) => `${t}/**/*-style.json`),
  ];
  return patterns;
}

export function scannedFiles(): string[] {
  const patterns = scanPatterns();
  return execSync(`git ls-files ${patterns.map((p) => `"${p}"`).join(" ")}`, { cwd: repoRoot(), encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes("node_modules/") && !f.includes("/dist/"));
}

// Repo-wide audits per doc 07 §06 (REQ-145/146/147/148).
export function auditRepo(): string[] {
  const violations: string[] = [];
  const root = repoRoot();
  const files = scannedFiles();
  const allowedHex = new Set(Object.values(readTokens(`${repoRoot()}/packages/design/tokens.css`)));
  for (const f of files) {
    const text = readFileSync(`${root}/${f}`, "utf8");
    // The token SOURCE is where the raw hexes and font stacks legitimately live; everything
    // else must use var()/TOKENS. Skip only its color+font checks — chrome checks still apply.
    if (!isTokenSource(f)) {
      violations.push(...auditColor(f, text, allowedHex));
      violations.push(...auditFont(f, text));
    }
    violations.push(...auditGradient(f, text));
    violations.push(...auditMotion(f, text));
    violations.push(...auditCaseAndDividers(f, text));
  }
  return violations;
}

function main(): void {
  const root = repoRoot();
  const { mode } = JSON.parse(readFileSync(`${root}/tools/design/design-ci.json`, "utf8")) as Mode;
  const tokenResult = auditTokens(`${root}/packages/design/tokens.css`);

  // NON-VACUITY (§487/§490/§554): every check below is a per-file scan, so an empty corpus produces zero
  // violations and prints "clean". This gate is BLOCKING (CLAUDE.md rule 7) and the pixel budgets — 5 colors,
  // 2 fonts, 0 shadows — have no other enforcer, so "clean" must never be reachable by reading nothing.
  const corpus = scannedFiles();
  if (corpus.length < 50) {
    console.error(`FAIL design audit — scanned ${corpus.length} file(s) under ${root}; the surfaces are hundreds.`);
    console.error("A per-file audit that reads nothing reports clean. Fix the scan, do not lower this floor.");
    process.exit(1);
  }

  const violations = [...tokenResult.violations, ...auditRepo()];
  writeFileSync(`${root}/tools/design/report.json`, JSON.stringify({ mode, violations }, null, 2));
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
