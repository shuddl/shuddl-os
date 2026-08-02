import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // 2026-08-02 §20 — DETERMINISTIC FILE ORDER. `singleWorker` runs the files sequentially, but vitest
    // still SHUFFLES which order that is: two consecutive runs of this suite started with completely
    // disjoint file lists. Combined with `isolatedStorage: false` (66 files on ONE control plane, no
    // per-test rollback), a green run is partly a function of the order it happened to draw — which is how
    // this suite produced two distinct intermittent failure clusters that took several full runs each to
    // even identify. Order-dependence between files is a real defect worth finding, but it must be found
    // REPRODUCIBLY: with the order pinned, a failure recurs on the next run instead of hiding for five.
    // 2026-08-02 §20 — shuffle off, but the order is STILL not deterministic: vitest's default sequencer
    // orders files by their CACHED DURATION from previous runs, so two consecutive runs of this suite start
    // with disjoint file lists even with shuffle off. Pinning it fully needs a custom path sequencer.
    //
    // That was WRITTEN AND REVERTED, deliberately, and the reason is the finding: with the order pinned,
    // `lens-adversarial` fails REPRODUCIBLY (2 tests, "expected 500 to be 200") because some earlier file
    // seeds `events` rows whose `id`/`prev_hash` do not satisfy the LedgerEvent schema, and the firehose
    // 500s when `rowToEvent` reads them. It passes 44/44 in isolation. So the suite is order-DEPENDENT
    // today and the randomization has been hiding it. Pinning the order without fixing that dependence
    // would trade an intermittent red for a permanent one, and the fix touches the canonical-hash read
    // path — not something to change in a hurry. Ledgered in the audit §20 with this exact reproduction.
    sequence: { shuffle: false, concurrent: false },
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
        //
        // CONSEQUENCE (read before adding a test file): with isolation off, ALL test files share ONE
        // D1. Two files applying the pinned migrations independently collide ("table already exists").
        // So migrations + control-plane seeding go through the idempotent `ensureSchema(env)` in
        // test/helpers.ts — call it in your beforeAll; do NOT re-apply migrations yourself. And
        // `singleWorker: true` runs all files sequentially in one isolate, which (a) lets ensureSchema's
        // module memo run setup exactly once and (b) removes any cross-isolate race on the shared D1.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Test-only secret injection; real JWT_SECRET arrives via `wrangler secret` (REQ-154).
          bindings: { JWT_SECRET: "test-secret-do-not-use-in-prod" },
        },
      },
    },
  },
});
