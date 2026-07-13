import { InvoiceIssuedPayload } from "@shuddl/contracts";
import type { QuotePricedPayload, JsonValue } from "@shuddl/contracts";
import { evaluateApproval, executingShare } from "@shuddl/rater";
import type { Leg } from "@shuddl/rater";
import { glMap } from "./gl-map.js";

// REQ-031/040/048/056 — the Biller's PURE, DETERMINISTIC, LLM-FREE composition core. Given a committed
// pod.signed + the RECORDED accepted quote.priced + bill terms, it returns the invoice.issued PAYLOAD
// whose lines are a verbatim projection of the quote's itemized lines (penny-parity: Σ === sell), or a
// HOLD when the recorded quote is anomalous (REQ-040, hard — the $222,084/35-lb case NEVER
// auto-invoices) or an interline EXECUTING SHARE sits below floor without an approval of MATCHING
// strength (REQ-048: single releases single; only dual releases dual).
//
// Money is a PROJECTION of recorded physics (REQ-003): every figure here is READ from the recorded
// event payload, never re-computed — the anomaly flag is the pricing-time `basis.anomaly`, the lines
// are the quote's own breakdown, the floors ride the quote. PURE: no Date, no Math.random, no I/O,
// no @shuddl/ledger, no LLM (REQ-024). The queue consumer that appends the event and sends the
// evidence email is a LATER task.

export interface ComposeInput {
  /** The committed POD that triggered billing — named in every hold detail so the review queue can find the shipment. */
  pod: { event_id: string; shipment_id: string };
  /** The RECORDED, accepted quote.priced payload — the penny-parity projection source (REQ-003/031). */
  acceptedQuote: QuotePricedPayload;
  /** Bill-to terms (REQ-056): prepaid/collect bill party_id; third_party bills third_party_id. */
  bill: { party_id: string; terms: "prepaid" | "collect" | "third_party"; third_party_id?: string; division?: string };
  /** Caller-supplied deterministic id — composeInvoice never mints ids (no Date/random inside). */
  invoiceId: string;
  /** Present ⇒ interline ⇒ the EXECUTING SHARE (never gross) is judged against the floors (REQ-040). */
  legs?: readonly Leg[];
  /** The tenant party whose executing share is judged. Required WITH a non-empty legs set, forbidden without — a partial signal throws (REQ-040). */
  tenantParty?: string;
  /**
   * The STRENGTH of the named below-floor approval granted (approval.decided), matching the REQ-048
   * matrix: "single" releases a single-approval hold (below target, above contribution); "dual"
   * releases both; a "single" grant can NEVER release a dual-required hold (below contribution — a
   * LOSS needs finance dual approval). Never releases an anomaly hold.
   */
  approvalGranted?: "single" | "dual";
}

export type ComposeResult =
  | { status: "issue"; payload: InvoiceIssuedPayload }
  | { status: "hold"; reason: "anomaly" | "below_floor"; detail: string };

// The approval-strength ladder (REQ-048): how many named approvals each grant carries. Compared against
// evaluateApproval's approvals_required so a single ops grant can never release a dual finance hold.
const GRANT_STRENGTH: Record<"single" | "dual", 1 | 2> = { single: 1, dual: 2 };

// Render the recorded basis.anomaly (an AnomalyFlag-shaped JsonValue) into a human-readable hold detail.
function anomalyDetail(anomaly: JsonValue): string {
  if (typeof anomaly === "object" && anomaly !== null && !Array.isArray(anomaly)) {
    const code = typeof anomaly["code"] === "string" ? anomaly["code"] : "unknown";
    const detail = anomaly["detail"];
    return typeof detail === "string"
      ? `recorded pricing-time anomaly (${code}): ${detail}`
      : `recorded pricing-time anomaly (${code})`;
  }
  return `recorded pricing-time anomaly: ${JSON.stringify(anomaly)}`;
}

/**
 * composeInvoice — POD + recorded quote + bill terms → invoice.issued payload, or a HOLD.
 *
 *  0. CALLER-CONTRACT guards throw (never hold): empty pod refs; a PARTIAL interline signal (legs
 *     without tenantParty OR tenantParty without a non-empty legs set — mirrors the rater's
 *     assessApproval: a partial signal must NEVER fall through, REQ-040); an unresolvable bill target
 *     (third_party without third_party_id, or a blank party_id) — never silently bill the wrong party.
 *  1. ANOMALY ⇒ HOLD, hard, no override (REQ-040 permanent). The recorded pricing-time flag at
 *     `basis.anomaly` is authoritative — read, never recomputed (no weight exists here). FAIL-CLOSED:
 *     only ABSENT or literal null means "sane"; any other recorded value (an object, false, "", 0)
 *     holds. Checked before any payload is built; `approvalGranted` does NOT release it.
 *  2. INTERLINE BELOW-FLOOR ⇒ HOLD unless an approval of MATCHING STRENGTH was granted (REQ-048).
 *     The tenant's EXECUTING SHARE (rater executingShare — the one source of truth for the slice) is
 *     judged against the quote's floors via the rater approval matrix; the share, NEVER the gross
 *     (REQ-040 / CLAUDE.md Law 5). Release only when the grant covers approvals_required: "single"
 *     covers 1 (below target); only "dual" covers 2 (below contribution — a loss).
 *  3. Otherwise ⇒ ISSUE: each recorded quote line projects verbatim into an InvoiceLine (line_no 1..n,
 *     same kind, same amount_cents, gl_map from the frozen map); party_id per terms; division defaults
 *     "main". The payload is validated through InvoiceIssuedPayload.parse (fail loud) and the OUTPUT
 *     is asserted to sum to the recorded sell — a mapping bug fails here, never misprices.
 */
