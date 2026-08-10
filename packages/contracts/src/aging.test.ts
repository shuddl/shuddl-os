import { describe, expect, it } from "vitest";
import { AGING_BUCKETS, agedOpenArList, agingBucketFor, daysPastDue, rollupAging, type AgeableInvoice } from "./aging.js";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

describe("aging math (REQ-082/083/090)", () => {
  const invoices: AgeableInvoice[] = [
    { total_cents: 100_000, status: "issued", due_ts: NOW - 10 * DAY }, // 10d overdue → 1–30D
    { total_cents: 50_000, status: "issued", due_ts: NOW + 5 * DAY }, // not due → CURRENT
    { total_cents: 30_000, status: "issued", due_ts: NOW - 45 * DAY }, // 45d → 31–60D
    { total_cents: 20_000, status: "issued", due_ts: NOW - 90 * DAY }, // 90d → >60D
    { total_cents: 70_000, status: "issued", due_ts: null }, // no terms
    { total_cents: 999_999, status: "paid", due_ts: NOW - 100 * DAY }, // settled — never ages/owes
  ];

  it("rolls open invoices into every bucket (in display order) + open/paid/no-terms totals", () => {
    const r = rollupAging(invoices, NOW);
    expect(r.buckets.map((b) => [b.slug, b.cents])).toEqual([
      ["current", 50_000],
      ["1-30", 100_000],
      ["31-60", 30_000],
      ["over-60", 20_000],
    ]);
    expect(r.noTermsCents).toBe(70_000);
    // open balance excludes the paid invoice and INCLUDES the no-terms one
    expect(r.openCents).toBe(270_000);
    expect(r.paidCents).toBe(999_999);
  });

  it("a NULL due_ts is honest no-terms, never fabricated overdue", () => {
    const r = rollupAging([{ total_cents: 12_345, status: "issued", due_ts: null }], NOW);
    expect(r.noTermsCents).toBe(12_345);
    expect(r.buckets.every((b) => b.cents === 0)).toBe(true); // nothing invented into an aging bucket
  });

  it("agedOpenArList keeps the compact queue shape (non-empty buckets in order, then NO TERMS)", () => {
    expect(agedOpenArList(invoices, NOW)).toEqual([
      { label: "CURRENT", cents: 50_000 },
      { label: "1–30D", cents: 100_000 },
      { label: "31–60D", cents: 30_000 },
      { label: ">60D", cents: 20_000 },
      { label: "NO TERMS", cents: 70_000 },
    ]);
    expect(agedOpenArList([], NOW)).toEqual([]);
  });

  it("daysPastDue floors against the clock (positive ⇒ overdue)", () => {
    expect(daysPastDue(NOW - 10 * DAY, NOW)).toBe(10);
    expect(daysPastDue(NOW + 5 * DAY, NOW)).toBe(-5);
  });
});

// §922 — THE BUCKETS MUST PARTITION THE LINE, AND ONLY A COMMENT SAID SO.
//
// `agingBucketFor` calls its trailing `return ">60D"` unreachable, and that is true only while the four
// predicates cover every finite integer with no overlap. Breaking the top bucket (`d > 60` → `d > 999_999`)
// left the whole contracts suite GREEN: a 90-days-past-due invoice then silently took the FALLBACK — which
// returns the same label the broken bucket would have, so the defect is invisible by construction, and the
// day someone changes the fallback it becomes a mislabel instead.
//
// This is the shared AR classifier for two surfaces — the command MONEY queue and the portal counterparty
// STATEMENT — so a mislabelled bucket is a number a customer reads about their own account.
//
// The fix is a property, not more examples: EXACTLY ONE predicate must match every value in a range that
// crosses all four boundaries. That makes the partition provable rather than asserted, and it fails on an
// overlap as loudly as on a gap — the direction examples never reach.
describe("§922: the aging buckets PARTITION the number line (exactly one match per value)", () => {
  it("every dpd from -400 to 400 matches exactly one bucket predicate", () => {
    const multi: string[] = [];
    for (let d = -400; d <= 400; d++) {
      const hits = AGING_BUCKETS.filter((b) => b.test(d)).map((b) => b.label);
      if (hits.length !== 1) multi.push(`dpd=${d} matched ${hits.length}: [${hits.join(", ")}]`);
    }
    expect(multi, "the aging buckets no longer partition the line — a gap sends a value to agingBucketFor's " +
      "'unreachable' fallback, and an overlap makes the label depend on array order. Both mislabel money a " +
      "customer reads on their own statement:\n  " + multi.slice(0, 8).join("\n  ")).toEqual([]);
  });

  it("the boundaries land where the labels claim (0/1, 30/31, 60/61)", () => {
    expect(agingBucketFor(0)).toBe("CURRENT");
    expect(agingBucketFor(1)).toBe("1–30D");
    expect(agingBucketFor(30)).toBe("1–30D");
    expect(agingBucketFor(31)).toBe("31–60D");
    expect(agingBucketFor(60)).toBe("31–60D");
    expect(agingBucketFor(61)).toBe(">60D");
  });
});
