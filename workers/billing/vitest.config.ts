import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Mirrors workers/translator/vitest.config.ts, minus the cross-script DO stub (this worker binds NO Durable
// Object — only the per-tenant D1s + the control D1). The pool loads wrangler.toml, so miniflare provisions a
// local D1 for each binding. isolatedStorage stays ON (default): each test's D1 writes roll back at its end,
// only beforeAll's schema/migrations persist. singleWorker keeps files sequential in one isolate.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
