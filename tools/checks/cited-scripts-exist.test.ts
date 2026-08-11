import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §996 — A CITED `pnpm <script>` MUST EXIST, BECAUSE pnpm FAILS SILENTLY WHEN IT DOES NOT.
//
// `pnpm -s <missing-script>` exits **1 and prints NOTHING** — `-s` swallows `Command "x" not found`. Run
// inside a redirect block, an absent gate is indistinguishable from a clean one. Every proof in this repo's
// governing records is a command, so a command that cannot run is evidence that cannot be reproduced.
//
// MEASURED AT §996: this record documents the trap TWICE already (`pnpm -s check:design` — the script is
// `audit:design`; `pnpm -s check:append-chokepoint` — never existed), and it happened a THIRD time anyway, in
// the verification table of §994's stopping point: *"`pnpm check:docs`, `phase-index` | clean · 5/5"*. There is
// no `check:docs`. The `phase-index` half was real, which is what made the row readable as green.
//
// Knowing a trap is not a defence against it. That is the argument for the gate.
//
// WHY THIS ONE IS BUILDABLE WHEN THE PATH-ONLY CITATION GATE IS NOT (checklist L421, measured and rejected
// TWICE — §240's residual ran ~95% false). Both face semantic false positives; the difference is the SIZE and
// STABILITY of the residual. Measured over the whole doc corpus: **456 backticked pnpm citations, 19
// unresolvable** — of which 11 were my own matcher (`exec` capturing `vitest`/`tsx`), 3 were prose merely
// containing the word, 1 was a `docs/plans` proposal, and **3 were deliberate negative examples**. Requiring
// the span to START with `pnpm` and treating `exec` as terminal removes all 15 mechanically; what remains is
// three known lines, which a marker handles exactly. §240's residual was open-ended (generic illustrations,
// shorthand, aspirational paths) and no marker could bound it. Same hazard, opposite verdict, for a reason
// that was measured rather than assumed.
//
// SCOPE, STATED: existence only. That a script EXISTS says nothing about whether it still emits the verdict
// the row claims — that is the row's own expiry trigger, and §995's gate owns it. Two halves of one question,
// deliberately separate: this one is decidable, the other is a judgement.

const PLANS = "docs/plans/"; // a plan PROPOSES a script that may land under another name — not rot (§240's rule)
const IGNORE = "script-check: ignore";
/** pnpm's own subcommands — not package scripts, and `exec`/`dlx` invoke a BINARY, so the tail is not a script. */
const SUBCOMMANDS = new Set(["install", "i", "add", "remove", "rm", "update", "up", "audit", "store", "why", "ls", "list", "init", "link", "unlink", "prune", "dedupe", "licenses", "outdated", "pack", "publish", "root", "bin", "env", "setup", "patch", "deploy", "fetch", "import", "rebuild", "server", "start", "create", "dlx", "exec"]);
/**
 * Flags that precede the script name and CARRY AN ARGUMENT. Boolean flags (`-s`, `-r`, `-w`,
 * `--workspace-root`, `--no-bail`) must NOT be listed: they are consumed by the generic `-`-prefix branch.
 * Listing one here skips the following token too — §996 shipped with `-w` misfiled, so
 * `pnpm -w exec node -e '…'` skipped past `exec` and reported `node` as a missing script. The gate's own
 * false positive, found by running it.
 */
const FLAG_WITH_ARG = new Set(["-F", "--filter", "-C", "--dir"]);

function tracked(root: string, pattern: string): string[] {
  return execFileSync("git", ["ls-files", pattern], { cwd: root, encoding: "utf8" }).split("\n").filter((l) => l !== "");
}

