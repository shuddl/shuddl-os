import { z } from "zod";
import { SafeInt, JsonObject } from "./json.js";
import {
  Cents,
  Bps,
  InvoiceIssuedPayload,
  InvoiceCorrectedPayload,
  SplitComputedPayload,
} from "./money.js";
import {
  MessageReceivedPayload,
  MessageSentPayload,
  QuoteRequestedPayload,
  QuoteSentPayload,
  QuoteAcceptedPayload,
} from "./comms.js";
import {
  CreditCheckedPayload,
  BookingCreatedPayload,
  AppointmentSetPayload,
  PickupScheduledPayload,
  DispatchAssignedPayload,
} from "./booking.js";
import { AuthorityFlippedPayload } from "./authority.js";

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

/**
 * §1227 — WHAT COUNTS AS AN "EXCEPTION", declared ONCE.
 *
 * This list was previously written out twice, independently: `workers/api/src/routes/exceptions.ts` (the
 * authenticated route behind the Command board's exception queue) and `packages/agents/src/copilot/answer.ts`
 * (the copilot's `open_exceptions` answer). Neither imported the other and no test compared them — so the two
 * surfaces' shared definition of an exception was held together by nothing but the fact that one person wrote
 * both. Adding a third kind to one would have left the board and the copilot disagreeing about the SAME
 * question, which is the exception-pulse acceptance demo (doc 00 §5).
 *
 * `satisfies readonly EventKind[]` is load-bearing rather than decorative: a member that is not in the frozen
 * 35-catalog fails to COMPILE, so this subset cannot drift away from its superset either. Both consumers keep
 * their literal-tuple typing because the `as const` is preserved here.
 */
export const EXCEPTION_KINDS = ["exception.raised", "osd.captured"] as const satisfies readonly EventKind[];

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

// REQ-049 — a named, reasoned Gatekeeper override, recorded PERMANENTLY on the event it releases:
// who overrode the gate (`by`) and why (`reason`). OPTIONAL on the envelope and, critically,
// OMITTED-WHEN-ABSENT: the canonicalizer drops `undefined` keys, so a normal (non-override) event's
// canonical bytes and hash are UNCHANGED by the mere existence of this field (the frozen-byte law
// holds). When PRESENT it rides into the hashed, chained envelope — so an override is tamper-evident
// AFTER write (the chain seals it; a later edit breaks verification) and permanently visible (REQ-049).
//
// IDENTITY (REQ-049, WP-05 exit audit): `by` is the AUTHENTICATED author. The append route
// (workers/api/src/routes/events.ts) STAMPS `by = session.sub` (the JWT subject) over any client-
// supplied value AND requires an elevated role (ops/admin/finance) — so an override's accountability
// record cannot be forged by a driver/portal caller. `reason` is the client's justification, kept
// verbatim. Both must be NON-BLANK: whitespace-only `by`/`reason` is rejected here at parse (a refine
// on the trimmed length, NOT a transform — the stored bytes are unchanged, so the frozen-byte law and
// the chained hash still hold), a clean VALIDATION_FAILED rather than reaching the gate as an
// unaccountable pass.
const nonBlank = (label: string) =>
  z.string().refine((s) => s.trim().length > 0, `override.${label} must be non-blank`);
