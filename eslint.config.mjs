import tseslint from "typescript-eslint";

export default tseslint.config(
  // shuddl-site/ is a separate, untracked sub-project with its own toolchain (Next.js + its own
  // eslint-plugin-react) — the monorepo's flat config must not try to lint it (it crashes on the
  // version-detection mismatch). It lints itself.
  // .claude/skills/** are governance/guidance docs (like CLAUDE.md), not build source. Their SKILL.md
  // reference snippets ship illustrative .ts/.sql that intentionally won't typecheck standalone — the
  // build linter must not gate on them.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "genesis/**", "fixtures/**", "docs/**", "seed/**", "shuddl-site/**", "marketing-site/**", ".agents/**", ".claude/**"] },
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
    // REQ-016/REQ-017 §620 — packages/driver-core IS THE OFFLINE PACKAGE, AND SAYS SO.
    //
    // `sync.ts` states the design in one line: "No DOM, no network, no timers here." The queue, the clock,
    // the jitter source and BOTH transports are injected; the package composes them. Measured at zero hits
    // across src AND test when this landed, so this changes no code — it stops the next edit, which is the
    // whole reason the ledger and rater blocks below exist.
    //
    // WHY THE NETWORK HALF MATTERS MOST: REQ-017's guarantee is that the evidence hash is computed AT
    // CAPTURE, before the bytes leave the device — that is what lets a device signature survive a driver
    // with no signal. §619 mutation-proved the hash is PRESENT (four tests went red when it was removed) and
    // then named the gap this closes: those tests assert presence, not ORDERING. A future edit that uploaded
    // bytes and hashed the response would keep all four green while inverting the guarantee. A package with
    // no `fetch` cannot invert it.
    //
    // The timer/DOM half is the determinism claim: an injected clock and jitter source are what make the
    // backoff tests (§579) reproducible rather than flaky.
    files: ["packages/driver-core/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "REQ-016/REQ-017: driver-core is the OFFLINE package — the transports are injected. A network call here can invert the hash-at-capture ordering that makes evidence trustworthy on a device with no signal." },
        { name: "setTimeout", message: "REQ-016: the clock and jitter source are injected — a real timer makes the backoff tests flaky and the offline queue untestable." },
        { name: "setInterval", message: "REQ-016: the clock and jitter source are injected — a real timer makes the backoff tests flaky and the offline queue untestable." },
        { name: "document", message: "driver-core is DOM-free; the PWA composes it (apps/driver owns the DOM)." },
        { name: "window", message: "driver-core is DOM-free; the PWA composes it (apps/driver owns the DOM)." },
      ],
    },
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
    // The translator's two PURE CORE modules (audit §835). `build-214.ts` opens "PURE: no D1/R2/network, no
    // Date, no random — deterministic given its inputs"; `quarantine.ts` says "PURE (REQ-204): a stable
    // synchronous hash — no Date, no random". Module-level claims, and nothing enforced them.
    //
    // A DELIBERATE SUBSET of the selector set used elsewhere: `NewExpression[callee.name="Date"]` is OMITTED
    // here, because `build-214.ts:72` does `new Date(e.ts).toISOString()` — converting an event's recorded
    // millisecond to wire format. That is a pure function of its argument and is exactly what the module
    // means by "no Date": no AMBIENT clock. Banning it would flag correct code and the block would be
    // deleted rather than obeyed.
    //
    // §815's rule applies to subsets in the dangerous direction, so it is stated rather than left to be
    // inferred: no other `no-restricted-syntax` block matches `workers/translator/**`, so this replaces
    // nothing — it is the only rule these files get, and it is narrower than the ledger/rater one ON PURPOSE.
    files: ["workers/translator/src/core/build-214.ts", "workers/translator/src/core/quarantine.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'MemberExpression[object.name="Date"][property.name="now"]',
          message: "REQ-204: this module's header claims PURE — an AMBIENT clock breaks the determinism the dedupe key depends on. `new Date(explicitMs)` is fine; reading the wall clock is not.",
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message: "REQ-204: this module's header claims PURE — its output must be reproducible from its inputs alone.",
        },
      ],
    },
  },
  {
    // The SAME determinism claim, in the five PURE LIBRARY modules of packages/ledger that also make it
    // (audit §835). §283/§284/§285 enforced it in the rater, the gates, agents and adapters. These five say
    // it too — `contacts.ts`, the three `geo/*` modules and `money/derive-split.ts` all open with "PURE" or
    // "no Date, no random" — and nothing enforced it.
    //
    // MEASURED before extending the ban, because a blanket `NewExpression[callee.name="Date"]` also flags the
    // legitimate `new Date(epochMs).toISOString()` CONVERSION, which is a pure function of its argument and is
    // why this ban is scoped rather than repo-wide (`workers/agents/src/biller.ts:158` and
    // `translator/core/build-214.ts:72` both do exactly that, correctly, outside these globs). All five of
    // these modules use no clock and no randomness at all today, so the ban costs them nothing and does the
    // one thing a lint rule can: it stops the NEXT edit.
    //
    // Selector set is IDENTICAL to the gates block below, not a superset — §815's lesson is that an
    // overlapping scope silently REPLACES options, and these paths carry no other `no-restricted-syntax`
    // block (`packages/ledger/**` declares only `no-restricted-imports`, `tsa/**` only
    // `no-restricted-globals`), so there is nothing here to replace.
    files: [
      "packages/ledger/src/contacts.ts",
      "packages/ledger/src/geo/**/*.ts",
      "packages/ledger/src/money/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: "REQ-024: this module's header claims PURE — the caller supplies the clock. An ambient one makes it untestable without freezing time.",
        },
        {
          selector: 'MemberExpression[object.name="Date"][property.name="now"]',
          message: "REQ-024: this module's header claims PURE — the caller supplies the clock. An ambient one makes it untestable without freezing time.",
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message: "REQ-024: this module's header claims PURE — its output must be reproducible from its inputs alone.",
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
  {
    // THE LAYERING HALF of the same claims (audit §285). §284 enforced the "no Date/no random" conjunct and
    // stopped there — but the sentences it swept are longer: migrator.ts says "no network, no D1, no ledger/
    // rater import" and "no Date, no crypto, no ledger"; edi/mapping.ts and edi/types.ts say "PURE: no I/O,
    // no ledger/rater". THREE files, TWO packages, and the ledger/rater/crypto conjuncts were unenforced.
    //
    // WHY IT IS A LAW, not a description: these modules are the pure header→field core, and the WORKER
    // (workers/api/routes/import.ts) persists by LOOPING THE EXISTING INTAKE VERBS. A ledger import here would
    // let the core reach persistence directly, around the verbs that carry the gates; a rater import would
    // price inside a mapper. `crypto` is banned for the same reason the clock is: "ids/timestamps are the
    // worker's job (this stays pure)" — a randomUUID in the mapper breaks the byte-identical-result promise
    // the docstring makes. check:chokepoint already catches a direct `INSERT INTO events`; nothing caught the
    // IMPORT, which is the layering violation that precedes it.
    //
    // MEASURED at zero hits across both packages INCLUDING their tests when this landed, so it bans no
    // existing code — the one textual match was a comment stating the rule.
    // FLAT-CONFIG HAZARD, stated because it nearly shipped: a later block REPLACES a rule, it does not merge
    // into it. Naming `no-restricted-imports` here would have silently disabled the repo-wide REQ-163
    // organ-bank ban inside these two packages, and naming `no-restricted-syntax` would have dropped §284's
    // determinism bans for adapters. Both are therefore RE-STATED below as a superset — which is exactly why
    // the ledger block above repeats the lumina/shuddl-2023 group instead of relying on the global one.
    files: ["packages/adapters/**/*.ts", "packages/edi/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["*lumina*", "*Lumina*", "*shuddl-2023*"], message: "REQ-163: prior codebases are organ banks — reference, never merge." },
            {
              group: ["@shuddl/ledger", "@shuddl/ledger/*", "@shuddl/rater", "@shuddl/rater/*"],
              message:
                "REQ-035/REQ-127: this is the PURE mapping core — it is ledger- and rater-free. The WORKER persists by looping the existing intake verbs; importing the ledger here routes around the gates those verbs carry.",
            },
            {
              group: ["node:crypto", "crypto"],
              message:
                "REQ-035: ids/timestamps are the WORKER's job — the mapper promises the same (sheet, mapping) yields a byte-identical result, which a generated id breaks.",
            },
          ],
        },
      ],
    },
  },
  {
    // Adapters ONLY, and the full superset. `crypto.randomUUID()` is the call form the import ban cannot see
    // (workerd exposes `crypto` as a global — no import to restrict), so it needs a syntax selector. Scoped to
    // adapters rather than both packages because edi claims PURITY ("no I/O, no ledger/rater") but never
    // claims DETERMINISM — enforcing an unstated rule there would be scope this register does not carry.
    // The three determinism selectors are repeated verbatim from §284's block for the replacement reason above.
    files: ["packages/adapters/**/*.ts"],
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
        {
          selector: 'MemberExpression[object.name="crypto"][property.name="randomUUID"]',
          message: "REQ-035: ids are the WORKER's job — a generated id breaks the byte-identical-result promise this module makes.",
        },
      ],
    },
  },
  // REQ-118 §566 — ASYNC CORRECTNESS, type-aware. A floating promise in a Worker is the silent-failure
  // class in its purest form: the isolate returns the response and is torn down, so the work simply never
  // happens — no error, no log, no retry. `tseslint.configs.recommended` (line 11) cannot catch it, because
  // these three rules need TYPE information and the base preset is the non-type-checked one.
  //
  // MEASURED BEFORE ENABLING: 215 files across workers/*/src and packages/*/src produced **zero** violations
  // of all three rules. This locks in a clean state rather than fixing a defect — §486's cheap half — and the
  // pass costs ~5s per tree.
  //
  // Scoped to src only (tests legitimately float promises in fixtures) and naming ONLY these three rules: a
  // flat-config block REPLACES a same-named rule's options rather than merging them, so redefining
  // `no-restricted-imports` here would silently drop REQ-024's ledger ban. A test asserts that ban still
  // fires with this block in place.
  {
    files: ["workers/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  // §705 — THE SURFACES WERE OUTSIDE THE TYPE-AWARE PROMISE RULES. The block above lists workers and
  // packages; `apps/` appears in NO block in this file, so the three PWAs were linted by the base rules only
  // (`any` and unused vars are caught — verified with a probe) and never by the rules that need type info.
  //
  // MEASURED: an identical floating `work();` is flagged in `packages/map/src/` and NOT in
  // `apps/command/src/`. That matters most in the driver PWA, whose whole premise is offline durability —
  // a dropped promise in a sync path is work that silently never happens, which is the failure the
  // airplane-mode soak exists to catch and which no soak can catch if the write was never awaited.
  //
  // A SEPARATE BLOCK, not a widening of the one above: co-located `*.test.tsx` files legitimately pass async
  // callbacks to `waitFor`, which is `no-misused-promises` by the letter and idiomatic by intent. Extending
  // the existing block would have imported 9 such violations; production surface code has ZERO.
  {
    files: ["apps/*/src/**/*.ts", "apps/*/src/**/*.tsx"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  // §716 — TEST FILES KEEP `no-floating-promises` AND LOSE ONLY `no-misused-promises`.
  //
  // §705 excluded `*.test.tsx` wholesale because extending the rules surfaced 9 errors — every one
  // `no-misused-promises` from `waitFor(async () => …)`, which is the rule by the letter and idiomatic by
  // intent. Blanket-ignoring the file was the wrong shape: it also dropped `no-floating-promises`, and
  // §715's mirror question (prove the EXCLUDED thing is caught by something, or should not be) was never
  // asked of it.
  //
  // MEASURED: `work().then((n) => { expect(n).toBe(999); });` in a test — eslint reports NOTHING and the
  // test PASSES, because the assertion lives in a promise nobody awaited. That is §713's own worst case,
  // stated there and unguarded here: "a test WITH assertions that cannot fail is worse than one with none".
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-misused-promises": "off" },
  },
  // §730 — THE DRIVER'S SERVICE WORKER IS SHIPPED CODE THAT HAD ZERO STATIC ANALYSIS.
  //
  // `apps/*/public/**` sat in the global ignores above, and unlike its neighbours in that list it carried no
  // stated reason. `public/` normally holds assets — but this one holds `sw.js`, the offline shell (REQ-061),
  // which is neither linted (ignored here) nor typechecked (it is `.js`, and no tsconfig include reaches it).
  // §717 found and fixed a real defect in this exact file — an unretained `caches.put()` that silently dropped
  // the offline cache write — and fixed the bug without making the file analysable.
  //
  // REMOVING THE IGNORE IS NOT ENOUGH, AND THAT IS THE POINT. Only `tseslint.configs.recommended` is spread
  // above, and it targets TypeScript. MEASURED with the ignore removed and no block: `const __probeUnused = 1`,
  // a reassigned `var`, and `1 == "1"` ALL produced **zero findings**. A green lint over this file would have
  // certified nothing — §726's vacuous-pass shape, reached by widening a corpus instead of by writing a test.
  // So the corpus widening and the rules land together.
  //
  // The globals are DERIVED from what the file references (self, caches, clients, fetch, skipWaiting,
  // addEventListener, Promise, URL) plus the two response types a fetch handler cannot avoid. Listing them
  // explicitly rather than pulling `globals` is not a preference — the package is transitive and not
  // resolvable under pnpm's strict layout (checked, not assumed).
  //
  // LIMIT, STATED: §717's defect class — a floating promise — needs TYPE-AWARE linting, which is unavailable
  // for plain `.js`. This gate cannot catch that one. What it does catch is the failure mode a service worker
  // is most exposed to: a typo'd global (`cahces.open`) is a ReferenceError inside an event handler, which
  // surfaces to a driver as "the app doesn't open offline" and to CI as nothing at all.
  {
    files: ["apps/*/public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        self: "readonly",
        caches: "readonly",
        clients: "readonly",
        fetch: "readonly",
        skipWaiting: "readonly",
        addEventListener: "readonly",
        Promise: "readonly",
        URL: "readonly",
        Response: "readonly",
        Request: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: "error",
      "no-var": "error",
    },
  },
);
