import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { DETERMINISTIC_SEQUENCE } from "../../tools/testing/path-sequencer.js";

export default defineWorkersConfig({
  test: {
    // DETERMINISTIC FILE ORDER (2026-08-02 §20/§21/§22 — the rule lives in tools/testing/path-sequencer.ts).
    // This project matters most: isolatedStorage is OFF below, so 70 files (2026-08-12) share ONE D1 with no per-test
    // rollback and file order is literally part of the fixture. §20 pinned it, found it made
    // lens-adversarial fail REPRODUCIBLY, and reverted rather than trade an intermittent red for a
    // permanent one; §21 fixed the cause (a fixture seeding schema-invalid `events` rows the firehose
    // 500'd on) and landed the pin. Verified at 730/730 over three runs with byte-identical order
// (that figure is as-of §22; the suite is 70 files / 831 tests at 2026-08-12 — §1236). THE SHARED D1
// IS ALSO A TEST-DESIGN CONSTRAINT: a test that measures the corpus sees every sibling's seeds, so
// §1235's three suite-scale failures came from constants calibrated against a single-file run.
    sequence: DETERMINISTIC_SEQUENCE,
    poolOptions: {
      workers: {
        // isolatedStorage snapshots each test's storage by copying the backing SQLite files;
        // pool-workers 0.9.x asserts every file ends in `.sqlite`, but a SQLite-backed Durable
        // Object (ShipmentSequencer, new_sqlite_classes) leaves a `.sqlite-shm` WAL sidecar and
        // the snapshot aborts.
        //
        // §1733 — WHAT THAT ASSERT ACTUALLY IS, re-read in the installed copy rather than inferred.
        // `dist/pool/index.mjs` carries it TWICE, on the push (`:644`, before `copyFile`) and on the
        // pop (`:660`, before `unlink`). Both loops already skip one non-`.sqlite` entry BY NAME
        // (`if (name === BLOBS_DIR_NAME) break;`), and the SAME module at `:793` iterates a Durable
        // Object directory and FILTERS with `if (name.endsWith(".sqlite"))` instead of asserting.
        // So the assert is not an invariant upstream holds about that directory — it is an
        // incomplete allowlist that upstream's own neighbouring code contradicts. That matters for
        // whoever picks this up: the fix shape is upstream and small, and the local constraint is
        // version-pinned (installed 0.9.14; see GO-LIVE-CHECKLIST's pool-binding row for the
        // seven-manifest upgrade this would take). We don't rely on per-test rollback here — every ledger test scopes
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
