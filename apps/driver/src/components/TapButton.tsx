import type { ReactNode } from "react";

// The ONE primary action per screen, sized for a gloved thumb at a dock. The design-system Button is
// ink-on-ink here (it disappears on the driver's dark ground), so the driver surface uses an inverted,
// full-width bar: `--field` fill + `--ink-dark` text when live, dimmed to `--signal-12`/`--signal-55`
// when the step's evidence is missing — so a disabled gate reads as unmistakably not-yet-tappable.
//
// REQ-067 (dark ground A2 + ≥44px hit targets — BUILT): the driver ground is ink-dark (the A2 default) and
// this is the full-width primary target — 22px vertical padding puts the tap height well over the 44px
// minimum for a gloved thumb. OUTDOOR READABILITY under direct sun (the other half of REQ-067's DoD) is a
// [CONFIRM]/pilot field check on real hardware — the token contrast is set here; the sunlight result is not
// claimed from CI.
export function TapButton({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      style={{
        fontFamily: "var(--mono)",
        fontWeight: 400,
        textTransform: "uppercase",
        fontSize: 15,
        letterSpacing: "0.08em",
        background: disabled ? "var(--signal-12)" : "var(--field)",
        color: disabled ? "var(--signal-55)" : "var(--ink-dark)",
        border: "none",
        borderRadius: 4,
        padding: "22px 24px",
        width: "100%",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
