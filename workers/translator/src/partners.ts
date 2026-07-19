// WP-12 Task 9 · REQ-203 / REQ-204 — PARTNER CERTIFICATION + OUTBOUND INTERCHANGE CONTROL-NUMBER STATE.
//
// Two concerns, one integrations row (no new table — the ≤22-table budget is hard):
//   1. certifyPartner  — a partner's stored mapping is VALIDATED (a malformed mapping must never be certified;
//      it would fault every 214 the sweep serializes) and the row is marked cert_status='certified' with its
//      replay fixture ref. The Task-10 replay harness calls this after a partner's fixtures round-trip clean.
//   2. allocatePartnerControls — SHUDDL's OWN outbound interchange control numbers, per partner, monotonically
//      increasing and PERSISTED across sweeps. An outbound 214/990 from SHUDDL to a partner MUST carry SHUDDL's
//      own numbers — NOT an echo of the inbound 204's ISA13 (that is the partner's number for a DIFFERENT
//      interchange; echoing it is an X12 correctness bug). The counter lives in integrations.config under the
//      reserved `outbound` key, kept SEPARATE from the partner MAPPING (version/statusDialect/refQualifiers) so
//      resolveMapping's strict() schema never sees it and a certified partner's dialect survives allocation.
//
// The `integrations` table is NOT one of the append-only guarded tables (guarded = events/positions/money_lines
// only — see 0003_insert_guards.sql), so `UPDATE integrations SET config=?, cert_status=?` is legal here.
// PURE-of-LLM (this whole worker is deterministic, EDI-format only) — D1 only, no ledger/rater import.
import { DEFAULT_004010, resolveMapping, type PartnerMapping } from "@shuddl/edi";

// The reserved integrations.config key holding SHUDDL's outbound interchange counters. It is NOT a partner-
// mapping field, so it is STRIPPED before any resolveMapping call (certify + partnerMapping). Keep this in
// lock-step with the `$.outbound` JSON paths in the allocate UPDATE below.
const OUTBOUND_KEY = "outbound";

// X12 control-number widths (REQ-204): ISA13 is EXACTLY 9 digits (zero-padded). GS06 is 1–9 digits (no leading
// zeros — the envelope writer derives ST02 by padding this to its 4-char minimum). An allocated counter never
// realistically reaches 10 digits; if it ever did, the envelope writer already clamps ISA13 to its last 9.
const ISA13_WIDTH = 9;

/**
 * A partner control-state fault: certifying/allocating for a partner that has no `integrations` row in this
 * tenant. Mirrors TransportError's role — a caller (the best-effort 990 ack) can catch THIS specifically and
 * defer, without swallowing a genuine bug. The 214 sweep only ever calls allocate for a partner it has already
 * resolved + found certified, so it never sees this in the happy path (its per-shipment catch isolates it if so).
 */
export class PartnerControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnerControlError";
  }
}

// Parse a stored integrations.config into a plain object (defensive: unparseable/non-object → {}). Never throws.
function parseConfigLenient(config: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    return {};
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

// Return the MAPPING portion of a parsed config (everything EXCEPT the reserved outbound-counter key) so it can
// be fed to resolveMapping. A non-plain-object value is passed through UNCHANGED so resolveMapping REJECTS it
// (a malformed config must not be silently coerced to the default at certification time).
function stripOutbound(parsed: unknown): unknown {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const { [OUTBOUND_KEY]: _outbound, ...mapping } = parsed as Record<string, unknown>;
    return mapping;
  }
  return parsed;
}

/**
 * Resolve the partner's stored mapping (REQ-034), IGNORING the outbound-counter key. A malformed/strict-
 * violating mapping falls back to DEFAULT_004010 — the 214 sweep must NEVER fault a whole shipment on a bad
 * stored mapping (certification, below, is where a bad mapping is REJECTED before it can ever go live). This
 * REPLACES the sweep's former local `mappingFor`, centralizing config-shape knowledge here in partners.ts.
 */
