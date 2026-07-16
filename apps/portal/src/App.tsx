import { useCallback, useMemo, useState } from "react";
import { Button, Display, Mono } from "@shuddl/design";
import { DEMO_GLYPHS_URL, DEMO_TILE_URL, MapCanvas, demoFleet, useFleet } from "@shuddl/map";
import { adoptTokenFromUrl, clear, getClaims, isAuthed } from "./session.js";
import { ShipmentList } from "./components/ShipmentList.js";
import { QuotePanel } from "./components/QuotePanel.js";
import { DocumentsView } from "./views/DocumentsView.js";
import { InvoicesView } from "./views/InvoicesView.js";
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

export function App(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(initialMode);

  const handleAuthError = useCallback((): void => {
    clear();
    setMode({ kind: "reauth" });
  }, []);

  if (mode.kind === "reauth") return <ReAuthPrompt />;
  return <Board partyId={mode.partyId} onAuthError={handleAuthError} />;
}

// The board's secondary lists live behind a tiny tab nav. OVERVIEW keeps the WP-10 map + quote→book + the
// ruled shipment/invoice list; the other tabs surface the WP-09 Task 6/7/8 views (documents / invoices /
// custody-chain+claims). Documents and Claims need a SELECTED shipment (picked on OVERVIEW); until one is
// chosen they show a hint rather than a broken read.
type PortalView = "overview" | "documents" | "invoices" | "claims";
const TABS: ReadonlyArray<{ view: PortalView; label: string }> = [
  { view: "overview", label: "OVERVIEW" },
  { view: "documents", label: "DOCUMENTS" },
  { view: "invoices", label: "INVOICES" },
  { view: "claims", label: "CLAIMS" },
];

function Board({ partyId, onAuthError }: { partyId: string; onAuthError: () => void }): React.JSX.Element {
  // The party lens scopes the fleet to this party's own shipments (defence-in-depth; the server lens is
  // authoritative and never sends out-of-scope marks). The live DO fan-out is WP-10 — until then the source
  // is the demo fleet, scoped to the party, so a real party sees only its OWN marks (never another party's).
  const source = useMemo(() => demoFleet(), []);
  const { collection } = useFleet({ scope: "party", partyId }, source);

  const [selectedShipmentId, setSelectedShipmentId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<PortalView>("overview");

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
