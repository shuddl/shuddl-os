import type { ReactNode } from "react";
import { Mono, Reveal } from "@shuddl/design";

// WP-10 Task 12 (REQ-082) — the shared chrome for the command QUEUE surface. The queues are the sanctioned DARK
// panels (--ink-dark) that float over the greige map (matching the original App.tsx QueuePanel). Every token here
// is one of the five (var(--ink-dark)/--field-on-dark/--signal/--signal-55/--signal-12); borders are 1px, radius
// ≤4px, no shadow/gradient — so the design audit stays clean when it turns BLOCKING at WP-10 exit (REQ-158).

/** A stored event `ts` (epoch ms) → a compact HH:MM (UTC, deterministic across environments). Display-only. */
export function hhmm(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

export interface DarkPanelProps {
  heading: string;
  children: ReactNode;
}

/** The dark queue panel shell — a Reveal-entering --ink-dark card with a mono heading. */
export function DarkPanel({ heading, children }: DarkPanelProps): React.JSX.Element {
  return (
    <Reveal>
      <div style={{ background: "var(--ink-dark)", padding: 16, minWidth: 264, maxWidth: 320, display: "flex", flexDirection: "column", gap: 10 }}>
        <Mono size={10} color="var(--signal-55)">
          {heading}
        </Mono>
        {children}
      </div>
    </Reveal>
  );
}

export interface GhostButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

// A ghost action for DARK panels: coral text + a 1px coral hairline on transparent (the solid dark Button would
// vanish on --ink-dark). Coral-on-ink clears the contrast floor; mono + uppercase + radius 4 keep it in-system.
export function GhostButton({ children, onClick, disabled, ariaLabel }: GhostButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        fontFamily: "var(--mono)",
        fontWeight: 400,
        textTransform: "uppercase",
        fontSize: 11,
        letterSpacing: "0.08em",
        background: "transparent",
        color: "var(--signal)",
        border: "1px solid var(--signal)",
        borderRadius: 4,
        padding: "6px 14px",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

// A whole-row click affordance on a dark panel (transparent, no border) — used to open a shipment's lens from a
// queue/citation. Left-aligned, --field-on-dark text; the caller supplies the row content.
export function RowButton({ children, onClick, ariaLabel }: { children: ReactNode; onClick: () => void; ariaLabel?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      style={{ background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", textAlign: "left", width: "100%", display: "block" }}
    >
      {children}
    </button>
  );
}
