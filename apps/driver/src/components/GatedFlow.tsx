import { useMemo, useRef, useState } from "react";
import type { Stop } from "../data/stops.js";
import { capturesForStep } from "../flow/captures.js";
import {
  addEvidence,
  advance,
  buildFlow,
  currentStep,
  initialState,
  progress,
  stateAtStep,
  type FlowState,
  type StepId,
} from "../flow/stop-flow.js";
import { captureAndEnqueue } from "../session.js";
import { CameraScreen } from "./CameraScreen.js";
import { SignatureScreen } from "./SignatureScreen.js";
import { StopScreen } from "./StopScreen.js";

// REQ-062/063/064 — drives one stop through its gated flow. The pure state machine decides the step
// order and gates advance on evidence; this component maps the current step to a screen and wires the
// real capture leg (`capture` → hash-at-capture → OfflineQueue) for each completed step. Captures are
// best-effort offline (a failure is logged, never a crash) — the merge/soak proofs live in Task 6/7.
export function GatedFlow({
  stop,
  startStep,
  onExit,
}: {
  stop: Stop;
  startStep?: StepId;
  onExit: () => void;
}): React.JSX.Element {
  const flow = useMemo(() => buildFlow(stop.kind, stop.dimsRequired === true ? { dimsRequired: true } : {}), [stop]);
  const [state, setState] = useState<FlowState>(() => (startStep ? stateAtStep(flow, startStep) : initialState(flow)));
  const placedHash = useRef<string | undefined>(undefined);

  const step = currentStep(flow, state);
  const header = `STOP ${stop.seq} · ${stop.kind.toUpperCase()} · ${state.stepIndex + 1}/${flow.steps.length}`;
  const prog = progress(flow, state);

  // Capture (and enqueue) the signed event(s) a step emits. Threads the placed-photo hash forward so
  // the terminal delivery.evidenced can reference it.
  async function emit(stepId: StepId, bytes?: Uint8Array): Promise<void> {
    const ctx = {
      shipmentId: stop.id,
      ts: Date.now(),
      ...(bytes ? { bytes } : {}),
      ...(placedHash.current ? { placedPhotoHash: placedHash.current } : {}),
    };
    try {
      for (const params of capturesForStep(flow.kind, stepId, ctx)) {
        const { hash } = await captureAndEnqueue(params);
        if (stepId === "photo_placed" && hash) placedHash.current = hash;
      }
    } catch {
      /* offline capture is best-effort in the WP-05 shell; the airplane-mode soak proves the leg (Task 7) */
    }
  }

  // A non-photo/non-signature step: one tap captures the evidence and advances (or, at the terminal
  // transition, emits and returns to the day sheet).
  function complete(): void {
    const id = step.id;
    void emit(id);
    if (step.terminal) {
      onExit();
      return;
    }
    setState((s) => advance(flow, addEvidence(s, step.requires)));
  }

  // Forced photo AND signature: the single ADVANCE/commit captures the (retake-final) evidence and
  // moves on — one event per artifact, no redundant enqueue on retake.
  function onCommit(bytes: Uint8Array): void {
    const id = step.id;
    void emit(id, bytes);
    setState((s) => advance(flow, addEvidence(s, step.requires)));
  }

  if (step.forcedPhoto) {
    return (
      <CameraScreen
        key={step.id}
        header={header}
        progress={prog}
        question={step.question}
        caption={step.caption}
        onCommit={onCommit}
      />
    );
  }

  if (step.id === "sign") {
    return (
      <SignatureScreen
        key={step.id}
        header={header}
        progress={prog}
        question={step.question}
        caption={step.caption}
        onCommit={onCommit}
      />
    );
  }

  return <StopScreen key={step.id} header={header} progress={prog} step={step} onComplete={complete} />;
}
