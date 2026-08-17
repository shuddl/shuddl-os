import type { Hono } from "hono";
import { z } from "zod";
import type { Role, SessionClaims } from "@shuddl/contracts";
import { deterministicUuid } from "@shuddl/contracts";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { translateAppendError, type SeqStub } from "./events.js";
import type { AppendedEvent } from "../do/sequencer.js";
import type { Env, Vars } from "../index.js";

// WP-10 Task 2 (REQ-082/194) — the approvals QUEUE surface. Two routes over the `approvals` read-model the
// sequencer projects (projection/approvals.ts):
//   POST /v1/shipments/:id/approval-decision — the BLESSED path for approval.decided. Loads the OPEN approval
//     for the shipment, enforces the matrix required_role SERVER-SIDE (REQ-049/030), and appends
//     approval.decided THROUGH the sequencer DO with the AUTHENTICATED decider (session.sub, never client-
//     claimed). This is why the general events route REFUSES approval.decided (events.ts BLESSED_DECISION_KINDS):
//     a client posting it there would BYPASS this required_role check (an ops principal deciding a finance-
//     required dual approval). One gated path, one server-side check.
//   GET  /v1/approvals?status=open — the command-queue list, tenant-scoped via the JWT claim (tenantDb, REQ-025).
//
// required_role SATISFACTION (the matrix, packages/rater approval.ts): a below-target single approval requires
// "ops"; a below-contribution (loss) dual approval requires "finance". A caller satisfies a requirement iff its
// role EQUALS the required role, or it is admin (admin clears any). So ops→ops OK, finance→finance OK, admin→any
// OK; ops→finance-required is 403, and finance→ops-required is likewise 403 (segregation of duties — the same
// spirit as events.ts REQ-185, where finance and ops emit disjoint decision kinds). This is deliberately EXACT
// match (plus admin), not a hierarchy — documented as the WP-10 assumption if a tenant policy later ranks roles.

const MAX_SHIPMENT_ID_LEN = 200; // mirrors events.ts / portal-actions.ts — bound length BEFORE the DO name / any query (400, not 500)
const APPROVAL_DECISION_CONFIDENCE_BPS = 10_000; // a deterministic server-recorded fact (mirrors portal-actions.ts)

// The decision body — bounded + .strict(): ONLY the approve/deny outcome. The required_role is enforced from
// the LOADED approval (server truth), never the body; the decider is session.sub, never a client field.
const DecisionBody = z.object({ decision: z.enum(["approved", "denied"]) }).strict();

// The read `status` filter — the queue lists OPEN by default; `decided` is offered for audit/history. An
// unknown value is a hard 400 (never a silent empty result), mirroring events.ts parseKinds.
const STATUS_VALUES = new Set(["open", "decided"]);

// A DETERMINISTIC v4-variant UUID (satisfies EventInput.id = z.string().uuid()) from a domain-separated seed —
// the SAME shaping rate.ts / portal-actions.ts use. Deriving the approval.decided id from the requested_event_id
// makes a re-decision reproduce the SAME id → the sequencer dedupes by id (one approval.decided per approval,
// the FIRST decision wins), so the ledger never gains a duplicate even under a race.
// `deterministicUuid` is imported from @shuddl/contracts — §1716 consolidated the SIX copies of it (this was
// one) into the one builder. Its outputs sit in append-only `events.id`; see the byte-contract warning there.

// The matrix satisfaction check (server-side). admin clears ANY requirement; otherwise the role must EQUAL the
// required role. required_role only ever holds "ops" or "finance" (the matrix), but this is total over any string.
function roleSatisfies(caller: Role, requiredRole: string): boolean {
  return caller === "admin" || caller === requiredRole;
}

// An approvals read-model row (the columns 0002_domain.sql:72-75 defines).
type ApprovalRow = {
  id: string;
  object_kind: string;
  object_id: string;
  rule: string;
  required_role: string;
  requested_event_id: string;
  decided_event_id: string | null;
  status: string;
};
const APPROVAL_COLS = "id, object_kind, object_id, rule, required_role, requested_event_id, decided_event_id, status";

