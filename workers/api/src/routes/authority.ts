import type { Hono } from "hono";
import { z } from "zod";
import { AuthorityModule, deterministicUuid, type AuthorityLevel } from "@shuddl/contracts";
import { computeModuleParity } from "@shuddl/ledger/parity";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { resolveAuthority } from "../authority.js";
import { translateAppendError, type SeqStub } from "./events.js";
import type { AppendedEvent } from "../do/sequencer.js";
import type { Env, Vars } from "../index.js";

// WP-15 Task 3 (REQ-023 / REQ-030, Ten Laws L8) — the Gatekeeper FLIP GUARD. A per-module authority flip is a
// SERVER-SIDE Gatekeeper decision, NEVER a UI toggle (REQ-030: gates are server-side; UIs merely reflect them).
// POST /v1/authority/:module/flip either PROMOTES a module to native (FORWARD — blocked until its parity is
// proven green) or FALLS BACK to legacy (BACKWARD — always allowed), and records the decision as a co-signed,
// append-only `authority.flipped` event on the tenant-level `t:root` stream. The Task-1 projection turns that
// ONE event into the authority_map change — the route NEVER writes authority_map directly (L8: authority is
// earned module-by-module and the flip is a ledger event; the map is its projection).
//
// THE ASYMMETRY (the overlay's safety model):
//   · FORWARD (legacy→native, "promote"): ceding the incumbent's authority to SHUDDL is the DANGEROUS direction
//     — it must be EARNED. Blocked unless the FRESH gate (gatesGreenFor) is green; a not-green forward flip is a
//     403 with NOTHING appended (no partial write). Green ⇒ the flip carries a gate_snapshot: the audit record
//     of WHY it was allowed.
//   · BACKWARD (native→legacy, "manual"): returning to the incumbent is the SAFE direction — a fallback must be
//     possible at any instant (this is the human twin of the Watchtower's Task-8 auto drift-fallback). ALWAYS
//     allowed; no gate is consulted. (Task-8's auto-fallback appends the SAME kind on the SAME t:root stream
//     with reason:'drift'.)
//
// SINGLE-STREAM INVARIANT (prior review): ALL authority flips for a tenant append on t:root (one stream per
// tenant) so the projection's authority reflects seq order — a promote and a later fallback can never race into
// an out-of-order authority. This route (and Task-8's auto-fallback) both append on t:root.

// The request: the TARGET authority + an OPTIONAL operator justification. The event's `reason` enum is NOT taken
// from the body — it is SERVER-DERIVED from the direction (forward ⇒ 'promote', backward ⇒ 'manual') so a client
// can never mislabel why authority moved. The optional `reason` string is an operator note; when present it rides
// the forward flip's gate_snapshot (the only audit surface a promote writes). .strict() ⇒ an extra body key
// (e.g. a smuggled `tenant`) is a clean 400, never silently honored — the tenant comes from the JWT claim ONLY.
const FlipBody = z.object({ to: z.enum(["native", "legacy"]), reason: z.string().min(1).max(500).optional() }).strict();

// The two MONEY modules. Their authority additionally requires a CLEAN-CLOSE history (below) — money authority
// cannot be earned on parity alone. EXACT subset of the 5 overlay modules.
const MONEY_MODULES: ReadonlySet<AuthorityModule> = new Set<AuthorityModule>(["invoicing", "settlement"]);
// ≥2 CONSECUTIVE clean closes before a money module may go native (the money gate's second leg).
const REQUIRED_CLEAN_CLOSES = 2;

// ── the clean-close signal (the HONEST in-repo finding) ──────────────────────────────────────────────────────
// A "clean close" is a reconciled financial-period close (a tenant-calendar object: the tenant asserts a period
// is closed and the books tie out). SHUDDL does NOT build native GL / period close (CLAUDE.md "Do not build":
// journal export ONLY) — a real close lives OUTSIDE this repo, in the tenant engagement workspace (genesis/13),
// and there is NO event kind, table, or sweep in-repo that represents one (the 35 frozen kinds have no
// close/reconcile kind; recon-sweep.ts re-drives the Biller, sla-sweep.ts chases overdue replies — neither is a
// period close). So this returns 0 BY CONSTRUCTION: there is no honest signal to count, and fabricating one would
// green a money flip on air (the anti-false-green law, mirroring computeModuleParity's UNKNOWN discipline).
//
// CONSEQUENCE (documented, correct): with cleanCloseCount ≡ 0 < 2, a money-module FORWARD flip is
// BLOCKED-BY-CONSTRUCTION in-repo — money authority (invoicing/settlement) cannot be promoted to native until
// two real closes exist. That is the intended fail-closed posture, not a gap: the money-forward-ALLOWED path
// becomes reachable only when a real close signal is wired (a WP-15 Task-10 / close-out tenant-calendar item —
// this seam is where that signal plugs in). We do NOT fabricate a close here.
function cleanCloseCount(_module: AuthorityModule): number {
  return 0;
}

