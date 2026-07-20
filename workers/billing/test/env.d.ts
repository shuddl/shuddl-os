import type { BillingEnv } from "../src/tenants.js";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging: ProvidedEnv mirrors the worker Env
  interface ProvidedEnv extends BillingEnv {}
}