// Append the server-composed approval.decided through the sequencer DO (the gated path — every projection + I1
// still run). Actor + decider are SERVER-CONTROLLED: actor.party = the operator principal (session.sub — an
// ops/finance/admin has no counterparty party_id; approval.decided accrues no parties-FK projection, so the
// sub sentinel is safe), and payload.decider = session.sub. Tenant comes from the claim only; the DO re-derives
// its id and rejects a mismatch (REQ-025).
async function appendDecision(
  env: Env,
  session: SessionClaims,
  shipmentId: string,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<AppendedEvent> {
  const streamId = `s:${shipmentId}`;
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${session.tenant}|${streamId}`)) as unknown as SeqStub;
  try {
    return await stub.append({
      tenant: session.tenant,
      streamId,
      input: {
        id: eventId,
        shipment_id: shipmentId,
        ts: Date.now(),
        actor: { party: session.party_id ?? session.sub },
        party_refs: [],
        evidence: [],
        source: "native",
        confidence: APPROVAL_DECISION_CONFIDENCE_BPS,
        kind: "approval.decided",
        payload,
      },
    });
  } catch (e) {
    throw translateAppendError(e);
  }
}

export function mountApprovalRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /v1/shipments/:id/approval-decision — record a decision on the shipment's OPEN below-floor approval.
  // roles admin/ops/finance (portal/driver/read never decide an internal approval). The BLESSED approval.decided
  // path: it does its OWN required_role check, so it legitimately bypasses the events.ts finance restriction.
  app.post("/v1/shipments/:id/approval-decision", requireRole("admin", "ops", "finance"), async (c) => {
    const session = c.get("session");
    const shipmentId = c.req.param("id") ?? "";
    if (shipmentId.length > MAX_SHIPMENT_ID_LEN) throw new ApiError("VALIDATION_FAILED", 400, "SHIPMENT ID TOO LONG");
    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim only

    const parsed = DecisionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID APPROVAL DECISION BODY");
    const { decision } = parsed.data;

    // Load the OPEN approval for this shipment from the read-model (tenant-scoped by the D1 handle). Order is
    // deterministic; v1 has at most one open below-floor approval per shipment stream at a time.
    const open = await db
      .prepare(`SELECT ${APPROVAL_COLS} FROM approvals WHERE object_id = ? AND object_kind = 'shipment' AND status = 'open' ORDER BY requested_event_id LIMIT 1`)
      .bind(shipmentId)
      .first<ApprovalRow>();

    if (open === null) {
      // Idempotency: a re-decision after the projection already flipped the row → a CLEAN already-decided
      // response (200), never a 404 or a duplicate append. A shipment that never had an approval → 404.
      const decided = await db
        .prepare(`SELECT ${APPROVAL_COLS} FROM approvals WHERE object_id = ? AND object_kind = 'shipment' AND status = 'decided' ORDER BY requested_event_id LIMIT 1`)
        .bind(shipmentId)
        .first<ApprovalRow>();
      if (decided !== null) return c.json({ status: "already_decided", approval: decided }, 200);
      throw new ApiError("NOT_FOUND", 404, "NO OPEN APPROVAL FOR THIS SHIPMENT");
    }

    // REQ-049/030 — enforce the matrix required_role SERVER-SIDE. An ops caller on a finance-required (dual)
    // approval is 403 with NOTHING appended (the check precedes the DO append).
    if (!roleSatisfies(session.role, open.required_role)) {
      throw new ApiError("FORBIDDEN", 403, "YOUR ROLE DOES NOT SATISFY THIS APPROVAL'S REQUIRED ROLE");
    }

    // Append approval.decided THROUGH the sequencer (deterministic id from the requested event → idempotent).
    // The decider is the AUTHENTICATED principal (session.sub), never client-claimed; the requested_event_id
    // links the decision to the OPEN row for the projection to flip.
    const eventId = await deterministicUuid(`approval-decided:${open.requested_event_id}`);
    const event = await appendDecision(c.env, session, shipmentId, eventId, {
      requested_event_id: open.requested_event_id,
      decision,
      decider: session.sub,
      required_role: open.required_role,
    });
    return c.json(event, 201);
  });

  // GET /v1/approvals?status=open — the command-queue list, tenant-scoped via the JWT claim (tenantDb, REQ-025).
  // roles admin/ops/finance/read (tenant-lens roles; a portal party/driver has no command queue). Default status
  // is 'open'; an unknown status is a 400.
  app.get("/v1/approvals", requireRole("admin", "ops", "finance", "read"), async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    const status = c.req.query("status") ?? "open";
    if (!STATUS_VALUES.has(status)) throw new ApiError("VALIDATION_FAILED", 400, "status MUST BE open OR decided");
    const res = await db
      .prepare(`SELECT ${APPROVAL_COLS} FROM approvals WHERE status = ? ORDER BY requested_event_id`)
      .bind(status)
      .all<ApprovalRow>();
    return c.json({ approvals: res.results });
  });
}
