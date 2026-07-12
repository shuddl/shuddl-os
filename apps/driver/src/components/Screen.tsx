import type { ReactNode } from "react";

// The driver surface (doc 07 §03): an `--ink-dark` full-bleed ground for docks-at-5am and sunlight
// glare, with a centered phone-width column so the one-question-one-button flow reads the same on a
// handset and on the live-render harness. Content is laid out top / middle / bottom by the caller.
export function Screen({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--ink-dark)", display: "flex", justifyContent: "center" }}>
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 28,
          boxSizing: "border-box",
        }}
      >
        {children}
      </div>
    </div>
  );
}
