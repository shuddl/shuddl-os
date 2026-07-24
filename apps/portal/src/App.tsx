import { useCallback, useMemo, useState } from "react";
import { Button, Display, Mono } from "@shuddl/design";
import { DEMO_GLYPHS_URL, DEMO_TILE_URL, MapCanvas, useFleet } from "@shuddl/map";
import { adoptTokenFromUrl, clear, getClaims, isAuthed } from "./session.js";
import { freshnessLabel, usePartyBoard, type PartyBoardState } from "./api/board.js";
import { ShipmentList } from "./components/ShipmentList.js";
import { QuotePanel } from "./components/QuotePanel.js";
import { DocumentsView } from "./views/DocumentsView.js";
import { InvoicesView } from "./views/InvoicesView.js";
import { StatementView } from "./views/StatementView.js";
import { ClaimsView } from "./views/ClaimsView.js";

// CLIENT PORTAL (REQ-085/051) — the SAME operational map, scoped to ONE party through the REAL session lens,
// with the quote→book panel and the ruled lists wired to the live server (the WP-03 shell was hardcoded
// PARTY_ID + fixture arrays + a dead "Get Quote" button). Three honesty rules govern this surface:
//   · the lens is the party_id from the SIGNED session claim (client defence-in-depth; the SERVER lens is
//     authoritative — REQ-030). useFleet({scope:"party"}) keeps generalized positions generalized (REQ-074).
//   · a missing/expired session (or one with no party_id) renders a clean re-auth prompt — never a broken
//     board; any ApiError.isAuthError from a child call drops the session and shows the same prompt.
//   · nothing is fabricated: the map shows only the party's own marks, money is integer cents, transit is
//     honest, and the party can never book directly — it only accepts (the Booking agent gate is server-side).

// Opt-in Mapbox tiles when VITE_MAPBOX_TOKEN is set at build; unset ⇒ self-hosted default (REQ-075).
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

type Mode = { kind: "authed"; partyId: string } | { kind: "reauth" };

// Resolve the initial lens ONCE: adopt a magic-link `?token=` if present (persist + strip it from the URL),
// then read the (unverified, display-only) claims. An authed session with a party_id ⇒ the board; anything
// else ⇒ the re-auth prompt. The server re-verifies every call regardless of what the client believes.
function initialMode(): Mode {
  adoptTokenFromUrl();
  const claims = getClaims();
  if (isAuthed() && claims?.party_id) return { kind: "authed", partyId: claims.party_id };
  return { kind: "reauth" };
}

// `initialView` opens the board directly on a tab — the portal router resolves a `?screen=statement`
// (or `/statement`) deep-link so a bill-to party can be sent straight to its STATEMENT (REQ-090). Absent
// or unknown ⇒ OVERVIEW, unchanged.
export function App({ initialView }: { initialView?: PortalView | undefined } = {}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(initialMode);

  const handleAuthError = useCallback((): void => {
    clear();
    setMode({ kind: "reauth" });
  }, []);

  if (mode.kind === "reauth") return <ReAuthPrompt />;
  return <Board partyId={mode.partyId} onAuthError={handleAuthError} initialView={initialView} />;
}

// The board's secondary lists live behind a tiny tab nav. OVERVIEW keeps the WP-10 map + quote→book + the
// ruled shipment/invoice list; the other tabs surface the WP-09 Task 6/7/8 views (documents / invoices /
// custody-chain+claims). Documents and Claims need a SELECTED shipment (picked on OVERVIEW); until one is
// chosen they show a hint rather than a broken read.
// STATEMENT (REQ-090) is the bill-to party's account view — aging + paid-vs-open + a remit affordance —
// rolled up client-side over the SAME lens-scoped GET /v1/invoices the INVOICES tab reads (not a new surface).
export type PortalView = "overview" | "documents" | "invoices" | "statement" | "claims";
const TABS: ReadonlyArray<{ view: PortalView; label: string }> = [
  { view: "overview", label: "OVERVIEW" },
  { view: "documents", label: "DOCUMENTS" },
  { view: "invoices", label: "INVOICES" },
  { view: "statement", label: "STATEMENT" },
  { view: "claims", label: "CLAIMS" },
];

