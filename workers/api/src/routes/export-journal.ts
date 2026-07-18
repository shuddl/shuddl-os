import type { Hono } from "hono";
import { z } from "zod";
import { exportJournal } from "@shuddl/ledger/gl/export";
import { serializeJournalIIF } from "@shuddl/ledger/gl/iif";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// REQ-020 (WP-11 Task 2) — the QuickBooks JOURNAL EXPORT route. GET /v1/export/journal serves a balanced,
// double-entry journal for a time window as either a QuickBooks IIF artifact (format=iif, the default) or
// the raw JournalLine[] (format=json). It is a ONE-WAY journal artifact — NATIVE GL FORBIDDEN (no period
// close, no balances). exportJournal already asserts Σdebit === Σcredit; the IIF serializer re-asserts it.
//
// Tenant comes from the JWT claim ONLY (tenantDb, REQ-025) — never a header/query. roles admin/ops/finance
// (the tenant-lens/finance roles; a portal party or driver has no GL export). A ?tenant= hint is rejected at
// auth before this handler runs.

// A sane maximum window — a full fiscal year plus a leap day. A wider range is a 400 (never a runaway scan).
const MAX_RANGE_MS = 366 * 86_400_000;

// from/to are epoch-ms integers; z.coerce turns the query strings into numbers (a non-numeric string → NaN →
// fails .int()). division is the optional REQ-057 filter; format defaults to iif.
const ExportQuery = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().nonnegative(),
  division: z.string().min(1).max(64).optional(),
  format: z.enum(["iif", "json"]).default("iif"),
});

export function mountExportRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.get("/v1/export/journal", requireRole("admin", "ops", "finance"), async (c) => {
    const parsed = ExportQuery.safeParse({
      from: c.req.query("from"),
      to: c.req.query("to"),
      division: c.req.query("division"),
      format: c.req.query("format"),
    });
    if (!parsed.success) {
      throw new ApiError("VALIDATION_FAILED", 400, "from/to MUST BE integer ms; format MUST BE iif OR json");
    }
    const { from, to, division, format } = parsed.data;
    if (from >= to) throw new ApiError("VALIDATION_FAILED", 400, "from MUST BE < to");
    if (to - from > MAX_RANGE_MS) throw new ApiError("VALIDATION_FAILED", 400, "range EXCEEDS THE 366-DAY MAXIMUM");

    const db = tenantDb(c.env, c.get("session").tenant); // REQ-025 — tenant off the claim, never client input
    const lines = await exportJournal(db, { from, to }, division !== undefined ? { division } : undefined);

    if (format === "json") {
      return c.json(lines); // the raw balanced JournalLine[]
    }
    // IIF: stamp the entry date at the window end (the period's "as of" date), format deterministically.
    const iif = serializeJournalIIF(lines, { date: to });
    return c.body(iif, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="journal-${from}-${to}.iif"`,
    });
  });
}
