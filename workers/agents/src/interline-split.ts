// WP-11 (REQ-019 / REQ-040 / REQ-003) — THE INTERLINE-SPLIT PRODUCER. The Biller's AP sibling: the SAME
// committed terminal delivery event (pod.signed) that bills the AR invoice also settles the interline AP
// split — DERIVED FROM THE CUSTODY LEGS, never a client-supplied allocation. It loads the recorded legs,
// derives the per-carrier allocation (deriveSplitFromLegs — group by executor, apportion the pie via the
// ledger's Hamilton largest-remainder), judges the tenant's EXECUTING SHARE against the quote's floors
// (never the gross — REQ-040), and appends a `split.computed` THROUGH the sequencer DO. The existing
// split.computed → interline_split projection (packages/ledger/src/projection/money.ts) posts the penny-
// exact AP `5000-INTERLINE-AP` money_lines; this producer builds NO money_lines and rebuilds NO projection.
//
// WHY AN AGENT (not a route): split.computed is server-emitted money (REQ-030) — the public events route
// REFUSES it, so a client can never hand-craft an allocation. It must be derived SERVER-SIDE from the
// physical custody record and appended through the sequencer, exactly the Biller's discipline: a
// DETERMINISTIC event id (seeded on the POD event id) makes the append idempotent under queue redelivery,
// and the sequencer dedupes. FAIL-CLOSED: a direct move produces no split; an interline whose share cannot
// be judged (incomplete legs) HOLDS; a below-floor executing share HOLDS (the REQ-040 $222K-class guard);
// a recorded pricing anomaly HOLDS — mirroring composeInvoice so the AR and AP decisions never diverge.
//
// PURE core (decideSplit) + thin D1 consumer (handleInterlineSplit), like the Biller. LLM-free.

import type { JsonValue, SplitComputedPayload } from "@shuddl/contracts";
import { SplitComputedPayload as SplitComputedPayloadSchema } from "@shuddl/contracts";
import { deriveSplitFromLegs } from "@shuddl/ledger/money/derive-split";
import { authoritativeSource, resolveAuthority } from "@shuddl/ledger/authority";
import { evaluateApproval, executingShare } from "@shuddl/rater";
import type { Leg } from "@shuddl/rater";
import {
  PodSignedMessage,
  loadAcceptedQuote,
  loadEvent,
  resolveInterline,
  uuidFromSeed,
  type LegRow,
  type SeqStubLike,
} from "./biller.js";

// The split.computed EVENT id, seeded on the POD event id (redelivery-stable; sequencer dedupes on it).
export async function splitEventIdFor(podEventId: string): Promise<string> {
  // MEASURED (§1788) — this guarantee is DELEGATED and this package cannot observe it. Making this id
  // non-deterministic reds `workers/agents` 0 of 155 and `workers/api` 2 of 908: "interline pod.signed →
  // split.computed appended; AP lines reconcile to the gross" and "is idempotent under redelivery — the
  // second run appends no second split, no second money_lines". The dedupe is the sequencer DO's, so the
  // outcome can only be asserted where that DO exists. A green `workers/agents` is not coverage of this line.
  return uuidFromSeed(`interline-split:split-event:${podEventId}`);
}

// ---- the pure decision core (mirrors the Biller's composeInvoice guards) ---------------------------------
export interface SplitDecisionInput {
  /** The committed POD that triggered the split — named in every hold detail so a review queue can find it. */
  pod: { event_id: string; shipment_id: string };
  /** The RECORDED accepted quote's sell = the interline GROSS being split (REQ-003). */
  grossSellCents: number;
  /** The RECORDED quote floors — the executing share (never gross) is judged against these (REQ-040). */
  floors: { contribution: number; full: number; target: number };
  /** The recorded pricing-time anomaly flag (acceptedQuote.basis.anomaly); present ⇒ HOLD, hard (REQ-040). */
  anomaly: JsonValue | undefined;
  /** The resolved interline legs (rater Leg: kind/executor/split_bps), split_bps totalling 10000. */
  legs: readonly Leg[];
  /** The tenant's executing party (the POD signer) whose share is judged against the floors. */
  tenantParty: string;
  /** The strength of a named below-floor approval granted (approval.decided); unwired today → always holds below floor. */
  approvalGranted?: "single" | "dual";
}

export type SplitDecision =
  | { status: "append"; payload: SplitComputedPayload }
  | { status: "hold"; reason: "anomaly" | "below_floor"; detail: string };

