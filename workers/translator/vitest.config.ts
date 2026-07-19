import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Mirrors workers/agents/vitest.config.ts (the workers pool). This package's Task-6 suites are the PURE
// agent-core (src/core/*) — plain describe/it over deterministic functions with NO D1/R2/DO/network, so no
// wrangler.toml + no cross-script binding stub is needed yet (the worker entry + its bindings land in
// Task 7/8). Inline miniflare gives the tests a workerd runtime (crypto.subtle for the shared party matcher)
// without a worker main. singleWorker keeps files sequential in one isolate.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        miniflare: { compatibilityDate: "2025-08-01" },
      },
    },
  },
});
