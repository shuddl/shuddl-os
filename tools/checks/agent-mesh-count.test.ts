import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1482 (REQ-118/119) — THE AGENT COUNT IS RESTATED IN A DOZEN PLACES AND DERIVED FROM NONE.
//
// `genesis/01-PRODUCT-SPEC.md` heads its roster *"## 2. The agent mesh (13 agents; …)"* and follows it with a
// table of exactly 13 rows. That number is then restated across the governing set — CLAUDE.md's opening line,
// README.md, `genesis/05` ("6 of the 13 agents"), `genesis/11`, `genesis/14`, `genesis/README`, two WP records,
// and `packages/agents/src/index.ts:1` ("the 13 agents' PURE, DETERMINISTIC cores").
//
// `claude-md-budgets.test.ts` already owns this machinery: §1175 asserts that *"every RESTATEMENT of a hard
// budget agrees with the number that enforces it"*. But 13 agents is NOT on CLAUDE.md's hard-budgets line — it
// lives in the opening prose — and §1173 deliberately reads budgets ONLY from the budgets line, so prose
// restatements never become budgets. Correct for budgets, and it leaves this count with no owner: a 14th agent
// would make a dozen documents wrong at once, silently, including the file that tells a build session what it
// is building.
//
// This is §1480's defect one level up. There the drift was a gate header beside its own roster; here it is a
// SOURCE-OF-TRUTH heading beside its own table, restated outward. §1481's cheap defence applies unchanged:
// make the roster assert its own stated size, and make every restatement agree with the roster rather than
// with each other.
//
// SCOPE. The audit record is excluded — it is a dated log whose older sections legitimately quote superseded
// numbers (the §1452 precedent). The budgets gate's synthetic CLAUDE.md fixture is excluded BY PATH: it embeds
// "13 agents" as example prose to prove §1173 reads the budgets line and not the intro, so scanning it would
// flag the very test that establishes the distinction (§1416's shape, fixed §1426's way).

const SPEC = "genesis/01-PRODUCT-SPEC.md";
const EXCLUDED_PATHS = ["docs/audits/", "tools/checks/claude-md-budgets.test.ts", "tools/checks/agent-mesh-count.test.ts"];

const WORDS: Record<string, number> = { eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };

/** The count the spec's own heading states, and the rows its table actually holds. */
function specRoster(root: string): { stated: number; rows: string[] } {
  const lines = readFileSync(`${root}/${SPEC}`, "utf8").split("\n");
  const head = lines.findIndex((l) => l.includes("The agent mesh"));
  if (head < 0) throw new Error(`${SPEC} no longer heads a section containing "The agent mesh"`);
  const m = /\((\d+|[a-z]+) agents/i.exec(lines[head] as string);
  if (m === null) throw new Error(`${SPEC}'s agent-mesh heading no longer states a count: ${lines[head]}`);
  const raw = (m[1] as string).toLowerCase();
  const stated = /^\d+$/.test(raw) ? Number(raw) : (WORDS[raw] ?? Number.NaN);
  const rows: string[] = [];
  for (const l of lines.slice(head + 1)) {
    if (l.startsWith("## ")) break;
    const r = /^\|\s*\*\*([A-Za-z][^*|]*)\*\*\s*\|/.exec(l);
    if (r !== null) rows.push((r[1] as string).trim());
  }
  return { stated, rows };
}

/** Every tracked file stating a count of agents, with the number it states. */
function restatements(root: string): { file: string; line: number; n: number }[] {
  const out = execSync(
    `git grep -nE '(\\b|[^0-9])(1[0-9]|[a-z]+) agents' -- '*.md' '*.ts' || true`,
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ).split("\n");
  const rows: { file: string; line: number; n: number }[] = [];
  for (const l of out) {
    if (l === "") continue;
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    if (m === null) continue;
    const [, file, line, text] = m as unknown as [string, string, string, string];
    if (EXCLUDED_PATHS.some((p) => file.startsWith(p))) continue;
    const c = /(\d+|[a-z]+) agents/i.exec(text);
    if (c === null) continue;
    const raw = (c[1] as string).toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : (WORDS[raw] ?? Number.NaN);
    if (Number.isNaN(n)) continue; // "the agents", "all agents" — not a count
    rows.push({ file, line: Number(line), n });
  }
  return rows;
}

describe("§1482 REQ-119: the agent-mesh count is derived, not restated", () => {
  const root = repoRoot();
  const { stated, rows } = specRoster(root);
  const said = restatements(root);

  it("derives a real roster (non-vacuity — an empty table would satisfy any heading)", () => {
    expect(rows.length, `${SPEC}'s agent table parsed to nothing — the table shape changed, not the mesh`).toBeGreaterThanOrEqual(5);
    expect(said.length, "no restatement of the agent count found — the matcher is stale, not the record").toBeGreaterThanOrEqual(4);
  });

  it("the spec's heading count equals the rows its own table holds", () => {
    expect(
      rows.length,
      `${SPEC} heads its roster "(${stated} agents…)" while the table below it holds ${rows.length} rows ` +
        `(${rows.join(", ")}). A heading beside its own roster is §1480's defect: the prose is what every other ` +
        "document copies, so this number going stale makes a dozen files wrong at once.",
    ).toBe(stated);
  });

  it("every restatement across the tracked corpus agrees with the roster", () => {
    const wrong = said.filter((r) => r.n !== rows.length).map((r) => `${r.file}:${r.line} says ${r.n}, roster holds ${rows.length}`);
    expect(
      wrong,
      "a document states an agent count that disagrees with genesis/01's table. This number is restated in the " +
        "governing set — CLAUDE.md's opening line, README, several genesis docs and packages/agents/src/index.ts " +
        "— and none of them derives it, so they can only be kept true together:\n  " + wrong.join("\n  "),
    ).toEqual([]);
  });

  it("the restatement scan reaches the governing files it exists for (positive control)", () => {
    // Without this, a matcher that quietly stopped finding CLAUDE.md would make the agreement test vacuous —
    // it would compare an empty set to the roster and pass. §1387's rule on a scan whose green means "found none".
    const files = new Set(said.map((r) => r.file));
    for (const f of ["CLAUDE.md", SPEC, "packages/agents/src/index.ts"]) {
      expect(files.has(f), `${f} states the agent count but the scan did not see it — the matcher is broken`).toBe(true);
    }
  });
});
