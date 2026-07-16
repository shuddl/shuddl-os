import { DurableObject } from "cloudflare:workers";
import { EventInput, LedgerEvent, type Visibility } from "@shuddl/contracts";
import { GENESIS_HASH, hashEvent } from "@shuddl/ledger/chain";
import { verifyEventSig } from "@shuddl/ledger/sign";
import { resolveVisibility } from "@shuddl/ledger/visibility";
import { eventToRow, rowToEvent } from "@shuddl/ledger/lens";
import {
  applyMoneyProjection,
  mapMoneyProjectionError,
  type MoneyProjectionDeps,
  type OriginalLine,
} from "@shuddl/ledger/projection/money";
import { projectPassport } from "@shuddl/ledger/projection/passports";
import { projectStatusCache } from "@shuddl/ledger/projection/status-cache";
import { applyMessageProjection } from "@shuddl/ledger/projection/messages";
import { projectAppointment } from "@shuddl/ledger/projection/appointment";
import { assertPodSigned } from "@shuddl/ledger/gates/invoice-gate";
import {
  assertPickupDepart,
  assertDelivery,
  assertInterline,
  assertException,
  assertConsentBeforeGps,
  assertAppointment,
  assertBookingCredit,
  assertBookingRecipientContact,
  assertDispatch,
  DISPATCH_REQUIRED_DOC_KIND,
  type AppointmentCtx,
  type DispatchCtx,
  type Fence,
  type GateCtx,
} from "@shuddl/ledger/gates/transition-gates";
import { deriveOperatingState } from "@shuddl/ledger/geo/jurisdiction";
import { loadFacility } from "../facilities.js";
import { localWall, localServiceDate } from "../appointment-window.js";
import { tenantDb } from "../tenants.js";
import type { Env } from "../index.js";

// doc 14 §06 — one Durable Object per (tenant|stream) IS the sequencer. It assigns `seq`/`prev_hash`,
// verifies the device signature, enforces the invoice gate (I2), resolves visibility server-side, and
// writes the event + EVERY projection in a single db.batch() so I1 holds both directions (no money line
// without an event; no money event half-applied). REQ-002 / REQ-011 / REQ-025 / I1 / I2 / I3.
//
// Errors must survive the Workers RPC hop, which preserves only Error `name`/`message`. So every refusal
// is thrown as `Error("CODE:json")` (e.g. `FORBIDDEN:{}`, `UNAUTHORIZED:{}`, `VALIDATION_FAILED:{}`,
// and GateError's own `GATE_BLOCKED:{"required_evidence":[...]}`). Task 14 maps these back to ApiError.
// This DO NEVER throws ApiError.

type AppendReq = { tenant: string; streamId: string; input: unknown };

// The RPC return shape. Deliberately NOT `LedgerEvent`: that union's `payload: JsonObject` is a
// recursive (z.lazy) type, and Workers-RPC's structural type mapper recurses into every return type,
// exploding into a TS2589 "excessively deep" instantiation at every `stub.append()` call site. This
// hand-written envelope keeps `payload` shallow (`Record<string, unknown>`) so the RPC surface stays
// finite. It is a structural superset of a stored LedgerEvent, so the DO returns the full event unchanged.
export interface AppendedEvent {
  id: string;
  stream_id: string;
  seq: number;
  shipment_id?: string | undefined;
  ts: number;
  recorded_at: number;
  kind: string;
  actor: { party: string; user?: string | undefined; device?: string | undefined };
  party_refs: string[];
  evidence: { doc_id: string; hash: string }[];
  prev_hash: string;
  hash?: string | undefined;
  sig?: string | undefined;
  visibility: Visibility;
  source: string;
  confidence: number;
  device_id?: string | undefined;
  device_seq?: number | undefined;
  captured_ts?: number | undefined;
  override?: { by: string; reason: string } | undefined; // REQ-049 — recorded when a gate was overridden
  payload: Record<string, unknown>;
}

// The tenant policy JSON (control plane `tenants.policy`): visibility overrides + gate config. The
// `gates` block carries the invoice-gate exception (invoice_without_pod_classes) AND the Task-5
// transition-gate knobs: whether a lane is dims-fitted, and the delivery geofence radius.
type TenantPolicy = {
  gates?: {
    invoice_without_pod_classes?: string[];
    dims_required?: boolean;
    geofence_radius_m?: number;
  };
  visibility?: Record<string, Visibility>;
};
type DeviceKeyEntry = { device_id: string; public_jwk: JsonWebKey };

// What #enforceTransitionGate hands back to #append. For appointment.set the gate has already computed the
// canonical LOCAL service date (facility tz) — the OCCURRENCE key — so it is passed forward to the
// appointment projection UNCHANGED (the projection stays a pure fn of its inputs; the impure tz math lives
// once, in the gate caller). Every other kind returns {} (no extra projection input).
type GateResult = { appointmentServiceDate?: string };

// A sane default delivery-fence radius (metres) when the tenant policy sets none. Real per-stop
// fences are provisioned by booking (WP-08); this only bounds the radius the gate compares against.
const DEFAULT_FENCE_RADIUS_M = 150;

