import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Mirrors workers/translator/vitest.config.ts. As of Task 10 this worker binds the api worker as an `API` service
// binding (the credit flow appends onto `_platform` through the REAL sequencer over it — SequencerPlatformLedger).
// Miniflare refuses to start if that service does not exist in the test runtime, so a STUB auxiliary worker
// satisfies the binding here — exactly as the translator/agents pools stub the cross-script api worker.
//
// The billing suites never actually CALL env.API: they inject a recording PlatformLedger to assert the emitter's
// append/settle CALLS in isolation. The REAL append-through-sequencer (the POD-gate exemption, the visibility
// clamp, the money projection) is proven in the api harness (workers/api/test/platform-credit.test.ts), where the
// real ShipmentSequencer + the migrated `_platform` D1 exist — the same split by which the agents Biller integration
// is proven in the api harness, not the agents pool. isolatedStorage stays ON (default); singleWorker keeps files
// sequential in one isolate.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          workers: [
            {
              // MUST match `service` in this package's wrangler.toml [[services]] API binding (= the api worker's
              // `name` in workers/api/wrangler.toml) — drift breaks miniflare startup / service-binding resolution.
              name: "shuddl-api-dev",
              modules: true,
              // Mirrors workers/api/wrangler.toml `compatibility_date` (the worker this stubs).
              compatibilityDate: "2025-08-01",
              script: `
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
