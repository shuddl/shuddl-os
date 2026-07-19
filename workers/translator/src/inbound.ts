// WP-12 Task 8 · REQ-201 / REQ-202 / REQ-196 / REQ-025 / REQ-030 — THE INBOUND 204 HANDLER (the highest-risk
// EDI seam). A partner load tender becomes a booking ONLY through the EXISTING gated pipeline, with ZERO
// bypass. Concretely: this handler appends the SAME chain a CSR produces — quote.requested → quote.priced →
// agent.acted → (approval.requested) → quote.accepted — THROUGH the cross-script api `SHIPMENT_SEQ` DO, and it
// STOPS at quote.accepted. It NEVER appends booking.created and NEVER reimplements the credit / evidence-
// recipient / one-booking-per-stream gate: in production the committed quote.accepted enqueues the UNCHANGED
// Booking agent (workers/agents), which appends the GATED booking.created. A broker tender with no deliverable
// contact → HELD is the gate WORKING, not a bug. This module's job ENDS at quote.accepted.
//
// LAWS THIS MODULE ENFORCES:
//   · NO-BYPASS (REQ-030): the append set is {quote.requested, quote.priced, agent.acted, approval.requested?,
//     quote.accepted}. booking.created is impossible here — it lives behind the DO's #enforceBooking gate, reached
//     only via the Booking agent. quote.accepted is the LAST append this handler ever makes.
//   · AUTHENTICATED BY THE PARTNER'S SHARED SECRET, not a JWT: HMAC-SHA256 over the RAW body, verified against
//     the control-plane pairing's `secret_ref` (kind='edi', status='active'). A bad/missing signature, an unknown
//     partner, or an unresolvable secret ⇒ 401 with NOTHING written (fail-closed).
//   · NEVER A SILENT DROP (Migrator rule / CLAUDE.md #10): a malformed / non-priceable tender is QUARANTINED
//     (an idempotent anomalies row + the raw bytes in R2) and ACKed 200 — never dropped, never a retry-storm.
//     Every N1/N3/N4 firm name + postal address the wire carried is persisted (parties.addresses + shipments.refs).
//   · IDEMPOTENT under redelivery (make-agent-idempotent doctrine): the shipment id + EVERY append's event id are
//     deterministic in the tender, so a redelivered 204 reproduces the SAME ids → the DO dedupes → no duplicate
//     shipment, no duplicate append (the api sequencer's dedupe-by-id + REQ-191 one-booking-per-stream hold).
//   · TENANT-ISOLATED (REQ-025): the resolved tenant's D1 handle + `edi/<tenant>/…` R2 keys only, throughout.
//
// The X12 parse (tokenize/parse204), the 204→plan mapping (mapTenderToBooking), the quarantine descriptor, and
// the 990 serialize are the PURE @shuddl/edi + Task-6 cores; this file is composition + I/O wiring only. LLM-free.
import { parse204, tokenize, build990 } from "@shuddl/edi";
import { priceShipment, assessApproval } from "@shuddl/rater";
import type { RateRequest } from "@shuddl/rater";
import { mapTenderToBooking, type BookingPlan } from "./core/map-204.js";
import { quarantineDescriptor } from "./core/quarantine.js";
import { tenderKey, gsControlFromIsa } from "./sweep-214.js";
import { loadTenantRatingConfig } from "./rate-config.js";
import { TransportError, type EdiTransport } from "./transport.js";

// ── ports (the composition root injects the live wiring; tests inject recording/static fakes) ──────────────

// The api sequencer DO append surface, hand-written for the SAME reason the api routes bind SeqStub and the
// agents worker binds SeqStubLike: the generic DurableObjectStub RPC mapper explodes on the recursive event
// union. Only `id` is consumed. In production this routes to `env.SHIPMENT_SEQ.get(idFromName(...)).append(...)`.
export interface SeqStubLike {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }>;
}

// Resolves the actual HMAC secret bytes from a pairing's `secret_ref`. Mirrors the transport/sender port
// discipline: the DEFAULT composition-root resolver is NotConfigured (fail-closed — no environment authenticates
// a real 204 until the CONFIRM-gated partner secret store is wired), and a StaticSecretResolver serves tests/dev.
export interface SecretResolver {
  resolve(secretRef: string): Promise<string | null>;
}

