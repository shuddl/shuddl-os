import { describe, expect, it } from "vitest";
import { CSS_VAR_LITERALS, TOKENS } from "@shuddl/design";
import { AGING_BUCKETS, agingBucketFor, daysPastDue, AGING_DAY_MS } from "@shuddl/contracts";
import {
  agingBucket,
  overdueDays,
  dunningDraftId,
  dunningBodyRef,
  renderDunningDraft,
  REMINDER_MAX_DAYS,
  FIRM_MAX_DAYS,
} from "../src/index.js";
import type { DunningBucket, DunningDraftData } from "../src/index.js";

// ====================================================================================================
// WP-11 Task 6 — THE COLLECTOR (REQ-032): aging watch + tone-matched dunning DRAFTS (no auto-send).
//
// The core is PURE + DETERMINISTIC + LLM-FREE: an open invoice's whole-days-overdue → an escalation BUCKET
// (reminder ≤30 / firm 31-60 / final >60 past due) → a FIXED, tone-matched template (NEVER model output).
// The tone is a FIXED template keyed by bucket (deterministic + auditable), mirroring the Concierge quote
// reply's config-seeded tenant voice (tenant from-name + a fixed body). Integer cents; CR/LF rejected on the
// invoice ref (it is interpolated into a mail header); same input → identical bytes.
// ====================================================================================================

const DAY_MS = 86_400_000;
const DUE = Date.parse("2026-06-01T00:00:00Z");

const BASE: DunningDraftData = {
  invoice_ref: "INV-40206",
  amount_cents: 148_000,
  days_overdue: 12,
  bucket: "reminder",
  tenant_from_name: "Example Freight Desk", // a config-seeded voice — a placeholder, no identity (REQ-167)
};