// The FRESH gate evaluation + the audit snapshot the forward flip records. Named for the guard question the route
// asks: "are the gates green FOR promoting this module?"
export interface FlipGateEvaluation {
  green: boolean;
  // the WHY, snapshotted into the flip event's gate_snapshot (integer-only JsonObject values — REQ-011). This is
  // the record a future auditor reads to see what was true at the instant authority moved.
  snapshot: Record<string, string | number | boolean>;
  // human-facing list of the gate legs that are NOT satisfied (surfaced as gate.required_evidence on a 403).
  missing: string[];
}

/**
 * gatesGreenFor — the FRESH, server-side readiness evaluation for a FORWARD (promote) flip.
 *
 * DESIGN LAW #1 (FRESH, never the stored snapshot): this re-derives readiness from LIVE signals every call — the
 * parity primitive reads the append-only `events` ledger, the clean-close count is derived (0) here. It NEVER
 * reads authority_map.gates_status as the readiness input. That stored snapshot is the audit of the LAST flip; a
 * drift fallback can leave it stale-GREEN, so trusting it would let a re-promote sail through on evidence that no
 * longer holds. Readiness is always computed from scratch (explicit prior-review requirement).
 *
 * DESIGN LAW #2 (all modules need parity green): within_gate is true ONLY when BOTH the native and legacy sides
 * are present AND drift ≤ tolerance (computeModuleParity fail-closes a missing side to within_gate:false). So a
 * module with no legacy mirror yet (every module today, before the Task-4 mirror) is correctly NOT green — a
 * forward flip is blocked until a real mirror + parity exist. We REUSE the shared primitive; parity is never
 * recomputed a second way (the share-lint-matchers discipline).
 *
 * DESIGN LAW #3 (money modules need ≥2 clean closes ON TOP): a money module additionally requires
 * cleanCloseCount ≥ 2. Since that count is 0 in-repo (see the finding above), money-forward flips are
 * blocked-by-construction until a real close signal exists.
 */
export async function gatesGreenFor(db: D1Database, module: AuthorityModule): Promise<FlipGateEvaluation> {
  // FRESH signal #1 — parity over the live ledger (the SHARED primitive; within_gate is false when a side is UNKNOWN).
  const parity = await computeModuleParity(db, module);
  const parityGreen = parity.within_gate === true;

  // FRESH signal #2 — the clean-close history (money modules only; 0 by construction in-repo).
  const isMoney = MONEY_MODULES.has(module);
  const closesRequired = isMoney ? REQUIRED_CLEAN_CLOSES : 0;
  const cleanCloses = isMoney ? cleanCloseCount(module) : 0;
  const closesGreen = cleanCloses >= closesRequired;

  const green = parityGreen && closesGreen;

  const missing: string[] = [];
  if (!parityGreen) missing.push("parity_within_gate");
  if (isMoney && !closesGreen) missing.push(`clean_closes>=${closesRequired}`);

  // The audit snapshot (integer-only JsonObject values). drift_bps is a number OR the literal "UNKNOWN" — both
  // valid JsonValue. This is the exact breakdown that gets frozen into the flip event's gate_snapshot.
  const snapshot: Record<string, string | number | boolean> = {
    module,
    parity_within_gate: parityGreen,
    parity_status: parity.status,
    drift_bps: parity.drift_bps,
    money_module: isMoney,
    clean_closes: cleanCloses,
    clean_closes_required: closesRequired,
    green,
  };

  return { green, snapshot, missing };
}

// Deterministic, STABLE event id derived from the Idempotency-Key. The idempotency middleware 400s a mutation
// missing the header, so a request that reaches this handler ALWAYS carries one (the crypto.randomUUID fallback
// at the call site is defensive-only — unreachable in practice). This route appends ONE event; a mid-flight 5xx
// is not HTTP-cached, so a retry re-runs the handler — a random id would then DUPLICATE an already-committed flip.
// Deriving the id from (idempotencyKey, module, to) makes a retry reproduce the SAME id, and the sequencer dedupes
// by id (returns the existing row, never a second append). Shaped into a v4-variant UUID so it satisfies
// EventInput.id. Mirrors rate.ts deterministicEventId.
async function flipEventId(idempotencyKey: string, module: string, to: string): Promise<string> {
  return deterministicUuid(`authority.flip:${idempotencyKey}:${module}:${to}`);
}

