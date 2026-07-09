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
