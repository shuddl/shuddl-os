import type { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { PARTY_KINDS, SHIPMENT_MODES, findOrCreateParty, materializeShipment, sha256Hex } from "../intake-core.js";
import type { Env, Vars } from "../index.js";

// WP-10 Task 6 (REQ-150 / REQ-195 / REQ-030 / REQ-025) — THE SYNCHRONOUS CSR NET-NEW INTAKE SEAM.
//
// A CSR keying a brand-new phone/walk-in order (new customer, no prior shipment) had no way to book from
// scratch. These two DETERMINISTIC, SYNCHRONOUS, LLM-FREE ops seams close that gap so the CSR flow composes
// over the EXISTING verbs — parties → shipment → POST /v1/rate → accept-quote → the gated Booking agent:
//   POST /v1/parties    — find-or-create a party (admin/ops), idempotent, tenant-scoped.
//   POST /v1/shipments  — materialize a QUOTE-STAGE shipments row with the shipper/consignee/bill_to FKs.
//
// The materialization logic itself now lives in ../intake-core.ts (findOrCreateParty / materializeShipment), so
// the WP-14 Migrator import (routes/import.ts) LOOPS the SAME functions with byte-identical gates — no reimplement.
//
// LAWS THIS MODULE ENFORCES:
//   · ROLES admin/ops ONLY. Tenant from the JWT claim ONLY (tenantDb, REQ-025) — never a client field.
//   · GATE PARITY (REQ-030): the seam materializes a QUOTE-STAGE shipments row (NO booking.created), so the
//     first REAL booking is still the first on the stream and the WP-09 one-booking-per-stream gate stays green.
//   · DETERMINISTIC + IDEMPOTENT: party find-or-create keys off a normalized email (else legal name); a
//     shipment's id derives from the Idempotency-Key so a retry reproduces the same id (INSERT OR IGNORE).
//   · NO new table, NO new event kind: parties/shipments are MUTABLE domain tables; the ledger is untouched.

const MAX_NAME_LEN = 200; // bounded — the legal name rides in the parties.names JSON
const MAX_EMAIL_LEN = 320; // RFC 5321 practical maximum
const MAX_PARTY_ID_LEN = 200; // a created id is `party_<16hex>`; bound a supplied FK before any query
const MAX_REF_LEN = 200; // each refs key/value is bounded (rides inline in the shipments row)
// §1534 — …AND SO IS THE KEY COUNT, which the length bound above implies but did not enforce. `z.record` has
// no size, so 10,000 keys × 200 chars parsed clean and stored **2,108,891 bytes in one `shipments.refs` cell**
// (measured against the live route, with a small-refs control returning 201 beside it). The author bounded key
// and value length precisely BECAUSE it rides inline; the cardinality was the half left open — §1516's shape
// on a field that, unlike `legs`, really is persisted.
//
// 64 is generous by two orders of magnitude against real use: the schema's own comment names the vocabulary
// (`pro/bol/master_job/partner`), the MCP tool stamps exactly one (`{pairing}`), and the largest map anywhere
// in the tree has TWO keys.
const MAX_REF_KEYS = 64;

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
    refs: z
      .record(z.string().max(MAX_REF_LEN), z.string().max(MAX_REF_LEN))
      .refine((r) => Object.keys(r).length <= MAX_REF_KEYS, `refs carries more than ${MAX_REF_KEYS} keys (§1534 — it rides inline in the shipments row)`)
      .optional(),
  })
  .strict();

export function mountIntakeRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /v1/parties — find-or-create a party DETERMINISTICALLY (no LLM, unlike the Concierge). roles admin/ops.
  app.post("/v1/parties", requireRole("admin", "ops"), async (c) => {
    const session = c.get("session");
    const parsed = PartyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID PARTY BODY");
    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim only

    const { id, created } = await findOrCreateParty(db, {
      kind: parsed.data.kind,
      name: parsed.data.name,
      ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
    });
    return c.json({ id, created }, created ? 201 : 200);
  });

  // POST /v1/shipments — materialize a QUOTE-STAGE shipments row with the three party FKs. roles admin/ops.
  app.post("/v1/shipments", requireRole("admin", "ops"), async (c) => {
    const session = c.get("session");
    const parsed = ShipmentBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID SHIPMENT BODY");
    const body = parsed.data;
    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim only

    // The shipment id is DETERMINISTIC from the Idempotency-Key (the mutation middleware already required it),
    // so a retry beyond the HTTP replay window reproduces the SAME id → INSERT OR IGNORE is a no-op.
    const idemKey = c.req.header("Idempotency-Key") ?? crypto.randomUUID();
    const shipmentId = `shp_${(await sha256Hex(`intake:shipment:${session.tenant}:${idemKey}`)).slice(0, 16)}`;

    const { missingFks } = await materializeShipment(db, {
      id: shipmentId,
      shipperPartyId: body.shipper_party_id,
      consigneePartyId: body.consignee_party_id,
      billToPartyId: body.bill_to_party_id,
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.division !== undefined ? { division: body.division } : {}),
      ...(body.refs !== undefined ? { refs: body.refs } : {}),
    });
    if (missingFks.length > 0) throw new ApiError("VALIDATION_FAILED", 400, "ONE OR MORE PARTY FKS DO NOT EXIST IN THIS TENANT");

    return c.json({ shipment_id: shipmentId }, 201);
  });
}
