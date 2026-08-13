import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { ensureSchema, TENANT_SLUG, token } from "./helpers.js";
import {
  GL_AR_CONTROL,
  GL_AP_CONTROL,
  GL_FREIGHT_AR,
  GL_INTERLINE_AP,
} from "@shuddl/contracts";

// ─── REQ-020 (WP-11 Task 2) — THE QUICKBOOKS JOURNAL EXPORT ROUTE ────────────────────────────────────
//
// GET /v1/export/journal?from=<ts>&to=<ts>&division=<opt>&format=<iif|json> (roles admin/ops/finance,
// tenant-lens). exportJournal(tenantDb(session.tenant), {from,to}, division?) → serialize (IIF via
// serializeJournalIIF, or JSON JournalLine[]). Tenant from the JWT claim ONLY (tenantDb, REQ-025).
//
// isolatedStorage is OFF (all api test files share ONE D1) — every id here is prefixed `exj-` and unique,
// and every seeded created_ts sits in a private window so a sibling file's money_lines can't perturb it.

const TENANT = TENANT_SLUG;
// A PRIVATE far-future created_ts window (year ~2030). The shared D1 is polluted by sibling files (e.g.
// kpis.test.ts seeds a money_line with created_ts=0 and a NON-canonical gl_map "4000-REV"); this window
// contains ONLY this file's canonical rows, so the export never scans another file's arbitrary data.
const T0 = 1_900_000_000_000;
const FROM = T0;
const TO = T0 + 30 * 86_400_000; // a 30-day window
const OUT_OF_RANGE = T0 + 400 * 86_400_000; // past TO — must be excluded

const opsTok = (): Promise<string> => token({ sub: "exj-ops", tenant: TENANT, role: "ops" });
const financeTok = (): Promise<string> => token({ sub: "exj-fin", tenant: TENANT, role: "finance" });
const driverTok = (): Promise<string> => token({ sub: "exj-drv", tenant: TENANT, role: "driver" });
const portalTok = (): Promise<string> => token({ sub: "exj-por", tenant: TENANT, role: "portal", party_id: "exj-party" });

// A globally-unique 64-hex hash derived from a random UUID (NOT a shared counter — sibling files like
// exceptions.test.ts also seed events into this shared D1, and a counter base collides, silently dropping
// the event under INSERT OR IGNORE and cascading to a money_lines FK failure).
const nextHash = (): string => crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");

// event ids MUST be valid UUIDs (LedgerEvent.parse). Generate once so the money_line FK matches.
const EVT_1 = crypto.randomUUID();
const EVT_2 = crypto.randomUUID();
const EVT_3 = crypto.randomUUID();

