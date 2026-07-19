import { describe, it, expect } from "vitest";
import { parse204 } from "../src/parse-204.js";
import { EdiParseError } from "../src/envelope.js";

function isaHeader(control: string): string {
  const c = control.padStart(9, "0").slice(-9);
  const sender = "MEGA".padEnd(15, " ");
  const receiver = "SHUDDL".padEnd(15, " ");
  const fields = [
    "ISA", "00", "          ", "00", "          ", "ZZ", sender, "ZZ", receiver,
    "260719", "1200", "U", "00401", c, "0", "P", ">",
  ];
  return fields.join("*") + "~";
}

// A synthetic but complete 204 load tender: shipper + consignee + bill-to + weight, with appt windows.
function tender204(): string {
  const S = (...f: string[]): string => f.join("*") + "~";
  return (
    isaHeader("000000042") +
    S("GS", "SM", "MEGA", "SHUDDL", "20260719", "1200", "77", "X", "004010") +
    S("ST", "204", "0001") +
    S("B2", "", "MEGA", "", "SHIP123", "", "PP") +
    S("B2A", "00") +
    S("L11", "BOL987", "BM") +
    S("N1", "SH", "ACME SHIPPING") +
    S("N3", "100 DOCK ST") +
    S("N4", "NEWARK", "NJ", "07101") +
    S("G62", "10", "20260720", "I", "0800") +
    S("N1", "CN", "BETA RECEIVING") +
    S("N3", "200 PORT AVE") +
    S("N4", "BOSTON", "MA", "02101") +
    S("G62", "02", "20260721", "I", "1600") +
    S("N1", "BT", "GAMMA BROKERS") +
    S("N3", "300 FINANCE BLVD") +
    S("N4", "CHICAGO", "IL", "60601") +
    S("PER", "BI", "ACCTS", "EM", "ap@gamma.example") +
    S("AT8", "G", "L", "15000", "40") +
    S("SE", "18", "0001") +
    S("GE", "1", "77") +
    S("IEA", "1", "000000042")
  );
}

describe("parse204", () => {
  it("maps a full 204 to a normalized TenderDoc", () => {
    const d = parse204(tender204());
    expect(d.partnerScac).toBe("MEGA");
    expect(d.purpose).toBe("00");
    expect(d.refs).toEqual({ SID: "SHIP123", BM: "BOL987" });
    expect(d.stops).toHaveLength(2);
    expect(d.stops[0]).toEqual({
      role: "SH",
      name: "ACME SHIPPING",
      address: { street: "100 DOCK ST", city: "NEWARK", state: "NJ", zip: "07101" },
      apptWindow: { start: "2026-07-20T08:00" },
    });
    expect(d.stops[1]).toEqual({
      role: "CN",
      name: "BETA RECEIVING",
      address: { street: "200 PORT AVE", city: "BOSTON", state: "MA", zip: "02101" },
      apptWindow: { end: "2026-07-21T16:00" },
    });
    expect(d.billTo).toEqual({
      name: "GAMMA BROKERS",
      email: "ap@gamma.example",
      address: { street: "300 FINANCE BLVD", city: "CHICAGO", state: "IL", zip: "60601" },
    });
    expect(d.weightLb).toBe(15000);
    expect(d.dims).toBeUndefined();
  });

  it("leaves weight undefined when the 204 carries no AT8 (no price on air)", () => {
    const S = (...f: string[]): string => f.join("*") + "~";
    const noWeight =
      isaHeader("000000043") +
      S("GS", "SM", "MEGA", "SHUDDL", "20260719", "1200", "78", "X", "004010") +
      S("ST", "204", "0001") +
      S("B2", "", "MEGA", "", "SHIP999", "", "PP") +
      S("B2A", "00") +
      S("N1", "SH", "ACME SHIPPING") +
      S("N4", "NEWARK", "NJ", "07101") +
      S("SE", "5", "0001") +
      S("GE", "1", "78") +
      S("IEA", "1", "000000043");
    const d = parse204(noWeight);
    expect(d.weightLb).toBeUndefined();
    expect(d.dims).toBeUndefined();
  });

  it("propagates EdiParseError when a required envelope segment is missing", () => {
    const full = tender204();
    const truncated = full.slice(0, full.indexOf("IEA"));
    expect(() => parse204(truncated)).toThrow(EdiParseError);
  });
});
