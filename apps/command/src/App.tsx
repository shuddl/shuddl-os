import { useEffect, useMemo, useState } from "react";
import { Button, Display, Divider, Metric, Mono, Reveal } from "@shuddl/design";
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

// (01) COMMAND — the map IS the home (REQ-073/080). Full-viewport greige canvas of the whole fleet,
// a 1px-divided count-up KPI strip, dark queue panels, and the ⌘K command bar. Chrome floats over the
// canvas; clicking a mark opens the lens WITHOUT navigating away. The fleet is the REAL lens-scoped board
// (GET /v1/board) — so the exception marks reflect ACTUAL ledger state and the exception-pulse / world-dim
// demo #5 fires on real data (an empty board renders an honest empty map, never synthetic marks). `?perf`
// swaps in the deterministic 1,000-entity fleet1k() for the pnpm perf:map frame-budget harness (REQ-079).

const KPIS: ReadonlyArray<{ label: string; value: number; format: (n: number) => string }> = [
  { label: "OR", value: 94, format: (n) => `${n}%` },
  { label: "DSO", value: 38, format: (n) => `${n}D` },
  { label: "UNBILLED", value: 0, format: (n) => `$${n}` },
  { label: "OTD", value: 98, format: (n) => `${n}%` },
  { label: "DWELL", value: 47, format: (n) => `${n}M` },
];

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
// failure ALSO yields an empty map — the canvas never invents synthetic marks. `enabled` is false in ?perf mode
// so the perf harness renders the deterministic fleet1k() instead of hitting the network.
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

// The selected mark's lens-scoped event tail (REQ-080). Fetches GET /v1/shipments/:id/events when a mark is
// open; clears when the panel closes. A read failure shows an empty tail (the panel renders "No events yet") —
// never fabricated events.
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

function QueuePanel({ heading, rows }: { heading: string; rows: ReadonlyArray<[string, string]> }): React.JSX.Element {
  return (
    <Reveal>
      <div style={{ background: "var(--ink-dark)", padding: 16, minWidth: 240, display: "flex", flexDirection: "column", gap: 10 }}>
        <Mono size={10} color="var(--signal-55)">
          {heading}
        </Mono>
        {rows.map(([name, count]) => (
          <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
            <Mono size={12} color="var(--field-on-dark)">
              {name}
            </Mono>
            <Display size="metric" color="var(--field-on-dark)">
              {count}
            </Display>
          </div>
        ))}
      </div>
    </Reveal>
  );
}

export function App(): React.JSX.Element {
  const perf = usePerfMode();
  // ?perf ⇒ the deterministic 1,000-entity fixture (frame-budget harness); otherwise the REAL live board.
  const perfSource = useMemo(() => (perf ? fleet1k() : null), [perf]);
  const { fleet: liveFleet, authExpired } = useBoardFleet(!perf);
  const source = perfSource ?? liveFleet;
  const { collection } = useFleet({ scope: "command" }, source);
  const [selected, setSelected] = useState<string | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false); // the CSR net-new intake flow (REQ-150, Task 11)
  const lensEvents = useShipmentEvents(selected);

  // (01) The ⌘K palette seams (REQ-081). Navigation changes the router URL (the queue/KPI/copilot views are wired
  // by sibling WP-10 tasks); opening a shipment selects its lens on THIS map home; the intake flow is LAUNCHED here
  // and BUILT by Task 11. Mutations go through the api client (a fresh Idempotency-Key per call). Stable identity.
  const commandDeps = useMemo<CommandDeps>(
    () => ({
      navigate: (path) => {
        globalThis.history?.pushState(null, "", path);
      },
      openShipment: (id) => setSelected(id),
      openIntake: () => setIntakeOpen(true), // Task 11 owns the flow; the palette only launches it
      api: { get, post },
    }),
    [],
  );
  // The selected mark's status comes straight from the fleet item the board fed in (never hardcoded).
  const selectedStatus = useMemo<Status>(
    () => source.find((i) => i.shipment_id === selected)?.status ?? "healthy",
    [source, selected],
  );

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

      {/* (01) BOARD — the 1px-divided count-up KPI strip. */}
      <section
        aria-label="Board KPIs"
        style={{ position: "absolute", left: 24, bottom: 84, background: "var(--field)", padding: 16, maxWidth: "min(680px, 92vw)" }}
      >
        <Mono size={10} color="var(--signal-55)">
          (01) BOARD
        </Mono>
        <div style={{ display: "flex", alignItems: "stretch", marginTop: 8 }}>
          {KPIS.map((k, i) => (
            <div key={k.label} style={{ display: "flex", alignItems: "stretch" }}>
              {i > 0 ? <div style={{ width: 1, background: "var(--signal-12)", margin: "0 16px" }} /> : null}
              <div style={{ minWidth: 84 }}>
                <Metric label={k.label} value={k.value} format={k.format} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* (02) QUEUES + (03) MONEY — dark panels. */}
      <aside style={{ position: "absolute", top: 84, right: 24, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" }}>
        <Mono size={10} color="var(--signal-55)">
          (02) QUEUES
        </Mono>
        <QueuePanel
          heading="APPROVALS"
          rows={[
            ["RATE HOLDS", "4"],
            ["CREDIT", "2"],
          ]}
        />
        <QueuePanel
          heading="EXCEPTIONS"
          rows={[
            ["OS&D", "1"],
            ["DETENTION", "3"],
          ]}
        />
        <Mono size={10} color="var(--signal-55)">
          (03) MONEY
        </Mono>
        <QueuePanel
          heading="READY TO SETTLE"
          rows={[
            ["INVOICED TODAY", "$128K"],
            ["AGING >45D", "$0"],
          ]}
        />
      </aside>

      {/* The ⌘K command palette (REQ-081) — the real DETERMINISTIC command bar. Mounts the bottom ⌘K affordance
          AND the global keydown-driven overlay palette. Replaces the old decorative strip (no input, no dispatch). */}
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

      {/* The CSR net-new intake flow (REQ-150) — launched by the ⌘K "New Order (CSR Intake)" command. On book it
          offers to open the new shipment's lens on THIS map home; a 401 drops the session (the re-auth path). */}
      {intakeOpen ? (
        <IntakeFlow
          api={{ get, post }}
          onClose={() => setIntakeOpen(false)}
          onOpenShipment={(id) => setSelected(id)}
          onAuthError={clearSession}
        />
      ) : null}

      {/* Keep the Divider primitive referenced so the board reads as one ruled system. */}
      <div style={{ display: "none" }} aria-hidden>
        <Divider />
      </div>
    </main>
  );
}
