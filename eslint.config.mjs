import tseslint from "typescript-eslint";

export default tseslint.config(
  // shuddl-site/ is a separate, untracked sub-project with its own toolchain (Next.js + its own
  // eslint-plugin-react) — the monorepo's flat config must not try to lint it (it crashes on the
  // version-detection mismatch). It lints itself.
  // .claude/skills/** are governance/guidance docs (like CLAUDE.md), not build source. Their SKILL.md
  // reference snippets ship illustrative .ts/.sql that intentionally won't typecheck standalone — the
  // build linter must not gate on them.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "genesis/**", "fixtures/**", "docs/**", "seed/**", "apps/*/public/**", "shuddl-site/**", "marketing-site/**", ".agents/**", ".claude/**"] },
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
      // REQ-024, the OTHER half (audit §53). The import ban above cannot see a raw HTTP call: a model is
      // reachable with `fetch("https://api.anthropic.com/v1/messages")` and no import at all, and the lint
      // would have passed it. `fetch` is the only network primitive in a Worker, so banning the global closes
      // that route for the realistic case — a well-meaning "just ask the model to classify this event".
      // It does not stop deliberate obfuscation; that is true of every lint here and is not the threat model.
      //
      // The ledger has exactly ONE sanctioned egress, exempted below: the RFC 3161 trusted-timestamp client.
      // Keeping the ban package-wide with a single named exception is the point — it makes that egress the
      // only one, visibly, so a second one cannot appear without editing this file and explaining itself.
      "no-restricted-globals": ["error", { name: "fetch", message: "REQ-024: the ledger's only sanctioned network egress is the RFC 3161 TSA client (src/tsa/**). An LLM is reachable by raw fetch with no import — do model work in packages/agents." }],
    },
  },
  {
    // The one exception, and the reason it is safe: HttpTsaClient takes `fetchImpl: typeof fetch = fetch`,
    // so every caller can inject a stub and the default is only a convenience. It talks to a timestamp
    // authority — a protocol with a verified response (imprint + nonce are checked against what was sent),
    // not a model. Scoped to the subtree, so the ban still holds across the rest of the package.
    files: ["packages/ledger/src/tsa/**/*.ts"],
    rules: { "no-restricted-globals": "off" },
  },
  {
    // REQ-004 + REQ-024 mirrored for the rater, which is network-free outright (no `fetch` token anywhere in
    // its src). `check:rater-purity` bans LLM/agent IMPORTS here; this closes the same raw-HTTP route that
    // the ledger ban above closes. The rater is a deterministic engine — a price that depends on a network
    // call is not reproducible, which is a REQ-004 problem before it is ever an LLM problem.
    files: ["packages/rater/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "REQ-004/REQ-024: the rater is a deterministic, network-free engine — no fetch. A price that depends on a network call is not reproducible." }],
    },
  },
);
