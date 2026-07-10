import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // isolatedStorage snapshots each test's storage by copying the backing SQLite files;
        // pool-workers 0.9.x asserts every file ends in `.sqlite`, but a SQLite-backed Durable
        // Object (ShipmentSequencer, new_sqlite_classes) leaves a `.sqlite-shm` WAL sidecar and
        // the snapshot aborts. We don't rely on per-test rollback here — every ledger test scopes
        // its assertions to a distinct (tenant|stream) DO + stream id, and the WP-01 suites use
        // unique idempotency keys / self-cleaning markers — so storage isolation is off for the
        // whole package instead. Cross-tenant isolation is proven by REQ-025 (id-derived DO + D1
        // allowlist), not by the test harness.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Test-only secret injection; real JWT_SECRET arrives via `wrangler secret` (REQ-154).
          bindings: { JWT_SECRET: "test-secret-do-not-use-in-prod" },
        },
      },
    },
  },
});
