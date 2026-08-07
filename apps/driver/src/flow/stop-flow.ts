// REQ-062 / REQ-063 — the driver PWA's per-stop gated flow machine. PURE (no DOM, no capture, no
// network): a step list + an `advance` fold that MIRRORS the server Gatekeeper (packages/ledger Task 3)
// so the driver captures evidence in gate-valid order. By the time the flow reaches its terminal step
// (the gated transition — `stop.departed` for a pickup, `delivery.evidenced` for a delivery), the
// accumulated evidence is a SUPERSET of what the server gate for that transition requires — so the
// signed events drain to a sequencer that never blocks them. The client is a strict MIRROR, never the
// authority (REQ-030): the server re-checks. Reusing `REQUIRED_EVIDENCE` makes a client/server token
// drift a COMPILE error, not a silent mismatch between the checklist and the gate.
import { REQUIRED_EVIDENCE, type RequiredEvidence } from "@shuddl/ledger/gates/transition-gates";

export type StopKind = "pickup" | "delivery";

export type StepId =
  | "arrive"
  | "count"
  | "photo_freight"
  | "dims"
  | "sign"
  | "depart" // pickup terminal — the gated `stop.departed`
  | "photo_placed"
  | "delivered"; // delivery terminal — the gated `delivery.evidenced`

export interface FlowStep {
  readonly id: StepId;
  /**
   * The `REQUIRED_EVIDENCE` tokens that must ALL be captured to advance PAST this step. Empty on a
   * terminal step (reaching it means every upstream gate was cleared). Mirrors the server gate's
   * `required_evidence` vocabulary exactly.
   */
  readonly requires: readonly RequiredEvidence[];
  /** A forced-photo step (REQ-063): its evidence is a photo hash and the step is UNTYPASSABLE. */
  readonly forcedPhoto: boolean;
  /** The gated transition itself — the last step of the flow. */
  readonly terminal: boolean;
  /** ONE Display question. */
  readonly question: string;
  /** ONE primary Button label. */
  readonly action: string;
  /** ONE Mono caption. */
  readonly caption: string;
}

export interface FlowOptions {
  /** Whether this lane/tenant requires a dims.captured before pickup departure (mirrors GateCtx.dimsRequired). */
  dimsRequired?: boolean;
}

export interface StopFlow {
  readonly kind: StopKind;
  readonly steps: readonly FlowStep[];
}

export interface FlowState {
  readonly kind: StopKind;
  /** Index into `StopFlow.steps` of the step the driver is on. */
  readonly stepIndex: number;
  /** Every evidence token captured so far this stop (append-only within a stop). */
  readonly captured: readonly RequiredEvidence[];
}

const R = REQUIRED_EVIDENCE;

// PICKUP — arrive → count → photo(freight) → dims? → sign(custody) → depart.
// The pickup-departure gate (assertPickupDepart) requires freight.counted, freight.photographed
// (photo_kind=freight), custody.transferred, and — only when the lane is dims-fitted — dims.captured.
function pickupSteps(dimsRequired: boolean): FlowStep[] {
  const steps: FlowStep[] = [
    {
      id: "arrive",
      requires: [R.geofence],
      forcedPhoto: false,
      terminal: false,
      question: "Confirm you're at the pickup",
      action: "I'm on site",
      caption: "GPS CONFIRMS YOU'RE INSIDE THE YARD",
    },
    {
      id: "count",
      requires: [R.freight_counted],
      forcedPhoto: false,
      terminal: false,
      question: "How many pieces?",
      action: "Confirm count",
      caption: "COUNT EVERY PIECE ON THE BOL",
    },
    {
      id: "photo_freight",
      requires: [R.freight_photo],
      forcedPhoto: true,
      terminal: false,
      question: "Photograph the freight where it sits",
      action: "Advance",
      caption: "FRAME ALL PIECES · CAPTURE THE BOL NUMBER",
    },
  ];
  if (dimsRequired) {
    steps.push({
      id: "dims",
      requires: [R.dims_captured],
      forcedPhoto: false,
      terminal: false,
      question: "Measure the freight",
      action: "Confirm dimensions",
      caption: "LENGTH · WIDTH · HEIGHT IN INCHES",
    });
  }
  steps.push(
    {
      id: "sign",
      requires: [R.custody_transferred],
      forcedPhoto: false,
      terminal: false,
      question: "Get the shipper's signature",
      action: "Advance",
      caption: "SHIPPER SIGNS TO HAND OFF CUSTODY",
    },
    {
      id: "depart",
      requires: [],
      forcedPhoto: false,
      terminal: true,
      question: "You're loaded — depart",
      action: "Depart",
      caption: "STAMPS DEPARTURE · YOU'RE OUT FOR DELIVERY",
    },
  );
  return steps;
}

