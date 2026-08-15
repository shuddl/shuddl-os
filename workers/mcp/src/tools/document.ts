// WP-13 Task 6 (REQ-101/192) — `get_document`, the MCP DOCUMENTS/INVOICES read tool (NOT mutating).
//
// Three lens-gated reads, chosen by the arguments, all with a freshly minted principal:
//   · default            → GET /v1/shipments/:id/documents — the PORTAL-SAFE documents list (the api omits
//                          r2_key/hash; the bytes never ride the list).
//   · document_id present → GET /v1/documents/:id/url — resolve ONE doc to a SHORT-LIVED signed cap url
//                          (5-min TTL; a miss fails closed to the api's 404 → an isError here).
//   · invoices:true       → GET /v1/invoices — the lens-scoped invoice HEADERS (portal-safe columns; margin/GL
//                          internals never ride this table). The api scopes by lens (party → its own invoices,
//                          tenant → all), and this tool NARROWS to the requested shipment client-side via each
//                          invoice's `shipment_ids` (the api's /v1/invoices ignores a query filter today, so the
//                          precision lives here — assumption noted).
//
// The tool NEVER touches D1/R2 — every column/scope decision is the api's (REQ-030). A read: no chokepoint.
// FAIL-CLOSED (REQ-192): a non-2xx surfaces an isError carrying ONLY the status, never the api's internal body.
import { z } from "zod";
import { defineTool, ToolError, type ToolCtx } from "./registry.js";
import { isRecord } from "../is-record.js";

const MAX_ID_LEN = 200; // shipment id — bound length before the path/hop
const MAX_DOC_ID_LEN = 300; // evidenceDocId = `evidence:<shipment>:<64-hex>` — mirrors documents.ts

const GetDocumentInput = z
  .object({
    shipment_id: z.string().min(1).max(MAX_ID_LEN),
    // A specific document → its short-lived signed cap url (else the whole documents list).
    document_id: z.string().min(1).max(MAX_DOC_ID_LEN).optional(),
    // Return the shipment's invoice headers instead of documents.
    invoices: z.boolean().optional(),
  })
  .strict();
type GetDocumentArgs = z.infer<typeof GetDocumentInput>;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

// An invoice belongs to the shipment iff its `shipment_ids` (a JSON-array column, delivered parsed or as text)
// contains the id. When the column is absent/unparseable, KEEP the invoice: it is already lens-authorized by the
// api, and a read tool must not SILENTLY DROP a row it cannot confidently exclude (fail-open on PRECISION only,
// never on scope — scope is the api's lens).
function invoiceOnShipment(inv: unknown, shipmentId: string): boolean {
  if (!isRecord(inv)) return false;
  const raw = inv.shipment_ids;
  let arr: unknown[] | null = null;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      arr = Array.isArray(parsed) ? parsed : null;
    } catch {
      arr = null;
    }
  }
  if (arr === null) return true; // shape unknown — keep the lens-authorized invoice (precision, not scope)
  return arr.includes(shipmentId);
}

export const getDocumentTool = defineTool({
  name: "get_document",
  description:
    "Fetch a shipment's evidence: the portal-safe documents list (default), a short-lived signed download url for " +
    "one `document_id`, or the shipment's invoice headers when `invoices` is true. A read; no mutation. The api " +
    "enforces the lens scope and the portal-safe columns; the bytes ride a 5-minute signed url, never the list.",
  inputSchema: GetDocumentInput,
  mutating: false,
  handler: async (ctx: ToolCtx, args: GetDocumentArgs) => {
    // A specific document → its short-lived signed cap url (the api re-checks the lens; a miss is its 404).
    if (args.document_id !== undefined) {
      const res = await ctx.callApi(ctx.env, {
        method: "GET",
        path: `/v1/documents/${encodeURIComponent(args.document_id)}/url`,
        jwt: await ctx.mintJwt(),
      });
      if (!res.ok) throw new ToolError(`document url failed: api returned ${res.status}`);
      const data = await readJson(res);
      return { shipment_id: args.shipment_id, document_id: args.document_id, url: data.url, expires_in: data.expires_in };
    }

    // The shipment's invoice headers, narrowed to this shipment client-side (the api scopes by lens).
    if (args.invoices === true) {
      const res = await ctx.callApi(ctx.env, {
        method: "GET",
        path: `/v1/invoices?shipment_id=${encodeURIComponent(args.shipment_id)}`,
        jwt: await ctx.mintJwt(),
      });
      if (!res.ok) throw new ToolError(`invoices failed: api returned ${res.status}`);
      const data = await readJson(res);
      const all = Array.isArray(data.invoices) ? data.invoices : [];
      const invoices = all.filter((inv) => invoiceOnShipment(inv, args.shipment_id));
      return { shipment_id: args.shipment_id, invoices };
    }

    // Default → the portal-safe documents list.
    const res = await ctx.callApi(ctx.env, {
      method: "GET",
      path: `/v1/shipments/${encodeURIComponent(args.shipment_id)}/documents`,
      jwt: await ctx.mintJwt(),
    });
    if (!res.ok) throw new ToolError(`documents failed: api returned ${res.status}`);
    const data = await readJson(res);
    return { shipment_id: args.shipment_id, documents: Array.isArray(data.documents) ? data.documents : [] };
  },
});
