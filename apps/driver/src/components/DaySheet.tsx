import { Display, Mono } from "@shuddl/design";
import type { Stop } from "../data/stops.js";
import { Screen } from "./Screen.js";

// REQ-062 — the day sheet: the driver's ordered stops. Tapping a row enters that stop's gated flow.
// One teal line marks the day's progress (stops cleared); each row is a big tap target, greige type on
// the ink ground, 1px `--signal-12` dividers doing all the hierarchy work.
export function DaySheet({
  stops,
  doneCount = 0,
  onOpen,
}: {
  stops: readonly Stop[];
  doneCount?: number;
  onOpen: (stop: Stop) => void;
}): React.JSX.Element {
  const pct = stops.length > 0 ? Math.round((doneCount / stops.length) * 100) : 0;
  return (
    <Screen>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Mono size={11} color="var(--signal-55)">
          MON JUL 13 · {stops.length} STOPS · PORTLAND LOOP
        </Mono>
        <Display size="section" color="var(--field-on-dark)">
          Day sheet
        </Display>
        <div style={{ height: 4, background: "var(--signal-12)", width: "100%" }}>
          <div style={{ height: 4, background: "var(--progress)", width: `${pct}%` }} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", overflowY: "auto", flex: 1, marginTop: 24 }}>
        {stops.map((stop) => (
          <button
            key={stop.id}
            type="button"
            onClick={() => onOpen(stop)}
            style={{
              display: "flex",
              gap: 18,
              alignItems: "flex-start",
              textAlign: "left",
              background: "transparent",
              border: "none",
              borderTop: "1px solid var(--signal-12)",
              padding: "22px 2px",
              cursor: "pointer",
              width: "100%",
            }}
          >
            <Mono size={13} color="var(--signal-55)">
              {String(stop.seq).padStart(2, "0")}
            </Mono>
            <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Mono size={11} color="var(--signal)">
                {stop.kind}
              </Mono>
              <Display size="sub" color="var(--field-on-dark)">
                {stop.name}
              </Display>
              <Mono size={11} color="var(--signal-55)">
                {stop.address} · {stop.window}
              </Mono>
            </span>
          </button>
        ))}
      </div>

      <Mono size={11} color="var(--signal-55)">
        OFFLINE — TAP A STOP TO BEGIN
      </Mono>
    </Screen>
  );
}
