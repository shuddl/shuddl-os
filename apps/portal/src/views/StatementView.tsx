import { useEffect, useMemo, useState } from "react";
import { Button, Divider, Loading, Mono } from "@shuddl/design";
import { daysPastDue, rollupAging, type AgeableInvoice } from "@shuddl/contracts";
import { ApiError, get } from "../lib/api.js";
import { formatCents } from "../lib/money.js";

// REQ-090 (WP-11 Task 11) — the portal STATEMENT surface: a bill-to party's account at a glance. It reads
// the SAME lens-scoped party invoices as the INVOICES tab (GET /v1/invoices → only invoices billed to the
// claim party; division/gl_map already stripped server-side, REQ-179) and rolls them up CLIENT-side into:
//   · an AGING summary (current / 1–30 / 31–60 / >60 past due + a no-terms pool), keyed on due_ts vs now;
//   · an honest PAID-vs-OPEN balance — the total owed is the sum of OPEN (issued) invoices only; a settled
//     ('paid') invoice never counts toward what's owed and shows PAID;
//   · a remit / "how to pay" AFFORDANCE — informational ONLY. Pay EXECUTION (escrow/settle/Stripe) is
//     CONFIRM-gated OUT (CLAUDE.md do-not): nothing here moves money. The CTA reveals remit guidance and
//     fires NO network mutation.
// Three honesty rules carry over from the INVOICES precedent:
//   · NO MARGIN INTERNALS — we read ONLY the party-safe header fields; a division/gl_map that leaked onto
//     the wire object can never reach the DOM.
//   · money is ALWAYS formatted from INTEGER cents (formatCents), never float math.
//   · a NULL due_ts is honest "no terms" — never invented as overdue.

// Party-SAFE header fields only. NO division, NO gl_map, NO issued_event_id — reading only these means an
// internal that leaked onto the wire can never render (mirrors InvoicesView.InvoiceRow).
interface InvoiceRow extends AgeableInvoice {
  id: string;
  party_id: string;
  total_cents: number;
  status: string;
  due_ts: number | null;
}

export interface StatementViewProps {
  onAuthError: () => void;
  now?: number; // injected clock for deterministic aging under test; defaults to Date.now()
}

// The due indicator for one open invoice row — honest, never fabricated. A NULL due_ts is "NO TERMS";
// otherwise the ISO due date plus how far past due (or "CURRENT" when not yet due).
function dueLabel(dueTs: number | null, now: number): string {
  if (dueTs === null) return "NO TERMS";
  const iso = new Date(dueTs).toISOString().slice(0, 10);
  const dpd = daysPastDue(dueTs, now);
  return dpd > 0 ? `DUE ${iso} · ${dpd}D PAST DUE` : `DUE ${iso} · CURRENT`;
}

export function StatementView({ onAuthError, now }: StatementViewProps): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showRemit, setShowRemit] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
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
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD STATEMENT");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onAuthError]);

  const clock = now ?? Date.now();
  const rollup = useMemo(() => rollupAging(invoices, clock), [invoices, clock]);
  const open = useMemo(() => invoices.filter((inv) => inv.status === "issued"), [invoices]);
  const paid = useMemo(() => invoices.filter((inv) => inv.status === "paid"), [invoices]);

  if (loading) {
    return (
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Mono size={10} color="var(--signal-55)">
          STATEMENT
        </Mono>
        <Loading label="SYNCING STATEMENT" />
      </section>
    );
  }
  if (error !== null) {
    return (
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Mono size={10} color="var(--signal-55)">
          STATEMENT
        </Mono>
        <Mono size={11} color="var(--signal-deep)">
          {error}
        </Mono>
      </section>
    );
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Mono size={10} color="var(--signal-55)">
        STATEMENT
      </Mono>

      {/* AGING SUMMARY — buckets in display order (integer cents), plus a no-terms pool when present. */}
      <Mono size={10} color="var(--signal-55)">
        AGING
      </Mono>
      {rollup.buckets.map((b) => (
        <div key={b.slug} style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
          <Mono size={11} color="var(--signal-55)">
            {b.label}
          </Mono>
          <Mono size={12}>
            <span data-testid={`aging-${b.slug}`}>{formatCents(b.cents)}</span>
          </Mono>
        </div>
      ))}
      {rollup.noTermsCents !== 0 ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
          <Mono size={11} color="var(--signal-55)">
            NO TERMS
          </Mono>
          <Mono size={12}>
            <span data-testid="aging-no-terms">{formatCents(rollup.noTermsCents)}</span>
          </Mono>
        </div>
      ) : null}

      {/* PAID vs OPEN — the honest balance. Owed is OPEN (issued) only; a settled invoice never counts. */}
      <Divider />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
        <Mono size={11} color="var(--signal-55)">
          TOTAL OWED
        </Mono>
        <Mono size={12}>
          <span data-testid="statement-owed">{formatCents(rollup.openCents)}</span>
        </Mono>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
        <Mono size={11} color="var(--signal-55)">
          PAID
        </Mono>
        <Mono size={12} color="var(--signal-55)">
          <span data-testid="statement-paid">{formatCents(rollup.paidCents)}</span>
        </Mono>
      </div>

      {/* OPEN INVOICES — each with an honest due indicator (NO TERMS when due_ts is null). */}
      {open.length > 0 ? (
        <>
          <Divider />
          <Mono size={10} color="var(--signal-55)">
            OPEN INVOICES
          </Mono>
          {open.map((inv) => (
            <div key={inv.id} data-testid={`invoice-${inv.id}`} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                <Mono size={12}>{inv.id}</Mono>
                <Mono size={12}>{formatCents(inv.total_cents)}</Mono>
              </div>
              <Mono size={10} color="var(--signal-55)">
                {dueLabel(inv.due_ts, clock)}
              </Mono>
            </div>
          ))}
        </>
      ) : null}

      {/* PAID INVOICES — settled AR, shown honestly as PAID. */}
      {paid.length > 0 ? (
        <>
          <Divider />
          <Mono size={10} color="var(--signal-55)">
            PAID INVOICES
          </Mono>
          {paid.map((inv) => (
            <div key={inv.id} data-testid={`invoice-${inv.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "6px 0" }}>
              <Mono size={12}>{inv.id}</Mono>
              <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                <Mono size={10} color="var(--signal-55)">
                  PAID
                </Mono>
                <Mono size={12}>{formatCents(inv.total_cents)}</Mono>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {/* REMIT / PAY AFFORDANCE — informational ONLY. Settle/escrow/Stripe is CONFIRM-gated OUT: no network
          mutation is ever fired here. The CTA merely reveals remit guidance. */}
      <Divider />
      <Mono size={10} color="var(--signal-55)">
        HOW TO PAY
      </Mono>
      <Mono size={11} color="var(--signal-deep)">
        Remit against your open invoices by their number. Your account manager confirms receipt and this balance updates
        automatically.
      </Mono>
      <div>
        <Button type="button" onClick={() => setShowRemit((v) => !v)}>
          Remit payment
        </Button>
      </div>
      {showRemit ? (
        <Mono size={11} color="var(--signal-deep)">
          <span data-testid="statement-remit-detail">
            Online settlement is not enabled on this portal yet. Contact billing to arrange ACH or check remittance,
            referencing your open invoice numbers above.
          </span>
        </Mono>
      ) : null}
      <Mono size={10} color="var(--signal-55)">
        AFFORDANCE ONLY · NO PAYMENT IS TAKEN HERE
      </Mono>
    </section>
  );
}
