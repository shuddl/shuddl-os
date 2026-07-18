// WP-11 Task 6 — THE COLLECTOR's aging decision (REQ-032). PURE + DETERMINISTIC + LLM-FREE.
//
// An open invoice's whole-days-overdue (relative to its due_ts) → an escalation BUCKET → a FIXED,
// tone-matched dunning template. The tone is a FIXED template keyed by the bucket — NEVER model output
// (deterministic + auditable; an LLM tone-polish is a later CONFIRM, not v1). The decision is CLOCK-FREE:
// `agingBucket` takes an already-computed day count; the sweep supplies the injected clock to `overdueDays`.
//
// IDEMPOTENCY: one draft per (invoice, ESCALATION BUCKET). The bucket IS the escalation period for v1 —
// a re-sweep of the SAME overdue state yields the SAME draft id (INSERT OR IGNORE ⇒ no duplicate), and an
// invoice that ages into a firmer bucket yields a NEW id (a firmer draft, never a clobber). `dunningDraftId`
// (the messages PK) and `dunningBodyRef` (the render pointer Task 7 recovers) are the two canonical shapes.

/** The three escalation buckets, friendly → firm → final. */
export type DunningBucket = "reminder" | "firm" | "final";

/** reminder covers ≤30 days past due (friendly). */
export const REMINDER_MAX_DAYS = 30;
/** firm covers 31–60 days past due (past-due); >60 is final. */
export const FIRM_MAX_DAYS = 60;

const DAY_MS = 86_400_000; // integer canonical law: aging is a whole number of days

/**
 * Whole days overdue = floor((now − due_ts) / DAY), clamped at 0 (never negative). The clock is INJECTED
 * (the sweep supplies `nowMs`); nothing here reads a fresh Date. A not-yet-due invoice yields 0 — the sweep's
 * `due_ts < now` filter means this is only ever called on genuinely-overdue rows, but the clamp keeps the pure
 * function total.
 */
export function overdueDays(nowMs: number, dueTsMs: number): number {
  const delta = nowMs - dueTsMs;
  if (delta <= 0) return 0;
  return Math.floor(delta / DAY_MS);
}

/** The escalation bucket for a whole-days-overdue count. ≤30 reminder · 31–60 firm · >60 final. */
export function agingBucket(daysOverdue: number): DunningBucket {
  if (daysOverdue <= REMINDER_MAX_DAYS) return "reminder";
  if (daysOverdue <= FIRM_MAX_DAYS) return "firm";
  return "final";
}

/**
 * The deterministic DRAFT id (the `messages` PK) — one draft per invoice per escalation bucket. Deterministic
 * so a re-sweep of the same state INSERT-OR-IGNOREs to a no-op; bucket-scoped so a firmer tone is a new row.
 */
export function dunningDraftId(invoiceId: string, bucket: DunningBucket): string {
  return `msg:dunning:${invoiceId}:${bucket}`;
}

/**
 * The deterministic body_ref pointer stored on the draft row. `messages` has no subject/body column (a draft
 * is a POINTER, exactly like the Concierge's `concierge-draft/<id>`); Task 7 recovers (invoiceId, bucket) from
 * this ref, reloads the invoice, and re-renders the identical bytes via `renderDunningDraft`.
 */
export function dunningBodyRef(invoiceId: string, bucket: DunningBucket): string {
  return `collector-dunning/${invoiceId}/${bucket}`;
}

/** The FIXED, per-bucket tone copy (config-independent, LLM-free). The tenant voice is the from-name only. */
export interface DunningTone {
  /** The eyebrow line above the headline. */
  eyebrow: string;
  /** The Display headline — the escalating tone the reader sees first. */
  headline: string;
  /** The uppercase subject tag (a mail-header token). */
  subjectTag: string;
  /** The closing line under the metadata — the escalating ask. */
  footer: string;
}

// The three FIXED tones. Escalating, deterministic, auditable — NOT model output. REQ-167-clean (no names).
export const DUNNING_TONES: Record<DunningBucket, DunningTone> = {
  reminder: {
    eyebrow: "Shuddl · Payment reminder",
    headline: "A friendly reminder",
    subjectTag: "REMINDER",
    footer: "A gentle reminder — if payment is already on its way, please disregard.",
  },
  firm: {
    eyebrow: "Shuddl · Past-due notice",
    headline: "Past due",
    subjectTag: "PAST DUE",
    footer: "This invoice is now past due — please arrange payment at your earliest convenience.",
  },
  final: {
    eyebrow: "Shuddl · Final notice",
    headline: "Final notice",
    subjectTag: "FINAL NOTICE",
    footer: "Final notice — please remit immediately to keep this account in good standing.",
  },
};
