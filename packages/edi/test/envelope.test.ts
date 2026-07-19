import { describe, it, expect } from "vitest";
import { tokenize, EdiParseError } from "../src/envelope.js";

// Build a fixed-width ISA header from parts, honoring a caller-chosen element sep / segment terminator /
// sub-element sep so we can prove the tokenizer READS the delimiters from the ISA rather than hardcoding them.
function isaHeader(opts: {
  el: string;
  seg: string;
  sub: string;
  control: string;
  sender?: string;
  receiver?: string;
}): string {
  const control = opts.control.padStart(9, "0").slice(-9);
  const sender = (opts.sender ?? "SHUDDL").padEnd(15, " ").slice(0, 15);
  const receiver = (opts.receiver ?? "PARTNER").padEnd(15, " ").slice(0, 15);
  const fields = [
    "ISA", "00", "          ", "00", "          ", "ZZ", sender, "ZZ", receiver,
    "260719", "1200", "U", "00401", control, "0", "P", opts.sub,
  ];
  return fields.join(opts.el) + opts.seg;
}

// A minimal-but-complete 204 interchange (ISA/GS/ST/…/SE/GE/IEA) with caller-chosen delimiters.
function doc(opts: { el?: string; seg?: string; sub?: string; control?: string; gsControl?: string }): string {
  const el = opts.el ?? "*";
  const seg = opts.seg ?? "~";
  const sub = opts.sub ?? ">";
  const control = opts.control ?? "000000042";
  const gsControl = opts.gsControl ?? "77";
  const S = (...fields: string[]): string => fields.join(el) + seg;
  return (
    isaHeader({ el, seg, sub, control }) +
    S("GS", "SM", "SHUDDL", "PARTNER", "20260719", "1200", gsControl, "X", "004010") +
    S("ST", "204", "0001") +
    S("B2", "", "SCAC", "", "SHIP123", "", "PP") +
    S("B2A", "00") +
    S("SE", "5", "0001") +
    S("GE", "1", gsControl) +
    S("IEA", "1", control.padStart(9, "0").slice(-9))
  );
}

describe("tokenize (X12 envelope)", () => {
  it("tokenizes a minimal valid ISA…IEA and reads the control numbers + ST", () => {
    const t = tokenize(doc({}));
    expect(t.isaControl).toBe("000000042");
    expect(t.gsControl).toBe("77");
    expect(t.delims).toEqual({ element: "*", segment: "~", sub: ">" });
    const st = t.segments.find((s) => s.tag === "ST");
    expect(st).toBeDefined();
    expect(st?.elements[0]).toBe("204");
    // elements exclude the tag; the ISA control number is ISA13 = elements[12]
    const isa = t.segments.find((s) => s.tag === "ISA");
    expect(isa?.elements[12]).toBe("000000042");
  });

  it("honors a non-default element separator declared in the ISA", () => {
    const t = tokenize(doc({ el: "|" }));
    expect(t.delims.element).toBe("|");
    expect(t.isaControl).toBe("000000042");
    expect(t.gsControl).toBe("77");
    expect(t.segments.find((s) => s.tag === "ST")?.elements[0]).toBe("204");
  });

  it("honors a non-default segment terminator declared in the ISA", () => {
    const t = tokenize(doc({ seg: "\n" }));
    expect(t.delims.segment).toBe("\n");
    expect(t.segments.find((s) => s.tag === "B2A")?.elements[0]).toBe("00");
  });

  it("throws EdiParseError when the interchange does not start with ISA", () => {
    expect(() => tokenize("GS*SM*A*B~")).toThrow(EdiParseError);
  });

  it("throws EdiParseError on an ISA shorter than a valid header", () => {
    expect(() => tokenize("ISA*00*too-short~")).toThrow(EdiParseError);
  });

  it("throws EdiParseError on a truncated interchange missing IEA", () => {
    const full = doc({});
    const truncated = full.slice(0, full.indexOf("IEA"));
    expect(() => tokenize(truncated)).toThrow(EdiParseError);
  });

  it("throws EdiParseError on an ST without a matching SE", () => {
    const el = "*";
    const seg = "~";
    const S = (...f: string[]): string => f.join(el) + seg;
    const noSe =
      isaHeader({ el, seg, sub: ">", control: "000000042" }) +
      S("GS", "SM", "SHUDDL", "PARTNER", "20260719", "1200", "77", "X", "004010") +
      S("ST", "204", "0001") +
      S("B2A", "00") +
      // no SE
      S("GE", "1", "77") +
      S("IEA", "1", "000000042");
    expect(() => tokenize(noSe)).toThrow(EdiParseError);
  });
});
