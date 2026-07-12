import { z } from "zod";
import { SafeInt, JsonObject } from "./json.js";
import {
  Cents,
  Bps,
  InvoiceIssuedPayload,
  InvoiceCorrectedPayload,
  SplitComputedPayload,
} from "./money.js";

// REQ-011 / doc 10 §01: the complete v1 catalog. Exactly 35 — adding a kind is a
// register amendment (a test pins .length === 35 and the strings against doc 10).
export const EVENT_KINDS = [
  "quote.requested", "quote.priced", "quote.sent", "quote.accepted", "quote.expired",
  "booking.created", "credit.checked", "appointment.set", "pickup.scheduled", "dispatch.assigned",
  "stop.arrived", "freight.counted", "freight.photographed", "dims.captured", "custody.transferred",
  "seal.applied", "stop.departed", "position.updated", "exception.raised", "osd.captured",
  "pod.signed", "delivery.evidenced",
  "invoice.issued", "invoice.corrected", "payment.received", "settlement.executed", "split.computed",
  "message.received", "message.sent", "call.transcribed",
  "document.attached", "approval.requested", "approval.decided", "agent.acted", "authority.flipped",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const Hash64 = z.string().regex(/^[0-9a-f]{64}$/);

// actor{party,user,device}: split into three DB columns (actor_party_id/_user_id/_device_id).
export const Actor = z
  .object({ party: z.string().min(1), user: z.string().optional(), device: z.string().optional() })
  .strict();
export type Actor = z.infer<typeof Actor>;

// REQ-001 (WP-02 slice): every physical state change is captured AT the event, carrying its evidence
// (doc id + content hash) — never re-keyed downstream. Because the ledger is the sole append-only
// source and money/status/passport rows are PROJECTIONS of it, no workflow re-enters ledger data.
// The device-side capture leg (driver PWA) lands in WP-05.
export const EvidenceRef = z.object({ doc_id: z.string(), hash: Hash64 }).strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Visibility = z.enum(["internal", "counterparty", "public"]);
export type Visibility = z.infer<typeof Visibility>;

// ---- typed payloads (the rest of the 35 kinds carry JsonObject) ----
// accuracy_m is a GPS uncertainty RADIUS — a negative accuracy is nonsensical and would poison the
// geofence ambiguity band, so it is rejected here (min 0), matching PositionStamp in position.ts.
export const GeoStamp = z
  .object({ lat_e6: SafeInt, lon_e6: SafeInt, accuracy_m: SafeInt.min(0).optional() })
  .strict();
export type GeoStamp = z.infer<typeof GeoStamp>;

// I5: every quote pins the rate_config version ids it priced against (min 1).
export const QuotePricedPayload = z
  .object({
    sell: Cents,
    floors: z.object({ contribution: Cents, full: Cents, target: Cents }).strict(),
    versions: z.object({ rate_config_ids: z.array(z.string()).min(1) }).strict(),
    basis: JsonObject,
  })
  .strict();
export type QuotePricedPayload = z.infer<typeof QuotePricedPayload>;

export const PodSignedPayload = z
  .object({ signature_hash: Hash64, geo: GeoStamp, unwitnessed: z.literal(true).optional() })
  .strict();
export type PodSignedPayload = z.infer<typeof PodSignedPayload>;

export const CustodyTransferredPayload = z
  .object({
    from_party: z.string().min(1),
    to_party: z.string().min(1),
    geo: GeoStamp.optional(),
    cosig: z.string().optional(), // co-sign ack reserved for WP-05
    unwitnessed: z.literal(true).optional(),
  })
  .strict();
export type CustodyTransferredPayload = z.infer<typeof CustodyTransferredPayload>;

export const PositionUpdatedPayload = z
  .object({ lat_e6: SafeInt, lon_e6: SafeInt, accuracy_m: SafeInt.optional(), speed_cms: SafeInt.optional() })
  .strict();
export type PositionUpdatedPayload = z.infer<typeof PositionUpdatedPayload>;

// REQ-005: agent.acted must cite at least one basis link (event/doc/config).
export const AgentActedPayload = z
  .object({
    agent: z.string().min(1),
    action: z.string().min(1),
    basis: z
      .array(z.object({ kind: z.enum(["event", "doc", "config"]), id: z.string() }).strict())
      .min(1),
    confidence_bps: Bps,
    cost_cents: Cents.optional(),
    latency_ms: SafeInt.optional(),
  })
  .strict();
export type AgentActedPayload = z.infer<typeof AgentActedPayload>;

// ---- WP-05 physical-capture payloads (REQ-017/063/064) ----
// Evidence bytes are hashed AT CAPTURE (REQ-017): photo/seal events carry a Hash64, never the
// bytes. Geo is integer microdegrees (GeoStamp); counts and dims are non-negative integers.
// These shapes feed the Gatekeeper gates + the driver capture in later WP-05 tasks — the gates
// read exactly the evidence pinned here (a placed-photo hash for delivery, a count for a stop).

// stop.arrived — geofence-triggered (auto=true) or manual (auto=false) arrival stamp.
export const StopArrivedPayload = z.object({ geo: GeoStamp, auto: z.boolean() }).strict();
export type StopArrivedPayload = z.infer<typeof StopArrivedPayload>;

// freight.counted — pieces observed; `expected` (from the BOL) is optional (not always known).
export const FreightCountedPayload = z
  .object({ pieces: SafeInt.min(0), expected: SafeInt.min(0).optional() })
  .strict();
export type FreightCountedPayload = z.infer<typeof FreightCountedPayload>;

// freight.photographed — a forced photo (REQ-063), hashed at capture. photo_kind (named to avoid
// shadowing the envelope `kind`) tags what the gate reads: "freight" (pickup-depart gate) or
// "placed" (delivery gate). Seals ride seal.applied and OS&D rides osd.captured — not this kind.
export const FreightPhotographedPayload = z
  .object({ photo_hash: Hash64, photo_kind: z.enum(["freight", "placed"]) })
  .strict();
export type FreightPhotographedPayload = z.infer<typeof FreightPhotographedPayload>;

// dims.captured — L/W/H inches + piece count; camera-measured or manually entered. Linear dims
// must be positive (min 1) — a 0-inch box is degenerate and would poison the pricing/class calc.
// pieces stays min 0 (0 can express a shortage).
export const DimsCapturedPayload = z
  .object({
    l_in: SafeInt.min(1),
    w_in: SafeInt.min(1),
    h_in: SafeInt.min(1),
    pieces: SafeInt.min(0),
    method: z.enum(["camera", "manual"]),
  })
  .strict();
export type DimsCapturedPayload = z.infer<typeof DimsCapturedPayload>;

// seal.applied — seal id + a photo of the applied seal (hashed at capture).
export const SealAppliedPayload = z.object({ seal_id: z.string().min(1), photo_hash: Hash64 }).strict();
export type SealAppliedPayload = z.infer<typeof SealAppliedPayload>;

// stop.departed — departure stamp; geofence-triggered (auto=true) or manual (auto=false).
// out_for_delivery: the WP-05 driver PWA sets this true when departing to run delivery; the
// status-cache projection flips the OFD flag ONLY on this signal (packages/ledger status-cache.ts),
// and the driver lens + map granularity read that flag. Optional — a plain depart never flips OFD.
export const StopDepartedPayload = z
  .object({ geo: GeoStamp, auto: z.boolean(), out_for_delivery: z.boolean().optional() })
  .strict();
export type StopDepartedPayload = z.infer<typeof StopDepartedPayload>;

// osd.captured — over/short/damage: a photo (hashed at capture) + a reason code + optional note.
// ASYMMETRY NOTE (for the Task-3 exception gate): osd.captured is strictly typed here, but
// `exception.raised` deliberately stays a loose JsonObject payload (see the ev/evInput maps). The
// two are NOT symmetrically typed — a gate reading exception evidence must DEFENSIVELY parse
// `{photo_hash, reason_code}` out of exception.raised's payload; it cannot assume this shape.
export const OsdCapturedPayload = z
  .object({
    photo_hash: Hash64,
    reason_code: z.enum(["shortage", "overage", "damage", "refused", "other"]),
    note: z.string().optional(),
  })
  .strict();
export type OsdCapturedPayload = z.infer<typeof OsdCapturedPayload>;

// delivery.evidenced — the forced placed-freight photo (REQ-063), hashed at capture, + where.
export const DeliveryEvidencedPayload = z.object({ placed_photo_hash: Hash64, geo: GeoStamp }).strict();
export type DeliveryEvidencedPayload = z.infer<typeof DeliveryEvidencedPayload>;

// REQ-166: driver location-tracking consent must be captured as an event BEFORE the first GPS
// stamp — and it must ride an EXISTING kind (adding a 36th kind is a register amendment). The
// carrier is `document.attached` (kept as a flexible JsonObject payload above): the DO stores a
// `document.attached` event whose payload conforms to ConsentAck, and the consent-before-GPS gate
// (a LATER WP-05 task) validates that payload against this schema. Every field is JsonValue-safe,
// so a ConsentAck is a structural subset of the document.attached JsonObject payload and rides the
// ledger unchanged. Consent language + policy_version live pack-side, counsel-reviewed (doc 13 §05).
export const ConsentAck = z
  .object({
    doc_kind: z.literal("consent"),
    policy_version: z.string().min(1),
    operating_state: z.string().min(1), // jurisdiction whose pack-side language was acknowledged
    acknowledged: z.literal(true),
  })
  .strict();
export type ConsentAck = z.infer<typeof ConsentAck>;

// ---- envelope base (shared by every kind; kind + payload are added per member) ----
const eventBaseShape = {
  id: z.string().uuid(),
  stream_id: z.string().regex(/^(s:[\w-]+|q:[\w-]+|t:root)$/),
  shipment_id: z.string().optional(),
  seq: SafeInt.min(0),
  ts: SafeInt.min(0), // epoch ms UTC (assumption 3)
  recorded_at: SafeInt.min(0), // server clock at append
  actor: Actor,
  party_refs: z.array(z.string()),
  evidence: z.array(EvidenceRef),
  prev_hash: Hash64,
  hash: Hash64.optional(), // present on read; computed, never client-supplied
  sig: z.string().optional(), // base64url P-256 over clientView
  visibility: Visibility,
  source: z.enum(["native", "legacy", "edi", "email"]),
  confidence: Bps,
  device_id: z.string().optional(),
  device_seq: SafeInt.min(0).optional(),
  captured_ts: SafeInt.min(0).optional(),
};

// Exported base carries the offline-dedupe refine: a device_id is meaningless without
// its per-device sequence number (the airplane-mode dedupe key). Members are built from
// the raw shape (a discriminated union cannot take a refined object as an option).
export const EventBase = z.object(eventBaseShape).strict().refine(
  (e) => e.device_id === undefined || e.device_seq !== undefined,
  { message: "device_seq required when device_id present (offline dedupe key)", path: ["device_seq"] },
);
export type EventBase = z.infer<typeof EventBase>;

function ev<K extends EventKind, P extends z.ZodTypeAny>(kind: K, payload: P) {
  return z.object({ ...eventBaseShape, kind: z.literal(kind), payload }).strict();
}

export const LedgerEvent = z
  .discriminatedUnion("kind", [
    ev("quote.requested", JsonObject),
    ev("quote.priced", QuotePricedPayload),
    ev("quote.sent", JsonObject),
    ev("quote.accepted", JsonObject),
    ev("quote.expired", JsonObject),
    ev("booking.created", JsonObject),
    ev("credit.checked", JsonObject),
    ev("appointment.set", JsonObject),
    ev("pickup.scheduled", JsonObject),
    ev("dispatch.assigned", JsonObject),
    ev("stop.arrived", StopArrivedPayload),
    ev("freight.counted", FreightCountedPayload),
    ev("freight.photographed", FreightPhotographedPayload),
    ev("dims.captured", DimsCapturedPayload),
    ev("custody.transferred", CustodyTransferredPayload),
    ev("seal.applied", SealAppliedPayload),
    ev("stop.departed", StopDepartedPayload),
    ev("position.updated", PositionUpdatedPayload),
    ev("exception.raised", JsonObject),
    ev("osd.captured", OsdCapturedPayload),
    ev("pod.signed", PodSignedPayload),
    ev("delivery.evidenced", DeliveryEvidencedPayload),
    ev("invoice.issued", InvoiceIssuedPayload),
    ev("invoice.corrected", InvoiceCorrectedPayload),
    ev("payment.received", JsonObject),
    ev("settlement.executed", JsonObject),
    ev("split.computed", SplitComputedPayload),
    ev("message.received", JsonObject),
    ev("message.sent", JsonObject),
    ev("call.transcribed", JsonObject),
    ev("document.attached", JsonObject),
    ev("approval.requested", JsonObject),
    ev("approval.decided", JsonObject),
    ev("agent.acted", AgentActedPayload),
    ev("authority.flipped", JsonObject),
  ])
  .superRefine((e, ctx) => {
    // offline-dedupe refine (mirrors EventBase; the union cannot inherit it directly).
    if (e.device_id !== undefined && e.device_seq === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "device_seq required when device_id present (offline dedupe key)",
        path: ["device_seq"],
      });
    }
    // I4: custody events must be co-signed by a device OR explicitly flagged unwitnessed.
    if (e.kind === "custody.transferred" || e.kind === "pod.signed") {
      const hasDevice = e.actor.device !== undefined;
      const unwitnessed = (e.payload as { unwitnessed?: unknown }).unwitnessed === true;
      if (!hasDevice && !unwitnessed) {
        ctx.addIssue({
          code: "custom",
          message: "I4: custody event requires actor.device or payload.unwitnessed",
          path: ["actor", "device"],
        });
      }
    }
  });
