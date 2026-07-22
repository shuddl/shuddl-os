// WP-15 Task 1 (REQ-008/023, Ten Laws L8) — the authority-flip read-model projection. The append-only,
// co-signed `authority.flipped` EVENT is truth; `authority_map` (0002_domain.sql:94-98) is its PROJECTION —
// the per-module overlay the Command surface reads to know whether SHUDDL runs a module natively or defers
// to legacy. The map is NEVER mutated without one of these events (L8) — this projection is its ONLY writer.
//
// `authority_map` is an UNGUARDED (mutable) domain read-model — NOT append-only-guarded (only events /
// positions / money_lines are, 0003_insert_guards.sql). So the UPSERT (INSERT ... ON CONFLICT(module) DO
// UPDATE) is legal here — the SAME verb status-cache.ts uses on `shipments` and its anomalies-gap uses;
// never INSERT OR REPLACE (that verb is lint-banned; it would DELETE-then-reinsert the row). The UPSERT is
// required because the table ships UNSEEDED — a flip of a never-flipped module lands even when its row is
// absent. The row rides the event's db.batch() (I1) — the map mutation and its event commit together or not
// at all.
//
// IDEMPOTENT under the sequencer's replay-by-event-id: re-applying the SAME authority.flipped lands identical
// state — `authority`/`gates_status` re-set to the same values, and e.id is appended to flipped_events ONLY
// when not already present (the EXISTS(json_each ...) membership dedupe). So a redelivered event is a no-op
// on the array — the id is recorded exactly once.
//
// The event is TRUTH; the projection just APPLIES `to`. It does NOT check that `from` matches the map's
// current authority, and it does NOT enforce any gate — the forward-blocked-until-green GUARD is a later
// task's server-side (Gatekeeper) concern, never the projection's.
//
// PURE — no Date / LLM / I/O (REQ-024); a pure function of the event, mirroring approvals.ts / agent-runs.ts.
import type { LedgerEvent } from "@shuddl/contracts";

// authority_map columns (0002_domain.sql:94-98): module (PK), authority, gates_status (j), flipped_events (j).
// gates_status: COALESCE(?, …) — a PRESENT gate_snapshot writes its JSON; an ABSENT one (bound NULL) keeps
// the '{}' default on INSERT and the existing value on UPDATE (never clobbers a prior snapshot with '{}').
// flipped_events: a NEW row starts json_array(e.id); an EXISTING row appends e.id ONLY when the membership
// check finds it absent — json_insert(…, '$[#]', ?) appends to the array tail. This is the replay-idempotent
// append (a redelivered event does not double-record its id).
const FLIP_SQL =
  "INSERT INTO authority_map (module, authority, gates_status, flipped_events) " +
  "VALUES (?, ?, COALESCE(?, '{}'), json_array(?)) " +
  "ON CONFLICT(module) DO UPDATE SET " +
  "authority = ?, " +
  "gates_status = COALESCE(?, authority_map.gates_status), " +
  "flipped_events = CASE " +
  "WHEN EXISTS (SELECT 1 FROM json_each(authority_map.flipped_events) WHERE value = ?) " +
  "THEN authority_map.flipped_events " +
  "ELSE json_insert(authority_map.flipped_events, '$[#]', ?) END";

/**
 * The authority_map mutation an event implies. Only `authority.flipped` projects (every other kind → []).
 * It UPSERTS the module row to authority = payload.to, writes payload.gate_snapshot into gates_status when
 * present (else leaves it untouched), and idempotently records e.id in flipped_events. PURE; it applies the
 * event's `to` verbatim — no gate, no from-state check (those are the server-side Gatekeeper's, not the
 * read-model's).
 */
export function projectAuthority(db: D1Database, e: LedgerEvent): D1PreparedStatement[] {
  if (e.kind !== "authority.flipped") return [];
  const { module, to } = e.payload;
  const gates = e.payload.gate_snapshot === undefined ? null : JSON.stringify(e.payload.gate_snapshot);
  return [db.prepare(FLIP_SQL).bind(module, to, gates, e.id, to, gates, e.id, e.id)];
}
