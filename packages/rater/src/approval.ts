import type { Role } from "@shuddl/contracts";
import { mulDivHalfUp } from "./money.js";
import type { Floors } from "./floors.js";
import type { PricedQuote } from "./price.js";

// REQ-048 / REQ-040 — the approval matrix + the interline executing-share rule. PURE and DETERMINISTIC
// (no LLM/I/O/Date/random): given a figure to compare and a quote's three floors it returns the NAMED
// approval a below-floor price requires (REQ-048: below-floor ⇒ named approval; a LOSS ⇒ DUAL approval).
//
// THE LAW (CLAUDE.md Law 5 / REQ-040, permanent): "Interline floors compare the executing share, never
// gross." A tenant that executes only PART of a move is judged on its own revenue slice — never the full
// gross — which is the guard against the $222,084 / 35-lb anomaly. A later task's regression fixture
// (Task 7) rides on this executing-share rule.
//
// This module is the pure DECISION only: it emits no events, writes no approvals row, touches no ledger —
// that is the /rate service (Task 10).

const BPS_TOTAL = 10_000; // split_bps are basis points of the whole; a valid interline split set totals this.

export type ApprovalKind = "none" | "single" | "dual";

// The two below-floor rules, named for the audit trail. Task 10 maps this straight into approvals.rule —
// a string-literal union (not a bare string) so a typo can never reach the DB.
export type ApprovalRule = "below_target_or" | "below_contribution_loss";

export interface ApprovalDecision {
  approval: ApprovalKind;
  approvals_required: 0 | 1 | 2;
  rule: ApprovalRule | null; // null when none
  required_role: Role | null; // from @shuddl/contracts Role; null when none
  evaluated_sell_cents: number; // the figure actually compared to the floors (executing share if interline, else the quoted sell)
  gross_sell_cents: number; // the whole-move sell before the interline share was applied (list, or the negotiated proposed sell), for audit — never itself compared under interline
  executing_share_bps: number | null; // present (0..10000) when an interline share was applied; null for direct moves
}

// An interline/participation leg. split_bps = this leg's share of the revenue in basis points.
export interface Leg {
  kind: "pickup" | "linehaul" | "interline" | "cartage" | "delivery" | "dray";
  executor: string; // party id that performs this leg
  split_bps: number; // 0..10000
}

// The four matrix fields evaluateApproval decides; the remaining ApprovalDecision fields (the audit trio:
// evaluated / gross / share) are assembled by assessApproval, which knows what it compared.
type MatrixResult = Pick<
  ApprovalDecision,
  "approval" | "approvals_required" | "rule" | "required_role"
>;

/**
 * evaluateApproval — THE MATRIX (REQ-048). Compares one already-chosen figure against the quote's floors:
 *   - x ≥ target                     → none  (0 approvals): at or above the target-OR floor.
 *   - contribution ≤ x < target      → single (1): below target but still covering contribution.
 *   - x < contribution               → dual  (2): the move LOSES money (below contribution) — REQ-048 dual.
 * `full` is informational only; the matrix pivots on contribution and target. The caller decides WHICH
 * figure `x` is — the executing share under interline, else the quoted/proposed sell (never gross under
 * interline; that is the REQ-040 law, enforced in assessApproval).
 *
 * The ops/finance role mapping is FIXED for this WP. The real mapping (which named role clears a
 * below-target vs a below-contribution loss) is ultimately a tenant-policy input — doc 10 `tenants.policy`
 * — read from config once policy lands; it is hard-coded here so the matrix is exercisable end-to-end.
 * Floors are already validated/monotonic by computeFloors; only the compared figure is guarded here.
 */
export function evaluateApproval(evaluatedSellCents: number, floors: Floors): MatrixResult {
  if (!Number.isInteger(evaluatedSellCents) || evaluatedSellCents < 0) {
    throw new Error(
      `evaluateApproval: evaluatedSellCents must be a non-negative integer (got ${evaluatedSellCents})`,
    );
  }

  // At or above the target-OR floor: the price clears — no approval.
  if (evaluatedSellCents >= floors.target) {
    return { approval: "none", approvals_required: 0, rule: null, required_role: null };
  }
  // Below target but ≥ contribution: covers contribution, misses target → single named approval (ops).
  if (evaluatedSellCents >= floors.contribution) {
    return {
      approval: "single",
      approvals_required: 1,
      rule: "below_target_or",
      required_role: "ops",
    };
  }
  // Below contribution: the move LOSES money → DUAL approval (finance) — REQ-048.
  return {
    approval: "dual",
    approvals_required: 2,
    rule: "below_contribution_loss",
    required_role: "finance",
  };
}

/**
 * executingShare — the tenant's revenue share of an interline move AND the bps it was pro-rated from, in
 * ONE result so the compared figure and the audited `executing_share_bps` can never desync (REQ-040 is a
 * permanent invariant — there must be ONE source of truth for the tenant's slice). shareCents = the gross
 * pro-rated by the basis points the tenant executes: mulDivHalfUp(gross, Σ tenant split_bps, 10000), via
 * the shared BigInt-safe half-up primitive so no float touches a monetary value.
 *
 * VALIDATES that ALL legs' split_bps (across every party) total exactly 10000. A split set that isn't 100%
 * is a MALFORMED interline — the revenue shares don't add up, so any share computed from it would be a lie.
 * THROW, never silently misprice — this is the guard that keeps the $222K-class error from slipping through
 * (REQ-040). A tenant that executes no legs ⇒ tenantBps 0 ⇒ shareCents 0.
 */
