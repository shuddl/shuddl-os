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

  it("§989: `no-restricted-globals` scopes stay DISJOINT — the reason it needs no inheritance rule", () => {
    // THE THIRD RULE NAME IN THE SAME FAMILY, and the only one with no inheritance hazard — because its
    // blocks never overlap. §815 recorded that as prose ("three blocks, DISJOINT scopes — no replacement
    // possible") and nothing kept it true.
    //
    // It matters more than the other two: this is where REQ-024's `fetch` ban lives. A fourth block scoped to
    // anything broader — `packages/**`, or a second ledger scope — would REPLACE the ledger's entry and delete
    // the ban that makes the RFC-3161 TSA client the ledger's only network egress. No lint would fail; the
    // rule name would simply resolve to someone else's options.
    //
    // MEASURED AT §989 — and §815's prose was slightly wrong. There are FOUR declarations, not three, and
    // two of them OVERLAP:
    //
    //     packages/ledger/**          fetch banned (REQ-024)
    //     packages/ledger/src/tsa/**  "no-restricted-globals": "off"   ← overlaps the line above, ON PURPOSE
    //     packages/driver-core/**     fetch/timers/DOM banned
    //     packages/rater/**           fetch banned (REQ-004/024)
    //
    // The overlap is the SANCTIONED EXCEPTION, not a defect: the TSA subtree is the ledger's one permitted
    // egress, and last-writer-wins is exactly the mechanism granting it. The config says why it is safe —
    // `HttpTsaClient` takes an injectable `fetchImpl`, and a timestamp authority's response is verified
    // (imprint + nonce), so it is a protocol, not a model.
    //
    // So the property is not "disjoint" but "the ONLY overlap is the named TSA exemption". General
    // glob-overlap is undecidable here, so this asserts the INPUTS to that judgement — the exact scope list,
    // in order. Any addition, removal or reorder fails, and whoever made it re-runs the argument rather than
    // inheriting a claim from 2026-08. A second `"off"` appearing in this list is the thing to fear.
    const scopes = [...cfg.matchAll(/"no-restricted-globals":/g)].map((m) => {
      const before = cfg.slice(0, m.index);
      const files = [...before.matchAll(/files:\s*\[([^\]]*)\]/g)];
      return (files.length > 0 ? (files[files.length - 1]?.[1] ?? "") : "(repo-wide)").replace(/\s+/g, " ").trim();
    });
    expect(scopes.length, "no no-restricted-globals blocks parsed — the scan is broken, not the config").toBeGreaterThanOrEqual(3);
    expect(
      scopes,
      "the `no-restricted-globals` scope set changed. It is the one rule in this family with NO inheritance " +
        "gate, and that is only safe while its blocks are disjoint. Re-check that no two scopes can match the " +
        "same file — especially against `packages/ledger/**`, whose entry is REQ-024's `fetch` ban (the TSA " +
        "client is the ledger's only sanctioned egress). If they now overlap, the later block must restate the " +
        "earlier's bans, exactly as §988 requires for no-restricted-syntax.",
    ).toEqual([
      '"packages/ledger/**/*.ts"',
      '"packages/ledger/src/tsa/client.ts"', // §1050 — NARROWED from the `**/*.ts` subtree to the one file
      // that actually holds the exemption's subject (`fetchImpl: typeof fetch = fetch` at client.ts:76).
      // The subtree form let a planted `tsa/__p.ts` with a raw fetch lint GREEN with no config edit,
      // falsifying the config's own promise that a second egress "cannot appear without editing this
      // file and explaining itself". cms.ts and der.ts have zero network tokens, so the narrowing is free.
      '"packages/driver-core/**/*.ts"',
      '"packages/rater/**/*.ts"',
    ]);
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
