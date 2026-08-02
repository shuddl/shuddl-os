import type { Context } from "hono";
import { z } from "@shuddl/contracts";
import { generalizePosition } from "@shuddl/ledger/redact";
import { envelope } from "../middleware/error.js";
import { resolveTenantDb } from "../tenants.js";
import { verifyStatusCap } from "./status-cap.js";
import type { Env, Vars } from "../index.js";

// REQ-187/188 (WP-09 Task 3, D1 half B) — GET /pub/status/:cap. The FIRST public, no-auth data read in the
// system, so its posture IS the feature: PROJECTION-ONLY, a POSITIVE-allowlist body, and geo that is ALWAYS
// city-coarse (even at OFD, because a public cap URL is FORWARDABLE — it must never unlock exact geo the way
// the authed party lens does). The cap IS the authorization; verifyStatusCap (Task 2) is the whole gate.

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

// The POSITIVE-allowlist OUTPUT contract (doc: locked design §4). `.strict()` so a FUTURE status_cache field
// can never be emitted — it is not in this schema, and it is never even READ into the body below (we pick
// `state` / `out_for_delivery` by name, never spread status_cache). assigned_driver (a driver user id) and
// any party name are structurally unreachable — there is no key for them here (REQ-167).
const PublicPosition = z.object({ lat_e6: z.number().int(), lon_e6: z.number().int() }).strict();
const PublicStatus = z
  .object({
    state: z.string(),
    out_for_delivery: z.boolean(),
    position: PublicPosition.optional(),
    // eta is OMITTED in v1: status_cache carries no honest ETA field, and a fabricated number violates the
    // honest-instrument law (skill keep-map-instrument-truthful). Kept optional so a REAL future ETA source
    // has a typed slot — never populated until one exists.
    eta: z.number().optional(),
  })
  .strict();

function parseStatusCache(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function publicStatusHandler(c: Ctx): Promise<Response> {
  // The cap lives in browser history, referrer headers, and access logs — so no-referrer + no-store on
  // EVERY response from this handler (locked design §7), the uniform 401s included.
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");

  // THE UNIFORM FAILURE. A bad MAC, an unknown tenant, and a missing shipment ALL return this one envelope
  // (identical code + message; only the random req_id differs) so a prober gets NO existence/typ/tenant
  // oracle — the enumeration defense (PS-1/PS-2). One producer, one body.
  const deny = (): Response => envelope(c, "UNAUTHORIZED", 401, "STATUS UNAVAILABLE");

  const cap = c.req.param("cap") ?? "";

  // 1) VERIFY FIRST — before touching any DB. verifyStatusCap throws a UNIFORM StatusCapError on ANY
  //    failure (bad MAC / expiry / wrong typ). Only a MAC-valid cap yields {t, s}; both come from INSIDE
  //    the MAC, so neither is client-forgeable nor enumerable from the URL.
  let claims: { t: string; s: string };
  try {
    claims = await verifyStatusCap(cap, c.env.JWT_SECRET);
  } catch {
    return deny();
  }

  // 2) ONLY AFTER a valid MAC, resolve the tenant D1 and read the PROJECTION. Everything here is
  //    fail-closed to the SAME 401: an unknown tenant (the resolver throws), a missing shipment, or any
  //    read fault is indistinguishable from a bad cap — no oracle, no 500 to probe.
  //
  //    CLAIMED-AWARE (2026-08-01 convergence audit): this used the STATIC-only tenantDb while the mint
  //    route (routes/status-link.ts) uses the claimed-aware resolver — so every status link a claimed
  //    pool tenant minted resolved to a uniform 401 and a customer's tracking link just read STATUS
  //    UNAVAILABLE. resolveTenantDb fail-closes identically (FORBIDDEN for sentinel/unclaimed/unknown
  //    slugs, caught into the same 401 below), so the no-oracle posture is unchanged.
  try {
    const db = await resolveTenantDb(c.env, claims.t);

    // PROJECTION READS ONLY — status_cache for the milestone; the latest positions row for geo. NEVER the
    // events table, NEVER lensFor/readEvents (that is the authenticated party lens, with its own OFD rules).
    const shipment = await db
      .prepare("SELECT status_cache FROM shipments WHERE id = ?")
      .bind(claims.s)
      .first<{ status_cache: string }>();
    if (shipment === null) return deny();

    const sc = parseStatusCache(shipment.status_cache);

    const body: z.input<typeof PublicStatus> = {
      // state / out_for_delivery come from status_cache BY NAME ONLY — never a spread, never assigned_driver.
      state: typeof sc.state === "string" ? sc.state : "unknown",
      out_for_delivery: sc.out_for_delivery === true,
    };

    const pos = await db
      .prepare("SELECT lat_e6, lon_e6, accuracy_m FROM positions WHERE shipment_id = ? ORDER BY ts DESC LIMIT 1")
      .bind(claims.s)
      .first<{ lat_e6: number; lon_e6: number; accuracy_m: number | null }>();
    if (pos !== null) {
      // ALWAYS coarse: `false` = NOT out-for-delivery, which makes generalizePosition (the SAME WP-02
      // redaction the party lens uses) round to ~11km and DROP accuracy_m. We pass `false` unconditionally,
      // so the public geo stays coarse even when status_cache says OFD — the forwardable-cap law (REQ-188).
      const coarse = generalizePosition({ lat_e6: pos.lat_e6, lon_e6: pos.lon_e6, accuracy_m: pos.accuracy_m ?? undefined }, false);
      // Re-parse through the strict sub-schema: it both types the `unknown` coords and guarantees only
      // lat_e6/lon_e6 (never a leaked accuracy_m) reach the wire.
      body.position = PublicPosition.parse({ lat_e6: coarse.lat_e6, lon_e6: coarse.lon_e6 });
    }

    // The strict OUTPUT parse is the fail-closed backstop: anything not in the allowlist cannot ship.
    return c.json(PublicStatus.parse(body));
  } catch {
    return deny();
  }
}