function Board({ partyId, onAuthError, initialView }: { partyId: string; onAuthError: () => void; initialView?: PortalView | undefined }): React.JSX.Element {
  // The party's live fleet from the AUTHORITATIVE server board (GET /v1/board) — scoped to this party AND
  // generalized SERVER-SIDE (REQ-085/074/025). No demoFleet anywhere: a failure shows an honest stale/empty/
  // unavailable state, never a fabricated fleet (usePartyBoard). serverScoped keeps useFleet from re-coarsening
  // the already-generalized coords, while its party_refs filter still guards against any stray non-party mark.
  const board = usePartyBoard(partyId, onAuthError);
  const lens = useMemo(() => ({ scope: "party" as const, partyId, serverScoped: true }), [partyId]);
  const { collection } = useFleet(lens, board.items);
  // The ruled SHIPMENTS list mirrors the same live board (the positioned freight the party owns), selectable.
  const shipments = useMemo(() => board.items.map((i) => ({ id: i.shipment_id, status: i.status })), [board.items]);

  const [selectedShipmentId, setSelectedShipmentId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<PortalView>(initialView ?? "overview");

  return (
    <main style={{ position: "fixed", inset: 0, background: "var(--field)", overflow: "hidden" }}>
      <MapCanvas
        tileUrl={DEMO_TILE_URL}
        glyphsUrl={DEMO_GLYPHS_URL}
        fleet={collection}
        onSelect={setSelectedShipmentId}
        mapboxToken={MAPBOX_TOKEN}
      />

      {/* Hero — the party's own live freight, keyed to the REAL lens identity (not a hardcoded name). */}
      <header style={{ position: "absolute", top: 40, left: 32, maxWidth: "70vw" }}>
        <Mono size={11} color="var(--signal-55)">
          YOUR FREIGHT · LIVE
        </Mono>
        <Display size="hero">{partyId}</Display>
        <BoardStatusLine state={board} />
        <nav style={{ display: "flex", gap: 16, marginTop: 12 }}>
          {TABS.map((t) => (
            <button
              key={t.view}
              type="button"
              aria-pressed={view === t.view}
              onClick={() => setView(t.view)}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
            >
              <Mono size={11} color={view === t.view ? "var(--signal)" : "var(--signal-55)"}>
                {t.label}
              </Mono>
            </button>
          ))}
        </nav>
      </header>

      {/* OVERVIEW keeps the live quote→book panel + the ruled shipment/invoice list. */}
      {view === "overview" ? (
        <>
          <QuotePanel shipmentId={selectedShipmentId} onAuthError={onAuthError} />
          <ShipmentList
            shipments={shipments}
            onAuthError={onAuthError}
            onSelectShipment={setSelectedShipmentId}
            selectedShipmentId={selectedShipmentId}
          />
        </>
      ) : (
        <ViewPanel>
          {view === "documents" ? (
            selectedShipmentId !== undefined ? (
              <DocumentsView shipmentId={selectedShipmentId} onAuthError={onAuthError} />
            ) : (
              <SelectHint what="documents" />
            )
          ) : null}
          {view === "invoices" ? <InvoicesView onAuthError={onAuthError} /> : null}
          {view === "statement" ? <StatementView onAuthError={onAuthError} /> : null}
          {view === "claims" ? (
            selectedShipmentId !== undefined ? (
              <ClaimsView shipmentId={selectedShipmentId} onAuthError={onAuthError} />
            ) : (
              <SelectHint what="custody chain" />
            )
          ) : null}
        </ViewPanel>
      )}
    </main>
  );
}

// The floating panel the non-overview views render into — same greige-on-field placement discipline as the
// shipment list (no cards, 1px rules do the work).
function ViewPanel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <aside
      style={{
        position: "absolute",
        bottom: 32,
        left: 32,
        width: "min(420px, 92vw)",
        maxHeight: "70vh",
        overflow: "auto",
        background: "var(--field)",
        padding: 16,
      }}
    >
      {children}
    </aside>
  );
}

// The honest freshness/health line for the live map: loading | live (with a server-derived AS OF stamp) | no
// active freight | stale (last-good stamp retained) | unavailable. It never claims freshness the server did not
// vouch for — the timestamp is the board's own `as_of`, formatted UTC (deterministic). An alarm state (stale /
// unavailable) is drawn in the one saturated token; a healthy board stays label-light on the greige field.
function boardStatusText(s: PartyBoardState): string {
  if (s.phase === "loading") return "LIVE MAP · SYNCING";
  if (s.phase === "unavailable") return "LIVE MAP · UNAVAILABLE";
  const stamp = s.asOf !== null ? freshnessLabel(s.asOf) : "—";
  if (s.stale) return `LIVE MAP · STALE · LAST OK ${stamp} UTC`;
  if (s.empty) return `LIVE MAP · NO ACTIVE FREIGHT · AS OF ${stamp} UTC`;
  return `LIVE MAP · LIVE · AS OF ${stamp} UTC`;
}

function BoardStatusLine({ state }: { state: PartyBoardState }): React.JSX.Element {
  const alarm = state.phase === "unavailable" || state.stale;
  return (
    <div data-testid="board-status" style={{ marginTop: 8 }}>
      <Mono size={10} color={alarm ? "var(--signal)" : "var(--signal-55)"}>
        {boardStatusText(state)}
      </Mono>
    </div>
  );
}

function SelectHint({ what }: { what: string }): React.JSX.Element {
  return (
    <Mono size={11} color="var(--signal-55)">
      SELECT A SHIPMENT ON OVERVIEW TO SEE ITS {what.toUpperCase()}
    </Mono>
  );
}

// A clean re-auth prompt — no session, or an expired one, or one missing a party_id. It mints NO token and
// leaks nothing; the party re-enters through a fresh magic link (WP-14). Kept on the greige field, no cards.
function ReAuthPrompt(): React.JSX.Element {
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--field)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 16,
        padding: 32,
        maxWidth: 640,
      }}
    >
      <Mono size={11} color="var(--signal-55)">
        SESSION EXPIRED
      </Mono>
      <Display size="section">SIGN IN AGAIN</Display>
      <Mono size={12} color="var(--signal-deep)">
        Your secure link has expired. Request a fresh sign-in link and we&apos;ll bring your board right back.
      </Mono>
      <div>
        <Button type="button" onClick={() => globalThis.location?.reload()}>
          Reload
        </Button>
      </div>
    </main>
  );
}
