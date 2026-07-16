import { useEffect, useState } from "react";
import { Divider, EmptyState, Loading, Mono, TextLink } from "@shuddl/design";
import { ApiError, get } from "../lib/api.js";
import { formatCents } from "../lib/money.js";

// REQ-085 — the portal board's ruled lists, wired to the real server (the WP-03 shell had hardcoded fixture
// arrays). GET /v1/invoices is the ONE list a portal PARTY can read through its own lens (invoices billed to
// it; documents/events reads need a shipment id). The party's SHIPMENTS are derived from those invoices'
// shipment_ids — the only lens-scoped way to enumerate them here (the /v1/events firehose excludes portal).
// Each shipment row is selectable so the QuotePanel can quote → book against a shipment the party OWNS.
// Design is unchanged: 1px-ruled lists, no cards, mono micro-labels, integer-cents money.

interface InvoiceRow {
  id: string;
  party_id: string;
  shipment_ids: unknown; // TEXT JSON on the wire (invoices.shipment_ids DEFAULT '[]') — parsed defensively
  total_cents: number;
  status: string;
  due_ts: number | null;
}

interface DerivedShipment {
  id: string;
  meta: string; // the honest state we can show from the invoice header (its billing status)
}

// invoices.shipment_ids is a JSON-array TEXT column; tolerate an already-parsed array too. Fail CLOSED to an
// empty list on anything malformed — never throw a render.
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

// The distinct shipments across the party's invoices, each tagged with its (first-seen) invoice status.
function deriveShipments(invoices: readonly InvoiceRow[]): DerivedShipment[] {
  const seen = new Map<string, string>();
  for (const inv of invoices) {
    for (const sid of parseShipmentIds(inv.shipment_ids)) {
      if (!seen.has(sid)) seen.set(sid, inv.status.toUpperCase());
    }
  }
  return [...seen.entries()].map(([id, meta]) => ({ id, meta }));
}

export interface ShipmentListProps {
  onAuthError: () => void;
  onSelectShipment: (id: string) => void;
  selectedShipmentId?: string | undefined;
}

export function ShipmentList({ onAuthError, onSelectShipment, selectedShipmentId }: ShipmentListProps): React.JSX.Element {
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
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD YOUR BOARD");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  const shipments = deriveShipments(invoices);

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
      {loading ? (
        <Loading label="SYNCING YOUR FREIGHT" />
      ) : error !== null ? (
        <Mono size={11} color="var(--signal-deep)">
          {error}
        </Mono>
      ) : (
        <>
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

          <section style={{ display: "flex", flexDirection: "column" }}>
            <Mono size={10} color="var(--signal-55)">
              INVOICES
            </Mono>
            <div style={{ marginTop: 8 }}>
              {invoices.length === 0 ? (
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
        </>
      )}

      <TextLink href="#status">Track a shipment</TextLink>
    </aside>
  );
}

function ShipmentRow({
  shipment,
  selected,
  onSelect,
}: {
  shipment: DerivedShipment;
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
          {shipment.meta}
        </Mono>
      </div>
    </div>
  );
}
