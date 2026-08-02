import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { BaseSequencer } from "vitest/node";

// Sort test FILES by path, always. `sequence.shuffle: false` alone is NOT enough: vitest orders files by
// their CACHED DURATION from previous runs, so the order drifts on its own as timings move — two
// consecutive runs of this suite began with disjoint file lists even with shuffle off. Sorting by path is
// the only ordering that does not depend on run history.
//
// This matters here more than in a normal suite: 66 files share ONE D1 with no per-test rollback
// (isolatedStorage:false below), so file order is part of the fixture. Leaving it to chance means an
// order-dependent defect shows up in maybe one run in five and vanishes when you look for it — which is
// exactly what happened twice (audit §17, §20). Pinned, such a defect fails on EVERY run and can be fixed.
class PathSequencer extends BaseSequencer {
  async sort(files: Parameters<BaseSequencer["sort"]>[0]): Promise<ReturnType<BaseSequencer["sort"]>> {
    const key = (f: unknown): string =>
      typeof f === "string" ? f : (((f as { moduleId?: string }).moduleId ?? String((f as unknown[])?.[1] ?? f)) as string);
    return [...files].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }
}

export default defineWorkersConfig({
  test: {
    // 2026-08-02 §20 — DETERMINISTIC FILE ORDER. `singleWorker` runs the files sequentially, but vitest
    // still SHUFFLES which order that is: two consecutive runs of this suite started with completely
    // disjoint file lists. Combined with `isolatedStorage: false` (66 files on ONE control plane, no
    // per-test rollback), a green run is partly a function of the order it happened to draw — which is how
    // this suite produced two distinct intermittent failure clusters that took several full runs each to
    // even identify. Order-dependence between files is a real defect worth finding, but it must be found
    // REPRODUCIBLY: with the order pinned, a failure recurs on the next run instead of hiding for five.
    // 2026-08-02 §21 — DETERMINISTIC FILE ORDER, landed after the order-dependence it exposed was fixed.
    // §20 wrote this pin, found it made `lens-adversarial` fail reproducibly, and REVERTED it rather than
    // trade an intermittent red for a permanent one. The cause was a fixture in driver-manifest.test.ts
    // seeding schema-invalid `events` rows that the firehose then 500'd on; with that fixed, the pin lands.
    sequence: { shuffle: false, concurrent: false, sequencer: PathSequencer },
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
