import { Display, Divider, Mono, TextLink } from "@shuddl/design";
import type { Status } from "./entities.js";

// The lens panel (REQ-080): clicking a mark opens a right-side --ink-dark panel with the shipment's
// event tail. The MAP NEVER NAVIGATES AWAY — this is an overlay on the same canvas; closing it
// returns to the board. Built entirely from @shuddl/design primitives, so it inherits the type/case/
// divider law and stays audit-clean (only var(--token) colours, 1px dividers, no shadow/radius).

export interface LensEvent {
  kind: string;
  at: string;
  detail?: string;
}

export interface LensPanelProps {
  shipmentId: string;
  label?: string;
  status?: Status;
  events: LensEvent[];
  onClose?: () => void;
}

export function LensPanel({ shipmentId, label, status, events, onClose }: LensPanelProps): React.JSX.Element {
  return (
    <aside
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        maxWidth: "100%",
        background: "var(--ink-dark)",
        borderLeft: "1px solid var(--signal-12)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        overflowY: "auto",
      }}
    >
      <Display size="sub" color="var(--field-on-dark)">
        {label ?? shipmentId}
      </Display>
      <Mono size={11} color="var(--signal-55)">
        {shipmentId}
        {status ? ` · ${status}` : ""}
      </Mono>
      <Divider />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {events.length === 0 ? (
          <Mono size={11} color="var(--signal-55)">
            No events yet
          </Mono>
        ) : (
          events.map((event, i) => (
            <div key={`${event.kind}-${event.at}-${i}`} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Mono size={11} color="var(--field-on-dark)">
                {event.kind}
              </Mono>
              <Mono size={10} color="var(--signal-55)">
                {event.at}
                {event.detail ? ` · ${event.detail}` : ""}
              </Mono>
            </div>
          ))
        )}
      </div>
      {onClose ? (
        <TextLink onClick={onClose}>Close</TextLink>
      ) : null}
    </aside>
  );
}
