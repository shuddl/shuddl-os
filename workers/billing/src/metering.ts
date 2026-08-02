// WP-14 Task 6 · REQ-123 / REQ-025 — THE CROSS-DB METERING RECOMPUTE SWEEP.
//
// THE METERED UNIT is the AI action = the frozen `agent.acted` event. `agent_runs`
// (packages/ledger/src/projection/agent-runs.ts) is the idempotent one-row-per-`agent.acted` meter — an
// `INSERT OR IGNORE` on the event id — so COUNT(agent_runs) == COUNT(agent.acted) EXACTLY, forever.
//
// WHY A SWEEP (not a sequencer write): the events ledger is per-tenant D1; `usage_credits` is control-plane D1,
// a SEPARATE database. The metering write therefore cannot ride the sequencer's single-DB db.batch() (I1). So
// it is a scheduled RECOMPUTE-FROM-LEDGER: for each tenant, count agent_runs per (agent, period) via the SAME
// `agent_runs ar JOIN events e ON e.id = ar.id` shape the Watchtower's agent-drift sweep uses (agent_runs has
// no ts, so the period clock comes from the joined events.ts), then OVERWRITE `usage_credits.metered` for that
// (tenant, period). A full REPLACE of the period blob — NEVER a `+=` counter — so it is drift-free by
// construction: every tick recomputes the whole truth and stamps it down, and a re-run is a no-op.
//
// REQ-025: one tenant's D1 read + only that tenant's OWN control row write per iteration; the deterministic id
// `<tenant>:<period>` keeps a tenant's rows in its own key space. LLM-free, deterministic. No new table — a
// worker + a cron is not a table.
import { allTenantSlugs, resolveTenantDb, type BillingEnv } from "./tenants.js";

// The metering period: the UTC calendar month, "YYYY-MM", off the event's ts (epoch ms). Mirrors
// workers/mcp/src/caps.ts `currentPeriod` — a clear, deterministic window.
export function periodOf(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// The control-row identity for a (tenant, period). Deterministic, so a recompute OVERWRITES in place (one row
// per tenant-period forever — never a duplicate, never a stray). The sweep OWNS this row; a future Stripe
// reconciliation must key `stripe_refs` on the SAME id so the two never fork.
export function usageCreditsId(tenant: string, period: string): string {
  return `${tenant}:${period}`;
}

// THE RECONCILIATION JOIN — the EXACT shape workers/agents/src/watchtower.ts sweepAgentDrift uses. agent_runs
// is one-row-per-`agent.acted` (INSERT OR IGNORE on the event id), and the row rides in its event's commit
// batch, so this INNER JOIN is 1:1 with the committed agent.acted events: COUNT(rows) == COUNT(agent.acted).
// A partial/corrupt agent_runs row with no matching event is DROPPED by the inner join — never metered.
const RUNS_JOIN_SQL = "SELECT ar.agent AS agent, e.ts AS ts FROM agent_runs ar JOIN events e ON e.id = ar.id";

// OVERWRITE (never `+=`): insert the freshly-recomputed blob for `<tenant>:<period>`; on a repeat tick REPLACE
// only `metered` from the recompute. `stripe_refs` is left untouched on conflict, so a value stamped by the
// billing/Stripe path survives a re-sweep. `usage_credits` is a control-plane read-model (NOT an append-only
// ledger table — only events/positions/money_lines are guarded), so an upsert on it is the idiomatic
// projection write (mirrors the invoices AR read-model), and the invariants lint bans upserts ONLY on the
// guarded tables.
const OVERWRITE_SQL =
  "INSERT INTO usage_credits (id, tenant_id, period, metered, stripe_refs) VALUES (?, ?, ?, ?, '{}') " +
  "ON CONFLICT(id) DO UPDATE SET metered = excluded.metered";

export interface TenantMeteringSummary {
  tenant: string;
  runs: number;
  periods: number;
}

// Recompute + OVERWRITE one tenant's metering. Reads ONLY this tenant's D1; writes ONLY this tenant's control
// rows (id/tenant_id scoped to `tenant`). REQ-025.
export async function sweepTenantMetering(
  tenantD1: D1Database,
  controlD1: D1Database,
  tenant: string,
): Promise<TenantMeteringSummary> {
  const rows = (await tenantD1.prepare(RUNS_JOIN_SQL).all<{ agent: string; ts: number }>()).results;

  // period → (agent → count). A FULL recompute from the ledger — the existing metered value is never read.
  const byPeriod = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const period = periodOf(r.ts);
    let agents = byPeriod.get(period);
    if (agents === undefined) {
      agents = new Map<string, number>();
      byPeriod.set(period, agents);
    }
    agents.set(r.agent, (agents.get(r.agent) ?? 0) + 1);
  }

  // OVERWRITE each (tenant, period)'s metered blob with the recomputed {agent: count}. Agents are emitted in a
  // stable (sorted) order so the stored JSON is deterministic across ticks (a byte-identical no-op re-write).
  for (const [period, agents] of byPeriod) {
    const metered: Record<string, number> = {};
    for (const [agent, count] of [...agents.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      metered[agent] = count;
    }
    await controlD1
      .prepare(OVERWRITE_SQL)
      .bind(usageCreditsId(tenant, period), tenant, period, JSON.stringify(metered))
      .run();
  }

  return { tenant, runs: rows.length, periods: byPeriod.size };
}

// The driven entrypoint — recompute every allowlisted customer tenant (REQ-025: one tenant's D1 + its own
// control rows per iteration). Per-tenant fault isolation: one tenant's failure is logged and never aborts the
// rest. The whole sweep is idempotent (OVERWRITE), so re-running each cron tick is safe.
export async function runMeteringSweep(env: BillingEnv): Promise<void> {
  // Claimed-aware (2026-08-01 §12): an unmetered claimed tenant is UNBILLED usage the day PLG flips.
  for (const slug of await allTenantSlugs(env)) {
    try {
      const summary = await sweepTenantMetering(await resolveTenantDb(env, slug), env.CONTROL_DB, slug);
      console.log(`metering-sweep: tenant ${slug} → ${JSON.stringify(summary)}`);
    } catch (err) {
      console.error(`metering-sweep: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
  }
}
