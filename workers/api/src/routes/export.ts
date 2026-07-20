import type { Hono } from "hono";
import { z } from "zod";
import type { LedgerEvent } from "@shuddl/contracts";
import { lensFor, readEvents, type Lens, type ReadQuery } from "@shuddl/ledger/lens";
import { exportJournal, type JournalLine } from "@shuddl/ledger/gl/export";
import { serializeJournalIIF } from "@shuddl/ledger/gl/iif";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// REQ-010 (WP-11 Task 5) — the ONE-CLICK FULL TENANT EXPORT in OPEN formats. GET /v1/export lets a tenant
// ADMIN pull the tenant's whole record for portability/audit, assembled into a SINGLE open-format JSON archive:
//   · events   — the append-only ledger, read THROUGH the caller's lens (admin ⇒ tenant lens ⇒ unredacted),
//                cursor-PAGINATED (the dominant, unbounded stream; the caller walks events_next_cursor to
//                stream the entire ledger page by page — a big tenant is never loaded whole into memory).
//   · journal  — the GL JOURNAL for a [from,to] window (exportJournal → balanced JournalLine[]), PLUS the same
//                journal serialized as a QuickBooks IIF artifact (serializeJournalIIF). NATIVE GL FORBIDDEN.
//   · documents— the documents read-model rows as REFS (id, shipment, party, kind, r2_key, visibility, …). The
//                ledger carries the R2 ref, never the bytes — the bytes ride the WP-09 doc-cap resolver.
//   · anchors  — the daily MERKLE roots. Per anchor.ts an anchor is a `documents` row (id `anchor:<day>`,
//                kind `tsa_receipt`, hash = root); we read those roots so the export is independently verifiable.
//   · manifest — {tenant, generated_at, journal_range, counts, anchor_roots}. generated_at is a PARAM into the
//                pure assembler (assembleTenantExport), never a clock read inside it.
//
// It is a READ — no writes, no new table/kind, only the existing reads (readEvents / exportJournal / the
// documents + anchor documents rows). ADMIN only: a full-tenant export is privileged. Tenant comes from the
// JWT claim ONLY (tenantDb, REQ-025) — the export can NEVER include another tenant's data (a ?tenant= hint is
// rejected at auth; the cross-tenant proof lives in isolation.test.ts). Open formats only: JSON + the IIF.
//
// NOTE: `mountExportRoutes` is already the JOURNAL export in export-journal.ts (GET /v1/export/journal); this
// module exports `mountFullExportRoutes` (GET /v1/export) to avoid the name clash. Distinct paths, no route
// collision.

const DEFAULT_LIMIT = 200; // mirrors @shuddl/ledger/lens readEvents so events_next_cursor agrees with the page
const LIMIT_CAP = 1000;

// The full documents row for an admin export — the REF, never the bytes. r2_key IS included (an admin export is
// tenant-lens; the key lives in THIS tenant's `evidence/<tenant>/…` namespace and can only ever be resolved by
// a cap minted for this tenant — REQ-025). hash lets a recipient reconcile the ref to its stored artifact.
const DOC_EXPORT_COLS = "id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility";

const ANCHOR_ID_PREFIX = "anchor:";

export interface DocumentRef {
  id: string;
  shipment_id: string | null;
  party_id: string | null;
  kind: string;
  r2_key: string;
  hash: string;
  lifecycle_class: string;
  visibility: string;
}

export interface AnchorRef {
  day: string;
  root: string;
  receipt_key: string;
}

export interface TenantExportManifest {
  tenant: string;
  generated_at: number;
  journal_range: { from: number; to: number };
  counts: { events: number; journal_lines: number; documents: number; anchors: number };
  anchor_roots: Array<{ day: string; root: string }>;
}

export interface TenantExportArchive {
  manifest: TenantExportManifest;
  events: LedgerEvent[];
  events_next_cursor: string | null;
  journal: JournalLine[];
  journal_iif: string;
  documents: DocumentRef[];
  anchors: AnchorRef[];
}

export interface AssembleOptions {
  db: D1Database;
  lens: Lens;
  tenant: string;
  generatedAt: number; // a PARAM, never a clock read inside — keeps the assembler pure of the wall clock.
  journalRange: { from: number; to: number };
  cursor?: { stream_id: string; seq: number };
  limit?: number;
}

/**
 * Assemble the full-tenant archive. Pure of the wall clock (generatedAt is injected) and of the LLM; only D1
 * reads through the caller's lens + the tenant's own D1 (never a second tenant). The archive is ONE page of
 * the ledger (events_next_cursor drives the next page) plus the journal window, the document refs, and the
 * daily anchor roots. No writes.
 */
