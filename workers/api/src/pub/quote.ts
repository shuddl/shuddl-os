import type { Context } from "hono";
import { z } from "zod";
import { MAX_WEIGHT_LB, MAX_ZIP_LEN } from "@shuddl/contracts";
import { priceShipment, resolveTransitDays } from "@shuddl/rater";
import type { RateRequest, TransitResult } from "@shuddl/rater";
import { ApiError, envelope } from "../middleware/error.js";
import { tenantDb, TENANT_BINDINGS } from "../tenants.js";
import { loadTenantRatingConfig, loadTransitMatrix } from "../rate-config.js";
import { authoritativeSource, resolveAuthority } from "../authority.js";
import { transitWindow } from "../routes/rate.js";
import type { Env, Vars } from "../index.js";

// REQ-051/189 (WP-09 Task 4) — POST /pub/quote: the SECOND no-auth public surface. A stranger prices freight
// with NO account and ZERO ledger residue. "Guest may QUOTE, never BOOK." It is a PURE PREVIEW: it calls the
// rating engine directly and appends NOTHING (no quote.priced, no agent.acted, no stream, no DO append, no
// INSERT). Where /v1/rate turns a price into co-signed append-only facts, THIS route stops at the price.
// Zero-append is guaranteed BY CONSTRUCTION: this module imports NO sequencer/DO/append surface — the only
// D1 it touches is the read-only rate_config loaders below.

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

// ---- Tenant from the CF-routed HOSTNAME, never the Host header (locked design §1) --------------------
// A no-auth surface has no JWT to key the tenant off, so the routing-authoritative CF hostname
// (new URL(c.req.url).hostname) resolves it via this static allowlist. It is a STRUCTURAL CLONE of
// TENANT_BINDINGS (src/tenants.ts): every VALUE here MUST be a key TENANT_BINDINGS binds — proven by the
// ISO-pub-5 parity test (share-lint-matchers skill). An unknown host 404s BEFORE any DB handle (no
// tenant-existence oracle, and it never touches D1). The client-forgeable Host header is NEVER consulted.
//
// Hostnames are SYNTHETIC placeholders (REQ-167 — no real tenant domains ever in the repo):
//   - "api.local"        — the vitest SELF.fetch host (see workers/api/test/helpers.ts `https://api.local/…`),
//                          mapped to tenant-a so the harness exercises the real route.
//   - "tenant-a.example" / "tenant-b.example" — stand-ins for the eventual per-tenant CF-routed hostnames.
export const HOST_TENANTS: Record<string, string> = {
  "api.local": "tenant-a",
  "tenant-a.example": "tenant-a",
  "tenant-b.example": "tenant-b",
};

// Defense in depth (fail LOUD at module load, not on a request): the ISO-pub-5 invariant, asserted at import
// so a HOST_TENANTS row pointing at a tenant TENANT_BINDINGS does not bind can never even boot the worker.
for (const slug of Object.values(HOST_TENANTS)) {
  if (!Object.prototype.hasOwnProperty.call(TENANT_BINDINGS, slug)) {
    throw new Error(`HOST_TENANTS maps to an unbound tenant '${slug}' — not in TENANT_BINDINGS (REQ-025)`);
  }
}

// ---- Guest request schema — .strict(), NO shipment_id (locked design §2) -----------------------------
// It MUST NOT reuse RateBody (routes/rate.ts): RateBody REQUIRES shipment_id, and reusing it is the footgun
// that could let a future rewrite derive an `s:${shipment_id}` stream for a stranger. The guest carries ONLY
// measured physics — no shipment_id, no legs/tenant_party (interline is ops-only), no proposed_sell_cents.
// `.strict()` REJECTS any of those with a 400 (GQ-5). Absent weight/dims is LEGAL — it flows to the engine
// which returns UNKNOWN (no price on air), never a 400. Integer-only law (integer pounds / integer inches).
const GuestDims = z
  .object({
    l_in: z.number().int().nonnegative(),
    w_in: z.number().int().nonnegative(),
    h_in: z.number().int().nonnegative(),
    pieces: z.number().int().positive(),
  })
  .strict();

