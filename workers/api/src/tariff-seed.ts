import { brokerageTemplate } from "@shuddl/rater";
import type { BrokerageTemplateParams, ColdStartBundle } from "@shuddl/rater";

// REQ-151 (WP-14 Task 4) — the SINGLE materialization path from a brokerage cold-start template into a tenant's
// rate_config. Both the seed-at-provisioning (provision.ts) and the guided builder (routes/tariff.ts) call this,
// so a "cold-start tariff" means exactly ONE thing wherever it is written.
//
// The write is INSERT OR IGNORE (idempotent): a caller derives a UNIQUE idPrefix per materialization (from the
// tenant slug at provisioning, from the Idempotency-Key at the builder), so a retry reproduces the SAME 4 ids
// and inserts nothing new, while a genuinely new build gets fresh ids + a newer effective_ts that wins the
// loader's "effective as of now" pick. rate_config is NOT append-only-guarded (it is a config table, not the
// ledger), but we NEVER REPLACE/UPDATE a row here — a new tariff is a new versioned row, so I5 reproducibility
// (a past quote still resolves the exact config it priced against) is preserved. Tenant isolation is upstream +
// structural: `db` is already the resolved tenant's own handle (tenantDb/resolveClaimedTenantDb, REQ-025) — this
// module never sees a tenant id and cannot cross tenants.

// Sensible cold-start defaults for a brokerage tenant: a national market linehaul with a healthy margin, a small
// -shipment min charge, and a standard fuel surcharge + accessorial menu. Every value is HONEST synthetic
// configuration (REQ-167: no real tenant data) — a starting point the tenant then tunes in the guided builder.
export const DEFAULT_BROKERAGE_PARAMS: Omit<BrokerageTemplateParams, "idPrefix" | "version"> = {
  marketRateCentsPerCwt: 3500, // $35.00 / cwt market linehaul
  marginBps: 1800, // 18% gross margin markup → sell
  minChargeCents: 12_000, // $120 small-shipment floor
  fscPctBps: 2400, // 24% fuel surcharge
  accessorials: { liftgate: 3500, residential: 2500, detention: 6500, notify: 1200 }, // cents
};

const INSERT_RATE_CONFIG =
  "INSERT OR IGNORE INTO rate_config (id, version, kind, payload, effective_ts, approved_by) VALUES (?,?,?,?,?,?)";

export interface SeedColdStartOptions {
  /** Version-pinning id prefix — UNIQUE per materialization (slug at provisioning, Idempotency-Key at builder). */
  idPrefix: string;
  /** Override the default brokerage params (partial; unspecified fields fall back to DEFAULT_BROKERAGE_PARAMS). */
  params?: Partial<Omit<BrokerageTemplateParams, "idPrefix" | "version">>;
  /** effective_ts stored on each row. Default now — the loader picks the newest row in effect as of the rate clock. */
  effectiveTs?: number;
  /** approved_by audit stamp (e.g. "provision" / "builder:<user>"). */
  approvedBy?: string;
  /** Payload version string (I5). Default "v1". */
  version?: string;
}

export interface SeedColdStartResult {
  bundle: ColdStartBundle;
  /** The version-pinned ids (`id@version`) written — the same shape a quote pins (I5). */
  config_ids: string[];
}

/**
 * Materialize a brokerage cold-start tariff into `db`'s rate_config — the 4 required kinds (zone_tariff / floors
 * / fsc / accessorials), immediately effective. Returns the bundle + the version-pinned config ids. Pure of any
 * tenant-crossing: `db` is the caller's already-resolved tenant handle.
 */
export async function seedColdStartTariff(db: D1Database, opts: SeedColdStartOptions): Promise<SeedColdStartResult> {
  const bundle = brokerageTemplate({
    ...DEFAULT_BROKERAGE_PARAMS,
    ...opts.params,
    idPrefix: opts.idPrefix,
    version: opts.version ?? "v1",
  });
  const effectiveTs = opts.effectiveTs ?? Date.now();
  const approvedBy = opts.approvedBy ?? "cold-start";

  // The 4 required payloads, in a stable order. Each row: the payload's own id (PK), row-version 1 (the integer
  // rate_config.version, distinct from the pinned payload version string), the JSON payload, effective_ts, stamp.
  const parts = [bundle.zone_tariff, bundle.floors, bundle.fsc, bundle.accessorials];
  const config_ids: string[] = [];
  for (const part of parts) {
    await db.prepare(INSERT_RATE_CONFIG).bind(part.id, 1, part.kind, JSON.stringify(part), effectiveTs, approvedBy).run();
    config_ids.push(`${part.id}@${part.version}`);
  }
  return { bundle, config_ids };
}