async function insertEvent(db: D1Database, id: string, shipmentId: string): Promise<void> {
  const e = eventFixture("pod.signed", {
    id,
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq: 0,
    visibility: "internal",
    party_refs: [],
  });
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await db
    .prepare(`INSERT OR IGNORE INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

interface MoneyLineSeed {
  id: string;
  shipment_id: string;
  event_id: string;
  direction: "ar" | "ap";
  kind: string;
  amount_cents: number;
  division: string;
  gl_map: string;
  created_ts: number;
  line_no?: number; // §1262 — settable so the third ORDER BY component can be exercised (default 1)
}
async function insertMoneyLine(db: D1Database, ml: MoneyLineSeed): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, currency, party_id, division, gl_map, created_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(ml.id, ml.shipment_id, ml.event_id, ml.line_no ?? 1, ml.direction, ml.kind, ml.amount_cents, "USD", "exj-party", ml.division, ml.gl_map, ml.created_ts)
    .run();
}

interface JournalLine {
  account: string;
  debit_cents: number;
  credit_cents: number;
  division: string;
  event_id: string;
  money_line_id: string;
  kind: string;
}
async function fetchExport(tok: string, query: string): Promise<{ status: number; ct: string | null; body: string }> {
  const res = await SELF.fetch(`https://api.local/v1/export/journal${query}`, { headers: { Authorization: `Bearer ${tok}` } });
  return { status: res.status, ct: res.headers.get("content-type"), body: await res.text() };
}
function amountsOf(iif: string): number[] {
  return iif
    .split("\r\n")
    .filter((l) => l.startsWith("TRNS\t") || l.startsWith("SPL\t"))
    .map((l) => {
      const a = l.split("\t")[4]!;
      const neg = a.startsWith("-");
      const [w, f] = (neg ? a.slice(1) : a).split(".");
      const cents = Number(w) * 100 + Number(f);
      return neg ? -cents : cents;
    });
}

beforeAll(async () => {
  await ensureSchema(env);

  // IN-RANGE: one AR freight money_line (→ 1200-AR debit / 4000-FREIGHT-AR credit, 306030) in division west.
  await insertEvent(env.TENANT_A_DB, EVT_1, "exj-shp-1");
  await insertMoneyLine(env.TENANT_A_DB, {
    id: "exj-ml-1", shipment_id: "exj-shp-1", event_id: EVT_1,
    direction: "ar", kind: "freight", amount_cents: 306030, division: "west", gl_map: GL_FREIGHT_AR, created_ts: T0 + 1000,
  });
  // IN-RANGE: one AP interline money_line (→ 5000-INTERLINE-AP debit / 2000-AP credit, 4500) in division east.
  await insertEvent(env.TENANT_A_DB, EVT_2, "exj-shp-2");
  await insertMoneyLine(env.TENANT_A_DB, {
    id: "exj-ml-2", shipment_id: "exj-shp-2", event_id: EVT_2,
    direction: "ap", kind: "interline_split", amount_cents: 4500, division: "east", gl_map: GL_INTERLINE_AP, created_ts: T0 + 2000,
  });
  // OUT-OF-RANGE: a distinctive amount (999999 → 9999.99) past TO — the range filter must exclude it.
  await insertEvent(env.TENANT_A_DB, EVT_3, "exj-shp-3");
  await insertMoneyLine(env.TENANT_A_DB, {
    id: "exj-ml-3", shipment_id: "exj-shp-3", event_id: EVT_3,
    direction: "ar", kind: "freight", amount_cents: 999999, division: "west", gl_map: GL_FREIGHT_AR, created_ts: OUT_OF_RANGE,
  });
});

describe("GET /v1/export/journal — IIF (format=iif / default)", () => {
  it("ops gets a text/plain IIF journal with the !TRNS header + the in-range lines", async () => {
    const r = await fetchExport(await opsTok(), `?from=${FROM}&to=${TO}`); // default format
    expect(r.status).toBe(200);
    expect(r.ct).toContain("text/plain");
    expect(r.body).toContain("!TRNS\tTRNSTYPE\tDATE\tACCOUNT\tAMOUNT\tDOCNUM\tMEMO\tCLASS");
    expect(r.body).toContain(`\t${GL_AR_CONTROL}\t3060.30\t`); // AR control debit
    expect(r.body).toContain(`\t${GL_FREIGHT_AR}\t-3060.30\t`); // revenue credit
    expect(r.body).toContain(`\t${GL_INTERLINE_AP}\t45.00\t`); // interline debit
    expect(r.body).toContain(`\t${GL_AP_CONTROL}\t-45.00\t`); // AP control credit
  });

  it("the out-of-range money_line is excluded (range filter)", async () => {
    const r = await fetchExport(await opsTok(), `?from=${FROM}&to=${TO}&format=iif`);
    expect(r.body).not.toContain("9999.99");
  });

  it("the IIF transaction balances to the penny (Σ amounts === 0)", async () => {
    const r = await fetchExport(await opsTok(), `?from=${FROM}&to=${TO}&format=iif`);
    expect(amountsOf(r.body).reduce((s, a) => s + a, 0)).toBe(0);
  });

  it("is deterministic: the same range serializes byte-identically", async () => {
    const a = await fetchExport(await opsTok(), `?from=${FROM}&to=${TO}&format=iif`);
    const b = await fetchExport(await opsTok(), `?from=${FROM}&to=${TO}&format=iif`);
    expect(a.body).toBe(b.body);
  });

  it("a division filter partitions the journal (REQ-057): west excludes the east interline lines", async () => {
    const r = await fetchExport(await opsTok(), `?from=${FROM}&to=${TO}&format=iif&division=west`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(`\t${GL_FREIGHT_AR}\t-3060.30\t`);
    expect(r.body).not.toContain(GL_INTERLINE_AP); // east lines are gone
    expect(amountsOf(r.body).reduce((s, a) => s + a, 0)).toBe(0); // still balanced
  });
});

describe("GET /v1/export/journal — JSON (format=json)", () => {
  it("ops gets an application/json JournalLine[] for the in-range window", async () => {
    const r = await fetchExport(await opsTok(), `?from=${FROM}&to=${TO}&format=json`);
    expect(r.status).toBe(200);
    expect(r.ct).toContain("application/json");
    const lines = JSON.parse(r.body) as JournalLine[];
    const debits = lines.reduce((s, l) => s + l.debit_cents, 0);
    const credits = lines.reduce((s, l) => s + l.credit_cents, 0);
    expect(debits).toBe(credits); // balanced double entry
    const arControl = lines.find((l) => l.account === GL_AR_CONTROL && l.debit_cents === 306030);
    expect(arControl).toBeDefined();
    expect(lines.some((l) => l.debit_cents === 999999 || l.credit_cents === 999999)).toBe(false); // out-of-range excluded
  });
});

describe("GET /v1/export/journal — validation (400)", () => {
  it("missing from → 400", async () => {
    expect((await fetchExport(await opsTok(), `?to=${TO}`)).status).toBe(400);
  });
  it("missing to → 400", async () => {
    expect((await fetchExport(await opsTok(), `?from=${FROM}`)).status).toBe(400);
  });
  it("from >= to → 400", async () => {
    expect((await fetchExport(await opsTok(), `?from=${TO}&to=${FROM}`)).status).toBe(400);
  });
  it("a range beyond the sane maximum → 400", async () => {
    expect((await fetchExport(await opsTok(), `?from=0&to=${400 * 86_400_000}`)).status).toBe(400);
  });
  it("a non-integer from → 400", async () => {
    expect((await fetchExport(await opsTok(), `?from=abc&to=${TO}`)).status).toBe(400);
  });
  it("an unknown format → 400", async () => {
    expect((await fetchExport(await opsTok(), `?from=${FROM}&to=${TO}&format=xml`)).status).toBe(400);
  });
});

describe("GET /v1/export/journal — role gating (admin/ops/finance only)", () => {
  it("finance is permitted (200)", async () => {
    expect((await fetchExport(await financeTok(), `?from=${FROM}&to=${TO}`)).status).toBe(200);
  });
  it("a driver is forbidden (403)", async () => {
    expect((await fetchExport(await driverTok(), `?from=${FROM}&to=${TO}`)).status).toBe(403);
  });
  it("a portal party is forbidden (403)", async () => {
    expect((await fetchExport(await portalTok(), `?from=${FROM}&to=${TO}`)).status).toBe(403);
  });
});

// ─── §1262 — THE JOURNAL'S LINE ORDER (REQ-057/118) ────────────────────────────────────────────────────────
//
// `exportJournal` orders by `created_ts, event_id, line_no`. Every fixture above varies created_ts ALONE, so
// the first clause satisfies them all and the other two are exercised by nothing. Measured: reversing the whole
// clause to `line_no, event_id, created_ts` left export-journal + export at **23/23 GREEN**.
//
// The suite's "is deterministic: the same range serializes byte-identically" case cannot see this. It issues
// the same query twice against the same rows in one process, which SQLite answers identically whether or not
// an ORDER BY is present — it distinguishes a stable engine from an unstable one, never an ORDERED query from
// an incidentally-stable one. Determinism ACROSS runs, schema changes and index choices is what the clause
// buys, and only a fixture that ties can show it.
//
// Ordering matters here beyond aesthetics: this is the accountant-facing journal (CLAUDE.md fixture rule — the
// QB export reconciles to the penny). Lines that reshuffle between exports of the SAME period turn a diff of
// two closes into noise, which is how a real discrepancy gets skipped.
describe("§1262 the journal's ORDER BY is exercised on all three components", () => {
  // A private created_ts window, well past TO and short of OUT_OF_RANGE, so these rows perturb no assertion
  // above and none of theirs perturb these.
  const TIE_T = T0 + 200 * 86_400_000;
  const W_FROM = TIE_T - 5_000;
  const W_TO = TIE_T + 5_000;
  // event_id is the SECOND clause, so the test must know which id sorts first — and ids are UUIDs (the schema
  // requires it), so they are sorted here rather than assumed.
  // Indexed with `!` rather than destructured: under `noUncheckedIndexedAccess` a destructure of a sorted
  // array is `string | undefined`, and the ordering premise is asserted at runtime below anyway.
  const SORTED_EVT = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
  const EVT_LO = SORTED_EVT[0]!;
  const EVT_MID = SORTED_EVT[1]!;
  const EVT_HI = SORTED_EVT[2]!;

  // Expected order E = [m0, m3, m2, m1]:
  //   m0  created_ts EARLIER            → first, by clause 1 (its event_id is the LAST — so dropping clause 1
  //                                       cannot leave it in front by accident)
  //   m3  TIE_T, EVT_LO, line_no 0      → clause 2 puts the LO group next, clause 3 orders within it
  //   m2  TIE_T, EVT_LO, line_no 1
  //   m1  TIE_T, EVT_MID, line_no 0
  //
  // INSERTION ORDER P = [m1, m2, m0, m3] is chosen, not stumbled on (§1260). The query is ASC, so SQLite scans
  // FORWARD and an incidental within-tie order is insertion order. P therefore satisfies:
  //   E ≠ P and E ≠ reverse(P)                        → no whole-scan can imitate the clause
  //   m2 inserted BEFORE m3                           → dropping `line_no` alone reorders the LO group
  //   m1 inserted BEFORE m3                           → dropping `event_id` alone reorders the TIE_T group
  beforeAll(async () => {
    // Each event is inserted EXACTLY once — a repeat trips the I3 append-only BEFORE INSERT guard, which is
    // the guard doing its job. m2 and m3 therefore share one event and one shipment, which is the realistic
    // shape anyway: two money_lines off a single money event is precisely what `line_no` exists to order.
    await insertEvent(env.TENANT_A_DB, EVT_LO, "exj-tie-lo");
    await insertEvent(env.TENANT_A_DB, EVT_MID, "exj-tie-mid");
    await insertEvent(env.TENANT_A_DB, EVT_HI, "exj-tie-hi");
    const mk = async (id: string, event_id: string, shipment_id: string, created_ts: number, line_no: number) =>
      insertMoneyLine(env.TENANT_A_DB, {
        id, shipment_id, event_id, direction: "ar", kind: "freight",
        amount_cents: 1000, division: "west", gl_map: GL_FREIGHT_AR, created_ts, line_no,
      });
    await mk("exj-tie-m1", EVT_MID, "exj-tie-mid", TIE_T, 0);
    await mk("exj-tie-m2", EVT_LO, "exj-tie-lo", TIE_T, 1);
    await mk("exj-tie-m0", EVT_HI, "exj-tie-hi", TIE_T - 500, 9);
    await mk("exj-tie-m3", EVT_LO, "exj-tie-lo", TIE_T, 0);
  });

  it("orders by created_ts, then event_id, then line_no — each clause load-bearing", async () => {
    const r = await fetchExport(await opsTok(), `?from=${W_FROM}&to=${W_TO}&format=json`);
    expect(r.status).toBe(200);
    const lines = JSON.parse(r.body) as JournalLine[];
    // Two journal lines per money_line (debit then credit); collapse to the money_line sequence.
    const seq = lines.map((l) => l.money_line_id).filter((id, i, a) => id !== a[i - 1]);
    // PREMISES: the window really holds exactly these four, and the tie really is a tie — without both, the
    // assertion below could pass over a corpus that never exercises a tiebreak.
    expect(new Set(seq), "the private window must hold exactly the four seeded lines").toEqual(
      new Set(["exj-tie-m0", "exj-tie-m1", "exj-tie-m2", "exj-tie-m3"]),
    );
    expect(EVT_LO < EVT_MID && EVT_MID < EVT_HI, "the sorted ids must actually be ordered").toBe(true);
    expect(seq).toEqual(["exj-tie-m0", "exj-tie-m3", "exj-tie-m2", "exj-tie-m1"]);
  });
});
