import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";

// The lint target must be a path that EXISTS (§566). These tests pass SYNTHETIC code under a real path so
// ESLint applies the config blocks that path selects — but §566 added type-aware rules scoped to
// `workers/*/src/**` and `packages/*/src/**`, and typescript-eslint's project service cannot type a file that
// is not on disk: a made-up `violation.ts` returns `Parsing error: ... was not found by the project service`
// INSTEAD of the rule violations, so every assertion below silently inverted. Five of these seven tests went
// red the moment that block landed, which is how the constraint was found.
//
// So each anchor is a real file in the directory whose rules are under test. The code linted is still
// synthetic — only the PATH has to be real.
const ANCHORS = {
  ledger: "packages/ledger/src/anchor.ts",
  ledgerTsa: "packages/ledger/src/tsa/client.ts",
  rater: "packages/rater/src/anomaly.ts",
  contracts: "packages/contracts/src/entitlements.ts",
  agents: "workers/agents/src/biller.ts",
} as const;

async function lintVirtualFile(filePath: string, code: string) {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
}

describe("REQ-118 §566: the lint anchors are real files", () => {
  it("every anchor exists — a renamed anchor must fail HERE, not as an inverted assertion below", () => {
    const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
    const missing = Object.entries(ANCHORS).filter(([, path]) => !existsSync(`${root}/${path}`));
    expect(
      missing.map(([k, path]) => `${k} → ${path}`),
      "a lint anchor no longer exists; point it at another real file in the SAME directory",
    ).toEqual([]);
  });
});

describe("REQ-024: no LLM imports inside packages/ledger", () => {
  it("flags an LLM SDK import in the ledger package", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.ledger,
      'import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(true);
  });
  it("allows the same import outside the ledger package", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.agents,
      'import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(false);
  });
});

// Audit §53. The import ban above is blind to a raw HTTP call — `fetch("https://api.anthropic.com/…")`
// reaches a model with no import at all. These pin the global ban that closes it, INCLUDING its one
// exemption: a rule whose exception is untested is a rule that can silently become no rule at all.
describe("REQ-024: the raw-fetch route to a model is closed too", () => {
  it("flags a raw fetch in the ledger core — no import needed to reach a model", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.ledger,
      'export const go = async () => (await fetch("https://api.anthropic.com/v1/messages")).status;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(true);
  });

  it("ALLOWS fetch inside src/tsa/** — the RFC 3161 timestamp client is the ledger's one sanctioned egress", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.ledgerTsa,
      'export const go = async (u: string) => (await fetch(u, { method: "POST" })).status;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(false);
  });

  it("flags a fetch in the rater — a price that depends on a network call is not reproducible (REQ-004)", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.rater,
      'export const go = async () => (await fetch("https://example.test/rate")).status;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-004"))).toBe(true);
  });
});

