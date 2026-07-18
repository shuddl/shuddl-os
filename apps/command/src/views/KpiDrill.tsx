import { useEffect, useState } from "react";
import { Button, Display, Divider, Mono } from "@shuddl/design";
import { ApiError, get } from "../lib/api.js";
import { hhmm } from "./ui.js";
import { KPI_DRILL_VIEW, kpiFormat, kpiScale, type KpiTile } from "./registry.js";

// WP-10 Task 12 (REQ-083/084) — the KPI DRILL. "Every KPI clicks through to its ledger events" (the DoD): a tile's
// click lands here on /kpi/:metric, which resolves the tile's `backing.kinds` (from GET /v1/kpis — the SERVER owns
// the backing kinds) and reads GET /v1/events?kind=<kinds> (the Task-1 kind filter). The drill is one component
// parameterized by metric onto the canonical detail views (v_lane_pnl / v_aging / v_scoreboards / v_unbilled /
// v_parity) — NOT a 13th view (REQ-084). Each backing event is clickable to open its shipment's lens on the board.
// A null metric is the drill INDEX (pick a KPI). Read-only.

// The stored-event fields the drill needs (a LedgerEvent on the wire carries more; we read only these).
interface DrillEvent {
  id: string;
  kind: string;
  ts: number;
  shipment_id?: string;
}

export interface KpiDrillProps {
  metric: string | null;
  onSelectMetric: (key: string) => void;
  onOpenShipment: (shipmentId: string) => void;
  onClose: () => void;
  onAuthError: () => void;
}

export function KpiDrill({ metric, onSelectMetric, onOpenShipment, onClose, onAuthError }: KpiDrillProps): React.JSX.Element {
  const [tiles, setTiles] = useState<KpiTile[]>([]);
  const [events, setEvents] = useState<DrillEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    async function load(): Promise<void> {
      const kpiRes = await get<{ kpis: KpiTile[] }>("/v1/kpis");
      if (!live) return;
      setTiles(kpiRes.kpis);
      const tile = metric !== null ? kpiRes.kpis.find((t) => t.key === metric) : undefined;
      if (tile === undefined) {
        setEvents([]); // the index (no metric) or an unknown metric — nothing to drill, show the picker
        return;
      }
      // The DoD click-through: read the exact events that back this tile via the Task-1 kind filter.
      const kinds = tile.backing.kinds.join(",");
      const evRes = await get<{ events: DrillEvent[] }>(`/v1/events?kind=${encodeURIComponent(kinds)}`);
      if (live) setEvents(evRes.events);
    }
    load()
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD DRILL");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [metric, onAuthError]);

  const tile = metric !== null ? tiles.find((t) => t.key === metric) : undefined;
  const view = metric !== null ? KPI_DRILL_VIEW[metric] ?? "v_kpi_strip" : "v_kpi_strip";
  const valueText =
    tile === undefined ? "" : tile.value === "UNKNOWN" ? "—" : kpiFormat(tile.unit)(kpiScale(tile.unit, tile.value as number));

  return (
    <section
      aria-label="KPI drill"
      style={{ position: "absolute", top: 84, left: 24, background: "var(--field)", padding: 20, minWidth: 320, maxWidth: "min(560px, 92vw)", display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
        <Mono size={10} color="var(--signal-55)">
          {view}
        </Mono>
        <Button onClick={onClose}>Close</Button>
      </div>

      {metric === null || tile === undefined ? (
        // The drill INDEX — pick a KPI to drill (no fabricated content when there is no metric).
        <>
          <Display size="sub">KPI DRILL</Display>
          <Mono size={11}>SELECT A KPI</Mono>
          {tiles.map((t) => (
            <div key={t.key}>
              <Divider />
              <div style={{ padding: "6px 0" }}>
                <Button onClick={() => onSelectMetric(t.key)}>{t.label}</Button>
              </div>
            </div>
          ))}
        </>
      ) : (
        <>
          <Display size="sub">{tile.label}</Display>
          <Display size="metric">{valueText}</Display>
          <Mono size={10} color="var(--signal-55)">
            BACKING EVENTS · {tile.backing.kinds.join(" · ")}
          </Mono>
          {loading ? (
            <Mono size={11}>SYNCING</Mono>
          ) : error !== null ? (
            <Mono size={11} color="var(--signal-deep)">
              {error}
            </Mono>
          ) : events.length === 0 ? (
            <Mono size={11}>NO BACKING EVENTS YET</Mono>
          ) : (
            events.map((e) => {
              const content = (
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline", padding: "8px 0" }}>
                  <Mono size={12}>{e.kind}</Mono>
                  <Mono size={10} color="var(--signal-55)">
                    {e.shipment_id ?? "—"} · {hhmm(e.ts)}
                  </Mono>
                </div>
              );
              return (
                <div key={e.id}>
                  <Divider />
                  {e.shipment_id !== undefined ? (
                    <button
                      type="button"
                      onClick={() => onOpenShipment(e.shipment_id as string)}
                      aria-label={`Open ${e.shipment_id}`}
                      style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", textAlign: "left", width: "100%", display: "block" }}
                    >
                      {content}
                    </button>
                  ) : (
                    content
                  )}
                </div>
              );
            })
          )}
        </>
      )}
    </section>
  );
}
