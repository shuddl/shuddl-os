import { describe, expect, it } from "vitest";
import { agedOpenArList, daysPastDue, rollupAging, type AgeableInvoice } from "./aging.js";

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
