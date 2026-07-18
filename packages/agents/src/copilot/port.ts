import type { EventKind } from "@shuddl/contracts";

// WP-10 Task 7 (REQ-038/024) — the copilot's INJECTED READ PORT. The core is PURE over this seam: it never
// imports @shuddl/ledger and never touches D1 directly (check packages/agents/package.json — @shuddl/ledger is
// NOT a dependency). The worker supplies the concrete binding: a lens-scoped readEvents(db, lensFor(session), q).
// So the copilot can NEVER read across the caller's visibility boundary — it only sees what the port hands it,
// and the port is the caller's lens. Mirrors how packages/agents/src/concierge takes injected ports.

/**
 * A retrieved event as the copilot SEES it — a read projection, never the writable envelope. The worker maps
 * a LedgerEvent → ReadEvent (id → event_id). `payload` is `unknown` on purpose: it may have originated from
 * UNTRUSTED email/portal input, so the core treats it as DATA to read, never as instructions or trusted truth.
 */
export interface ReadEvent {
  event_id: string;
  kind: EventKind;
  shipment_id?: string;
  ts: number; // epoch ms — used only to pick the freshest event; never fabricated
  payload: unknown; // untrusted; read defensively, never assumed
}

/**
 * The read query the copilot forms. Every field maps 1:1 onto the ledger lens read (ReadQuery): a shipment
 * scope, a kind filter (a SET), and a bounded limit. The port NARROWS through the lens — it can never widen
 * what the caller may see.
 */
export interface CopilotReadQuery {
  shipment_id?: string;
  kind?: readonly EventKind[];
  limit?: number;
}

/** The port: retrieve lens-scoped events. The ONLY way the core reaches the ledger — read-only, no write seam. */
export interface CopilotReadPort {
  readEvents(query: CopilotReadQuery): Promise<ReadEvent[]>;
}
