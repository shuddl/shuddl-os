import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Test-only secret injection; real JWT_SECRET arrives via `wrangler secret` (REQ-154).
          bindings: { JWT_SECRET: "test-secret-do-not-use-in-prod" },
        },
      },
    },
  },
});