// DELIVERY — arrive(consent + in-geofence) → photo(placed) → sign(pod) → delivered.
// The delivery gate (assertDelivery) requires a stop.arrived cleanly inside the fence (geofence), a
// pod.signed, and the forced placed-freight photo. Consent-before-first-GPS (assertConsentBeforeGps)
// requires a consent ack on the stream before the arrival stamp — so arrive needs BOTH consent + geofence.
function deliverySteps(): FlowStep[] {
  return [
    {
      id: "arrive",
      requires: [R.consent, R.geofence],
      forcedPhoto: false,
      terminal: false,
      question: "Confirm the delivery arrival",
      action: "I'm at the door",
      caption: "CONSENT ON FILE · GPS INSIDE THE FENCE",
    },
    {
      id: "photo_placed",
      requires: [R.placed_freight_photo],
      forcedPhoto: true,
      terminal: false,
      question: "Photograph the freight placed",
      action: "Advance",
      caption: "SHOW WHERE YOU LEFT IT · UNTYPASSABLE",
    },
    {
      id: "sign",
      requires: [R.pod_signed],
      forcedPhoto: false,
      terminal: false,
      question: "Capture the receiver's signature",
      action: "Advance",
      caption: "SIGN ON GLASS · HASHED AS PROOF OF DELIVERY",
    },
    {
      id: "delivered",
      requires: [],
      forcedPhoto: false,
      terminal: true,
      question: "Delivered",
      action: "Complete delivery",
      caption: "STAMPS DELIVERY · INVOICE FIRES ON SYNC",
    },
  ];
}

// REQ-053 (round-trip + stop-off flows — DEFERRED / follow-up): buildFlow models the SINGLE-STOP cycle (one
// pickup OR one delivery). The multi-leg variations — a round-trip (return leg) and a stop-off (an extra
// intermediate stop) — are a follow-up flow variation layered on this same gated base; they are NOT built in
// WP-05. The per-stop gate catalog here is the reusable primitive each leg of those flows will compose.
/** Build the ordered step list for a stop. `dimsRequired` inserts the dims step (pickup only). */
export function buildFlow(kind: StopKind, opts: FlowOptions = {}): StopFlow {
  const steps = kind === "pickup" ? pickupSteps(opts.dimsRequired === true) : deliverySteps();
  return { kind, steps };
}

/** The starting state — on the first step, nothing captured. */
export function initialState(flow: StopFlow): FlowState {
  return { kind: flow.kind, stepIndex: 0, captured: [] };
}

/**
 * A state positioned ON `stepId`, with every upstream step's required evidence pre-captured — used to
 * render any flow screen deterministically from a `?screen=` URL param. Falls through to the terminal
 * step if the id isn't in this flow (e.g. a pickup-only step id requested on a delivery flow).
 *
 * RENDER-ONLY: the `captured` tokens here are SYNTHESIZED to position the screen — the upstream events
 * were NOT emitted. A caller must NEVER treat these tokens as proof that a transition may fire (a
 * deep-linked terminal would otherwise enqueue a `stop.departed`/`delivery.evidenced` the server 403s).
 * GatedFlow gates the terminal emit on events ACTUALLY captured this session, never on these (REQ-119).
 */
export function stateAtStep(flow: StopFlow, stepId: StepId): FlowState {
  let state = initialState(flow);
  for (const step of flow.steps) {
    if (step.id === stepId) break;
    state = advance(flow, state, step.requires);
  }
  return state;
}