// Every field is BOUNDED (2026-08-01 convergence audit): this is an anonymous compute endpoint, and the
// per-IP edge rule (REQ-193) limits request VOLUME, not per-request payload size — an unbounded zip or
// accessorial list carried arbitrary bytes into the engine. Mirrors SignupBody's bounding discipline.
const GuestQuoteBody = z
  .object({
    // §1515 — the shared ceiling, not a local 16: three surfaces had three answers for one field.
    origin_zip: z.string().min(1).max(MAX_ZIP_LEN),
    dest_zip: z.string().min(1).max(MAX_ZIP_LEN),
    // §1513 — the SAME ceiling the authed surface uses, imported rather than restated. Unbounded, a guest
    // could send `weight_lb: 1e15` and reach `mulDivHalfUp`'s precision throw: an HTTP 500 on the anonymous
    // surface from one JSON field (measured §1513). Over-cap is a 400 here, like every other bounded field.
    weight_lb: z.number().int().positive().max(MAX_WEIGHT_LB).optional(),
    dims: GuestDims.nullish(), // absent OR null ⇒ UNKNOWN missing_physics (the engine decides, not a 400)
    accessorials: z.array(z.string().max(64)).max(32).optional(),
  })
  .strict();

// ---- Response allowlist — .strict() {status, sell_cents, lines?, transit} and NOTHING else (§4) -------
// A discriminated union so a PRICED body carries EXACTLY the four allowed keys and an UNKNOWN body carries no
// price. EXCLUDED forever: floors, basis, versions, approval, anomaly (the executing_share/gross/evaluated
// internals). We NEVER call assessApproval or pricedResponse — both recompute/return those internals. The
// strict parse below is the fail-closed backstop: anything outside the allowlist cannot ship even if a future
// edit tried to attach it.
const GuestLine = z
  .object({
    // MIRRORS the counterparty quote.priced redaction (REDACTIONS["quote.priced"]=["floors","basis","versions"]
    // in packages/ledger/src/redact.ts): the redacted lens keeps sell + lines, and a PriceLine is margin-free
    // by construction (kind/code/amount_cents only — no floor/basis/margin). We re-map each line to exactly
    // these three fields, so even if PriceLine ever grows an internal, it cannot reach the wire.
    kind: z.enum(["freight", "fsc", "accessorial"]),
    code: z.string(),
    amount_cents: z.number().int(),
  })
  .strict();

const GuestQuoteResponse = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("PRICED"),
      sell_cents: z.number().int(),
      lines: z.array(GuestLine).optional(),
      // the honest transit window — a whole business-day count when KNOWN, else "unavailable". NEVER a
      // fabricated number (the honest-window law); mapped through the SAME transitWindow the authed /rate uses.
      transit: z.union([
        z.object({ status: z.literal("known"), business_days: z.number().int() }).strict(),
        z.object({ status: z.literal("unavailable") }).strict(),
      ]),
    })
    .strict(),
  // UNKNOWN carries NO price and NO transit — just the honest reason (missing_physics / no_zone /
  // no_rate_group / no_tariff), which is a status string, never a margin internal.
  z
    .object({
      status: z.literal("UNKNOWN"),
      reason: z.string(),
    })
    .strict(),
]);

