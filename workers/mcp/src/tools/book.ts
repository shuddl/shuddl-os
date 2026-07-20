// WP-13 Task 5 (REQ-101/107/195) — `book_shipment`, the MCP BOOK tool (mutating + money-moving).
//
// The DoD booking path, second half: accept a priced quote. The tool makes EXACTLY ONE api write —
// POST /v1/shipments/:id/accept-quote with {quote_event_id} — which appends `quote.accepted` and NOTHING
// more. A committed quote.accepted TRIGGERS the unchanged Booking agent (agents worker), which produces the
// GATED `booking.created` behind the credit/evidence gates. That is OUT OF THIS TOOL'S SCOPE.
//
// THE NO-BYPASS INVARIANT (REQ-030): this tool's api-call SET STOPS AT accept-quote. It MUST NOT append
// `booking.created`, call any booking route, or reimplement a gate. The proof lives in the test — the recorded
// call set is exactly [POST …/accept-quote], never a booking.created append or a booking route — mirroring the
// translator's own "the append set stops at quote.accepted" invariant (inbound.test.ts) at the callApi seam.
// The write goes through `mutatingCallApi`, so if the tool were mis-declared mutating:false (no chokepoint ⇒
// ctx uncleared) the write would THROW rather than silently skip caps+confirm.
import { z } from "zod";
import { defineTool, mutatingCallApi, ToolError, type ToolCtx } from "./registry.js";

const MAX_ID_LEN = 200; // a shipment id / event id is a slug or uuid; bound length before the path/hop.
const MAX_KEY_LEN = 200;

const BookShipmentInput = z
  .object({
    shipment_id: z.string().min(1).max(MAX_ID_LEN),
    quote_event_id: z.string().min(1).max(MAX_ID_LEN),
    // The caller's explicit idempotency token (REQ-106) — a retried accept collapses to one quote.accepted.
    idempotency_key: z.string().min(1).max(MAX_KEY_LEN).optional(),
    // NOTE (Task 9, REQ-102): the human-CONFIRM gate adds a `confirm` block here. Room is left deliberately;
    // the money-moving accept is the CONFIRM-gated action.
  })
  .strict();
type BookShipmentArgs = z.infer<typeof BookShipmentInput>;

export const bookShipmentTool = defineTool({
  name: "book_shipment",
  description:
    "Accept a priced quote on a shipment (by shipment id + quote.priced event id), appending quote.accepted. " +
    "This TRIGGERS the gated Booking agent that produces booking.created out-of-band; this tool never books " +
    "directly. Returns the quote.accepted event id + the accepted quote + the shipment id (provenance).",
  inputSchema: BookShipmentInput,
  mutating: true,
  handler: async (ctx: ToolCtx, args: BookShipmentArgs) => {
    // THE ONE write. encodeURIComponent bounds the :id to a single path segment (a stray slash can never
    // reshape the route). accept-quote is lens-gated + existence-checked server-side (portal-actions.ts): a
    // shipment this pairing's principal cannot see, or a quote not priced on it, is refused there (403/400) —
    // surfaced here as an isError, never swallowed and never a fabricated success.
    const res = await mutatingCallApi(ctx, {
      method: "POST",
      path: `/v1/shipments/${encodeURIComponent(args.shipment_id)}/accept-quote`,
      body: { quote_event_id: args.quote_event_id },
    });
    if (!res.ok) throw new ToolError(`accept-quote failed: api returned ${res.status}`);
    const accepted = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const acceptedId = accepted.id;
    if (typeof acceptedId !== "string") throw new ToolError("accept-quote returned no event id");

    return {
      status: "ACCEPTED" as const,
      shipment_id: args.shipment_id,
      quote_event_id: args.quote_event_id, // the priced quote accepted (provenance)
      accepted_event_id: acceptedId, // the quote.accepted this appended (triggers the Booking agent)
    };
  },
});
