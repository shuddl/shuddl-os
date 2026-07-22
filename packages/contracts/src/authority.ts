import { z } from "zod";
import { JsonObject } from "./json.js";

// WP-15 Task 1 (REQ-008/023, Ten Laws L8) — the TYPED payload for authority.flipped, the append-only,
// co-signed EVENT that records SHUDDL earning (or ceding) authority for ONE module. `authority_map`
// (db/tenant/migrations/0002_domain.sql:94-98) is its PROJECTION — the map is NEVER mutated without one
// of these events (L8: authority is earned module-by-module and the flip is a ledger event). The event is
// SELF-DESCRIBING: it carries BOTH `from` (authority BEFORE) and `to` (authority AFTER) so the permanent
// audit record stands alone — the projection APPLIES `to`; it never re-derives it from prior map state.
// NO kind is added — authority.flipped is the FROZEN #35 (events.ts pins .length === 35); this only shapes
// its previously-untyped JsonObject payload. Organized as its own domain module + imported by events.ts,
// mirroring money.ts / comms.ts / booking.ts.

// The five overlay modules — EXACT match to the authority_map.module CHECK IN ('rating','invoicing',
// 'dispatch','settlement','comms') (0002_domain.sql) so a flip keys the projection's UPSERT verbatim; a
// module outside this set is un-projectable and is rejected HERE at the record.
export const AuthorityModule = z.enum(["rating", "invoicing", "dispatch", "settlement", "comms"]);
export type AuthorityModule = z.infer<typeof AuthorityModule>;

// The authority state — EXACT match to authority_map.authority CHECK IN ('native','legacy'). `native` =
// SHUDDL runs the module; `legacy` = it defers to the incumbent system.
export const AuthorityLevel = z.enum(["native", "legacy"]);
export type AuthorityLevel = z.infer<typeof AuthorityLevel>;

// Why the flip happened. `promote` = a gated FORWARD flip (an earned legacy→native); `drift` = an auto
// FALLBACK the Watchtower forces (native→legacy on an anomaly); `manual` = an operator action.
export const AuthorityFlipReason = z.enum(["promote", "drift", "manual"]);
export type AuthorityFlipReason = z.infer<typeof AuthorityFlipReason>;

export const AuthorityFlippedPayload = z
  .object({
    module: AuthorityModule,
    from: AuthorityLevel, // authority BEFORE this flip — the self-describing audit record; the projection does NOT re-check it against current map state
    to: AuthorityLevel, //   authority AFTER — the projection applies EXACTLY this
    reason: AuthorityFlipReason,
    // OPTIONAL, OMITTED-WHEN-ABSENT: the canonicalizer drops `undefined` keys, so a flip without these two
    // fields hashes identically to one that never declared them (the frozen-byte law holds). A present
    // gate_snapshot rides into gates_status; an absent one leaves the map's existing gates_status untouched.
    gate_snapshot: JsonObject.optional(), // the gates state at flip time (integer-only via JsonValue)
    drift_ref: z.string().min(1).optional(), // the anomaly/event id that TRIGGERED a drift fallback (provenance)
  })
  .strict();
export type AuthorityFlippedPayload = z.infer<typeof AuthorityFlippedPayload>;
