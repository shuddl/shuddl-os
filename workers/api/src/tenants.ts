import type { Env } from "./index.js";
import { ApiError } from "./middleware/error.js";

// REQ-025: tenant → D1 binding is a server-side allowlist keyed by the JWT claim.
// There is no code path from client input to a database handle.
const TENANT_BINDINGS: Record<string, keyof Pick<Env, "TENANT_A_DB" | "TENANT_B_DB">> = {
  "tenant-a": "TENANT_A_DB",
  "tenant-b": "TENANT_B_DB",
};

export function tenantDb(env: Env, tenantSlug: string): D1Database {
  const binding = TENANT_BINDINGS[tenantSlug];
  if (!binding) throw new ApiError("FORBIDDEN", 403, "UNKNOWN TENANT");
  return env[binding];
}