// Fail-closed default: resolves NOTHING, so every 204 401s until the CONFIRM-gated secret store is wired (the
// symmetric twin of NotConfiguredTransport keeping outbound EDI fail-closed). The handler LOGIC ships fully
// tested via an injected resolver; going live is a config flip, not code.
export class NotConfiguredSecretResolver implements SecretResolver {
  async resolve(_secretRef: string): Promise<string | null> {
    return null;
  }
}

// The tests/dev resolver: an explicit secret_ref → secret map. Never a real credential.
export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly secrets: Record<string, string>) {}
  async resolve(secretRef: string): Promise<string | null> {
    return this.secrets[secretRef] ?? null;
  }
}

export interface InboundDeps {
  /** The control plane (pairings + tenants) — auth resolution ONLY; never a tenant data path (REQ-025). */
  controlDb: D1Database;
  /** Resolve a tenant slug → its OWN D1 handle (the allowlist; the ONLY tenant→D1 map — REQ-025). */
  tenantDbFor: (slug: string) => D1Database;
  /** EDI markers + quarantine bytes live under the `edi/<tenant>/…` R2 prefix. */
  evidence: R2Bucket;
  /** The api sequencer DO append surface (the ONLY event write path — the gates + projections run there). */
  seq: SeqStubLike;
  /** The outbound 990 acknowledgment port (best-effort; NotConfigured no-ops safely). */
  transport: EdiTransport;
  /** Resolves a pairing's secret_ref → the HMAC secret. */
  secrets: SecretResolver;
  /** The arrival clock (kept injectable so the core stays deterministic-friendly and tests are stable). */
  now: () => number;
}

// The webhook auth headers: the partner names its pairing id (= its edi_partner integration id, so the 214
// sweep resolves the SAME id) and presents an HMAC-SHA256 of the raw body, hex-encoded.
export const EDI_PARTNER_HEADER = "X-Shuddl-Edi-Partner";
export const EDI_SIGNATURE_HEADER = "X-Shuddl-Edi-Signature";
export const INBOUND_204_PATH = "/edi/204/inbound";

