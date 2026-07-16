import type { Env } from "./index.js";
import { ApiError } from "./middleware/error.js";

// REQ-025: tenant → D1 binding is a server-side allowlist keyed by the JWT claim.
// There is no code path from client input to a database handle. EXPORTED so the WP-09 public host
// allowlist (HOST_TENANTS in src/pub/quote.ts) can be proven a structural subset of it — every hostname
// the /pub surface resolves MUST map to a tenant this core allowlist actually binds (ISO-pub-5 parity test,
// share-lint-matchers skill). The public map may never conjure a tenant the core map doesn't know.
export const TENANT_BINDINGS: Record<string, keyof Pick<Env, "TENANT_A_DB" | "TENANT_B_DB">> = {
  "tenant-a": "TENANT_A_DB",
  "tenant-b": "TENANT_B_DB",
};

export function tenantDb(env: Env, tenantSlug: string): D1Database {
  const binding = TENANT_BINDINGS[tenantSlug];
  if (!binding) throw new ApiError("FORBIDDEN", 403, "UNKNOWN TENANT");
  return env[binding];
}
