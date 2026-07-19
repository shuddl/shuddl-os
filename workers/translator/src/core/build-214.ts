// WP-12 Task 6 · REQ-200 — the 214 status-projection CORE. Given a shipment's ledger events, project the
// SHUDDL status milestones into a byte-stable @shuddl/edi StatusView (ready for build214) and a deterministic
// dedupe key. PURE: no D1/R2/network, no Date, no random — deterministic given its inputs, so the worker
// (Task 7/8) supplies the ledger read + the outbound send port. Zero import of @shuddl/ledger at runtime — the
// event ROW shape (id/kind/ts/payload) is consumed structurally, mirroring what readEvents/rowToEvent returns.
import { StatusView, dialectStatus, DEFAULT_004010, type PartnerMapping } from "@shuddl/edi";

// The event-row subset build-214 consumes — structurally identical to a @shuddl/ledger read row projected to
// the four fields this core needs. Kept local (no @shuddl/ledger runtime import) so the pure core stays
// dependency-light; the worker maps readEvents(...) rows into this shape.
export interface StatusEventRow {
  id: string;
  kind: string;
  ts: string;
  payload: unknown;
}

export interface BuildStatusViewInput {
  shipmentRef: string;
  partnerScac: string;
  isaControl: string;
  gsControl: string;
  mapping?: PartnerMapping;
  events: StatusEventRow[];
}

export interface BuildStatusViewResult {
  view: StatusView;
  dedupeKey: string;
}

// The SHUDDL status EVENT KIND → the CANONICAL status token that DEFAULT_004010.statusDialect maps to an AT7
// wire code. This is the ONLY place the two vocabularies meet; the AT7 code itself is NEVER duplicated here —
// dialectStatus(token, mapping) is the single source of truth (mapping.ts). Only kinds the frozen 004010
// dialect can resolve are listed: custody.transferred is deliberately OMITTED — the baseline dialect defines
// no AT7 code for a custody transfer, and fabricating one would be a mapping.ts change (out of scope, and a
// non-AT7 code on the wire is a lie — the honest-window / no-fabrication law).
const STATUS_KIND_TO_TOKEN: Record<string, string> = {
  "stop.arrived": "arrived",
  "stop.departed": "departed",
  "pod.signed": "pod",
  "delivery.evidenced": "delivered",
};

// Pull an optional string field out of an unknown payload without trusting its shape (defensive: the ledger
// payload is a JsonObject for some kinds). A non-string / absent value → undefined (never fabricated).
function payloadString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export function buildStatusView(input: BuildStatusViewInput): BuildStatusViewResult {
  const mapping = input.mapping ?? DEFAULT_004010;

  // Filter to the mappable status kinds, in the input's (ledger append) order.
  const statusEvents = input.events.filter((e) => Object.hasOwn(STATUS_KIND_TO_TOKEN, e.kind));

  const stops = statusEvents.map((e) => {
    // STATUS_KIND_TO_TOKEN owns e.kind (guaranteed by the filter above); resolve its AT7 code via the single
    // source of truth. Object.hasOwn-guarded access keeps a hostile kind from reaching an inherited member.
    const token = STATUS_KIND_TO_TOKEN[e.kind] as string;
    const statusCode = dialectStatus(token, mapping);
    const city = payloadString(e.payload, "city");
    const state = payloadString(e.payload, "state");
    // exactOptionalPropertyTypes: only attach city/state when the wire carried them (never `undefined`).
    const stop: { statusCode: string; ts: string; city?: string; state?: string } = { statusCode, ts: e.ts };
    if (city !== undefined) stop.city = city;
    if (state !== undefined) stop.state = state;
    return stop;
  });

  const view = StatusView.parse({
    shipmentRef: input.shipmentRef,
    partnerScac: input.partnerScac,
    isaControl: input.isaControl,
    gsControl: input.gsControl,
    stops,
  });

  // dedupeKey = "edi214/" + the id of the NEWEST status event (the Biller's `evidence-email/<invoiceEventId>`
  // precedent, workers/agents/src/biller.ts:502): one 214 per newest-status, deterministic under redelivery so
  // the worker INSERT OR IGNOREs / dedups on it. "Newest" = the greatest ts, ties resolving to the later event
  // in ledger order (append order is chronological). Empty status list → a stable "none" marker (a 214 with no
  // AT7 stops is a no-op the worker can skip, but the key stays deterministic).
  const newest = statusEvents.reduce<StatusEventRow | undefined>((best, e) => (best === undefined || e.ts >= best.ts ? e : best), undefined);
  const dedupeKey = `edi214/${newest?.id ?? "none"}`;

  return { view, dedupeKey };
}
