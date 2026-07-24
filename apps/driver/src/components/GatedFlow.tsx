import { useEffect, useMemo, useRef, useState } from "react";
import { Display, Mono } from "@shuddl/design";
import type { Stop } from "../data/stops.js";
import { capturesForStep, type GeoFix } from "../flow/captures.js";
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
// Task 11 Step 5 (REQ-071/166) — the FOREGROUND geolocation reader that REPLACES the hardcoded MOCK_GEO.
// It runs `watchPosition` ONLY while the app is visible/foreground and the geolocation API is permitted;
// it tears the watch down on hide and unmount, and it makes NO claim of background continuity (a native
// client / ELD is required for that — design WP4). It surfaces EXPLICIT states — acquiring / ready / stale
// / denied / unsupported — so the UI never fakes a fix: a GPS step is blocked behind a permission/stale
// screen until a fresh, permitted fix exists.
type GeoStatus = "unsupported" | "acquiring" | "ready" | "stale" | "denied";
interface GeoReading {
  status: GeoStatus;
  fix?: GeoFix;
  ts?: number;
}
const GEO_STALE_MS = 30_000; // a fix older than this is no longer trustworthy for a gate stamp

function useForegroundGeo(active: boolean, nonce: number): GeoReading {
  const [reading, setReading] = useState<GeoReading>({ status: "unsupported" });
  useEffect(() => {
    const geoloc = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
    if (!active || !geoloc) {
      setReading({ status: "unsupported" }); // no GPS step showing, or no geolocation API — inert
      return;
    }
    let watchId: number | null = null;
    const onFix = (pos: GeolocationPosition): void =>
      setReading({
        status: "ready",
        fix: {
          lat_e6: Math.round(pos.coords.latitude * 1e6),
          lon_e6: Math.round(pos.coords.longitude * 1e6),
          accuracy_m: Math.round(pos.coords.accuracy),
        },
        ts: Date.now(),
      });
    const onErr = (err: GeolocationPositionError): void =>
      setReading((r) => (err.code === err.PERMISSION_DENIED ? { status: "denied" } : r.status === "ready" ? r : { status: "acquiring" }));
    const start = (): void => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return; // FOREGROUND only
      setReading((r) => (r.status === "ready" ? r : { status: "acquiring" }));
      watchId = geoloc.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
    };
    const stopWatch = (): void => {
      if (watchId !== null) {
        geoloc.clearWatch(watchId);
        watchId = null; // hidden/unmounted → the watch STOPS (no background continuity is promised)
      }
    };
    const onVis = (): void => {
      if (document.visibilityState === "visible") start();
      else stopWatch();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    start();
    // Staleness sweep: a ready fix that ages past GEO_STALE_MS flips to `stale` so the gate re-blocks.
    const tick = setInterval(
      () => setReading((r) => (r.status === "ready" && r.ts !== undefined && Date.now() - r.ts > GEO_STALE_MS ? { ...r, status: "stale" } : r)),
      5_000,
    );
    return () => {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
      stopWatch();
      clearInterval(tick);
    };
  }, [active, nonce]);
  return reading;
}

// The step ids that stamp GPS (each builds a GeoStamp-bearing capture). Only these are gated on a fix.
const GPS_STEPS = new Set<StepId>(["arrive", "sign", "depart", "delivered"]);

// The explicit permission/stale screen shown when a GPS step is reached without a fresh permitted fix. It
// BLOCKS the capture (never a fabricated stamp) and offers a retry that re-arms the watch.
function GeoGate({
  status,
  header,
  progress: prog,
  onRetry,
}: {
  status: Exclude<GeoStatus, "unsupported" | "ready">;
  header: string;
  progress: number;
  onRetry: () => void;
}): React.JSX.Element {
  const copy: Record<typeof status, { title: string; caption: string }> = {
    acquiring: { title: "Getting your location", caption: "ACQUIRING GPS — HOLD STILL A MOMENT" },
    stale: { title: "Location is stale", caption: "WAITING FOR A FRESH GPS FIX" },
    denied: { title: "Location is off", caption: "ENABLE LOCATION FOR THIS APP TO CONTINUE THE STOP" },
  };
  const { title, caption } = copy[status];
  return (
    <Screen>
      <ProgressLine label={header} progress={prog} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, textAlign: "center", padding: "0 8px" }}>
        <Mono size={12} color="var(--signal)">
          GPS REQUIRED · NOT CAPTURED
        </Mono>
        <Display size="sub" color="var(--field-on-dark)">
          {title}
        </Display>
        <Mono size={11} color="var(--signal-55)">
          {caption}
        </Mono>
      </div>
      <TapButton onClick={onRetry}>Retry location</TapButton>
    </Screen>
  );
}

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
  const [geoNonce, setGeoNonce] = useState(0); // bumped to re-arm the geolocation watch on a retry
  const placedHash = useRef<string | undefined>(undefined);
  // Evidence tokens whose events were ACTUALLY captured+enqueued this session (not synthesized by a
  // deep-link's stateAtStep). The terminal emit is gated on this — the client mirror of the server gate.
  const realCaptured = useRef<Set<RequiredEvidence>>(new Set());

  const step = currentStep(flow, state);
  const header = `STOP ${stop.seq} · ${stop.kind.toUpperCase()} · ${state.stepIndex + 1}/${flow.steps.length}`;
  const prog = progress(flow, state);

  // Foreground GPS — active only while a GPS step is showing. A fresh permitted fix (`ready`) is required
  // before a GPS-bearing capture; otherwise the GeoGate below blocks it (never a fabricated stamp).
  const geoNeeded = GPS_STEPS.has(step.id);
  const geo = useForegroundGeo(geoNeeded, geoNonce);

  // Run (and enqueue) the signed event(s) a step emits, AWAITING each. Returns true on success; on
  // failure it surfaces the error (so the caller BLOCKS advance) instead of swallowing it. Threads the
  // placed-photo hash forward and records the step's evidence as really-captured-this-session.
  async function runCaptures(stepId: StepId, requires: readonly RequiredEvidence[], bytes?: Uint8Array): Promise<boolean> {
    const ctx = {
      shipmentId: stop.id,
      ts: Date.now(),
      // A real device fix is threaded ONLY when fresh + permitted; a GPS step never reaches here otherwise
      // (the GeoGate blocks it), so a GPS capture is never built over a fabricated coordinate.
      ...(geo.status === "ready" && geo.fix ? { geo: geo.fix } : {}),
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

  // A GPS step without a fresh permitted fix shows the explicit permission/stale gate — the capture is
  // BLOCKED here rather than stamped with a fabricated coordinate. (`unsupported` — no geolocation API,
  // e.g. the test harness — falls through; a real device always has one and is gated honestly.)
  if (geoNeeded && geo.status !== "ready" && geo.status !== "unsupported") {
    return <GeoGate status={geo.status} header={header} progress={prog} onRetry={() => setGeoNonce((n) => n + 1)} />;
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
