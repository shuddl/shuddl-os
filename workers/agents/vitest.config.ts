import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Mirrors workers/api/vitest.config.ts. This worker has no SQLite-backed Durable Object, so
// isolatedStorage can stay ON (default) — each test's D1/R2 writes roll back at its end, only
// beforeAll's schema persists. singleWorker keeps files sequential in one isolate.
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