const GRANT_STRENGTH: Record<"single" | "dual", 1 | 2> = { single: 1, dual: 2 };

/**
 * decideSplit — the recorded gross + floors + resolved legs → a derived split.computed payload, or a HOLD.
 * Mirrors composeInvoice so the AR invoice and the AP split can never disagree on a shipment:
 *   1. ANOMALY ⇒ HOLD (hard, no override — REQ-040 permanent). Fail-closed: only absent/null is "sane".
 *   2. INTERLINE BELOW-FLOOR ⇒ HOLD unless a matching-strength approval was granted. The tenant's
 *      EXECUTING SHARE (executingShare — the one source of truth for the slice, which also validates the
 *      leg split totals 10000 bps) is judged against the floors, NEVER the gross (REQ-040 / Law 5).
 *   3. Otherwise ⇒ APPEND: derive the allocation from the custody legs and validate it through the
 *      SplitComputedPayload schema (fail loud) — the derived bps sum to exactly 10000, the projection
 *      apportions the gross penny-exact.
 * PURE — no Date, no random, no I/O.
 */
export function decideSplit(input: SplitDecisionInput): SplitDecision {
  const { pod, grossSellCents, floors, anomaly, legs, tenantParty, approvalGranted } = input;

  // 1. Anomaly ⇒ HOLD, fail-closed (only absent/null is "no flag"; any recorded value holds).
  if (anomaly !== undefined && anomaly !== null) {
    return {
      status: "hold",
      reason: "anomaly",
      detail: `shipment ${pod.shipment_id} (pod ${pod.event_id}): recorded pricing-time anomaly — interline split held (REQ-040)`,
    };
  }

  // 2. Judge the tenant's EXECUTING SHARE against the floors — never the gross (REQ-040). executingShare
  //    validates the leg split_bps total exactly 10000 (the anti-$222K guard); evaluateApproval is REQ-048.
  const share = executingShare(grossSellCents, legs, tenantParty);
  const decision = evaluateApproval(share.shareCents, floors);
  const grantedStrength = approvalGranted === undefined ? 0 : GRANT_STRENGTH[approvalGranted];
  if (decision.approvals_required > grantedStrength) {
    return {
      status: "hold",
      reason: "below_floor",
      detail:
        `shipment ${pod.shipment_id} (pod ${pod.event_id}): executing share ${share.shareCents}¢ ` +
        `(${share.tenantBps} bps of ${grossSellCents}¢ gross) is below floor (rule ${decision.rule}, ` +
        `requires ${decision.approval} approval — ${decision.approvals_required} required, ${grantedStrength} granted) (REQ-040/048)`,
    };
  }

  // 3. Derive the split from the custody legs and validate it (Σ share_bps === 10000; total_cents ≥ 0).
  const derived = deriveSplitFromLegs(
    legs.map((l) => ({ executor_party_id: l.executor, split_bps: l.split_bps, kind: l.kind })),
    grossSellCents,
  );
  const payload = SplitComputedPayloadSchema.parse(derived);
  return { status: "append", payload };
}

// ---- the D1 consumer (loads records, appends through the sequencer) --------------------------------------
export interface InterlineSplitDeps {
  /** The message tenant's OWN D1 (the caller resolves it via the tenant allowlist — REQ-025). */
  db: D1Database;
  seq: SeqStubLike;
}

export type InterlineSplitOutcome =
  | { status: "appended"; split_event_id: string; total_cents: number; parties: number }
  | { status: "skipped"; reason: "pod_not_found" | "direct" | "no_quote" | "unresolved" | "already_split"; detail: string }
  | { status: "held"; reason: "anomaly" | "below_floor"; detail: string };

/**
 * handleInterlineSplit — a committed pod.signed → the interline AP split, derived from the custody legs.
 * Idempotent under queue redelivery: the split event id is deterministic and the sequencer dedupes; a
 * redelivered message whose split already committed takes the short-circuit (already_split). FAIL-CLOSED
 * at every ambiguity (see the module header). The append rides the SAME sequencer DO as the Biller, so the
 * money projection runs atomically with the event insert (I1).
 */
