// X12 990 response-to-a-load-tender serialize (REQ-201). PURE (REQ-035) and BYTE-STABLE. A 990 is a single B1
// segment carrying the SCAC, the shipment id, and the reservation action code ("A" accept / "D" decline),
// wrapped in the shared deterministic interchange envelope. Control numbers are passed in, not generated.
import { TenderResponse } from "./types.js";
import { buildInterchange, segment } from "./writer.js";

export function build990(r: TenderResponse): string {
  const v = TenderResponse.parse(r);
  // B1: B101 = SCAC, B102 = shipment identification number, B103 = reservation action code.
  const data = [segment(["B1", v.partnerScac, v.shipmentRef, v.action])];
  return buildInterchange({
    docType: "990",
    gsCode: "GF",
    isaControl: v.isaControl,
    gsControl: v.gsControl,
    receiver: v.partnerScac,
    data,
  });
}