describe("REQ-163: prior codebases are organ banks — never imported", () => {
  it("flags any prior-TMS import anywhere", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.rater,
      'import { thing } from "lumina-tms/rating";\nexport const x = thing;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-163"))).toBe(true);
  });

  // §814 — THE BAN MUST ALSO REACH `packages/ledger`, AND THAT IS NOT AUTOMATIC.
  //
  // ESLint flat config is LAST-WRITER-WINS per rule NAME: the `packages/ledger/**` block re-declares
  // `no-restricted-imports` for REQ-024, which REPLACES the repo-wide options rather than merging them. That
  // is why the REQ-163 patterns are written TWICE — the ledger copy exists only to survive its own override.
  //
  // MEASURED (§814): adding a fourth prior-codebase pattern to the GLOBAL group and not the ledger's left
  // `test:tools` at its 3-failure baseline, and a probe file proved the consequence rather than inferring it —
  // the same import reported REQ-163 in `packages/contracts` and **ZERO hits in `packages/ledger`**. The
  // append-only event spine, the one package CLAUDE.md singles out, would be the only place the new ban did
  // not apply.
  //
  // Two halves, because neither is sufficient: parity catches a pattern added to one list and not the other;
  // the behavioural test catches both lists being wrong together.
  it("§814: every REQ-163 pattern in the repo-wide group is also in the ledger's override", () => {
    const cfg = readFileSync(`${repoRoot()}/eslint.config.mjs`, "utf8");
    // THREE blocks re-declare `no-restricted-imports` and therefore each needs its own copy: the repo-wide
    // one, `packages/ledger/**`, and `packages/adapters/**` + `packages/edi/**`. (My first cut asserted TWO
    // and failed on a clean tree — the fixed point catching an instrument error, §"keep a fixed point".)
    const groups = [...cfg.matchAll(/group:\s*\[([^\]]*)\],\s*message:\s*"REQ-163[^"]*"/g)].map((m) =>
      [...m[1]!.matchAll(/"([^"]+)"/g)].map((q) => q[1]!),
    );
    expect(
      groups.length,
      "expected every REQ-163 pattern group — repo-wide plus one per scoped override that re-declares " +
        "no-restricted-imports. If a block was added or removed, this count is the prompt to re-check that " +
        "the new block carries the patterns too.",
    ).toBe(3);
    const [wide, ...overrides] = groups as [string[], ...string[][]];
    const missing = overrides.flatMap((o, i) => wide.filter((p) => !o.includes(p)).map((p) => `override #${i + 1}: ${p}`));
    expect(
      missing,
      "a prior-codebase pattern is banned repo-wide but NOT in a scoped override. ESLint flat config replaces " +
        "a named rule's options rather than merging them, so that scope — one of which is packages/ledger, the " +
        "append-only event spine — would be where the import is still legal. Add it to every group.",
    ).toEqual([]);
  });

  // §815 — THE SAME REPLACEMENT HAZARD FOR `no-restricted-syntax`, where two blocks BOTH cover
  // `packages/adapters/**`.
  //
  // §814 fixed `no-restricted-imports`. Sweeping every multiply-declared rule NAME found two more:
  // `no-restricted-globals` (three blocks, DISJOINT scopes — no replacement possible) and
  // `no-restricted-syntax`, where `packages/adapters/**` appears in TWO blocks: one shared with
  // `packages/agents/**`, and a later adapters-only one.
  //
  // Last-writer-wins means the adapters-only block REPLACES the shared one for adapters. MEASURED: it is a
  // strict SUPERSET today — the same three determinism selectors plus `crypto.randomUUID` — so adapters is
  // deliberately STRICTER than agents and nothing is lost. That is correct by construction and was NOT a
  // defect.
  //
  // What nothing checked is that it STAYS a superset. Removing a selector from the adapters-only block would
  // silently give `packages/adapters/**` a WEAKER rule than the block it overrides, and the shared block's
  // presence would make it look covered.
  it("§815: the adapters-only no-restricted-syntax block is a SUPERSET of the shared one it replaces", () => {
    const cfg = readFileSync(`${repoRoot()}/eslint.config.mjs`, "utf8");
    // Each rule body ends at a 6-space `],`; the owning scope is the NEAREST PRECEDING `files:`. My first cut
    // used a 4-space terminator, matched zero blocks, and failed on a clean tree — the same instrument error
    // as §814's, caught the same way.
    const blocks = [...cfg.matchAll(/"no-restricted-syntax":\s*\[([\s\S]*?)\n      \],/g)]
      .map((m) => {
        const before = cfg.slice(0, m.index);
        const scopes = [...before.matchAll(/files:\s*\[([^\]]*)\]/g)];
        return {
          files: scopes.length > 0 ? scopes[scopes.length - 1]![1]! : "(repo-wide)",
          selectors: [...m[1]!.matchAll(/selector:\s*'([^']+)'/g)].map((x) => x[1]!),
        };
      })
      .filter((b) => b.files.includes("packages/adapters/"));
    expect(
      blocks.length,
      "expected exactly TWO no-restricted-syntax blocks covering packages/adapters — the shared agents+adapters " +
        "one and the adapters-only override. If that changed, re-check which block wins for adapters.",
    ).toBe(2);
    const shared = blocks[0]!;
    const adaptersOnly = blocks[1]!;
    expect(
      shared.selectors.filter((sel) => !adaptersOnly.selectors.includes(sel)),
      "the adapters-only no-restricted-syntax block has become WEAKER than the shared block it replaces. " +
        "ESLint flat config replaces a rule's options rather than merging, so packages/adapters would lose " +
        "that selector while the shared block makes it look covered. Keep the override a superset.",
    ).toEqual([]);
  });

  it("§814: a prior-codebase import into packages/ledger is flagged (the half parity cannot see)", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.ledger,
      'import { thing } from "lumina-tms/rating";\nexport const x = thing;\n',
    );
    expect(
      messages.some((m) => m.message.includes("REQ-163")),
      "the REQ-163 ban does not reach packages/ledger — its no-restricted-imports override has replaced the " +
        "repo-wide rule without carrying the prior-codebase patterns.",
    ).toBe(true);
  });
});

describe("no-explicit-any is an error everywhere", () => {
  it("flags any", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.contracts,
      "export const x: any = 1;\n",
    );
    expect(messages.some((m) => m.ruleId === "@typescript-eslint/no-explicit-any")).toBe(true);
  });
});

// REQ-118 §566 — ASYNC CORRECTNESS IS TYPE-AWARE AND ON.
//
// A floating promise inside a Worker is the silent-failure class at its purest: the isolate returns the
// response and is torn down, so the work never happens — no error, no log, no retry, nothing to grep for.
// The base preset (`tseslint.configs.recommended`) cannot catch it: these rules need TYPE information.
//
// Measured before enabling: 215 files across workers/*/src and packages/*/src produced ZERO violations, so
// this locks in a clean state rather than fixing a defect. That is exactly the case that needs a test —
// nothing is failing today, so nothing else would notice the rule being dropped.
describe("REQ-118 §566: no-floating-promises is enabled for worker + package source", () => {
  it("flags an unawaited promise in a worker src file", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.agents,
      "export async function work(): Promise<void> {\n  Promise.resolve(1);\n}\n",
    );
    expect(
      messages.some((m) => m.ruleId === "@typescript-eslint/no-floating-promises"),
      `a floating promise was not flagged — messages: ${messages.map((m) => m.ruleId).join(", ") || "none"}`,
    ).toBe(true);
  });

  it("flags an unawaited promise in a package src file too", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.ledger,
      "export async function work(): Promise<void> {\n  Promise.resolve(1);\n}\n",
    );
    expect(messages.some((m) => m.ruleId === "@typescript-eslint/no-floating-promises")).toBe(true);
  });

  it("does NOT flag a correctly awaited promise (the rule is not a blanket ban)", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.agents,
      "export async function work(): Promise<void> {\n  await Promise.resolve(1);\n}\n",
    );
    expect(messages.some((m) => m.ruleId === "@typescript-eslint/no-floating-promises")).toBe(false);
  });
});
