import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §988 — A SCOPED `no-restricted-syntax` BLOCK MUST RESTATE THE REPO-WIDE BANS IT REPLACES.
//
// ESLint flat config is last-writer-wins per rule NAME. A block that declares `no-restricted-syntax` for its
// own reasons — determinism selectors, a clock ban — silently DELETES every repo-wide selector of that name
// for the files it matches. The config reads as additive; it is substitutive, and the loser is the earlier,
// broader statement that nobody is looking at while editing a scoped block.
//
// This repo already gates two edges of that hazard:
//   §814  no-restricted-imports: repo-wide REQ-163 patterns must appear in every scoped override.
//   §815  no-restricted-syntax: the adapters-only block must be a SUPERSET of the shared agents+adapters one.
//
// The edge between them had no gate, and it bit four times in three phases (§986 ×2, §987, and the sweep
// below). MEASURED AT §988 by planting `await import("lumina-core")` in each scope that declares its own
// syntax block — the repo-wide REQ-163 dynamic ban was DELETED for:
//
//     packages/rater/**            HOLE
//     packages/agents/**           HOLE
//     packages/ledger/src/gates/** HOLE
//     packages/contracts/**        caught (no scoped block — the control)
//
// A parse alone would have over-reported: it predicted five holes and the probe found three, because a
// declared block only replaces for files it actually matches. The behavioural check is the authority; this
// gate is the cheap standing approximation of it.
//
// THE RULE: every `no-restricted-syntax` block restates the repo-wide ImportExpression bans. Restating a ban
// can never weaken a scope, so the rule is safe to apply uniformly — no judgement, no exemption list, and
// therefore nothing to rot.

const CFG = "eslint.config.mjs";

interface Block {
  scope: string;
  selectors: string[];
}

/** Every `no-restricted-syntax` block, with the nearest preceding `files:` as its scope (§815's method). */
function syntaxBlocks(cfg: string): Block[] {
  return [...cfg.matchAll(/"no-restricted-syntax":\s*\[([\s\S]*?)\n {6}\],/g)].map((m) => {
    const before = cfg.slice(0, m.index);
    const scopes = [...before.matchAll(/files:\s*\[([^\]]*)\]/g)];
    return {
      scope: scopes.length > 0 ? (scopes[scopes.length - 1]?.[1] ?? "").replace(/\s+/g, " ").trim() : "(repo-wide)",
      selectors: [...(m[1] ?? "").matchAll(/selector:\s*'([^']+)'/g)].map((x) => x[1] as string),
    };
  });
}

describe("§988: a scoped no-restricted-syntax block restates the repo-wide bans it replaces", () => {
  const cfg = readFileSync(`${repoRoot()}/${CFG}`, "utf8");
  const blocks = syntaxBlocks(cfg);
  const wide = blocks.find((b) => b.scope === "(repo-wide)");

  it("finds the blocks and a repo-wide one (non-vacuity — §968's rule)", () => {
    // Without this, a reformatted config yields zero blocks and the rule below passes over nothing, which is
    // the exact silence this session has spent forty phases on.
    expect(blocks.length, `no no-restricted-syntax blocks parsed from ${CFG} — the scan is broken`).toBeGreaterThanOrEqual(5);
    expect(wide, `no repo-wide no-restricted-syntax block found in ${CFG} — if the repo-wide bans moved into a scoped block, this gate must be re-scoped deliberately`).toBeDefined();
  });

  it("every scoped block carries the repo-wide ImportExpression bans", () => {
    const required = (wide?.selectors ?? []).filter((s) => s.startsWith("ImportExpression"));
    expect(required.length, "the repo-wide block declares no ImportExpression ban — has REQ-163's dynamic half been removed?").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const b of blocks) {
      if (b.scope === "(repo-wide)") continue;
      for (const sel of required) {
        if (!b.selectors.includes(sel)) missing.push(`${b.scope.slice(0, 56)} → ${sel.slice(0, 48)}`);
      }
    }
    expect(
      missing,
      "scoped `no-restricted-syntax` block(s) that DELETE a repo-wide ban by declaring the rule name:\n  " +
        missing.join("\n  ") +
        "\n\nESLint flat config replaces a named rule's options rather than merging them, so declaring " +
        "`no-restricted-syntax` for a scope drops every repo-wide selector for those files. MEASURED (§988): " +
        '`await import("lumina-core")` passed in packages/rater, packages/agents and packages/ledger/src/gates ' +
        "while being caught in packages/contracts. Restate the selector in the scoped block — restating can " +
        "never weaken a scope, so there is no case where omitting it is correct.",
    ).toEqual([]);
  });
});
