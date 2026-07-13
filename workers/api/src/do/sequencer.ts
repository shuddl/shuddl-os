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
import { assertPodSigned } from "@shuddl/ledger/gates/invoice-gate";
import {
  assertPickupDepart,
  assertDelivery,
  assertInterline,
  assertException,
  assertConsentBeforeGps,
  type Fence,
  type GateCtx,
} from "@shuddl/ledger/gates/transition-gates";
import { deriveOperatingState } from "@shuddl/ledger/geo/jurisdiction";
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
    await this.#enforceTransitionGate(db, streamId, event, policy);

    const hash = await hashEvent(event);
    const full = { ...event, hash } as LedgerEvent;

    // ONE batch — event + money lines + passport counters + status_cache. A projection failure (e.g. a
    // missing parties FK, or a second correction of the same event) aborts the WHOLE append atomically.
    const deps = await this.#moneyDeps(db, full);
    const stmts = [
      insertEventStmt(db, full),
      ...applyMoneyProjection(db, full, deps),
      ...projectPassport(db, full),
      ...projectStatusCache(db, full),
    ];
    try {
      await db.batch(stmts);
    } catch (err) {
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
    return full;
  }

  // ---- Gatekeeper transition gates (REQ-044/045/046/049/050/166) --------------------------------
  // Calls the matching PURE gate with SERVER-SOURCED context BEFORE the append. A block throws
  // GateError (→ GATE_BLOCKED:{required_evidence}) or GateValidationError (→ VALIDATION_FAILED:{reason});
  // either aborts the append before any write, so an evidence-short transition can NEVER be appended
  // via any API path (REQ-030). `event.override` (REQ-049), when accountable, releases the gate and is
  // persisted on the event (override_json). The prior stream is loaded LAZILY and at most once, so only
  // the gates that inspect prior events pay for the read — the exception gate reads only `incoming`.
  async #enforceTransitionGate(db: D1Database, streamId: string, incoming: LedgerEvent, policy: TenantPolicy): Promise<void> {
    if (!isGatedKind(incoming.kind)) return;

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
        return;
      case "delivery.evidenced": {
        // REQ-046. fence sourced from the delivery leg's dest geo + a policy radius (server-side). When
        // no fence is provisioned it is OMITTED (not passed as undefined); the gate reads ctx.fence as
        // absent and fails loud (GateValidationError → 400), exactly as if it were undefined.
        const fence = await this.#deliveryFence(db, shipmentId, policy);
        assertDelivery(await prior(), incoming, fence !== undefined ? { ...ctx, fence } : ctx);
        return;
      }
      case "custody.transferred": {
        // REQ-045. isInterline sourced from the shipment legs (server-side), never the client event.
        const isInterline = await this.#isInterline(db, shipmentId);
        assertInterline(await prior(), incoming, isInterline, ctx);
        return;
      }
      case "exception.raised":
      case "osd.captured":
        assertException(incoming, ctx); // REQ-050 — photo + reason_code, read from `incoming` only (no prior load)
        return;
      case "stop.arrived":
        // REQ-166 consent-before-GPS. The operating state is DERIVED SERVER-SIDE from the stamp's raw
        // coordinates (deriveOperatingState) — the client supplies geo, the server decides the state, so
        // the state is not a client-supplied CLAIM. But server-derived ≠ authoritative: the coarse box
        // lookup is a documented stub (a precise point-in-polygon reverse-geocode is the WP-08
        // refinement), and legal sufficiency of any consent is [CONFIRM]/counsel. This gate takes NO
        // override — consent is a legal precondition, not a waivable evidence requirement.
        assertConsentBeforeGps(await prior(), incoming, { operating_state: deriveOperatingState(incoming.payload.geo) });
        return;
      default:
        // A GatedKind with no case above = a Set/switch desync. `assertNever` makes that a COMPILE error
        // (belt) and throws at runtime (suspenders) — never a silent fall-through to an ungated append.
        return assertNever(incoming.kind);
    }
  }

  // fence: the delivery leg's dest geo (doc 10 §03 legs.geo) + a policy radius (DEFAULT_FENCE_RADIUS_M
  // if unset). Real per-stop fences are provisioned by booking (WP-08); the tests seed the delivery
  // leg. NEVER from the incoming event. Returns undefined when no delivery leg / no coords exists — the
  // gate then fails LOUD (GateValidationError → 400): a geofence cannot be judged with no fence.
  async #deliveryFence(db: D1Database, shipmentId: string | undefined, policy: TenantPolicy): Promise<Fence | undefined> {
    if (shipmentId === undefined) return undefined;
    const row = await db
      .prepare("SELECT geo FROM legs WHERE shipment_id = ? AND kind = 'delivery' ORDER BY seq LIMIT 1")
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