// The transition kinds the Gatekeeper gates (REQ-044/045/046/049/050/166) evaluate BEFORE append.
// ONE source of truth: this const drives BOTH the membership check (GATED_KIND_SET) AND the GatedKind
// union the dispatch switch must be exhaustive over — so a kind added here without a matching switch
// case is a COMPILE error (assertNever), never a silent ungated append. position.updated is absent BY
// DESIGN — it never reaches this DO (rejected upstream, owned by the positions bypass route, which
// must enforce the same consent gate).
const GATED_KINDS = [
  "stop.departed", "delivery.evidenced", "custody.transferred", "exception.raised", "osd.captured", "stop.arrived",
  "appointment.set", "booking.created", "dispatch.assigned",
] as const;
type GatedKind = (typeof GATED_KINDS)[number];
const GATED_KIND_SET: ReadonlySet<string> = new Set(GATED_KINDS);
function isGatedKind(kind: string): kind is GatedKind {
  return GATED_KIND_SET.has(kind);
}

// Exhaustiveness guard for the gate-dispatch switch. A `never` argument means every GatedKind was
// handled; if GATED_KINDS gains a kind without a switch case, the call stops COMPILING (the argument
// is no longer `never`). It also throws at RUNTIME as belt-and-suspenders, so a Set/switch desync can
// never fall through to an ungated append. Exported so the fail-loud behavior is unit-tested.
export function assertNever(x: never): never {
  throw new Error(`unreachable gate dispatch for kind ${String(x)}`);
}

// REQ-095 / REQ-026 — which committed events fan a Concierge trigger onto the agent queue, and the trigger
// body. Exported + PURE so the enqueue DECISION is unit-testable: the DO's `env.AGENT_QUEUE` is cross-isolate,
// so the queue push itself cannot be observed from a test, but this predicate (the single source of truth the
// DO calls) can. Only a COUNTERPARTY-visible inbound is one the Concierge should act on: an INTERNAL
// message.received is an agent OPS NOTE (e.g. the SLA-overdue note the Task-8 sweep records) — re-triggering
// the Concierge on it burns a wasted parse and, with a NotConfigured parser, throws retriable → a DLQ
// retry-storm. So an internal note NEVER enqueues (the visibility IS the redaction signal — the cleanest gate).
export type ConciergeTrigger =
  | { kind: "message.received"; tenant: string; event_id: string }
  | { kind: "message.received"; tenant: string; shipment_id: string; event_id: string };

export function conciergeTriggerFor(
  e: { kind: string; visibility: Visibility; shipment_id?: string | undefined; id: string },
  tenant: string,
): ConciergeTrigger | null {
  if (e.kind !== "message.received" || e.visibility === "internal") return null;
  return e.shipment_id === undefined
    ? { kind: "message.received", tenant, event_id: e.id }
    : { kind: "message.received", tenant, shipment_id: e.shipment_id, event_id: e.id };
}

const EVENT_COLUMNS = [
  "stream_id", "seq", "id", "shipment_id", "ts", "recorded_at", "kind",
  "actor_party_id", "actor_user_id", "actor_device_id", "party_refs", "payload",
  "evidence", "prev_hash", "hash", "sig", "visibility", "source", "confidence",
  "device_id", "device_seq", "captured_ts", "override_json",
] as const;
const EVENT_INSERT_SQL = `INSERT INTO events (${EVENT_COLUMNS.join(",")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(",")})`;

function insertEventStmt(db: D1Database, e: LedgerEvent): D1PreparedStatement {
  const row = eventToRow(e);
  return db.prepare(EVENT_INSERT_SQL).bind(...EVENT_COLUMNS.map((c) => row[c] ?? null));
}

// A refusal whose message is `CODE:json` — the only shape that crosses the RPC boundary intact.
function rpcError(code: "FORBIDDEN" | "UNAUTHORIZED" | "VALIDATION_FAILED", detail: Record<string, unknown> = {}): Error {
  return new Error(`${code}:${JSON.stringify(detail)}`);
}

// MUST stay byte-identical to LedgerEvent's `stream_id` regex (contracts/events.ts). The DO checks it up
// front so a malformed streamId is a clean VALIDATION_FAILED, not a raw ZodError leaked through the parse.
const STREAM_ID_RE = /^(s:[\w-]+|q:[\w-]+|t:root)$/;

export class ShipmentSequencer extends DurableObject<Env> {
  // Caches — D1 is truth. `tail`/`pin` are TS-private (runtime-public) so the crash-heal test can null them.
  private tail: { seq: number; hash: string } | null = null;
  private pin: { tenant: string; streamId: string } | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private policyCache: TenantPolicy | null = null;
  private deviceKeys = new Map<string, JsonWebKey | null>();

