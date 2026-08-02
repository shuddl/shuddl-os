import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { DETERMINISTIC_SEQUENCE } from "../../tools/testing/path-sequencer.js";

// Mirrors workers/api/vitest.config.ts. This worker has no SQLite-backed Durable Object of its own, so
// isolatedStorage can stay ON (default) — each test's D1/R2 writes roll back at its end, only
// beforeAll's schema persists. singleWorker keeps files sequential in one isolate.
//
// WP-06: wrangler.toml binds SHIPMENT_SEQ cross-script to the api worker (script_name =
// "shuddl-api-dev") — the Biller's only write path. Miniflare refuses to start if that service does
// not exist in the test runtime, so a STUB auxiliary worker satisfies the binding here. It is never
// called by this package's suites: the Biller integration proof (workers/api/test/biller.test.ts)
// runs in the api harness, where the REAL ShipmentSequencer + migrated tenant D1 exist.
export default defineWorkersConfig({
  test: {
    // 2026-08-02 §22 — deterministic FILE order (see tools/testing/path-sequencer.ts). Vitest orders
    // files by cached duration from prior runs, so the order drifts on its own; measured varying here.
    // `beforeAll` writes are never rolled back even with isolatedStorage on, so cross-file state exists
    // in this project too — and an intermittent failure you cannot reproduce is a rumour, not a bug.
    sequence: DETERMINISTIC_SEQUENCE,
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          workers: [
            {
              // MUST match `script_name` in this package's wrangler.toml SHIPMENT_SEQ binding
              // (= the api worker's `name` in workers/api/wrangler.toml) — drift breaks miniflare startup.
              name: "shuddl-api-dev",
              modules: true,
              // Mirrors workers/api/wrangler.toml `compatibility_date` (the worker this stubs).
              compatibilityDate: "2025-08-01",
              script: `
                export class ShipmentSequencer {
                  fetch() { return new Response("stub sequencer — the real DO lives in the api worker", { status: 501 }); }
                }
                export default {
                  fetch() { return new Response("stub api worker for binding resolution only", { status: 501 }); },
                };
              `,
            },
          ],
        },
      },
    },
  },
});
