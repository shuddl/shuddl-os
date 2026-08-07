import { describe, expect, it } from "vitest";
import { REQUIRED_EVIDENCE as R, type RequiredEvidence } from "@shuddl/ledger/gates/transition-gates";
import {
  advance,
  buildFlow,
  canAdvance,
  currentStep,
  initialState,
  isComplete,
  progress,
  serverRequiredEvidence,
} from "./stop-flow.js";

describe("stop-flow — the gated per-stop machine (REQ-062/063)", () => {
  it("pickup advances ONLY when each step's required evidence is present", () => {
    const flow = buildFlow("pickup", { dimsRequired: true });
    let s = initialState(flow);
    const order = ["arrive", "count", "photo_freight", "dims", "sign", "depart"];
    expect(flow.steps.map((x) => x.id)).toEqual(order);

    // arrive → count needs geofence; an empty advance is a no-op.
    expect(currentStep(flow, s).id).toBe("arrive");
    s = advance(flow, s, []);
    expect(currentStep(flow, s).id).toBe("arrive"); // blocked — no geofence
    s = advance(flow, s, [R.geofence]);
    expect(currentStep(flow, s).id).toBe("count");

    // count → photo_freight needs the count.
    s = advance(flow, s, []);
    expect(currentStep(flow, s).id).toBe("count");
    s = advance(flow, s, [R.freight_counted]);
    expect(currentStep(flow, s).id).toBe("photo_freight");

    // photo_freight → dims needs the forced freight photo.
    s = advance(flow, s, [R.freight_photo]);
    expect(currentStep(flow, s).id).toBe("dims");

    // dims → sign needs the dims.
    s = advance(flow, s, [R.dims_captured]);
    expect(currentStep(flow, s).id).toBe("sign");

    // sign → depart needs custody.
    s = advance(flow, s, []);
    expect(currentStep(flow, s).id).toBe("sign");
    s = advance(flow, s, [R.custody_transferred]);
    expect(currentStep(flow, s).id).toBe("depart");
    expect(isComplete(flow, s)).toBe(true);
  });

  it("omits the dims step when the lane is not dims-fitted", () => {
    const flow = buildFlow("pickup"); // dimsRequired defaults false
    expect(flow.steps.map((x) => x.id)).toEqual(["arrive", "count", "photo_freight", "sign", "depart"]);
  });

  it("a forced-photo step CANNOT be skipped — advance blocks until a photo is captured (REQ-063)", () => {
    const flow = buildFlow("delivery");
    let s = initialState(flow);
    // Clear arrive with consent + geofence.
    s = advance(flow, s, [R.consent, R.geofence]);
    const photo = currentStep(flow, s);
    expect(photo.id).toBe("photo_placed");
    expect(photo.forcedPhoto).toBe(true);

    // No photo → the button is dead and advance is a no-op, no matter how many times it's tapped.
    expect(canAdvance(flow, s)).toBe(false);
    s = advance(flow, s, []);
    s = advance(flow, s, []);
    expect(currentStep(flow, s).id).toBe("photo_placed");

    // The placed-photo token is the ONLY thing that opens the gate.
    s = advance(flow, s, [R.placed_freight_photo]);
    expect(currentStep(flow, s).id).toBe("sign");
    expect(canAdvance(flow, s)).toBe(false); // pod not yet signed
  });

  it("delivery arrive needs BOTH consent and geofence — one alone does not open it", () => {
    const flow = buildFlow("delivery");
    let s = initialState(flow);
    s = advance(flow, s, [R.geofence]);
    expect(currentStep(flow, s).id).toBe("arrive"); // consent missing
    s = advance(flow, s, [R.consent]);
    expect(currentStep(flow, s).id).toBe("photo_placed");
  });

  it("the terminal state is the gated transition (depart / delivered) and never advances past it", () => {
    const pickup = buildFlow("pickup");
    let p = initialState(pickup);
    for (const t of [R.geofence, R.freight_counted, R.freight_photo, R.custody_transferred]) {
      p = advance(pickup, p, [t]);
    }
    expect(currentStep(pickup, p).id).toBe("depart");
    expect(currentStep(pickup, p).terminal).toBe(true);
    const stuck = advance(pickup, p, [R.geofence]);
    expect(stuck.stepIndex).toBe(p.stepIndex); // terminal — no move
    expect(progress(pickup, p)).toBe(1);

    const delivery = buildFlow("delivery");
    let d = initialState(delivery);
    for (const t of [R.consent, R.geofence, R.placed_freight_photo, R.pod_signed]) {
      d = advance(delivery, d, [t]);
    }
    expect(currentStep(delivery, d).id).toBe("delivered");
    expect(currentStep(delivery, d).terminal).toBe(true);
  });

  it("by the terminal step the captured evidence is a SUPERSET of the server gate's requirement (true mirror)", () => {
    for (const [kind, opts] of [
      ["pickup", { dimsRequired: true }],
      ["pickup", {}],
      ["delivery", {}],
    ] as const) {
      const flow = buildFlow(kind, opts);
      let s = initialState(flow);
      // Drive the whole flow, feeding each step exactly its required evidence.
      while (!isComplete(flow, s)) {
        s = advance(flow, s, currentStep(flow, s).requires);
      }
      const captured = new Set(s.captured);
      for (const token of serverRequiredEvidence(kind, opts)) {
        expect(captured.has(token)).toBe(true);
      }
    }
  });

  it("progress runs 0 → 1 monotonically as steps clear", () => {
    const flow = buildFlow("delivery");
    let s = initialState(flow);
    let last = progress(flow, s);
    expect(last).toBe(0);
    for (const t of [[R.consent, R.geofence], [R.placed_freight_photo], [R.pod_signed]] as const) {
      s = advance(flow, s, t);
      expect(progress(flow, s)).toBeGreaterThanOrEqual(last);
      last = progress(flow, s);
    }
    expect(last).toBe(1);
  });
});

