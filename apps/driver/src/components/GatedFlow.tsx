import { useMemo, useRef, useState } from "react";
import { Display, Mono } from "@shuddl/design";
import type { Stop } from "../data/stops.js";
import { capturesForStep } from "../flow/captures.js";
import {
  addEvidence,
  advance,
  buildFlow,
  currentStep,
  initialState,
  progress,
  serverRequiredEvidence,
  stateAtStep,
  type FlowOptions,
  type FlowState,
  type StepId,
} from "../flow/stop-flow.js";
import type { RequiredEvidence } from "@shuddl/ledger/gates/transition-gates";
import { captureAndEnqueue } from "../session.js";
import { CameraScreen } from "./CameraScreen.js";
import { ProgressLine } from "./ProgressLine.js";
import { Screen } from "./Screen.js";
import { SignatureScreen } from "./SignatureScreen.js";
import { StopScreen } from "./StopScreen.js";
import { TapButton } from "./TapButton.js";

// REQ-062/063/064 — drives one stop through its gated flow. The pure state machine decides the step
// order and gates advance on evidence; this component maps the current step to a screen and wires the
// real capture leg (`capture` → hash-at-capture → OfflineQueue) for each completed step.
//
// EVIDENCE INTEGRITY (WP-05 exit audit, REQ-119):
//   - A capture failure is SURFACED (a visible error) and BLOCKS advance — never a silent skip that
//     drops evidence (a `void`-emit fire-and-forget would let a failed placed-photo no-op away).
//   - The terminal transition (`stop.departed` / `delivery.evidenced`) is gated on the evidence that was
//     ACTUALLY emitted THIS SESSION (`realCaptured`), NOT on the tokens `stateAtStep` synthesizes for a
//     `?screen=` deep-link render. A deep-linked terminal therefore cannot enqueue a gate-invalid event
//     the server would 403.
//   - The terminal `complete()` AWAITS its POD enqueue before `onExit()` — a fast navigate-away can no
//     longer drop the `delivery.evidenced`. A delivery with no real placed photo BLOCKS (mirrors the gate).
export function GatedFlow({
  stop,
  startStep,
  onExit,
}: {
  stop: Stop;
  startStep?: StepId;
  onExit: () => void;
}): React.JSX.Element {
  const opts: FlowOptions = useMemo(() => (stop.dimsRequired === true ? { dimsRequired: true } : {}), [stop]);
  const flow = useMemo(() => buildFlow(stop.kind, opts), [stop.kind, opts]);
  const [state, setState] = useState<FlowState>(() => (startStep ? stateAtStep(flow, startStep) : initialState(flow)));
  const [captureError, setCaptureError] = useState<string | null>(null);
  const placedHash = useRef<string | undefined>(undefined);
  // Evidence tokens whose events were ACTUALLY captured+enqueued this session (not synthesized by a
  // deep-link's stateAtStep). The terminal emit is gated on this — the client mirror of the server gate.
  const realCaptured = useRef<Set<RequiredEvidence>>(new Set());

  const step = currentStep(flow, state);
  const header = `STOP ${stop.seq} · ${stop.kind.toUpperCase()} · ${state.stepIndex + 1}/${flow.steps.length}`;
  const prog = progress(flow, state);

  // Run (and enqueue) the signed event(s) a step emits, AWAITING each. Returns true on success; on
  // failure it surfaces the error (so the caller BLOCKS advance) instead of swallowing it. Threads the
  // placed-photo hash forward and records the step's evidence as really-captured-this-session.
  async function runCaptures(stepId: StepId, requires: readonly RequiredEvidence[], bytes?: Uint8Array): Promise<boolean> {
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
      for (const t of requires) realCaptured.current.add(t);
      return true;
    } catch {
      // Do NOT swallow — a failed capture means the event never queued. Surface it and block advance so
      // evidence is never silently dropped (the airplane-mode soak proves the happy leg, Task 7).
      setCaptureError("CAPTURE DIDN'T SAVE — NOTHING WAS RECORDED. TRY AGAIN.");
      return false;
    }
  }

  // A non-terminal step: capture its evidence, then advance ONLY if the capture actually saved.
  async function runStep(stepId: StepId, requires: readonly RequiredEvidence[], bytes?: Uint8Array): Promise<void> {
    const ok = await runCaptures(stepId, requires, bytes);
    if (!ok) return; // error surfaced — do not advance past unrecorded evidence
    setState((s) => advance(flow, addEvidence(s, requires)));
  }

  // The terminal gated transition. Only emit when the REAL upstream captures happened THIS SESSION (a
  // deep-linked terminal has none → BLOCKED, so it can't enqueue a gate-invalid event). AWAIT the POD
  // enqueue before exiting. A delivery with no real placed photo cannot complete (mirrors the gate).
  async function completeTerminal(stepId: StepId): Promise<void> {
    const required = serverRequiredEvidence(flow.kind, opts);
    const haveReal = required.every((t) => realCaptured.current.has(t));
    if (!haveReal || (flow.kind === "delivery" && !placedHash.current)) {
      setCaptureError("UPSTREAM EVIDENCE MISSING — COMPLETE THIS STOP FROM THE DAY SHEET.");
      return; // BLOCK: never enqueue a transition the server would 403
    }
    const ok = await runCaptures(stepId, []);
    if (!ok) return; // POD enqueue failed — surfaced, do not exit (the delivery.evidenced is not lost)
    onExit();
  }

  // A non-photo/non-signature step. One tap captures the evidence and advances — or, at the terminal
  // transition, awaits the POD enqueue and returns to the day sheet.
  function complete(): void {
    if (step.terminal) {
      void completeTerminal(step.id);
      return;
    }
    void runStep(step.id, step.requires);
  }

  // Forced photo AND signature: the single ADVANCE/commit captures the (retake-final) evidence and
  // advances — but only if the capture saved (a failed placed-photo capture BLOCKS, never a silent skip).
  function onCommit(bytes: Uint8Array): void {
    void runStep(step.id, step.requires, bytes);
  }

  if (captureError) {
    return (
      <Screen>
        <ProgressLine label={header} progress={prog} />
        <div style={{ display: "flex", flexDirection: "column", gap: 16, textAlign: "center", padding: "0 8px" }}>
          <Mono size={12} color="var(--signal)">
            CAPTURE FAILED · NOT QUEUED
          </Mono>
          <Display size="sub" color="var(--field-on-dark)">
            {captureError}
          </Display>
          <Mono size={11} color="var(--signal-55)">
            NOTHING WAS RECORDED — THE STEP IS UNCHANGED
          </Mono>
        </div>
        <TapButton onClick={() => setCaptureError(null)}>Try again</TapButton>
      </Screen>
    );
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
