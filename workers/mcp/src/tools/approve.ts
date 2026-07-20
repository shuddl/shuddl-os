// WP-13 Task 7 (REQ-101/192/194) — `approve`, the MCP APPROVAL-DECISION tool (mutating).
//
// A caller (Claude, via MCP) records a decision on a shipment's OPEN below-floor approval. The tool makes
// EXACTLY ONE api write — POST /v1/shipments/:id/approval-decision — which is THE blessed path for
// approval.decided (approvals.ts): the api LOADS the open approval itself and RE-CHECKS the matrix
// `required_role` SERVER-SIDE. The MCP principal is role=ops, so an ops-satisfiable approval (below-target,
// ops-required) succeeds, but a FINANCE-required (loss/dual) approval is 403 at the api — a PROMPT-INDEPENDENT
// role gate the tool cannot talk its way past. The tool surfaces that 403 as an isError result, never a
// fabricated decision. This is why the general events route REFUSES approval.decided (events.ts): the check
// has ONE home, and every caller — browser or MCP — goes through it.
//
// STRICT api body: the api's DecisionBody is `{decision}` ONLY (.strict()). It selects the OPEN approval by
// shipment; it does NOT take an approval_event_id. So `approval_event_id`, though ACCEPTED here (caller
// provenance / forward-compat), is NEVER forwarded — sending it would trip the api's strict 400. The write goes
// through `mutatingCallApi`, so a mis-declared mutating:false (no chokepoint ⇒ ctx uncleared) THROWS rather than
// silently skipping caps+confirm.
import { z } from "zod";
import { defineTool, mutatingCallApi, ToolError, type ToolCtx } from "./registry.js";

const MAX_ID_LEN = 200;
const MAX_KEY_LEN = 200;

const ApproveInput = z
  .object({
    shipment_id: z.string().min(1).max(MAX_ID_LEN),
    // The api's outcome vocabulary (approvals.ts DecisionBody) — approve OR deny the open approval.
    decision: z.enum(["approved", "denied"]),
    // ACCEPTED for provenance/forward-compat but NOT forwarded — the api selects the open approval by shipment
    // and its body is strict {decision}; forwarding this would be a 400. See the header.
    approval_event_id: z.string().min(1).max(MAX_ID_LEN).optional(),
    // The caller's explicit idempotency token (REQ-106) — a retried decision collapses to one approval.decided.
    idempotency_key: z.string().min(1).max(MAX_KEY_LEN).optional(),
    // NOTE (Task 9, REQ-102): a money-moving approval will require a `confirm` block here. Room left deliberately.
  })
  .strict();
type ApproveArgs = z.infer<typeof ApproveInput>;

export const approveTool = defineTool({
  name: "approve",
  description:
    "Record a decision (approved/denied) on a shipment's OPEN below-floor approval. The api re-checks the " +
    "matrix required_role SERVER-SIDE: an ops-required approval succeeds, a finance-required one is refused " +
    "(this principal cannot satisfy it) and surfaces as an error. Returns the decision + the approval.decided " +
    "event id (or an already-decided status).",
  inputSchema: ApproveInput,
  mutating: true,
  handler: async (ctx: ToolCtx, args: ApproveArgs) => {
    // THE ONE write. The api's strict body is {decision} — approval_event_id is deliberately NOT sent. A 403
    // (role does not satisfy the required_role) or 404 (no open approval) is surfaced as an isError, never
    // swallowed and never a fabricated success (REQ-192 — only the status, no internal body).
    const res = await mutatingCallApi(ctx, {
      method: "POST",
      path: `/v1/shipments/${encodeURIComponent(args.shipment_id)}/approval-decision`,
      body: { decision: args.decision },
    });
    if (!res.ok) throw new ToolError(`approval-decision failed: api returned ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    // The api returns either the appended approval.decided event (201, carries `id`) or an already-decided
    // envelope (200, {status:"already_decided", approval}). Surface both honestly.
    const out: Record<string, unknown> = {
      status: typeof data.status === "string" ? data.status : "decided",
      shipment_id: args.shipment_id,
      decision: args.decision,
    };
    if (typeof data.id === "string") out.decided_event_id = data.id;
    if (data.approval !== undefined) out.approval = data.approval;
    return out;
  },
});
