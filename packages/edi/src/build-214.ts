// X12 214 shipment-status serialize (REQ-200). PURE (REQ-035) and BYTE-STABLE: identical StatusView →
// identical bytes. The CALLER passes an already-mapped AT7 status code; build214 does NOT re-map, it only
// serializes. The single source of truth for the SHUDDL-status → AT7 dialect is DEFAULT_004010.statusDialect
// (mapping.ts), resolved per-partner via dialectStatus — build214 never duplicates that map.
import { StatusView } from "./types.js";
import { buildInterchange, segment } from "./writer.js";

// CCYYMMDD (AT705) + HHMM (AT706) from an ISO-ish timestamp via pure digit extraction — no Date object, so the
// output never shifts with the host timezone and stays deterministic.
function isoToDateTime(ts: string): { date: string; time: string } {
  const digits = ts.replace(/\D/g, "");
  return { date: digits.slice(0, 8).padEnd(8, "0"), time: digits.slice(8, 12).padEnd(4, "0") };
}

export function build214(view: StatusView): string {
  const v = StatusView.parse(view);

  const data: string[] = [];
  // B10: B1001 = reference/shipment id, B1002 = shipment id, B1003 = SCAC.
  data.push(segment(["B10", v.shipmentRef, v.shipmentRef, v.partnerScac]));

  v.stops.forEach((s, i) => {
    data.push(segment(["LX", String(i + 1)]));
    const { date, time } = isoToDateTime(s.ts);
    // AT7: AT701 status, AT702 reason, AT703/AT704 empty, AT705 date, AT706 time.
    data.push(segment(["AT7", s.statusCode, s.reasonCode ?? "", "", "", date, time]));
    if (s.city !== undefined || s.state !== undefined) {
      // MS1: MS101 city, MS102 state/province.
      data.push(segment(["MS1", s.city ?? "", s.state ?? ""]));
    }
  });

  return buildInterchange({
    docType: "214",
    gsCode: "QM",
    isaControl: v.isaControl,
    gsControl: v.gsControl,
    receiver: v.partnerScac,
    data,
  });
}
