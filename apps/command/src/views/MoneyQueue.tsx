import { useEffect, useMemo, useState } from "react";
import { Mono } from "@shuddl/design";
import { agedOpenArList } from "@shuddl/contracts";
import { z } from "@shuddl/contracts";
import { ApiError, get } from "../lib/api.js";
import { formatCents } from "../intake/intake.js";
import { DarkPanel } from "./ui.js";
import type { KpiValue } from "./registry.js";

// WP-10 Task 12 (REQ-082/083) — the MONEY queue (v_queue_money). Two HONEST signals, no invented "held" state
// (held-invoice visibility is WP-11):
//   · UNBILLED PODS — the count of PODs still needing an invoice, straight from the KPI strip's `unbilled` tile
//     (GET /v1/kpis, computed once by App and passed in). UNKNOWN would render "—", but unbilled is always a real
//     count (0 is the healthy truth), never fabricated.
//   · OPEN AR AGING — the open invoices (status='issued') from GET /v1/invoices, bucketed by days-past-due against
//     the server clock and summed in INTEGER CENTS (formatCents — no float ever touches the money). A 'paid'
//     invoice is settled AR and never counts. due_ts may be null (no terms) → its own honest bucket.

interface InvoiceRow {
  id: string;
  total_cents: number;
  status: string;
  due_ts: number | null;
}

// Open-AR aging is SHARED math (@shuddl/contracts/agedOpenArList) — ONE definition of the buckets +
// days-past-due assignment, so the command queue and the portal STATEMENT (REQ-090) never drift. Only
// status='issued' ages; 'paid' is settled; a null due_ts is honest "NO TERMS", never fabricated overdue.

// The schema mirrors THIS VIEW'S InvoiceRow — the four fields it actually reads — not the full server row.
// Parsing fields a view never uses couples it to unrelated server changes: `/v1/invoices` also returns
// `party_id` and `shipment_ids`, and requiring them here would blank the money queue the day either moves,
// for a view that renders neither. Unknown keys are stripped, so extra fields stay harmless.
const MoneyInvoicesResponse = z.object({
  invoices: z.array(z.object({ id: z.string(), total_cents: z.number(), status: z.string(), due_ts: z.number().nullable() })),
});

export interface MoneyQueueProps {
  unbilled: KpiValue; // from the KPI strip's `unbilled` tile (GET /v1/kpis) — a real count, never fabricated
  onAuthError: () => void;
  now?: number; // injected clock for deterministic aging under test; defaults to Date.now()
}

export function MoneyQueue({ unbilled, onAuthError, now }: MoneyQueueProps): React.JSX.Element {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // PARSED at the boundary (§782) — unchecked, an absent key set state to undefined and the list render
    // below threw on `.length`/`.map`, white-screening the money queue.
    get<unknown>("/v1/invoices")
      .then((raw) => {
        if (live) setInvoices(MoneyInvoicesResponse.parse(raw).invoices as unknown as InvoiceRow[]);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD AR");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  const clock = now ?? Date.now();
  const aged = useMemo(() => agedOpenArList(invoices, clock), [invoices, clock]);
  const unbilledText = unbilled === "UNKNOWN" ? "—" : String(unbilled);

  return (
    <DarkPanel heading="MONEY">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
        <Mono size={12} color="var(--field-on-dark)">
          UNBILLED PODS
        </Mono>
        <Mono size={12} color="var(--field-on-dark)">
          <span data-testid="money-unbilled">{unbilledText}</span>
        </Mono>
      </div>
      <Mono size={10} color="var(--signal-55)">
        OPEN AR AGING
      </Mono>
      {loading ? (
        <Mono size={11} color="var(--field-on-dark)">
          SYNCING
        </Mono>
      ) : error !== null ? (
        <Mono size={11} color="var(--signal)">
          {error}
        </Mono>
      ) : aged.length === 0 ? (
        <Mono size={11} color="var(--field-on-dark)">
          NO OPEN AR
        </Mono>
      ) : (
        aged.map((a) => (
          <div key={a.label} style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
            <Mono size={11} color="var(--signal-55)">
              {a.label}
            </Mono>
            <Mono size={12} color="var(--field-on-dark)">
              {formatCents(a.cents)}
            </Mono>
          </div>
        ))
      )}
    </DarkPanel>
  );
}
