// REQ-012 / REQ-057 / I1 / I7 — money is a PROJECTION of physics. `projectMoneyLines` is a pure
// function: (event, deps) -> the money_lines + invoices rows that event implies. It never touches
// the DB (the caller loads deps and executes). `applyMoneyProjection` turns those rows into PREPARED
// statements so the Task-13 sequencer can put them in the SAME db.batch() as the event INSERT — the
// event and its lines commit together or not at all (I1 both directions). INTEGER CENTS ONLY.
import type { LedgerEvent } from "@shuddl/contracts";
// REQ-020 — GL accounts for the non-invoice money kinds (invoice lines carry their own gl_map on the
// payload). Drawn from the ONE canonical chart-of-accounts (contracts gl-accounts), the same registry
// the Biller GL_MAP and the journal export use, so the whole system reconciles against a single chart
// (Task-3 qb-journal-month). Strings unchanged; the gl-accounts parity test guards a future drift.
import { GL_INTERLINE_AP as INTERLINE_GL, GL_COD_CLEARING as COD_GL, GL_SETTLEMENT_FEE as SETTLE_GL } from "@shuddl/contracts";
import { allocateCents } from "../money/split.js";

// REQ-083 — the documented system DEFAULT payment terms an issued invoice falls back to when nothing more
// specific is on file. net-30 is a real, ubiquitous AR business default (NOT a fabricated due date); the
// sequencer sources it server-side and hands it to the projection as deps.termsDays. Documented HERE so the
// DSO built on due_ts is honest ("assumes standard net-30 when the ledger carries no terms"). The
// invoice.issued payload carries no terms field, and booking.created.bill_terms is a billing-RESPONSIBILITY
// code (prepaid/collect/third_party) — NOT a net-days payment term — so neither yields a due date today.
export const DEFAULT_TERMS_DAYS = 30;
const DAY_MS = 86_400_000; // integer canonical law: due_ts stays an integer number of ms

export type MoneyDirection = "ar" | "ap";
export type MoneyKind =
  | "freight" | "fsc" | "accessorial" | "correction_credit" | "correction_debit"
  | "interline_split" | "cod_collect" | "settle_fee" | "credit_purchase";

// A projected money_lines row. Every amount is an integer number of cents (never a float).
export interface MoneyLineRow {
  id: string;
  shipment_id: string | null;
  event_id: string;
  line_no: number;
  direction: MoneyDirection;
  kind: MoneyKind;
  amount_cents: number;
  currency: string;
  party_id: string;
  division: string;
  gl_map: string;
  corrects_event_id: string | null;
  basis: string;
  created_ts: number;
}

// The invoices projection row (REQ-057: division filterable everywhere). `insert` upserts on issue (carrying
// REQ-083 terms/due_ts); `update` re-totals an existing invoice on a reissue; `void` flips a fully-reversed
// invoice OUT of 'issued' to {status:'void', total_cents:0} (REQ-119: a void is a correction, not a no-op —
// the AR read-model must land on the same 0 the reversing money_lines do, else every read that scopes open AR
// on status='issued' — the Collector dunning sweep, computeDsoDays, the aging rollup — overstates it forever);
// `settle` flips a matched OPEN invoice to 'paid' when a payment.received covers it (REQ-083, the AR-settlement
// write an honest DSO needs). invoices is a MUTABLE read-model — all four are legal (events/money_lines are not).
export type InvoiceUpsert =
  | { mode: "insert"; id: string; party_id: string; division: string; total_cents: number; status: string; issued_event_id: string; terms: string | null; due_ts: number | null }
  | { mode: "update"; id: string; total_cents: number; status: string; issued_event_id: string }
  | { mode: "void"; id: string; total_cents: number; status: string }
  | { mode: "settle"; id: string; status: string };

// The in-effect (positive) money_lines of the event a correction targets. The caller loads these
// (SELECT ... WHERE event_id = corrects_event_id AND amount_cents > 0). Correcting a correction
// therefore reverses the LATEST event's reissue lines, not the whole history.
export interface OriginalLine {
  line_no: number;
  amount_cents: number;
  gl_map: string;
  party_id: string;
  division: string;
}

export interface MoneyProjectionDeps {
  originalLines?: readonly OriginalLine[]; // required for invoice.corrected
  division?: string; // shipment division for split/cod/settle (their payloads don't carry one)
  // REQ-083 — the resolved payment-terms window (integer DAYS) for an invoice.issued, sourced SERVER-SIDE by
  // the sequencer (the documented DEFAULT_TERMS_DAYS today). undefined ⇒ NO terms on file ⇒ terms/due_ts
  // project NULL (honest; the aging view never invents a due date).
  termsDays?: number;
  // REQ-083 — the OPEN invoice a payment.received settles, matched SERVER-SIDE (by payload.invoice_id, else
  // the shipment's open invoice). Present ⇒ a covering payment flips it to 'paid'; undefined ⇒ nothing to settle.
  settleInvoice?: { id: string; total_cents: number };
}

