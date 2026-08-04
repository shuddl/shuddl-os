import { DurableObject } from "cloudflare:workers";
import { EventInput, LedgerEvent, hazmatEnabled, isPlatformTenant, parseTenantPolicy, describeTenantPolicyRejection, TENANT_POLICY_MALFORMED_REASON, type Visibility } from "@shuddl/contracts";
import { GENESIS_HASH, hashEvent } from "@shuddl/ledger/chain";
import { verifyEventSig } from "@shuddl/ledger/sign";
import { resolveVisibility, UNRESOLVED_VISIBILITY } from "@shuddl/ledger/visibility";
import { eventToRow, rowToEvent } from "@shuddl/ledger/lens";
import {
  applyMoneyProjection,
  mapMoneyProjectionError,
  DEFAULT_TERMS_DAYS,
  type MoneyProjectionDeps,
  type OriginalLine,
} from "@shuddl/ledger/projection/money";
import { projectPassport } from "@shuddl/ledger/projection/passports";
import { projectStatusCache, surfaceCreditProjectionGapIfMissed, CREDIT_PROJECTION_GAP_RULE } from "@shuddl/ledger/projection/status-cache";
import { reconcileCreditForParty } from "@shuddl/ledger/reconcile/credit";
import { applyMessageProjection } from "@shuddl/ledger/projection/messages";
import { projectAppointment } from "@shuddl/ledger/projection/appointment";
import { projectApprovals } from "@shuddl/ledger/projection/approvals";
import { projectAgentRuns } from "@shuddl/ledger/projection/agent-runs";
import { projectAuthority } from "@shuddl/ledger/projection/authority";
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
  GateValidationError,
  type AppointmentCtx,
  type DispatchCtx,
  type Fence,
  type GateCtx,
} from "@shuddl/ledger/gates/transition-gates";
import { deriveOperatingState } from "@shuddl/ledger/geo/jurisdiction";
import { loadFacility } from "../facilities.js";
import { authoritativeSource, resolveAuthority } from "../authority.js";
import { localWall, localServiceDate } from "../appointment-window.js";
import { resolveTenantDb, resolvePlatformTenantDb } from "../tenants.js";
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

// `platform` is the INTERNAL, server-minted credit path discriminator (WP-14 T10, finding B). It is set ONLY by
// the internal billing route (routes/internal-platform.ts), NEVER by a customer route (which hard-codes append
// WITHOUT it). It selects the reserved platform D1 (resolvePlatformTenantDb) instead of the customer resolver,
// so a customer JWT can never drive a `_platform` append: the customer path resolves through resolveTenantDb,
// which REJECTS `_platform`. See #resolveDb.
type AppendReq = { tenant: string; streamId: string; input: unknown; platform?: boolean };

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
// The typed view of tenants.policy. Hand-written on purpose — see the note beside TenantPolicyShape in
// @shuddl/contracts (§32): inferring it collides with exactOptionalPropertyTypes at every consumer.
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

