import { useState } from "react";
import { Button, Display, Mono } from "@shuddl/design";

// DRIVER PWA — Amendment A2: dark ground (`--ink-dark`) with `--field` type, for docks at 5am and
// sunlight glare. A gate is a FULL-SCREEN QUESTION: one Display instruction, one primary Button, one
// Mono caption. The stop's progress is the ONE sanctioned teal moment (REQ-078) — a `--progress` fill
// line, never text or state. No map here: the camera/gate screens are pure, dark, and unmissable.

const STOP_STEPS = ["ARRIVE", "PHOTO", "SIGNATURE", "DEPART"] as const;
const CURRENT_STEP = 1; // on PHOTO (0-indexed) ⇒ 2 of 4 done at completion

export function App(): React.JSX.Element {
  const [done, setDone] = useState(CURRENT_STEP);
  const progress = Math.min(1, (done + 1) / STOP_STEPS.length);

  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--ink-dark)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 28,
      }}
    >
      {/* Stop progress — teal fill line (the one teal moment). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Mono size={11} color="var(--signal-55)">
          STOP 2 OF 4 · {STOP_STEPS[Math.min(done, STOP_STEPS.length - 1)]}
        </Mono>
        <div style={{ height: 4, background: "var(--signal-12)", width: "100%" }}>
          <div style={{ height: 4, background: "var(--progress)", width: `${Math.round(progress * 100)}%` }} />
        </div>
      </div>

      {/* The gate — one instruction, huge, light on dark. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 640 }}>
        <Mono size={12} color="var(--signal-55)">
          GATE · REQUIRED
        </Mono>
        <Display size="hero" color="var(--field-on-dark)">
          Photograph the freight where it sits
        </Display>
        <Mono size={12} color="var(--field-on-dark)">
          FRAME ALL PIECES · CAPTURE THE BOL NUMBER
        </Mono>
      </div>

      {/* One primary action. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Button onClick={() => setDone((d) => Math.min(STOP_STEPS.length - 1, d + 1))}>Open Camera</Button>
        <Mono size={11} color="var(--signal-55)">
          OFFLINE — CAPTURING LOCALLY
        </Mono>
      </div>
    </main>
  );
}
