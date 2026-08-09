import { useEffect, useState } from "react";
import { Button, Divider, EmptyState, Input, Loading, Mono } from "@shuddl/design";
import { z } from "@shuddl/contracts";
import { ApiError, get, post } from "../lib/api.js";

// REQ-085 (WP-09 Task 8/11) — the PORTAL CLAIMS + CUSTODY-CHAIN view. It reads the shipment's ledger feed
// through the party lens (GET /v1/shipments/:id/events) and renders the CUSTODY CHAIN — the physical-truth
// events a counterparty cares about — in seq order. Filing a claim posts to POST /v1/shipments/:id/claim
// (a message.received on the portal channel, Task 8) and the filed claim then shows on the timeline.
//
// Honesty rules:
//   · LENS-HONEST: the feed is exactly what the party may see (the server's readEvents lens). We only SELECT
//     the chain kinds to display — no client-side re-derivation of visibility.
//   · exception.raised is an UNTYPED JsonObject — parsed DEFENSIVELY (never assume a field): we probe a small
//     allowlist of string keys and fall back to a generic label, so a malformed/unexpected payload never throws.

// The physical custody chain a counterparty cares about. quote/booking/money/agent kinds are deliberately NOT
// here — this view is the physical-truth timeline, not the full firehose.
const CHAIN_KINDS: ReadonlySet<string> = new Set<string>([
  "custody.transferred",
  "osd.captured",
  "exception.raised",
  "pod.signed",
  "delivery.evidenced",
]);

const EventRowWire = z.object({ id: z.string(), kind: z.string(), seq: z.number(), ts: z.number(), payload: z.unknown() });
const ClaimEventsResponse = z.object({ events: z.array(EventRowWire) });
// Derived from the wire schema (§782) — one shape, so the parsed value and the state type cannot drift.
type EventRow = z.infer<typeof EventRowWire>;

export interface ClaimsViewProps {
  shipmentId: string;
  onAuthError: () => void;
}

// A filed claim rides an existing kind (message.received, channel 'portal', intent 'claim'). Surface only
// THOSE on this timeline — never every portal message.
function isFiledClaim(e: EventRow): boolean {
  if (e.kind !== "message.received") return false;
  const p = e.payload;
  return p !== null && typeof p === "object" && (p as { intent?: unknown }).intent === "claim";
}

function isTimelineEvent(e: EventRow): boolean {
  return CHAIN_KINDS.has(e.kind) || isFiledClaim(e);
}

// Humanize a kind for display WITHOUT changing the accessible DOM string into punctuation a reader would
// mis-speak: "custody.transferred" → "custody transferred" (CSS uppercases it; the DOM keeps real words).
function humanizeKind(kind: string): string {
  return kind.replace(/[._]/g, " ");
}

// DEFENSIVE parse of an UNTYPED exception.raised payload: probe a small allowlist of string keys and return
// the first non-empty one; assume NOTHING about shape or nesting. Returns null when nothing usable is present.
function exceptionDetail(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const key of ["code", "reason", "type", "severity", "note", "message", "detail"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

// The filed-claim body, defensively read (message.received payload.body is a string when present).
function claimBody(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const v = (payload as { body?: unknown }).body;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export function ClaimsView({ shipmentId, onAuthError }: ClaimsViewProps): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [description, setDescription] = useState("");
  const [filing, setFiling] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    // PARSED at the boundary (§782) — unchecked, an absent key set state to undefined and the timeline
    // render threw on `.map`. A ZodError lands in the .catch below and becomes the honest error state.
    get<unknown>(`/v1/shipments/${encodeURIComponent(shipmentId)}/events?limit=200`)
      .then((raw) => {
        if (live) setEvents(ClaimEventsResponse.parse(raw).events);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD THE CUSTODY CHAIN");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [shipmentId, onAuthError]);

  async function handleFileClaim(): Promise<void> {
    const text = description.trim();
    if (text === "") return; // never file an empty claim
    setFiling(true);
    setFileError(null);
    try {
      // The server appends the claim through the sequencer DO and returns the appended message.received. Add
      // it to the timeline so the party sees its filed claim immediately (the real appended event, not a fake).
      const filed = await post<EventRow>(`/v1/shipments/${encodeURIComponent(shipmentId)}/claim`, { description: text });
      setEvents((prev) => [...prev, filed]);
      setDescription("");
    } catch (e) {
      if (e instanceof ApiError && e.isAuthError) {
        onAuthError();
        return;
      }
      setFileError(e instanceof ApiError ? e.message : "COULD NOT FILE THE CLAIM");
    } finally {
      setFiling(false);
    }
  }

  // Ascending by seq — the lens read returns ascending already; sort defensively so an appended claim lands
  // in order regardless of insertion.
  const timeline = events.filter(isTimelineEvent).slice().sort((a, b) => a.seq - b.seq);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Mono size={10} color="var(--signal-55)">
        CUSTODY CHAIN
      </Mono>

      {loading ? (
        <Loading label="SYNCING THE CHAIN" />
      ) : error !== null ? (
        <Mono size={11} color="var(--signal-deep)">
          {error}
        </Mono>
      ) : (
        <div>
          {timeline.length === 0 ? (
            <EmptyState>No custody events yet</EmptyState>
          ) : (
            timeline.map((e) => <TimelineRow key={e.id} event={e} />)
          )}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Mono size={10} color="var(--signal-55)">
          FILE A CLAIM
        </Mono>
        <Input name="claim" placeholder="Describe what happened" value={description} onChange={setDescription} />
        <div>
          <Button type="button" onClick={() => void handleFileClaim()}>
            {filing ? "Filing…" : "File Claim"}
          </Button>
        </div>
        {fileError !== null ? (
          <Mono size={11} color="var(--signal)">
            {fileError}
          </Mono>
        ) : null}
      </div>
    </section>
  );
}

function TimelineRow({ event }: { event: EventRow }): React.JSX.Element {
  const filed = isFiledClaim(event);
  const label = filed ? "claim filed" : humanizeKind(event.kind);
  const detail = event.kind === "exception.raised" ? exceptionDetail(event.payload) : filed ? claimBody(event.payload) : null;
  return (
    <div>
      <Divider />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 0" }}>
        <Mono size={12} color={filed ? "var(--signal)" : "var(--signal-deep)"}>
          {label}
        </Mono>
        {detail !== null ? (
          <Mono size={10} color="var(--signal-55)">
            {detail}
          </Mono>
        ) : null}
      </div>
    </div>
  );
}
