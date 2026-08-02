import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

async function lintVirtualFile(filePath: string, code: string) {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
}

describe("REQ-024: no LLM imports inside packages/ledger", () => {
  it("flags an LLM SDK import in the ledger package", async () => {
    const messages = await lintVirtualFile(
      "packages/ledger/src/violation.ts",
      'import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(true);
  });
  it("allows the same import outside the ledger package", async () => {
    const messages = await lintVirtualFile(
      "workers/agents/src/ok.ts",
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
      "packages/ledger/src/violation.ts",
      'export const go = async () => (await fetch("https://api.anthropic.com/v1/messages")).status;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(true);
  });

  it("ALLOWS fetch inside src/tsa/** — the RFC 3161 timestamp client is the ledger's one sanctioned egress", async () => {
    const messages = await lintVirtualFile(
      "packages/ledger/src/tsa/client.ts",
      'export const go = async (u: string) => (await fetch(u, { method: "POST" })).status;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-024"))).toBe(false);
  });

  it("flags a fetch in the rater — a price that depends on a network call is not reproducible (REQ-004)", async () => {
    const messages = await lintVirtualFile(
      "packages/rater/src/violation.ts",
      'export const go = async () => (await fetch("https://example.test/rate")).status;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-004"))).toBe(true);
  });
});

describe("REQ-163: prior codebases are organ banks — never imported", () => {
  it("flags any prior-TMS import anywhere", async () => {
    const messages = await lintVirtualFile(
      "packages/rater/src/violation.ts",
      'import { thing } from "lumina-tms/rating";\nexport const x = thing;\n',
    );
    expect(messages.some((m) => m.message.includes("REQ-163"))).toBe(true);
  });
});

describe("no-explicit-any is an error everywhere", () => {
  it("flags any", async () => {
    const messages = await lintVirtualFile(
      "packages/contracts/src/violation.ts",
      "export const x: any = 1;\n",
    );
    expect(messages.some((m) => m.ruleId === "@typescript-eslint/no-explicit-any")).toBe(true);
  });
});
