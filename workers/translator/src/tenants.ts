// Tenant allowlist for the Translator worker. A MIRROR of workers/api/src/tenants.ts (and
// workers/agents/src/tenants.ts) — if the sets drift, a tenant silently stops getting its outbound 214s
// swept. REQ-025 isolation: this server-side allowlist is the ONLY tenant→D1 map; there is no code path
// from client input (or an R2 marker key) to a database handle.

export type TranslatorEnv = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  /** EDI markers (tender linkage + the 214 dedupe/sent-record) live under the `edi/<tenant>/…` R2 prefix. */
  EVIDENCE: R2Bucket;
  /** The api worker's sequencer DO (cross-script). Unused by the 214 sweep (no event append); Task 8's 204
   *  handler appends the tender THROUGH it so the I2 gate + projections run there. */
  SHIPMENT_SEQ: DurableObjectNamespace;
  ENVIRONMENT?: string;
  // ── CONFIRM-gated live outbound-EDI transport creds (secrets via `wrangler secret put`, never the toml —
  //    REQ-154). BOTH absent ⇒ NotConfiguredTransport (fail-closed: no real EDI transmitted). A live adapter
  //    binds at the composition root (transportFor) when these exist AND the partner is replay-certified. ──
  EDI_TRANSPORT_URL?: string;
  EDI_TRANSPORT_TOKEN?: string;
};

const TENANT_BINDINGS: Record<string, keyof Pick<TranslatorEnv, "TENANT_A_DB" | "TENANT_B_DB">> = {
  "tenant-a": "TENANT_A_DB",
  "tenant-b": "TENANT_B_DB",
};

export const TENANT_SLUGS: readonly string[] = Object.keys(TENANT_BINDINGS);

export function tenantDb(env: TranslatorEnv, slug: string): D1Database {
  const binding = TENANT_BINDINGS[slug];
  if (!binding) throw new Error(`UNKNOWN_TENANT: ${slug}`);
  return env[binding];
}
