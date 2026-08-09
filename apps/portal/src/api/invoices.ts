import { z } from "@shuddl/contracts";
import type { AgeableInvoice } from "@shuddl/contracts";
import { get } from "../lib/api.js";

// Audit §781 (REQ-085/073) — THE PORTAL'S INVOICE SEAM, parsed.
//
// WHY THIS FILE EXISTS. Three components read GET /v1/invoices — ShipmentList, InvoicesView, StatementView —
// and all three did it like this:
//
//     get<{ invoices: InvoiceRow[] }>("/v1/invoices").then((res) => setInvoices(res.invoices))
//
// That generic is a COMPILE-TIME LIE: `get` returns whatever the server sent, and nothing checked it. A
// response without an `invoices` key set the state to `undefined`, and the very next render reached
// `invoices.length` / `.map` / `.reduce` — an uncaught TypeError that WHITE-SCREENS the portal. The
// `.catch` each component already had could not help: the failure happens later, in render, not in the
// promise. Measured in a real browser (the e2e route mock returned a board shape for every `/v1/**`):
// `PAGEERROR: Cannot read properties of undefined (reading 'length')`, and an empty `<body>`.
//
// A malformed ROW was worse than the crash: `invoices.reduce((sum, inv) => sum + inv.total_cents, 0)` over
// rows missing `total_cents` renders **NaN** as a statement total — money on screen that is not money, with
// no error state at all. CLAUDE.md's stack rule is "Zod at every boundary"; the board seam next door does
// exactly that (`BoardResponse.parse`), and this seam was the one that did not.
//
// NOT `.strict()`, DELIBERATELY — and this is the one place it differs from `api/board.ts`. All three
// components document the same intent: *"reading ONLY these means an internal that leaked onto the wire
// object can never render."* A default (non-strict) Zod object STRIPS unknown keys, which IS that allowlist
// enforced at runtime rather than merely described in a comment. `.strict()` would instead THROW on a
// server that added a harmless field, turning a forward-compatible response into a blank billing page. So:
// reject a missing/mistyped REQUIRED field, silently drop everything else.
const InvoiceRow = z.object({
  id: z.string(),
  party_id: z.string(),
  total_cents: z.number(),
  status: z.string(),
  // Honest "no terms" — never invented as overdue (StatementView's rule). Null is a value, not an absence.
  due_ts: z.number().nullable(),
  // TEXT JSON on the wire (invoices.shipment_ids DEFAULT '[]'); each consumer parses it defensively and
  // fails closed to []. Kept `unknown` so this schema does not duplicate — or disagree with — that handling.
  shipment_ids: z.unknown().optional(),
});

const InvoicesResponse = z.object({ invoices: z.array(InvoiceRow) });

/** One portal-safe invoice header row. Structurally satisfies AgeableInvoice (total_cents/status/due_ts). */
export type PortalInvoiceRow = z.infer<typeof InvoiceRow> & AgeableInvoice;

/**
 * Fetch the party's invoices through its own lens. Throws ApiError on a non-2xx (callers branch on
 * isAuthError → re-auth) or a ZodError on a malformed body — which every caller's existing `.catch` already
 * routes to its honest error state, so a bad payload becomes a refusal on screen instead of a white screen.
 */
export async function fetchPartyInvoices(): Promise<PortalInvoiceRow[]> {
  const raw = await get<unknown>("/v1/invoices");
  return InvoicesResponse.parse(raw).invoices as PortalInvoiceRow[];
}
