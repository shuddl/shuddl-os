// WP-13 Task 4 (REQ-101/107/195) — `quote_freight`, the MCP QUOTE tool (mutating).
//
// The DoD booking path, first half: a caller (Claude, via MCP) hands shipper/consignee/bill-to + lane +
// physics; the tool COMPOSES OVER THE EXISTING api verbs — POST /v1/parties (find-or-create) → POST
// /v1/shipments (stamped with this pairing) → POST /v1/rate — and returns the quote + the shipment id + the
// quote.priced event id the caller accepts in book_shipment. Every write goes through `mutatingCallApi`, so a
// mis-declared tool (mutating:false ⇒ no chokepoint ⇒ ctx uncleared) fails LOUDLY instead of bypassing
// caps+confirm. There is NO second gate here: the api's server-side gates (auth, "no price on air", REQ-030)
// run UNCHANGED on the service-binding round-trip — the MCP caller is just another api client.
//
// TWO invariants this tool carries:
//   · OWNERSHIP PROVENANCE (REQ-107): the shipment is stamped `refs:{pairing: ctx.pairingId}` so a later
//     book_shipment (and any audit) can tell WHICH pairing originated it. `refs` is stored verbatim by intake.ts.
//   · NO PRICE ON AIR (REQ-004, end to end): a weightless/dimless quote returns the api's UNKNOWN verbatim —
//     the tool NEVER fabricates a sell, and never even hops for a priced-event id (there is no priced fact).
import { z } from "zod";
import { defineTool, mutatingCallApi, ToolError, type ToolCtx } from "./registry.js";

// Byte-identical to intake.ts / rate.ts (the api is the authority; these bound the tool input BEFORE the hop).
const PARTY_KINDS = ["shipper", "consignee", "carrier", "broker", "cartage", "factor", "insurer"] as const;
const SHIPMENT_MODES = ["LTL", "TL", "brokered", "cartage", "dray", "transload"] as const;
const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 320;
const MAX_ZIP_LEN = 20;
const MAX_ACCESSORIALS = 32;
const MAX_KEY_LEN = 200;

// One party as the caller supplies it. `kind` is optional — it defaults per role (shipper/consignee/bill-to)
// so an LLM caller need not know the 7-kind taxonomy, but MAY override it (a broker-billed move).
const PartyInput = z
  .object({
    name: z.string().min(1).max(MAX_NAME_LEN),
    email: z.string().min(1).max(MAX_EMAIL_LEN).optional(),
    kind: z.enum(PARTY_KINDS).optional(),
  })
  .strict();
type PartyArgs = z.infer<typeof PartyInput>;

// Mirrors rate.ts Dims — integer inches/pieces. Absent dims (or absent weight) ⇒ the api returns UNKNOWN.
const Dims = z
  .object({
    l_in: z.number().int().nonnegative(),
    w_in: z.number().int().nonnegative(),
    h_in: z.number().int().nonnegative(),
    pieces: z.number().int().positive(),
  })
  .strict();

const QuoteFreightInput = z
  .object({
    shipper: PartyInput,
    consignee: PartyInput,
    // Omitted ⇒ the shipper is billed (the common CSR default); provided ⇒ a distinct bill-to party.
    bill_to: PartyInput.optional(),
    origin_zip: z.string().min(1).max(MAX_ZIP_LEN),
    dest_zip: z.string().min(1).max(MAX_ZIP_LEN),
    // Physics is OPTIONAL on purpose: missing weight/dims is LEGAL and flows to the api's UNKNOWN (no price
    // on air) — it is never a client-side 400 here.
    weight_lb: z.number().int().positive().optional(),
    dims: Dims.optional(),
    accessorials: z.array(z.string().min(1).max(MAX_NAME_LEN)).max(MAX_ACCESSORIALS).optional(),
    mode: z.enum(SHIPMENT_MODES).optional(),
    // The caller's explicit "this is one operation" token — deriveIdempotencyKey reads it (REQ-106) so a
    // retried quote collapses to one shipment/quote regardless of other arg jitter.
    idempotency_key: z.string().min(1).max(MAX_KEY_LEN).optional(),
  })
  .strict();
