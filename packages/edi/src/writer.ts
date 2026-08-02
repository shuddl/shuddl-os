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

// Fixed placeholder interchange date/time — the DEFAULT, keeping every fixture byte-stable. A live send
// stamps the real instant via `sentAt` (2026-08-01 audit: a 2000-01-01 interchange date is commonly
// rejected by partner VANs, so the send path supplies it exactly where it supplies control numbers). The
// writer stays PURE either way: `sentAt` is an INPUT — no Date.now() in this package, identical input →
// identical bytes.
const ISA_DATE = "000101"; // ISA09 YYMMDD
const ISA_TIME = "0000"; // ISA10 HHMM
const GS_DATE = "20000101"; // GS04 CCYYMMDD
const GS_TIME = "0000"; // GS05 HHMM

// The four envelope stamps for a real send instant (UTC — X12 carries no zone; UTC is the one unambiguous
// choice and matches the ledger's epoch-ms convention).
function envelopeStamps(sentAt: number): { isaDate: string; isaTime: string; gsDate: string; gsTime: string } {
  const d = new Date(sentAt);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return { isaDate: yyyy.slice(2) + mm + dd, isaTime: hh + mi, gsDate: yyyy + mm + dd, gsTime: hh + mi };
}

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
  /** The real send instant (epoch ms) — a SEND-TIME input, stamped by the sweep where it stamps control
   *  numbers. Absent (fixtures, dedupe views) ⇒ the fixed byte-stable constants. */
  sentAt?: number;
}

// Wrap the caller's data segments in a complete, byte-stable interchange: ISA/GS/ST/…/SE/GE/IEA.
export function buildInterchange(p: InterchangeParams): string {
  const control9 = isaControl9(p.isaControl);
  const stControl = p.gsControl.padStart(4, "0"); // ST02 min length is 4
  const stamps = p.sentAt === undefined
    ? { isaDate: ISA_DATE, isaTime: ISA_TIME, gsDate: GS_DATE, gsTime: GS_TIME }
    : envelopeStamps(p.sentAt);

  const isa = segment([
    "ISA", "00", pad("", 10), "00", pad("", 10), "ZZ", pad(SENDER, 15), "ZZ", pad(p.receiver, 15),
    stamps.isaDate, stamps.isaTime, "U", "00401", control9, "0", "P", SUB,
  ]);
  const gs = segment(["GS", p.gsCode, SENDER, p.receiver, stamps.gsDate, stamps.gsTime, p.gsControl, "X", "004010"]);
  const st = segment(["ST", p.docType, stControl]);
  const se = segment(["SE", String(p.data.length + 2), stControl]); // ST + data + SE
  const ge = segment(["GE", "1", p.gsControl]);
  const iea = segment(["IEA", "1", control9]);

  return [isa, gs, st, ...p.data, se, ge, iea].map((s) => s + SEG).join("");
}
