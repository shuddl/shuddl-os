// REQ-012 / REQ-057 / I1 / I7 — money is a PROJECTION of physics. `projectMoneyLines` is a pure
// function: (event, deps) -> the money_lines + invoices rows that event implies. It never touches
// the DB (the caller loads deps and executes). `applyMoneyProjection` turns those rows into PREPARED
// statements so the Task-13 sequencer can put them in the SAME db.batch() as the event INSERT — the
// event and its lines commit together or not at all (I1 both directions). INTEGER CENTS ONLY.
import type { LedgerEvent } from "@shuddl/contracts";
import { allocateCents } from "../money/split.js";

// GL accounts for the non-invoice money kinds (invoice lines carry their own gl_map on the payload).
const INTERLINE_GL = "5000-INTERLINE-AP";
const COD_GL = "1300-COD-CLEARING";
const SETTLE_GL = "5100-SETTLEMENT-FEE";

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

// The invoices projection row (REQ-057: division filterable everywhere). `insert` upserts on issue;
// `update` re-totals an existing invoice on a reissue (a void emits none).
export type InvoiceUpsert =
  | { mode: "insert"; id: string; party_id: string; division: string; total_cents: number; status: string; issued_event_id: string }
  | { mode: "update"; id: string; total_cents: number; status: string; issued_event_id: string };

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
      return {
        lines,
        invoices: [
          { mode: "insert", id: p.invoice_id, party_id: p.party_id, division: p.division, total_cents: total, status: "issued", issued_event_id: e.id },
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
          ? [] // a void reissues nothing (plan: "or none on void")
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
      // Zero money EXCEPT a COD collection, which posts a negative AR (cash collected at the door).
      if (asString(e.payload["method"]) !== "cod") return empty();
      const amount = asInt(e.payload["amount_cents"]);
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
        invoices: [],
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
  "INSERT INTO invoices (id, party_id, division, shipment_ids, total_cents, status, issued_event_id) VALUES (?,?,?,'[]',?,?,?) " +
  "ON CONFLICT(id) DO UPDATE SET party_id=excluded.party_id, division=excluded.division, total_cents=excluded.total_cents, status=excluded.status, issued_event_id=excluded.issued_event_id";
const INVOICE_UPDATE_SQL = "UPDATE invoices SET total_cents=?, status=?, issued_event_id=? WHERE id=?";

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
      stmts.push(db.prepare(INVOICE_UPSERT_SQL).bind(inv.id, inv.party_id, inv.division, inv.total_cents, inv.status, inv.issued_event_id));
    } else {
      stmts.push(db.prepare(INVOICE_UPDATE_SQL).bind(inv.total_cents, inv.status, inv.issued_event_id, inv.id));
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
  return null;
}
