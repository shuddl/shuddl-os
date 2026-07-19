// Per-partner EDI mapping config layer (REQ-034/203). The Translator law is: partner format QUIRKS ARE DATA,
// not code. A partner's stored mapping overrides a frozen default, and a certified partner's outbound is only
// unblocked after its fixtures/edi replay round-trips clean (REQ-203). PURE (REQ-035): no I/O, no ledger/rater
// import — just schema-validated config resolution and lookups.
import { z } from "zod";
import { PartnerMapping, type TenderDoc } from "./types.js";

// The frozen 004010 baseline every partner inherits. statusDialect maps a canonical SHUDDL status to its AT7
// wire code; refQualifiers renames an X12 L11/B2 reference qualifier to a canonical ref name. A partner config
// overrides only the entries it names — everything else falls back here.
// Build a prototype-less string map so a lookup by a key equal to an Object.prototype member (`toString`,
// `constructor`, `__proto__`, …) can never return an inherited function/accessor instead of undefined.
function nullMap(entries: Record<string, string>): Record<string, string> {
  return Object.assign(Object.create(null), entries);
}

export const DEFAULT_004010: PartnerMapping = {
  version: "004010",
  statusDialect: nullMap({
    arrived: "X3",
    departed: "AF",
    delivered: "D1",
    pod: "D1",
  }),
  refQualifiers: nullMap({
    BM: "bol", // Bill of Lading Number
    PO: "po", // Purchase Order Number
    CR: "customerRef", // Customer Reference Number
    SID: "shipmentId", // shipment identification number (from B2)
  }),
};

// A partner config is a PARTIAL of PartnerMapping. `.strict()` — an unknown top-level field is a hard REJECT
// (a typo or a smuggled key never silently no-ops), which is exactly the replay-certification guarantee.
const PartnerMappingConfig = z
  .object({
    version: z.string().optional(),
    statusDialect: z.record(z.string(), z.string()).optional(),
    refQualifiers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

// Resolve an untrusted config into a complete PartnerMapping, merged OVER the default. An empty config yields
// exactly DEFAULT_004010; an unknown field throws (ZodError).
export function resolveMapping(config: unknown): PartnerMapping {
  const parsed = PartnerMappingConfig.parse(config);
  return {
    version: parsed.version ?? DEFAULT_004010.version,
    // Merge onto a null-proto base so the resolved maps stay prototype-safe (see nullMap).
    statusDialect: Object.assign(Object.create(null), DEFAULT_004010.statusDialect, parsed.statusDialect ?? {}),
    refQualifiers: Object.assign(Object.create(null), DEFAULT_004010.refQualifiers, parsed.refQualifiers ?? {}),
  };
}

// Apply a partner mapping to a parsed tender: rename each ref key via refQualifiers (unknown keys pass through
// unchanged — never dropped, Migrator rule). All other fields are carried through untouched.
export function applyMapping(tender: TenderDoc, m: PartnerMapping): TenderDoc {
  const refs: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(tender.refs)) {
    // Guard with Object.hasOwn: `m.refQualifiers[key] ?? key` would return an INHERITED Object.prototype
    // member (a function) when key is e.g. "toString", storing the ref under a coerced-garbage key.
    const mapped = Object.hasOwn(m.refQualifiers, key) ? m.refQualifiers[key] : undefined;
    refs[mapped ?? key] = value;
  }
  return { ...tender, refs };
}

// Resolve a canonical status code to the partner's dialect AT7 code; an unmapped code passes through unchanged.
// Object.hasOwn (not `?? code`) — a code like "__proto__"/"toString" must never resolve to an inherited member.
export function dialectStatus(code: string, m: PartnerMapping): string {
  if (Object.hasOwn(m.statusDialect, code)) {
    const mapped = m.statusDialect[code];
    if (mapped !== undefined) return mapped;
  }
  return code;
}
