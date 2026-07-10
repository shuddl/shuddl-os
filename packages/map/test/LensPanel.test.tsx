import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { LensPanel } from "../src/LensPanel.js";

// The lens is the click target of the map (REQ-080): it shows the selected shipment's event tail and
// closes back to the board — the map never navigates. This smoke test proves the panel composes the
// @shuddl/design primitives and surfaces the tail + close affordance.

afterEach(cleanup);

describe("LensPanel (REQ-080)", () => {
  it("renders the shipment label and its event tail", () => {
    const { getByText } = render(
      <LensPanel
        shipmentId="shp-1"
        label="AUSTIN -> DALLAS"
        status="at-risk"
        events={[
          { kind: "PICKUP", at: "09:14" },
          { kind: "DWELL", at: "12:02", detail: "4:12" },
        ]}
      />,
    );
    getByText("AUSTIN -> DALLAS");
    getByText("PICKUP");
    getByText("DWELL");
  });

  it("closes back to the board (the map never navigates away)", () => {
    const onClose = vi.fn();
    const { getByText } = render(<LensPanel shipmentId="shp-1" events={[]} onClose={onClose} />);
    fireEvent.click(getByText(/close/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
