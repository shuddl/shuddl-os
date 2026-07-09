import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "genesis/**", "fixtures/**", "docs/**", "seed/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // REQ-163: prior codebases (pre-genesis TMS builds, 2023 apps) are organ banks — reference, never merge.
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["*lumina*", "*Lumina*", "*shuddl-2023*"], message: "REQ-163: prior codebases are organ banks — no code merges into the spine." }],
      }],
    },
  },
  {
    // REQ-024: LLMs never write ledger truth — statically banned from the ledger package.
    files: ["packages/ledger/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["*lumina*", "*Lumina*", "*shuddl-2023*"], message: "REQ-163: organ bank only." },
          { group: ["@anthropic-ai/*", "anthropic*", "openai*", "@openai/*", "ai", "@ai-sdk/*", "@shuddl/agents*", "*agents*"], message: "REQ-024: LLMs never write ledger truth — no LLM/agent imports in packages/ledger." },
        ],
      }],
    },
  },
);
