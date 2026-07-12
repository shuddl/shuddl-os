import { describe, expect, it } from "vitest";
import { REQUIRED_EVIDENCE as R } from "@shuddl/ledger/gates/transition-gates";
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
