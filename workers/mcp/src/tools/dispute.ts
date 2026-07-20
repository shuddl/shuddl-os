// WP-13 Task 7 (REQ-101/192) — `dispute`, the MCP CLAIM tool (mutating).
//
// A caller (Claude, via MCP) files a claim on a shipment it can see. The tool makes EXACTLY ONE api write —
// POST /v1/shipments/:id/claim — which the api records as a `message.received` on the 'portal' channel with
// intent 'claim' (portal-actions.ts). That rides an EXISTING event kind at ZERO budget cost: no new event kind,
// no new table (doc 10 §37 — "claims live as event-chains + documents + money_lines"). The claim lands on the
// shipment timeline and fans the Concierge/ops queue. The api LENS-GATES :id (the caller must see the shipment)
// and appends THROUGH the sequencer, so every gate runs (REQ-030) — there is no bypass here.
//
// The write goes through `mutatingCallApi`, so a mis-declared mutating:false (no chokepoint ⇒ ctx uncleared)
// THROWS rather than silently skipping caps+confirm. FAIL-CLOSED (REQ-192): a non-2xx surfaces an isError
// carrying ONLY the status, never the api's internal error body.
import { z } from "zod";
import { defineTool, mutatingCallApi, ToolError, type ToolCtx } from "./registry.js";

const MAX_ID_LEN = 200;
const MAX_KEY_LEN = 200;
const CLAIM_DESCRIPTION_MAX = 4_000; // mirrors portal-actions.ts ClaimBody — the text rides inline in the hash
const CLAIM_SUBJECT_MAX = 200;

const DisputeInput = z
  .object({
    shipment_id: z.string().min(1).max(MAX_ID_LEN),
    // The claim/dispute text — becomes the message.received body (the api's ClaimBody.description). Named
    // `reason` for the freight sense of a dispute; it is the whole required client surface.
    reason: z.string().min(1).max(CLAIM_DESCRIPTION_MAX),
    // Optional short subject line (the api's ClaimBody.subject), passed through only when provided.
    subject: z.string().min(1).max(CLAIM_SUBJECT_MAX).optional(),
    // The caller's explicit idempotency token (REQ-106) — a retried file collapses to one claim.
    idempotency_key: z.string().min(1).max(MAX_KEY_LEN).optional(),
  })
  .strict();
type DisputeArgs = z.infer<typeof DisputeInput>;

export const disputeTool = defineTool({
  name: "dispute",
  description:
    "File a claim/dispute on a shipment (by shipment id + a reason). The api records it as a portal-channel " +
    "message on the shipment timeline and routes it to the Concierge/ops queue — no new event kind or table. " +
    "Returns the recorded claim's event id. Mutating; the api lens-gates the shipment.",
  inputSchema: DisputeInput,
  mutating: true,
  handler: async (ctx: ToolCtx, args: DisputeArgs) => {
    // THE ONE write. encodeURIComponent bounds :id to a single path segment. The api lens-gates the shipment
    // (a shipment the principal cannot see → 403) — surfaced here as an isError, never a fabricated success.
    const body: Record<string, unknown> = { description: args.reason };
    if (args.subject !== undefined) body.subject = args.subject;
    const res = await mutatingCallApi(ctx, {
      method: "POST",
      path: `/v1/shipments/${encodeURIComponent(args.shipment_id)}/claim`,
      body,
    });
    if (!res.ok) throw new ToolError(`claim failed: api returned ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof data.id !== "string") throw new ToolError("claim returned no event id");
    return { status: "FILED" as const, shipment_id: args.shipment_id, claim_event_id: data.id };
  },
});
