import { useEffect, useState } from "react";
import { Divider, EmptyState, Loading, Mono } from "@shuddl/design";
import { ApiError } from "../lib/api.js";
import { fetchPartyInvoices, type PortalInvoiceRow } from "../api/invoices.js";
import { formatCents } from "../lib/money.js";

// REQ-085 (WP-09 Task 7/11) — the PORTAL INVOICES view. It reads the party's invoice HEADERS through its own
// lens (GET /v1/invoices → invoices billed to the claim party) and renders the summary + totals + status.
// Two honesty rules:
//   · NO MARGIN INTERNALS: `division` (internal org unit) and gl_map (chart-of-accounts) are stripped by the
//     server for a party projection and are NEVER reconstructed here. We read ONLY the safe header fields —
//     even if a future server bug leaked an internal onto the wire, it could never reach the DOM.
//   · money is ALWAYS formatted from INTEGER cents (formatCents), never float math.

// The portal-SAFE header fields only. NO division, NO gl_map, NO issued_event_id — reading only these means an
// internal that leaked onto the wire object can never render.
// The parsed row (§781) — the allowlist is now ENFORCED by the Zod object in api/invoices.ts (non-strict, so
// unknown keys are STRIPPED: an internal that leaked onto the wire still cannot reach the DOM), not merely
// asserted by this interface over an unchecked body.
type InvoiceRow = PortalInvoiceRow;

// invoices.shipment_ids is a JSON-array TEXT column; tolerate an already-parsed array too. Fail CLOSED to an
// empty list on anything malformed — never throw a render (mirrors ShipmentList.parseShipmentIds).
function parseShipmentIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface InvoicesViewProps {
  onAuthError: () => void;
}

export function InvoicesView({ onAuthError }: InvoicesViewProps): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    // PARSED at the boundary (§781): unchecked, a malformed body reached `invoices.reduce(... total_cents)`
    // and rendered NaN as a total — money on screen that is not money. A ZodError becomes the error state.
    fetchPartyInvoices()
      .then((rows) => {
        if (live) setInvoices(rows);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD INVOICES");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  // Integer-cents sum — the exact total across the party's invoices (no float ever touches the money).
  const totalCents = invoices.reduce((sum, inv) => sum + inv.total_cents, 0);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Mono size={10} color="var(--signal-55)">
        INVOICES
      </Mono>
      {loading ? (
        <Loading label="SYNCING INVOICES" />
      ) : error !== null ? (
        <Mono size={11} color="var(--signal-deep)">
          {error}
        </Mono>
      ) : invoices.length === 0 ? (
        <EmptyState>No invoices billed to you yet</EmptyState>
      ) : (
        <div>
          {invoices.map((inv) => {
            const shipmentIds = parseShipmentIds(inv.shipment_ids);
            return (
              <div key={inv.id}>
                <Divider />
                <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                    <Mono size={12}>{inv.id}</Mono>
                    <Mono size={12}>{formatCents(inv.total_cents)}</Mono>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                    <Mono size={10} color="var(--signal-55)">
                      {shipmentIds.length > 0 ? shipmentIds.join(" · ") : "—"}
                    </Mono>
                    <Mono size={10} color="var(--signal-55)">
                      {inv.status.toUpperCase()}
                    </Mono>
                  </div>
                </div>
              </div>
            );
          })}

          <Divider />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "10px 0" }}>
            <Mono size={11} color="var(--signal-55)">
              TOTAL
            </Mono>
            <Mono size={12}>
              <span data-testid="invoices-total">{formatCents(totalCents)}</span>
            </Mono>
          </div>
        </div>
      )}
    </section>
  );
}
