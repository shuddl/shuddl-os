import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";
import { eventFixture } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";

// REQ-010 (WP-11 Task 5) — the ONE-CLICK FULL TENANT EXPORT in open formats. GET /v1/export (ADMIN only)
// assembles the tenant's whole record into a single open-format JSON archive: the append-only EVENTS
// (lens-scoped, admin = tenant lens, cursor-paginated), the GL JOURNAL (exportJournal + the QuickBooks IIF),
// the DOCUMENT refs (the documents read-model rows — refs, NOT bytes), and the MERKLE ANCHOR roots (the daily
// tsa_receipt roots that make the export verifiable), plus a manifest (tenant, generated_at, counts, roots).
//
// A READ — no writes, no new table/kind. Tenant off the JWT claim ONLY (tenantDb, REQ-025); the cross-tenant
// case lives in isolation.test.ts. These cases prove: admin-only role gating; the 4 parts + manifest assemble;
// the manifest counts agree with the included sets; the open-format shape (JSON body + IIF journal + download
// disposition); and cursor pagination over the ledger.

// A PRIVATE far-future window (year ~2032) NO sibling file seeds a money_line into, so the journal in this
// file's export contains EXACTLY the row seeded below — deterministic counts, no shared-D1 pollution.
const PW_TS = 1_960_000_000_000;
const A_ML_EVENT = crypto.randomUUID();
const A_PAGE2_EVENT = crypto.randomUUID(); // audit §181 — the SECOND in-window event, so pagination has two pages
const A_DOC_ID = `exp-doc-${crypto.randomUUID()}`;
const A_ANCHOR_DAY = "2032-02-03";
const A_ANCHOR_ROOT = "a".repeat(64);
const exHash = (): string => crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");

async function seedEvent(eventId: string, shipmentId: string): Promise<void> {
  const e = eventFixture("pod.signed", { id: eventId, stream_id: `s:${shipmentId}`, shipment_id: shipmentId, seq: 0, visibility: "internal", party_refs: [] });
  const row = eventToRow(e);
  row.hash = exHash();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT OR IGNORE INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((col) => row[col])).run();
}

async function seedMoneyLine(eventId: string, shipmentId: string, mlId: string, amount: number): Promise<void> {
  await seedEvent(eventId, shipmentId);
  await env.TENANT_A_DB
    .prepare("INSERT OR IGNORE INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, currency, party_id, division, gl_map, created_ts) VALUES (?,?,?,1,?,?,?,?,?,?,?,?)")
    .bind(mlId, shipmentId, eventId, "ar", "freight", amount, "USD", "party-shipper", "main", "4000-FREIGHT-AR", PW_TS)
    .run();
}

beforeAll(async () => {
  await ensureSchema(env);
  // (1) a money_line in the private window (its FK event too) — the journal control.
  await seedMoneyLine(A_ML_EVENT, "exp-shipment-a", "exp-ml-a", 123_456); // → 1234.56
  // (1b) audit §181 — a SECOND event in the private window, with NO money_line so the journal counts below
  // stay deterministic. Until this existed the window held exactly ONE event, so the keyset-pagination test
  // fetched an EMPTY page 2 and its "the keyset advanced" assertion — guarded by `if (p1.events[0] &&
  // p2.events[0])` — never ran even once.
  await seedEvent(A_PAGE2_EVENT, "exp-shipment-page2");
  // (2) a plain document ref (the bytes ride the WP-09 resolver; the export lists only the ref).
  await env.TENANT_A_DB
    .prepare("INSERT OR IGNORE INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility) VALUES (?,?,?,?,?,?,?,?)")
    .bind(A_DOC_ID, "exp-shipment-a", "party-shipper", "POD", `evidence/${TENANT_SLUG}/exp-shipment-a/pod.jpg`, exHash(), "default", "counterparty")
    .run();
  // (3) a MERKLE anchor — stored (per anchor.ts) as a tsa_receipt documents row id `anchor:<day>`, hash = root.
  await env.TENANT_A_DB
    .prepare("INSERT OR IGNORE INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility) VALUES (?,?,?,?,?,?,?,?)")
    .bind(`anchor:${A_ANCHOR_DAY}`, null, null, "tsa_receipt", `anchors/${TENANT_SLUG}/${A_ANCHOR_DAY}/tsr.der`, A_ANCHOR_ROOT, "default", "internal")
    .run();
});

const WINDOW = `from=${PW_TS - 1000}&to=${PW_TS + 1000}`;

async function getExport(tok: string, extra = ""): Promise<Response> {
  return SELF.fetch(`https://api.local/v1/export?${WINDOW}${extra}`, { headers: { Authorization: `Bearer ${tok}` } });
}

interface Archive {
  manifest: {
    tenant: string;
    generated_at: number;
    journal_range: { from: number; to: number };
    counts: { events: number; journal_lines: number; documents: number; anchors: number };
    anchor_roots: Array<{ day: string; root: string }>;
  };
  events: Array<{ stream_id: string; seq: number; kind: string }>;
  events_next_cursor: string | null;
  journal: Array<{ account: string; event_id: string }>;
  journal_iif: string;
  documents: Array<{ id: string; kind: string; r2_key: string; visibility: string; shipment_id: string | null }>;
  anchors: Array<{ day: string; root: string; receipt_key: string }>;
}

