// WP-15 Task 2 (REQ-030 / REQ-008, Ten Laws L8) — resolveAuthority: the shared, server-side READ-SEAM that
// every module's authoritative-output path consults to answer ONE question: for this module, is SHUDDL's
// NATIVE computation authoritative, or does it defer to the incumbent's LEGACY mirror? It reads the
// `authority_map` read-model (db/tenant/migrations/0002_domain.sql:94) that the Task-1 authority.flipped
// projection (projection/authority.ts) maintains. This is the AUTHORITY analog of workers/api/src/
// gate-context.ts: ONE shared seam so a module's authority can never DRIFT between paths — exactly the
// pattern the 2026-07-15 audit established after a bypass route silently dropped a gate the main path enforced
// (see .claude/skills/enforce-server-side-gate-parity).
//
// WHY THIS LIVES IN @shuddl/ledger (not workers/api): it is consulted from BOTH the api worker (the rate /
// quote / dunning routes) AND the agents worker (the biller / interline-split / concierge consumers), and
// those two workers have NO dependency edge — workers/agents does NOT depend on @shuddl/api (see
// workers/agents/package.json; the rate-config.ts duplication note in concierge.ts documents the same split).
// A shared READ of a LEDGER read-model — authority_map, whose PROJECTION already lives at projection/
// authority.ts — belongs in the one package BOTH workers import, so there is a SINGLE implementation and zero
// parity-drift risk (stronger than the rate-config.ts duplicate-plus-parity-test pattern). workers/api/src/
// authority.ts re-exports this so the api routes still import a LOCAL sibling of gate-context.ts.
// REQ-024-clean: no LLM, no Date, no side effects — a pure read + a pure decision.
//
// FAIL-CLOSED (mirrors gate-context.ts's "returns fail-closed, never throws"): `native` is returned ONLY when
// the stored value is EXACTLY 'native'; a missing row, a NULL, an unrecognized value, or ANY thrown error all
// resolve to 'legacy'. `db` is ALREADY the tenant's OWN D1 (resolved upstream from the JWT tenant claim), so
// this is tenant-scoped BY CONSTRUCTION (REQ-025) — it NEVER takes a tenant from a header or a body.

import type { AuthorityLevel, AuthorityModule } from "@shuddl/contracts";

// Re-export Task 1's contract types so every caller imports the module/level type FROM the seam (one source).
export type { AuthorityModule, AuthorityLevel } from "@shuddl/contracts";

// Byte-scoped to the map's PK lookup. authority_map: module (PK, one of the 5 overlay modules), authority
// (NOT NULL DEFAULT 'legacy' CHECK IN ('native','legacy')). We SELECT only the column we decide on.
const AUTHORITY_SQL = "SELECT authority FROM authority_map WHERE module = ?";

/**
 * Resolve whether SHUDDL's NATIVE computation is authoritative for `module` on THIS tenant's ledger.
 * Returns 'native' ONLY for a stored row whose authority is EXACTLY 'native'; fail-closed to 'legacy' for a
 * missing row / a NULL / an unrecognized value / ANY thrown query error. NEVER throws (gate-context.ts
 * discipline). Because the map ships UNSEEDED (nothing flipped), every module fail-closes to 'legacy' today.
 */
export async function resolveAuthority(db: D1Database, module: AuthorityModule): Promise<AuthorityLevel> {
  try {
    const row = await db.prepare(AUTHORITY_SQL).bind(module).first<{ authority: string | null }>();
    return row !== null && row.authority === "native" ? "native" : "legacy";
  } catch {
    // A read fault (a table dropped mid-migration, a transient D1 error) must NEVER let the incumbent's
    // authority masquerade as SHUDDL's — fail closed to 'legacy', exactly like gate-context.ts's reads.
    return "legacy";
  }
}

/**
 * authoritativeSource — the pure decision a caller makes AFTER resolveAuthority: which value does it output?
 *   - `native`  → SHUDDL's native computation is authoritative → output the NATIVE value.
 *   - `legacy` AND a mirror value EXISTS for the object → shadow mode → output the LEGACY mirror value.
 *   - `legacy` but NO mirror value exists → still output NATIVE. The freight is real and must be priced /
 *     invoiced / settled — "no price on air" (REQ-004) forbids withholding output merely because authority
 *     has not yet flipped and no incumbent mirror exists to defer to.
 * TODAY every caller passes `legacyValueAvailable = false` (no legacy mirror exists yet — the 171-col mirror
 * adapter is WP-15 Task 4), so this ALWAYS returns 'native'. That is what makes the wiring behavior-NEUTRAL
 * while still being LOAD-BEARING (not dead code): the seam is consulted everywhere, but INERT in effect until
 * a flip AND a mirror BOTH exist. Tasks 4/6/8 supply the real `legacyValueAvailable`. PURE — no I/O.
 */
export function authoritativeSource(authority: AuthorityLevel, legacyValueAvailable: boolean): AuthorityLevel {
  if (authority === "native") return "native";
  return legacyValueAvailable ? "legacy" : "native";
}