export interface MoneyProjection {
  lines: MoneyLineRow[];
  invoices: InvoiceUpsert[];
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) ? v : undefined;

/**
 * Pure projection. Exhaustive over all 35 event kinds: the five money kinds project rows, the other
 * thirty project nothing, and the `never` guard makes a future 36th kind a COMPILE error (it can
 * never silently project zero money).
 */
export function projectMoneyLines(e: LedgerEvent, deps: MoneyProjectionDeps): MoneyProjection {
  const shipment = e.shipment_id ?? null;
  const ts = e.recorded_at;
  const empty = (): MoneyProjection => ({ lines: [], invoices: [] });
  const row = (o: Omit<MoneyLineRow, "shipment_id" | "event_id" | "currency" | "basis" | "created_ts" | "id"> & { id: string }): MoneyLineRow => ({
    shipment_id: shipment,
    event_id: e.id,
    currency: "USD",
    basis: "{}",
    created_ts: ts,
    ...o,
  });

  switch (e.kind) {
    case "invoice.issued": {
      const p = e.payload;
      const lines = p.lines.map((l) =>
        row({
          id: `${e.id}#${l.line_no}`,
          line_no: l.line_no,
          direction: "ar",
          kind: l.kind,
          amount_cents: l.amount_cents,
          party_id: p.party_id,
          division: p.division,
          gl_map: l.gl_map,
          corrects_event_id: null,
        }),
      );
      const total = p.lines.reduce((s, l) => s + l.amount_cents, 0);
      // REQ-083 — terms + due_ts for an honest DSO. termsDays is resolved SERVER-SIDE (deps); undefined ⇒
      // NULL (no terms on file, never a fabricated due date). due_ts anchors on the ISSUE ts (the invoice's
      // own business timestamp, NOT recorded_at) and stays an integer number of ms.
      const termsDays = deps.termsDays;
      const terms = termsDays !== undefined ? `net${termsDays}` : null;
      const dueTs = termsDays !== undefined ? e.ts + termsDays * DAY_MS : null;
      return {
        lines,
        invoices: [
          { mode: "insert", id: p.invoice_id, party_id: p.party_id, division: p.division, total_cents: total, status: "issued", issued_event_id: e.id, terms, due_ts: dueTs },
        ],
      };
    }

    case "invoice.corrected": {
      const p = e.payload;
      const originals = deps.originalLines ?? [];
      // Full reversal: one correction_credit per in-effect original line (amount negated), tagged
      // with corrects_event_id so ux_ml_corrects(corrects_event_id, line_no) makes a SECOND
      // correction of the same event a DB error (I7: one correction per event).
      const credits: MoneyLineRow[] = originals.map((o, j) =>
        row({
          id: `${e.id}#${j + 1}`,
          line_no: j + 1,
          direction: "ar",
          kind: "correction_credit",
          amount_cents: -o.amount_cents,
          party_id: o.party_id,
          division: o.division,
          gl_map: o.gl_map,
          corrects_event_id: p.corrects_event_id,
        }),
      );
      // Reissue: new charges. Not reversals -> corrects_event_id NULL. line_no continues past the
      // credits so it never collides with them under UNIQUE(event_id, line_no).
      const invParty = originals[0]?.party_id;
      const invDivision = originals[0]?.division;
      if (p.reissue_lines.length > 0 && (invParty === undefined || invDivision === undefined)) {
        throw new Error("invoice.corrected: reissue requires the original lines (deps.originalLines) to inherit party/division");
      }
      const debits: MoneyLineRow[] = p.reissue_lines.map((l, j) =>
        row({
          id: `${e.id}#${credits.length + j + 1}`,
          line_no: credits.length + j + 1,
          direction: "ar",
          kind: "correction_debit",
          amount_cents: l.amount_cents,
          party_id: invParty ?? "",
          division: invDivision ?? "",
          gl_map: l.gl_map,
          corrects_event_id: null,
        }),
      );
      const invoices: InvoiceUpsert[] =
        p.reissue_lines.length === 0
          // A void reissues nothing, but it is NOT a no-op on the AR row: flip the invoices projection OUT of
          // 'issued' to {status:'void', total_cents:0} so every read that scopes open AR on status='issued'
          // (Collector dunning, computeDsoDays, aging rollup) drops it — the credits net money_lines to 0 in
          // this SAME batch, so both read-models of the event land on the same economic truth (REQ-119, I1).
          ? [{ mode: "void", id: p.invoice_id, total_cents: 0, status: "void" }]
          : [{ mode: "update", id: p.invoice_id, total_cents: p.reissue_lines.reduce((s, l) => s + l.amount_cents, 0), status: "issued", issued_event_id: e.id }];
      return { lines: [...credits, ...debits], invoices };
    }

    case "split.computed": {
      const p = e.payload;
      const cents = allocateCents(p.total_cents, p.allocations.map((a) => a.share_bps));
      const division = deps.division ?? "main";
      const lines: MoneyLineRow[] = [];
      p.allocations.forEach((a, j) => {
        const amount = cents[j] ?? 0;
        if (amount === 0) return; // a zero share would violate money_lines CHECK(amount_cents != 0)
        lines.push(
          row({
            id: `${e.id}#${j + 1}`,
            line_no: j + 1,
            direction: "ap",
            kind: "interline_split",
            amount_cents: amount,
            party_id: a.party_id,
            division,
            gl_map: INTERLINE_GL,
            corrects_event_id: null,
          }),
        );
      });
      return { lines, invoices: [] };
    }

    case "payment.received": {
      const amount = asInt(e.payload["amount_cents"]);
      // REQ-083 — AR SETTLEMENT: flip the matched OPEN invoice to 'paid' when this payment COVERS it in full.
      // deps.settleInvoice is the invoice the sequencer matched (by payload.invoice_id, else the shipment's
      // open invoice). Pay-in-full model: a partial payment (|amount| < total) leaves the invoice OPEN —
      // still outstanding AR for the DSO; v1 carries no running-balance/'partial' state. Idempotent: the
      // settle UPDATE is guarded WHERE status='issued', and an already-paid invoice yields no match upstream.
      // This is ORTHOGONAL to the cod_collect money_line below — settlement applies to EVERY method.
      const target = deps.settleInvoice;
      const settle: InvoiceUpsert[] =
        target !== undefined && amount !== undefined && Math.abs(amount) >= target.total_cents
          ? [{ mode: "settle", id: target.id, status: "paid" }]
          : [];

      // The cod_collect money_line is UNCHANGED (money-parity is sacred): only a COD collection posts a
      // negative AR (cash collected at the door); every other method posts none.
      if (asString(e.payload["method"]) !== "cod") return { lines: [], invoices: settle };
      if (amount === undefined) throw new Error("payment.received (cod): integer amount_cents required");
      return {
        lines: [
          row({
            id: `${e.id}#1`,
            line_no: 1,
            direction: "ar",
            kind: "cod_collect",
            amount_cents: -Math.abs(amount),
            party_id: asString(e.payload["party_id"]) ?? e.actor.party,
            division: asString(e.payload["division"]) ?? deps.division ?? "main",
            gl_map: COD_GL,
            corrects_event_id: null,
          }),
        ],
        invoices: settle,
      };
    }

    case "settlement.executed": {
      // Dormant: settlement is a CONFIRM-gated feature (do-not-build until signed). The projection
      // exists and is synthetically tested; it only posts when a nonzero fee is present.
      const fee = asInt(e.payload["fee_cents"]);
      if (fee === undefined || fee === 0) return empty();
      return {
        lines: [
          row({
            id: `${e.id}#1`,
            line_no: 1,
            direction: "ap",
            kind: "settle_fee",
            amount_cents: fee,
            party_id: asString(e.payload["party_id"]) ?? e.actor.party,
            division: asString(e.payload["division"]) ?? deps.division ?? "main",
            gl_map: SETTLE_GL,
            corrects_event_id: null,
          }),
        ],
        invoices: [],
      };
    }

    // The other 30 kinds carry no money. Listed explicitly so the `never` guard below is real.
    case "quote.requested":
    case "quote.priced":
    case "quote.sent":
    case "quote.accepted":
    case "quote.expired":
    case "booking.created":
    case "credit.checked":
    case "appointment.set":
    case "pickup.scheduled":
    case "dispatch.assigned":
    case "stop.arrived":
    case "freight.counted":
    case "freight.photographed":
    case "dims.captured":
    case "custody.transferred":
    case "seal.applied":
    case "stop.departed":
    case "position.updated":
    case "exception.raised":
    case "osd.captured":
    case "pod.signed":
    case "delivery.evidenced":
    case "message.received":
    case "message.sent":
    case "call.transcribed":
    case "document.attached":
    case "approval.requested":
    case "approval.decided":
    case "agent.acted":
    case "authority.flipped":
      return empty();

    default: {
      const _never: never = e;
      return _never;
    }
  }
}