describe("REQ-010: GET /v1/export — admin-only full tenant export", () => {
  it("a non-admin tenant role (ops) is 403 — a full export is privileged", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    expect((await getExport(t)).status).toBe(403);
  });

  it("finance is 403 (even a finance principal has no full-tenant export)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "finance" });
    expect((await getExport(t)).status).toBe(403);
  });

  it("read is 403", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "read" });
    expect((await getExport(t)).status).toBe(403);
  });

  it("admin gets a 200 open-format JSON archive with a download disposition", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "admin" });
    const res = await getExport(t);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(TENANT_SLUG);
  });
});

describe("REQ-010: the archive bundles events + journal + documents + anchors, with a truthful manifest", () => {
  it("assembles the 4 parts and the manifest, all counts agreeing with the included sets", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "admin" });
    const res = await getExport(t);
    expect(res.status).toBe(200);
    const a = (await res.json()) as Archive;

    // manifest
    expect(a.manifest.tenant).toBe(TENANT_SLUG);
    expect(typeof a.manifest.generated_at).toBe("number");
    expect(a.manifest.journal_range).toEqual({ from: PW_TS - 1000, to: PW_TS + 1000 });

    // 4 parts present and correctly shaped
    expect(Array.isArray(a.events)).toBe(true);
    expect(Array.isArray(a.journal)).toBe(true);
    expect(Array.isArray(a.documents)).toBe(true);
    expect(Array.isArray(a.anchors)).toBe(true);

    // counts in the manifest match the bundled sets exactly (a truthful manifest)
    expect(a.manifest.counts.events).toBe(a.events.length);
    expect(a.manifest.counts.journal_lines).toBe(a.journal.length);
    expect(a.manifest.counts.documents).toBe(a.documents.length);
    expect(a.manifest.counts.anchors).toBe(a.anchors.length);

    // JOURNAL — the private window isolates our one money_line → exactly 2 balanced lines, citing its event.
    expect(a.journal.length).toBe(2);
    expect(a.journal.some((l) => l.event_id === A_ML_EVENT)).toBe(true);

    // DOCUMENTS — our seeded ref is present, as a REF (r2_key) with no bytes.
    const doc = a.documents.find((d) => d.id === A_DOC_ID);
    expect(doc).toBeDefined();
    expect(doc?.kind).toBe("POD");
    expect(doc?.r2_key).toContain(`evidence/${TENANT_SLUG}/`);

    // ANCHORS — the daily root is exported, and echoed in manifest.anchor_roots (the verifiable set).
    const anchor = a.anchors.find((x) => x.day === A_ANCHOR_DAY);
    expect(anchor?.root).toBe(A_ANCHOR_ROOT);
    expect(a.manifest.anchor_roots.some((r) => r.day === A_ANCHOR_DAY && r.root === A_ANCHOR_ROOT)).toBe(true);
  });

  it("the journal is ALSO serialized as an open-format QuickBooks IIF artifact", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "admin" });
    const a = (await (await getExport(t)).json()) as Archive;
    expect(typeof a.journal_iif).toBe("string");
    expect(a.journal_iif.startsWith("!TRNS")).toBe(true);
    expect(a.journal_iif).toContain("1234.56"); // our money_line's dollars.cents in the window
  });

  it("the ledger paginates via a keyset cursor (bounded — a big tenant streams page by page)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "admin" });
    const p1 = (await (await getExport(t, "&limit=1")).json()) as Archive;
    expect(p1.events.length).toBe(1);
    expect(typeof p1.events_next_cursor).toBe("string"); // a full page ⇒ more may follow
    const cursor = p1.events_next_cursor;
    if (cursor === null) throw new Error("expected a next_cursor on a full page");
    const p2 = (await (await getExport(t, `&limit=1&cursor=${encodeURIComponent(cursor)}`)).json()) as Archive;
    // page 2's first event is strictly after page 1's (the keyset advanced) — no overlap, no gap.
    const k = (e: { stream_id: string; seq: number }): string => `${e.stream_id}:${e.seq}`;
    // Pin page 2 before comparing (audit §181). p1.events[0] is guaranteed by the length check above, but
    // p2 was not: a cursor that returned an EMPTY page made the keyset-advance assertion below skip
    // silently, so broken pagination would read as green.
    expect(p2.events.length).toBe(1);
    if (p1.events[0] && p2.events[0]) expect(k(p2.events[0])).not.toBe(k(p1.events[0]));
  });

  // §1228 — THE OTHER HALF OF THE CURSOR CONTRACT, which nothing asserted. The test above pins only that a
  // FULL page hands back a cursor. Removing the length check entirely — so a cursor comes back even on the
  // final page — left BOTH route suites green (measured: 44/44 and 7/7), because deleting that check can only
  // turn nulls into strings and no test ever asserted a null. Without this, a client walking
  // `events_next_cursor` never learns from the cursor that it is done: it makes one extra round trip that
  // returns nothing, and the documented contract ("a short page is the end") is unenforced.
  it("a SHORT page ends the walk — events_next_cursor is null (REQ-010 termination)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "admin" });
    const LIMIT = 500; // under LIMIT_CAP (1000), far above anything the shared test D1 holds
    const a = (await (await getExport(t, `&limit=${LIMIT}`)).json()) as Archive;
    // PREMISE, asserted rather than assumed: this really is a short page. The tenant D1 is SHARED across test
    // files, so the count is not fixed here — if it ever reached LIMIT this test would silently be exercising
    // the full-page branch instead, and pass for the wrong reason.
    expect(a.events.length, `the export returned a FULL page at limit=${LIMIT}; raise LIMIT or this case is vacuous`).toBeLessThan(LIMIT);
    // Both directions in one unconditional property: null iff the page was short.
    expect(
      a.events_next_cursor === null,
      "a short page must end the walk with a null cursor; a non-null cursor here sends the client back for a page that does not exist",
    ).toBe(true);
  });
});