const NATIVE_CONFIDENCE_BPS = 10_000; // a deterministic rule engine, full capture confidence (mirrors rate.ts).
const RATER_ACTOR = "agent:rater"; // server-controlled sentinel; none of these events accrue a parties FK.

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function unauthorized(): Response {
  // Deliberately terse — an unauthenticated caller learns nothing about which check failed.
  return json(401, { error: "unauthorized" });
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A deterministic v4-variant UUID from a domain-separated seed — the SAME shaping map-204 / rate.ts /
// portal-actions use, so a redelivered 204 reproduces the SAME event id and the sequencer dedupes by id.
async function deterministicUuid(seed: string): Promise<string> {
  const h = (await sha256Hex(seed)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// HMAC-SHA256(secret, body) as lowercase hex.
async function hmacHex(secret: string, body: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish hex compare: length check + full char sweep (never short-circuit on the first mismatch).
// A timing side channel on an auth gate is not worth leaving open even for a webhook secret.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface ResolvedPartner {
  partnerId: string;
  tenantSlug: string;
}

// AUTH: resolve the active EDI pairing named in the header, resolve its secret, and verify the HMAC over the
// RAW body. Returns the (partnerId, tenantSlug) on success; null (⇒ 401, nothing written) on ANY failure —
// missing headers, unknown/inactive pairing, unresolvable tenant/secret, or a signature mismatch. Fail-closed.
async function authenticate(request: Request, rawBytes: ArrayBuffer, deps: InboundDeps): Promise<ResolvedPartner | null> {
  const partnerHeader = request.headers.get(EDI_PARTNER_HEADER);
  const signatureHeader = request.headers.get(EDI_SIGNATURE_HEADER);
  if (partnerHeader === null || partnerHeader === "" || signatureHeader === null || signatureHeader === "") return null;

  const pairing = await deps.controlDb
    .prepare(
      "SELECT p.id AS partner_id, p.secret_ref AS secret_ref, t.slug AS slug FROM pairings p " +
        "JOIN tenants t ON t.id = p.tenant_id WHERE p.id = ?1 AND p.kind = 'edi' AND p.status = 'active' LIMIT 1",
    )
    .bind(partnerHeader)
    .first<{ partner_id: string; secret_ref: string; slug: string }>();
  if (pairing === null) return null;

  const secret = await deps.secrets.resolve(pairing.secret_ref);
  if (secret === null || secret === "") return null;

  const expected = await hmacHex(secret, rawBytes);
  if (!timingSafeEqual(expected, signatureHeader.trim().toLowerCase())) return null;

  return { partnerId: pairing.partner_id, tenantSlug: pairing.slug };
}

// A strict non-negative integer from an X12 element (no float, no hex, no exponent — mirrors parse-204's AT8
// discipline: a bogus value stays UNDEFINED so it never fabricates a price input).
function strictInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

// Extract the MEASURED dims the rater's "no price on air" gate requires (l/w/h + piece count) from the raw 204.
// parse-204 (a Task-6 core, out of this task's scope to change) extracts weight but not dims, so this reads them
// HERE from the standard 204 measurement segments: L4 (Measurement) = length/width/height in inches, and the AT8
// lading quantity (AT804) = the piece count. A tender missing ANY of these is NOT priceable → the handler rests
// it at quote.requested (no price on air — CLAUDE.md #4), never fabricating a dimension the wire did not carry.
// Per-partner dims mapping variance is a certification-time concern (Task 9); this is the baseline 004010 reading.
function extractWireDims(raw: string): { l_in: number; w_in: number; h_in: number; pieces: number } | undefined {
  let segments: { tag: string; elements: string[] }[];
  try {
    segments = tokenize(raw).segments;
  } catch {
    return undefined;
  }
  let lIn: number | undefined;
  let wIn: number | undefined;
  let hIn: number | undefined;
  let pieces: number | undefined;
  for (const s of segments) {
    if (s.tag === "L4") {
      lIn = strictInt(s.elements[0]);
      wIn = strictInt(s.elements[1]);
      hIn = strictInt(s.elements[2]);
    } else if (s.tag === "AT8") {
      pieces = strictInt(s.elements[3]); // AT804 — lading quantity (handling units)
    }
  }
  if (lIn === undefined || wIn === undefined || hIn === undefined || pieces === undefined || pieces < 1) return undefined;
  return { l_in: lIn, w_in: wIn, h_in: hIn, pieces };
}

// Best-effort ISA13 for the quarantine/marker keys: the real interchange control when tokenize succeeds, else a
// DETERMINISTIC fallback of the raw bytes so a redelivery of the identical malformed doc collapses to the same
// anomaly row + R2 key (idempotent). Never throws.
async function extractIsaControl(raw: string): Promise<string> {
  try {
    const control = tokenize(raw).isaControl;
    if (control !== "") return control;
  } catch {
    // fall through to the deterministic fallback
  }
  return `nohdr_${(await sha256Hex(raw)).slice(0, 40)}`;
}

// QUARANTINE: an idempotent anomalies row (INSERT OR IGNORE on the deterministic id) + the raw bytes in R2,
// then ACK 200. A malformed/non-priceable tender is NEVER dropped and NEVER retry-stormed back at the partner.
async function quarantine(
  deps: InboundDeps,
  tenantSlug: string,
  partnerId: string,
  isaControl: string,
  rawBytes: ArrayBuffer,
  err: unknown,
): Promise<Response> {
  const r2Key = `edi/${tenantSlug}/quarantine/${partnerId}/${isaControl}`;
  const descriptor = quarantineDescriptor({
    partnerId,
    isaControl,
    docType: "204",
    parseError: err instanceof Error ? err.message : String(err),
    r2Key,
  });
  const db = deps.tenantDbFor(tenantSlug);
  await db
    .prepare("INSERT OR IGNORE INTO anomalies (id, rule, object_kind, object_id, severity, detail) VALUES (?,?,?,?,?,?)")
    .bind(descriptor.anomalyId, descriptor.rule, descriptor.objectKind, descriptor.objectId, descriptor.severity, JSON.stringify(descriptor.detail))
    .run();
  await deps.evidence.put(r2Key, rawBytes);
  return json(200, { status: "quarantined", anomaly_id: descriptor.anomalyId });
}

// Persist the tendering party (bill-to, else shipper) idempotently. The three shipment FKs all self-reference
// this ONE party (the map-204 / Concierge precedent: the real shipper/consignee firm up at BOOKING via a party-
// correction) — so the shipper/consignee firm NAMES + every N1/N3/N4 postal address the wire carried are
// preserved on parties.addresses as role-tagged entries: nothing the wire carried is silently dropped
// (Migrator rule / CLAUDE.md #10). Mirrors intake.ts's INSERT OR IGNORE + names/contacts shape (REQ-196).
async function persistParty(db: D1Database, plan: BookingPlan): Promise<void> {
  const names = JSON.stringify({ legal: plan.party.name });
  const contacts = JSON.stringify(plan.party.email !== undefined ? [{ kind: "primary", email: plan.party.email }] : []);
  const addressBook: Array<Record<string, unknown>> = [];
  if (plan.addresses.billTo !== undefined) addressBook.push({ role: "bill_to", name: plan.party.name, ...plan.addresses.billTo });
  if (plan.stops.shipper !== undefined) addressBook.push({ role: "shipper", name: plan.stops.shipper.name, ...plan.stops.shipper.address });
  if (plan.stops.consignee !== undefined) addressBook.push({ role: "consignee", name: plan.stops.consignee.name, ...plan.stops.consignee.address });
  await db
    .prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts, addresses) VALUES (?,?,?,?,?)")
    .bind(plan.party.id, plan.party.kind, names, contacts, JSON.stringify(addressBook))
    .run();
}

// Materialize the QUOTE-STAGE shipments row (NO booking.created, status_cache at its empty default) so the
// first REAL booking is still first on the stream (the WP-09 one-booking-per-stream gate stays green). Mirrors
// intake.ts's INSERT OR IGNORE shape; the partner SCAC + every tender ref are recorded in refs (no drop).
async function persistShipment(db: D1Database, plan: BookingPlan, createdTs: number): Promise<void> {
  const refs = JSON.stringify({ ...plan.shipment.refs, partner: plan.shipment.partnerScac });
  await db
    .prepare(
      "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, mode, division, refs, created_ts) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(plan.shipment.id, plan.shipment.shipperPartyId, plan.shipment.consigneePartyId, plan.shipment.billToPartyId, "brokered", "main", refs, createdTs)
    .run();
}

// THE MAIN HANDLER. See the file header for the no-bypass contract. Structured in two phases so a retry is safe:
//   1. AUTH → PARSE/MAP (pure): a bad secret ⇒ 401 (nothing written); a parse/map failure ⇒ quarantine + 200.
//   2. PERSIST → APPEND (I/O): all idempotent (INSERT OR IGNORE + deterministic event ids), so a transient
//      fault surfaces as 500 and a partner retry re-runs the whole handler with no duplicate shipment/append.
export async function handleInbound204(request: Request, deps: InboundDeps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method not allowed" });

  const rawBytes = await request.arrayBuffer();

  // 1a. AUTH — HMAC over the raw body. Before this returns, NOTHING is written (bad-secret ⇒ 401, clean).
  const partner = await authenticate(request, rawBytes, deps);
  if (partner === null) return unauthorized();
  const { partnerId, tenantSlug } = partner;

  const raw = new TextDecoder().decode(rawBytes);
  const isaControl = await extractIsaControl(raw);
  const receivedTs = deps.now();

  // 1b. PARSE + MAP (pure). An EdiParseError, a non-priceable tender (MAP204_NO_LANE), or any other pure-core
  //     failure is a DETERMINISTIC bad document — quarantine + 200, never a 5xx retry-storm and never a shipment.
  let plan: BookingPlan;
  try {
    const tender = parse204(raw);
    plan = await mapTenderToBooking(tender, { partnerId, isaControl, receivedTs });
  } catch (err) {
    return quarantine(deps, tenantSlug, partnerId, isaControl, rawBytes, err);
  }

  // 2. PERSIST + APPEND. A fault here (D1/DO transient) throws → 500 → the partner retries; every write is
  //    idempotent so the retry produces no duplicate. The append set stops at quote.accepted (no-bypass).
  const db = deps.tenantDbFor(tenantSlug);
  const streamId = `s:${plan.shipment.id}`;

  await persistParty(db, plan);
  await persistShipment(db, plan, receivedTs);

  // The tender marker the 214 sweep reads to learn which shipments are EDI-tendered + by whom (its schema is
  // fixed: {partnerId, partnerScac, isaControl}). Written idempotently before the appends so the sweep can find
  // the shipment even if a later append faults and the partner retries.
  await deps.evidence.put(
    tenderKey(tenantSlug, plan.shipment.id),
    JSON.stringify({ partnerId, partnerScac: plan.shipment.partnerScac, isaControl }),
  );

  // 2a. quote.requested — the map-204 core already built this valid edi-source append (source:"edi"). It is the
  //     record that the tender arrived; append it FIRST, exactly as the Concierge appends quote.requested.
  const requestedEvent = plan.appends[0];
  if (requestedEvent === undefined || requestedEvent.kind !== "quote.requested") {
    // A defensive assertion, not a data path: mapTenderToBooking always yields exactly one leading quote.requested.
    throw new Error("EDI_PLAN_SHAPE: mapTenderToBooking must yield a leading quote.requested append");
  }
  await deps.seq.append({ tenant: tenantSlug, streamId, input: requestedEvent });

  // 2b. PRICE + append quote.priced → agent.acted → (approval.requested) → quote.accepted, MIRRORING the CSR
  //     /v1/rate + accept-quote payloads EXACTLY so a 204 booking is byte-identical to a CSR one. No tariff or an
  //     UNKNOWN price ⇒ the tender rests at quote.requested (no price on air) and no quote.accepted is appended.
  const config = await loadTenantRatingConfig(db, receivedTs);
  let accepted = false;
  if (config !== null) {
    // The pricing request = the mapped lane+weight PLUS the measured dims read from the wire (parse-204 does not
    // extract dims). The rater's dims-presence gate is "no price on air": a dims-less tender prices UNKNOWN and
    // rests at quote.requested. The dims are server-sourced measured physics, never fabricated.
    const wireDims = extractWireDims(raw);
    const rateRequest: RateRequest = { ...requestedEvent.payload.request, ...(wireDims !== undefined ? { dims: wireDims } : {}) };
    const quote = priceShipment(rateRequest, config);
    if (quote.status === "PRICED") {
      const pricedId = await deterministicUuid(`edi:quote-priced:${plan.shipment.id}`);
      const acceptedId = await deterministicUuid(`edi:quote-accepted:${pricedId}`);

      // quote.priced — byte-identical to rate.ts: the sell, the itemized breakdown the invoice projects (Σ ===
      // sell), the three floors, the pinned config versions (I5), and the audit basis carrying the REQ-040 anomaly.
      await deps.seq.append({
        tenant: tenantSlug,
        streamId,
        input: {
          id: pricedId,
          shipment_id: plan.shipment.id,
          ts: receivedTs,
          actor: { party: RATER_ACTOR },
          party_refs: [],
          evidence: [],
          source: "native",
          confidence: NATIVE_CONFIDENCE_BPS,
          kind: "quote.priced",
          payload: {
            sell: quote.sell_cents,
            lines: quote.lines.map((l) => ({ kind: l.kind, code: l.code, amount_cents: l.amount_cents })),
            floors: quote.floors,
            versions: quote.versions,
            basis: { ...quote.basis, anomaly: quote.anomaly },
          },
        },
      });

      // agent.acted — REQ-005 provenance, byte-identical to rate.ts: the rater cites the quote.priced it produced
      // plus every rate_config version it priced against (≥1 link). cost 0 (a deterministic engine, honest 0),
      // latency the real measured wall-clock (non-determinism is harmless: the DO dedupes agent.acted by its id).
      await deps.seq.append({
        tenant: tenantSlug,
        streamId,
        input: {
          id: await deterministicUuid(`edi:agent-acted:${plan.shipment.id}`),
          shipment_id: plan.shipment.id,
          ts: receivedTs,
          actor: { party: RATER_ACTOR },
          party_refs: [],
          evidence: [],
          source: "native",
          confidence: NATIVE_CONFIDENCE_BPS,
          kind: "agent.acted",
          payload: {
            agent: "rater",
            action: "priced",
            basis: [{ kind: "event", id: pricedId }, ...quote.versions.rate_config_ids.map((id) => ({ kind: "config", id }))],
            confidence_bps: NATIVE_CONFIDENCE_BPS,
            cost_cents: 0,
            latency_ms: Math.max(0, deps.now() - receivedTs),
          },
        },
      });

      // approval.requested — the below-floor gate, recorded server-side EXACTLY as rate.ts does (REQ-030). A 204
      // carries no negotiated sell / interline legs, so assessApproval judges the quoted sell directly. This does
      // NOT block the accept (the CSR flow doesn't either — the below-floor approval is a human queue concern, not
      // the booking gate); it is recorded so the ops queue surfaces it, then the chain proceeds to quote.accepted.
      const decision = assessApproval(quote, {});
      if (decision.approval !== "none") {
        await deps.seq.append({
          tenant: tenantSlug,
          streamId,
          input: {
            id: await deterministicUuid(`edi:approval-requested:${plan.shipment.id}`),
            shipment_id: plan.shipment.id,
            ts: receivedTs,
            actor: { party: RATER_ACTOR },
            party_refs: [],
            evidence: [],
            source: "native",
            confidence: NATIVE_CONFIDENCE_BPS,
            kind: "approval.requested",
            payload: {
              rule: decision.rule,
              required_role: decision.required_role,
              approvals_required: decision.approvals_required,
              evaluated_sell_cents: decision.evaluated_sell_cents,
              gross_sell_cents: decision.gross_sell_cents,
              executing_share_bps: decision.executing_share_bps,
            },
          },
        });
      }

      // quote.accepted — THE LAST APPEND. Byte-identical to accept-quote's payload ({quote_event_id}); the
      // accepting party is the tendering counterparty. A COMMITTED quote.accepted enqueues the UNCHANGED Booking
      // agent in production, which appends the GATED booking.created. THIS HANDLER APPENDS NOTHING FURTHER.
      await deps.seq.append({
        tenant: tenantSlug,
        streamId,
        input: {
          id: acceptedId,
          shipment_id: plan.shipment.id,
          ts: receivedTs,
          actor: { party: plan.party.id },
          party_refs: [plan.party.id],
          evidence: [],
          source: "native",
          confidence: NATIVE_CONFIDENCE_BPS,
          kind: "quote.accepted",
          payload: { quote_event_id: pricedId },
        },
      });
      accepted = true;

      // 3. 990 acceptance — best-effort through the transport port (idempotency-keyed on the accepted quote). With
      //    NotConfiguredTransport this REJECTS and is swallowed here (the 204 is recorded + its chain appended;
      //    only the partner acknowledgment is deferred until the CONFIRM-gated transport is wired). Any transport
      //    failure is logged + swallowed — the same fail-closed discipline the 214 sweep uses.
      try {
        const bytes = build990({
          shipmentRef: plan.shipment.id,
          partnerScac: plan.shipment.partnerScac,
          isaControl,
          gsControl: gsControlFromIsa(isaControl),
          action: "A",
        });
        await deps.transport.send990(plan.shipment.partnerScac, bytes, `edi990/${acceptedId}`);
      } catch (err) {
        if (!(err instanceof TransportError)) throw err; // a serialize bug is loud; a transport reject is expected
        console.error(`204-inbound: 990 ack for ${plan.shipment.id} not transmitted (transport unwired/failed — the 204 is recorded):`, err.message);
      }
    }
  }

  return json(200, { status: accepted ? "accepted" : "recorded", shipment_id: plan.shipment.id });
}
