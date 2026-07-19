// WP-11 Task 9 (REQ-113) — the agent_runs METERING projection. Populates the EXISTING (previously DEAD,
// never-written) `agent_runs` table (0002_domain.sql:89-93) from committed `agent.acted` events, turning it
// into a LIVE per-run cost/latency ledger the Watchtower reads to enforce per-agent budgets. NO new table,
// NO new event kind — `agent.acted` already carries the fields (contracts/src/events.ts:151-152, cost_cents /
// latency_ms, both optional); the ONLY missing wiring was projecting them into a row.
//
// `agent_runs` is an UNGUARDED (mutable) domain read-model — NOT append-only-guarded (only events / positions /
// money_lines are, 0003_insert_guards.sql). The INSERT is PLAIN `INSERT OR IGNORE` on the PK (the agent.acted
// EVENT id) — never INSERT OR REPLACE (that verb is lint-banned; it would DELETE-then-reinsert the row). It is
// IDEMPOTENT under the sequencer's replay-by-event-id: OR IGNORE no-ops on the existing id, so a redelivered
// agent.acted re-runs this projection with no duplicate row. The row rides in the event's db.batch() (I1) — the
// run row and its event commit together or not at all.
//
// HONESTY (the WP-10/11 metric law): cost/latency are recorded EXACTLY as the emitting agent reported them —
// never fabricated. A deterministic agent emits cost_cents:0 (an honest zero → stored `{cents:0}`); an agent
// that reports no cost records cost `{}` (unknown), and one that reports no latency records latency_ms NULL — we
// store the ABSENCE, we do not invent a number. The Watchtower's window AVG then naturally skips the unknowns,
// so an agent can never be alarmed on a metric it never reported.
//
// PURE — no Date / LLM / I/O (REQ-024); a pure function of the event, mirroring approvals.ts / status-cache.ts.
import type { LedgerEvent } from "@shuddl/contracts";

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);

// agent_runs columns (0002_domain.sql:89-93): id, agent, trigger_event_id, actions(j), basis(j), confidence,
// cost(j), latency_ms, outcome. The row id IS the agent.acted event id — unique + deterministic across a
// replay, so OR IGNORE dedupes a redelivery cleanly. `cost` is a JSON blob (schema shape), so a reported
// cost is stored as `{cents:N}` and an unreported one as `{}`.
const INSERT_SQL =
  "INSERT OR IGNORE INTO agent_runs (id, agent, trigger_event_id, actions, basis, confidence, cost, latency_ms, outcome) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

interface BasisLink {
  kind: string;
  id: string;
}
function isEventBasis(b: unknown): b is BasisLink {
  return typeof b === "object" && b !== null && (b as { kind?: unknown }).kind === "event" && typeof (b as { id?: unknown }).id === "string";
}

/**
 * The agent_runs metering row an event implies. Only `agent.acted` projects (every other kind → []). cost is
 * `{cents:N}` when the agent reported cost_cents (a deterministic 0 counts), else `{}` (unknown — NOT fabricated
 * as 0). latency_ms is the reported integer or NULL (absence, never invented). trigger_event_id is the first
 * cited EVENT-kind basis link (the provenance event) or NULL. A malformed agent.acted (no `agent`) opens no
 * row rather than aborting the append — the ledger event stays truth, the read-model is best-effort (the
 * status-cache/approvals "return [] for what I can't shape" discipline).
 */
export function projectAgentRuns(db: D1Database, e: LedgerEvent): D1PreparedStatement[] {
  if (e.kind !== "agent.acted") return [];
  const p = e.payload;
  const agent = asString(p["agent"]);
  if (agent === undefined) return [];

  const action = asString(p["action"]);
  const basis = Array.isArray(p["basis"]) ? (p["basis"] as unknown[]) : [];
  const triggerEventId = basis.find(isEventBasis)?.id ?? null;
  const confidence = asInt(p["confidence_bps"]) ?? null;
  const costCents = asInt(p["cost_cents"]);
  const cost = costCents === undefined ? "{}" : JSON.stringify({ cents: costCents });
  const latencyMs = asInt(p["latency_ms"]) ?? null;

  return [
    db
      .prepare(INSERT_SQL)
      .bind(
        e.id,
        agent,
        triggerEventId,
        JSON.stringify(action === undefined ? [] : [action]),
        JSON.stringify(basis),
        confidence,
        cost,
        latencyMs,
        action ?? null,
      ),
  ];
}