export const EventOverride = z.object({ by: nonBlank("by"), reason: nonBlank("reason") }).strict();
export type EventOverride = z.infer<typeof EventOverride>;

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
    // The itemized breakdown the invoice projects from (REQ-003/031): the invoice's lines are a
    // projection of THIS recorded event, never a re-computation. Σ amount_cents === sell.
    lines: z
      .array(
        z
          .object({
            kind: z.enum(["freight", "fsc", "accessorial"]),
            code: z.string().min(1),
            // POSITIVE (>= 1; I7, mirrors money.ts InvoiceLine): a line is a positive charge, and each quote
            // line is projected verbatim into an invoice line. A negative line that still summed to sell would
            // be un-projectable; a ZERO line poisons the money projection at money_lines CHECK(amount_cents
            // != 0) — so both fail HERE at the record (a credit is its own kind, never a zero/negative line).
            amount_cents: Cents.refine((c) => c >= 1, "quote line amount_cents must be a positive charge; a credit is its own kind, never a zero/negative line (I7)"),
          })
          .strict(),
      )
      .min(1),
    floors: z.object({ contribution: Cents, full: Cents, target: Cents }).strict(),
    versions: z.object({ rate_config_ids: z.array(z.string()).min(1) }).strict(),
    basis: JsonObject,
  })
  .strict()
  // Penny-parity guard (REQ-003/031): a breakdown that does not total the sell must FAIL — the invoice
  // projects these lines verbatim, so a mismatch would misprice. Integer addition; Cents are safe integers.
  .refine(
    (p) => p.lines.reduce((sum, l) => sum + l.amount_cents, 0) === p.sell,
    "quote.priced lines must sum to sell (penny-parity: the invoice projects these lines)",
  );
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
    cosig: z.string().optional(), // co-sign ack — consumed by the REQ-045 interline gate (assertInterline requires a non-blank receiver cosig)
    unwitnessed: z.literal(true).optional(),
  })
  .strict();
export type CustodyTransferredPayload = z.infer<typeof CustodyTransferredPayload>;

