// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CaptureParams } from "@shuddl/driver-core";
import { DAY_SHEET, type Stop } from "../data/stops.js";
import { GatedFlow } from "./GatedFlow.js";

// The capture leg is mocked — this suite proves GatedFlow's ORCHESTRATION (evidence integrity), not the
// crypto: (2) a failed capture surfaces + blocks (never a silent POD drop), the POD is awaited before
// exit, a missing placed photo blocks; (3) a `?screen=` deep-linked terminal cannot enqueue a
// gate-invalid transition. The forced-photo camera guard is proven in CameraScreen.test.tsx.
vi.mock("../session.js", () => ({
  captureAndEnqueue: vi.fn(),
  consentAckPayload: () => ({ doc_kind: "consent", policy_version: "v1", operating_state: "OR", acknowledged: true }),
}));

// Stand-in screens that expose their commit/complete callback as a single tappable button, so the flow
// can be driven without a live camera / signature canvas.
vi.mock("./CameraScreen.js", () => ({
  CameraScreen: ({ onCommit }: { onCommit: (b: Uint8Array) => void }) => (
    <button type="button" onClick={() => onCommit(new Uint8Array([1, 2, 3]))}>mock-camera-commit</button>
  ),
}));
vi.mock("./SignatureScreen.js", () => ({
  SignatureScreen: ({ onCommit }: { onCommit: (b: Uint8Array) => void }) => (
    <button type="button" onClick={() => onCommit(new Uint8Array([4, 5, 6]))}>mock-sign-commit</button>
  ),
}));
vi.mock("./StopScreen.js", () => ({
  StopScreen: ({ step, onComplete }: { step: { id: string }; onComplete: () => void }) => (
    <button type="button" onClick={onComplete}>{`mock-stop-${step.id}`}</button>
  ),
}));

const { captureAndEnqueue } = await import("../session.js");
const enqueue = vi.mocked(captureAndEnqueue);

const DELIVERY: Stop = DAY_SHEET.find((s) => s.kind === "delivery") as Stop;
const PICKUP: Stop = DAY_SHEET.find((s) => s.kind === "pickup") as Stop;

type Recorded = { kind: string; payload: Record<string, unknown> };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  enqueue.mockReset();
});

describe("GatedFlow — the POD (delivery.evidenced) is never silently dropped (REQ-119/046)", () => {
  it("reaching `delivered` with a real placed hash ENQUEUES the POD and AWAITS it before onExit", async () => {
    let releaseDelivered!: () => void;
    const deliveredGate = new Promise<void>((r) => { releaseDelivered = r; });
    const calls: Recorded[] = [];
    enqueue.mockImplementation(async (params: CaptureParams) => {
      calls.push({ kind: params.kind, payload: params.payload as Record<string, unknown> });
      if (params.kind === "delivery.evidenced") { await deliveredGate; return {}; }
      return "evidence" in params && params.evidence ? { hash: "PLACEDHASH" } : {};
    });

    const onExit = vi.fn();
    const { findByText } = render(<GatedFlow stop={DELIVERY} onExit={onExit} />);

    fireEvent.click(await findByText("mock-stop-arrive")); // arrive → consent + stop.arrived
    fireEvent.click(await findByText("mock-camera-commit")); // photo_placed → freight.photographed (hash)
    fireEvent.click(await findByText("mock-sign-commit")); // sign → pod.signed
    fireEvent.click(await findByText("mock-stop-delivered")); // terminal → delivery.evidenced

    // The POD is enqueued carrying the threaded placed-photo hash...
    await waitFor(() => expect(calls.some((c) => c.kind === "delivery.evidenced")).toBe(true));
    const pod = calls.find((c) => c.kind === "delivery.evidenced");
    expect(pod?.payload.placed_photo_hash).toBe("PLACEDHASH");
    // ...and onExit is BLOCKED until the enqueue resolves — proving the terminal AWAITS the POD.
    expect(onExit).not.toHaveBeenCalled();
    releaseDelivered();
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });

  it("a FAILED placed-photo capture BLOCKS advance and SURFACES an error (never a silent skip)", async () => {
    enqueue.mockImplementation(async (params: CaptureParams) => {
      if (params.kind === "freight.photographed") throw new Error("IDB write failed");
      return {};
    });

    const onExit = vi.fn();
    const { findByText, queryByText } = render(<GatedFlow stop={DELIVERY} onExit={onExit} />);

    fireEvent.click(await findByText("mock-stop-arrive")); // arrive ok
    fireEvent.click(await findByText("mock-camera-commit")); // placed photo capture throws

    await findByText(/CAPTURE FAILED/i); // error surfaced
    expect(queryByText("mock-sign-commit")).toBeNull(); // did NOT advance past the failed capture
    expect(onExit).not.toHaveBeenCalled();
    // The POD was never reached — no delivery.evidenced could have been enqueued over a missing photo.
    expect(enqueue.mock.calls.some(([p]) => p.kind === "delivery.evidenced")).toBe(false);
  });
});

describe("GatedFlow — a ?screen= deep-linked terminal cannot enqueue a gate-invalid event (REQ-119)", () => {
  it("deep-link to the pickup terminal (depart) enqueues NOTHING — the upstream events weren't emitted", async () => {
    enqueue.mockResolvedValue({});
    const onExit = vi.fn();
    const { findByText } = render(<GatedFlow stop={PICKUP} startStep="depart" onExit={onExit} />);

    fireEvent.click(await findByText("mock-stop-depart"));

    await findByText(/UPSTREAM EVIDENCE MISSING/i);
    expect(enqueue).not.toHaveBeenCalled(); // no stop.departed the server would 403
    expect(onExit).not.toHaveBeenCalled();
  });

  it("deep-link to the delivery terminal (delivered) enqueues NO delivery.evidenced", async () => {
    enqueue.mockResolvedValue({});
    const onExit = vi.fn();
    const { findByText } = render(<GatedFlow stop={DELIVERY} startStep="delivered" onExit={onExit} />);

    fireEvent.click(await findByText("mock-stop-delivered"));

    await findByText(/UPSTREAM EVIDENCE MISSING/i);
    expect(enqueue).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });
});
