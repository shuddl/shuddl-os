import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

// REQ-118 §679 — A DORMANT GAP'S EXPIRY TRIGGER, MADE A GATE INSTEAD OF A HOPE.
//
// §135 recorded a real, latent gap: `agent_runs` is projected from `agent.acted`, the Watchtower's budget
// alarm averages only reported metrics — and the Concierge, ~~the only agent that calls an LLM~~ (STRUCK by
// §680: the Command copilot is a second one, REQ-038) emits no `agent.acted`. The alarm is wired to exactly
// the agents whose cost cannot drift and blind to the ones whose cost can.
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

// §680 — BOTH LLM-calling agents, not one. §135 recorded "the Concierge is the only agent that calls an
// LLM", and §679 repeated it without checking. It is stale: `routes/copilot.ts` selects a live
// `ClaudeCopilot` (raw fetch to the Anthropic API) when ANTHROPIC_API_KEY + COPILOT_MODEL are both bound,
// falling back to a DeterministicCopilot floor otherwise. REQ-038 is one of the register's 13 agents and it
// emits no `agent.acted` either — so the metering gap §135 found has TWO members, not one.
//
// The model key is per-agent; the API key is shared. Watching only ANTHROPIC_MODEL, as §679 did, would have
// stayed silent on the day the Copilot alone was switched on.
interface LlmAgent {
  readonly name: string;
  /** The file that would carry the `agent.acted` emit. */
  readonly file: string;
  /** The binding whose presence turns this agent from deterministic to cost-bearing. */
  readonly modelKey: string;
}

const LLM_AGENTS: readonly LlmAgent[] = [
  { name: "Concierge", file: "workers/agents/src/concierge.ts", modelKey: "ANTHROPIC_MODEL" },
  { name: "Copilot", file: "workers/api/src/routes/copilot.ts", modelKey: "COPILOT_MODEL" },
];

const API_KEY = "ANTHROPIC_API_KEY";

/** Every tracked wrangler config — the only place a binding becomes real in a deployable scope. */
function wranglerConfigs(root: string): string[] {
  return execSync('git ls-files "*/wrangler.toml" "wrangler.toml"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** Configs declaring one of the given binding names, by `file:key`. */
function bindingsFor(root: string, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of wranglerConfigs(root)) {
    const toml = readFileSync(`${root}/${f}`, "utf8");
    // Comment-stripped per line: a `# ANTHROPIC_API_KEY is CONFIRM-gated` note is documentation, not a
    // binding, and this file exists because a gate that cannot tell prose from code cries wolf (§674).
    const live = toml
      .split("\n")
      .map((l) => l.replace(/#.*$/, ""))
      .join("\n");
    for (const k of keys) if (live.includes(k)) out.push(`${f}:${k}`);
  }
  return out;
}

describe("REQ-118 §679/§680: every LLM-calling agent's metering trigger is enforced, not hoped", () => {
  const root = repoRoot();

  it("finds the wrangler configs at all (non-vacuity — a dormant gate must not be a broken one)", () => {
    // Without this, renaming the configs would make every binding scan permanently empty and every
    // conditional below permanently true — PASS forever, on the day it matters most.
    expect(
      wranglerConfigs(root).length,
      "no wrangler.toml files found — this gate cannot see a binding, so its silence means nothing",
    ).toBeGreaterThanOrEqual(4);
  });

  it.each(LLM_AGENTS)("if $name's model binding appears, $name must emit agent.acted", ({ name, file, modelKey }) => {
    const bound = bindingsFor(root, [API_KEY, modelKey]);
    if (bound.length === 0) return; // dormant, as recorded in §135.1 — the hold has not expired

    // stripComments is correct HERE and only here: this is TypeScript, where `//` outside a string is a
    // comment. §674 pinned the boundary — it must not be reused on a CSS-scanning gate. It matters because
    // concierge.ts mentions `agent.acted` TWICE, in comments explaining that it does NOT emit one; a gate
    // reading raw text would pass on those two lines and prove nothing.
    const src = stripComments(readFileSync(`${root}/${file}`, "utf8"));
    expect(
      src.includes("agent.acted"),
      `${modelKey} / ${API_KEY} is now bound (${bound.join(", ")}), so ${name} calls an LLM and its cost is ` +
        `variable. It still emits no \`agent.acted\`, so it writes no \`agent_runs\` row and the Watchtower's ` +
        "budget-drift alarm (REQ-113) averages every agent whose cost CANNOT drift while remaining blind to " +
        `the ones whose cost can. This is §135's dormant gap waking up: emit \`agent.acted\` with the real ` +
        "cost and latency, or move the alarm off `agent_runs`",
    ).toBe(true);
  });

  it.each(LLM_AGENTS)("$name still does not report, so this gate still has a subject", ({ name, file }) => {
    // §"record holds with expiry triggers": if an agent starts reporting on its own, its row here guards
    // nothing and should be removed rather than left as a green check nobody can explain.
    const src = stripComments(readFileSync(`${root}/${file}`, "utf8"));
    expect(
      src.includes("agent.acted"),
      `${name} now emits \`agent.acted\` unconditionally — §135's gap is closed for it on its own terms. ` +
        "Drop it from LLM_AGENTS and say so in the audit, rather than leaving a check that guards nothing",
    ).toBe(false);
  });
});
