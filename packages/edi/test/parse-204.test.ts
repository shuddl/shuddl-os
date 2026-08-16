import { describe, it, expect } from "vitest";
import { parse204 } from "../src/parse-204.js";
import { EdiParseError } from "../src/envelope.js";
import { TenderDoc, StatusView, TenderResponse } from "../src/types.js";

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
    // AT804=40 now populates the piece count; the fixture carries no L4, so l/w/h stay UNKNOWN.
    expect(d.dims).toEqual({ pieces: 40 });
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

// A minimal 204 whose L11 refs and AT8 weight are attacker-controlled, to prove the untrusted-partner boundary
// is prototype-safe and refuses a bogus weight.
function hostileDoc(opts: { l11: Array<[string, string]>; at8?: string }): string {
  const S = (...f: string[]): string => f.join("*") + "~";
  const l11 = opts.l11.map(([value, qual]) => S("L11", value, qual)).join("");
  const at8 = opts.at8 === undefined ? "" : S("AT8", "G", "L", opts.at8, "40");
  return (
    isaHeader("000000042") +
    S("GS", "SM", "MEGA", "SHUDDL", "20260719", "1200", "77", "X", "004010") +
    S("ST", "204", "0001") +
    S("B2", "", "MEGA", "", "SHIP123", "", "PP") +
    S("B2A", "00") +
    l11 +
    S("N1", "SH", "ACME") +
    S("N4", "NEWARK", "NJ", "07101") +
    at8 +
    S("SE", "9", "0001") +
    S("GE", "1", "77") +
    S("IEA", "1", "000000042")
  );
}

// A minimal priceable-shape 204 with a configurable L4 measurement + AT8 lading quantity, to prove the SINGLE
// dims parse path: parse204 populates TenderDoc.dims from L4 ONLY when the unit is inches (IN) and l/w/h are
// positive integers, and pieces from AT8 AT804 (last-VALID-wins). A CM/FT/zero L4 leaves l/w/h UNKNOWN (no
// price on air — never a fabricated dimension in an unknown unit).
function dimsDoc(opts: { l4?: [string, string, string, string]; at8Qty?: string; secondAt8Qty?: string }): string {
  const S = (...f: string[]): string => f.join("*") + "~";
  const l4 = opts.l4 === undefined ? "" : S("L4", ...opts.l4);
  const at8 = S("AT8", "G", "L", "15000", opts.at8Qty ?? "");
  const at8b = opts.secondAt8Qty === undefined ? "" : S("AT8", "G", "L", "16000", opts.secondAt8Qty);
  return (
    isaHeader("000000042") +
    S("GS", "SM", "MEGA", "SHUDDL", "20260719", "1200", "77", "X", "004010") +
    S("ST", "204", "0001") +
    S("B2", "", "MEGA", "", "SHIP123", "", "PP") +
    S("B2A", "00") +
    S("N1", "SH", "ACME") +
    S("N4", "NEWARK", "NJ", "07101") +
    l4 +
    at8 +
    at8b +
    S("SE", "9", "0001") +
    S("GE", "1", "77") +
    S("IEA", "1", "000000042")
  );
}

describe("parse204 — dims from L4 + AT8 pieces (the single dims parse path, REQ-201/204)", () => {
  it("L4 in inches + AT8 lading quantity populate dims (l/w/h + pieces)", () => {
    const d = parse204(dimsDoc({ l4: ["48", "40", "60", "IN"], at8Qty: "40" }));
    expect(d.dims).toEqual({ lengthIn: 48, widthIn: 40, heightIn: 60, pieces: 40 });
  });

  it("an L4 in CENTIMETRES leaves l/w/h UNKNOWN (no price on air — never a fabricated inch)", () => {
    const d = parse204(dimsDoc({ l4: ["120", "100", "150", "CM"], at8Qty: "40" }));
    expect(d.dims?.lengthIn).toBeUndefined();
    expect(d.dims?.widthIn).toBeUndefined();
    expect(d.dims?.heightIn).toBeUndefined();
    expect(d.dims?.pieces).toBe(40); // pieces still parsed from AT8
  });

  it("a ZERO or non-integer L4 dimension is rejected (leaves l/w/h undefined)", () => {
    expect(parse204(dimsDoc({ l4: ["0", "40", "60", "IN"], at8Qty: "40" })).dims?.lengthIn).toBeUndefined();
    expect(parse204(dimsDoc({ l4: ["48.5", "40", "60", "IN"], at8Qty: "40" })).dims?.lengthIn).toBeUndefined();
  });

  it("pieces is LAST-VALID-wins — a later blank AT8 never clears an earlier valid quantity", () => {
    // first AT8 carries qty 40, a second (blank AT804) must NOT reset pieces to undefined.
    const d = parse204(dimsDoc({ l4: ["48", "40", "60", "IN"], at8Qty: "40", secondAt8Qty: "" }));
    expect(d.dims?.pieces).toBe(40);
  });

  it("no L4 and no AT8 quantity → dims stays undefined entirely (no price on air)", () => {
    const d = parse204(dimsDoc({}));
    expect(d.dims).toBeUndefined();
  });
});

