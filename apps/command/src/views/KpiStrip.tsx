import { Display, Metric, Mono } from "@shuddl/design";
import { kpiFormat, kpiScale, type KpiTile } from "./registry.js";

// WP-10 Task 12 (REQ-083) — the KPI STRIP (v_kpi_strip). The 1px-divided count-up strip, now over the REAL
// GET /v1/kpis numbers (App fetches once and passes them in). HONESTY:
//   · a real number counts up via Metric/CountUp; a bps tile shows a whole percent; money is integer-cents;
//   · a tile whose value is "UNKNOWN" shows an honest em-dash "—" + "NO DATA" — NEVER a fabricated 0 or 100%;
//   · every tile CLICKS THROUGH to its ledger events — onTile(key) navigates to the kind-filtered KPI drill
//     (GET /v1/events?kind=<backing.kinds>), the DoD "every KPI clicks through to its ledger events".
// The OR tile arrives already labeled honestly by the server ("Cost/Rev (quoted basis)", not "Operating Ratio").

export interface KpiStripProps {
  kpis: KpiTile[];
  loading: boolean;
  error: string | null;
  onTile: (key: string) => void;
}

function KpiTileButton({ tile, onClick }: { tile: KpiTile; onClick: () => void }): React.JSX.Element {
  const unknown = tile.value === "UNKNOWN";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${tile.label} — drill to ledger events`}
      style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", textAlign: "left", minWidth: 96 }}
    >
      {unknown ? (
        // HONEST no-data: an em-dash value + a mono "NO DATA" — never a fabricated number.
        <div style={{ borderTop: "1px solid var(--signal-12)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          <Display size="metric" color="var(--signal-deep)">
            —
          </Display>
          <Mono size={10}>{tile.label} · NO DATA</Mono>
        </div>
      ) : (
        <Metric label={tile.label} value={kpiScale(tile.unit, tile.value as number)} format={kpiFormat(tile.unit)} />
      )}
    </button>
  );
}

export function KpiStrip({ kpis, loading, error, onTile }: KpiStripProps): React.JSX.Element {
  return (
    <section aria-label="Board KPIs" style={{ position: "absolute", left: 24, bottom: 84, background: "var(--field)", padding: 16, maxWidth: "min(760px, 92vw)" }}>
      <Mono size={10} color="var(--signal-55)">
        (01) BOARD — KPIS
      </Mono>
      {loading ? (
        <div style={{ marginTop: 8 }}>
          <Mono size={11}>SYNCING KPIS</Mono>
        </div>
      ) : error !== null ? (
        <div style={{ marginTop: 8 }}>
          <Mono size={11} color="var(--signal-deep)">
            {error}
          </Mono>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "stretch", marginTop: 8, flexWrap: "wrap" }}>
          {kpis.map((k, i) => (
            <div key={k.key} style={{ display: "flex", alignItems: "stretch" }}>
              {i > 0 ? <div style={{ width: 1, background: "var(--signal-12)", margin: "0 16px" }} /> : null}
              <KpiTileButton tile={k} onClick={() => onTile(k.key)} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
