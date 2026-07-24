import { useEffect, useState } from "react";
import { Divider, EmptyState, Loading, Mono, TextLink } from "@shuddl/design";
import { ApiError, get } from "../lib/api.js";
import { formatCents } from "../lib/money.js";

// REQ-085 / remediation Task 12 — the portal board's ruled lists.
//   • SHIPMENTS is the party's LIVE freight, passed down from the SERVER-SCOPED board (GET /v1/board): the same
//     positioned shipments the map draws, party-scoped + generalized server-side (App.tsx / api/board.ts). This
//     replaces the earlier workaround that enumerated shipments from invoice.shipment_ids — the board is the
//     authoritative, live source, so a shipment shows here iff it is on the map. Each row is selectable so the
//     QuotePanel / documents / custody views act on a shipment the party OWNS.
//   • INVOICES is the party's billing summary (GET /v1/invoices) — invoices billed to it, through its own lens.
// Design is unchanged: 1px-ruled lists, no cards, mono micro-labels, integer-cents money.

interface InvoiceRow {
  id: string;
  party_id: string;
  total_cents: number;
  status: string;
  due_ts: number | null;
}

// A live board shipment as the list renders it: the id + its map status (healthy | at-risk | exception),
// shown as the row's honest meta. Supplied by App from the server board — never derived on the client.
export interface BoardShipment {
  id: string;
  status: string;
}

export interface ShipmentListProps {
  shipments: readonly BoardShipment[];
  onAuthError: () => void;
  onSelectShipment: (id: string) => void;
  selectedShipmentId?: string | undefined;
}

export function ShipmentList({ shipments, onAuthError, onSelectShipment, selectedShipmentId }: ShipmentListProps): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    get<{ invoices: InvoiceRow[] }>("/v1/invoices")
      .then((res) => {
        if (!live) return;
        setInvoices(res.invoices);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD YOUR INVOICES");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  return (
    <aside
      style={{
        position: "absolute",
        bottom: 32,
        left: 32,
        width: "min(420px, 92vw)",
        background: "var(--field)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      {/* SHIPMENTS — the live server board (App owns its loading); a mark shows here iff it is on the map. */}
      <section style={{ display: "flex", flexDirection: "column" }}>
        <Mono size={10} color="var(--signal-55)">
          SHIPMENTS
        </Mono>
        <div style={{ marginTop: 8 }}>
          {shipments.length === 0 ? (
            <EmptyState>No active shipments</EmptyState>
          ) : (
            shipments.map((s) => (
              <ShipmentRow
                key={s.id}
                shipment={s}
                selected={s.id === selectedShipmentId}
                onSelect={() => onSelectShipment(s.id)}
              />
            ))
          )}
        </div>
      </section>

      {/* INVOICES — the party's billing summary (its own lens-scoped read). */}
      <section style={{ display: "flex", flexDirection: "column" }}>
        <Mono size={10} color="var(--signal-55)">
          INVOICES
        </Mono>
        <div style={{ marginTop: 8 }}>
          {loading ? (
            <Loading label="SYNCING YOUR INVOICES" />
          ) : error !== null ? (
            <Mono size={11} color="var(--signal-deep)">
              {error}
            </Mono>
          ) : invoices.length === 0 ? (
            <EmptyState>No invoices yet</EmptyState>
          ) : (
            invoices.map((inv) => (
              <div key={inv.id}>
                <Divider />
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "10px 0" }}>
                  <Mono size={12}>{inv.id}</Mono>
                  <Mono size={12} color="var(--signal-55)">
                    {formatCents(inv.total_cents)} · {inv.status.toUpperCase()}
                  </Mono>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <TextLink href="#status">Track a shipment</TextLink>
    </aside>
  );
}

function ShipmentRow({
  shipment,
  selected,
  onSelect,
}: {
  shipment: BoardShipment;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <div>
      <Divider />
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "10px 0", cursor: "pointer" }}
      >
        <Mono size={12} color={selected ? "var(--signal)" : "var(--signal-deep)"}>
          {selected ? `▸ ${shipment.id}` : shipment.id}
        </Mono>
        <Mono size={12} color="var(--signal-55)">
          {shipment.status.toUpperCase()}
        </Mono>
      </div>
    </div>
  );
}