/** Every script name defined anywhere in the workspace — root plus every tracked package.json. */
function definedScripts(root: string): Set<string> {
  const out = new Set<string>();
  for (const pj of ["package.json", ...tracked(root, "**/package.json")]) {
    try {
      const scripts = (JSON.parse(readFileSync(`${root}/${pj}`, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const k of Object.keys(scripts)) out.add(k);
    } catch {
      // an unparseable package.json is another gate's business, not this one's
    }
  }
  return out;
}

/** The script a backticked `pnpm …` span invokes, or null when it invokes none. */
export function citedScript(span: string): string | null {
  const tokens = span.trim().split(/\s+/);
  if (tokens[0] !== "pnpm") return null; // a span merely CONTAINING the word is prose
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (FLAG_WITH_ARG.has(t)) { i += 2; continue; }
    if (t.startsWith("-")) { i += 1; continue; } // -s, --silent, -r, --no-bail …
    if (t === "run") { i += 1; continue; }
    break;
  }
  const name = tokens[i];
  if (name === undefined || SUBCOMMANDS.has(name)) return null;
  return /^[a-z][a-z0-9:_-]*$/.test(name) ? name : null;
}

interface Citation { file: string; line: number; script: string; span: string }

function citations(root: string): Citation[] {
  const out: Citation[] = [];
  for (const rel of tracked(root, "*.md").concat(tracked(root, "**/*.md"))) {
    if (rel.startsWith(PLANS)) continue;
    const text = readFileSync(`${root}/${rel}`, "utf8");
    text.split("\n").forEach((line, idx) => {
      if (line.includes(IGNORE)) return;
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const script = citedScript(m[1] as string);
        if (script !== null) out.push({ file: rel, line: idx + 1, script, span: (m[1] as string).slice(0, 60) });
      }
    });
  }
  return out;
}

describe("§996: every cited `pnpm <script>` resolves to a defined script", () => {
  const root = repoRoot();
  const scripts = definedScripts(root);
  const cited = citations(root);

  it("the parser separates a command from prose (unit cases, so the corpus scan means something)", () => {
    expect(citedScript("pnpm check:citations")).toBe("check:citations");
    expect(citedScript("pnpm -s check:citations")).toBe("check:citations");
    expect(citedScript("pnpm run verify:merge")).toBe("verify:merge");
    expect(citedScript("pnpm -F @shuddl/api test")).toBe("test");
    // `exec` and `dlx` invoke a BINARY — the tail is not a package script and must never be reported as one.
    expect(citedScript("pnpm exec vitest run anchor")).toBeNull();
    expect(citedScript("pnpm exec tsx tools/deploy/preflight.ts")).toBeNull();
    // A BOOLEAN flag must not swallow the next token. This exact span made the gate report `node`.
    expect(citedScript("pnpm -w exec node -e 'process.cwd()'")).toBeNull();
    expect(citedScript("pnpm -r --no-bail run typecheck")).toBe("typecheck");
    expect(citedScript("pnpm install")).toBeNull();
    expect(citedScript("pnpm store prune")).toBeNull();
    // Prose that merely contains the word is not a citation — 3 corpus lines looked like this.
    expect(citedScript("and pnpm blocks install scripts")).toBeNull();
  });

  it("finds a real corpus (non-vacuity — §968's rule, and §996's own subject)", () => {
    // This gate exists because an ABSENT thing read as a clean one. It must not do that itself: a broken glob,
    // a renamed docs tree, or a marker applied too widely would otherwise certify every proof in the repo.
    expect(scripts.size, "no package scripts collected — the package.json scan is broken, not the repo").toBeGreaterThanOrEqual(20);
    expect(
      cited.length,
      "no backticked `pnpm <script>` citations found across the docs. The corpus, the glob or the backtick " +
        "matcher broke — and a scan for bad citations finds none in an empty corpus, which is the exact " +
        "failure this gate was written to stop.",
    ).toBeGreaterThanOrEqual(100);
  });

  it("no document cites a script that does not exist", () => {
    const missing = cited.filter((c) => !scripts.has(c.script));
    expect(
      missing,
      "document(s) citing a `pnpm` script that is defined nowhere in the workspace:\n  " +
        missing.map((c) => `${c.file}:${c.line}  \`${c.span}\`  → '${c.script}'`).join("\n  ") +
        "\n\n`pnpm -s <missing>` exits 1 and prints NOTHING, so an absent gate is indistinguishable from a " +
        "clean one — §996 recorded three instances, the last inside a stopping point's own evidence table. " +
        "Either the script was renamed (repoint the citation) or it never existed (say so, and mark the line " +
        `with an HTML comment \`${IGNORE}\` if the citation is a deliberate negative example).`,
    ).toEqual([]);
  });
});
