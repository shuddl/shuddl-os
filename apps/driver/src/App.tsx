import { useState } from "react";
import { DAY_SHEET, type Stop } from "./data/stops.js";
import type { StepId } from "./flow/stop-flow.js";
import { DaySheet } from "./components/DaySheet.js";
import { GatedFlow } from "./components/GatedFlow.js";

// DRIVER PWA (doc 07 §03) — the day sheet and the gated per-stop flow. Ink-dark ground, `--field`
// type, ONE question + ONE button per screen, the ONE teal progress line. A `?screen=` param positions
// any flow screen deterministically so the live-render harness can prove each state (WP-03 honesty).

type View = { kind: "daysheet" } | { kind: "flow"; stop: Stop; startStep?: StepId };

const PICKUP = DAY_SHEET.find((s) => s.kind === "pickup") ?? DAY_SHEET[0];
const DELIVERY = DAY_SHEET.find((s) => s.kind === "delivery") ?? DAY_SHEET[0];

// Map a `?screen=` value to an initial view. Unknown / absent ⇒ the day sheet.
function initialView(param: string | null): View {
  switch (param) {
    case "arrive":
      return DELIVERY ? { kind: "flow", stop: DELIVERY, startStep: "arrive" } : { kind: "daysheet" };
    case "count":
      return PICKUP ? { kind: "flow", stop: PICKUP, startStep: "count" } : { kind: "daysheet" };
    case "photo":
      return PICKUP ? { kind: "flow", stop: PICKUP, startStep: "photo_freight" } : { kind: "daysheet" };
    case "dims":
      return PICKUP ? { kind: "flow", stop: PICKUP, startStep: "dims" } : { kind: "daysheet" };
    case "signature":
      return DELIVERY ? { kind: "flow", stop: DELIVERY, startStep: "sign" } : { kind: "daysheet" };
    case "depart":
      return PICKUP ? { kind: "flow", stop: PICKUP, startStep: "depart" } : { kind: "daysheet" };
    case "delivered":
      return DELIVERY ? { kind: "flow", stop: DELIVERY, startStep: "delivered" } : { kind: "daysheet" };
    default:
      return { kind: "daysheet" };
  }
}

export function App(): React.JSX.Element {
  const param = new URLSearchParams(window.location.search).get("screen");
  const [view, setView] = useState<View>(() => initialView(param));

  if (view.kind === "flow") {
    return (
      <GatedFlow
        stop={view.stop}
        {...(view.startStep ? { startStep: view.startStep } : {})}
        onExit={() => setView({ kind: "daysheet" })}
      />
    );
  }

  return <DaySheet stops={DAY_SHEET} doneCount={1} onOpen={(stop) => setView({ kind: "flow", stop })} />;
}
