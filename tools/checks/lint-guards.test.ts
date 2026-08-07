import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

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
