import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Own minimal wrangler config: two per-tenant D1 bindings + R2 EVIDENCE for anchor tests.
        wrangler: { configPath: "./wrangler.test.toml" },
      },
    },
  },
});
