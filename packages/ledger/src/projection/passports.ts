// REQ-009 — passport fields exist AND accrue from events. Passports are MUTABLE projections: the
// counters here are derived, never the source of truth (the events they come from are). The
// sequencer batches these statements with the event INSERT.
//
// FK CONTRACT (enforced): passports.party_id REFERENCES parties(id). Accruing for a party that has
// no `parties` row makes the passport INSERT fail its foreign key, and because these statements ride
// in the same db.batch() as the event, the WHOLE append aborts atomically. Therefore every fixture,
// seed, and API path that appends events for a party MUST create the party first (binds Tasks 11/14/17).
import type { LedgerEvent } from "@shuddl/contracts";

// One accrual: create the passport with the counter at 1, or increment that counter if it exists.
// Numbered params (?1 party, ?2 field, ?3 updated_at) so ?2 can appear three times unambiguously.
const BUMP_SQL =
  "INSERT INTO passports (party_id, scores, updated_at) VALUES (?1, json_object(?2, 1), ?3) " +
  "ON CONFLICT(party_id) DO UPDATE SET " +
  "scores = json_set(scores, '$.' || ?2, COALESCE(json_extract(scores, '$.' || ?2), 0) + 1), " +
  "updated_at = ?3";

/**
 * The passport counters an event implies. pod.signed -> deliveries (+on_time when the payload flags
 * it); exception.raised -> exceptions; osd.captured -> claims_opened; custody.transferred ->
 * custody_events. Every other kind accrues nothing.
 */
export function projectPassport(db: D1Database, e: LedgerEvent): D1PreparedStatement[] {
  const bump = (party: string, field: string): D1PreparedStatement =>
    db.prepare(BUMP_SQL).bind(party, field, e.recorded_at);

  switch (e.kind) {
    case "pod.signed": {
      const stmts = [bump(e.actor.party, "deliveries")];
      // NOTE: PodSignedPayload (contracts, merged) is .strict() and carries no `on_time` field, so
      // this branch is dormant until a contract amendment adds it. Read defensively so it lights up
      // the moment the field exists — see the PR/report note.
      if ((e.payload as { on_time?: unknown }).on_time === true) stmts.push(bump(e.actor.party, "on_time"));
      return stmts;
    }
    case "exception.raised":
      return [bump(e.actor.party, "exceptions")];
    case "osd.captured":
      return [bump(e.actor.party, "claims_opened")];
    case "custody.transferred":
      return [bump(e.actor.party, "custody_events")];
    default:
      return [];
  }
}