// EXIT-AUDIT F-4 (Info — SCAC delimiter injection): the SCAC crosses into X12 envelopes verbatim, so a
// delimiter-bearing value (`*` element sep, `~` segment terminator, `>` sub-element sep, newline) would inject a
// segment/element or corrupt outbound byte-stability. Constrain the charset at the parse/serialize boundary on
// ALL THREE SCAC-bearing schemas (defense-in-depth). Real SCACs are 2–4 alpha; `{2,15}` alphanumeric is generous.
describe("SCAC charset guard — no X12 delimiter injection (REQ-202/204, F-4)", () => {
  const okTender = { partnerScac: "MEGA", purpose: "00" as const, refs: {}, stops: [] };
  const okStatus = { shipmentRef: "S1", partnerScac: "MEGA", isaControl: "000000042", gsControl: "42", stops: [] };
  const okResponse = { shipmentRef: "S1", partnerScac: "MEGA", isaControl: "000000042", gsControl: "42", action: "A" as const };

  it("rejects a delimiter/control-char-bearing SCAC on every SCAC-bearing schema", () => {
    for (const bad of ["ME*GA", "AC~ME", "A>B", "MEGA\n", "ME GA", "M", ""]) {
      expect(() => TenderDoc.parse({ ...okTender, partnerScac: bad }), `TenderDoc rejects ${JSON.stringify(bad)}`).toThrow();
      expect(() => StatusView.parse({ ...okStatus, partnerScac: bad }), `StatusView rejects ${JSON.stringify(bad)}`).toThrow();
      expect(() => TenderResponse.parse({ ...okResponse, partnerScac: bad }), `TenderResponse rejects ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it("still accepts real alphanumeric SCACs (the certification fixtures use SYNC/MEGA/ACME)", () => {
    for (const good of ["MEGA", "ACME", "SYNC", "UPSN", "FDEG", "AA"]) {
      expect(() => TenderDoc.parse({ ...okTender, partnerScac: good })).not.toThrow();
      expect(() => StatusView.parse({ ...okStatus, partnerScac: good })).not.toThrow();
      expect(() => TenderResponse.parse({ ...okResponse, partnerScac: good })).not.toThrow();
    }
  });

  it("a delimiter-bearing B202 in a raw 204 fails parse204 (→ the worker quarantines it, fail-closed)", () => {
    const S = (...f: string[]): string => f.join("*") + "~";
    // A `>` (sub-element sep) survives tokenization inside B202 → the SCAC guard rejects it at TenderDoc.parse.
    const doc =
      isaHeader("000000042") +
      S("GS", "SM", "MEGA", "SHUDDL", "20260719", "1200", "77", "X", "004010") +
      S("ST", "204", "0001") +
      S("B2", "", "ME>GA", "", "SHIP123", "", "PP") +
      S("B2A", "00") +
      S("N1", "SH", "ACME") +
      S("N4", "NEWARK", "NJ", "07101") +
      S("SE", "5", "0001") +
      S("GE", "1", "77") +
      S("IEA", "1", "000000042");
    expect(() => parse204(doc)).toThrow();
  });
});

describe("parse204 — untrusted-partner boundary hardening", () => {
  it("preserves refs whose qualifier collides with an Object.prototype member (no silent drop/corruption)", () => {
    const d = parse204(
      hostileDoc({
        l11: [
          ["C987", "constructor"],
          ["T987", "toString"],
          ["P987", "__proto__"],
        ],
      }),
    );
    const refs = d.refs as Record<string, string>;
    expect(Object.hasOwn(refs, "constructor")).toBe(true);
    expect(refs["constructor"]).toBe("C987");
    expect(Object.hasOwn(refs, "toString")).toBe(true);
    expect(refs["toString"]).toBe("T987");
    // __proto__ would vanish through a {}-proto build AND through zod's record rebuild; the prototype-safe
    // path keeps it as a real own key (Migrator rule: a ref is never silently dropped).
    expect(Object.hasOwn(refs, "__proto__")).toBe(true);
    expect(refs["__proto__"]).toBe("P987");
  });

  it("rejects a non-positive-decimal AT8 weight, leaving weightLb undefined (no price on air)", () => {
    expect(parse204(hostileDoc({ l11: [], at8: "-500" })).weightLb).toBeUndefined();
    expect(parse204(hostileDoc({ l11: [], at8: "0x10" })).weightLb).toBeUndefined();
    expect(parse204(hostileDoc({ l11: [], at8: "1e5" })).weightLb).toBeUndefined();
    expect(parse204(hostileDoc({ l11: [], at8: "0" })).weightLb).toBeUndefined();
    expect(parse204(hostileDoc({ l11: [], at8: "42000" })).weightLb).toBe(42000);
  });
});

// §1604 (REQ-201/034/118) — A TRUNCATED 204 PARSES AS A COMPLETE TENDER WITH NO STOPS.
//
// X12 gives a receiver one integrity check for exactly this: SE01 states how many segments the transaction set
// contains. `envelope.ts` validates ST/SE **balance** and the IEA trailer's presence — it does not compare
// SE01's COUNT to the segments actually read. And `TenderDoc.stops` is `z.array(TenderStop)` with no `.min()`.
//
// So a transmission cut after the L11/AT8 block — every N1/N3/N4/G62 stop group gone, SE01 still claiming 18
// where five segments remain — parses clean. Measured below: `stops: []`, refs and weight intact.
//
// DOWNSTREAM IS FAIL-CLOSED, which is why this is filed rather than fixed here: `map-204` finds no SH/CN stop,
// `inbound` guards on `!== undefined`, and a tender with no origin or destination cannot be priced, so it rests
// at `quote.requested` rather than becoming a bad booking. **The cost is diagnosability, not correctness** — a
// partner's truncated message becomes a stuck tender with no explanation instead of a quarantine that names
// the truncation.
//
// THE FIX IS A DECISION, not an edit. Validating SE01 is the standard's own answer and catches truncation and
// injection generally — but strict SE01 enforcement is famously brittle against real senders that emit a wrong
// count, so turning it on can reject traffic that works today. A `.min(1)` on stops is narrower but guesses at
// semantics. Both are owner calls (GO-LIVE-CHECKLIST, audit §1604). This case PINS today's behaviour so
// whichever is chosen lands deliberately: **when it fails, the decision was made — update the row and rewrite
// this case as the refusal it becomes.**
describe("§1604 REQ-201: a stop-truncated 204 parses as a complete tender (filed, not fixed)", () => {
  const S = (...f: string[]): string => f.join("*") + "~";

  it("every stop group removed + a WRONG SE01 count still yields a valid TenderDoc", () => {
    const truncated =
      isaHeader("000000042") +
      S("GS", "SM", "MEGA", "SHUDDL", "20260719", "1200", "77", "X", "004010") +
      S("ST", "204", "0001") +
      S("B2", "", "MEGA", "", "SHIP123", "", "PP") +
      S("B2A", "00") +
      S("L11", "BOL987", "BM") +
      S("AT8", "G", "L", "15000", "40") +
      S("SE", "18", "0001") + // claims 18; five segments are present
      S("GE", "1", "77") +
      S("IEA", "1", "000000042");

    const doc = parse204(truncated);
    expect(
      doc.stops.length,
      "a stop-truncated 204 is now REFUSED — SE01 validation or a stops floor landed. That is the fix this case " +
        "was written to detect: strike the GO-LIVE-CHECKLIST row (audit §1604) and rewrite this as the refusal.",
    ).toBe(0);
    expect(doc.weightLb, "the surviving fields still parse — truncation is invisible, not partial").toBe(15000);
    expect(Object.keys(doc.refs).length, "the refs before the cut survive").toBeGreaterThan(0);
  });
});