const MONEY_LINE_SQL =
  "INSERT INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, currency, party_id, division, gl_map, corrects_event_id, basis, created_ts) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const INVOICE_UPSERT_SQL =
  "INSERT INTO invoices (id, party_id, division, shipment_ids, total_cents, status, issued_event_id, terms, due_ts) VALUES (?,?,?,'[]',?,?,?,?,?) " +
  "ON CONFLICT(id) DO UPDATE SET party_id=excluded.party_id, division=excluded.division, total_cents=excluded.total_cents, status=excluded.status, issued_event_id=excluded.issued_event_id, terms=excluded.terms, due_ts=excluded.due_ts";
const INVOICE_UPDATE_SQL = "UPDATE invoices SET total_cents=?, status=?, issued_event_id=? WHERE id=?";
// REQ-119 / REQ-209 — the VOID write: flip a fully-reversed invoice OUT of 'issued' to {status:'void', total_cents:0}.
// Unconditional (like the reissue UPDATE) so the AR row always lands on the void truth; redelivery is already
// blocked upstream by the ux_ml_corrects UNIQUE on the reversing money_lines (a second void of the same event
// aborts the whole batch), so this UPDATE never re-runs standalone.
const INVOICE_VOID_SQL = "UPDATE invoices SET status=?, total_cents=? WHERE id=?";
// REQ-083 — the settlement write: flip an OPEN invoice to 'paid'. Guarded WHERE status='issued' so a
// re-projected payment (or a second payment) is a harmless no-op, never a re-flip of an already-settled row.
const INVOICE_SETTLE_SQL = "UPDATE invoices SET status=? WHERE id=? AND status='issued'";