// finding C (REQ-030/123, WP-14 T10) — the NARROW POD-gate exemption predicate. Exported + PURE so the
// exemption's exact boundary is unit-tested. TRUE only for a `_platform` CREDIT invoice: the tenant IS the
// reserved platform tenant AND every money line is kind='credit_purchase' (the prepaid credit-pack sale the
// billing emitter builds — a sale with no delivered shipment, hence no POD by nature). It is FALSE for ANY
// customer tenant, so a CUSTOMER invoice.issued is ALWAYS POD-gated (the I2 gate is UNCHANGED), and false for a
// `_platform` invoice that is not a pure credit-purchase invoice (fail-safe: only the exact credit shape exempts).
export function isPlatformCreditInvoiceIssued(tenant: string, kind: string, payload: unknown): boolean {
  if (kind !== "invoice.issued") return false;
  if (!isPlatformTenant(tenant)) return false; // customer invoices are NEVER exempt
  const lines = (payload as { lines?: unknown } | null | undefined)?.lines;
  return (
    Array.isArray(lines) &&
    lines.length > 0 &&
    lines.every((l) => l !== null && typeof l === "object" && (l as { kind?: unknown }).kind === "credit_purchase")
  );
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
  // The RAW {plan, policy} control row for THIS tenant — the input the @shuddl/contracts entitlement helpers
  // read (REQ-060/162). Populated ALONGSIDE policyCache by #policy (one control read), so an entitlement gate
  // needs no extra subrequest. Fail-closed default (empty plan, {} policy) grants NOTHING.
  private entitlementRowCache: { plan: string; policy: string } | null = null;
  private deviceKeys = new Map<string, JsonWebKey | null>();
  // The resolved tenant D1 handle for THIS pinned (tenant, stream). Memoized after the first append: the DO is
  // pinned to ONE tenant (id + pin), so the handle never changes — a claimed slug pays its control-plane read
  // once per wake, not per append. See #resolveDb.
  private dbHandle: D1Database | null = null;

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

  async #append({ tenant, streamId, input, platform }: AppendReq): Promise<AppendedEvent> {
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

    const db = await this.#resolveDb(tenant, platform === true);

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

    // WP-15 Task 3 (REQ-030/023, L8) — authority.flipped is a TENANT-LEVEL control event with ONE blessed home:
    // the t:root stream (the admin-only, gated flip route). It must NEVER land on a shipment (s:) or quote (q:)
    // stream: projectAuthority applies ANY authority.flipped to authority_map regardless of stream, so an
    // authority.flipped on a shipment stream would flip authority while BYPASSING the flip guard (gatesGreenFor +
    // the admin restriction + the money gate) AND shatter the single-stream/seq-order invariant. Enforced HERE at
    // the DO — the single chokepoint EVERY append (every route, every internal seam) traverses — so no caller can
    // inject one no matter which route it reaches. This is the structural twin of the events-route refusal
    // (defense in depth); rejected BEFORE the tail read / gate / batch, so nothing is written and nothing projects.
    if (parsed.kind === "authority.flipped" && streamId !== "t:root") {
      throw rpcError("FORBIDDEN", { reason: "authority.flipped may only append on t:root (WP-15 flip guard)" });
    }

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

    // Task 6 (REQ-042/183/185) — a NATIVE credit.checked must name a party that ALREADY EXISTS. The decision
    // writes tenant-global parties.credit_status that the REQ-042 booking credit-hold gate reads; a decision for
    // an ABSENT party used to append and surface a projection GAP that a later booking could read as NULL and
    // pass (a silent credit-gate defeat). FAIL CLOSED at the write boundary: reject BEFORE any append, so an
    // unresolvable credit decision produces ZERO events and NEVER fabricates a party row. Scoped to
    // source:'native' (the client-postable path the events route forces to native) — a historical/imported
    // (source≠native) credit decision keeps the projection-gap handling below, which the shared reconciler + the
    // booking-gate block resolve fail-closed. Reached AFTER the idempotency checks, so a replay of the same event
    // id still returns the original row rather than re-judging it.
    if (parsed.kind === "credit.checked" && parsed.source === "native") {
      const party = await db.prepare("SELECT id FROM parties WHERE id = ?").bind(parsed.payload.party_id).first();
      if (party === null) throw rpcError("VALIDATION_FAILED", { reason: "credit_party_not_found" });
    }

    const policy = await this.#policy(tenant);
    // I2 (REQ-030) — no invoice without a signed POD on this stream. Gate BEFORE the append.
    // TODO(REQ-030): the `serviceClass` exemption (policy.gates.invoice_without_pod_classes) is UNWIRED.
    // The invoice.issued payload carries no service class, and the shipment's service class is not threaded
    // here, so assertPodSigned's 4th arg is intentionally omitted and the exemption is INERT — the gate
    // always enforces (fail-safe: a POD is always required; a tenant configuring the exemption gets no
    // effect, never an accidental bypass). Wire serviceClass from shipments.service once the invoice write
    // path models it; enabling a POD-gate bypass needs its own test before it ships (register note).
    //
    // finding C (WP-14 T10) — the ONE narrow exemption: a `_platform` CREDIT invoice (all lines credit_purchase)
    // is a prepaid credit-pack sale with no delivered shipment, so it has no POD by nature and is EXEMPT. The
    // predicate requires the reserved platform tenant, so a CUSTOMER invoice.issued is NEVER exempted — its I2
    // POD gate is byte-for-byte UNCHANGED (a customer invoice with no pod.signed still GATE_BLOCKs).
    //
    // WP-15 Task 4b (REQ-021/030) — a `source:'legacy'` invoice.issued is a HISTORICAL MIRROR RECORD of an
    // invoice the incumbent ALREADY issued, NOT a native physical assertion. The I2 POD gate is a NATIVE
    // physical-precondition ("SHUDDL will not create an invoice without a signed POD on ITS ledger"); it must
    // NOT re-judge a mirror record against SHUDDL's own physics (the incumbent's POD lives in the incumbent's
    // system, not this stream). So a legacy invoice is EXEMPT here. `source:'legacy'` is producible ONLY by the
    // internal mirror seam (the events route FORCES native), so this carve-out is unforgeable by a client. Every
    // STRUCTURAL law still applies to it below: the seq/prev_hash/hash chain, the append-only guards, tenant
    // isolation, and the authority.flipped-only-on-t:root check above (legacy is never authority.flipped).
    if (parsed.kind === "invoice.issued" && parsed.source !== "legacy" && !isPlatformCreditInvoiceIssued(tenant, parsed.kind, parsed.payload)) {
      await assertPodSigned(db, streamId, policy);
    }

    // D1 is truth: load the tail once per wake, from D1. The in-memory cache is bumped only AFTER the
    // batch commits, so a crash between insert and bump self-heals from D1 on the next wake.
    if (!this.tail) {
      const row = await db
        .prepare("SELECT seq, hash FROM events WHERE stream_id = ? ORDER BY seq DESC LIMIT 1")
        .bind(streamId)
        .first<{ seq: number; hash: string }>();
      this.tail = row ? { seq: row.seq, hash: row.hash } : { seq: -1, hash: GENESIS_HASH };
    }

    // Task 8 (REQ-015 / I7) — invoice.corrected inherits its parent's visibility so I7 netting stays inside the
    // parent's EXACT lens. Resolve the parent by STREAM + KIND (not just id): it must be an invoice.issued or a
    // prior invoice.corrected ON THIS STREAM. A missing / wrong-kind / cross-stream / cross-tenant parent yields
    // NO visibility → resolveVisibility returns UNRESOLVED_VISIBILITY → we reject below (fail closed, zero append).
    // The DO is tenant-pinned and this reads THIS tenant's db, so a cross-tenant parent id can never match here.
    const correctedVis =
      parsed.kind === "invoice.corrected" ? await this.#parentInvoiceVisibility(db, streamId, parsed.payload.corrects_event_id) : undefined;

    // requested_visibility is INPUT-ONLY: it has no DB column, so if it entered the hashed envelope
    // rowToEvent could never reproduce the hash and every read-back would fail chain verification.
    // Destructure it out and build the event from the remaining client fields.
    const { requested_visibility, ...clientFields } = parsed;
    const resolvedVisibility = resolveVisibility(parsed.kind, policy.visibility, requested_visibility, correctedVis);
    // Task 8 (REQ-015 / I7) — FAIL CLOSED on an unresolved correction lens. An invoice.corrected whose parent's
    // visibility could not be resolved must NOT default to counterparty (a phantom charge in a lens the original
    // never appeared in); reject BEFORE the append so nothing is written, projected, or netted.
    if (resolvedVisibility === UNRESOLVED_VISIBILITY) {
      throw rpcError("VALIDATION_FAILED", { reason: "invoice_correction_unresolved_parent" });
    }
    let visibility: Visibility = resolvedVisibility;
    // finding D (REQ-025/123, WP-14 T10) — the reserved platform tenant's credit money events are INTERNAL. The
    // shared resolver defaults invoice.issued/payment.received to `counterparty` (correct for a REAL tenant, whose
    // counterparty MUST see its invoice); on `_platform` there is no counterparty, so clamp them to `internal`
    // server-side. This is the SERVER's enforcement (belt to the emitter's own requested_visibility:'internal') —
    // a narrowing only (internal < counterparty), so it can never widen a stamped value.
    if (isPlatformTenant(tenant) && (parsed.kind === "invoice.issued" || parsed.kind === "payment.received")) {
      visibility = "internal";
    }

    // REQ-186 (WP-08 exit audit) — PIN shipment_id to the stream. stream_id is DO-authoritative (set below);
    // shipment_id must name the SAME shipment (the events CHECK is `stream_id = 's:' || shipment_id`). But the
    // client field is z.string().optional(), and the DO used to trust it — so an OMITTED shipment_id committed
    // a phantom appointment.set that claimed no slot (the projections key off e.shipment_id), and a CROSSED one
    // reached a projection and aborted the batch as an unmapped 500. Derive it from the stream — the same
    // authority that sets stream_id — for a shipment stream (s:<id>); leave it untouched for a non-shipment
    // stream (q:/t:root), whose events carry no shipment_id (stamping one would both change their canonical
    // bytes AND violate the CHECK). Byte-safe on all existing data, by two facts together: (1) the CHECK
    // forbids a stored s: event from CROSSING shipment_id — any PRESENT value already equals streamId.slice(2),
    // so re-deriving it is a no-op; and (2) the CHECK does permit shipment_id NULL on an s: stream, but every
    // seeded/agent-written s: event actually POPULATES it (seed generate.ts, booking.ts, concierge.ts all set
    // it), so there is NO null-on-s: event whose canonical bytes the derivation would change. Verified: the
    // SEED-1 hash is unchanged by this commit. The derivation exists to correct exactly the malformed shapes
    // (omitted/crossed) that this repo's writers never produce but an untrusted client could.
    const derivedShipmentId = streamId.startsWith("s:") ? streamId.slice(2) : undefined;

    // LedgerEvent.parse validates the assembled STORAGE shape (and, being .strict(), is a backstop
    // against any stray key entering the hash-view). hash is computed next, never client-supplied.
    const event = LedgerEvent.parse({
      ...clientFields,
      stream_id: streamId,
      ...(derivedShipmentId !== undefined ? { shipment_id: derivedShipmentId } : {}),
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

    // WP-15 Task 4b (REQ-021/022/030) — SOURCE-AWARE SHADOW BATCH. A `source:'legacy'` event is a HISTORICAL
    // MIRROR RECORD of what the incumbent already did, NOT a native physical assertion. It lands in `events` —
    // where the native-vs-legacy PARITY compute reads it RAW (computeModuleParity's `source IN ('native','legacy')`)
    // — but drives NO native read-model / projection: SKIP every projection spread, so it writes NO money_lines /
    // invoices / AR / status_cache / legs / passport / approval / agent_run / authority row. This ONE branch
    // covers every projection-based native read-model in a single place. The event INSERT itself still runs (the
    // legacy row is a real, chained ledger entry), and so do ALL the structural laws around it: the
    // seq/prev_hash/hash chain (`full` above), the append-only + party_refs D1 guards (events_guard_ins etc. fire
    // on THIS insert), and tenant isolation (REQ-025 — `db` is this tenant's D1). Native (native/edi/email) is
    // byte-for-byte UNCHANGED — the else-branch is the exact prior batch.
    const isLegacy = full.source === "legacy";
    let statusStmts: D1PreparedStatement[] = [];
    let statusOffset = -1;
    let stmts: D1PreparedStatement[];
    if (isLegacy) {
      // Parity-only shadow: the event insert ALONE. No #moneyDeps read, no projection spread — nothing native.
      stmts = [insertEventStmt(db, full)];
    } else {
      // ONE batch — event + money lines + passport counters + status_cache + messages read-model. A
      // projection failure (e.g. a missing parties FK, or a second correction of the same event) aborts
      // the WHOLE append atomically. The messages projection (REQ-100) mirrors the money one: a committed
      // message.* event projects its `messages` row in this SAME batch, so no communication exists outside
      // the ledger (INSERT OR IGNORE on a deterministic id keeps re-projection idempotent).
      const deps = await this.#moneyDeps(db, full, tenant);
      const moneyStmts = applyMoneyProjection(db, full, deps);
      const passportStmts = projectPassport(db, full);
      statusStmts = projectStatusCache(db, full);
      // REQ-183 — the credit.checked→parties.credit_status UPDATE rides this batch (statusStmts, exactly one
      // statement for a credit.checked). Its rows-affected, read off the batch result at this offset AFTER the
      // commit, tells us whether the party row was absent (a silent no-op to surface loudly, never fabricate).
      statusOffset = 1 + moneyStmts.length + passportStmts.length;
      stmts = [
        insertEventStmt(db, full),
        ...moneyStmts,
        ...passportStmts,
        ...statusStmts,
        ...projectAppointment(db, full, gateResult.appointmentServiceDate),
        ...applyMessageProjection(db, full),
        // WP-10 T2 (REQ-082/194) — the approvals-queue read-model: approval.requested opens a row, approval.decided
        // flips it to decided. Rides the SAME batch (I1) so the queue row and its event commit atomically.
        ...projectApprovals(db, full),
        // WP-11 T9 (REQ-113) — agent_runs metering: a committed agent.acted projects one per-run cost/latency row
        // (the previously dead table, now LIVE). Same batch (I1); INSERT OR IGNORE keeps a redelivery idempotent.
        ...projectAgentRuns(db, full),
        // WP-15 T1 (REQ-008/023, L8) — authority_map overlay: a committed authority.flipped UPSERTS the module's
        // authority + records the flip. Same batch (I1); the EXISTS(json_each) append dedupe keeps a redelivery idempotent.
        ...projectAuthority(db, full),
      ];
    }
    let results: D1Result[];
    try {
      results = await db.batch(stmts);
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

    // WP-15 Task 4b (REQ-021/030) — a legacy shadow record drives NO native SIDE EFFECT either: no
    // credit-gap surface, and NO Biller/Booking/Concierge trigger. An agent activation is even more
    // native-polluting than a read-model row (it would emit a native invoice/booking/reply against the
    // mirror), so it must not fire. MIRROR_KINDS today excludes every trigger kind (pod.signed /
    // quote.accepted / message.received), so this is belt-and-suspenders AND forward-safe (the `comms`
    // module mirrors message.received in a later task). Return the committed legacy event unchanged.
    if (isLegacy) return full;

    // REQ-183 — surface a LOUD gap if the credit.checked→parties.credit_status projection was a silent no-op
    // (the party row does not exist yet). Runs AFTER the commit: the credit.checked event is truth regardless,
    // and this is a best-effort durable ops signal (loud log + anomalies row) that must never throw into the
    // append path. It NEVER fabricates the missing party row. results[statusOffset] carries the CREDIT_SQL
    // statement's rows-affected (statusStmts is exactly that one statement for a credit.checked).
    if (full.kind === "credit.checked" && statusStmts.length === 1) {
      const changes = results[statusOffset]?.meta.changes ?? 0;
      try {
        await surfaceCreditProjectionGapIfMissed(db, full, changes);
      } catch (err) {
        console.error(
          `[REQ-183] credit projection gap surfacing failed for ${full.id} (the gap log above stands; the recon sweep re-checks):`,
          err,
        );
      }
    }

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
            console.error(`biller trigger enqueue failed for pod ${full.id} (POD committed; the REQ-169 sweep recovers it for STATIC-ROSTER tenants only — the agents crons cannot enumerate claimed pool tenants):`, err);
          }),
        );
      }
    }

    // WP-08 (REQ-028/030/039): a COMMITTED quote.accepted triggers the Booking agent — the Biller's sibling.
    // Same discipline as the Biller/Concierge triggers: enqueue STRICTLY AFTER the batch commits (an enqueue-
    // then-abort would book an acceptance that was never recorded), on ctx.waitUntil (off the mutex + the
    // caller's ack), best-effort (a failed push is LOGGED, never thrown — the accept is committed truth; a lost
    // trigger is a reconciliation-sweep concern, WP-11, and the Booking agent's append is idempotent). A
    // quote.accepted always sits on a shipment stream (it presupposes an accepted quote), so shipment_id is
    // expected; a missing one can never be booked by the trigger, so it pages a human rather than vanishing.
    // The shape is the consumer's Zod boundary (workers/agents/src/booking.ts QuoteAcceptedTrigger).
    if (full.kind === "quote.accepted") {
      if (full.shipment_id === undefined) {
        console.error(`booking trigger NOT enqueued: quote.accepted ${full.id} on ${streamId} carries no shipment_id — nothing will book this acceptance (REQ-028)`);
      } else {
        const trigger = { kind: "quote.accepted", tenant, shipment_id: full.shipment_id, event_id: full.id };
        this.ctx.waitUntil(
          this.env.AGENT_QUEUE.send(trigger).catch((err: unknown) => {
            // AUDIT §131 — CORRECTED. This line previously read "the sweep recovers it for static-roster
          // tenants only", which named a recovery that DOES NOT EXIST. The pod.signed -> invoice window has
          // one (REQ-169: `queries/unbilled.ts` anti-joins committed PODs against invoices and `recon-sweep.ts`
          // re-drives them). There is NO equivalent for quote.accepted -> booking.created: no unbooked query,
          // and none of the seven crons (sla, recon, credit-recon, collector, mirror, watchtower, retention)
          // reconciles bookings. A lost trigger here leaves the accept committed and the shipment UNBOOKED
          // indefinitely, recoverable only by a human re-driving it. Proposed as a register row in audit §131;
          // building the sweep needs that row first (CLAUDE.md: no build without a REQ).
          console.error(`booking trigger enqueue failed for quote.accepted ${full.id} (accept committed; NO SWEEP RECOVERS THIS — see audit §131, the shipment stays unbooked until a human re-drives it):`, err);
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
          console.error(`concierge trigger enqueue failed for message ${full.id} (message committed; the sweep recovers it for static-roster tenants only):`, err);
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
    // WP-15 Task 4b (REQ-021/030) — a `source:'legacy'` event is a HISTORICAL MIRROR RECORD of a transition the
    // incumbent ALREADY made (an appointment it set, a driver it dispatched), NOT a native physical assertion, so
    // it is EXEMPT from EVERY native physical/business-precondition transition gate: #enforceAppointment
    // (facility+leg+capacity), #enforceDispatch (a claimed appointment + carrier docs), #enforceBooking
    // (credit/recipient/hazmat), the pickup-depart / delivery-geofence / interline / consent-before-GPS / exception
    // gates. These gates encode SHUDDL's OWN physics ("a driver may not roll before the stop is scheduled ON THIS
    // LEDGER"); re-judging a mirror record against them would refuse a fact the incumbent already performed. Every
    // STRUCTURAL law still binds a legacy event (enforced OUTSIDE this method): the append-only guards, the
    // seq/prev_hash/hash chain, tenant isolation (REQ-025), and the Task-3 authority.flipped-only-on-t:root check
    // (a legacy event is never authority.flipped — MIRROR_KINDS excludes it). `source:'legacy'` is producible ONLY
    // by the internal mirror seam (the public events route FORCES native), so this carve-out is unforgeable by a
    // client — the review's exact concern. Returning {} means no appointmentServiceDate is computed, which is
    // correct: the legacy appointment.set projection is ALSO skipped (the source-aware batch below), so no gate,
    // and no write, re-derives the incumbent's slot on SHUDDL's dock model.
    if (incoming.source === "legacy") return {};
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
        // the state is not a client-supplied CLAIM. But server-derived ≠ authoritative: the resolver is
        // exact point-in-polygon (V1 Task 13, geo/jurisdiction.ts) over a SYNTHETIC 5-state artifact — a
        // licensed boundary set is a deploy input — and legal sufficiency of any consent is
        // [CONFIRM]/counsel. This gate takes NO override — consent is a legal precondition, not a waivable
        // evidence requirement.
        assertConsentBeforeGps(await prior(), incoming, { operating_state: deriveOperatingState(incoming.payload.geo) });
        return {};
      case "appointment.set": {
        // REQ-028/052 — the dock-slot claim gate. All context is SERVER-SOURCED here (facility capacity from
        // this tenant's D1, the window's LOCAL wall clock from the facility tz, leg existence + occupancy from
        // the legs read-model) — never from the client event. Returns the computed service_date so #append can
        // hand the SAME value to the appointment projection (one impure tz derivation, reused by gate + write).
        //
        // WP-15 REQ-030/L8 — consult the shared authority read-seam for the DISPATCH module. SCOPED to ONLY this
        // gated kind (a rare, dock-slot-claim event) — NOT the generic every-kind append path — so it is one
        // indexed SELECT on the 5-row authority_map for an infrequent event, never the position/GPS firehose.
        // `legacyValueAvailable` is false today (no legacy dispatch mirror — Task 4), so authoritativeSource
        // ALWAYS resolves to "native" and the service_date computed below IS authoritative — behavior-IDENTICAL.
        // The consult feeds a DORMANT branch ONLY: it NEVER touches the gate decision, the returned service_date,
        // the event hash, the append, or the seq ordering. Tasks 4/6/8 light up the legacy branch.
        const dispatchAuthority = authoritativeSource(await resolveAuthority(db, "dispatch"), false);
        if (dispatchAuthority === "legacy") {
          // DORMANT until a legacy dispatch mirror exists (Task 4). Unreachable today (native always wins).
          console.error(`sequencer: dispatch authority is 'legacy' for ${shipmentId ?? streamId} (appointment.set) but no mirror is wired (WP-15 Task 4) — proceeding native`);
        }
        return { appointmentServiceDate: await this.#enforceAppointment(db, shipmentId, incoming, ctx, prior) };
      }
      case "booking.created":
        // REQ-042/182 — the booking gates. booking.created is the FIRST event on a fresh direct-booking
        // stream (prior may be []), so context is SERVER-SOURCED from the PARTIES read-model — BOTH the
        // bill_to's credit_status AND the bill_to's contacts (the bill_to is the party the Biller emails, so
        // it is the party gated) — NEVER from prior events. Both reads go through THIS tenant's db
        // (tenant-isolated), never the client event.
        await this.#enforceBooking(db, incoming, ctx);
        return {};
      case "dispatch.assigned": {
        // REQ-043 — the DISPATCH gate. You don't send a driver before the stop is scheduled AND the carrier
        // paperwork exists. BOTH facts are SERVER-SOURCED from THIS tenant's D1 read-models (legs.appt_slot_key
        // for the claimed appointment, a documents row of the dispatch-required kind for the docs) — never from
        // the client event. A missing prerequisite → GATE_BLOCKED with the EXACT missing subset (REQ-030).
        //
        // WP-15 REQ-030/L8 — consult the shared authority read-seam for the DISPATCH module, SCOPED to ONLY this
        // gated kind (a rare driver-assignment event), exactly like the appointment.set case above — one indexed
        // SELECT on the 5-row authority_map, never the generic append path. `legacyValueAvailable` is false today
        // (no legacy dispatch mirror — Task 4), so authoritativeSource ALWAYS resolves to "native" and the gate
        // below runs exactly as before — behavior-IDENTICAL. The consult feeds a DORMANT branch ONLY: it NEVER
        // touches the gate decision, the event hash, the append, or the ordering. Tasks 4/6/8 light it up.
        const dispatchAuthority = authoritativeSource(await resolveAuthority(db, "dispatch"), false);
        if (dispatchAuthority === "legacy") {
          // DORMANT until a legacy dispatch mirror exists (Task 4). Unreachable today (native always wins).
          console.error(`sequencer: dispatch authority is 'legacy' for ${shipmentId ?? streamId} (dispatch.assigned) but no mirror is wired (WP-15 Task 4) — proceeding native`);
        }
        await this.#enforceDispatch(db, shipmentId, ctx);
        return {};
      }
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

    // REQ-191 (WP-09 exit audit C-2) — booking.created is IDEMPOTENT PER STREAM: at most ONE per shipment.
    // A SECOND booking.created (a portal party who re-rated + re-accepted an already-booked shipment via the
    // accept-quote seam, or any WP-10 command-bar path) is rejected here SERVER-SIDE before the append — so
    // the append-only ledger never gains a duplicate booking and the status_cache never regresses (a delivered
    // shipment can no longer revert to `booked`). The Concierge quote-stage path stays green: its shipments
    // row is created WITHOUT a booking.created, so the first REAL booking is still the first on the stream.
    // `incoming.stream_id` is DO-authoritative (set before the gate runs). Checked BEFORE the credit/contact
    // gates so an already-booked stream reports the invariant, not a credit/recipient reason.
    const priorBooking = await db
      .prepare("SELECT 1 AS present FROM events WHERE stream_id = ? AND kind = 'booking.created' LIMIT 1")
      .bind(incoming.stream_id)
      .first<{ present: number }>();
    if (priorBooking !== null) throw new GateValidationError("shipment_already_booked");

    // Task 7 (REQ-031/003) — BOOKING QUOTE AUTHORITY. booking.created.quote_event_id anchors the accepted quote
    // the Biller will later project into the invoice, so a booking must never commit bound to a quote it did not
    // accept. Validated SERVER-SIDE before the append (REQ-030 parity: both the ops/API path and the Booking agent
    // traverse this DO). SCOPED to a reference that RESOLVES to a real event ON THIS STREAM: if it resolves, it
    // MUST be a quote.priced that a quote.accepted on this stream NAMES (exact id / stream / kind / accepted) —
    // else the booking is rejected (VALIDATION_FAILED), ZERO append. A reference that does NOT resolve on this
    // stream (a cross-stream / cross-tenant / not-yet-materialized id) is deliberately NOT rejected here: the
    // Biller's fail-closed billing check (loadAcceptedBookingQuote) HOLDS it with zero money/send, and rejecting
    // every non-co-located reference at write time would break the many existing streams whose booking carries a
    // placeholder quote id. This gate closes the on-stream wrong-kind / unaccepted holes at write time; the Biller
    // closes the rest at bill time. `incoming.stream_id` is DO-authoritative.
    const referencedQuote = await db
      .prepare("SELECT kind FROM events WHERE stream_id = ? AND id = ? LIMIT 1")
      .bind(incoming.stream_id, p.quote_event_id)
      .first<{ kind: string }>();
    if (referencedQuote !== null) {
      if (referencedQuote.kind !== "quote.priced") {
        throw rpcError("VALIDATION_FAILED", { reason: "booking_quote_not_priced" });
      }
      const acceptedRef = await db
        .prepare("SELECT 1 AS present FROM events WHERE stream_id = ? AND kind = 'quote.accepted' AND json_extract(payload, '$.quote_event_id') = ? LIMIT 1")
        .bind(incoming.stream_id, p.quote_event_id)
        .first<{ present: number }>();
      if (acceptedRef === null) throw rpcError("VALIDATION_FAILED", { reason: "booking_quote_not_accepted" });
    }

    // REQ-060 — HAZMAT entitlement (fail-closed, SERVER-SIDE). A booking DECLARED hazmat (payload.hazmat === true)
    // is REFUSED unless THIS tenant's control-plane policy enables it (policy.hazmat_enabled). The entitlement is
    // read from the SERVER control plane keyed off the DO's pinned tenant (#entitlementRow) — NEVER the client
    // payload; the payload's `hazmat` only DECLARES the freight is regulated, so a client can never self-grant the
    // workspace enablement. Excluded from the Spark default (a Spark tenant's policy carries no hazmat_enabled).
    // Runs BEFORE the credit/recipient gates: a tenant that may not book hazmat AT ALL is refused regardless of
    // the bill_to's credit/contact. Both the ops/API path and the Booking agent append booking.created THROUGH
    // this DO, so gate parity holds (REQ-030). FORBIDDEN (403) — an entitlement miss is an authorization refusal,
    // not malformed input. NON-hazmat bookings never reach hazmatEnabled(), so the gate is inert for them.
    if ((incoming.payload as { hazmat?: unknown }).hazmat === true && !hazmatEnabled(this.#entitlementRow())) {
      throw rpcError("FORBIDDEN", { reason: "hazmat_not_enabled" });
    }

    // Task 6 (REQ-042/183) — RECONCILE any credit projection gap for the bill_to FIRST (idempotent, bounded; the
    // SAME shared fn the agents cron drives), so a decision that landed after the party materialized is applied
    // before we read credit. Then fail CLOSED if a gap SURVIVES: an unresolved gap means the party is still
    // absent or no credit.checked decision is on the ledger, so the credit_status read is unreliable and booking
    // must block. Tenant-isolated — `db` is this DO's one tenant (REQ-025).
    await reconcileCreditForParty(db, p.bill_to_party_id);

    // ONE read of the bill_to party — its credit_status AND contacts feed both gates (the bill_to is who pays
    // AND who is emailed). Read AFTER reconcile so credit_status reflects any just-applied decision. A missing
    // row (no such party) reads as null for both → the credit gate fails closed via the gap below, the recipient
    // gate blocks (no contact) unless the payload opts out — fail-closed.
    const billTo = await db
      .prepare("SELECT credit_status, contacts FROM parties WHERE id = ?")
      .bind(p.bill_to_party_id)
      .first<{ credit_status: string | null; contacts: string | null }>();

    // An OPEN credit_projection_gap for the bill_to that SURVIVED reconciliation → the credit decision may not
    // have landed. Presence fails the credit gate closed with a DISTINCT reason (Task 6).
    const creditGapUnresolved =
      (await db
        .prepare("SELECT 1 AS present FROM anomalies WHERE rule = ?1 AND object_id = ?2 AND status = 'open' LIMIT 1")
        .bind(CREDIT_PROJECTION_GAP_RULE, p.bill_to_party_id)
        .first<{ present: number }>()) !== null;

    // Credit (REQ-042/183): an unresolved gap OR an explicit 'hold' blocks. Overridable (REQ-049) — ctx carries
    // the override, which releases both (an accountable finance book-over).
    assertBookingCredit(billTo?.credit_status ?? null, creditGapUnresolved, ctx);

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
  async #moneyDeps(db: D1Database, e: LedgerEvent, tenant: string): Promise<MoneyProjectionDeps> {
    if (e.kind === "invoice.corrected") {
      // The in-effect (positive) lines of the event this correction targets — the projection negates
      // them and inherits their party/division for the reissue.
      const res = await db
        .prepare("SELECT line_no, amount_cents, gl_map, party_id, division FROM money_lines WHERE event_id = ? AND amount_cents > 0 ORDER BY line_no")
        .bind(e.payload.corrects_event_id)
        .all<OriginalLine>();
      return { originalLines: res.results };
    }
    // REQ-083 — an issued invoice's payment terms, sourced SERVER-SIDE. The invoice.issued payload carries no
    // terms field and booking.created.bill_terms is a billing-RESPONSIBILITY code (not net-days), so today the
    // honest source is the documented system default (net-30). The projection turns it into terms + due_ts;
    // if this were ever undefined, the projection stores NULL (no terms on file), never a fabricated date.
    if (e.kind === "invoice.issued") {
      // A `_platform` credit invoice is PREPAID — no net terms (terms/due_ts project NULL), matching the retired
      // D1PlatformLedger's credit behavior. A CUSTOMER invoice keeps the documented net-30 default (REQ-083).
      if (isPlatformTenant(tenant)) return {};
      return { termsDays: DEFAULT_TERMS_DAYS };
    }
    // split/cod/settle payloads don't carry a division — take it from the shipment.
    if (e.kind === "split.computed" || e.kind === "payment.received" || e.kind === "settlement.executed") {
      const deps: MoneyProjectionDeps = {};
      if (e.shipment_id !== undefined) {
        const row = await db.prepare("SELECT division FROM shipments WHERE id = ?").bind(e.shipment_id).first<{ division: string }>();
        if (row) deps.division = row.division;
      }
      // REQ-083 — a payment.received settles the invoice it names (payload.invoice_id), else the shipment's
      // single OPEN invoice (matched via the issued event's shipment_id). Only status='issued' rows are
      // matched, so an already-paid invoice yields nothing to re-settle (idempotent). The pure projection
      // then flips it to 'paid' iff the payment covers the total.
      if (e.kind === "payment.received") {
        const target = await this.#matchOpenInvoice(db, e);
        if (target) deps.settleInvoice = target;
      }
      return deps;
    }
    return {};
  }

  // REQ-083 — resolve the OPEN invoice a payment.received applies to (server-side linkage; kept off the pure
  // projection). Prefer an explicit payload.invoice_id; otherwise the shipment's single open invoice, joined
  // through issued_event_id → the invoice.issued event's shipment_id (invoices carries no shipment column).
  async #matchOpenInvoice(db: D1Database, e: LedgerEvent): Promise<{ id: string; total_cents: number } | undefined> {
    if (e.kind !== "payment.received") return undefined; // narrows e.payload to the JsonObject variant
    const invoiceId = typeof e.payload["invoice_id"] === "string" ? e.payload["invoice_id"] : undefined;
    if (invoiceId !== undefined) {
      const row = await db
        .prepare("SELECT id, total_cents FROM invoices WHERE id = ?1 AND status = 'issued'")
        .bind(invoiceId)
        .first<{ id: string; total_cents: number }>();
      return row ?? undefined;
    }
    if (e.shipment_id !== undefined) {
      const row = await db
        .prepare(
          "SELECT i.id AS id, i.total_cents AS total_cents FROM invoices i " +
            "JOIN events ev ON ev.id = i.issued_event_id " +
            "WHERE ev.shipment_id = ?1 AND i.status = 'issued' ORDER BY ev.recorded_at, ev.seq LIMIT 1",
        )
        .bind(e.shipment_id)
        .first<{ id: string; total_cents: number }>();
      return row ?? undefined;
    }
    return undefined;
  }

  // Task 8 (REQ-015 / I7) — the EXACT parent's visibility for an invoice.corrected. Resolved by STREAM + KIND,
  // not merely by id: the parent must be an invoice.issued (or a prior invoice.corrected in the netting chain) ON
  // THIS STREAM. A missing / wrong-kind / cross-stream parent returns undefined → the caller resolves UNRESOLVED
  // and fails closed. Cross-tenant is structurally excluded (this reads the DO's own tenant db, REQ-025).
  async #parentInvoiceVisibility(db: D1Database, streamId: string, eventId: string): Promise<Visibility | undefined> {
    const row = await db
      .prepare("SELECT visibility FROM events WHERE stream_id = ? AND id = ? AND kind IN ('invoice.issued','invoice.corrected') LIMIT 1")
      .bind(streamId, eventId)
      .first<{ visibility: Visibility }>();
    return row?.visibility;
  }

  // REQ-025/123 (WP-14 T10) — SERVER-SIDE tenant→D1 resolution for the append (WRITE) path. TWO disjoint doors,
  // and the ISOLATION INVARIANT lives in which door a caller can open:
  //   · CUSTOMER (platform=false, the DEFAULT): resolveTenantDb resolves a STATIC (tenant-a/b) OR a CLAIMED pool
  //     slug, and REJECTS `_platform` (throws ApiError). The DO id + `tenant` come from the authenticated session
  //     claim (the route derives idFromName(`${tenant}|${streamId}`)), so a customer JWT — even one forged to
  //     carry tenant=`_platform` — dies here, exactly as on the read path. This is what lets a CLAIMED tenant now
  //     WRITE to its OWN pool D1 (the Task-3 read resolver, now on the append path) WITHOUT widening isolation.
  //   · PLATFORM (platform=true): the INTERNAL, server-minted credit path — set ONLY by the internal billing
  //     route (routes/internal-platform.ts), which is secret-gated and is NOT a customer route. It resolves the
  //     reserved platform D1 and ASSERTS the tenant IS `_platform` (belt: the flag can never bind a customer slug).
  // Memoized on `dbHandle`: the DO is pinned to ONE (tenant, stream) by the identity + pin checks that run BEFORE
  // this, so the resolved handle is stable — a claimed slug pays its control read once per wake, not per append.
  async #resolveDb(tenant: string, platform: boolean): Promise<D1Database> {
    if (this.dbHandle) return this.dbHandle;
    if (platform) {
      if (!isPlatformTenant(tenant)) throw rpcError("FORBIDDEN", { reason: "platform append requires the platform tenant" });
      this.dbHandle = resolvePlatformTenantDb(this.env);
      return this.dbHandle;
    }
    try {
      // resolveTenantDb REJECTS `_platform` and resolves static + claimed. Its ApiError must not cross the RPC
      // hop, so map any miss to the DO's own FORBIDDEN contract (the SAME fail-closed refusal a static miss gets).
      this.dbHandle = await resolveTenantDb(this.env, tenant);
    } catch {
      throw rpcError("FORBIDDEN", { reason: "unknown tenant" });
    }
    return this.dbHandle;
  }

  // ---- control-plane reads (cached per instance; a DO is pinned to one tenant) ----
  async #policy(tenant: string): Promise<TenantPolicy> {
    if (this.policyCache) return this.policyCache;
    // ONE read feeds BOTH the parsed gate policy AND the raw entitlement row (plan + policy). A MISSING control
    // row fails closed on both: {} policy (no gate knobs) and an empty-plan entitlement row (no SKU/hazmat).
    const row = await this.env.CONTROL_DB
      .prepare("SELECT plan, policy FROM tenants WHERE slug = ?")
      .bind(tenant)
      .first<{ plan: string; policy: string }>();
    this.entitlementRowCache = row ? { plan: row.plan, policy: row.policy } : { plan: "", policy: "{}" };
    // A MALFORMED policy REFUSES THE APPEND with a named code (2026-08-02 §15). Read the correction here,
    // because the first attempt at this guard was a security defect and the reasoning matters:
    //
    // The parse was originally unguarded — one stray character in a hand-edited control row threw a raw
    // SyntaxError out of #policy (which #append awaits BEFORE any gate), so every append for that tenant
    // 500'd forever and the translator's inbound-204 chain retry-stormed against it. §13 "fixed" that by
    // falling back to `{}` and letting appends proceed, calling `{}` the gate-knob floor.
    //
    // `{}` IS NOT A FLOOR. It is the floor for exactly one knob and the CEILING for three:
    //   · gates.dims_required — `=== true`, so {} yields FALSE and DROPS the REQ-045 dims precondition
    //   · gates.geofence_radius_m — `?? 150`, so {} widens any tenant that configured a tighter fence
    //   · visibility — resolveVisibility falls to per-kind DEFAULTS, dropping every narrowing override
    //   · invoice_without_pod_classes — `[]`, the only genuinely tighter one (and it is UNWIRED)
    //
    // The visibility case is the unrecoverable one: visibility is STAMPED on the event at append time, and
    // events are immutable (I3/I7). A tenant who set `document.attached: internal` and then suffered one
    // corrupt byte would have had those events stamped `counterparty` and exposed through the portal lens
    // PERMANENTLY — repairing the control row afterwards cannot un-stamp a committed event. A loud 500 is a
    // bad failure; a silent, permanent, irreversible disclosure is a far worse one.
    //
    // So: refuse, with a code that names the cause. This keeps the fail-closed posture the original had
    // while replacing the opaque SyntaxError 500 with a diagnosable VALIDATION_FAILED that tells the
    // operator exactly which row to fix. `JSON.parse("null")` and any non-object are refused the same way
    // (a null would also defeat the `if (this.policyCache)` cache line above and re-read on every call).
    if (row) {
      // The predicate is SHARED from @shuddl/contracts (2026-08-02 §19) — the EDI translator must reach the
      // same verdict BEFORE it writes anything, or its append throws a 500 that a partner retry-storms
      // against. Two copies of "may this tenant append?" is precisely the drift §14 closed for the reserved
      // plans; this one is worse, because the two sides would disagree about a security refusal.
      const parsed = parseTenantPolicy(row.policy);
      if (parsed === null) {
        console.error(`sequencer: tenant ${tenant} has an UNUSABLE policy — ${describeTenantPolicyRejection(row.policy)} — REFUSING every append until the control row is fixed; a {} fallback would silently OPEN the dims gate, widen the geofence and drop visibility overrides onto immutable events`);
        throw rpcError("VALIDATION_FAILED", { reason: TENANT_POLICY_MALFORMED_REASON });
      }
      this.policyCache = parsed as TenantPolicy;
    } else {
      // A MISSING row refuses TOO (2026-08-02 §18). The previous revision special-cased it with a comment
      // asserting it was "genuinely fail-closed: no tenant means no overrides to lose". That was FALSE, and
      // it sat four lines below the guard that exists because the same `{}` is a CEILING: with no row, an
      // append proceeds with dims_required dropped, the geofence widened to the 150m default, and — the
      // irreversible one — every narrowing visibility override gone, stamped permanently onto an immutable
      // event. Proved by probe: with a `visibility.freight.photographed=internal` policy the append stamps
      // `internal`; DELETE the tenants row and the identical append stamps `counterparty`, silently.
      //
      // It is reachable. A STATIC tenant resolves its D1 on the hot path with NO control-plane read
      // (src/tenants.ts TENANT_BINDINGS), so it appends happily with zero control rows; and no migration
      // creates a static tenant's row — `0001` makes the table, `0002` inserts `_platform`, `0003` the pool
      // sentinels. The row is hand-provisioned (tools/deploy/staging-smoke.ts, test/helpers.ts), therefore
      // hand-DELETABLE, by exactly the operator whose hand-corruption the branch above defends against. A
      // control-plane restore or a re-pointed CONTROL_DB binding lands here too.
      //
      // The old split was also internally inconsistent: a missing row is fail-CLOSED for entitlements
      // (#entitlementRow yields plan:"" so hazmat/SKU grant nothing) and was fail-OPEN for gates and
      // visibility. One row, one policy: a tenant the control plane does not know is not a tenant that may
      // append. OPERATIONAL PREREQUISITE this makes load-bearing: every bound tenant needs a `tenants` row
      // before it can append — GO-LIVE-CHECKLIST §1, "Every bound tenant needs a `tenants` control row"
      // (written 2026-08-02 §28: this comment cited that row for ten days before the row existed).
      // ONE carve-out, and only one: the reserved PLATFORM revenue tenant. It is resolved SERVER-SIDE with
      // no slug input, its ledger lives in its own D1 that no customer path can reach (REQ-025), and it has
      // no counterparty lens — so `{}` there widens nothing that anyone outside the platform can read, and
      // requiring a row would couple the credit ledger to whether migration 0002 has run. Every CUSTOMER
      // tenant refuses.
      if (!isPlatformTenant(tenant)) {
        console.error(`sequencer: tenant ${tenant} has NO control-plane row — REFUSING every append until one exists (proceeding on {} would silently widen visibility onto append-only events)`);
        throw rpcError("VALIDATION_FAILED", { reason: TENANT_POLICY_MALFORMED_REASON });
      }
      this.policyCache = {};
    }
    return this.policyCache;
  }

  /** The raw {plan, policy} control row for THIS tenant (the @shuddl/contracts entitlement helpers' input).
   *  #policy — always awaited before any transition gate in #append — populates it; the fail-closed default
   *  (empty plan, {} policy) grants NOTHING, so a gate that reads it before #policy ran refuses rather than
   *  fails open. */
  #entitlementRow(): { plan: string; policy: string } {
    return this.entitlementRowCache ?? { plan: "", policy: "{}" };
  }

  async #deviceKey(tenant: string, deviceId: string): Promise<JsonWebKey | null> {
    const cached = this.deviceKeys.get(deviceId);
    if (cached !== undefined) return cached;
    // The device's public JWK lives on the user that registered it (users.device_keys[]).
    const row = await this.env.CONTROL_DB
      .prepare(
        // REQ-254 (audit §86) — a REVOKED device's key must not verify a signature. Without the
        // `revoked_ts IS NULL` clause, revoking a stolen device removed it from the enrollment surface
        // while this path kept accepting its signed appends: the revocation was cosmetic on the two
        // readers that matter. Mirrors the identical predicate in gate-context's deviceOwnedBy — one rule,
        // both readers (share-lint: if this shape grows a third reader, factor it).
        "SELECT je.value AS entry FROM users u, json_each(u.device_keys) je " +
          "WHERE u.tenant_id = (SELECT id FROM tenants WHERE slug = ?1) AND json_extract(je.value, '$.device_id') = ?2 " +
          "AND json_extract(je.value, '$.revoked_ts') IS NULL LIMIT 1",
      )
      .bind(tenant, deviceId)
      .first<{ entry: string }>();
    // 2026-08-02 §15/§18 — the sibling of the #policy guard above, on the same column class, with an HONEST
    // note on reachability: the catch is defence-in-depth and is probably NOT reachable through this query,
    // because `je.value` comes out of SQLite's json_each and so already parsed as JSON once. A review
    // reverted this guard and the whole api suite still passed, which is true and expected for that half.
    //
    // The `?? null` is the part that earns its place. A key entry missing `public_jwk` previously yielded
    // `undefined`, which is not the same as "no key": it is cached as undefined and handed to the verifier,
    // where the failure mode is a crash rather than a refusal. Collapsing both to null makes an unusable key
    // mean exactly one thing — the signature does not verify — on the DRIVER-AUTH path, where a crash and a
    // bypass are the two outcomes that must never happen.
    let jwk: JsonWebKey | null = null;
    if (row) {
      try {
        const entry = JSON.parse(row.entry) as DeviceKeyEntry;
        jwk = entry?.public_jwk ?? null;
      } catch (err) {
        console.error(`sequencer: tenant ${tenant} device ${deviceId} has a MALFORMED device_keys entry — treating the key as ABSENT (signatures will not verify):`, err);
      }
    }
    this.deviceKeys.set(deviceId, jwk);
    return jwk;
  }
}