export type LedgerEvent = z.infer<typeof LedgerEvent>;

// ---- EventInput: the client-suppliable subset (Task 13) ----
// The sequencer DO owns seq / prev_hash / recorded_at / visibility / hash / stream_id — a client
// may NOT supply any of them (that is the difference between the input shape and the storage shape
// `LedgerEvent`). A client MAY request a NARROWER visibility (`requested_visibility`; resolveVisibility
// only ever lowers, never raises) and MAY carry the offline-reserve fields (device_id/_seq/captured_ts).
// Kept as its own per-kind discriminated union so `input.kind === "invoice.corrected"` still narrows
// `input.payload` to InvoiceCorrectedPayload for the DO. NEVER call LedgerEvent.parse on a request body.
const eventInputBaseShape = {
  id: z.string().uuid(),
  shipment_id: z.string().optional(),
  ts: SafeInt.min(0), // actor-claimed epoch ms (advisory; server stamps recorded_at)
  actor: Actor,
  party_refs: z.array(z.string()),
  evidence: z.array(EvidenceRef),
  sig: z.string().optional(), // base64url P-256 over clientView (device-captured events)
  source: z.enum(["native", "legacy", "edi", "email"]),
  confidence: Bps,
  device_id: z.string().optional(),
  device_seq: SafeInt.min(0).optional(),
  captured_ts: SafeInt.min(0).optional(),
  requested_visibility: Visibility.optional(), // narrow-only; resolved server-side, never hashed
};

