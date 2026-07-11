import {
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
} from "@shuddl/contracts";
import type { TenantRatingConfig } from "@shuddl/rater";

// I5 / REQ-151 — load a tenant's CURRENT effective rating config from its OWN D1 rate_config table
// (doc 10 §17: rate_config(id, version, kind, payload, effective_ts, approved_by)). Tenant isolation is
// upstream and structural: `db` is already the session tenant's handle (tenantDb, REQ-025) — this module
// never sees a tenant id and cannot cross tenants. For each rate_config kind it selects the row IN EFFECT
// AS OF `now` (the newest row whose effective_ts <= now, ties broken by the highest integer row version)
// and parses its payload with the matching @shuddl/contracts schema, so a malformed STORED config fails
// LOUDLY here (a 500), never as a silently mispriced quote. Bounding by `now` is load-bearing: a
// FUTURE-DATED row (a scheduled tariff change) must NOT price today — only the row actually in effect
// wins. A tenant missing ANY REQUIRED kind (zone_tariff/floors/fsc/accessorials) cannot price: return
// null → the /rate service answers UNKNOWN no_tariff (the REQ-151 cold-start "no tariff = no sell" half).
// class_adapter is OPTIONAL — the engine does not consume it in this WP, but the loader stays faithful to
// what the tenant configured and pins it when present.

// The effective-as-of-`now` row for one kind: among rows already in effect (effective_ts <= now) the
// newest wins; equal effective_ts breaks to the highest integer row version. `version` is the row-level
// DB integer (doc 10 §17), distinct from the payload's own version STRING that gets pinned (I5).
const EFFECTIVE_BY_KIND =
  "SELECT payload FROM rate_config WHERE kind = ?1 AND effective_ts <= ?2 ORDER BY effective_ts DESC, version DESC LIMIT 1";

async function effectivePayload(db: D1Database, kind: string, now: number): Promise<unknown> {
  const row = await db.prepare(EFFECTIVE_BY_KIND).bind(kind, now).first<{ payload: string }>();
  if (!row) return undefined;
  const payload: unknown = JSON.parse(row.payload);
  return payload;
}

export async function loadTenantRatingConfig(db: D1Database, now: number): Promise<TenantRatingConfig | null> {
  const [zt, fl, fs, acc, cls] = await Promise.all([
    effectivePayload(db, "zone_tariff", now),
    effectivePayload(db, "floors", now),
    effectivePayload(db, "fsc", now),
    effectivePayload(db, "accessorials", now),
    effectivePayload(db, "class_adapter", now),
  ]);

  // REQ-151 — a tenant without ALL FOUR required configs cannot price: UNKNOWN, no sell (cold-start half).
  if (zt === undefined || fl === undefined || fs === undefined || acc === undefined) return null;

  return {
    zone_tariff: ZoneTariff.parse(zt),
    floors: FloorsConfig.parse(fl),
    fsc: FscConfig.parse(fs),
    accessorials: AccessorialSchedule.parse(acc),
    // class_adapter is optional — pin it only when the tenant has one (exactOptionalPropertyTypes: never
    // set the key to undefined).
    ...(cls !== undefined ? { class_adapter: ClassAdapter.parse(cls) } : {}),
  };
}
