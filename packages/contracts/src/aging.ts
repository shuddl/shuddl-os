// REQ-082/083/090 — the SHARED AR-aging math. ONE definition of the aging buckets + the days-past-due
// assignment, consumed by BOTH the command MONEY queue (v_queue_money, apps/command/.../MoneyQueue.tsx)
// and the portal STATEMENT surface (apps/portal/.../StatementView.tsx). It lives on the shared money
// boundary so the two surfaces cannot DRIFT: a change to a bucket edge (e.g. the 1–30D window) updates
// both at once — the share-the-matcher discipline (share-lint-matchers-with-parity-tests).
//
// Integer cents ONLY — no float ever touches the money (the canonical integer-cents law, doc 10). A NULL
// due_ts is honest "no terms": it lands in its own pool, NEVER invented as overdue. Only OPEN invoices
// (status='issued') age; a settled ('paid') invoice is never bucketed and never counts toward the balance.

/** One day in epoch milliseconds. */
export const AGING_DAY_MS = 86_400_000;

/** The AR-aging bucket display labels, in order (current → most overdue). */
export type AgingBucketLabel = "CURRENT" | "1–30D" | "31–60D" | ">60D";
/** A stable, ASCII slug per bucket (for DOM ids / keys — free of the label's en-dash / `>`). */
export type AgingBucketSlug = "current" | "1-30" | "31-60" | "over-60";

interface BucketDef {
  label: AgingBucketLabel;
  slug: AgingBucketSlug;
  test: (daysPastDue: number) => boolean;
}

// The buckets partition the number line: CURRENT (not yet due) → >60D (deeply overdue). Exactly one matches
// any finite days-past-due value.
const AGING_BUCKETS: readonly BucketDef[] = [
  { label: "CURRENT", slug: "current", test: (d) => d <= 0 },
  { label: "1–30D", slug: "1-30", test: (d) => d >= 1 && d <= 30 },
  { label: "31–60D", slug: "31-60", test: (d) => d >= 31 && d <= 60 },
  { label: ">60D", slug: "over-60", test: (d) => d > 60 },
];

/** The minimal invoice shape aging needs: an integer-cents amount, a read-model status ('issued' | 'paid'),
 * and a due timestamp (epoch ms) that MAY be null (no terms — never invented as overdue). */
export interface AgeableInvoice {
  total_cents: number;
  status: string;
  due_ts: number | null;
}

/** One aging bucket's summed amount (integer cents), carrying its display label + ASCII slug. */
export interface AgedBucket {
  label: AgingBucketLabel;
  slug: AgingBucketSlug;
  cents: number;
}

/** A compact aging line — a non-empty bucket OR the "NO TERMS" pool (the command queue's shape). */
export interface AgedLine {
  label: string;
  cents: number;
}

/** The complete aging rollup a statement renders: every bucket in display order (including empty ones),
 * the no-terms pool, and the open/paid balances. All integer cents. */
export interface AgingRollup {
  buckets: AgedBucket[];
  /** Open invoices with a NULL due_ts — honest "no terms", never fabricated as overdue. */
  noTermsCents: number;
  /** Total OPEN AR (status='issued') — the balance owed. */
  openCents: number;
  /** Total SETTLED AR (status='paid'). */
  paidCents: number;
}

/** Days-past-due for a due timestamp against a clock (both epoch ms). Positive ⇒ overdue; ≤0 ⇒ current. */
export function daysPastDue(dueTs: number, now: number): number {
  return Math.floor((now - dueTs) / AGING_DAY_MS);
}

/** The bucket label a days-past-due value lands in. The buckets partition the line, so this always
 * resolves; the trailing return is unreachable and only satisfies exhaustiveness. */
export function agingBucketFor(dpd: number): AgingBucketLabel {
  for (const b of AGING_BUCKETS) if (b.test(dpd)) return b.label;
  return ">60D";
}

/** Roll invoices into every aging bucket (in display order) + the open/paid/no-terms totals (integer
 * cents). Only OPEN invoices (status='issued') age; a 'paid' invoice is settled AR and never bucketed;
 * an unknown status is counted as neither (fail-closed). A NULL due_ts lands in the no-terms pool. */
export function rollupAging(invoices: AgeableInvoice[], now: number): AgingRollup {
  const totals = new Map<AgingBucketLabel, number>();
  let noTermsCents = 0;
  let openCents = 0;
  let paidCents = 0;
  for (const inv of invoices) {
    if (inv.status === "paid") {
      paidCents += inv.total_cents;
      continue;
    }
    if (inv.status !== "issued") continue; // unknown status — not open AR, not settled (fail-closed)
    openCents += inv.total_cents;
    if (inv.due_ts === null) {
      noTermsCents += inv.total_cents;
      continue;
    }
    const label = agingBucketFor(daysPastDue(inv.due_ts, now));
    totals.set(label, (totals.get(label) ?? 0) + inv.total_cents);
  }
  const buckets: AgedBucket[] = AGING_BUCKETS.map((b) => ({ label: b.label, slug: b.slug, cents: totals.get(b.label) ?? 0 }));
  return { buckets, noTermsCents, openCents, paidCents };
}

/** The compact aging list the command MONEY queue renders: non-empty buckets in display order, then the
 * no-terms pool if present. (Mirrors the original ageOpenAr shape so the queue's tests stay green.) */
export function agedOpenArList(invoices: AgeableInvoice[], now: number): AgedLine[] {
  const roll = rollupAging(invoices, now);
  const out: AgedLine[] = roll.buckets.filter((b) => b.cents !== 0).map((b) => ({ label: b.label, cents: b.cents }));
  if (roll.noTermsCents !== 0) out.push({ label: "NO TERMS", cents: roll.noTermsCents });
  return out;
}
