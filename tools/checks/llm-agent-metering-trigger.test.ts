import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

// REQ-118 §679/§680/§681 — A DORMANT GAP'S EXPIRY TRIGGER, MADE A GATE INSTEAD OF A HOPE.
//
// §135 recorded a real, latent gap: `agent_runs` is projected from `agent.acted`, the Watchtower's budget
// alarm (REQ-113) averages only reported metrics — and the agents that call an LLM, the only ones whose cost
// can vary at all, do not report a cost. The alarm is wired to exactly the agents whose cost cannot drift.
//
// Nothing fails open: the projection records what an agent REPORTS and `{}` means unknown, never a
// fabricated zero. The gap is LATENT because every LLM adapter is selected only when its model binding is
// present, and none is bound anywhere today (all CONFIRM-gated external holds). §135.1 recorded the expiry
// trigger — *the day a model binding appears* — and left it HUMAN. §319: an unenforced trigger is a hope.
//
// THE ROSTER GREW TWICE WHILE THIS FILE WAS BEING WRITTEN, which is the substance of §680 and §681:
//   §679 covered the Concierge and asserted §135's "the only agent that calls an LLM".
//   §680 measured that claim FALSE — `routes/copilot.ts` selects a live ClaudeCopilot on COPILOT_MODEL.
//   §681 found a THIRD, `MIGRATOR_MODEL`, by deriving the population instead of listing it.
//
// The model key is PER-AGENT (the API key is shared, the model name is not), so a hand-written list is
// exactly the wrong shape — hence the completeness floor below, which is what actually closes this.
//
// AND THE MECHANISM DIFFERS PER AGENT. The Concierge and Copilot would report via an `agent.acted` event;
// the Migrator already writes `agent_runs` DIRECTLY and binds `cost` as the literal `"{}"` — an honest
// unknown today, and a silent hole the day its tokens cost money. Asserting "emits agent.acted" against the
// Migrator would be false-negative by construction, so each agent carries its own predicate.

const API_KEY = "ANTHROPIC_API_KEY";

interface LlmAgent {
  readonly name: string;
  /** The file that carries this agent's cost reporting. */
  readonly file: string;
  /** The binding that turns this agent from deterministic to cost-bearing. */
  readonly modelKey: string;
  /** True when the file reports a real cost. Comment-stripped source is passed in. */
  readonly reportsCost: (src: string) => boolean;
  /** What to do about it, named in the failure. */
  readonly remedy: string;
}

const LLM_AGENTS: readonly LlmAgent[] = [
  {
    name: "Concierge",
    file: "workers/agents/src/concierge.ts",
    modelKey: "ANTHROPIC_MODEL",
    reportsCost: (src) => src.includes("agent.acted"),
    remedy: "emit `agent.acted` carrying the real cost and latency",
  },
  {
    name: "Copilot",
    file: "workers/api/src/routes/copilot.ts",
    modelKey: "COPILOT_MODEL",
    reportsCost: (src) => src.includes("agent.acted"),
    remedy: "emit `agent.acted` carrying the real cost and latency",
  },
  {
    name: "Migrator",
    file: "workers/api/src/routes/import.ts",
    modelKey: "MIGRATOR_MODEL",
    // Already writes agent_runs directly; the hole is the cost column, bound as a literal empty object.
    reportsCost: (src) => !/\.bind\([^)]*"\{\}"/s.test(src),
    remedy: 'bind a real cost in the `agent_runs` insert instead of the literal `"{}"`',
  },
];

/** Every tracked wrangler config — the only place a binding becomes real in a deployable scope. */
function wranglerConfigs(root: string): string[] {
  return execSync('git ls-files "*/wrangler.toml" "wrangler.toml"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** Configs declaring one of the given binding names, by `file:key`. Comment-stripped. */
function bindingsFor(root: string, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of wranglerConfigs(root)) {
    // A `# ANTHROPIC_API_KEY is CONFIRM-gated` note is documentation, not a binding (§674's cry-wolf shape).
    const live = readFileSync(`${root}/${f}`, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, ""))
      .join("\n");
    for (const k of keys) if (live.includes(k)) out.push(`${f}:${k}`);
  }
  return out;
}

