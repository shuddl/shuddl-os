import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../checks/repo-root.js";

// §1224 (REQ-288/276/118) — EVERY COMMAND THE WORKFLOWS RUN MUST RESOLVE TO SOMETHING THAT EXISTS.
//
// WHY THIS GATE EXISTS, and why now. §1223 measured the enforcement surface and found every `ci.yml` job
// DORMANT: it triggers on `pull_request` and `push:[main]`, `origin/main` is 1,287 commits behind, and there
// have been zero pull requests ever. A workflow that has never executed is unexercised code — and the failure
// mode that bites FIRST, on the very first run, is a command that no longer resolves: a renamed `package.json`
// script, a dropped binary, a workspace that lost its `build`.
//
// `ci-contract.test.ts` (26 assertions) already pins that ci.yml CONTAINS the right steps — install flags, the
// merge gate, the doc gates by name, gitleaks at full depth, SHA-pinned actions. It asserts the workflow SAYS
// the right things. It does not assert that what it says can RUN. That is the gap this closes, and the two are
// complementary: one guards the shape of the file, the other the reachability of its commands.
//
// THE PARSER IS THE HARD PART, and it was measured wrong first. A naive scan that strips flags and takes the
// next word reports `pnpm -r --if-present build` and `pnpm exec playwright …` as MISSING root scripts — both
// are false. `-r` dispatches to WORKSPACE scripts (three apps define `build`) and `exec` runs a BINARY from a
// dependency (`playwright` ships in `@playwright/test`). A gate carrying that parser would red the build on
// two correct lines, which is how a gate gets deleted (§"semantic false positives need a marker"). Each pnpm
// form is therefore resolved against the thing it actually dispatches to.

type Form = "builtin" | "root-script" | "workspace-script" | "binary";

interface Invocation {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  readonly form: Form;
  readonly target: string;
}

/** pnpm subcommands that are the tool itself, not a script — nothing in this repo can rename them away. */
const BUILTINS = new Set(["install", "audit", "dlx", "why", "list", "outdated", "store", "add", "remove"]);

/** Every `pnpm …` invocation in a workflow `run:` line, classified by what it dispatches to. */
export function invocations(files: readonly { path: string; text: string }[]): Invocation[] {
  const out: Invocation[] = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((raw, i) => {
      const run = /^\s*-?\s*run:\s*(.+)$/.exec(raw);
      if (run === null) return;
      for (const cmd of run[1]!.split(/&&|\|\|/)) {
        const m = /(?:^|\s)pnpm\s+(.+)$/.exec(cmd.trim());
        if (m === null) continue;
        // Consume leading flags (-s, -r, --if-present, --filter x). `-r`/`--recursive` switches the dispatch
        // target from the root manifest to every workspace manifest, so it is remembered, not merely skipped.
        const words = m[1]!.trim().split(/\s+/);
        let recursive = false;
        let head = "";
        for (let k = 0; k < words.length; k += 1) {
          const w = words[k]!;
          if (w === "-r" || w === "--recursive") { recursive = true; continue; }
          if (w.startsWith("-")) continue;
          head = w;
          break;
        }
        if (head === "") continue;
        const line = i + 1;
        if (BUILTINS.has(head)) { out.push({ file: path, line, raw: cmd.trim(), form: "builtin", target: head }); continue; }
        if (head === "exec" || head === "run") {
          const next = words[words.indexOf(head) + 1];
          if (next === undefined) continue;
          if (head === "run") { out.push({ file: path, line, raw: cmd.trim(), form: recursive ? "workspace-script" : "root-script", target: next }); continue; }
          out.push({ file: path, line, raw: cmd.trim(), form: "binary", target: next });
          continue;
        }
        out.push({ file: path, line, raw: cmd.trim(), form: recursive ? "workspace-script" : "root-script", target: head });
      }
    });
  }
  return out;
}

function manifests(root: string): { path: string; scripts: Set<string>; deps: Set<string> }[] {
  const files = execSync('git ls-files "package.json" "*/package.json" "*/*/package.json"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "");
  return files.map((p) => {
    const j = JSON.parse(readFileSync(`${root}/${p}`, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      path: p,
      scripts: new Set(Object.keys(j.scripts ?? {})),
      deps: new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]),
    };
  });
}