export async function handleInterlineSplit(message: PodSignedMessage, deps: InterlineSplitDeps): Promise<InterlineSplitOutcome> {
  const msg = PodSignedMessage.parse(message); // Zod at the boundary even when the caller pre-parsed
  const { db, seq } = deps;
  const streamId = `s:${msg.shipment_id}`;

  // WP-15 REQ-030/L8 — consult the shared authority read-seam for the SETTLEMENT module before deriving the
  // authoritative native interline split below. `legacyValueAvailable` is false today (no legacy settlement
  // mirror exists — Task 4), so authoritativeSource ALWAYS resolves to "native" and this producer derives the
  // native AP split exactly as before — behavior-identical. The dormant branch is where Tasks 4/6/8 defer to
  // the incumbent's settlement; it is UNREACHABLE while legacyValueAvailable is false (native always wins).
  const settlementAuthority = authoritativeSource(await resolveAuthority(db, "settlement"), false);
  if (settlementAuthority === "legacy") {
    // DORMANT until a legacy settlement mirror exists (Task 4). Unreachable today (native always wins).
    console.error(`interline-split: settlement authority is 'legacy' for shipment ${msg.shipment_id} but no mirror is wired (WP-15 Task 4) — proceeding native`);
  }

  // GUARD — the trigger POD must exist on this stream. A message referencing a nonexistent/foreign POD is
  // poison: redelivery cannot conjure it (the Biller's own backstop mirrors this).
  const pod = await loadEvent(db, streamId, msg.event_id, "pod.signed");
  if (pod === null || pod.kind !== "pod.signed") {
    return { status: "skipped", reason: "pod_not_found", detail: `pod.signed ${msg.event_id} not on ${streamId} — poison message` };
  }

  // IDEMPOTENCY short-circuit — if the deterministically-ided split already committed, we are done. (The
  // sequencer would dedupe a re-append anyway; this saves the loads + derivation on redelivery.)
  const splitEventId = await splitEventIdFor(pod.id);
  const existing = await loadEvent(db, streamId, splitEventId, "split.computed");
  if (existing !== null) {
    return { status: "skipped", reason: "already_split", detail: `split ${splitEventId} already committed on ${streamId}` };
  }

  // Classify by the DATA, never the label (REQ-040 fail-closed — same resolveInterline the Biller uses).
  const legRows = await db
    .prepare("SELECT kind, executor_party_id, split_bps FROM legs WHERE shipment_id = ? ORDER BY seq")
    .bind(msg.shipment_id)
    .all<LegRow>();
  const interline = resolveInterline(legRows.results, pod.actor.party);
  if (interline.kind === "direct") {
    return { status: "skipped", reason: "direct", detail: `shipment ${msg.shipment_id} is a single-carrier direct move — no interline split` };
  }
  if (interline.kind === "unresolved") {
    return { status: "skipped", reason: "unresolved", detail: `shipment ${msg.shipment_id}: ${interline.detail} (REQ-040 fail-closed)` };
  }

  // The RECORDED accepted quote is the gross + floors source (REQ-003). No quote ⇒ nothing to split.
  const quoteEvent = await loadAcceptedQuote(db, streamId, pod.seq);
  if (quoteEvent === null || quoteEvent.kind !== "quote.priced") {
    return { status: "skipped", reason: "no_quote", detail: `no quote.priced precedes pod ${msg.event_id} on ${streamId} — no gross to split` };
  }
  const quote = quoteEvent.payload;

  // Decide: anomaly / below-floor HOLD (no append); else derive + append (approvalGranted intentionally
  // unwired, matching the Biller — a below-floor interline share always holds until the approvals queue lands).
  const decision = decideSplit({
    pod: { event_id: pod.id, shipment_id: msg.shipment_id },
    grossSellCents: quote.sell,
    floors: quote.floors,
    anomaly: quote.basis["anomaly"],
    legs: interline.legs,
    tenantParty: interline.tenantParty,
  });
  if (decision.status === "hold") {
    return { status: "held", reason: decision.reason, detail: decision.detail };
  }

  // Append THROUGH the sequencer DO — the split.computed → interline_split projection runs there,
  // atomically with the event insert (I1). ts is the POD commit instant this AP money projects from
  // (deterministic, no clock read); the actor is a server-controlled sentinel (mirrors the Biller/Rater).
  const appended = await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      id: splitEventId,
      shipment_id: msg.shipment_id,
      ts: pod.recorded_at,
      actor: { party: "agent:interline-split" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "split.computed",
      payload: decision.payload,
    },
  });

  return { status: "appended", split_event_id: appended.id, total_cents: decision.payload.total_cents, parties: decision.payload.allocations.length };
}
