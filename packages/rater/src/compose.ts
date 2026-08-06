import type { InvoiceLine } from "@shuddl/contracts";
import type { FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import { mulDivHalfUp } from "./money.js";

// REQ-027 — the price COMPOSER. PURE and DETERMINISTIC (no LLM, no I/O, no Date/random): given the
// freight charge (from priceFreight), the accessorial codes the customer asked for, and the tenant's
// parsed fsc + accessorial schedule, it lays down an ordered list of INTEGER-cent price lines and their
// sum (`sell`). It composes ON TOP of freight; it does NOT re-rate freight, and it does NOT apply floors
// or approval gates (WP-04 Tasks 5/6). This emits the lightweight PriceLine breakdown only — the heavier
// DB `money_lines` row (event_id / gl_map) is assembled later at the /rate service, never here.

// The line vocabulary MIRRORS contracts' MoneyLine/InvoiceLine `kind` enum (freight | fsc | accessorial)
// so the breakdown speaks the same language the money projection will later persist.
export type PriceLineKind = "freight" | "fsc" | "accessorial";

// COMPILE-TIME PROOF of that mirroring (audit §391). `l.kind` is copied VERBATIM from a PriceLine into an
// event payload's lines in five call sites (`routes/rate.ts`, `concierge/compose.ts`, `biller/compose.ts`,
// `translator/inbound.ts`, `projection/money.ts`), and until this line nothing checked the two vocabularies
// against each other: widening `PriceLineKind` with a kind `InvoiceLine` does not accept typechecked CLEAN
// across all 17 workspaces, and the divergence surfaced only when a real `quote.priced` failed schema parse
// — at runtime, in production, on a money event.
//
// The relation is SUBSET, not equality: `cod_collect` and `credit_purchase` are money-line kinds the rater
// never emits. `extends` is exactly that assertion, so this stays correct as the money vocabulary grows and
// fails the moment the rater's grows past it.
type _PriceLineKindIsAMoneyLineKind = PriceLineKind extends InvoiceLine["kind"] ? true : never;
const _priceLineKindSubsetProof: _PriceLineKindIsAMoneyLineKind = true;
void _priceLineKindSubsetProof;

// readonly throughout: a breakdown feeds a co-signed event downstream (Task 5 floors, Task 10 /rate) and
// must not be mutated after compose returns it.
export interface PriceLine {
  readonly kind: PriceLineKind;
  readonly code: string; // "freight" | "fsc" | the accessorial code, e.g. "liftgate"
  readonly amount_cents: number; // integer cents, always > 0 for an emitted line
}

export interface Composed {
  readonly lines: readonly PriceLine[]; // deterministic order: freight, fsc, then accessorials sorted by code asc
  readonly sell_cents: number; // Σ lines.amount_cents (integer)
}

const BPS_DIVISOR = 10_000; // fsc pct is in basis points; amount = freight × pct_bps / 10000

/**
 * compose freight + fsc + accessorials into ordered price lines + a sell.
 *
 * Rules (see the task spec, REQ-027):
 *  - freight line first, then fsc, then accessorials sorted by `code` ascending — a stable, deterministic
 *    order so the same inputs always yield byte-identical output (this feeds a co-signed event later).
 *  - OMIT any line whose amount is 0 (a 0-cent line is noise): honours the PriceLine invariant
 *    "amount_cents always > 0 for an emitted line". In practice freight is always > 0 (priceFreight only
 *    PRICEs a positive-weight shipment and floors at min_charge), and fsc > 0 whenever pct_bps > 0.
 *  - fsc amount is formed with mulDivHalfUp so `freight × pct_bps` cannot overflow 2^53 (Task-3 guard).
 *  - NO SILENT DROPS (Migrator law): a requested accessorial code that is not in the tenant schedule is
 *    an ERROR naming the code — never dropped. A code that IS in the schedule but priced at 0 is a known
 *    zero, not an unknown, so it is simply omitted (its lookup succeeded).
 *  - DEDUPE: a code requested more than once bills ONCE (the schedule price is a per-shipment charge, not
 *    a per-request multiplier); duplicates collapse to a single line.
 */
export function compose(
  freightCents: number,
  requestedAccessorials: readonly string[],
  fsc: FscConfig,
  accessorials: AccessorialSchedule,
): Composed {
  // Guard freightCents directly so the invariant is self-standing (not merely incidental to mulDivHalfUp,
  // which could later be skipped when pct_bps === 0). Freight is INTEGER cents, finite, non-negative.
  if (!Number.isInteger(freightCents) || freightCents < 0) {
    throw new Error(`compose: freightCents must be a non-negative integer (got ${freightCents})`);
  }

  // build into a mutable local, return it typed readonly (the breakdown is immutable to its consumers).
  const lines: PriceLine[] = [];

  // 1. freight (omit a 0 line — see the omit-zero rule; freight is > 0 for any real PRICED shipment).
  if (freightCents > 0) {
    lines.push({ kind: "freight", code: "freight", amount_cents: freightCents });
  }

  // 2. fsc = round_half_up(freight × pct_bps / 10000), product formed in BigInt (mulDivHalfUp). Omit if 0.
  //    (mulDivHalfUp also validates freightCents/pct_bps as non-negative integers — fails loudly, never misprices.)
  const fscCents = mulDivHalfUp(freightCents, fsc.pct_bps, BPS_DIVISOR);
  if (fscCents > 0) {
    lines.push({ kind: "fsc", code: "fsc", amount_cents: fscCents });
  }

  // 3. accessorials: dedupe, look each up (unknown ⇒ throw naming it), omit zero-priced, sort by code asc.
  const accessorialLines: PriceLine[] = [];
  const seen = new Set<string>();
  for (const code of requestedAccessorials) {
    if (seen.has(code)) continue; // dedupe: a code requested twice bills once
    seen.add(code);
    // Object.hasOwn (not a bare index read) so inherited keys like "constructor"/"toString" resolve to
    // "unknown code", never to a Function on Object.prototype. noUncheckedIndexedAccess already infers
    // Cents | undefined for the index read.
    const amount = Object.hasOwn(accessorials.items, code) ? accessorials.items[code] : undefined;
    if (amount === undefined) {
      throw new Error(
        `compose: requested accessorial "${code}" is not in the tenant accessorial schedule (${accessorials.id}) — no silent drop (Migrator law)`,
      );
    }
    if (amount > 0) {
      accessorialLines.push({ kind: "accessorial", code, amount_cents: amount });
    }
  }
  accessorialLines.sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
  lines.push(...accessorialLines);

  // 4. sell = Σ line amounts. No 2^53 concern here (unlike the fsc PRODUCT, which is BigInt-guarded): each
  //    amount is ≤ ~1e12 cents and the line count is tiny (freight + fsc + a handful of accessorials), so
  //    the sum stays far inside the safe-integer range. The asymmetry (BigInt for the product, plain
  //    number for the sum) is intentional — only the multiply can overflow.
  const sell_cents = lines.reduce((sum, line) => sum + line.amount_cents, 0);

  return { lines, sell_cents };
}
