import { Display, Mono } from "@shuddl/design";
import type { FlowStep } from "../flow/stop-flow.js";
import { ProgressLine } from "./ProgressLine.js";
import { Screen } from "./Screen.js";
import { TapButton } from "./TapButton.js";

// REQ-062 — a single gate: ONE Display question, ONE primary Button, ONE Mono caption, over the teal
// progress line. Used for the non-photo/non-signature steps (arrive, count, dims, and the terminal
// depart/delivered transition). Tapping the button captures the step's evidence and advances.
export function StopScreen({
  header,
  progress,
  step,
  onComplete,
  count,
}: {
  header: string;
  progress: number;
  step: FlowStep;
  onComplete: () => void;
  /** The count step's REAL answer (2026-08-01: a hardcoded 6 used to be recorded on every pickup).
   *  When present, a numeric field is the gate's answer and the button stays disabled until it is a
   *  positive integer — the recorded fact is what the driver actually counted, never a constant. */
  count?: { value: number | undefined; onChange: (n: number | undefined) => void };
}): React.JSX.Element {
  const countMissing = count !== undefined && (count.value === undefined || !Number.isInteger(count.value) || count.value <= 0);
  return (
    <Screen>
      <ProgressLine label={header} progress={progress} />

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <Mono size={12} color="var(--signal-55)">
          {step.terminal ? "TRANSITION · GATED" : "GATE · REQUIRED"}
        </Mono>
        <Display size="hero" color="var(--field-on-dark)">
          {step.question}
        </Display>
        <Mono size={12} color="var(--field-on-dark)">
          {step.caption}
        </Mono>
        {count !== undefined ? (
          <input
            aria-label="PIECE COUNT"
            inputMode="numeric"
            pattern="[0-9]*"
            autoFocus
            value={count.value ?? ""}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              count.onChange(Number.isInteger(n) && n > 0 ? n : undefined);
            }}
            style={{
              background: "transparent",
              border: "1px solid var(--signal-55)",
              borderRadius: 4,
              color: "var(--field-on-dark)",
              fontFamily: "inherit",
              fontSize: 32,
              padding: "12px 16px",
              width: "8ch",
            }}
          />
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <TapButton onClick={onComplete} disabled={countMissing}>{step.action}</TapButton>
        <Mono size={11} color="var(--signal-55)">
          OFFLINE — CAPTURING LOCALLY
        </Mono>
      </div>
    </Screen>
  );
}
