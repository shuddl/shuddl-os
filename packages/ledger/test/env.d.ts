// Types the bindings declared in wrangler.test.toml so `env` from cloudflare:test is strict.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    TENANT_A_DB: D1Database;
    TENANT_B_DB: D1Database;
    EVIDENCE: R2Bucket;
  }
}