type QuoteFreightArgs = z.infer<typeof QuoteFreightInput>;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export const quoteFreightTool = defineTool({
  name: "quote_freight",
  description:
    "Quote a freight shipment: find-or-create the shipper/consignee/bill-to parties, materialize a quote-stage " +
    "shipment stamped to this pairing, and price it. Returns the sell + transit + the shipment id + the " +
    "quote.priced event id (to accept via book_shipment). Missing weight/dims ⇒ UNKNOWN (no price on air).",
  inputSchema: QuoteFreightInput,
  mutating: true,
  handler: async (ctx: ToolCtx, args: QuoteFreightArgs) => {
    // THE api idempotency middleware keys off (tenant · method · pathname · key) with NO body — so THREE POST
    // /v1/parties under ONE key would replay the FIRST party's id (consignee/bill-to would collapse onto the
    // shipper). Give each write its OWN sub-key: distinct per pathname-collision, yet DETERMINISTIC across a
    // retry of this whole tool call (ctx.idempotencyKey is itself derived from the semantic operation, REQ-106).
    const sub = (name: string): ToolCtx => ({ ...ctx, idempotencyKey: `${ctx.idempotencyKey}:${name}` });

    const createParty = async (slot: string, party: PartyArgs, defaultKind: string): Promise<string> => {
      const body: Record<string, unknown> = { kind: party.kind ?? defaultKind, name: party.name };
      if (party.email !== undefined) body.email = party.email;
      const res = await mutatingCallApi(sub(`party:${slot}`), { method: "POST", path: "/v1/parties", body });
      if (!res.ok) throw new ToolError(`create party (${slot}) failed: api returned ${res.status}`);
      const id = (await readJson(res)).id;
      if (typeof id !== "string") throw new ToolError(`create party (${slot}) returned no id`);
      return id;
    };

    const shipperId = await createParty("shipper", args.shipper, "shipper");
    const consigneeId = await createParty("consignee", args.consignee, "consignee");
    const billToId = args.bill_to !== undefined ? await createParty("bill_to", args.bill_to, "shipper") : shipperId;

    // Materialize the quote-stage shipment, STAMPED with this pairing (ownership provenance, REQ-107). intake.ts
    // stores `refs` verbatim and leaves the row at quote stage (no booking.created) — the first real booking is
    // still the Booking agent's, behind the credit/evidence gates.
    const shipmentBody: Record<string, unknown> = {
      shipper_party_id: shipperId,
      consignee_party_id: consigneeId,
      bill_to_party_id: billToId,
      refs: { pairing: ctx.pairingId },
    };
    if (args.mode !== undefined) shipmentBody.mode = args.mode;
    const shipRes = await mutatingCallApi(sub("shipment"), { method: "POST", path: "/v1/shipments", body: shipmentBody });
    if (!shipRes.ok) throw new ToolError(`create shipment failed: api returned ${shipRes.status}`);
    const shipmentId = (await readJson(shipRes)).shipment_id;
    if (typeof shipmentId !== "string") throw new ToolError("create shipment returned no shipment_id");

    // Price. The api's "no price on air" gate (REQ-004) is authoritative: missing physics/lane/tariff ⇒ UNKNOWN.
    const rateBody: Record<string, unknown> = { shipment_id: shipmentId, origin_zip: args.origin_zip, dest_zip: args.dest_zip };
    if (args.weight_lb !== undefined) rateBody.weight_lb = args.weight_lb;
    if (args.dims !== undefined) rateBody.dims = args.dims;
    if (args.accessorials !== undefined) rateBody.accessorials = args.accessorials;
    const rateRes = await mutatingCallApi(sub("rate"), { method: "POST", path: "/v1/rate", body: rateBody });
    if (!rateRes.ok) throw new ToolError(`rate failed: api returned ${rateRes.status}`);
    const quote = await readJson(rateRes);

    // UNKNOWN — surface the api's reason HONESTLY. No sell, and NO events hop (there is no priced fact to find).
    if (quote.status !== "PRICED") {
      return {
        status: "UNKNOWN" as const,
        reason: typeof quote.reason === "string" ? quote.reason : "unknown",
        shipment_id: shipmentId,
      };
    }

    // REQ-107 — the /v1/rate response does NOT carry the quote.priced event id (see rate.ts pricedResponse), so
    // fetch it from the shipment stream. A READ (GET) with a freshly minted principal — the ops tenant lens
    // returns the priced fact. The kind filter narrows to quote.priced; the newest on this fresh stream is the
    // price just computed.
    const eventsRes = await ctx.callApi(ctx.env, {
      method: "GET",
      path: `/v1/shipments/${encodeURIComponent(shipmentId)}/events?kind=quote.priced`,
      jwt: await ctx.mintJwt(),
    });
    if (!eventsRes.ok) throw new ToolError(`fetch quote.priced failed: api returned ${eventsRes.status}`);
    const events = (await readJson(eventsRes)).events;
    const list = Array.isArray(events) ? events : [];
    const newest = list.length > 0 ? (list[list.length - 1] as { id?: unknown }) : undefined;
    if (newest === undefined || typeof newest.id !== "string") throw new ToolError("priced, but no quote.priced event on the stream");

    return {
      status: "PRICED" as const,
      shipment_id: shipmentId,
      quote_event_id: newest.id, // accept THIS in book_shipment
      sell_cents: quote.sell_cents,
      transit: quote.transit,
      approval: quote.approval,
      floors: quote.floors,
      anomaly: quote.anomaly,
    };
  },
});