export const PositionUpdatedPayload = z
  // accuracy_m is a GPS uncertainty RADIUS — a negative accuracy is nonsensical and would poison the
  // geofence ambiguity band, so it is rejected here (min 0), matching GeoStamp / PositionStamp.
  .object({ lat_e6: SafeInt, lon_e6: SafeInt, accuracy_m: SafeInt.min(0).optional(), speed_cms: SafeInt.optional() })
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
    // §1532 — OPERATOR FREE TEXT, bounded. A driver types this at a door and it lands in an append-only
    // event: unbounded, one paste puts arbitrary bytes in the ledger forever. 2,048 matches the bound
    // `MessageReceivedPayload.subject` already carries for the same reason (a human-scale line of text);
    // the longest note anywhere in the tree is 163 characters.
    note: z.string().max(2_048).optional(),
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
// (a LATER WP-05 task) validates that payload against this schema.
//
// EXACT-MATCH CONTRACT (load-bearing — do NOT read this as "loose"): ConsentAck is `.strict()`, so
// the stored `document.attached` consent payload must match it EXACTLY — these four fields and
// NOTHING else. A consent doc that also carries a natural `doc_id`, content hash, or `captured_ts`
// on the SAME payload object fails `safeParse` → the gate would silently block that driver from ALL
// GPS in that state, forever, with nothing pointing at the offending extra key. So the Task-5/Task-8
// emitter's contract is: put ONLY {doc_kind, policy_version, operating_state, acknowledged} in the
// consent payload; any doc id / hash / timestamp rides the envelope's `evidence[]` / `captured_ts`,
// never inside this object. Consent language + policy_version live pack-side, counsel-reviewed (doc 13 §05).
export const ConsentAck = z
  .object({
    doc_kind: z.literal("consent"),
    policy_version: z.string().min(1),
    // Jurisdiction of the acknowledged pack-side language. CANONICAL FORM: uppercase 2-letter
    // jurisdiction code (USPS, e.g. "TX"). The gate compares this by EXACT case-sensitive equality
    // to the incoming stamp's derived jurisdiction, so capture (Task 8), derivation (Task 5), and
    // the gate must all use this one form — "TX" ≠ "tx" ≠ "Texas".
    //
    // FORM ENFORCED (WP-05 exit audit, REQ-166): exactly two uppercase letters, EXCLUDING the
    // fail-closed sentinel "XX". `deriveOperatingState` returns "XX" for any coordinate outside the
    // known boxes (~45 states), so a `ConsentAck{operating_state:"XX"}` would otherwise match every
    // out-of-box stamp — one acknowledgment covering half the country. An unknown jurisdiction cannot
    // be consented, so "XX" is rejected here at parse (and the gate blocks any "XX"-derived stamp).
    operating_state: z
      .string()
      .regex(/^[A-Z]{2}$/, "operating_state must be a 2-letter uppercase USPS code")
      .refine((s) => s !== "XX", "operating_state cannot be the unknown-jurisdiction sentinel 'XX'"),
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
  override: EventOverride.optional(), // REQ-049: present only on an event that carried a gate override
};

// Exported base carries the offline-dedupe refine: a device_id is meaningless without
// its per-device sequence number (the airplane-mode dedupe key). Members are built from
// the raw shape (a discriminated union cannot take a refined object as an option).
// §913 — NO CONSUMER. `git grep EventBase` finds only this definition and its `export type`; the union
// members below are built from the raw `eventBaseShape`, never from this. Neutralising the refine leaves
// the whole contracts suite green because nothing evaluates it — NOT because it is under-tested. It is
// public API (re-exported from index.ts), so it is filed for the owner rather than deleted here. Do not
// cite it as the enforcement point for the dedupe key: that is the pair of superRefines below.
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
    ev("quote.requested", QuoteRequestedPayload),
    ev("quote.priced", QuotePricedPayload),
    ev("quote.sent", QuoteSentPayload),
    ev("quote.accepted", QuoteAcceptedPayload),
    ev("quote.expired", JsonObject),
    ev("booking.created", BookingCreatedPayload),
    ev("credit.checked", CreditCheckedPayload),
    ev("appointment.set", AppointmentSetPayload),
    ev("pickup.scheduled", PickupScheduledPayload),
    ev("dispatch.assigned", DispatchAssignedPayload),
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
    ev("message.received", MessageReceivedPayload),
    ev("message.sent", MessageSentPayload),
    ev("call.transcribed", JsonObject),
    ev("document.attached", JsonObject),
    ev("approval.requested", JsonObject),
    ev("approval.decided", JsonObject),
    ev("agent.acted", AgentActedPayload),
    ev("authority.flipped", AuthorityFlippedPayload),
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
    // WP-05 exit audit (REQ-016): a device-namespaced event (one carrying a `device_id`, the offline
    // dedupe key) MUST be co-signed BY that device — its `device_id` must equal `actor.device` and it
    // must carry a signature. Otherwise an unsigned event, or one device signing under another's
    // device_id, could squat a victim's (device_id, device_seq) slot and silently drop the victim's
    // real signed capture (first-wins). Binding the dedupe key to the signing key closes that.
    if (e.device_id !== undefined) {
      if (e.actor.device === undefined || e.actor.device !== e.device_id) {
        ctx.addIssue({
          code: "custom",
          message: "device_id must equal actor.device (a device-namespaced event is signed by that device)",
          path: ["device_id"],
        });
      }
      if (e.sig === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "sig required when device_id present (a device-namespaced event must be signed)",
          path: ["sig"],
        });
      }
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
  override: EventOverride.optional(), // REQ-049: the dispatcher's named+reasoned gate override
};

function evInput<K extends EventKind, P extends z.ZodTypeAny>(kind: K, payload: P) {
  return z.object({ ...eventInputBaseShape, kind: z.literal(kind), payload }).strict();
}

