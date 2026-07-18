import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Display, Mono } from "@shuddl/design";
import {
  DEMO_GLYPHS_URL,
  DEMO_TILE_URL,
  LensPanel,
  MapCanvas,
  fleet1k,
  useFleet,
  type FleetItem,
  type LensEvent,
  type Status,
} from "@shuddl/map";
import { ApiError, get, post } from "./lib/api.js";
import { fetchBoard, fetchShipmentEvents } from "./lib/board.js";
import { clear as clearSession } from "./session.js";
import { CommandBar } from "./command/CommandBar.js";
import type { CommandDeps } from "./command/registry.js";
import { IntakeFlow } from "./intake/IntakeFlow.js";
import { resolveRoute, type Route } from "./router.js";
import { ApprovalsQueue } from "./views/ApprovalsQueue.js";
import { ExceptionsQueue } from "./views/ExceptionsQueue.js";
import { MoneyQueue } from "./views/MoneyQueue.js";
import { KpiStrip } from "./views/KpiStrip.js";
import { KpiDrill } from "./views/KpiDrill.js";
import { CopilotPanel } from "./views/CopilotPanel.js";
import type { KpiTile, KpiValue } from "./views/registry.js";

// (01) COMMAND — the map IS the home (REQ-073/080). Full-viewport greige canvas of the whole fleet, a live
// count-up KPI strip, the three dark queue panels, and the ⌘K command bar. Chrome floats over the canvas;
// clicking a mark opens the lens WITHOUT navigating away. Task 12 (REQ-082/083/038/084) replaces the old
// HARDCODED KPI tiles + queue panels with LIVE, honest views over the Task 2-7 server reads, organized by the
// Task-8 router (≤12 canonical views): the board's KPI strip + the three queues, the KPI drill-through, and the
// ⌘K copilot. The fleet is the REAL lens-scoped board (GET /v1/board); `?perf` swaps in the deterministic
// 1,000-entity fleet1k() for the frame-budget harness (REQ-079) and suppresses the live chrome (no network).

const NAV_LINKS = ["BOARD", "QUEUES", "MONEY", "SETTINGS"] as const;

// Opt-in Mapbox tiles when VITE_MAPBOX_TOKEN is set at build; unset ⇒ self-hosted default (REQ-075).
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

function usePerfMode(): boolean {
  return useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).has("perf");
  }, []);
}

