import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

// REQ-118 §679 — A DORMANT GAP'S EXPIRY TRIGGER, MADE A GATE INSTEAD OF A HOPE.
//
// §135 recorded a real, latent gap: `agent_runs` is projected from `agent.acted`, the Watchtower's budget
// alarm averages only reported metrics — and the Concierge, **the only agent that calls an LLM and therefore
// the only one whose cost can vary at all**, emits no `agent.acted`. The alarm is wired to exactly the agents
// whose cost cannot drift and blind to the one whose cost can.
//
// Nothing fails open: the projection records what an agent REPORTS and `{}` means unknown, never a fabricated
// zero. The gap is real but LATENT, because `ClaudeParser` is selected only when `ANTHROPIC_API_KEY` and
// `ANTHROPIC_MODEL` are both bound, and neither is bound anywhere today (both are CONFIRM-gated external
// holds). No LLM cost is incurred, so there is nothing to meter.
//
// §135.1 therefore recorded an unusually clean expiry trigger: **the day `ANTHROPIC_API_KEY` binds.** That
// single event turns the Concierge from deterministic to cost-bearing AND makes an unmetered Concierge
// matter. It was left as a HUMAN trigger — and §319's rule is that an unenforced trigger is a hope, not a
// control. This is that trigger, enforced.
//
// SCOPE — deliberately narrow. This does NOT bind the key, does not alter REQ-039's DoD (register scope,
// owner-held per §179), and does not require the Concierge to emit anything TODAY. It asserts one
// conditional: *if the key is ever bound in a deployable scope, the Concierge must by then report its runs.*
// Until that day it is dormant, and the non-vacuity assertion below is what stops "dormant" from decaying
// into "broken and silent".

const CONCIERGE = "workers/agents/src/concierge.ts";
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"] as const;

/** Every tracked wrangler config — the only place a binding becomes real in a deployable scope. */
function wranglerConfigs(root: string): string[] {
  return execSync('git ls-files "*/wrangler.toml" "wrangler.toml"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** Configs declaring an Anthropic binding, by `file:key`. */
function anthropicBindings(root: string): string[] {
  const out: string[] = [];
  for (const f of wranglerConfigs(root)) {
    const toml = readFileSync(`${root}/${f}`, "utf8");
    // Comment-stripped per line: a `# ANTHROPIC_API_KEY is CONFIRM-gated` note is documentation, not a
    // binding, and this file exists because a gate that cannot tell prose from code cries wolf (§674).
    const live = toml
      .split("\n")
      .map((l) => l.replace(/#.*$/, ""))
      .join("\n");
    for (const k of KEYS) if (live.includes(k)) out.push(`${f}:${k}`);
  }
  return out;
}

describe("REQ-118 §679: the Concierge metering gap's expiry trigger is enforced, not hoped", () => {
  const root = repoRoot();

  it("finds the wrangler configs at all (non-vacuity — a dormant gate must not be a broken one)", () => {
    // Without this, renaming the configs would make `anthropicBindings()` permanently empty and the
    // conditional below permanently true — the gate would report PASS forever, on the day it matters most.
    expect(
      wranglerConfigs(root).length,
      "no wrangler.toml files found — this gate cannot see a binding, so its silence means nothing",
    ).toBeGreaterThanOrEqual(4);
  });

  it("if an Anthropic binding exists in any deployable scope, the Concierge must emit agent.acted", () => {
    const bound = anthropicBindings(root);
    if (bound.length === 0) return; // dormant, as recorded in §135.1 — the hold has not expired

    // stripComments is correct HERE and only here: this is TypeScript, where `//` outside a string is a
    // comment. §674 pinned the boundary — it must not be reused on a CSS-scanning gate. The distinction
    // matters because concierge.ts currently mentions `agent.acted` TWICE, in comments explaining that it
    // does NOT emit one. A gate reading raw text would pass on those two lines and prove nothing.
    const src = stripComments(readFileSync(`${root}/${CONCIERGE}`, "utf8"));
    expect(
      src.includes("agent.acted"),
      `ANTHROPIC_API_KEY / ANTHROPIC_MODEL is now bound (${bound.join(", ")}), so the Concierge calls an LLM ` +
        "and its cost is variable. It still emits no `agent.acted`, so it writes no `agent_runs` row and the " +
        "Watchtower's budget-drift alarm (REQ-113) averages every agent whose cost CANNOT drift while " +
        "remaining blind to the only one whose cost can. This is §135's dormant gap waking up: emit " +
        "`agent.acted` with the real cost and latency, or move the alarm off `agent_runs`",
    ).toBe(true);
  });

  it("the gap it guards is still the recorded one (the assumption this gate rests on)", () => {
    // §"record holds with expiry triggers": if the Concierge starts reporting on its own, this file has
    // nothing left to guard and should be deleted rather than left as a passing gate nobody can explain.
    const src = stripComments(readFileSync(`${root}/${CONCIERGE}`, "utf8"));
    expect(
      src.includes("agent.acted"),
      "the Concierge now emits `agent.acted` unconditionally — §135's gap is closed on its own terms and " +
        "this gate is obsolete. Delete it and say so in the audit, rather than leaving a green check that " +
        "guards nothing",
    ).toBe(false);
  });
});
