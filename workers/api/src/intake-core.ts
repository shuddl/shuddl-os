import { normalizePartyEmail, partyIdForEmail } from "@shuddl/contracts";

// WP-10 Task 6 (REQ-150/195/025/030) + WP-14 Task 5 (REQ-127) — THE ONE implementation of net-new party/shipment
// materialization. Extracted from routes/intake.ts so BOTH the CSR intake verbs (POST /v1/parties + /v1/shipments)
// AND the Migrator import (routes/import.ts, which LOOPS these verbs) run byte-identical logic — no reimplement,
// no drift (the tariff-seed.ts precedent). The functions are DETERMINISTIC + IDEMPOTENT: a party's id derives from
// its email/name (the shared @shuddl/contracts matcher, REQ-196), so a re-create collapses to one row under INSERT
// OR IGNORE; a shipment's id is supplied by the caller (the CSR derives it from the Idempotency-Key; the Migrator
// derives it from the ROW CONTENT so a re-import makes no dupes). NO new table/kind — parties/shipments are MUTABLE
// domain tables (the append-only ledger is untouched here).

// The 7 party kinds — byte-identical to the parties.kind CHECK in 0002_domain.sql.
export const PARTY_KINDS = ["shipper", "consignee", "carrier", "broker", "cartage", "factor", "insurer"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];
// The 6 shipment modes — byte-identical to the shipments.mode CHECK in 0002_domain.sql.
export const SHIPMENT_MODES = ["LTL", "TL", "brokered", "cartage", "dray", "transload"] as const;
export type ShipmentMode = (typeof SHIPMENT_MODES)[number];

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FindOrCreatePartyInput {
  kind: PartyKind;
  name: string;
  email?: string;
  /** Retained-but-unmapped party values (REQ-035 nothing lost). Written on CREATE only (a found party is not mutated). */
  externalRefs?: Record<string, string>;
}

/**
 * Find-or-create a party DETERMINISTICALLY (no LLM). The match key is a normalized email when present, else the
 * normalized legal name — the email path CONVERGES with the Concierge/Translator via the shared @shuddl/contracts
 * matcher (REQ-196), so the same customer never splits into two rows. On create the id is derived from the same
 * key so two concurrent creates collapse under INSERT OR IGNORE. The stored email keeps its original case for
 * deliverability; only the match key + derived id are normalized. `externalRefs` ride parties.external_refs on
 * create (never lost). Returns the party id + whether it was newly created.
 */
export async function findOrCreateParty(db: D1Database, input: FindOrCreatePartyInput): Promise<{ id: string; created: boolean }> {
  const contactEmail = input.email?.trim();
  const normEmail = contactEmail !== undefined && contactEmail !== "" ? normalizePartyEmail(contactEmail) : undefined;
  const normName = input.name.trim().toLowerCase();

  let existingId: string | null = null;
  if (normEmail !== undefined) {
    const row = await db
      .prepare("SELECT p.id AS id FROM parties p, json_each(p.contacts) je WHERE lower(json_extract(je.value, '$.email')) = ?1 LIMIT 1")
      .bind(normEmail)
      .first<{ id: string }>();
    existingId = row?.id ?? null;
  } else {
    const row = await db
      .prepare("SELECT id FROM parties WHERE lower(json_extract(names, '$.legal')) = ?1 LIMIT 1")
      .bind(normName)
      .first<{ id: string }>();
    existingId = row?.id ?? null;
  }
  if (existingId !== null) return { id: existingId, created: false };

  const id =
    contactEmail !== undefined && contactEmail !== ""
      ? await partyIdForEmail(contactEmail)
      : `party_${(await sha256Hex(`intake:party:name:${normName}`)).slice(0, 16)}`;
  const names = JSON.stringify({ legal: input.name });
  const contacts = JSON.stringify(contactEmail !== undefined && contactEmail !== "" ? [{ kind: "primary", email: contactEmail }] : []);
  const externalRefs = JSON.stringify(input.externalRefs ?? {});
  await db
    .prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts, external_refs) VALUES (?,?,?,?,?)")
    .bind(id, input.kind, names, contacts, externalRefs)
    .run();
  return { id, created: true };
}

export interface MaterializeShipmentInput {
  /** The caller-supplied deterministic id (CSR: from the Idempotency-Key; Migrator: from the row content hash). */
  id: string;
  shipperPartyId: string;
  consigneePartyId: string;
  billToPartyId: string;
  mode?: ShipmentMode;
  division?: string;
  refs?: Record<string, string>;
}

/**
 * Materialize a QUOTE-STAGE shipments row (NO booking.created, status_cache at its empty default) with the three
 * party FKs — so the first REAL booking is still the first on the stream and the WP-09 gate stays green. The three
 * FKs MUST exist in THIS tenant's parties (no DB-level FK); a missing one is returned in `missingFks` so the caller
 * fails fast (a 400) rather than leaving an orphan. INSERT OR IGNORE on the supplied id ⇒ a retry/re-import is a
 * no-op (no duplicate).
 */
export async function materializeShipment(db: D1Database, input: MaterializeShipmentInput): Promise<{ created: boolean; missingFks: string[] }> {
  const fkIds = [...new Set([input.shipperPartyId, input.consigneePartyId, input.billToPartyId])];
  const found = await db
    .prepare(`SELECT id FROM parties WHERE id IN (${fkIds.map(() => "?").join(",")})`)
    .bind(...fkIds)
    .all<{ id: string }>();
  const present = new Set(found.results.map((r) => r.id));
  const missingFks = fkIds.filter((fk) => !present.has(fk));
  if (missingFks.length > 0) return { created: false, missingFks };

  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, mode, division, refs, created_ts) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(
      input.id,
      input.shipperPartyId,
      input.consigneePartyId,
      input.billToPartyId,
      input.mode ?? "LTL",
      input.division ?? "main",
      JSON.stringify(input.refs ?? {}),
      Date.now(),
    )
    .run();
  return { created: (res.meta.changes ?? 0) > 0, missingFks: [] };
}
