import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { fileURLToPath } from "node:url";

// WP-13 Task 1 (REQ-101) — proves the api SERVICE-BINDING reuse seam runs the REAL api worker in-process.
//
// The `[[services]] binding = "API"` in wrangler.toml points at `shuddl-api-dev`. In the test pool that name
// resolves to an AUXILIARY worker running in the same workerd process (the same mechanism by which the
// translator/agents pools resolve their cross-script `shuddl-api-dev` SHIPMENT_SEQ DO). Unlike those stubs,
// this loads the ACTUAL api Hono app so `binding.test.ts` exercises its real auth/idempotency middleware +
// /v1 gates — not a reimplementation.
//
// vitest-pool-workers auxiliary Workers CANNOT have a TypeScript entrypoint; they must be pre-compiled to JS
// (Cloudflare docs: "You must compile auxiliary Workers to JavaScript first"). The `pretest` npm script does
// exactly that — `wrangler deploy --dry-run --outdir ../mcp/dist/api` over workers/api — and we load the
// bundle here (dist/ is git- + eslint-ignored, so the 1.5 MB artifact never lints or commits). The api worker
// OWNS its resources; this task never migrates them, so the auxiliary is given
// only the bindings GET /v1/whoami actually reaches: JWT_SECRET (auth) + ENVIRONMENT. The idempotency KV,
// tenant D1s, evidence R2, sequencer DO + agent queue are NOT touched by whoami and so are not provisioned.
//
// JWT_SECRET matches workers/api/vitest.config.ts's test secret so an HS256 JWT this package's test signs
// verifies inside the api auxiliary. Injected here (tests only) — never the toml (REQ-154).
const API_TEST_SECRET = "test-secret-do-not-use-in-prod";
const apiBundleDir = fileURLToPath(new URL("./dist/api", import.meta.url));
const apiBundlePath = fileURLToPath(new URL("./dist/api/index.js", import.meta.url));

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // The mcp (main) worker's Env includes JWT_SECRET (ProvidedEnv extends Env). Test-only injection;
          // the real secret arrives via `wrangler secret` (REQ-154).
          bindings: { JWT_SECRET: API_TEST_SECRET },
          workers: [
            {
              // MUST match `service` in this package's wrangler.toml [[services]] API binding (= the api
              // worker's `name` in workers/api/wrangler.toml) — drift breaks service-binding resolution.
              name: "shuddl-api-dev",
              modules: true,
              modulesRoot: apiBundleDir,
              scriptPath: apiBundlePath,
              // Mirrors workers/api/wrangler.toml `compatibility_date` (the worker this loads).
              compatibilityDate: "2025-08-01",
              bindings: { JWT_SECRET: API_TEST_SECRET, ENVIRONMENT: "dev" },
            },
          ],
        },
      },
    },
  },
});
