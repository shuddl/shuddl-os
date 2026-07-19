// Per-partner EDI mapping config layer (REQ-034/203). The Translator law is: partner format QUIRKS ARE DATA,
// not code. A partner's stored mapping overrides a frozen default, and a certified partner's outbound is only
// unblocked after its fixtures/edi replay round-trips clean (REQ-203). PURE (REQ-035): no I/O, no ledger/rater
// import — just schema-validated config resolution and lookups.
import { z } from "zod";
import { PartnerMapping, type TenderDoc } from "./types.js";

// The frozen 004010 baseline every partner inherits. statusDialect maps a canonical SHUDDL status to its AT7
// wire code; refQualifiers renames an X12 L11/B2 reference qualifier to a canonical ref name. A partner config
// overrides only the entries it names — everything else falls back here.
export const DEFAULT_004010: PartnerMapping = {
  version: "004010",
  statusDialect: {
    arrived: "X3",
    departed: "AF",
    delivered: "D1",
    pod: "D1",
  },
  refQualifiers: {
    BM: "bol", // Bill of Lading Number
    PO: "po", // Purchase Order Number
    CR: "customerRef", // Customer Reference Number
    SID: "shipmentId", // shipment identification number (from B2)
  },
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
    statusDialect: { ...DEFAULT_004010.statusDialect, ...(parsed.statusDialect ?? {}) },
    refQualifiers: { ...DEFAULT_004010.refQualifiers, ...(parsed.refQualifiers ?? {}) },
  };
}

// Apply a partner mapping to a parsed tender: rename each ref key via refQualifiers (unknown keys pass through
// unchanged — never dropped, Migrator rule). All other fields are carried through untouched.
export function applyMapping(tender: TenderDoc, m: PartnerMapping): TenderDoc {
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(tender.refs)) {
    refs[m.refQualifiers[key] ?? key] = value;
  }
  return { ...tender, refs };
}

// Resolve a canonical status code to the partner's dialect AT7 code; an unmapped code passes through unchanged.
export function dialectStatus(code: string, m: PartnerMapping): string {
  return m.statusDialect[code] ?? code;
}
