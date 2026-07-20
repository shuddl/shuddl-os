import type { Hono } from "hono";
import { z } from "zod";
import { normalizePartyEmail, partyIdForEmail } from "@shuddl/contracts";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// WP-10 Task 6 (REQ-150 / REQ-195 / REQ-030 / REQ-025) — THE SYNCHRONOUS CSR NET-NEW INTAKE SEAM.
//
// A CSR keying a brand-new phone/walk-in order (new customer, no prior shipment) had no way to book from
// scratch: POST /v1/rate appends quote.priced to a bare stream but creates NO shipments row and NO parties
// rows, so the Booking agent returned skipped:shipment_not_found (booking.ts). Party creation existed ONLY
// in the Concierge's async LLM email path (concierge.ts makeResolvePort), not callable by a CSR. These two
// DETERMINISTIC, SYNCHRONOUS, LLM-FREE ops seams close that gap so the CSR flow composes over the EXISTING
// verbs — parties → shipment → POST /v1/rate → POST /v1/shipments/:id/accept-quote → the gated Booking agent:
//   POST /v1/parties    — find-or-create a party (admin/ops), idempotent, tenant-scoped.
//   POST /v1/shipments  — materialize a QUOTE-STAGE shipments row with the shipper/consignee/bill_to FKs.
//
// LAWS THIS MODULE ENFORCES:
//   · ROLES admin/ops ONLY (a CSR is ops). NOT portal/driver/read/finance. Tenant from the JWT claim ONLY
//     (tenantDb, REQ-025) — never a client field; the auth middleware already rejects any X-Tenant-Id/?tenant=.
//   · GATE PARITY (REQ-030): the seam materializes a QUOTE-STAGE shipments row (NO booking.created, status_cache
//     left at its empty default), so the first REAL booking is still the first on the stream and the WP-09
//     one-booking-per-stream gate stays green. The booking still flows through the sequencer + #enforceBooking:
//     a net-new booking to a bill_to on a credit hold, or with no deliverable contact, is HELD exactly as any
//     other booking. This seam can NEVER let a booking skip the credit/evidence gates.
//   · DETERMINISTIC + IDEMPOTENT: party find-or-create keys off a normalized email (else legal name); a re-POST
//     of the same party returns the existing id, and a fresh party's id is derived from that same key so a race
//     collapses to one row under INSERT OR IGNORE. A shipment's id is derived from the Idempotency-Key so a retry
//     beyond the HTTP replay window reproduces the same id (INSERT OR IGNORE → no duplicate).
//   · UI-DECOUPLED: plain REST verbs. WP-13 MCP calls the SAME endpoints and inherits the SAME server-side gates.
//   · NO new table, NO new event kind, NO append to `events`: parties/shipments are MUTABLE domain tables
//     (INSERT/INSERT OR IGNORE legal — no append-only guard); the append-only ledger is untouched here.
//
// The party/shipment materialization deliberately MIRRORS the Concierge's makeResolvePort (concierge.ts:210-240)
// — same INSERT OR IGNORE shape, the same `party_`/`shp_` id prefixes, and the same `[{kind:"primary",email}]`
// contact so a bill_to created here satisfies the SAME hasDeliverableContact predicate the booking gate reads.
// The email-keyed party IDENTITY (the match key + the derived id) IS shared, via the @shuddl/contracts matcher
// (normalizePartyEmail / partyIdForEmail, REQ-196) — both workers depend on contracts, so both derive the SAME
// party id and find each other's rows (no split-billing duplicate). The tiny INSERT statements themselves stay
// duplicated: the Concierge lives in the agents worker (@shuddl/agents) which the api worker does not depend on,
// so extracting a few INSERTs cross-worker is heavier + riskier than the byte-small duplication (the rate.ts /
// approvals.ts precedent). Only the identity RULE — the one thing that must converge — is centralized.

const MAX_NAME_LEN = 200; // bounded — the legal name rides in the parties.names JSON
const MAX_EMAIL_LEN = 320; // RFC 5321 practical maximum
const MAX_PARTY_ID_LEN = 200; // a created id is `party_<16hex>`; bound a supplied FK before any query
const MAX_REF_LEN = 200; // each refs key/value is bounded (rides inline in the shipments row)

// The 7 party kinds — byte-identical to the parties.kind CHECK in 0002_domain.sql.
const PARTY_KINDS = ["shipper", "consignee", "carrier", "broker", "cartage", "factor", "insurer"] as const;
// The 6 shipment modes — byte-identical to the shipments.mode CHECK in 0002_domain.sql.
const SHIPMENT_MODES = ["LTL", "TL", "brokered", "cartage", "dray", "transload"] as const;

// POST /v1/parties body — bounded + .strict(). `email` is the one deliverable contact a CSR captures for a new
// customer (optional: a party may be name-only, e.g. a consignee, and get a contact later). Every string is capped.
const PartyBody = z
  .object({
    kind: z.enum(PARTY_KINDS),
    name: z.string().min(1).max(MAX_NAME_LEN),
    email: z.string().min(1).max(MAX_EMAIL_LEN).optional(),
  })
  .strict();