  /**
   * The mutex — MEASURED load-bearing, not speculative. A Cloudflare DO input gate closes only during the
   * DO's OWN `ctx.storage` operations (and `blockConcurrencyWhile`); it does NOT close across a plain D1
   * subrequest await. This sequencer reads its tail and writes its batch via D1, so without serialization
   * concurrent appends read the same tail and assign the same `seq`. Verified by deleting this mutex and
   * running the 100-concurrent fresh-stub test: it goes red with `D1_ERROR: I3: append-only:
   * SQLITE_CONSTRAINT` (the duplicate (stream_id, seq) rows collide on events_guard_ins). So: chain every
   * append onto the previous one's settlement; `.catch(() => undefined)` keeps one failure from poisoning
   * the chain (the returned promise still rejects — see the RPC normalization below).
   */
  append(req: AppendReq): Promise<AppendedEvent> {
    const run = this.lock.then(() => this.#append(req));
    this.lock = run.catch(() => undefined);
    // Normalize refusals for the RPC hop. Workers RPC preserves only `name`/`message`, and for a
    // NON-"Error" subclass it prepends the class name to the message — so `GateError` would arrive as
    // "GateError: GATE_BLOCKED:{...}" and break the `CODE:json` split Task 14 relies on. A plain Error
    // arrives with its message verbatim (verified), so re-wrap any subclass into one. The mutex chains
    // on the RAW `run`, not this normalized view.
    return run.catch((e: unknown) => {
      if (e instanceof Error && e.name !== "Error") throw new Error(e.message);
      throw e;
    });
  }

  async #append({ tenant, streamId, input }: AppendReq): Promise<AppendedEvent> {
    // REQ-025 — structural tenant pinning. The caller-declared identity must re-derive to OUR OWN id.
    // A forged tenant produces a DIFFERENT DurableObjectId, so this instance can never be bound to
    // another tenant's D1. The route derives the id from the JWT `tenant` claim only.
    const expected = this.env.SHIPMENT_SEQ.idFromName(`${tenant}|${streamId}`);
    if (!expected.equals(this.ctx.id)) throw rpcError("FORBIDDEN", { reason: "sequencer identity mismatch" });

    // REQ-133 — validate the streamId FORMAT before any work (D1, control plane, or storage). EventInput
    // never sees `stream_id`, so a shipment id with an apostrophe/space (`s:o'brien`) survives input
    // validation and would otherwise fail LedgerEvent's regex deep in the batch-build parse, throwing a
    // RAW ZodError (a JSON issues array) that breaks this DO's `CODE:json` contract and leaks Zod detail
    // across the RPC hop. Reject it here; the LedgerEvent.parse below stays as the now-unreachable backstop.
    if (!STREAM_ID_RE.test(streamId)) throw rpcError("VALIDATION_FAILED", { reason: "malformed stream id" });

    // Pin (tenant, stream) on first success. This is a REDUNDANT second layer, NOT the primary guard:
    // id-equality above already rejects any (tenant|streamId) that doesn't hash to THIS instance's id, so
    // any change to either input lands on a different DO and a pin mismatch is effectively unreachable.
    // Kept as belt-and-suspenders + self-documentation of what this instance is bound to.
    const pinned = this.pin ?? (await this.ctx.storage.get<{ tenant: string; streamId: string }>("pin")) ?? null;
    if (pinned && (pinned.tenant !== tenant || pinned.streamId !== streamId)) {
      throw rpcError("FORBIDDEN", { reason: "pin mismatch" });
    }
    if (!pinned) {
      this.pin = { tenant, streamId };
      await this.ctx.storage.put("pin", this.pin);
    }

    const db = tenantDb(this.env, tenant);

    // The request body is the client-suppliable subset — never LedgerEvent (which would let a client
    // supply seq/prev_hash/hash). A parse failure is VALIDATION_FAILED, not a raw ZodError.
    let parsed: EventInput;
    try {
      parsed = EventInput.parse(input);
    } catch {
      throw rpcError("VALIDATION_FAILED", { reason: "event input schema" });
    }
    // positions bypass the sequencer entirely (Task 14 owns POST /v1/positions -> partitioned stream).
    if (parsed.kind === "position.updated") throw rpcError("VALIDATION_FAILED", { reason: "position.updated bypasses the sequencer" });

    // Idempotency — replay by event id returns the original row (no second append).
    const byId = await db.prepare("SELECT * FROM events WHERE id = ?").bind(parsed.id).first<Record<string, string | number | null>>();
    if (byId) return rowToEvent(byId);

    // WP-05 exit audit (REQ-016) — a device-namespaced event (carrying `device_id`, the offline dedupe
    // key) MUST be co-signed BY that device before it can claim a (device_id, device_seq) slot: its
    // `device_id` must equal `actor.device` AND its signature must VERIFY. Otherwise an unsigned event,
    // or one device signing under a victim's device_id, could squat the victim's slot and silently drop
    // the victim's real signed capture (first-wins). This is the server belt to the EventInput refine
    // (which already rejects device_id≠actor.device / a missing sig) — presence is not enough, the sig
    // must actually verify, and the check MUST precede the dedup below.
    if (parsed.device_id !== undefined) {
      if (parsed.actor.device !== parsed.device_id) {
        throw rpcError("VALIDATION_FAILED", { reason: "device_id must equal actor.device" });
      }
      const jwk = await this.#deviceKey(tenant, parsed.device_id);
      if (!jwk || !(await verifyEventSig(parsed, jwk))) throw rpcError("UNAUTHORIZED", { reason: "device signature" });

      // Idempotency — replay by the offline dedupe key (stream_id, device_id, device_seq). Reached only
      // after the device binding above, so the slot cannot be occupied by an unsigned/foreign event.
      const byDevice = await db
        .prepare("SELECT * FROM events WHERE stream_id = ? AND device_id = ? AND device_seq = ?")
        .bind(streamId, parsed.device_id, parsed.device_seq ?? -1)
        .first<Record<string, string | number | null>>();
      if (byDevice) return rowToEvent(byDevice);
    } else if (parsed.actor.device !== undefined) {
      // A co-signed event that is NOT device-namespaced (actor.device present, no offline device_id):
      // still verify the device signature (REQ-011/016). verifyEventSig returns false, never throws.
      const jwk = await this.#deviceKey(tenant, parsed.actor.device);
      if (!jwk || !(await verifyEventSig(parsed, jwk))) throw rpcError("UNAUTHORIZED", { reason: "device signature" });
    }

    const policy = await this.#policy(tenant);
    // I2 (REQ-030) — no invoice without a signed POD on this stream. Gate BEFORE the append.
    // TODO(REQ-030): the `serviceClass` exemption (policy.gates.invoice_without_pod_classes) is UNWIRED.
    // The invoice.issued payload carries no service class, and the shipment's service class is not threaded
    // here, so assertPodSigned's 4th arg is intentionally omitted and the exemption is INERT — the gate
    // always enforces (fail-safe: a POD is always required; a tenant configuring the exemption gets no
    // effect, never an accidental bypass). Wire serviceClass from shipments.service once the invoice write
    // path models it; enabling a POD-gate bypass needs its own test before it ships (register note).
    if (parsed.kind === "invoice.issued") await assertPodSigned(db, streamId, policy);

    // D1 is truth: load the tail once per wake, from D1. The in-memory cache is bumped only AFTER the
    // batch commits, so a crash between insert and bump self-heals from D1 on the next wake.
    if (!this.tail) {
      const row = await db
        .prepare("SELECT seq, hash FROM events WHERE stream_id = ? ORDER BY seq DESC LIMIT 1")
        .bind(streamId)
        .first<{ seq: number; hash: string }>();
      this.tail = row ? { seq: row.seq, hash: row.hash } : { seq: -1, hash: GENESIS_HASH };
    }

    // invoice.corrected inherits the corrected event's visibility (so I7 netting stays in one lens).
    const correctedVis =
      parsed.kind === "invoice.corrected" ? await this.#visibilityOf(db, parsed.payload.corrects_event_id) : undefined;

    // requested_visibility is INPUT-ONLY: it has no DB column, so if it entered the hashed envelope
    // rowToEvent could never reproduce the hash and every read-back would fail chain verification.
    // Destructure it out and build the event from the remaining client fields.
    const { requested_visibility, ...clientFields } = parsed;
    const visibility = resolveVisibility(parsed.kind, policy.visibility, requested_visibility, correctedVis);

    // LedgerEvent.parse validates the assembled STORAGE shape (and, being .strict(), is a backstop
    // against any stray key entering the hash-view). hash is computed next, never client-supplied.
    const event = LedgerEvent.parse({
      ...clientFields,
      stream_id: streamId,
      seq: this.tail.seq + 1,
      prev_hash: this.tail.hash,
      recorded_at: Date.now(),
      visibility,
    });

    // REQ-030/007 — Gatekeeper transition gates, enforced SERVER-SIDE here BEFORE the append, so no API
    // path (and no UI) can bypass a required-evidence check. The gate CONTEXT (fence, isInterline,
    // operating_state, dimsRequired) is sourced from tenant config / the legs / a server-side derivation
    // — NEVER from the client event (a driver cannot spoof "the fence is here" or "this isn't
    // interline"). A named override (REQ-049) travels on `event.override`, is honored by the gate, and
    // is persisted (override_json) so it is permanently visible. A block throws here → nothing is
    // written (append-on-block is impossible).
    const gateResult = await this.#enforceTransitionGate(db, streamId, event, policy);

    const hash = await hashEvent(event);
    const full = { ...event, hash } as LedgerEvent;

    // ONE batch — event + money lines + passport counters + status_cache + messages read-model. A
    // projection failure (e.g. a missing parties FK, or a second correction of the same event) aborts
    // the WHOLE append atomically. The messages projection (REQ-100) mirrors the money one: a committed
    // message.* event projects its `messages` row in this SAME batch, so no communication exists outside
    // the ledger (INSERT OR IGNORE on a deterministic id keeps re-projection idempotent).
    const deps = await this.#moneyDeps(db, full);
    const stmts = [
      insertEventStmt(db, full),
      ...applyMoneyProjection(db, full, deps),
      ...projectPassport(db, full),
      ...projectStatusCache(db, full),
      ...projectAppointment(db, full, gateResult.appointmentServiceDate),
      ...applyMessageProjection(db, full),
    ];
    try {
      await db.batch(stmts);
    } catch (err) {
      // REQ-028/052 — the ATOMIC double-book backstop. A concurrent appointment.set whose claim collides on
      // ux_legs_slot aborts the WHOLE batch (D1 single-writer), so the loser's event never commits. Map it to
      // the SAME 400/slot_taken the sequential gate returns — the simultaneous and raced-late losers are
      // indistinguishable to the client. This holds even if the friendly capacity gate were deleted (the index
      // is the sole arbiter). Checked BEFORE the money mapper — the two constraints never share a message.
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed/i.test(msg) && /ux_legs_slot|legs\.(facility_id|appt_slot_key|appt_service_date)/i.test(msg)) {
        throw rpcError("VALIDATION_FAILED", { reason: "slot_taken" });
      }
      const mapped = mapMoneyProjectionError(err);
      if (mapped) throw rpcError("VALIDATION_FAILED", { reason: mapped.message });
      throw err; // an unmapped DB fault surfaces as INTERNAL via Task 14's default mapping
    }

