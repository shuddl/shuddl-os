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
import { parseTenantPolicy, describeTenantPolicyRejection, isUnknownTenant } from "@shuddl/contracts";
import { parse204, tokenize, build990 } from "@shuddl/edi";
import type { TenderDoc } from "@shuddl/edi";
import { priceShipment, assessApproval } from "@shuddl/rater";
import type { RateRequest } from "@shuddl/rater";
import { authoritativeSource, resolveAuthority } from "@shuddl/ledger/authority";
import { mapTenderToBooking, LOAD_UNIQUE_REF_KEYS, ORDER_LEVEL_REF_KEYS, type BookingPlan } from "./core/map-204.js";
import { quarantineDescriptor, type QuarantineRule } from "./core/quarantine.js";
import { tenderKey } from "./sweep-214.js";
import { allocatePartnerControls, PartnerControlError } from "./partners.js";
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
  /** ASYNC since 2026-08-01 (§11): a CLAIMED pool tenant resolves through the control plane. */
  tenantDbFor: (slug: string) => Promise<D1Database>;
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

// Storage-DoS cap (REQ-202): a real X12 204 is a few KB; 1 MiB is generous. An over-cap body is rejected 413
// BEFORE any read/persist, so an authed partner cannot spray unbounded R2 quarantine objects + anomaly rows.
const MAX_BODY_BYTES = 1_048_576;

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
// then ACK 200. A malformed / no-stable-ref tender is NEVER dropped and NEVER retry-stormed back at the partner.
// The R2 payload is capped defensively (the body is already ≤ MAX_BODY_BYTES; this is belt-and-suspenders).
async function quarantine(
  deps: InboundDeps,
  // The ALREADY-RESOLVED tenant handle (2026-08-01 §12). This used to re-resolve through
  // deps.tenantDbFor — an in-memory map lookup before the claimed-tenant work, but a live control-plane
  // query after it. A blip in that window turned this module's law ("a malformed tender is QUARANTINED
  // and ACKed 200 — never dropped, never a retry-storm") into a 500 the partner retries forever on a
  // document that can never parse. Both callers already hold the handle.
  db: D1Database,
  tenantSlug: string,
  partnerId: string,
  isaControl: string,
  rawBytes: ArrayBuffer,
  err: unknown,
  rule: QuarantineRule,
): Promise<Response> {
  const r2Key = `edi/${tenantSlug}/quarantine/${partnerId}/${isaControl}`;
  const descriptor = quarantineDescriptor({
    partnerId,
    isaControl,
    docType: "204",
    parseError: err instanceof Error ? err.message : String(err),
    r2Key,
    rule,
  });
  await db
    .prepare("INSERT OR IGNORE INTO anomalies (id, rule, object_kind, object_id, severity, detail) VALUES (?,?,?,?,?,?)")
    .bind(descriptor.anomalyId, descriptor.rule, descriptor.objectKind, descriptor.objectId, descriptor.severity, JSON.stringify(descriptor.detail))
    .run();
  const capped = rawBytes.byteLength > MAX_BODY_BYTES ? rawBytes.slice(0, MAX_BODY_BYTES) : rawBytes;
  await deps.evidence.put(r2Key, capped);
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

// CONVERGENCE (F-1, corrected): resolve the CANONICAL shipment id for THIS tender — the id of a PRIOR shipment
// from the same partner that shares a QUALIFIED (qualifier,value) LOAD-UNIQUE ref (SID/BM/PRO). ORDER-LEVEL refs
// (PO) are DELIBERATELY EXCLUDED: one PO spans many truckloads, so converging on a shared PO would silently merge
// two DISTINCT loads and drop the second (a silent freight drop — worse than a duplicate; CLAUDE.md #10). Match
// ONLY on the qualified pair (partner + `$.<QUAL>` = value), never a bare value.
//   AMBIGUITY GUARD: collect the DISTINCT candidate shipment ids across the tender's load-unique refs. Exactly
//   ONE ⇒ converge onto it. ZERO ⇒ no convergence (a fresh id). ≥2 (a tender bridging two prior shipments — a
//   data anomaly) ⇒ do NOT converge; the caller mints fresh (conservative: a visible possible-duplicate beats a
//   WRONG merge). Tenant-isolated: `db` is the resolved tenant's handle; the ref keys are a fixed constant list,
//   so the bound `$.<QUAL>` path is injection-safe.
async function resolveCanonicalShipmentId(db: D1Database, partnerId: string, tender: TenderDoc): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const key of LOAD_UNIQUE_REF_KEYS) {
    const value = tender.refs[key]?.trim();
    if (value === undefined || value === "") continue;
    const rows = await db
      .prepare("SELECT id FROM shipments WHERE json_extract(refs, '$.partner') = ?1 AND json_extract(refs, ?2) = ?3")
      .bind(partnerId, `$.${key}`, value)
      .all<{ id: string }>();
    for (const r of rows.results) candidates.add(r.id);
  }
  if (candidates.size === 1) return [...candidates][0];
  if (candidates.size >= 2) {
    console.error(
      `204-inbound: AMBIGUOUS convergence for partner ${partnerId} — ${candidates.size} candidate shipments (${[...candidates].join(", ")}) share this tender's load-unique refs; NOT merging (minting fresh — a visible possible-duplicate beats a wrong merge)`,
    );
  }
  return undefined;
}

