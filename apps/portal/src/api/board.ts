import { useEffect, useRef, useState } from "react";
import { z } from "@shuddl/contracts";
import type { FleetItem } from "@shuddl/map";
import { ApiError, get } from "../lib/api.js";

// REQ-085 / remediation Task 12 — the portal's data seam onto the SERVER-SCOPED party board (GET /v1/board).
// This REPLACES the synthetic demoFleet the WP-03 shell rendered: the marks are now the party's OWN positioned
// shipments, scoped + generalized SERVER-SIDE (workers/api/src/routes/board.ts) before they ever reach the wire.
// The client fabricates nothing and re-scopes nothing that matters — it renders exactly what the authoritative
// projection returned, and polls it truthfully.
//
// Zod at the boundary (CLAUDE.md): the response is server-controlled, so it is parsed .strict(); a malformed or
// extra field is a hard throw the hook surfaces as an honest "unavailable", never a half-rendered fleet. The item
// allowlist mirrors the server projection EXACTLY: {shipment_id, lat_e6, lon_e6, status} — no party_id, no
// accuracy, nothing internal. `as_of` is the SERVER-derived freshness stamp (epoch ms) the party board carries so
// the portal shows "how fresh" from server truth, never the browser clock.
const BoardItem = z
  .object({
    shipment_id: z.string(),
    lat_e6: z.number(),
    lon_e6: z.number(),
    status: z.enum(["healthy", "at-risk", "exception"]),
  })
  .strict();
const BoardResponse = z.object({ board: z.array(BoardItem), as_of: z.number() }).strict();

export type PartyBoardItem = z.infer<typeof BoardItem>;

const E6 = 1_000_000;

// Bounded poll interval (Task 12 Step 5: 15–30s). 20s keeps the map live without hammering the durable read.
//
// THIS IS REQ-257's "polling fallback" (§865). That row — *"Live board uses hibernatable Durable Object
// WebSockets with serialized lens attachment and batching and reconnect and eviction and polling fallback"* —
// is **vNEXT (V2-E)**, so the socket is deferred and this poll is the sanctioned interim, not a stopgap
// someone forgot to replace. Recorded here because the row was cited nowhere in code before 2026-08-09: a
// reader of this constant had no way to reach the design that supersedes it. The Command surface sits one
// step further back (a single load on mount, apps/command/src/App.tsx::useBoardFleet) — deliberate scope,
// since no register row asks that map to refresh.
export const BOARD_POLL_MS = 20_000;

// One board row → the FleetItem the map renders. TRUTHFUL MAP (skill keep-map-instrument-truthful):
//   • kind "at_rest" — a last-known DOT, not a chevron. The board carries a single position and NO heading; a
//     chevron would invent a due-north bearing. A dot claims no direction and still rides the exception pulse, so
//     acceptance demo #5 is unaffected.
//   • bearing 0 — inert for a circle (only the `trucks` symbol reads bearing), so no heading is fabricated.
// party_refs is [partyId]: the SERVER already scoped this read to the party (REQ-025); useFleet's party lens
// re-affirms membership as defence-in-depth, so a stray non-party mark (e.g. a re-introduced demoFleet) would be
// dropped rather than drawn. The coords are already server-generalized (REQ-074), so the party lens runs
// serverScoped (App.tsx) and never re-coarsens an out-for-delivery shipment's exact position.
function toFleetItem(b: PartyBoardItem, partyId: string): FleetItem {
  return {
    id: b.shipment_id,
    lng: b.lon_e6 / E6,
    lat: b.lat_e6 / E6,
    bearing: 0,
    kind: "at_rest",
    status: b.status,
    label: b.shipment_id,
    shipment_id: b.shipment_id,
    party_refs: [partyId],
  };
}

/** Fetch the party's live board. Throws ApiError on a non-2xx (the caller branches on isAuthError → re-auth) or a
 * ZodError on a malformed body (→ honest unavailable). Returns the mapped fleet + the server freshness stamp. */
export async function fetchPartyBoard(partyId: string): Promise<{ items: FleetItem[]; asOf: number }> {
  const raw = await get<unknown>("/v1/board");
  const parsed = BoardResponse.parse(raw);
  return { items: parsed.board.map((b) => toFleetItem(b, partyId)), asOf: parsed.as_of };
}

/** The server freshness stamp (epoch ms) as a compact HH:MM:SS (UTC — deterministic across environments). */
export function freshnessLabel(asOf: number): string {
  return new Date(asOf).toISOString().slice(11, 19);
}

export type BoardPhase = "loading" | "ready" | "unavailable";

export interface PartyBoardState {
  phase: BoardPhase;
  /** Last-known marks — retained across a failed refresh so the map stays useful while honestly labelled stale. */
  items: FleetItem[];
  /** The server freshness stamp of the last GOOD load; null until the first success. */
  asOf: number | null;
  /** A refresh failed while we still hold last-known data. */
  stale: boolean;
  /** Ready with zero marks — an honest empty board, not a fabricated fleet. */
  empty: boolean;
}

const LOADING: PartyBoardState = { phase: "loading", items: [], asOf: null, stale: false, empty: false };

/**
 * Poll the party board truthfully. Bounded interval (BOARD_POLL_MS), a mounted-guard abort-on-unmount, honest
 * states (loading | ready[empty] | stale | unavailable), and a 401 that stops the loop and hands off to
 * onAuthError. It NEVER falls back to synthetic data: a failure keeps the last-known marks (stale) or, on a cold
 * failure, shows unavailable — the map is only ever the server's truth or an honest gap.
 *
 * abort-on-unmount: the portal fetch client exposes no AbortSignal (mirrors apps/command/src/lib/board.ts), so
 * this uses the repo-standard mounted-guard cancel — no setState and no further poll survives unmount.
 */
export function usePartyBoard(partyId: string, onAuthError: () => void): PartyBoardState {
  const [state, setState] = useState<PartyBoardState>(LOADING);
  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      try {
        const { items, asOf } = await fetchPartyBoard(partyId);
        if (!mounted) return;
        setState({ phase: "ready", items, asOf, stale: false, empty: items.length === 0 });
      } catch (e) {
        if (!mounted) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthErrorRef.current(); // 401 → drop the session; STOP polling (no reschedule)
          return;
        }
        // A non-auth failure: retain last-known marks (STALE) if we have them, else an honest UNAVAILABLE.
        setState((prev) => (prev.phase === "ready" ? { ...prev, stale: true } : { ...LOADING, phase: "unavailable" }));
      }
      if (!mounted) return;
      timer = setTimeout(() => void tick(), BOARD_POLL_MS);
    }

    void tick();
    return () => {
      mounted = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [partyId]);

  return state;
}
