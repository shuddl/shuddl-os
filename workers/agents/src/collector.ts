// WP-11 Task 6 — THE COLLECTOR dunning sweep (REQ-032). The per-tenant complement to the WP-10 AR-settlement
// projection (money.ts): that projection stamps an issued invoice's `terms`/`due_ts` and flips it to 'paid'
// on a covering payment; THIS sweep, running per-tenant on the agents cron, finds the ones now OVERDUE and
// still OPEN (`status='issued' AND due_ts < now`) and DRAFTS a tone-matched dunning message for each.
//
// DRAFT ONLY — NEVER AUTO-SEND (REQ-032 DoD: "Draft quality human-rated; no auto-send"). The sweep writes a
// DRAFT `messages` row (drafted_by_agent='collector') and appends NO `message.sent` and calls NO sender —
// Task 7 owns the human-initiated review-and-send. The draft is a POINTER (the `messages` read-model has no
// subject/body column, exactly like the Concierge's `concierge-draft/<id>`): the deterministic body_ref
// encodes (invoice, bucket) so Task 7 reloads the invoice and re-renders the identical bytes via
// renderDunningDraft. LLM-FREE: v1 dunning is a FIXED per-bucket template (aging.ts), never model output.
//
// IDEMPOTENT: the draft id is deterministic per (invoice, escalation BUCKET) — a re-sweep of the SAME overdue
// state INSERT-OR-IGNOREs to a no-op (the id already exists), while an invoice that ages into a firmer bucket
// yields a NEW id (a firmer draft, never a clobber). No new table, no new event kind.
//
// TENANT ISOLATION (REQ-025): the caller binds `db` to ONE tenant's D1; the sweep reads + writes ONLY that
// D1 (it appends no event and names no tenant), so it CANNOT touch another tenant. PURITY OF INPUTS: `now` is
// supplied by the caller (the cron reads wall-clock); the pure decision (agingBucket) never reads a clock.

import { agingBucket, overdueDays, dunningDraftId, dunningBodyRef } from "@shuddl/agents";
import { resolveRecipient } from "./biller.js";

export interface CollectorSweepResult {
  /** Overdue OPEN invoices returned by the query. */
  scanned: number;
  /** Draft `messages` rows genuinely inserted this pass (INSERT OR IGNORE with changes>0). */
  drafted: number;
  /** Overdue invoices whose (invoice, bucket) draft already existed — the idempotent re-sweep no-op count. */
  already_drafted: number;
  /** Overdue invoices skipped because the bill-to party has no resolvable billing email (a dunning email we
   *  cannot address is not drafted — mirrors the Biller HOLDing an evidence send with no recipient). */
  no_recipient: number;
}

// One overdue candidate: an OPEN invoice past its due_ts. `party_id` is the bill-to party the invoice was
// issued to (money.ts writes it as the invoice's `party_id`), and the dunning recipient resolves off it.
interface OverdueInvoiceRow {
  id: string;
  party_id: string;
  total_cents: number;
  due_ts: number;
}

// status='issued' is OPEN (money.ts flips a covered invoice to 'paid'); due_ts IS NOT NULL AND due_ts < now is
// OVERDUE. An invoice with no terms carries a NULL due_ts and CANNOT be overdue — it is excluded honestly (no
// due date ⇒ nothing to dun), never treated as instantly-past-due.
const OVERDUE_INVOICES_SQL =
  "SELECT id, party_id, total_cents, due_ts FROM invoices " +
  "WHERE status = 'issued' AND due_ts IS NOT NULL AND due_ts < ?1";

// The DRAFT artifact — a `messages` read-model row (MUTABLE, no append-only guard, so a direct INSERT OR
// IGNORE on the deterministic id is legal + idempotent). channel='email', direction='out', drafted_by_agent=
// 'collector'; shipment_id is NULL (a dunning draft is PARTY/INVOICE-scoped, never shipment-scoped); the
// body_ref is the deterministic render pointer. NOT a message.sent (a draft was never sent, REQ-032/REQ-100).
const RECORD_DRAFT_SQL =
  "INSERT OR IGNORE INTO messages (id, channel, direction, party_id, shipment_id, resolved_conf, thread, body_ref, drafted_by_agent, sla_due_ts) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?)";

/**
 * Sweep ONE tenant's OPEN overdue invoices and DRAFT a tone-matched dunning `messages` row for each. The
 * caller binds `db` to that one tenant (REQ-025). `now` is the sweep clock (injected; deterministic in tests).
 * Idempotent: safe to call every cron tick — a re-sweep of the same overdue state re-derives the same draft id
 * and INSERT OR IGNORE makes it a no-op. Appends NO event and calls NO sender (draft only; Task 7 sends).
 */
export async function sweepTenantOverdueInvoices(db: D1Database, now: number): Promise<CollectorSweepResult> {
  const rows = (await db.prepare(OVERDUE_INVOICES_SQL).bind(now).all<OverdueInvoiceRow>()).results;
  let drafted = 0;
  let alreadyDrafted = 0;
  let noRecipient = 0;

  for (const inv of rows) {
    // The dunning recipient — the bill-to party's billing contact (resolveRecipient prefers `kind:"billing"`,
    // the SAME resolver the Biller's evidence send uses). No deliverable address ⇒ no draft (a dunning email we
    // cannot address is a data fault the AR-aging surface shows, not a draft Task 7 could ever send).
    const recipient = await resolveRecipient(db, inv.party_id);
    if (recipient === undefined) {
      noRecipient += 1;
      continue;
    }

    // The escalation bucket from the whole-days-overdue (injected clock in → clock-free decision out).
    const bucket = agingBucket(overdueDays(now, inv.due_ts));

    const res = await db
      .prepare(RECORD_DRAFT_SQL)
      .bind(
        dunningDraftId(inv.id, bucket),
        "email",
        "out",
        inv.party_id,
        null, // shipment_id — party/invoice-scoped dunning, NOT shipment-scoped
        null, // resolved_conf
        null, // thread
        dunningBodyRef(inv.id, bucket),
        "collector",
        null, // sla_due_ts
      )
      .run();

    // meta.changes distinguishes a genuine new draft from an INSERT OR IGNORE no-op (the idempotent re-sweep) —
    // the same signal evidence.ts uses to tell a healed row from an existing one.
    if ((res.meta?.changes ?? 0) > 0) drafted += 1;
    else alreadyDrafted += 1;
  }

  return { scanned: rows.length, drafted, already_drafted: alreadyDrafted, no_recipient: noRecipient };
}