// AUDIT §498 — `canAdvance` and `advance` are ONE rule, and nothing compared them.
//
// `canAdvance` is what the tests ask; `advance` is what the driver's screen actually runs —
// `GatedFlow.tsx` imports `advance` and NOT `canAdvance`. Each computed `step.requires.every(...)` from its
// own copy, so a change to either would leave the tests asserting one rule and the PWA obeying the other,
// with both green. They now share `evidenceSatisfied`; this is the test that makes the sharing load-bearing
// rather than incidental.
describe("REQ-063 §498: the query and the transition cannot disagree", () => {
  const KINDS = ["pickup", "delivery"] as const;

  it("canAdvance is TRUE exactly when advance actually moves the step", () => {
    for (const kind of KINDS) {
      const flow = buildFlow(kind);
      // Walk every step, and at each one try every subset-of-one of its required evidence plus the full
      // set — the boundary where the two implementations could differ is "some but not all captured".
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i]!;
        const subsets: RequiredEvidence[][] = [[], [...step.requires], ...step.requires.map((r) => [r])];
        for (const captured of subsets) {
          const state = { kind, stepIndex: i, captured } as ReturnType<typeof initialState>;
          const moved = advance(flow, state).stepIndex !== state.stepIndex;
          const atEnd = i >= flow.steps.length - 1;
          expect(
            canAdvance(flow, state),
            `${kind} step ${i} (${step.id}) with [${captured.join(",")}]: canAdvance disagrees with advance`,
          ).toBe(moved || (atEnd && step.requires.every((r) => captured.includes(r))));
        }
      }
    }
  });

  it("a step with unmet evidence is a NO-OP — the untypassable-photo rule (REQ-063)", () => {
    const flow = buildFlow("delivery");
    const forced = flow.steps.findIndex((s) => s.requires.length > 0);
    expect(forced, "the delivery flow must have at least one evidence-gated step").toBeGreaterThanOrEqual(0);
    const state = { kind: "delivery", stepIndex: forced, captured: [] } as ReturnType<typeof initialState>;
    expect(advance(flow, state).stepIndex, "advance must not skip a gated step").toBe(forced);
    expect(canAdvance(flow, state)).toBe(false);
  });
});