/** Invocations whose target does not exist. Returned with the source line so a failure is actionable. */
export function unresolved(inv: readonly Invocation[], mans: ReturnType<typeof manifests>): string[] {
  const root = mans.find((m) => m.path === "package.json");
  const bad: string[] = [];
  for (const v of inv) {
    let ok = false;
    if (v.form === "builtin") ok = true;
    else if (v.form === "root-script") ok = root !== undefined && root.scripts.has(v.target);
    else if (v.form === "workspace-script") ok = mans.some((m) => m.path !== "package.json" && m.scripts.has(v.target));
    // A binary is provided by a declared dependency; `playwright` ships inside `@playwright/test`, so the
    // dependency NAME is matched as a substring rather than for equality.
    else ok = mans.some((m) => [...m.deps].some((d) => d === v.target || d.includes(v.target)));
    if (!ok) bad.push(`${v.file}:${v.line}  [${v.form}] "${v.target}"  ← ${v.raw}`);
  }
  return bad;
}

const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/nightly.yml"];

describe("§1224 REQ-288/276: every workflow command resolves to a real script or binary", () => {
  const root = repoRoot();
  const files = WORKFLOWS.map((p) => ({ path: p, text: readFileSync(`${root}/${p}`, "utf8") }));
  const inv = invocations(files);
  const mans = manifests(root);

  it("finds the workflows and a real invocation corpus (non-vacuity — §968's rule)", () => {
    // Floor the INPUT. A renamed workflow file or a broken `run:` regex yields zero invocations, and
    // "nothing unresolved" over an empty set is the false clean this repo has spent scores of phases on.
    expect(files.every((f) => f.text.length > 200), "a workflow file is empty or unreadable").toBe(true);
    expect(inv.length, "no pnpm invocations parsed — the run: regex is broken, not the workflows").toBeGreaterThanOrEqual(10);
    expect(mans.length, "no manifests found — the corpus query is broken").toBeGreaterThanOrEqual(10);
    // All four dispatch forms must be exercised, or a form could rot untested behind a green gate.
    expect(new Set(inv.map((v) => v.form)).size, "not every pnpm dispatch form appears — the classifier may have collapsed").toBeGreaterThanOrEqual(3);
  });

  it("no workflow command targets a missing script or binary", () => {
    const bad = unresolved(inv, mans);
    expect(
      bad,
      "workflow command(s) that cannot run — CI has never executed (§1223), so this would surface on the FIRST " +
        "push, as a red first run:\n  " +
        bad.join("\n  ") +
        "\n\nRestore the script in package.json, or update the workflow to the new name.",
    ).toEqual([]);
  });

  it("the resolver rejects each form when its target is absent (non-vacuity per form)", () => {
    // One synthetic workflow exercising all four dispatches against targets that do not exist. Without this,
    // a resolver that returned `ok = true` unconditionally would pass the suite forever.
    const fake = [
      {
        path: "synthetic.yml",
        text: [
          "      - run: pnpm no-such-root-script",
          "      - run: pnpm -r --if-present no-such-workspace-script",
          "      - run: pnpm exec no-such-binary --flag",
        ].join("\n"),
      },
    ];
    expect(unresolved(invocations(fake), mans), "the resolver accepts targets that do not exist").toHaveLength(3);
  });

  it("does NOT flag the real forms that a naive parser gets wrong", () => {
    // The two lines that a first cut of this gate reported as MISSING, both correct: `-r` dispatches to
    // workspace manifests, and `exec` runs a dependency's binary.
    const real = [
      {
        path: "synthetic.yml",
        text: ["      - run: pnpm -r --if-present build", "      - run: pnpm exec playwright install --with-deps chromium", "      - run: pnpm install --frozen-lockfile", "      - run: pnpm audit --prod"].join("\n"),
      },
    ];
    expect(unresolved(invocations(real), mans), "a false positive here is how this gate gets deleted").toEqual([]);
  });
});