// ── design-law scanners (mirror the evidence-email / quote-reply test: allowlist, not a hex-only sweep) ──
const BLESSED_HEX = new Set<string>(Object.values(TOKENS).map((h) => h.toUpperCase()));
const normalizeCommas = (v: string): string => v.replace(/,\s+/g, ",");
const SANCTIONED_TRANSPARENTS = new Set<string>(
  Object.values(CSS_VAR_LITERALS)
    .filter((v) => v.startsWith("rgba"))
    .map((v) => normalizeCommas(v).toLowerCase()),
);
function extractHexes(html: string): string[] {
  const out: string[] = [];
  const dbl = (c: string): string => c + c;
  for (const m of html.matchAll(/#([0-9A-Fa-f]{3,8})\b/g)) {
    const s = (m[1] as string).toUpperCase();
    if (s.length === 3 || s.length === 4) out.push(`#${dbl(s[0] as string)}${dbl(s[1] as string)}${dbl(s[2] as string)}`);
    else if (s.length === 8) out.push(`#${s.slice(0, 6)}`);
    else out.push(`#${s}`);
  }
  return out;
}

describe("REQ-032 Collector — aging buckets (pure, clock-free decision)", () => {
  it("maps whole-days-overdue to the escalation bucket at the documented boundaries", () => {
    expect(agingBucket(0)).toBe<DunningBucket>("reminder"); // just crossed due
    expect(agingBucket(1)).toBe<DunningBucket>("reminder");
    expect(agingBucket(REMINDER_MAX_DAYS)).toBe<DunningBucket>("reminder"); // ≤30
    expect(agingBucket(REMINDER_MAX_DAYS + 1)).toBe<DunningBucket>("firm"); // 31
    expect(agingBucket(FIRM_MAX_DAYS)).toBe<DunningBucket>("firm"); // 60
    expect(agingBucket(FIRM_MAX_DAYS + 1)).toBe<DunningBucket>("final"); // 61
    expect(agingBucket(365)).toBe<DunningBucket>("final");
  });

  it("overdueDays is the injected-clock delta in WHOLE days, floored, never negative", () => {
    expect(overdueDays(DUE, DUE)).toBe(0); // exactly due — 0 days overdue
    expect(overdueDays(DUE + DAY_MS - 1, DUE)).toBe(0); // <1 day past → floors to 0
    expect(overdueDays(DUE + DAY_MS, DUE)).toBe(1);
    expect(overdueDays(DUE + 45 * DAY_MS, DUE)).toBe(45);
    expect(overdueDays(DUE - 10 * DAY_MS, DUE)).toBe(0); // not yet due → clamped to 0 (never negative)
  });
});

describe("REQ-032 Collector — deterministic draft id + body_ref (idempotency keys)", () => {
  it("the draft id is deterministic per (invoice, bucket) — a re-derive is byte-identical", () => {
    expect(dunningDraftId("INV-1", "reminder")).toBe("msg:dunning:INV-1:reminder");
    expect(dunningDraftId("INV-1", "reminder")).toBe(dunningDraftId("INV-1", "reminder"));
  });
  it("the id ESCALATES with the bucket (a firmer tone is a NEW draft, not a clobber)", () => {
    expect(dunningDraftId("INV-1", "reminder")).not.toBe(dunningDraftId("INV-1", "firm"));
    expect(dunningDraftId("INV-1", "firm")).not.toBe(dunningDraftId("INV-1", "final"));
  });
  it("body_ref is the deterministic pointer Task 7 re-renders from", () => {
    expect(dunningBodyRef("INV-1", "final")).toBe("collector-dunning/INV-1/final");
  });
});

describe("REQ-032 Collector — tone-matched FIXED templates (no LLM, no clock, no random)", () => {
  const rendered: Record<DunningBucket, { subject: string; html: string }> = {
    reminder: renderDunningDraft({ ...BASE, bucket: "reminder" }),
    firm: renderDunningDraft({ ...BASE, bucket: "firm" }),
    final: renderDunningDraft({ ...BASE, bucket: "final" }),
  };

  it("each bucket renders a DISTINCT escalating tone in BOTH the subject and the body", () => {
    expect(rendered.reminder.subject).toContain("REMINDER");
    expect(rendered.firm.subject).toContain("PAST DUE");
    expect(rendered.final.subject).toContain("FINAL NOTICE");
    // the three bodies are genuinely different copy (the tone escalates), never the same template.
    expect(rendered.reminder.html).not.toBe(rendered.firm.html);
    expect(rendered.firm.html).not.toBe(rendered.final.html);
    expect(rendered.reminder.html.toLowerCase()).toContain("reminder");
    expect(rendered.final.html.toLowerCase()).toContain("final notice");
  });

  it("the amount-due renders via INTEGER-cents formatting (money never a float)", () => {
    expect(rendered.reminder.subject).toContain("$1,480.00");
    expect(rendered.reminder.html).toContain("$1,480.00");
  });

  it("the invoice ref + amount + days-overdue are the ONLY interpolated data (the body is bounded)", () => {
    const r = renderDunningDraft({ ...BASE, invoice_ref: "INV-99", amount_cents: 5_00, days_overdue: 1 });
    expect(r.html).toContain("INV-99");
    expect(r.html).toContain("$5.00");
    expect(r.html).toContain("1 day"); // singular
    const many = renderDunningDraft({ ...BASE, days_overdue: 40, bucket: "firm" });
    expect(many.html).toContain("40 days"); // plural
  });

  it("the config-seeded tenant voice signs the draft (a from-name, NOT model output)", () => {
    expect(rendered.reminder.html).toContain("Example Freight Desk");
  });

  it("is DETERMINISTIC — same input → identical bytes (no Date, no random ⇒ no model output)", () => {
    const a = renderDunningDraft(BASE);
    const b = renderDunningDraft(BASE);
    expect(a.subject).toBe(b.subject);
    expect(a.html).toBe(b.html);
  });

  it("REJECTS CR/LF in the invoice ref — it is interpolated into a mail header (subject)", () => {
    expect(() => renderDunningDraft({ ...BASE, invoice_ref: "INV-1\r\nBcc: evil@x" })).toThrow(/CR\/LF/);
  });

  it("is design-law clean — only blessed hexes, no shadow/gradient/oversized radius", () => {
    const html = renderDunningDraft(BASE).html;
    // §1511 — FLOOR THE LOOP: a renderer that emitted no hex colours at all (a move to classes, a broken
    // template) would satisfy "every hex is blessed" vacuously. The design law is about what IS emitted.
    expect(extractHexes(html).length, "the draft emitted no hex colours — the blessed-palette loop asserts nothing").toBeGreaterThan(0);
    for (const hex of extractHexes(html)) {
      expect(BLESSED_HEX.has(hex.toUpperCase()) || SANCTIONED_TRANSPARENTS.has(hex.toLowerCase()), `unblessed color ${hex}`).toBe(true);
    }
    expect(/box-shadow|gradient/i.test(html)).toBe(false);
    for (const m of html.matchAll(/border-radius\s*:\s*(\d+)px/gi)) expect(Number(m[1])).toBeLessThanOrEqual(4);
  });
});

// §1548 (REQ-032/082/083) — THE DUNNING ESCALATION AND THE AR AGING REPORT AGREE, BY CONSTRUCTION AND HERE.
//
// Two modules bucket the same overdue invoice: `contracts/aging.ts` (the AR report — CURRENT / 1–30 / 31–60 /
// >60) and this one (the dunning escalation — reminder / firm / final). Until §1548 the collector restated the
// cut points as `= 30` and `= 60` and imported NOTHING from the sibling whose header calls itself *"the SHARED
// AR-aging math. ONE definition of the aging buckets + the days-past-due."* Same numbers, written twice.
//
// They are now derived, so they cannot silently disagree — and this is the corpus that proves the derivation
// means what it claims. It is deliberately a RANGE rather than the four edge cases: an off-by-one in either
// module shows up as a whole band of days mapping to the wrong tone, and the edges alone would not say which.
describe("§1548 the dunning buckets and the AR aging buckets partition the same line", () => {
  const PAIRS: ReadonlyArray<readonly [string, DunningBucket]> = [
    ["1–30D", "reminder"],
    ["31–60D", "firm"],
    [">60D", "final"],
  ];

  it("every day from 1 to 120 lands in corresponding buckets in both modules", () => {
    const mismatches: string[] = [];
    for (let d = 1; d <= 120; d += 1) {
      const report = agingBucketFor(d);
      const dunning = agingBucket(d);
      const expected = PAIRS.find(([label]) => label === report)?.[1];
      if (expected !== dunning) mismatches.push(`day ${d}: report=${report} dunning=${dunning}`);
    }
    expect(
      mismatches,
      "the AR aging report and the dunning escalation disagree about which bucket an invoice is in. Both are " +
        "money-facing and customer-visible: the report shows a total, the email sets a tone, and a customer can " +
        "see both. The cut points are DERIVED from contracts@AGING_BUCKETS precisely so this cannot happen:\n  " +
        mismatches.slice(0, 8).join("\n  "),
    ).toEqual([]);
  });

  it("the derived edges ARE the shared table's edges, not a coincidence that matches today", () => {
    expect(REMINDER_MAX_DAYS, "REMINDER_MAX_DAYS is no longer the top of the shared 1-30 bucket").toBe(30);
    expect(FIRM_MAX_DAYS, "FIRM_MAX_DAYS is no longer the top of the shared 31-60 bucket").toBe(60);
    // …and the derivation reads the table rather than a literal: every slug it names must exist there.
    for (const slug of ["1-30", "31-60"]) {
      expect(AGING_BUCKETS.some((b) => b.slug === slug), `contracts@AGING_BUCKETS lost the '${slug}' bucket the derivation reads`).toBe(true);
    }
  });

  it("overdueDays is the shared days-past-due, clamped — one division, not two", () => {
    const due = Date.UTC(2026, 5, 1);
    for (const days of [0, 1, 30, 31, 60, 61, 119]) {
      const now = due + days * AGING_DAY_MS;
      expect(overdueDays(now, due), `day ${days} diverges from the shared computation`).toBe(Math.max(0, daysPastDue(due, now)));
    }
    expect(overdueDays(due - 10 * AGING_DAY_MS, due), "the clamp is this module's own rule and must survive delegation").toBe(0);
  });
});