export async function assembleTenantExport(opts: AssembleOptions): Promise<TenantExportArchive> {
  const { db, lens, tenant, generatedAt, journalRange } = opts;
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, LIMIT_CAP);

  // EVENTS — the lens-scoped ledger page. admin ⇒ tenant lens ⇒ the unredacted stream. The composite
  // (stream_id, seq) keyset cursor pages across streams (the firehose contract), so it is bounded per page.
  const eventsQuery: ReadQuery = { limit };
  if (opts.cursor) eventsQuery.cursor = opts.cursor;
  const events = await readEvents(db, lens, eventsQuery);
  const last = events[events.length - 1];
  // A full page ⇒ more rows may follow (hand back a keyset cursor on the last row); a short page is the end.
  const events_next_cursor = last !== undefined && events.length >= limit ? `${last.stream_id}:${last.seq}` : null;

  // JOURNAL — the balanced double-entry lines for the window, PLUS the QuickBooks IIF (both open formats).
  // serializeJournalIIF re-asserts Σdebit === Σcredit and canonical-account-only (native GL forbidden).
  const journal = await exportJournal(db, journalRange);
  const journal_iif = serializeJournalIIF(journal, { date: journalRange.to });

  // DOCUMENTS — the read-model rows as REFS (bytes excluded by construction; only r2_key travels). Ordered by
  // id for a deterministic archive. (This includes the tsa_receipt anchor rows, which also surface distinctly
  // below as verifiable roots.)
  const docsRes = await db.prepare(`SELECT ${DOC_EXPORT_COLS} FROM documents ORDER BY id`).all<DocumentRef>();
  const documents = docsRes.results;

  // ANCHORS — the daily MERKLE roots. An anchor is a documents row id `anchor:<day>`, kind `tsa_receipt`,
  // hash = the day's Merkle root (anchor.ts). Extract them so the export is independently verifiable.
  const anchorRes = await db
    .prepare("SELECT id, hash, r2_key FROM documents WHERE kind = 'tsa_receipt' AND id LIKE 'anchor:%' ORDER BY id")
    .all<{ id: string; hash: string; r2_key: string }>();
  const anchors: AnchorRef[] = anchorRes.results.map((r) => ({ day: r.id.slice(ANCHOR_ID_PREFIX.length), root: r.hash, receipt_key: r.r2_key }));

  const manifest: TenantExportManifest = {
    tenant,
    generated_at: generatedAt,
    journal_range: journalRange,
    counts: { events: events.length, journal_lines: journal.length, documents: documents.length, anchors: anchors.length },
    anchor_roots: anchors.map((a) => ({ day: a.day, root: a.root })),
  };

  return { manifest, events, events_next_cursor, journal, journal_iif, documents, anchors };
}

// Query params (all optional). from/to bound the JOURNAL window (default: all history → generated_at). cursor +
// limit page the EVENTS stream. Every value is validated; unknown params are ignored (the ?tenant= hint is
// already rejected at auth). Built from named keys so `.strict()` never trips on unrelated query params.
const ExportQuery = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

// Composite keyset cursor `<stream_id>:<seq>`. stream_id itself contains a colon (`s:{id}`), so split on the
// LAST colon (mirrors events.ts) — a first-colon split would truncate the stream id and page the wrong stream.
function parseCursor(raw: string): { stream_id: string; seq: number } {
  const i = raw.lastIndexOf(":");
  if (i <= 0 || i === raw.length - 1) throw new ApiError("VALIDATION_FAILED", 400, "cursor MUST BE <stream_id>:<seq>");
  const seq = Number(raw.slice(i + 1));
  if (!Number.isInteger(seq) || seq < 0) throw new ApiError("VALIDATION_FAILED", 400, "cursor seq MUST BE A NON-NEGATIVE INTEGER");
  return { stream_id: raw.slice(0, i), seq };
}

export function mountFullExportRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/export — ADMIN only. A full-tenant export is privileged; requireRole runs before any read.
  app.get("/v1/export", requireRole("admin"), async (c) => {
    const parsed = ExportQuery.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
      from: c.req.query("from"),
      to: c.req.query("to"),
    });
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "cursor/limit/from/to ARE MALFORMED");
    const { cursor, limit, from, to } = parsed.data;

    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant); // REQ-025 — tenant off the claim, never client input
    const generatedAt = Date.now(); // read the clock HERE; the assembler stays pure (generatedAt is a param)

    // The journal window: default the WHOLE history (0 → generated_at). A full export wants every money_line;
    // an admin may narrow it with from/to. money_lines is bounded per tenant, so a full-history scan is fine.
    const journalRange = { from: from ?? 0, to: to ?? generatedAt };
    if (journalRange.from > journalRange.to) throw new ApiError("VALIDATION_FAILED", 400, "from MUST BE <= to");

    const options: AssembleOptions = { db, lens: lensFor(session), tenant: session.tenant, generatedAt, journalRange };
    if (cursor !== undefined) options.cursor = parseCursor(cursor);
    if (limit !== undefined) options.limit = limit;

    const archive = await assembleTenantExport(options);
    // A single open-format JSON document, with a download disposition naming the tenant + the generated_at.
    return c.body(JSON.stringify(archive), 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="tenant-export-${session.tenant}-${generatedAt}.json"`,
    });
  });
}