/**
 * Prepared statements for the projection — NOT executed. The sequencer batches these with the event
 * INSERT so they share one transaction (I1). invoices has no append-only guard (it is a mutable
 * projection), so the upsert/update are legal; money_lines are append-only (guarded).
 */
export function applyMoneyProjection(
  db: D1Database,
  e: LedgerEvent,
  deps: MoneyProjectionDeps = {},
): D1PreparedStatement[] {
  const { lines, invoices } = projectMoneyLines(e, deps);
  const stmts: D1PreparedStatement[] = [];
  for (const l of lines) {
    stmts.push(
      db
        .prepare(MONEY_LINE_SQL)
        .bind(l.id, l.shipment_id, l.event_id, l.line_no, l.direction, l.kind, l.amount_cents, l.currency, l.party_id, l.division, l.gl_map, l.corrects_event_id, l.basis, l.created_ts),
    );
  }
  for (const inv of invoices) {
    if (inv.mode === "insert") {
      stmts.push(db.prepare(INVOICE_UPSERT_SQL).bind(inv.id, inv.party_id, inv.division, inv.total_cents, inv.status, inv.issued_event_id, inv.terms, inv.due_ts));
    } else if (inv.mode === "update") {
      stmts.push(db.prepare(INVOICE_UPDATE_SQL).bind(inv.total_cents, inv.status, inv.issued_event_id, inv.id));
    } else if (inv.mode === "void") {
      stmts.push(db.prepare(INVOICE_VOID_SQL).bind(inv.status, inv.total_cents, inv.id));
    } else {
      stmts.push(db.prepare(INVOICE_SETTLE_SQL).bind(inv.status, inv.id));
    }
  }
  return stmts;
}

/**
 * A UNIQUE violation on ux_ml_corrects means the targeted event was already corrected. The
 * sequencer maps this DB error to the VALIDATION_FAILED envelope (I7: one correction per event).
 */
export function mapMoneyProjectionError(err: unknown): { code: "VALIDATION_FAILED"; message: string } | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(msg) && /(ux_ml_corrects|corrects_event_id)/i.test(msg)) {
    return { code: "VALIDATION_FAILED", message: "invoice already corrected (I7: one correction per event)" };
  }
  // Defense in depth: Zod normally guards the split boundary (bps non-negative, summing to 10000, gross
  // ≥ 0), but if an off-path caller reaches allocateCents with bad shares its input/postcondition throw
  // must surface as a client 4xx, not an opaque INTERNAL 500.
  if (/\ballocateCents\b/.test(msg)) {
    return { code: "VALIDATION_FAILED", message: "interline split allocation invalid (shares must be non-negative integer bps summing to 10000)" };
  }
  return null;
}