function evInput<K extends EventKind, P extends z.ZodTypeAny>(kind: K, payload: P) {
  return z.object({ ...eventInputBaseShape, kind: z.literal(kind), payload }).strict();
}

export const EventInput = z
  .discriminatedUnion("kind", [
    evInput("quote.requested", JsonObject),
    evInput("quote.priced", QuotePricedPayload),
    evInput("quote.sent", JsonObject),
    evInput("quote.accepted", JsonObject),
    evInput("quote.expired", JsonObject),
    evInput("booking.created", JsonObject),
    evInput("credit.checked", JsonObject),
    evInput("appointment.set", JsonObject),
    evInput("pickup.scheduled", JsonObject),
    evInput("dispatch.assigned", JsonObject),
    evInput("stop.arrived", StopArrivedPayload),
    evInput("freight.counted", FreightCountedPayload),
    evInput("freight.photographed", FreightPhotographedPayload),
    evInput("dims.captured", DimsCapturedPayload),
    evInput("custody.transferred", CustodyTransferredPayload),
    evInput("seal.applied", SealAppliedPayload),
    evInput("stop.departed", StopDepartedPayload),
    evInput("position.updated", PositionUpdatedPayload),
    evInput("exception.raised", JsonObject),
    evInput("osd.captured", OsdCapturedPayload),
    evInput("pod.signed", PodSignedPayload),
    evInput("delivery.evidenced", DeliveryEvidencedPayload),
    evInput("invoice.issued", InvoiceIssuedPayload),
    evInput("invoice.corrected", InvoiceCorrectedPayload),
    evInput("payment.received", JsonObject),
    evInput("settlement.executed", JsonObject),
    evInput("split.computed", SplitComputedPayload),
    evInput("message.received", JsonObject),
    evInput("message.sent", JsonObject),
    evInput("call.transcribed", JsonObject),
    evInput("document.attached", JsonObject),
    evInput("approval.requested", JsonObject),
    evInput("approval.decided", JsonObject),
    evInput("agent.acted", AgentActedPayload),
    evInput("authority.flipped", JsonObject),
  ])
  .superRefine((e, ctx) => {
    if (e.device_id !== undefined && e.device_seq === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "device_seq required when device_id present (offline dedupe key)",
        path: ["device_seq"],
      });
    }
    if (e.kind === "custody.transferred" || e.kind === "pod.signed") {
      const hasDevice = e.actor.device !== undefined;
      const unwitnessed = (e.payload as { unwitnessed?: unknown }).unwitnessed === true;
      if (!hasDevice && !unwitnessed) {
        ctx.addIssue({
          code: "custom",
          message: "I4: custody event requires actor.device or payload.unwitnessed",
          path: ["actor", "device"],
        });
      }
    }
  });
