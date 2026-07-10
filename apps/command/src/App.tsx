import { useMemo, useState } from "react";
import { Button, Display, Divider, Metric, Mono, Reveal } from "@shuddl/design";
import {
  DEMO_GLYPHS_URL,
  DEMO_TILE_URL,
  LensPanel,
  MapCanvas,
  demoFleet,
  fleet1k,
  useFleet,
} from "@shuddl/map";

// (01) COMMAND — the map IS the home (REQ-073/080). Full-viewport greige canvas of the whole fleet,
// a 1px-divided count-up KPI strip, dark queue panels, and the ⌘K command bar. Chrome floats over the
// canvas; clicking a mark opens the lens WITHOUT navigating away. Deterministic (seeded demoFleet) so
// the canonical screenshot is stable. `?perf` swaps in the 1,000-entity fleet1k() for pnpm perf:map.

const KPIS: ReadonlyArray<{ label: string; value: number; format: (n: number) => string }> = [
  { label: "OR", value: 94, format: (n) => `${n}%` },
  { label: "DSO", value: 38, format: (n) => `${n}D` },
  { label: "UNBILLED", value: 0, format: (n) => `$${n}` },
  { label: "OTD", value: 98, format: (n) => `${n}%` },
  { label: "DWELL", value: 47, format: (n) => `${n}M` },
];

const NAV_LINKS = ["BOARD", "QUEUES", "MONEY", "SETTINGS"] as const;

function usePerfMode(): boolean {
  return useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).has("perf");
  }, []);
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
  const source = useMemo(() => (perf ? fleet1k() : demoFleet()), [perf]);
  const { collection } = useFleet({ scope: "command" }, source);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <main style={{ position: "fixed", inset: 0, background: "var(--field)", overflow: "hidden" }}>
      <MapCanvas tileUrl={DEMO_TILE_URL} glyphsUrl={DEMO_GLYPHS_URL} fleet={collection} onSelect={setSelected} />

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

      {/* The ⌘K command bar — dark strip, mono uppercase, red caret. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          background: "var(--ink-dark)",
          padding: "14px 24px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          borderTop: "1px solid var(--signal-12)",
        }}
      >
        <Mono size={12} color="var(--field-on-dark)">
          ⌘K
        </Mono>
        <Mono size={12} color="var(--signal-55)">
          Type a command — quote, dispatch, invoice
        </Mono>
        <span aria-hidden style={{ width: 8, height: 15, background: "var(--signal)" }} />
      </div>

      {selected ? (
        <LensPanel
          shipmentId={selected}
          label={selected}
          status="healthy"
          events={[
            { kind: "PICKUP", at: "07:12", detail: "SEAL 88421" },
            { kind: "IN TRANSIT", at: "09:40" },
          ]}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {/* Keep the Divider primitive referenced so the board reads as one ruled system. */}
      <div style={{ display: "none" }} aria-hidden>
        <Divider />
      </div>
    </main>
  );
}
