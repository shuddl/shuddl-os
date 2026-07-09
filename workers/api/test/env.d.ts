import type { Env } from "../src/index.js";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging: ProvidedEnv must extend the worker Env
  interface ProvidedEnv extends Env {}
}