    this.tail = { seq: full.seq, hash }; // bump AFTER commit — crash self-heals from the D1 tail

    // WP-06 (REQ-031/039): a COMMITTED pod.signed triggers the Biller. The send is INITIATED strictly
    // AFTER the batch commits — never before (an enqueue-then-abort would bill a POD that was never
    // recorded) — but rides ctx.waitUntil, NOT the response path: a slow Queue push must extend
    // neither the per-stream mutex hold nor the driver's POD ack (the <5s budget is for the invoice,
    // not for plumbing). Delivery past the commit is best-effort by design: a failure (or a crash in
    // the commit→enqueue window) is LOGGED, never thrown — the POD is committed truth, and the lost
    // trigger is recovered by the REQ-169 reconciliation sweep (the agents cron re-enqueues streams
    // with a committed pod.signed and no invoice/hold; the Biller's appends + sends are idempotent, so
    // re-driving is safe). The message shape is the consumer's Zod boundary
    // (workers/agents/src/biller.ts PodSignedMessage).
    if (full.kind === "pod.signed") {
      if (full.shipment_id === undefined) {
        // LOUD: a pod.signed with no shipment_id can never be billed by the trigger OR the sweep —
        // this must page a human, not vanish as a silent skip (REQ-031).
        console.error(`biller trigger NOT enqueued: pod.signed ${full.id} on ${streamId} carries no shipment_id — nothing will bill this POD (REQ-031/169)`);
      } else {
        const trigger = { kind: "pod.signed", tenant, shipment_id: full.shipment_id, event_id: full.id };
        this.ctx.waitUntil(
          this.env.AGENT_QUEUE.send(trigger).catch((err: unknown) => {
            console.error(`biller trigger enqueue failed for pod ${full.id} (POD committed; the REQ-169 sweep recovers it):`, err);
          }),
        );
      }
    }