export async function publicQuoteHandler(c: Ctx): Promise<Response> {
  // A price preview must not be cached by an intermediary (one guest's quote served to another), and the
  // request URL should not leak via the referrer — consistent with the /pub/status posture.
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");

  // 1) TENANT from the CF-routed URL hostname (routing-authoritative), NEVER the client-forgeable Host header.
  //    An unknown host 404s HERE — before any DB handle is resolved (no oracle, never touches D1).
  const host = new URL(c.req.url).hostname;
  const tenant = HOST_TENANTS[host];
  if (tenant === undefined) return envelope(c, "NOT_FOUND", 404, "NOT FOUND");

  // 2) Guest body — .strict() rejects shipment_id / legs / tenant_party / proposed_sell_cents with a 400.
  const parsed = GuestQuoteBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID QUOTE REQUEST");
  const body = parsed.data;

  // One clock for the config's effective-now bound.
  const now = Date.now();
  const db = tenantDb(c.env, tenant);

  // 3) PREVIEW ONLY — load the tenant's CURRENT rating config and price via the PURE engine. No tariff ⇒
  //    UNKNOWN no_tariff, and (like every path here) NOTHING appended.
  const config = await loadTenantRatingConfig(db, now);
  if (config === null) return c.json(GuestQuoteResponse.parse({ status: "UNKNOWN", reason: "no_tariff" }));

  // Map the guest fields → a single-leg RateRequest (the canonical rate-request shape), defaulting the rest.
  // exactOptionalPropertyTypes: attach optional physics only when present (a null dims is kept — the engine
  // reads it as missing_physics; undefined must never become an explicit key). Mirrors routes/rate.ts.
  const request: RateRequest = {
    origin_zip: body.origin_zip,
    dest_zip: body.dest_zip,
    ...(body.weight_lb !== undefined ? { weight_lb: body.weight_lb } : {}),
    ...(body.dims !== undefined ? { dims: body.dims } : {}),
    ...(body.accessorials !== undefined ? { accessorials: body.accessorials } : {}),
  };

  const quote = priceShipment(request, config);
  // No price on air (REQ-004): an UNKNOWN (missing physics / unserved lane) returns the honest reason and NO
  // price, NO transit — and STILL appends nothing.
  if (quote.status === "UNKNOWN") {
    return c.json(GuestQuoteResponse.parse({ status: "UNKNOWN", reason: quote.reason }));
  }

  // 4) The honest transit window — resolved the SAME way /rate does (over the SAME zone tariff the price used).
  //    An absent matrix OR an unresolvable lane ⇒ "unavailable"; a number is NEVER fabricated.
  const transitMatrix = await loadTransitMatrix(db, now);
  const transit: TransitResult =
    transitMatrix === null
      ? { status: "UNKNOWN" }
      : resolveTransitDays(body.origin_zip, body.dest_zip, transitMatrix, config.zone_tariff);

  // WP-15 REQ-030/L8 — consult the shared authority read-seam for the RATING module before returning the
  // authoritative (PRICED) guest quote. `legacyValueAvailable` is false today (no legacy price mirror — Task 4),
  // so authoritativeSource ALWAYS resolves to "native" and this guest preview IS the native price —
  // behavior-identical. NO response header here: this is an UNAUTHENTICATED public endpoint, and emitting the
  // authority level would disclose the tenant's rating maturity (legacy vs native) to anonymous callers once
  // the seam is live. The consult feeds a DORMANT intent-marker branch, like the agents sites; the authed
  // /v1/rate keeps its X-Shuddl-Authority-Rating header (intended parity observability behind auth).
  const ratingAuthority = authoritativeSource(await resolveAuthority(db, "rating"), false);
  if (ratingAuthority === "legacy") {
    // DORMANT until a legacy price mirror exists (Task 4). Unreachable today (native always wins).
    console.error(`pub/quote: rating authority is 'legacy' for tenant ${tenant} but no price mirror is wired (WP-15 Task 4) — proceeding native`);
  }

  // 5) Response allowlist — the PRICED price + the margin-free line breakdown + the honest window. The strict
  //    parse is the fail-closed backstop; floors/basis/versions/approval/anomaly are structurally absent (we
  //    never read them onto this object).
  return c.json(
    GuestQuoteResponse.parse({
      status: "PRICED" as const,
      sell_cents: quote.sell_cents,
      lines: quote.lines.map((l) => ({ kind: l.kind, code: l.code, amount_cents: l.amount_cents })),
      transit: transitWindow(transit),
    }),
  );
}
