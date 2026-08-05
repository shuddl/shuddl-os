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
      // DETERMINISM, the other half of the same claim (audit §283). `check:rater-purity` bans LLM imports
      // and the global above bans `fetch`; both are the I/O half. The rater's own header says "PURE and
      // DETERMINISTIC (no LLM/I/O/Date/random)" and the gates say "no D1, no R2, no Date, no random" — but
      // nothing enforced the clock/randomness half. Measured at zero hits when this landed, so this changes
      // no code; it stops the NEXT edit. Syntax selectors rather than no-restricted-globals so a `Date` used
      // as a TYPE stays legal.
      "no-restricted-syntax": [
        "error",
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: "REQ-004/REQ-024: an ambient clock is not deterministic — take the instant as a parameter (the callers already inject one).",
        },
        {
          selector: 'MemberExpression[object.name="Date"][property.name="now"]',
          message: "REQ-004/REQ-024: an ambient clock is not deterministic — take the instant as a parameter (the callers already inject one).",
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message: "REQ-004/REQ-024: randomness is not reproducible — derive ids deterministically (see the Biller id law).",
        },
      ],
    },
  },
  {
    // REQ-024 / the gate-purity claim (audit §283). transition-gates.ts states it outright: "pure
    // deterministic decisions over (prior events, incoming event, context) — no D1, no R2, no Date, no
    // random, no LLM". That is what makes the whole gate catalog unit-testable without a database, and it
    // is the property the sequencer relies on when it loads `prior` and calls a gate. The impure inputs are
    // supplied BY THE CALLER (the clock is passed in), so an ambient one here would silently reintroduce the
    // dependency the design removed. Measured at zero hits when this landed: it changes no code, it stops
    // the next edit. Scoped to the gates subtree — the wider ledger has legitimate clock use (anchoring,
    // TSA) — and expressed as syntax selectors so `Date` in a TYPE position stays legal.
    files: ["packages/ledger/src/gates/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: "REQ-024: gates are pure — the caller supplies the clock; an ambient one breaks the property that makes the catalog testable without a DB.",
        },
        {
          selector: 'MemberExpression[object.name="Date"][property.name="now"]',
          message: "REQ-024: gates are pure — the caller supplies the clock; an ambient one breaks the property that makes the catalog testable without a DB.",
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message: "REQ-024: gates are pure — a gate decision must be reproducible from its inputs alone.",
        },
      ],
    },
  },
  {
    // The SAME determinism claim, in the two packages that also make it (audit §284). §283 enforced it where
    // it first turned up — the rater and the gates — which is the per-FILE fix §262 warns about: eight files
    // across these two packages carry the identical sentence ("no Date, no random"; migrator adds "no
    // crypto"), and none was covered. `aging.ts` states the design the ban protects: "the sweep supplies
    // `nowMs`; nothing here reads a fresh Date." Composition and rendering are pure functions of their
    // inputs, which is what makes an agent's output reproducible from a recorded event — the property the
    // Biller's deterministic-id law depends on. Measured at ZERO hits across both packages when this landed,
    // so it changes no code. Syntax selectors so a `Date` TYPE stays legal.
    files: ["packages/agents/**/*.ts", "packages/agents/**/*.tsx", "packages/adapters/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: "REQ-024: this layer is deterministic — the caller supplies the instant (see aging.ts: 'the sweep supplies nowMs').",
        },
        {
          selector: 'MemberExpression[object.name="Date"][property.name="now"]',
          message: "REQ-024: this layer is deterministic — the caller supplies the instant (see aging.ts: 'the sweep supplies nowMs').",
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message: "REQ-024: randomness is not reproducible — a redelivered message must recompose the SAME output (the Biller id law).",
        },
      ],
    },
  },
);