export function composeInvoice(input: ComposeInput): ComposeResult {
  const { pod, acceptedQuote, bill, invoiceId, legs, tenantParty, approvalGranted } = input;

  // 0a. The POD refs name the shipment in every hold/queue surface — blank refs would make a hold
  //     unactionable, so they are a caller error.
  if (pod.event_id.length === 0 || pod.shipment_id.length === 0) {
    throw new Error(
      "composeInvoice: pod.event_id and pod.shipment_id must be non-empty — a hold must name the shipment and POD it blocks",
    );
  }

  // 0b. Partial interline signal ⇒ THROW, both directions (mirrors rater assessApproval, REQ-040):
  //     legs without a tenantParty can't be judged; a tenantParty without a non-empty legs set implies
  //     the caller MEANT interline — silently issuing as direct would skip the share check entirely.
  const legsProvided = legs !== undefined && legs.length > 0;
  const tenantProvided = tenantParty !== undefined;
  if (legsProvided !== tenantProvided) {
    throw new Error(
      legsProvided
        ? "composeInvoice: interline legs were provided without a tenantParty — refusing to silently skip the executing-share floor check (REQ-040)"
        : "composeInvoice: a tenantParty was provided without a non-empty legs set — a partial interline signal must never fall through to an unjudged issue (REQ-040)",
    );
  }

  // 0c. Resolve the bill-to party from the terms (REQ-056); an unresolvable or BLANK target throws —
  //     never silently bill the wrong (or no) party. Symmetric: both branches reject empty strings.
  let party_id: string;
  if (bill.terms === "third_party") {
    if (bill.third_party_id === undefined || bill.third_party_id === "") {
      throw new Error(
        "composeInvoice: terms are third_party but bill.third_party_id is missing or blank — never silently bill the wrong party (REQ-056)",
      );
    }
    party_id = bill.third_party_id;
  } else {
    if (bill.party_id === "") {
      throw new Error(
        `composeInvoice: terms are ${bill.terms} but bill.party_id is blank — never silently bill the wrong party (REQ-056)`,
      );
    }
    party_id = bill.party_id;
  }

  // 1. Anomaly ⇒ HOLD (hard). The recorded flag rides the accepted quote at basis.anomaly (REQ-003:
  //    the projection reads the record). FAIL-CLOSED: only absent or literal null is "no flag" — any
  //    other value (a flag object, or a malformed false/""/0) holds; a truthiness check would silently
  //    auto-invoice a malformed record.
  const anomaly = acceptedQuote.basis["anomaly"];
  if (anomaly !== undefined && anomaly !== null) {
    return {
      status: "hold",
      reason: "anomaly",
      detail: `shipment ${pod.shipment_id} (pod ${pod.event_id}): ${anomalyDetail(anomaly)}`,
    };
  }

  // 2. Interline ⇒ judge the EXECUTING SHARE against the floors, never gross (REQ-040). Release a
  //    below-floor hold only when the granted approval strength covers what the matrix requires.
  if (legsProvided && tenantParty !== undefined) {
    // executingShare validates the split totals 10000 bps; evaluateApproval is the REQ-048 matrix.
    const share = executingShare(acceptedQuote.sell, legs, tenantParty);
    const decision = evaluateApproval(share.shareCents, acceptedQuote.floors);
    const grantedStrength = approvalGranted === undefined ? 0 : GRANT_STRENGTH[approvalGranted];
    if (decision.approvals_required > grantedStrength) {
      return {
        status: "hold",
        reason: "below_floor",
        detail:
          `shipment ${pod.shipment_id} (pod ${pod.event_id}): executing share ${share.shareCents}¢ ` +
          `(${share.tenantBps} bps of ${acceptedQuote.sell}¢ gross) is below floor (rule ${decision.rule}, ` +
          `requires ${decision.approval} approval — ${decision.approvals_required} required, ` +
          `${grantedStrength} granted) (REQ-040/048)`,
      };
    }
  }

  // 3. Issue: project the recorded lines verbatim (REQ-031).
  const payload = InvoiceIssuedPayload.parse({
    invoice_id: invoiceId,
    party_id,
    division: bill.division ?? "main",
    lines: acceptedQuote.lines.map((line, i) => ({
      line_no: i + 1,
      kind: line.kind,
      amount_cents: line.amount_cents,
      gl_map: glMap(line.kind),
    })),
  });

  // Penny-parity postcondition on the OUTPUT (REQ-031): the Task-1 refine guarantees the recorded
  // lines sum to sell, but a mapping bug here must fail loud, never misprice. Integer addition.
  const total = payload.lines.reduce((sum, l) => sum + l.amount_cents, 0);
  if (total !== acceptedQuote.sell) {
    throw new Error(
      `composeInvoice: penny-parity violated — invoice lines total ${total}¢ but the recorded quote sell is ${acceptedQuote.sell}¢`,
    );
  }

  return { status: "issue", payload };
}