export function mountAuthorityRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.post("/v1/authority/:module/flip", requireRole("admin"), async (c) => {
    const session = c.get("session");

    // Validate :module ∈ the 5 overlay modules HERE — an un-projectable module is a clean 400, never reaching
    // the ledger. (AuthorityModule is the exact authority_map.module CHECK set.)
    const moduleParsed = AuthorityModule.safeParse(c.req.param("module"));
    if (!moduleParsed.success) throw new ApiError("VALIDATION_FAILED", 400, "UNKNOWN AUTHORITY MODULE");
    const module = moduleParsed.data;

    const parsed = FlipBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID FLIP REQUEST");
    const { to, reason: operatorReason } = parsed.data;

    // REQ-025 — the tenant's OWN D1, keyed off the JWT claim ONLY (never a header/query/body). resolveAuthority
    // + computeModuleParity + the sequencer all bind THIS handle, so the flip can never cross tenants.
    const db = await resolveTenantDb(c.env, session.tenant);

    // from = the CURRENT authority (fail-closed to legacy). Idempotent no-op when nothing changes — NO event.
    // CONTRACT (client branches on this): a NO-OP returns 200 { module, from, to, flipped: false } and appends
    // nothing; a REAL flip returns 201 with the appended authority.flipped event body. Status distinguishes them.
    const from: AuthorityLevel = await resolveAuthority(db, module);
    if (to === from) return c.json({ module, from, to, flipped: false });

    // Build the flip payload. The `reason` enum is SERVER-DERIVED from the direction — never client-supplied.
    let payload: Record<string, unknown>;
    if (to === "native") {
      // FORWARD (promote) — BLOCKED unless the FRESH gate is green. A not-green forward flip appends NOTHING.
      const gate = await gatesGreenFor(db, module);
      if (!gate.green) {
        throw new ApiError("GATE_BLOCKED", 403, "AUTHORITY FORWARD FLIP BLOCKED: GATE NOT GREEN", { required_evidence: gate.missing });
      }
      // Green ⇒ record the FRESH gate breakdown as the audit of WHY the promote was allowed.
      const gate_snapshot: Record<string, unknown> = { ...gate.snapshot };
      if (operatorReason !== undefined) gate_snapshot.operator_reason = operatorReason;
      payload = { module, from, to, reason: "promote", gate_snapshot };
    } else {
      // BACKWARD (fallback) — ALWAYS allowed; no gate consulted, no gate_snapshot.
      payload = { module, from, to, reason: "manual" };
    }

    // Append on t:root via the sequencer — the SAME pattern as rate.ts, but streamId='t:root', NO shipment_id,
    // source:'native', actor = the authenticated admin (the CO-SIGN: WHO flipped it, recorded permanently). The
    // Task-1 projectAuthority runs inside the sequencer batch (I1), so authority_map updates atomically with the
    // event — the route never touches authority_map itself.
    const streamId = "t:root";
    const stub = c.env.SHIPMENT_SEQ.get(c.env.SHIPMENT_SEQ.idFromName(`${session.tenant}|${streamId}`)) as unknown as SeqStub;
    const idemKey = c.req.header("Idempotency-Key");
    const id = idemKey === undefined ? crypto.randomUUID() : await flipEventId(idemKey, module, to); // fallback defensive-only (middleware requires the header)

    let event: AppendedEvent;
    try {
      event = await stub.append({
        tenant: session.tenant, // claim only — the DO re-derives its id from it and rejects a mismatch
        streamId,
        input: {
          id,
          // NO shipment_id — a t:root control event carries none (the events CHECK forbids a shipment_id on a
          // non-s: stream; the DO derives none for t:root).
          ts: Date.now(),
          // The co-sign: `user` is the authenticated admin principal (WHO decided the flip); `party` is a stable
          // control-plane sentinel (an admin has no counterparty). authority.flipped accrues no parties-FK
          // projection, so the sentinel party is safe (mirrors rate.ts's agent:rater sentinel).
          actor: { party: session.party_id ?? "system:gatekeeper", user: session.sub },
          party_refs: [],
          evidence: [],
          source: "native",
          confidence: 10_000, // a deterministic server decision — full confidence
          kind: "authority.flipped",
          payload,
        },
      });
    } catch (e) {
      throw translateAppendError(e);
    }

    return c.json(event, 201);
  });
}