export function partnerMapping(config: string): PartnerMapping {
  try {
    return resolveMapping(stripOutbound(parseConfigLenient(config)));
  } catch {
    return DEFAULT_004010;
  }
}

/**
 * Certify a partner: validate its stored mapping, then mark it certified with its replay fixture ref. Idempotent
 * (re-certifying re-runs the same UPDATE — a no-op-equivalent). THROWS (certification refused) when the config is
 * not valid JSON or its mapping is unusable (resolveMapping's strict() rejects an unknown field / non-string
 * dialect value) — a certification must never pass a mapping the sweep cannot serialize against.
 */
export async function certifyPartner(db: D1Database, partnerId: string, fixtureRef: string): Promise<void> {
  const row = await db
    .prepare("SELECT config FROM integrations WHERE kind = 'edi_partner' AND id = ? LIMIT 1")
    .bind(partnerId)
    .first<{ config: string }>();
  if (row === null) {
    throw new PartnerControlError(`CERTIFY_UNKNOWN_PARTNER: no edi_partner integration '${partnerId}' in this tenant`);
  }

  // Validate the MAPPING (outbound counter stripped so an already-allocated partner can be re-certified). A bad
  // JSON body or a strict-schema violation THROWS here → certification refused, cert_status untouched.
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config);
  } catch {
    throw new PartnerControlError(`CERTIFY_MALFORMED_CONFIG: integration '${partnerId}' config is not valid JSON`);
  }
  resolveMapping(stripOutbound(parsed)); // throws (ZodError) on an unusable mapping — do NOT catch

  await db
    .prepare("UPDATE integrations SET cert_status = 'certified', replay_fixture_ref = ? WHERE kind = 'edi_partner' AND id = ?")
    .bind(fixtureRef, partnerId)
    .run();
}

/**
 * Allocate the NEXT outbound interchange (ISA13) + group (GS06) control numbers for a partner, returning them
 * zero-padded to X12 widths (ISA13 = 9 digits; GS06 = the plain decimal, 1–9 digits). MONOTONIC + persisted:
 * the counter lives in integrations.config under `$.outbound`, and each call increments + stores it.
 *
 * NO-DOUBLE-ISSUE GUARD: the read-increment-write is ONE atomic SQLite UPDATE (json_set over the COALESCE'd
 * prior value), NOT a read-then-write across an await — so even if two callers raced (the cron sweep is
 * effectively serial, but this holds regardless), each UPDATE is serialized by SQLite and RETURNING reports the
 * POST-update counter, so no two callers can observe or persist the same number. json_set targets the ROOT
 * `$.outbound` key (whose parent `$` always exists), so it works on an empty `'{}'` config too. A burned-but-
 * unused number (allocate then the send fails) is acceptable — gaps are legal in X12; a REUSED number is not.
 *
 * Throws PartnerControlError if the partner has no integrations row in this tenant (nothing to increment).
 */
export async function allocatePartnerControls(db: D1Database, partnerId: string): Promise<{ isaControl: string; gsControl: string }> {
  const row = await db
    .prepare(
      "UPDATE integrations SET config = json_set(config, '$.outbound', json_object(" +
        "'isa', COALESCE(json_extract(config, '$.outbound.isa'), 0) + 1, " +
        "'gs',  COALESCE(json_extract(config, '$.outbound.gs'),  0) + 1)) " +
        "WHERE kind = 'edi_partner' AND id = ? " +
        "RETURNING json_extract(config, '$.outbound.isa') AS isa, json_extract(config, '$.outbound.gs') AS gs",
    )
    .bind(partnerId)
    .first<{ isa: number; gs: number }>();
  if (row === null) {
    throw new PartnerControlError(`ALLOCATE_UNKNOWN_PARTNER: no edi_partner integration '${partnerId}' in this tenant`);
  }
  return { isaControl: String(row.isa).padStart(ISA13_WIDTH, "0"), gsControl: String(row.gs) };
}
