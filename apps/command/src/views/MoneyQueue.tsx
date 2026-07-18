import { useEffect, useMemo, useState } from "react";
import { Mono } from "@shuddl/design";
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

const DAY_MS = 86_400_000;

// The aging buckets, in display order. `test` maps days-past-due → membership; a null due_ts lands in NO TERMS.
const BUCKETS: ReadonlyArray<{ label: string; test: (daysPastDue: number) => boolean }> = [
  { label: "CURRENT", test: (d) => d <= 0 },
  { label: "1–30D", test: (d) => d >= 1 && d <= 30 },
  { label: "31–60D", test: (d) => d >= 31 && d <= 60 },
  { label: ">60D", test: (d) => d > 60 },
];

interface Aged {
  label: string;
  cents: number;
}

// Sum open invoices into aging buckets (integer cents). Only status='issued' is open AR; 'paid' is settled.
function ageOpenAr(invoices: InvoiceRow[], now: number): Aged[] {
  const totals = new Map<string, number>();
  let noTerms = 0;
  for (const inv of invoices) {
    if (inv.status !== "issued") continue; // open AR only — a settled ('paid') invoice is not aging
    if (inv.due_ts === null) {
      noTerms += inv.total_cents;
      continue;
    }
    const daysPastDue = Math.floor((now - inv.due_ts) / DAY_MS);
    const bucket = BUCKETS.find((b) => b.test(daysPastDue));
    if (bucket) totals.set(bucket.label, (totals.get(bucket.label) ?? 0) + inv.total_cents);
  }
  const aged: Aged[] = [];
  for (const b of BUCKETS) {
    const cents = totals.get(b.label) ?? 0;
    if (cents !== 0) aged.push({ label: b.label, cents });
  }
  if (noTerms !== 0) aged.push({ label: "NO TERMS", cents: noTerms });
  return aged;
}

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
    get<{ invoices: InvoiceRow[] }>("/v1/invoices")
      .then((res) => {
        if (live) setInvoices(res.invoices);
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
  const aged = useMemo(() => ageOpenAr(invoices, clock), [invoices, clock]);
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