export const EventInput = z
  .discriminatedUnion("kind", [
    evInput("quote.requested", QuoteRequestedPayload),
    evInput("quote.priced", QuotePricedPayload),
    evInput("quote.sent", QuoteSentPayload),
    evInput("quote.accepted", QuoteAcceptedPayload),
    evInput("quote.expired", JsonObject),
    evInput("booking.created", BookingCreatedPayload),
    evInput("credit.checked", CreditCheckedPayload),
    evInput("appointment.set", AppointmentSetPayload),
    evInput("pickup.scheduled", PickupScheduledPayload),
    evInput("dispatch.assigned", DispatchAssignedPayload),
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
    evInput("message.received", MessageReceivedPayload),
    evInput("message.sent", MessageSentPayload),
    evInput("call.transcribed", JsonObject),
    evInput("document.attached", JsonObject),
    evInput("approval.requested", JsonObject),
    evInput("approval.decided", JsonObject),
    evInput("agent.acted", AgentActedPayload),
    evInput("authority.flipped", AuthorityFlippedPayload),
  ])
  .superRefine((e, ctx) => {
    if (e.device_id !== undefined && e.device_seq === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "device_seq required when device_id present (offline dedupe key)",
        path: ["device_seq"],
      });
    }
    // WP-05 exit audit (REQ-016) — bind the offline dedupe key to the signing key (mirrors LedgerEvent):
    // a device_id ⟹ actor.device === device_id AND a signature. The sequencer additionally VERIFIES the
    // signature before the (device_id, device_seq) dedup, so a squatted slot is impossible via any path.
    if (e.device_id !== undefined) {
      if (e.actor.device === undefined || e.actor.device !== e.device_id) {
        ctx.addIssue({
          code: "custom",
          message: "device_id must equal actor.device (a device-namespaced event is signed by that device)",
          path: ["device_id"],
        });
      }
      if (e.sig === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "sig required when device_id present (a device-namespaced event must be signed)",
          path: ["sig"],
        });
      }
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
        // Σ amount_cents === sell (REQ-003/031 penny-parity): 90_000 + 12_000 + 18_000 = 120_000.
        lines: [
          { kind: "freight", code: "freight", amount_cents: 90_000 },
          { kind: "fsc", code: "fsc", amount_cents: 12_000 },
          { kind: "accessorial", code: "liftgate", amount_cents: 18_000 },
        ],
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
    // WP-07 Concierge comms/quote payloads (REQ-093/099). from/to refs use the reserved example.com domain
    // (no tenant/person identity — REQ-167); body_ref is an R2 pointer (the ledger carries the ref, not bytes).
    case "message.received":
      return { channel: "email", from_ref: "shipper@example.com", body_ref: "r2://msg/inbound-1" };
    case "message.sent":
      return { channel: "email", to_ref: "shipper@example.com", body_ref: "r2://msg/outbound-1" };
    case "quote.requested":
      return { request: { origin_zip: "97201", dest_zip: "98101" } };
    case "quote.sent":
      return { quote_event_id: "evt-quote-1", to_ref: "shipper@example.com", message_event_id: "evt-message-1" };
    case "quote.accepted":
      return { quote_event_id: "evt-quote-1" };
    // WP-08 Scheduler/Booking payloads (REQ-028/042/043/047/052/057). booking.created is the party-correction
    // source (names the REAL consignee/bill_to + anchors the accepted quote); windows are integer epoch-ms.
    case "booking.created":
      return {
        quote_event_id: "evt-quote-1",
        shipper_party_id: "party-shipper",
        consignee_party_id: "party-consignee",
        bill_to_party_id: "party-bill-to",
        division: "main",
      };
    case "credit.checked":
      return { party_id: "party-bill-to", status: "clear" };
    case "appointment.set":
      return {
        leg_kind: "pickup",
        facility_id: "facility-1",
        slot_key: "slot-1",
        window_start_ts: FIXTURE_TS,
        window_end_ts: FIXTURE_TS + 3_600_000,
      };
    case "pickup.scheduled":
      return { facility_id: "facility-1", window_start_ts: FIXTURE_TS, window_end_ts: FIXTURE_TS + 3_600_000 };
    case "dispatch.assigned":
      return { driver_user_id: "user-driver" };
    // WP-15 (REQ-008/023): a minimal earned forward flip. gate_snapshot / drift_ref stay OMITTED so the
    // fixture's canonical bytes carry only the four required keys (frozen-byte law: undefined keys drop).
    case "authority.flipped":
      return { module: "rating", from: "legacy", to: "native", reason: "promote" };
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