/** The step the driver is currently on. Never undefined for an in-range state. */
export function currentStep(flow: StopFlow, state: FlowState): FlowStep {
  const step = flow.steps[state.stepIndex];
  if (!step) throw new RangeError(`stop-flow: stepIndex ${state.stepIndex} out of range`);
  return step;
}

/** Union of the two token lists, order-preserving, no duplicates. */
function mergeEvidence(a: readonly RequiredEvidence[], b: readonly RequiredEvidence[]): RequiredEvidence[] {
  const out = [...a];
  for (const t of b) if (!out.includes(t)) out.push(t);
  return out;
}

/** Record captured evidence WITHOUT moving the step pointer (SHUTTER / sign / count buttons). */
export function addEvidence(state: FlowState, tokens: readonly RequiredEvidence[]): FlowState {
  return { ...state, captured: mergeEvidence(state.captured, tokens) };
}

/**
 * THE step-gate predicate, declared once (audit §498).
 *
 * `canAdvance` (what the tests ask) and `advance` (what the UI actually runs) each computed
 * `step.requires.every(...)` from their own copy. They agreed, and nothing compared them: `GatedFlow.tsx`
 * imports `advance` and NOT `canAdvance`, so a change to either copy would leave the tests asserting one
 * rule while the driver's screen obeyed the other — and both would stay green. Two hand-maintained copies
 * of one rule is the §493 shape, here in the flow behind acceptance demo 3 ("a real driver completes a
 * gated stop with zero instruction").
 *
 * This is the CLIENT mirror only. The server gate is the authority (CLAUDE.md rule 3 — UIs merely reflect
 * them); this exists so the driver is never offered a button whose event the server would refuse.
 */
function evidenceSatisfied(step: FlowStep, captured: readonly RequiredEvidence[]): boolean {
  return step.requires.every((r) => captured.includes(r));
}

/**
 * True when the current step's required evidence is all captured — i.e. the ADVANCE button may fire.
 * A forced-photo step is false until its photo token is present, which is what makes it UNTYPASSABLE.
 */
export function canAdvance(flow: StopFlow, state: FlowState): boolean {
  return evidenceSatisfied(currentStep(flow, state), state.captured);
}

/** Whether the flow has reached (and is sitting on) its terminal gated transition. */
export function isComplete(flow: StopFlow, state: FlowState): boolean {
  return currentStep(flow, state).terminal;
}

/**
 * Fold `captured` into the state and advance to the next step IFF the current step's required
 * evidence is now all present. A step whose evidence is missing is a NO-OP (returns the same step) —
 * this is the client mirror of a server gate block, and for a forced-photo step it is the
 * untypassable-photo rule (REQ-063). A terminal step never advances further.
 */
export function advance(flow: StopFlow, state: FlowState, captured: readonly RequiredEvidence[] = []): FlowState {
  const merged = mergeEvidence(state.captured, captured);
  const step = flow.steps[state.stepIndex];
  if (!step) return { ...state, captured: merged };
  const satisfied = evidenceSatisfied(step, merged);
  const atEnd = state.stepIndex >= flow.steps.length - 1;
  const nextIndex = satisfied && !atEnd ? state.stepIndex + 1 : state.stepIndex;
  return { kind: state.kind, stepIndex: nextIndex, captured: merged };
}

/** Teal progress fill (REQ-078), 0 on the first step, 1 on the terminal step. */
export function progress(flow: StopFlow, state: FlowState): number {
  const span = flow.steps.length - 1;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, state.stepIndex / span));
}

/**
 * The evidence the SERVER gate for this stop's terminal transition requires — the set the flow must
 * have accumulated by the time it reaches the terminal step. Exposed so a test can prove the client
 * flow is a true superset-mirror of the server Gatekeeper (assertPickupDepart / assertDelivery).
 */
export function serverRequiredEvidence(kind: StopKind, opts: FlowOptions = {}): RequiredEvidence[] {
  if (kind === "pickup") {
    const req: RequiredEvidence[] = [R.freight_counted, R.freight_photo, R.custody_transferred];
    if (opts.dimsRequired === true) req.push(R.dims_captured);
    return req;
  }
  return [R.geofence, R.pod_signed, R.placed_freight_photo];
}
