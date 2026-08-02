// The Zod boundary schemas for @shuddl/edi. This package is a PURE X12 format adapter (REQ-035): it never
// imports @shuddl/ledger, @shuddl/rater, or any worker/DO code, does no I/O, and holds no pricing/ledger
// logic. Every value that crosses the parse/serialize boundary is validated here with `.strict()` so an
// unknown field is a hard reject, never a silent pass-through (mirrors packages/contracts style).
//
// zod is a real dependency of THIS package (declared in package.json) — @shuddl/edi is a standalone adapter
// and does not route through @shuddl/contracts, so it takes zod directly and pins the same version.
import { z } from "zod";

// A postal address as it appears in a 204 N1/N3/N4 loop. Every field optional: the 204 is a partner document
// and any field may be absent. Absent stays absent — the Migrator rule (CLAUDE.md #10) forbids fabricating a
// value that the wire did not carry.
export const EdiAddress = z
  .object({
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
  })
  .strict();
export type EdiAddress = z.infer<typeof EdiAddress>;

// An appointment window carried by a 204 G62 date/time segment. start/end optional — a tender may pin only a
// pickup-by or only a deliver-by.
export const ApptWindow = z
  .object({ start: z.string().optional(), end: z.string().optional() })
  .strict();
export type ApptWindow = z.infer<typeof ApptWindow>;

// One physical stop of a tender: shipper (SH) or consignee (CN). name is required (an N1 loop always carries a
// party name in N102); address/appt may be partial.
export const TenderStop = z
  .object({
    role: z.enum(["SH", "CN"]),
    name: z.string(),
    address: EdiAddress,
    apptWindow: ApptWindow.optional(),
  })
  .strict();
export type TenderStop = z.infer<typeof TenderStop>;

// The bill-to party (204 N1*BT loop). email is optional — the 204 rarely carries one, but when a PER
// contact-email is present it is preserved (never dropped — Migrator rule).
export const TenderBillTo = z
  .object({
    name: z.string(),
    email: z.string().optional(),
    address: EdiAddress.optional(),
  })
  .strict();
export type TenderBillTo = z.infer<typeof TenderBillTo>;

// Freight dimensions in inches + the handling-unit (piece) count. All optional: "no price on air" (CLAUDE.md
// #4) — a missing dim stays UNKNOWN here and the downstream rater refuses to sell, so this adapter must NOT
// default a zero. parse-204 populates l/w/h from an L4 measurement ONLY when its unit qualifier is inches (IN)
// and each value is a positive integer, and `pieces` from the AT8 lading quantity (AT804) — a CM/FT/zero L4 or
// a blank AT804 leaves the field UNDEFINED (never a fabricated dimension in an unknown unit).
export const TenderDims = z
  .object({
    lengthIn: z.number().optional(),
    widthIn: z.number().optional(),
    heightIn: z.number().optional(),
    pieces: z.number().optional(),
  })
  .strict();
export type TenderDims = z.infer<typeof TenderDims>;

// The SCAC charset guard (F-4, defense-in-depth). A SCAC crosses VERBATIM into X12 envelopes (B202 inbound; the
// ISA/GS receiver + B1/LX segments outbound), so a value bearing an X12 delimiter — `*` (element sep), `~`
// (segment terminator), `>` (sub-element sep), or a newline/control char — could inject a segment/element or
// corrupt outbound byte-stability. Constrain it to alphanumerics ONLY, on every SCAC-bearing schema. Real SCACs
// are 2–4 alpha; `{2,15}` is generous (a longer/odd value fails .parse() → the worker quarantines it, fail-closed).
// The `^…$` anchors + the `[A-Za-z0-9]` class exclude every delimiter, whitespace, and newline (JS `$` without
// the `m` flag does NOT match before a trailing "\n", so a "MEGA\n" is correctly rejected).
const PartnerScac = z.string().regex(/^[A-Za-z0-9]{2,15}$/, "SCAC must be 2–15 alphanumerics (no X12 delimiters/whitespace)");

// TenderDoc — the normalized, engine-agnostic view of a parsed X12 204 load tender. weightLb/dims are
// optional and left `undefined` when the wire omitted them (never fabricated).
export const TenderDoc = z
  .object({
    partnerScac: PartnerScac,
    purpose: z.enum(["00", "01"]),
    refs: z.record(z.string(), z.string()),
    stops: z.array(TenderStop),
    billTo: TenderBillTo.optional(),
    // Positive-only: a zero/negative weight is a bogus sell input; the boundary rejects it rather than pass
    // it to the rater (defense in depth behind parse-204's AT803 guard).
    weightLb: z.number().positive().optional(),
    dims: TenderDims.optional(),
  })
  .strict();
export type TenderDoc = z.infer<typeof TenderDoc>;

// One status event to serialize into a 214 (LX + AT7 + MS1). statusCode is ALREADY the AT7 wire code — the
// caller maps SHUDDL status → AT7 before calling build214; this package only serializes.
export const StatusStop = z
  .object({
    statusCode: z.string(),
    reasonCode: z.string().optional(),
    ts: z.string(),
    city: z.string().optional(),
    state: z.string().optional(),
  })
  .strict();
export type StatusStop = z.infer<typeof StatusStop>;

// StatusView — the deterministic input to build214. isaControl/gsControl are passed in (not generated) so the
// serializer is byte-stable: identical input → identical bytes (no Date.now, no counters).
export const StatusView = z
  .object({
    shipmentRef: z.string(),
    partnerScac: PartnerScac,
    isaControl: z.string(),
    gsControl: z.string(),
    stops: z.array(StatusStop),
    sentAt: z.number().int().positive().optional(), // real send instant (epoch ms) — stamped by the sweep at send
  })
  .strict();
export type StatusView = z.infer<typeof StatusView>;

// TenderResponse — the deterministic input to build990 (the 990 answer to a 204 load tender). action is the
// B1 reservation action code: "A" accept / "D" decline. Control numbers are passed in for byte-stability.
export const TenderResponse = z
  .object({
    shipmentRef: z.string(),
    partnerScac: PartnerScac,
    isaControl: z.string(),
    gsControl: z.string(),
    action: z.enum(["A", "D"]),
    sentAt: z.number().int().positive().optional(), // real send instant (epoch ms) — stamped at send
  })
  .strict();
export type TenderResponse = z.infer<typeof TenderResponse>;

// PartnerMapping — the per-partner format quirks as DATA, not code (REQ-034/203). statusDialect overrides the
// canonical status→AT7 code per partner; refQualifiers renames an L11 qualifier to a canonical ref name. A
// certified partner's mapping is stored config; this schema pins its shape.
export const PartnerMapping = z
  .object({
    version: z.string(),
    statusDialect: z.record(z.string(), z.string()),
    refQualifiers: z.record(z.string(), z.string()),
  })
  .strict();
export type PartnerMapping = z.infer<typeof PartnerMapping>;