// The live board feed (REQ-073/080). Loads GET /v1/board once and maps it to FleetItem[] for useFleet. On a 401
// (Task 8 isAuthError) it drops the session (the re-auth path) and surfaces an honest empty map; any other read
// failure ALSO yields an empty map — the canvas never invents synthetic marks. `enabled` is false in ?perf mode.
function useBoardFleet(enabled: boolean): { fleet: FleetItem[]; authExpired: boolean } {
  const [fleet, setFleet] = useState<FleetItem[]>([]);
  const [authExpired, setAuthExpired] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchBoard()
      .then((items) => {
        if (cancelled) return;
        setFleet(items);
        setAuthExpired(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.isAuthError) {
          clearSession(); // drop the rejected token — the shell must re-authenticate (magic link, WP-14)
          setAuthExpired(true);
        }
        setFleet([]); // honest empty map on any failure — no synthetic marks
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return { fleet, authExpired };
}

// The KPI strip's data (REQ-083). Loads GET /v1/kpis once — the SIX honest tiles (a real number OR "UNKNOWN",
// never fabricated). Shared by the strip AND the money queue (its `unbilled` tile), so App fetches it ONCE.
function useKpis(enabled: boolean): { kpis: KpiTile[]; loading: boolean; error: string | null } {
  const [kpis, setKpis] = useState<KpiTile[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    get<{ kpis: KpiTile[] }>("/v1/kpis")
      .then((res) => {
        if (live) setKpis(res.kpis);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          clearSession();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD KPIS");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  return { kpis, loading, error };
}

// The selected mark's lens-scoped event tail (REQ-080). Fetches GET /v1/shipments/:id/events when a mark is open;
// clears when the panel closes. A read failure shows an empty tail — never fabricated events.
function useShipmentEvents(shipmentId: string | null): LensEvent[] {
  const [events, setEvents] = useState<LensEvent[]>([]);
  useEffect(() => {
    if (shipmentId === null) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void fetchShipmentEvents(shipmentId)
      .then((tail) => {
        if (!cancelled) setEvents(tail);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [shipmentId]);
  return events;
}

function currentLocation(): { pathname: string; search: string; hash: string } {
  return { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash };
}

// The Task-8 router as live state (REQ-081/084). resolveRoute maps window.location → one of the command screens;
// popstate keeps back/forward honest; navigate() pushes AND re-resolves (pushState alone does not fire popstate),
// so a ⌘K nav or a KPI tile click updates the view immediately. This organizes EXISTING canonical views — never
// a 13th (REQ-084).
function useRouter(): { route: Route; navigate: (path: string) => void } {
  const [route, setRoute] = useState<Route>(() => resolveRoute(currentLocation()));
  useEffect(() => {
    const onPop = (): void => setRoute(resolveRoute(currentLocation()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((path: string): void => {
    globalThis.history?.pushState(null, "", path);
    setRoute(resolveRoute(currentLocation()));
  }, []);
  return { route, navigate };
}

export function App(): React.JSX.Element {
  const perf = usePerfMode();
  // ?perf ⇒ the deterministic 1,000-entity fixture (frame-budget harness); otherwise the REAL live board.
  const perfSource = useMemo(() => (perf ? fleet1k() : null), [perf]);
  const { fleet: liveFleet, authExpired } = useBoardFleet(!perf);
  const source = perfSource ?? liveFleet;
  const { collection } = useFleet({ scope: "command" }, source);
  const { kpis, loading: kpisLoading, error: kpisError } = useKpis(!perf);
  const { route, navigate } = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false); // the CSR net-new intake flow (REQ-150, Task 11)
  const lensEvents = useShipmentEvents(selected);

  // Opening a shipment selects its lens on the map home AND returns to the board (closing any drill/copilot
  // overlay), so a click-through from a queue / KPI drill / copilot citation lands on the shipment in context.
  const openShipment = useCallback(
    (id: string): void => {
      setSelected(id);
      navigate("/");
    },
    [navigate],
  );

  // (01) The ⌘K palette seams (REQ-081). Navigation routes through the SAME useRouter navigate (so the view
  // updates); opening a shipment selects its lens; the intake flow is launched here (BUILT by Task 11). Mutations
  // go through the api client (a fresh Idempotency-Key per call).
  const commandDeps = useMemo<CommandDeps>(
    () => ({
      navigate,
      openShipment,
      openIntake: () => setIntakeOpen(true),
      api: { get, post },
    }),
    [navigate, openShipment],
  );

  // The selected mark's status comes straight from the fleet item the board fed in (never hardcoded).
  const selectedStatus = useMemo<Status>(
    () => source.find((i) => i.shipment_id === selected)?.status ?? "healthy",
    [source, selected],
  );

  // The MONEY queue's unbilled-PODs count is the KPI strip's own `unbilled` tile (one /v1/kpis read, shared).
  const unbilled = useMemo<KpiValue>(() => {
    const tile = kpis.find((k) => k.key === "unbilled");
    return tile ? tile.value : "UNKNOWN";
  }, [kpis]);

  return (
    <main style={{ position: "fixed", inset: 0, background: "var(--field)", overflow: "hidden" }}>
      <MapCanvas tileUrl={DEMO_TILE_URL} glyphsUrl={DEMO_GLYPHS_URL} fleet={collection} onSelect={setSelected} mapboxToken={MAPBOX_TOKEN} />

      {/* Transparent nav — wordmark, micro-mono links, one dark CTA. */}
      <nav
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "18px 24px",
          gap: 24,
        }}
      >
        <Display size="sub">SHUDDL</Display>
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          {/* Re-auth signal (Task 8 isAuthError): the token was rejected + cleared; the operator must sign in
              again. Honest note in the alarm token — the map is empty because there is NO session, not no fleet. */}
          {authExpired ? (
            <Mono size={11} color="var(--signal)">
              SESSION EXPIRED — SIGN IN AGAIN
            </Mono>
          ) : null}
          {NAV_LINKS.map((l) => (
            <Mono key={l} size={11}>
              {l}
            </Mono>
          ))}
          <Button>New Quote</Button>
        </div>
      </nav>

      {/* The live chrome — suppressed in ?perf (the frame-budget harness renders ONLY the map, hits no network). */}
      {!perf ? (
        <>
          {/* (01) BOARD — the live count-up KPI strip; every tile clicks through to its ledger events (REQ-083). */}
          <KpiStrip kpis={kpis} loading={kpisLoading} error={kpisError} onTile={(key) => navigate(`/kpi/${key}`)} />

          {/* (02) QUEUES + (03) MONEY — the three live dark panels (REQ-082). */}
          <aside style={{ position: "absolute", top: 84, right: 24, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" }}>
            <Mono size={10} color="var(--signal-55)">
              (02) QUEUES
            </Mono>
            <ApprovalsQueue onAuthError={clearSession} />
            <ExceptionsQueue onAuthError={clearSession} onOpenShipment={openShipment} />
            <Mono size={10} color="var(--signal-55)">
              (03) MONEY
            </Mono>
            <MoneyQueue unbilled={unbilled} onAuthError={clearSession} />
          </aside>
        </>
      ) : null}

      {/* The ⌘K command palette (REQ-081) — the real DETERMINISTIC command bar. */}
      <CommandBar deps={commandDeps} />

      {selected ? (
        <LensPanel
          shipmentId={selected}
          label={selected}
          status={selectedStatus}
          events={lensEvents}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {/* The CSR net-new intake flow (REQ-150) — launched by the ⌘K "New Order (CSR Intake)" command. */}
      {intakeOpen ? (
        <IntakeFlow
          api={{ get, post }}
          onClose={() => setIntakeOpen(false)}
          onOpenShipment={(id) => setSelected(id)}
          onAuthError={clearSession}
        />
      ) : null}

      {/* Route-driven overlays: the KPI drill-through (kind-filtered ledger events) and the ⌘K copilot. */}
      {!perf && route.name === "kpi" ? (
        <KpiDrill
          metric={route.metric}
          onSelectMetric={(key) => navigate(`/kpi/${key}`)}
          onOpenShipment={openShipment}
          onClose={() => navigate("/")}
          onAuthError={clearSession}
        />
      ) : null}
      {!perf && route.name === "copilot" ? <CopilotPanel onOpenShipment={openShipment} onClose={() => navigate("/")} /> : null}
    </main>
  );
}