export function executingShare(
  grossSellCents: number,
  legs: readonly Leg[],
  tenantParty: string,
): { shareCents: number; tenantBps: number } {
  if (!Number.isInteger(grossSellCents) || grossSellCents < 0) {
    throw new Error(
      `executingShare: grossSellCents must be a non-negative integer (got ${grossSellCents})`,
    );
  }

  let total = 0;
  let tenantBps = 0;
  for (const leg of legs) {
    if (!Number.isInteger(leg.split_bps) || leg.split_bps < 0 || leg.split_bps > BPS_TOTAL) {
      throw new Error(
        `executingShare: leg split_bps must be an integer in [0, ${BPS_TOTAL}] ` +
          `(got ${leg.split_bps} for executor ${leg.executor})`,
      );
    }
    total += leg.split_bps;
    if (leg.executor === tenantParty) {
      tenantBps += leg.split_bps;
    }
  }

  // THE anti-$222K guard: the split set must total 100% or the interline is malformed and cannot be priced.
  if (total !== BPS_TOTAL) {
    throw new Error(
      `executingShare: interline split_bps across all legs must total ${BPS_TOTAL} ` +
        `(got ${total}) — a split set that isn't 100% is malformed and cannot be priced`,
    );
  }

  return { shareCents: mulDivHalfUp(grossSellCents, tenantBps, BPS_TOTAL), tenantBps };
}

/**
 * executingShareCents — the tenant's revenue share in cents (REQ-040). A thin wrapper over executingShare
 * so callers that only need the cents (e.g. Task 7's regression fixture) keep a plain number, while the
 * bps the share was derived from stay single-sourced in executingShare.
 */
export function executingShareCents(
  grossSellCents: number,
  legs: readonly Leg[],
  tenantParty: string,
): number {
  return executingShare(grossSellCents, legs, tenantParty).shareCents;
}

/**
 * assessApproval — orchestrates the matrix over the RIGHT figure (REQ-048 / REQ-040):
 *   - quotedSell = proposedSellCents (a rep may negotiate below list) ?? the list sell.
 *   - INTERLINE (a non-empty `legs` set AND `tenantParty`): compare the tenant's EXECUTING SHARE — NEVER
 *     the gross. Both halves are REQUIRED: a partial signal (only one) is a caller bug that, if we fell
 *     through to DIRECT, would compare the full GROSS against the floors — the one thing REQ-040 forbids —
 *     so we FAIL LOUD, naming the missing half, rather than silently misprice.
 *   - DIRECT (neither given): the tenant executes the whole move; compare the quoted/proposed sell itself.
 * Returns the full ApprovalDecision with the audit trio: what was compared (evaluated_sell_cents), the
 * whole-move sell for the record (gross_sell_cents), and the applied share in bps (executing_share_bps;
 * null for direct). Pure — no events, no DB, no ledger (Task 10 owns that).
 */
export function assessApproval(
  quote: PricedQuote,
  opts?: {
    proposedSellCents?: number;
    legs?: readonly Leg[];
    tenantParty?: string;
  },
): ApprovalDecision {
  // A rep may propose a negotiated price below the list sell; absent ⇒ the list sell.
  const quotedSell = opts?.proposedSellCents ?? quote.sell_cents;
  const legs = opts?.legs;
  const tenantParty = opts?.tenantParty;

  // An interline assessment is signalled by a NON-EMPTY legs set OR a tenantParty; BOTH are required. A
  // partial signal must NEVER fall through to DIRECT (which compares the gross) — fail loud, naming the
  // missing half (REQ-040). A truly direct move passes neither.
  const legsProvided = legs !== undefined && legs.length > 0;
  const tenantProvided = tenantParty !== undefined;
  if (legsProvided !== tenantProvided) {
    throw new Error(
      legsProvided
        ? "assessApproval: interline legs were provided without a tenantParty — refusing to fall through to comparing the gross (REQ-040)"
        : "assessApproval: a tenantParty was provided without a non-empty legs set — refusing to fall through to comparing the gross (REQ-040)",
    );
  }

  let evaluated: number;
  let executing_share_bps: number | null;
  if (legs !== undefined && legs.length > 0 && tenantParty !== undefined) {
    // INTERLINE: judge the tenant on its EXECUTING SHARE, never the gross (REQ-040 / CLAUDE.md Law 5). The
    // compared share and the audited bps come from the ONE executingShare call — they cannot diverge.
    const share = executingShare(quotedSell, legs, tenantParty); // validates the split totals 10000
    evaluated = share.shareCents;
    executing_share_bps = share.tenantBps;
  } else {
    // DIRECT move: the tenant executes the whole thing; compare the quoted/proposed sell itself.
    evaluated = quotedSell;
    executing_share_bps = null;
  }

  const decision = evaluateApproval(evaluated, quote.floors);

  return {
    ...decision,
    evaluated_sell_cents: evaluated,
    gross_sell_cents: quotedSell,
    executing_share_bps,
  };
}
