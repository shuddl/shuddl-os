import { describe, it, expect } from "vitest";
import { build214 } from "../src/build-214.js";
import type { StatusView } from "../src/types.js";

const view: StatusView = {
  shipmentRef: "SHIP123",
  partnerScac: "MEGA",
  isaControl: "42",
  gsControl: "77",
  stops: [
    { statusCode: "X3", reasonCode: "NS", ts: "2026-07-20T08:00:00Z", city: "NEWARK", state: "NJ" },
    { statusCode: "D1", ts: "2026-07-21T16:30:00Z", city: "BOSTON", state: "MA" },
  ],
};

// Expected bytes, built independently of the serializer's internals (fixed-width ISA via padEnd here).
const isa = [
  "ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "SHUDDL".padEnd(15), "ZZ", "MEGA".padEnd(15),
  "000101", "0000", "U", "00401", "000000042", "0", "P", ">",
].join("*");

const expected = [
  isa,
  "GS*QM*SHUDDL*MEGA*20000101*0000*77*X*004010",
  "ST*214*0077",
  "B10*SHIP123*SHIP123*MEGA",
  "LX*1",
  "AT7*X3*NS***20260720*0800",
  "MS1*NEWARK*NJ",
  "LX*2",
  "AT7*D1****20260721*1630",
  "MS1*BOSTON*MA",
  "SE*9*0077",
  "GE*1*77",
  "IEA*1*000000042",
].map((s) => s + "~").join("");

describe("build214", () => {
  it("serializes a two-stop StatusView to the exact expected X12 214 bytes", () => {
    expect(build214(view)).toBe(expected);
  });

  it("is byte-stable: identical input yields identical output", () => {
    expect(build214(view)).toBe(build214(view));
  });

  it("pads the interchange control number to the fixed 9-char ISA13/IEA02 field", () => {
    const out = build214(view);
    expect(out).toContain("*000000042*0*P*>~"); // ISA13 padded
    expect(out.endsWith("IEA*1*000000042~")).toBe(true);
  });
});

// §1593 (REQ-200/034/118) — A DELIMITER IN A VALUE RESTRUCTURES THE INTERCHANGE.
//
// `segment()` is `fields.join(EL)` and X12 has no escape mechanism, so a value carrying `*`, `~` or `>` does
// not render oddly — it changes the SHAPE of the message. Measured before the fix, on the two fields that
// carry freight data rather than controlled codes:
//
//   · `shipmentRef: "SHP*AAA"` → B10 serialised with SIX elements instead of four, so every position after it
//     shifts and the partner reads the SCAC where a reference belongs.
//   · `city: "PORT~LAND"` → TWELVE segments where the SE01 trailer states eleven. SE01 is computed as
//     `data.length + 2` from the array, so the count no longer describes the bytes: a hard structural error
//     that a receiver's translator rejects outright.
//
// Both strings arrive from freight data — an incumbent import, an inbound 204 — and nothing upstream forbids
// an asterisk. The boundary now refuses. The sweep's per-item isolation makes that one logged shipment, not a
// stalled tick, and refusing beats substituting: the reference is what the partner MATCHES on, so a silent
// replacement trades a rejected message for an unmatchable one (the sanitise-instead decision is filed).
describe("§1593 REQ-200: an X12 delimiter inside a value is refused at the boundary", () => {
  const base = { partnerScac: "ABCD", isaControl: "000000001", gsControl: "1" };
  const stop = { statusCode: "X6", ts: "2026-01-01T00:00:00Z", city: "PORTLAND", state: "OR" };

  it("a clean view still builds (the refusals below prove nothing without this)", () => {
    const out = build214({ ...base, shipmentRef: "SHPAAA", stops: [stop] });
    const b10 = out.split("~").find((s) => s.startsWith("B10"));
    expect(b10?.split("*").length, "B10 carries a tag + three elements").toBe(4);
  });

  const CASES: Array<[string, Parameters<typeof build214>[0]]> = [
    ["an element separator in shipmentRef", { ...base, shipmentRef: "SHP*AAA", stops: [stop] }],
    ["a segment terminator in shipmentRef", { ...base, shipmentRef: "SHP~AAA", stops: [stop] }],
    ["a component separator in shipmentRef", { ...base, shipmentRef: "SHP>AAA", stops: [stop] }],
    ["a segment terminator in a city", { ...base, shipmentRef: "SHPAAA", stops: [{ ...stop, city: "PORT~LAND" }] }],
    ["an element separator in a city", { ...base, shipmentRef: "SHPAAA", stops: [{ ...stop, city: "PORT*LAND" }] }],
    ["an element separator in a reason code", { ...base, shipmentRef: "SHPAAA", stops: [{ ...stop, reasonCode: "A*1" }] }],
  ];

  for (const [what, view] of CASES) {
    it(`${what} is REFUSED, never serialised`, () => {
      expect(
        () => build214(view),
        `${what} was serialised. X12 has no escaping, so this does not render oddly — it restructures the ` +
          `interchange and the partner parses different data in every position after it.`,
      ).toThrow();
    });
  }
});
