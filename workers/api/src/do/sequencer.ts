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
import { assertPodSigned, type GatePolicy } from "@shuddl/ledger/gates/invoice-gate";
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
  payload: Record<string, unknown>;
}

// The tenant policy JSON (control plane `tenants.policy`): visibility overrides + gate exceptions.
type TenantPolicy = GatePolicy & { visibility?: Record<string, Visibility> };
type DeviceKeyEntry = { device_id: string; public_jwk: JsonWebKey };

const EVENT_COLUMNS = [
  "stream_id", "seq", "id", "shipment_id", "ts", "recorded_at", "kind",
  "actor_party_id", "actor_user_id", "actor_device_id", "party_refs", "payload",
  "evidence", "prev_hash", "hash", "sig", "visibility", "source", "confidence",
  "device_id", "device_seq", "captured_ts",
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

    // Pin (tenant, stream) on first success; later calls must match the pin (defends against a
    // second stream sharing this instance by id collision, and self-documents the binding).
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
    // Idempotency — replay by the offline dedupe key (stream_id, device_id, device_seq).
    if (parsed.device_id !== undefined) {
      const byDevice = await db
        .prepare("SELECT * FROM events WHERE stream_id = ? AND device_id = ? AND device_seq = ?")
        .bind(streamId, parsed.device_id, parsed.device_seq ?? -1)
        .first<Record<string, string | number | null>>();
      if (byDevice) return rowToEvent(byDevice);
    }

    // Device signature (REQ-011/016). A device-actor event must verify against the registered JWK.
    // Server-actor events (no actor.device) carry no signature. verifyEventSig returns false, never throws.
    if (parsed.actor.device !== undefined) {
      const jwk = await this.#deviceKey(tenant, parsed.actor.device);
      if (!jwk || !(await verifyEventSig(parsed, jwk))) throw rpcError("UNAUTHORIZED", { reason: "device signature" });
    }

    const policy = await this.#policy(tenant);
    // I2 — no invoice without a signed POD (or a tenant-exempt service class). Gate BEFORE the append.
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
    return full;
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