/** Every `*_MODEL` binding the source actually reads — the population, derived rather than listed. */
function declaredModelKeys(root: string): string[] {
  // `src/**/*.ts` requires at least one subdirectory, so it MISSES `workers/agents/src/index.ts` — where
  // ANTHROPIC_MODEL lives. Measured: the narrow glob found 2 of 3 keys. The non-vacuity floor below caught
  // it, which is the whole argument for §610's rule that a selector needs its own floor.
  const files = execSync('git ls-files "workers/**/*.ts" "packages/**/*.ts"', {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && !f.includes(".test."));
  const keys = new Set<string>();
  for (const f of files) {
    const src = stripComments(readFileSync(`${root}/${f}`, "utf8"));
    for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]*_MODEL)\b/g)) keys.add(m[1]!);
  }
  return [...keys].sort();
}

describe("REQ-118 §679/§680/§681: every LLM-calling agent's metering trigger is enforced, not hoped", () => {
  const root = repoRoot();

  it("finds the wrangler configs at all (non-vacuity — a dormant gate must not be a broken one)", () => {
    // Without this, renaming the configs would make every binding scan permanently empty and every
    // conditional below permanently true — PASS forever, on the day it matters most.
    expect(
      wranglerConfigs(root).length,
      "no wrangler.toml files found — this gate cannot see a binding, so its silence means nothing",
    ).toBeGreaterThanOrEqual(4);
  });

  it("LLM_AGENTS covers EVERY model binding the source reads (§681 — the roster is derived, not listed)", () => {
    // §671's completeness floor, and the reason this gate is trustworthy at all. §679 listed one agent,
    // §680 found a second by reading an ops doc, §681 found a third by deriving the population — the list
    // was wrong twice in two phases. A hand-maintained roster of a set the code defines is the wrong shape;
    // this assertion is what makes the next addition loud instead of silent.
    const declared = declaredModelKeys(root);
    expect(declared.length, "no *_MODEL bindings found in source — the scan broke, the code did not").toBeGreaterThanOrEqual(3);
    expect(
      declared,
      "a `*_MODEL` binding exists that LLM_AGENTS does not cover. Every one of them selects an LLM adapter, " +
        "so every one turns some agent from deterministic to cost-bearing. Add it with the file that carries " +
        "its cost reporting and the predicate that detects it:\n  " +
        declared.join("\n  "),
    ).toEqual(LLM_AGENTS.map((a) => a.modelKey).sort());
  });

  it.each(LLM_AGENTS)("if $name's model binding appears, $name must report a real cost", ({ name, file, modelKey, reportsCost, remedy }) => {
    const bound = bindingsFor(root, [API_KEY, modelKey]);
    if (bound.length === 0) return; // dormant, as recorded in §135.1 — the hold has not expired

    // stripComments is correct HERE and only here: this is TypeScript, where `//` outside a string is a
    // comment. §674 pinned the boundary — it must not be reused on a CSS-scanning gate. It matters because
    // concierge.ts mentions `agent.acted` TWICE, in comments explaining that it does NOT emit one.
    const src = stripComments(readFileSync(`${root}/${file}`, "utf8"));
    expect(
      reportsCost(src),
      `${modelKey} / ${API_KEY} is now bound (${bound.join(", ")}), so ${name} calls an LLM and its cost is ` +
        `variable. It still reports no cost, so REQ-113's budget-drift alarm averages every agent whose cost ` +
        `CANNOT drift while remaining blind to the ones whose cost can. §135's dormant gap is waking up — ${remedy}`,
    ).toBe(true);
  });

  it.each(LLM_AGENTS)("$name still does not report, so this gate still has a subject", ({ name, file, reportsCost }) => {
    // §"record holds with expiry triggers": if an agent starts reporting on its own, its row here guards
    // nothing and should be removed rather than left as a green check nobody can explain.
    const src = stripComments(readFileSync(`${root}/${file}`, "utf8"));
    expect(
      reportsCost(src),
      `${name} now reports a real cost — §135's gap is closed for it on its own terms. Drop it from ` +
        "LLM_AGENTS and say so in the audit, rather than leaving a check that guards nothing",
    ).toBe(false);
  });
});