    // WP-07 (REQ-026/093/100): a COMMITTED message.received triggers the Concierge — the Biller's sibling.
    // Same discipline as the Biller trigger above: enqueue STRICTLY AFTER the batch commits (never before),
    // on ctx.waitUntil (off the mutex + the caller's ack), best-effort (a failed push is LOGGED, never
    // thrown — the message is committed truth; a lost trigger is a reconciliation-sweep concern, WP-11). A
    // fresh quote email has NO shipment yet (the Concierge CREATES one), so `shipment_id` rides only when the
    // committed event already carries one (an inbound already bound to a shipment stream); the consumer
    // otherwise locates the event by its id. The shape is the consumer's Zod boundary
    // (workers/agents/src/concierge.ts MessageReceivedTrigger).
    // conciergeTriggerFor gates this: a counterparty inbound enqueues; an INTERNAL note (the Task-8
    // SLA-overdue signal) returns null and NEVER enqueues — it is not an inbound the Concierge acts on
    // (re-triggering would burn a wasted parse / DLQ retry-storm). REQ-095.
    const conciergeTrigger = conciergeTriggerFor(full, tenant);
    if (conciergeTrigger) {
      this.ctx.waitUntil(
        this.env.AGENT_QUEUE.send(conciergeTrigger).catch((err: unknown) => {
          console.error(`concierge trigger enqueue failed for message ${full.id} (message committed; the sweep recovers it):`, err);
        }),
      );
    }
    return full;
  }

  // ---- Gatekeeper transition gates (REQ-044/045/046/049/050/166) --------------------------------
  // Calls the matching PURE gate with SERVER-SOURCED context BEFORE the append. A block throws
  // GateError (→ GATE_BLOCKED:{required_evidence}) or GateValidationError (→ VALIDATION_FAILED:{reason});
  // either aborts the append before any write, so an evidence-short transition can NEVER be appended
  // via any API path (REQ-030). `event.override` (REQ-049), when accountable, releases the gate and is
  // persisted on the event (override_json). The prior stream is loaded LAZILY and at most once, so only
  // the gates that inspect prior events pay for the read — the exception gate reads only `incoming`.
  async #enforceTransitionGate(db: D1Database, streamId: string, incoming: LedgerEvent, policy: TenantPolicy): Promise<GateResult> {
    if (!isGatedKind(incoming.kind)) return {};

    const shipmentId = streamId.startsWith("s:") ? streamId.slice(2) : undefined;
    // The shared override, honored by every gate below. Built as an EXACT-optional ctx: `override` is
    // set only when present (exactOptionalPropertyTypes forbids an explicit `override: undefined`).
    const ctx: GateCtx = {};
    if (incoming.override !== undefined) ctx.override = incoming.override;

    let priorCache: readonly LedgerEvent[] | null = null;
    const prior = async (): Promise<readonly LedgerEvent[]> => {
      if (priorCache === null) {
        const rows = await db
          .prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq")
          .bind(streamId)
          .all<Record<string, string | number | null>>();
        priorCache = rows.results.map((r) => rowToEvent(r));
      }
      return priorCache;
    };

    switch (incoming.kind) {
      case "stop.departed":
        // REQ-044 pickup depart. This gate only BITES the first (pickup) depart: at any later depart
        // the count/photo/custody are already on the stream, so the same call passes. `dimsRequired`
        // comes from tenant policy (default false = the lane is not dims-fitted).
        assertPickupDepart(await prior(), incoming, { ...ctx, dimsRequired: policy.gates?.dims_required === true });
        return {};
      case "delivery.evidenced": {
        // REQ-046. fence sourced from the delivery leg's dest geo + a policy radius (server-side). When
        // no fence is provisioned it is OMITTED (not passed as undefined); the gate reads ctx.fence as
        // absent and fails loud (GateValidationError → 400), exactly as if it were undefined.
        const fence = await this.#deliveryFence(db, shipmentId, policy);
        assertDelivery(await prior(), incoming, fence !== undefined ? { ...ctx, fence } : ctx);
        return {};
      }
      case "custody.transferred": {
        // REQ-045. isInterline sourced from the shipment legs (server-side), never the client event.
        const isInterline = await this.#isInterline(db, shipmentId);
        assertInterline(await prior(), incoming, isInterline, ctx);
        return {};
      }
      case "exception.raised":
      case "osd.captured":
        assertException(incoming, ctx); // REQ-050 — photo + reason_code, read from `incoming` only (no prior load)
        return {};
      case "stop.arrived":
        // REQ-166 consent-before-GPS. The operating state is DERIVED SERVER-SIDE from the stamp's raw
        // coordinates (deriveOperatingState) — the client supplies geo, the server decides the state, so
        // the state is not a client-supplied CLAIM. But server-derived ≠ authoritative: the coarse box
        // lookup is a documented stub (a precise point-in-polygon reverse-geocode is the WP-08
        // refinement), and legal sufficiency of any consent is [CONFIRM]/counsel. This gate takes NO
        // override — consent is a legal precondition, not a waivable evidence requirement.
        assertConsentBeforeGps(await prior(), incoming, { operating_state: deriveOperatingState(incoming.payload.geo) });
        return {};
      case "appointment.set":
        // REQ-028/052 — the dock-slot claim gate. All context is SERVER-SOURCED here (facility capacity from
        // this tenant's D1, the window's LOCAL wall clock from the facility tz, leg existence + occupancy from
        // the legs read-model) — never from the client event. Returns the computed service_date so #append can
        // hand the SAME value to the appointment projection (one impure tz derivation, reused by gate + write).
        return { appointmentServiceDate: await this.#enforceAppointment(db, shipmentId, incoming, ctx, prior) };
      case "booking.created":
        // REQ-042/182 — the booking gates. booking.created is the FIRST event on a fresh direct-booking
        // stream (prior may be []), so context is SERVER-SOURCED from the PARTIES read-model — BOTH the
        // bill_to's credit_status AND the bill_to's contacts (the bill_to is the party the Biller emails, so
        // it is the party gated) — NEVER from prior events. Both reads go through THIS tenant's db
        // (tenant-isolated), never the client event.
        await this.#enforceBooking(db, incoming, ctx);
        return {};
      case "dispatch.assigned":
        // REQ-043 — the DISPATCH gate. You don't send a driver before the stop is scheduled AND the carrier
        // paperwork exists. BOTH facts are SERVER-SOURCED from THIS tenant's D1 read-models (legs.appt_slot_key
        // for the claimed appointment, a documents row of the dispatch-required kind for the docs) — never from
        // the client event. A missing prerequisite → GATE_BLOCKED with the EXACT missing subset (REQ-030).
        await this.#enforceDispatch(db, shipmentId, ctx);
        return {};
      default:
        // A GatedKind with no case above = a Set/switch desync. `assertNever` makes that a COMPILE error
        // (belt) and throws at runtime (suspenders) — never a silent fall-through to an ungated append.
        return assertNever(incoming.kind);
    }
  }

  // REQ-028/052 — load the SERVER-SOURCED appointment context and run the pure gate. Returns the canonical
  // LOCAL service date (facility tz) that the appointment projection claims the slot under. `loadFacility`
  // throws LOUDLY on a malformed stored facility config (mirrors #deliveryFence sourcing config server-side);
  // the tz math (localWall/localServiceDate) is impure so it lives HERE, out of the pure gate.
  async #enforceAppointment(
    db: D1Database,
    shipmentId: string | undefined,
    incoming: LedgerEvent & { kind: "appointment.set" },
    ctx: GateCtx,
    prior: () => Promise<readonly LedgerEvent[]>,
  ): Promise<string> {
    const p = incoming.payload;
    const facility = await loadFacility(db, p.facility_id); // null when absent; throws on malformed config
    const now = Date.now();

    // The window's LOCAL wall clock + the server clock's local date — computed only when the facility (hence
    // its tz) resolves. When the facility is null the gate throws `unknown_facility` before these are read.
    let serviceDate = "";
    let localMinuteOfDay = 0;
    let localWindowEndMinute = 0;
    let localDow = 0;
    let nowServiceDate = "";
    if (facility !== null) {
      const tz = facility.hours.tz;
      const w = localWall(p.window_start_ts, tz);
      serviceDate = w.serviceDate;
      localMinuteOfDay = w.minuteOfDay;
      localWindowEndMinute = localWall(p.window_end_ts, tz).minuteOfDay;
      localDow = w.dow;
      nowServiceDate = localServiceDate(now, tz);
    }

    // legExists: the leg the claim UPDATEs (shipment_id, leg_kind) must be materialized (fail-closed).
    const legExists =
      shipmentId !== undefined &&
      (await db
        .prepare("SELECT 1 AS present FROM legs WHERE shipment_id = ? AND kind = ? LIMIT 1")
        .bind(shipmentId, p.leg_kind)
        .first<{ present: number }>()) !== null;

    // occupied: ANOTHER stream (shipment_id <> self) already holds this (facility, slot, service_date). The
    // self-exclude lets a stream reschedule onto/around its own claim without tripping the friendly block.
    const occupied =
      facility !== null &&
      shipmentId !== undefined &&
      (await db
        .prepare("SELECT 1 AS present FROM legs WHERE facility_id = ? AND appt_slot_key = ? AND appt_service_date = ? AND shipment_id <> ? LIMIT 1")
        .bind(p.facility_id, p.slot_key, serviceDate, shipmentId)
        .first<{ present: number }>()) !== null;

    const apptCtx: AppointmentCtx = {
      facility:
        facility === null
          ? null
          : { capacity_slots: facility.capacity_slots, hours: facility.hours, appointment_rules: facility.appointment_rules },
      serviceDate,
      localMinuteOfDay,
      localWindowEndMinute,
      localDow,
      now,
      nowServiceDate,
      legExists,
      occupied,
    };
    if (ctx.override !== undefined) apptCtx.override = ctx.override;

    assertAppointment(await prior(), incoming, apptCtx);
    return serviceDate;
  }

  // REQ-042/182 — load the SERVER-SOURCED booking context from the PARTIES read-model and run the two pure
  // gates. booking.created is the first event on a fresh stream, so there are no prior events to read — the
  // gate reads parties. BOTH gates target the BILL_TO party: its credit_status AND its contacts. The bill_to
  // is the party the Biller's resolveRecipient emails, so gating its contact is what guarantees a passing
  // booking has a resolvable evidence recipient (the party checked == the party emailed). Both reads use THIS
  // tenant's `db` (the DO is pinned to one tenant), so they can never cross a tenant boundary (REQ-025).
  // Credit is evaluated FIRST, so a hold-and-no-contact booking reports credit_clear (deterministic order).
  async #enforceBooking(
    db: D1Database,
    incoming: LedgerEvent & { kind: "booking.created" },
    ctx: GateCtx,
  ): Promise<void> {
    const p = incoming.payload;

    // ONE read of the bill_to party — its credit_status AND contacts feed both gates (the bill_to is who pays
    // AND who is emailed). A missing row (no such party) reads as null for both → credit passes (no hold),
    // recipient blocks (no contact) unless the payload opts out — fail-closed.
    const billTo = await db
      .prepare("SELECT credit_status, contacts FROM parties WHERE id = ?")
      .bind(p.bill_to_party_id)
      .first<{ credit_status: string | null; contacts: string | null }>();

    // Credit (REQ-042): only an explicit 'hold' blocks. Overridable (REQ-049) — ctx carries the override.
    assertBookingCredit(billTo?.credit_status ?? null, ctx);

    // Evidence-recipient contact (REQ-182): the bill_to's contacts JSON, parsed defensively here (a missing
    // row or unparseable JSON → null → no deliverable contact → the gate blocks unless the payload opts out).
    // NON-overridable: the payload opt-out is the only escape.
    let contacts: unknown = null;
    if (billTo?.contacts != null) {
      try {
        contacts = JSON.parse(billTo.contacts);
      } catch {
        contacts = null;
      }
    }
    assertBookingRecipientContact(incoming, contacts);
  }

  // REQ-043 — load the SERVER-SOURCED dispatch context and run the pure gate. BOTH facts come from THIS
  // tenant's D1 read-models (the DO is pinned to one tenant, so neither read can cross a tenant boundary,
  // REQ-025) — never the client event; a dispatcher cannot spoof either:
  //   - hasAppointment: a leg on the shipment has CLAIMED a dock slot — legs.appt_slot_key IS NOT NULL (set by
  //     T5's appointment.set projection). A booked shipment carries skeleton legs with appt_slot_key NULL until
  //     an appointment.set claims one, so a non-null slot IS the "an appointment exists" signal. Matching ANY
  //     leg's appt_slot_key (pickup OR delivery) is the INTENDED v1 reading: dispatch.assigned assigns a driver
  //     to the SHIPMENT, so "the shipment is scheduled" (any appointment) is the gate; leg-kind-specific
  //     dispatch precision (e.g. require the pickup appointment specifically) is future scope, not v1.
  //   - hasDocs: the required carrier paperwork exists — a documents row of the shared DISPATCH_REQUIRED_DOC_KIND
  //     ('ratecon'), the rate-confirmation-class doc REQ-043's literal "docs" requires before a driver rolls (a
  //     member of the documents.kind CHECK in 0002_domain.sql). Required UNCONDITIONALLY — no per-tenant knob;
  //     that matches REQ-043 verbatim and is the recorded decision. DEFERRAL (REQ-184, vNEXT): nothing writes a
  //     ratecon document yet (the rate-con GENERATION flow lands under REQ-184), so this gate is FAIL-CLOSED
  //     until then — a dispatch cannot pass without an accountable REQ-049 override. That is deliberate: the
  //     evidence must exist before a driver rolls. A BOL/POD/other kind does not satisfy it (the concrete kind
  //     is named, via the ONE shared constant — a rename can never silently fail-close the gate).
  // shipmentId is undefined only for a non-`s:` stream (dispatch is shipment-scoped), where neither fact can
  // hold → the gate fails closed. A REQ-049 override on `ctx` releases the gate accountably.
  async #enforceDispatch(db: D1Database, shipmentId: string | undefined, ctx: GateCtx): Promise<void> {
    const hasAppointment =
      shipmentId !== undefined &&
      (await db
        .prepare("SELECT 1 AS present FROM legs WHERE shipment_id = ? AND appt_slot_key IS NOT NULL LIMIT 1")
        .bind(shipmentId)
        .first<{ present: number }>()) !== null;

    const hasDocs =
      shipmentId !== undefined &&
      (await db
        .prepare("SELECT 1 AS present FROM documents WHERE shipment_id = ?1 AND kind = ?2 LIMIT 1")
        .bind(shipmentId, DISPATCH_REQUIRED_DOC_KIND)
        .first<{ present: number }>()) !== null;

    const dispatchCtx: DispatchCtx = { hasAppointment, hasDocs };
    if (ctx.override !== undefined) dispatchCtx.override = ctx.override;
    assertDispatch(dispatchCtx);
  }

  // fence: the delivery leg's dest geo (doc 10 §03 legs.geo) + a policy radius (DEFAULT_FENCE_RADIUS_M
  // if unset). Real per-stop fences are provisioned by booking (WP-08); the tests seed the delivery
  // leg. NEVER from the incoming event. Returns undefined when no delivery leg / no coords exists — the
  // gate then fails LOUD (GateValidationError → 400): a geofence cannot be judged with no fence.
  //
  // INVARIANT (WP-08 T5, REQ-028/052): booking.created materializes ONE delivery leg per shipment at the
  // deterministic `${id}:delivery` row with EMPTY geo; downstream provisioning (dispatch/T8) must UPDATE that
  // row, NEVER INSERT a sibling delivery leg. As a backstop against a stray sibling, this PREFERS a delivery
  // leg with NON-EMPTY geo (falling back to lowest-seq only if none has geo) so the empty skeleton can never
  // SHADOW the real fence regardless of seq order — otherwise a real leg at seq ≥ 2 would be masked and the
  // delivery gate would block forever. deliveryStopGeo (biller.ts) reads the same shape identically.
  async #deliveryFence(db: D1Database, shipmentId: string | undefined, policy: TenantPolicy): Promise<Fence | undefined> {
    if (shipmentId === undefined) return undefined;
    const row = await db
      .prepare("SELECT geo FROM legs WHERE shipment_id = ? AND kind = 'delivery' ORDER BY (geo IS NULL OR geo = '{}') ASC, seq ASC LIMIT 1")
      .bind(shipmentId)
      .first<{ geo: string }>();
    if (row === null) return undefined;
    let geo: unknown;
    try {
      geo = JSON.parse(row.geo);
    } catch {
      return undefined;
    }
    if (geo === null || typeof geo !== "object") return undefined;
    const g = geo as Record<string, unknown>;
    if (typeof g.lat_e6 !== "number" || typeof g.lon_e6 !== "number") return undefined;
    return { lat_e6: g.lat_e6, lon_e6: g.lon_e6, radius_m: policy.gates?.geofence_radius_m ?? DEFAULT_FENCE_RADIUS_M };
  }

  // isInterline: an executing leg whose kind is 'interline' (doc 10 §03 legs.kind IS the determination;
  // an executor_party_id-≠-tenant comparison is an equivalent the schema also supports — a documented
  // refinement). Default false when no interline leg (a plain consignee handoff is not interline).
  async #isInterline(db: D1Database, shipmentId: string | undefined): Promise<boolean> {
    if (shipmentId === undefined) return false;
    const row = await db
      .prepare("SELECT 1 AS present FROM legs WHERE shipment_id = ? AND kind = 'interline' LIMIT 1")
      .bind(shipmentId)
      .first<{ present: number }>();
    return row !== null;
  }

  // ---- money projection dependencies (loaded from D1; kept off the pure projection) ----
  async #moneyDeps(db: D1Database, e: LedgerEvent): Promise<MoneyProjectionDeps> {
    if (e.kind === "invoice.corrected") {
      // The in-effect (positive) lines of the event this correction targets — the projection negates
      // them and inherits their party/division for the reissue.
      const res = await db
        .prepare("SELECT line_no, amount_cents, gl_map, party_id, division FROM money_lines WHERE event_id = ? AND amount_cents > 0 ORDER BY line_no")
        .bind(e.payload.corrects_event_id)
        .all<OriginalLine>();
      return { originalLines: res.results };
    }
    // split/cod/settle payloads don't carry a division — take it from the shipment.
    if (e.kind === "split.computed" || e.kind === "payment.received" || e.kind === "settlement.executed") {
      if (e.shipment_id === undefined) return {};
      const row = await db.prepare("SELECT division FROM shipments WHERE id = ?").bind(e.shipment_id).first<{ division: string }>();
      return row ? { division: row.division } : {};
    }
    return {};
  }

  async #visibilityOf(db: D1Database, eventId: string): Promise<Visibility | undefined> {
    const row = await db.prepare("SELECT visibility FROM events WHERE id = ?").bind(eventId).first<{ visibility: Visibility }>();
    return row?.visibility;
  }

  // ---- control-plane reads (cached per instance; a DO is pinned to one tenant) ----
  async #policy(tenant: string): Promise<TenantPolicy> {
    if (this.policyCache) return this.policyCache;
    const row = await this.env.CONTROL_DB.prepare("SELECT policy FROM tenants WHERE slug = ?").bind(tenant).first<{ policy: string }>();
    this.policyCache = row ? (JSON.parse(row.policy) as TenantPolicy) : {};
    return this.policyCache;
  }

  async #deviceKey(tenant: string, deviceId: string): Promise<JsonWebKey | null> {
    const cached = this.deviceKeys.get(deviceId);
    if (cached !== undefined) return cached;
    // The device's public JWK lives on the user that registered it (users.device_keys[]).
    const row = await this.env.CONTROL_DB
      .prepare(
        "SELECT je.value AS entry FROM users u, json_each(u.device_keys) je " +
          "WHERE u.tenant_id = (SELECT id FROM tenants WHERE slug = ?1) AND json_extract(je.value, '$.device_id') = ?2 LIMIT 1",
      )
      .bind(tenant, deviceId)
      .first<{ entry: string }>();
    const jwk = row ? (JSON.parse(row.entry) as DeviceKeyEntry).public_jwk : null;
    this.deviceKeys.set(deviceId, jwk);
    return jwk;
  }
}
