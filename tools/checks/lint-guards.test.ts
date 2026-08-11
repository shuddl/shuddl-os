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
  // §1053 — EXPLICIT TIMEOUT. Measured 2426ms, which is 49% of vitest's 5000ms
  // default — §1052's flake was an assertion at 5080ms against that same default, and the only thing
  // separating this test from that one is load. It spawns a real eslint run over a planted fixture, so the cost is
  // inherent. 30s follows the convention already set at cwd-parity.test.ts (120_000 for an 11.5s test):
  // a test whose runtime is a known multiple of seconds should say so where it is written, rather than
  // relying on a global bound chosen for the other 1,231 tests.
  it("flags an LLM SDK import in the ledger package", async () => {
    const messages = await lintVirtualFile(
      ANCHORS.ledger,
      'import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(true);
  }, 30_000);
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
// ── §835 — A MODULE THAT CLAIMS PURITY MUST BE UNDER A DETERMINISM BAN ────────────────────────────────
//
// §283/§284/§285 enforced "no Date, no random" where the claim first appeared — the rater, the ledger gates,
// agents and adapters. §835 swept for the rest and found five more in `packages/ledger` and two in the
// translator's pure core, all claiming it and none enforced. Those globs are now in `eslint.config.mjs`.
//
// This is the discovery half, so the NEXT one is caught by a gate rather than by a sweep. It looks for a
// module-level purity claim in a file header and requires the path to fall under one of the determinism
// globs — the §802/§824 shape, applied to a claim rather than to a code pattern.

const DETERMINISM_GLOBS = [
  "packages/rater/",
  "packages/ledger/src/gates/",
  "packages/ledger/src/contacts.ts",
  "packages/ledger/src/geo/",
  "packages/ledger/src/money/",
  "packages/agents/",
  "packages/adapters/",
  "workers/translator/src/core/build-214.ts",
  "workers/translator/src/core/quarantine.ts",
  "packages/ledger/src/gl/iif.ts",
] as const;

/**
 * Files whose purity sentence describes something OTHER than the module. Each carries what it actually
 * claims, because the distinction is the whole reason they are not banned.
 */
const SCOPED_CLAIMS: Record<string, string> = {
  "workers/agents/src/biller.ts":
    'the claim is about the DERIVED ID — "deterministically derived from the POD event id (no Date, no random)" — not the module, which is a worker that reads D1 and R2 by design. It also does `new Date(epochMs).toISOString()`, a pure conversion.',
  "workers/agents/src/booking.ts":
    'same shape: the id is derived from the quote.accepted event id "(no Date, no random)". The worker itself does I/O.',
  "workers/agents/src/concierge.ts":
    'same shape: ids derived from the message event id "(no Date, no random)".',
  "workers/billing/src/billing.ts":
    'the phrase "no clock read" sits on a SCHEMA FIELD (`created: unix seconds — the event\'s business clock`), not on the module. The module INJECTS its clock — `this.now = options.now ?? (() => Date.now())` — which is the correct pattern, not a purity claim (§844).',
  "workers/billing/src/credits.ts":
    "matched on a determinism word in prose, not a module-level purity claim; the module is a Stripe webhook consumer and does I/O by design.",
};

describe("§835: every module claiming PURE/deterministic is under a determinism ban", () => {
  const root = repoRoot();

  it("the claim scan finds the modules it is supposed to (non-vacuity)", () => {
    const claiming = purityClaimants(root);
    // Measured at §835: 25 claiming modules. A scan returning nothing would make the assertion below vacuous.
    expect(claiming.length, "no purity claims found at all — the scan broke, not the tree").toBeGreaterThanOrEqual(15);
    expect(claiming).toContain("packages/rater/src/engine.ts");
  });

  it("no module claims purity outside a determinism glob", () => {
    const novel = purityClaimants(root)
      .filter((f) => !DETERMINISM_GLOBS.some((g) => f.startsWith(g)))
      .filter((f) => !(f in SCOPED_CLAIMS));
    expect(
      novel,
      "a module's header claims it is PURE / has no Date / no random, and no eslint block enforces that. " +
        "The claim is then a sentence, and the next edit can quietly add an ambient clock — which is how a " +
        "gate becomes untestable without freezing time. Add the path to a determinism block in " +
        "eslint.config.mjs (mind §815: an overlapping scope REPLACES options), or — if the sentence " +
        "describes something narrower than the module, such as a derived id — record it in SCOPED_CLAIMS " +
        "with what it actually claims:\n  " +
        novel.join("\n  "),
    ).toEqual([]);
  });

  it("every SCOPED_CLAIMS entry still exists and still claims something (no stale exemption)", () => {
    const claiming = new Set(purityClaimants(root));
    for (const f of Object.keys(SCOPED_CLAIMS)) {
      expect(claiming, `${f} no longer carries a purity sentence — drop this exemption (§672: no exemption outlives its subject)`).toContain(f);
    }
  });
});

/** Prod modules whose first ~3k of source carries a purity/determinism claim. */
function purityClaimants(root: string): string[] {
  return execSync('git ls-files "packages" "workers"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && !f.includes("/test/"))
    .filter((f) => /PURE and DETERMINISTIC|no Date, no random|no D1, no R2, no Date|no clock/i.test(readFileSync(`${root}/${f}`, "utf8").slice(0, 3000)));
}
