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
}: {
  header: string;
  progress: number;
  step: FlowStep;
  onComplete: () => void;
}): React.JSX.Element {
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
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <TapButton onClick={onComplete}>{step.action}</TapButton>
        <Mono size={11} color="var(--signal-55)">
          OFFLINE — CAPTURING LOCALLY
        </Mono>
      </div>
    </Screen>
  );
}