// ORDER-LEVEL-ONLY id (F-1 corrected, seed half): a tender whose ONLY stable ref is order-level (PO) has NO load
// identity, so two such tenders are DISTINCT loads by default. Seed the id with the interchange control as a
// per-delivery discriminator, so two distinct deliveries on one PO become two shipments (prefer a VISIBLE
// duplicate over a SILENT drop) while a same-interchange retry still reproduces the id (idempotent). Returns
// undefined when the tender carries no order-level ref either (⇒ map-204 throws MAP204_NO_SHIPMENT_REF → quarantine).
async function orderLevelOnlyShipmentId(partnerId: string, tender: TenderDoc, isaControl: string): Promise<string | undefined> {
  for (const key of ORDER_LEVEL_REF_KEYS) {
    const value = tender.refs[key]?.trim();
    if (value === undefined || value === "") continue;
    return `shp_${(await sha256Hex(`edi:shipment:${partnerId}:${key}:${value}:${isaControl}`)).slice(0, 16)}`;
  }
  return undefined;
}

// Materialize the QUOTE-STAGE shipments row (NO booking.created, status_cache at its empty default) so the
// first REAL booking is still first on the stream (the WP-09 one-booking-per-stream gate stays green). Mirrors
// intake.ts's INSERT OR IGNORE shape. `refs.partner` is the PARTNER ID (the convergence key above matches it);
// `refs.partner_scac` preserves the tender's carrier SCAC (no drop), and every tender qualifier rides through.
async function persistShipment(db: D1Database, plan: BookingPlan, partnerId: string, createdTs: number): Promise<void> {
  const refs = JSON.stringify({ ...plan.shipment.refs, partner: partnerId, partner_scac: plan.shipment.partnerScac });
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

  // 0. STORAGE-DOS CAP (REQ-202) — reject an over-cap body up front, BEFORE reading/auth/persist. A declared
  //    Content-Length over the ceiling is refused without reading the stream; the post-read byteLength check is
  //    the belt for a chunked/absent Content-Length. Nothing is written on a 413.
  const declaredLen = request.headers.get("content-length");
  if (declaredLen !== null && Number.isFinite(Number(declaredLen)) && Number(declaredLen) > MAX_BODY_BYTES) {
    return json(413, { error: "payload too large" });
  }
  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength > MAX_BODY_BYTES) return json(413, { error: "payload too large" });

  // 1a. AUTH — HMAC over the raw body. Before this returns, NOTHING is written (bad-secret ⇒ 401, clean).
  const partner = await authenticate(request, rawBytes, deps);
  if (partner === null) return unauthorized();
  const { partnerId, tenantSlug } = partner;

  // Decoded + ISA extracted BEFORE tenant resolution (§29): both are PURE (no db, no control plane), and
  // the resolution guard below needs the ISA to key the preserved bytes so a redelivery overwrites rather
  // than accumulating one R2 object per attempt.
  const raw = new TextDecoder().decode(rawBytes);
  const isaControl = await extractIsaControl(raw);

  // 2026-08-02 §29 — RESOLUTION IS ALSO A DETERMINISTIC REFUSAL, and it runs BEFORE the policy preflight.
  //
  // §19 added a preflight so a corrupt control row quarantines instead of 500ing the VAN. It was placed
  // beside the cert gate, 36 lines below here — and for a STATIC-roster tenant that is fine, because
  // `tenantDbFor` is a pure map lookup that cannot throw. For a CLAIMED POOL tenant it is
  // `resolveClaimedTenantDb`, which reads THE SAME `tenants.policy` and throws `UNKNOWN_TENANT` when the
  // policy is unparseable or names no valid `pool_binding`. So the exact condition the preflight exists to
  // catch still reached the runtime as a 500 — and 500 is what a VAN retries forever. The §19 test only
  // exercised the static path, which is why it passed while this hole stayed open. (Dark today behind
  // `PROVISIONING_ENABLED`; the harm is the storm, not lost data — nothing is written before this line.)
  //
  // It CANNOT quarantine: quarantine writes an anomalies row to the tenant's own D1, which is precisely what
  // failed to resolve. So the honest answer is a deterministic 4xx — no retry, nothing written, and a loud
  // server-side log naming the tenant. That matches how this handler already treats an unresolvable tenant
  // at auth (401), and it keeps the one law that matters here: a deterministic condition never returns 5xx.
  let db: D1Database;
  try {
    db = await deps.tenantDbFor(tenantSlug);
  } catch (err) {
    // DISCRIMINATE ON THE ERROR, not on where it was thrown (2026-08-02 §36). The first cut caught EVERY
    // throw from tenantDbFor and answered 422 — but that call also does a LIVE control-plane D1 read, so a
    // transient blip on a perfectly HEALTHY claimed tenant produced a PERMANENT refusal (a VAN does not
    // retry a 422) plus a tender preserved only under an R2 prefix nothing enumerates. A lost freight tender
    // from a network hiccup: the exact "worse of the two failures" this guard was added to avoid.
    //
    // §34 wrote the escape condition — "if a future change makes this branch reachable for a HEALTHY tenant,
    // that reasoning evaporates" — and missed that no future change was needed; it was already reachable.
    // It was also internally inconsistent: §31 had just added `isTenantPolicyRefusal` so the agents consumer
    // could tell deterministic from retriable BY INSPECTING THE ERROR, and this guard classified by position.
    //
    // A transient fault now RETHROWS → 5xx → the VAN retries, which is the correct answer for the one
    // condition a retry can actually fix.
    if (!isUnknownTenant(err)) throw err;
    // NO DATA LOSS — but NOT a full quarantine, and the difference is stated rather than glossed (§34).
    //
    // The first cut of this guard returned 422 and discarded the tender, trading a retry-storm for a LOST
    // DOCUMENT — the worse failure, and the one CLAUDE.md #10 / the Migrator rule and this module's own
    // header forbid. The raw bytes are now preserved, and they do not need the tenant D1: the R2 key is
    // keyed by slug alone.
    //
    // What this does NOT do is what `quarantine()` does — write an `anomalies` row. It cannot: that row
    // lives in the tenant D1, which is precisely what failed to resolve. So the tender survives but does NOT
    // surface on the exceptions queue; the only active signal is the loud log below. That is an honest
    // partial: the DATA-LOSS half of the law is satisfied, the DISCOVERABILITY half is not.
    //
    // It is acceptable HERE and nowhere else, for a specific reason: this branch means the tenant cannot be
    // resolved at all, so every append for it is already being refused and every tender already 422s — the
    // tenant is comprehensively down and will be noticed for reasons much louder than one missing queue row.
    // If a future change makes this branch reachable for a HEALTHY tenant, that reasoning evaporates and the
    // anomaly must find another home (the control plane) before it does.
    //
    // Isolation holds regardless of the ISA content (REQ-025): `tenantSlug` and `partnerId` are read from
    // the control-plane pairing row (`t.slug`, `p.id`), never from the client header, so the key is always
    // under an AUTHENTICATED tenant prefix — a crafted ISA cannot make it match another tenant's listing.
    // Best-effort — an R2 fault must not turn a deterministic 4xx back into a 5xx retry-storm.
    // BOUNDED + DISAMBIGUATED (§36). isaControl is verbatim wire content (ISA13), unbounded and
    // partner-chosen. An over-long one blows the 1024-byte R2 key limit so `put` throws, the inner catch
    // swallows it, and the tender is GONE — no bytes, no row. And ISA13 is an interchange counter, not a
    // document identity: two distinct unresolvable tenders sharing one (a rolled-over counter, a test
    // partner pinned at 000000001) silently overwrote each other. Truncate the tail and append a body hash,
    // so redelivery still overwrites (same bytes ⇒ same key) while a DIFFERENT document cannot.
    const r2Key = `edi/${tenantSlug}/unresolvable/${partnerId}/${isaControl.slice(0, 64)}-${(await sha256Hex(raw)).slice(0, 16)}`;
    try {
      const capped = rawBytes.byteLength > MAX_BODY_BYTES ? rawBytes.slice(0, MAX_BODY_BYTES) : rawBytes;
      await deps.evidence.put(r2Key, capped);
    } catch (putErr) {
      console.error(`edi inbound-204: could not preserve the unresolvable tender at ${r2Key} (the refusal still stands):`, putErr);
    }
    console.error(
      `edi inbound-204: tenant ${tenantSlug} could not be RESOLVED (a claimed-pool row whose policy is unusable, or which names no valid pool_binding) — refusing 422, NOT 5xx: this is deterministic and a retry cannot fix it. The raw tender is preserved at ${r2Key}; no anomalies row is possible because the tenant D1 is what failed to resolve:`,
      err,
    );
    return json(422, { error: "tenant unresolvable" });
  }

  const receivedTs = deps.now();

  // 1a½. CERT GATE (REQ-203 / zero-risk mandate). A tender is parsed into a booking ONLY from a REPLAY-CERTIFIED
  //     partner. Certification exists precisely to prove a partner's format round-trips BEFORE going live; parsing
  //     + booking against an authenticated-but-UNCERTIFIED (possibly wrong) mapping risks a mis-booking. So an
  //     uncertified partner's raw doc is QUARANTINED (edi_uncertified_partner) + ACKed 200 — NO parse-to-booking,
  //     NO shipment, NO appends, NO 990-accept — held for certification (this also keeps the 990-accept path
  //     certified-only). A missing integrations row is treated as uncertified (fail-closed). Same NEVER-A-SILENT-
  //     DROP discipline as the malformed / no-stable-ref branches; the anomaly id is deterministic per partner+ISA13.
  const partnerRow = await db
    .prepare("SELECT cert_status FROM integrations WHERE kind = 'edi_partner' AND id = ? LIMIT 1")
    .bind(partnerId)
    .first<{ cert_status: string | null }>();
  if (partnerRow === null || partnerRow.cert_status !== "certified") {
    const reason = new Error(`partner not replay-certified (cert_status=${partnerRow?.cert_status ?? "none"})`);
    return quarantine(deps, db, tenantSlug, partnerId, isaControl, rawBytes, reason, "edi_uncertified_partner");
  }

  // 1a¾. TENANT-POLICY PREFLIGHT (2026-08-02 §19 — REQ-030/200). The sequencer REFUSES every append for a
  //     tenant whose control-plane policy is unusable (unparseable / null / an array / a non-object), and
  //     for a tenant with no control row at all — because proceeding on `{}` silently widens the dims gate,
  //     the geofence and, irreversibly, visibility on append-only events.
  //
  //     That refusal must be discovered HERE, not at the append. This handler's own law, stated thirty
  //     lines below, is that a DETERMINISTIC bad document quarantines with a 200 and never a 5xx: a corrupt
  //     control row is exactly as deterministic as a malformed 204, and letting the append's throw become a
  //     500 hands the VAN an infinite retry against a condition no retry can fix. Worse, the persists and
  //     the tender marker at step 2 run BEFORE the appends and write straight to tenant D1 — so every retry
  //     would accumulate parties, shipments and markers with no ledger behind them, a projection with no
  //     events. Checked before anything is written, using the SAME predicate the sequencer uses.
  //
  //     The platform tenant is exempt there and is not reachable here (no EDI partner tenders to it).
  //
  //     REACHABILITY, stated honestly (§31): the `policyRow === null` arm below is DEFENCE-IN-DEPTH and is
  //     NOT reachable today — `authenticate` joins `pairings → tenants`, so a tenant with no control row
  //     401s before this line, and test (h2) asserts exactly that. It is kept rather than deleted because
  //     the two are independent (an auth refactor that resolves the tenant another way would expose it),
  //     but the comment must not imply coverage it does not have: what this preflight actually catches is
  //     a row that EXISTS and carries an unusable policy.
  const policyRow = await deps.controlDb
    .prepare("SELECT policy FROM tenants WHERE slug = ?")
    .bind(tenantSlug)
    .first<{ policy: string }>();
  if (policyRow === null || parseTenantPolicy(policyRow.policy) === null) {
    const reason = new Error(
      policyRow === null
        ? `tenant ${tenantSlug} has NO control-plane row — the sequencer refuses every append until one exists`
        : `tenant ${tenantSlug} has an UNUSABLE control-plane policy (${describeTenantPolicyRejection(policyRow.policy)}) — the sequencer refuses every append until it is fixed`,
    );
    return quarantine(deps, db, tenantSlug, partnerId, isaControl, rawBytes, reason, "edi_tenant_policy_unusable");
  }

  // 1b. PARSE + MAP (pure). An EdiParseError / non-priceable tender (MAP204_NO_LANE) / no-stable-ref tender
  //     (MAP204_NO_SHIPMENT_REF) / any other pure-core failure is a DETERMINISTIC bad document — quarantine +
  //     200, never a 5xx retry-storm and never a shipment. The no-stable-ref case is distinguished so the
  //     exceptions queue shows WHY (a tender with no SID/BOL/PRO/PO cannot mint a dedupe-safe booking id).
  let plan: BookingPlan;
  try {
    const tender = parse204(raw);
    // Resolve the shipment id BEFORE map so ALL deterministic append ids + the stream compute against it (threaded
    // through the ctx, never a post-hoc swap):
    //   1) CONVERGE on a prior shipment sharing a LOAD-UNIQUE ref (SID/BM/PRO) — the true F-1 re-tender win.
    //   2) else, if the tender has NO load-unique ref (order-level PO only), mint a per-DELIVERY id so two distinct
    //      loads on one PO are two shipments (PO is order-level, never a merge key — visible duplicate > silent drop).
    //   3) else (has a load-unique ref but no prior match) leave it to map-204's fresh deterministic seed.
    let shipmentIdOverride = await resolveCanonicalShipmentId(db, partnerId, tender);
    if (shipmentIdOverride === undefined) {
      const hasLoadUniqueRef = LOAD_UNIQUE_REF_KEYS.some((k) => (tender.refs[k]?.trim() ?? "") !== "");
      if (!hasLoadUniqueRef) shipmentIdOverride = await orderLevelOnlyShipmentId(partnerId, tender, isaControl);
    }
    plan = await mapTenderToBooking(
      tender,
      shipmentIdOverride !== undefined ? { partnerId, receivedTs, shipmentIdOverride } : { partnerId, receivedTs },
    );
  } catch (err) {
    const rule: QuarantineRule = err instanceof Error && err.message.startsWith("MAP204_NO_SHIPMENT_REF") ? "edi_no_shipment_ref" : "edi_malformed";
    return quarantine(deps, db, tenantSlug, partnerId, isaControl, rawBytes, err, rule);
  }

  // 2. PERSIST + APPEND. A fault here (D1/DO transient) throws → 500 → the partner retries; every write is
  //    idempotent so the retry produces no duplicate. The append set stops at quote.accepted (no-bypass). `db` was
  //    resolved above (the cert gate needed it).
  const streamId = `s:${plan.shipment.id}`;

  await persistParty(db, plan);
  await persistShipment(db, plan, partnerId, receivedTs);

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
    // Price the SAME request that was recorded as quote.requested — a SINGLE parse path: parse-204 populated the
    // lane + weight + (measured) dims, map-204 threaded them in. The rater's dims-presence gate is "no price on
    // air": a tender whose wire carried no complete inch-unit dims prices UNKNOWN and rests at quote.requested.
    const rateRequest: RateRequest = requestedEvent.payload.request;
    const quote = priceShipment(rateRequest, config);
    if (quote.status === "PRICED") {
      const pricedId = await deterministicUuid(`edi:quote-priced:${plan.shipment.id}`);
      const acceptedId = await deterministicUuid(`edi:quote-accepted:${pricedId}`);

      // WP-15 REQ-030/L8 — this EDI 204 handler INDEPENDENTLY PRICES via the native Rater (priceShipment above)
      // and appends a source:"native" quote.priced below, so it is authoritative for the RATING module — the
      // SAME authoritative-emitter class as the Concierge auto-reply (concierge.ts). Consult the rating seam HERE,
      // before the native price is committed, so a future rating='legacy' tenant's EDI-tendered quote defers to
      // the incumbent price mirror instead of silently shipping a native price (the exact bypass the coverage lint
      // guards). `legacyValueAvailable` is false today ⇒ authoritativeSource ALWAYS resolves to "native" ⇒
      // behavior-identical; dormant intent-marker branch, same as the concierge/biller/rate consult sites. Task 4
      // lights it up when a legacy price mirror exists.
      const ratingAuthority = authoritativeSource(await resolveAuthority(db, "rating"), false);
      if (ratingAuthority === "legacy") {
        // DORMANT until a legacy price mirror exists (Task 4). Unreachable today (native always wins).
        console.error(
          `204-inbound: rating authority is 'legacy' for shipment ${plan.shipment.id} but no price mirror is wired (WP-15 Task 4) — proceeding native`,
        );
      }

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

      // 3. 990 acceptance — best-effort through the transport port, dedup'd EXACTLY like the 214 sweep (F-3). A
      //    redelivered accepted 204 must NOT re-send the 990 NOR re-allocate a fresh outbound control number
      //    (which would burn a number every redelivery and send a byte-divergent 990). The `edi/<tenant>/990/
      //    <acceptedId>` marker's PRESENCE means "already acknowledged" → skip allocate/build/send entirely; it is
      //    written ONLY after a successful send (mark-on-success), so an unwired NotConfigured env writes no marker
      //    and stays re-attemptable next delivery — the same discipline as sweep-214's sent-marker.
      const ack990Key = `edi/${tenantSlug}/990/${acceptedId}`;
      if ((await deps.evidence.head(ack990Key)) === null) {
        try {
          // SHUDDL's OWN outbound interchange control numbers for this partner (allocated + persisted, monotonic) —
          // NEVER an echo of the inbound 204's ISA13, which is the PARTNER's number for a DIFFERENT interchange.
          const { isaControl: ackIsa, gsControl: ackGs } = await allocatePartnerControls(db, partnerId);
          const bytes = build990({
            shipmentRef: plan.shipment.id,
            partnerScac: plan.shipment.partnerScac,
            isaControl: ackIsa,
            gsControl: ackGs,
            action: "A",
            sentAt: deps.now(), // real interchange date at send (2026-08-01 audit — never the year-2000 fixture constant)
          });
          await deps.transport.send990(plan.shipment.partnerScac, bytes, `edi990/${acceptedId}`);
          await deps.evidence.put(ack990Key, bytes); // mark-on-success — only a transmitted 990 is recorded
        } catch (err) {
          // A transport reject (unwired) OR an unallocatable partner (no integrations row in this tenant yet) DEFERS
          // the best-effort ack — the 204 is recorded + its chain appended, and NO marker is written so a later
          // delivery re-attempts. A genuine serialize bug stays LOUD.
          if (!(err instanceof TransportError) && !(err instanceof PartnerControlError)) throw err;
          console.error(
            `204-inbound: 990 ack for ${plan.shipment.id} not transmitted (deferred — the 204 is recorded):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  return json(200, { status: accepted ? "accepted" : "recorded", shipment_id: plan.shipment.id });
}