// POST /v1/shipments body — bounded + .strict(). The three party FKs are required; mode/division/refs are
// optional (the schema defaults LTL/main/{}). `refs` is a bounded string map (pro/bol/master_job/partner).
const ShipmentBody = z
  .object({
    shipper_party_id: z.string().min(1).max(MAX_PARTY_ID_LEN),
    consignee_party_id: z.string().min(1).max(MAX_PARTY_ID_LEN),
    bill_to_party_id: z.string().min(1).max(MAX_PARTY_ID_LEN),
    mode: z.enum(SHIPMENT_MODES).optional(),
    division: z.string().min(1).max(MAX_REF_LEN).optional(),
    refs: z.record(z.string().max(MAX_REF_LEN), z.string().max(MAX_REF_LEN)).optional(),
  })
  .strict();

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function mountIntakeRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /v1/parties — find-or-create a party DETERMINISTICALLY (no LLM, unlike the Concierge). roles admin/ops.
  app.post("/v1/parties", requireRole("admin", "ops"), async (c) => {
    const session = c.get("session");
    const parsed = PartyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID PARTY BODY");
    const { kind, name } = parsed.data;
    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim only

    // The deterministic match key: a normalized email when present, else the normalized legal name. The email
    // path CONVERGES with the Concierge (REQ-196) via the shared @shuddl/contracts matcher — both find with
    // `lower(json_extract(...email))` bound to normalizePartyEmail(), and both derive the id via
    // partyIdForEmail(), so a CSR `Bob@Acme.com` and a later Concierge inbound `bob@acme.com` collapse to ONE
    // party row (no split-billing duplicate). The STORED email keeps its original case for deliverability —
    // only the match key + the derived id are normalized. The name-keyed path stays intake-local (below).
    const contactEmail = parsed.data.email?.trim();
    const normEmail = contactEmail !== undefined ? normalizePartyEmail(contactEmail) : undefined;
    const normName = name.trim().toLowerCase();

    // FIND — an existing party by the key. Email match reads the contacts JSON via json_each (the same shape
    // the Concierge's findPartyByEmail + the booking evidence gate read); name match reads names.$.legal.
    let existingId: string | null = null;
    if (normEmail !== undefined) {
      const row = await db
        .prepare("SELECT p.id AS id FROM parties p, json_each(p.contacts) je WHERE lower(json_extract(je.value, '$.email')) = ?1 LIMIT 1")
        .bind(normEmail)
        .first<{ id: string }>();
      existingId = row?.id ?? null;
    } else {
      const row = await db
        .prepare("SELECT id FROM parties WHERE lower(json_extract(names, '$.legal')) = ?1 LIMIT 1")
        .bind(normName)
        .first<{ id: string }>();
      existingId = row?.id ?? null;
    }
    if (existingId !== null) return c.json({ id: existingId, created: false }, 200);

    // CREATE — the id is DETERMINISTIC from the same key, so two concurrent creates derive the SAME id and
    // collapse to one row under INSERT OR IGNORE (the guard-free parties table permits IGNORE; first-write wins).
    // Email path: the SHARED partyIdForEmail (REQ-196) — the SAME id the Concierge derives. Name path: intake-
    // local (a name-only party, e.g. a consignee, is never keyed by the Concierge's email flow).
    const id =
      contactEmail !== undefined
        ? await partyIdForEmail(contactEmail)
        : `party_${(await sha256Hex(`intake:party:name:${normName}`)).slice(0, 16)}`;
    const names = JSON.stringify({ legal: name });
    const contacts = JSON.stringify(contactEmail !== undefined ? [{ kind: "primary", email: contactEmail }] : []);
    await db.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)").bind(id, kind, names, contacts).run();
    return c.json({ id, created: true }, 201);
  });

  // POST /v1/shipments — materialize a QUOTE-STAGE shipments row with the three party FKs. roles admin/ops.
  app.post("/v1/shipments", requireRole("admin", "ops"), async (c) => {
    const session = c.get("session");
    const parsed = ShipmentBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID SHIPMENT BODY");
    const body = parsed.data;
    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim only

    // The three party FKs MUST exist in THIS tenant's parties (created via POST /v1/parties or already present).
    // The shipments table has no DB-level FK, so verify here — fail-fast with a clean 400 rather than leaving an
    // orphan shipment whose booking would later mysteriously hold on a missing bill_to.
    const fkIds = [...new Set([body.shipper_party_id, body.consignee_party_id, body.bill_to_party_id])];
    const found = await db
      .prepare(`SELECT id FROM parties WHERE id IN (${fkIds.map(() => "?").join(",")})`)
      .bind(...fkIds)
      .all<{ id: string }>();
    const present = new Set(found.results.map((r) => r.id));
    if (fkIds.some((fk) => !present.has(fk))) throw new ApiError("VALIDATION_FAILED", 400, "ONE OR MORE PARTY FKS DO NOT EXIST IN THIS TENANT");

    // The shipment id is DETERMINISTIC from the Idempotency-Key (the mutation middleware already required it),
    // so a retry beyond the HTTP replay window reproduces the SAME id → INSERT OR IGNORE is a no-op (no
    // duplicate). Two DIFFERENT keys are two DIFFERENT orders (a CSR keying two loads for the same parties).
    // `shp_<hex>` is word-chars only ⇒ a valid `s:<id>` stream. Tenant folded in for defense-in-depth.
    const idemKey = c.req.header("Idempotency-Key") ?? crypto.randomUUID();
    const shipmentId = `shp_${(await sha256Hex(`intake:shipment:${session.tenant}:${idemKey}`)).slice(0, 16)}`;

    // Mirror the Concierge's createShipment: a direct INSERT OR IGNORE quote-stage row with NO booking.created
    // and status_cache at its empty default '{}' (never a fabricated `booked`), so the first real booking is
    // still first on the stream (WP-09 one-booking-per-stream gate). mode/division/refs default to LTL/main/{}.
    await db
      .prepare(
        "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, mode, division, refs, created_ts) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        shipmentId,
        body.shipper_party_id,
        body.consignee_party_id,
        body.bill_to_party_id,
        body.mode ?? "LTL",
        body.division ?? "main",
        JSON.stringify(body.refs ?? {}),
        Date.now(),
      )
      .run();

    return c.json({ shipment_id: shipmentId }, 201);
  });
}
