// WP-13 Task 6 (REQ-101/192) — `track`, the MCP shipment-FEED read tool (NOT mutating).
//
// A caller (Claude, via MCP) hands a shipment id (+ an optional event-kind filter); the tool GETs the api's
// lens-scoped feed — GET /v1/shipments/:id/events — with a freshly minted principal and returns the events
// UNTOUCHED. The api has ALREADY narrowed them to the caller's lens (readEvents: internal fields stripped,
// positions coarsened to ~city pre-OFD, the visibility WHERE bound). The tool NEVER re-fetches raw D1 (it has
// no D1 binding) and NEVER re-widens the feed — it is a pure pass-through, so the ops tenant lens the MCP
// principal carries is the ONLY scope this tool can ever surface. A read: no chokepoint, plain callApi.
//
// FAIL-CLOSED (REQ-192): a lens that returns an EMPTY feed (a shipment outside the caller's scope) surfaces an
// empty list, never a fabricated event; a non-2xx from the api surfaces an isError result carrying ONLY the
// status code — never the api's internal error body / any stack.
import { z } from "zod";
import { defineTool, ToolError, type ToolCtx } from "./registry.js";

const MAX_ID_LEN = 200; // a shipment id is a slug; bound length before the path/hop (mirrors book.ts)
const MAX_KIND_LEN = 64; // one event-kind token; the api validates it against the frozen 35-kind catalog

// The kind filter is passed THROUGH verbatim; the api's parseKinds is the single authority on the 35-kind
// catalog (an unknown kind → the api's 400, surfaced here as an isError). The tool does NOT re-declare the
// catalog (no drift): one validator, server-side.
const TrackInput = z
  .object({
    shipment_id: z.string().min(1).max(MAX_ID_LEN),
    kind: z.string().min(1).max(MAX_KIND_LEN).optional(),
  })
  .strict();
type TrackArgs = z.infer<typeof TrackInput>;

export const trackTool = defineTool({
  name: "track",
  description:
    "Return a shipment's event feed through this principal's lens (internal fields stripped, positions coarsened " +
    "to ~city until out-for-delivery — the api narrows it). Optional `kind` filters to one event kind. A read; no " +
    "mutation. A shipment outside scope returns an empty feed (never a fabricated event).",
  inputSchema: TrackInput,
  mutating: false,
  handler: async (ctx: ToolCtx, args: TrackArgs) => {
    const query = args.kind !== undefined ? `?kind=${encodeURIComponent(args.kind)}` : "";
    const res = await ctx.callApi(ctx.env, {
      method: "GET",
      path: `/v1/shipments/${encodeURIComponent(args.shipment_id)}/events${query}`,
      jwt: await ctx.mintJwt(),
    });
    // Fail-closed: any non-2xx (a bad kind → 400, an unresolved lens → 403, etc.) is an isError carrying ONLY
    // the status — never the api's internal error body (REQ-192).
    if (!res.ok) throw new ToolError(`track failed: api returned ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Pass the LENS-NARROWED events through untouched — the tool never re-shapes or re-widens what the api scoped.
    const events = Array.isArray(data.events) ? data.events : [];
    return { shipment_id: args.shipment_id, events, next_cursor: data.next_cursor ?? null };
  },
});
