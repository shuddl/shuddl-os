import tseslint from "typescript-eslint";

export default tseslint.config(
  // shuddl-site/ is a separate, untracked sub-project with its own toolchain (Next.js + its own
  // eslint-plugin-react) — the monorepo's flat config must not try to lint it (it crashes on the
  // version-detection mismatch). It lints itself.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "genesis/**", "fixtures/**", "docs/**", "seed/**", "apps/*/public/**", "shuddl-site/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // Honor the `_`-prefix convention for intentionally-unused args/vars/catch bindings (e.g. a
      // reserved future-seam parameter like costBasis(_config)). Underscore = "deliberately unused".
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_",
      }],
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
