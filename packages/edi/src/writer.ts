// Byte-stable X12 envelope writer shared by the outbound serializers (214, 990). DETERMINISM is the law here:
// identical input → identical output bytes. That means NO Date.now() and NO counters — the interchange date /
// time are fixed constants and the control numbers are passed in by the caller. Outbound interchanges always
// use the default delimiters (element `*`, sub-element `>`, segment `~`), so those are constants too.
// PURE (REQ-035): no I/O, no ledger/rater import.

export const EL = "*";
export const SEG = "~";
export const SUB = ">";

// SHUDDL is always the sender of an outbound 214/990 (application sender code + ISA06 interchange sender ID).
const SENDER = "SHUDDL";

// Fixed placeholder interchange date/time. Real per-send timestamps would break byte-stability and are not
// part of the deterministic contract (the caller supplies only control numbers), so these stay constant.
const ISA_DATE = "000101"; // ISA09 YYMMDD
const ISA_TIME = "0000"; // ISA10 HHMM
const GS_DATE = "20000101"; // GS04 CCYYMMDD
const GS_TIME = "0000"; // GS05 HHMM

function pad(value: string, len: number): string {
  return value.padEnd(len, " ").slice(0, len);
}

function isaControl9(isaControl: string): string {
  return isaControl.padStart(9, "0").slice(-9);
}

// Assemble one segment from its fields (tag first), element-separated.
export function segment(fields: string[]): string {
  return fields.join(EL);
}

export interface InterchangeParams {
  docType: string; // ST01, e.g. "214" | "990"
  gsCode: string; // GS01 functional identifier code, e.g. "QM" | "GF"
  isaControl: string; // ISA13 / IEA02
  gsControl: string; // GS06 / GE02 (and, zero-padded to 4, ST02 / SE02)
  receiver: string; // partner SCAC → ISA08 / GS03
  data: string[]; // inner segments (already element-joined), excluding ST/SE
}

// Wrap the caller's data segments in a complete, byte-stable interchange: ISA/GS/ST/…/SE/GE/IEA.
export function buildInterchange(p: InterchangeParams): string {
  const control9 = isaControl9(p.isaControl);
  const stControl = p.gsControl.padStart(4, "0"); // ST02 min length is 4

  const isa = segment([
    "ISA", "00", pad("", 10), "00", pad("", 10), "ZZ", pad(SENDER, 15), "ZZ", pad(p.receiver, 15),
    ISA_DATE, ISA_TIME, "U", "00401", control9, "0", "P", SUB,
  ]);
  const gs = segment(["GS", p.gsCode, SENDER, p.receiver, GS_DATE, GS_TIME, p.gsControl, "X", "004010"]);
  const st = segment(["ST", p.docType, stControl]);
  const se = segment(["SE", String(p.data.length + 2), stControl]); // ST + data + SE
  const ge = segment(["GE", "1", p.gsControl]);
  const iea = segment(["IEA", "1", control9]);

  return [isa, gs, st, ...p.data, se, ge, iea].map((s) => s + SEG).join("");
}
