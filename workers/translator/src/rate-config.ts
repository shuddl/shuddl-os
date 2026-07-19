// WP-12 Task 8 · REQ-201 / REQ-025 / I5 — load a tenant's CURRENT effective REQUIRED rating config from its
// OWN D1 rate_config table, so an EDI-tendered lane prices through the SAME @shuddl/rater core the CSR /v1/rate
// route uses and a 204-originated quote.priced is byte-identical to a CSR one (no misprice divergence). This is
// a FAITHFUL DUPLICATE of the REQUIRED-config half of workers/api/src/rate-config.ts (loadTenantRatingConfig):
// that module lives in the api worker, which the Translator does not depend on, so — exactly as intake.ts
// duplicates a few INSERTs cross-worker rather than reaching across a worker boundary — the small effective-row
// query is duplicated here. The identity that MUST converge (the party matcher) is centralized in @shuddl/
// contracts; this loader carries no such cross-surface invariant (a mispriced quote fails LOUDLY at parse).
//
// The DISPLAY-ONLY transit matrix (REQ-059) is DELIBERATELY OMITTED: the quote.priced payload carries no
// transit window (the api /rate route computes it only for the HTTP response, never the event), so an EDI
// booking never needs it. Tenant isolation is upstream + structural: `db` is already the resolved tenant's
// handle — this module never sees a tenant id and cannot cross tenants (REQ-025).
import { ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule, ClassAdapter } from "@shuddl/contracts";
import type { TenantRatingConfig } from "@shuddl/rater";

// The effective-as-of-`now` row for one kind: among rows already in effect (effective_ts <= now) the newest
// wins; equal effective_ts breaks to the highest integer row version. A future-dated row must not price today.
const EFFECTIVE_BY_KIND =
  "SELECT payload FROM rate_config WHERE kind = ?1 AND effective_ts <= ?2 ORDER BY effective_ts DESC, version DESC LIMIT 1";

async function effectivePayload(db: D1Database, kind: string, now: number): Promise<unknown> {
  const row = await db.prepare(EFFECTIVE_BY_KIND).bind(kind, now).first<{ payload: string }>();
  if (!row) return undefined;
  return JSON.parse(row.payload) as unknown;
}

// Returns the tenant's required rating bundle IN EFFECT as of `now`, or null when ANY required kind is missing
// (REQ-151 cold start: no tariff = no sell → the caller records the tender at quote.requested and prices nothing,
// no price on air). A malformed STORED config fails LOUDLY here (the .parse throws) rather than mispricing.
export async function loadTenantRatingConfig(db: D1Database, now: number): Promise<TenantRatingConfig | null> {
  const [zt, fl, fs, acc, cls] = await Promise.all([
    effectivePayload(db, "zone_tariff", now),
    effectivePayload(db, "floors", now),
    effectivePayload(db, "fsc", now),
    effectivePayload(db, "accessorials", now),
    effectivePayload(db, "class_adapter", now),
  ]);

  if (zt === undefined || fl === undefined || fs === undefined || acc === undefined) return null;

  return {
    zone_tariff: ZoneTariff.parse(zt),
    floors: FloorsConfig.parse(fl),
    fsc: FscConfig.parse(fs),
    accessorials: AccessorialSchedule.parse(acc),
    ...(cls !== undefined ? { class_adapter: ClassAdapter.parse(cls) } : {}),
  };
}