export type EventInput = z.infer<typeof EventInput>;

// ---- deterministic fixtures (no Date.now / Math.random) ----
const FIXTURE_ID = "00000000-0000-4000-8000-000000000001";
const FIXTURE_TS = 1_720_000_000_000; // 2024-07-03T12:26:40Z
const FIXTURE_RECORDED_AT = 1_720_000_000_500;
const FIXTURE_GENESIS = "0".repeat(64);
const FIXTURE_SIGNATURE_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const FIXTURE_GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };

function fixtureActor(kind: EventKind): { party: string; user?: string; device?: string } {
  if (kind === "pod.signed" || kind === "custody.transferred") {
    return { party: "party-carrier", user: "user-driver", device: "device-1" };
  }
  return { party: "party-shipper" };
}

function fixturePayload(kind: EventKind): Record<string, unknown> {
  switch (kind) {
    case "quote.priced":
      return {
        sell: 120_000,
        floors: { contribution: 60_000, full: 90_000, target: 100_000 },
        versions: { rate_config_ids: ["rc-tariff-v3"] },
        basis: {},
      };
    case "pod.signed":
      return { signature_hash: FIXTURE_SIGNATURE_HASH, geo: FIXTURE_GEO };
    case "custody.transferred":
      return { from_party: "party-shipper", to_party: "party-carrier" };
    case "position.updated":
      return { lat_e6: FIXTURE_GEO.lat_e6, lon_e6: FIXTURE_GEO.lon_e6, speed_cms: 1_500 };
    case "stop.arrived":
    case "stop.departed":
      return { geo: FIXTURE_GEO, auto: true };
    case "freight.counted":
      return { pieces: 12 };
    case "freight.photographed":
      return { photo_hash: FIXTURE_SIGNATURE_HASH, photo_kind: "freight" };
    case "dims.captured":
      return { l_in: 48, w_in: 40, h_in: 60, pieces: 4, method: "camera" };
    case "seal.applied":
      return { seal_id: "seal-1", photo_hash: FIXTURE_SIGNATURE_HASH };
    case "osd.captured":
      return { photo_hash: FIXTURE_SIGNATURE_HASH, reason_code: "damage" };
    case "delivery.evidenced":
      return { placed_photo_hash: FIXTURE_SIGNATURE_HASH, geo: FIXTURE_GEO };
    case "agent.acted":
      return {
        agent: "biller",
        action: "draft_invoice",
        basis: [{ kind: "event", id: "evt-basis-1" }],
        confidence_bps: 9_000,
      };
    case "invoice.issued":
      return {
        invoice_id: "inv-1",
        party_id: "party-bill-to",
        division: "main",
        lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }],
      };
    case "invoice.corrected":
      return {
        invoice_id: "inv-1",
        corrects_event_id: "evt-invoice-orig",
        reason: "reweigh correction",
        reissue_lines: [],
      };
    case "split.computed":
      return {
        total_cents: 120_000,
        allocations: [
          { party_id: "party-carrier", share_bps: 7_000 },
          { party_id: "party-interline", share_bps: 3_000 },
        ],
      };
    default:
      return {};
  }
}

// Deterministic minimal-valid event per kind; shallow-merges overrides then validates.
export function eventFixture(kind: EventKind, overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  const base: Record<string, unknown> = {
    id: FIXTURE_ID,
    stream_id: "s:shp-1",
    shipment_id: "shp-1",
    seq: 0,
    ts: FIXTURE_TS,
    recorded_at: FIXTURE_RECORDED_AT,
    actor: fixtureActor(kind),
    party_refs: [],
    evidence: [],
    prev_hash: FIXTURE_GENESIS,
    visibility: "internal",
    source: "native",
    confidence: 10_000,
    kind,
    payload: fixturePayload(kind),
  };
  return LedgerEvent.parse({ ...base, ...overrides });
}
