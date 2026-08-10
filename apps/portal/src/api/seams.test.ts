import { afterEach, describe, expect, it, vi } from "vitest";

// §863 — THE TWO PORTAL BOUNDARY SEAMS, AND THE ASYMMETRY BETWEEN THEM THAT NOTHING ENFORCED.
//
// `api/invoices.ts` exists BECAUSE OF A SHIPPED DEFECT. Its header records it: three components each wrote
// `get<{ invoices: InvoiceRow[] }>(...)`, a compile-time lie — `get` returns whatever the server sent. A body
// without an `invoices` key set state to `undefined` and the next render reached `.length`, white-screening
// the portal; a row missing `total_cents` rendered **NaN as a statement total** — money on screen that is not
// money. §781 put a Zod parse at the seam. Nothing tested it, which is the §860 shape: the mistake a guard
// prevents has already happened once, so it is demonstrably reachable.
//
// THE ASYMMETRY IS THE POINT OF THIS FILE. The two seams parse DIFFERENTLY, on purpose, and the reasoning is
// written out in both:
//
//   api/board.ts     `.strict()`  — server-controlled projection; an extra field is a hard throw, surfaced as
//                                   an honest "unavailable" rather than a half-rendered fleet.
//   api/invoices.ts  NOT strict   — a default Zod object STRIPS unknown keys, which IS the allowlist all three
//                                   components describe in prose ("reading ONLY these"), enforced at runtime.
//                                   `.strict()` here would turn a server adding a harmless field into a blank
//                                   billing page.
//
// Two mechanisms deliberately disagreeing is exactly the shape that gets "tidied" into consistency by someone
// who reads one file and not the other. The final case pins the difference itself: ONE payload, accepted by
// one seam and refused by the other.

const get = vi.fn();
vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: (...a: unknown[]) => get(...a) };
});

const { fetchPartyInvoices } = await import("./invoices.js");
const { fetchPartyBoard, freshnessLabel } = await import("./board.js");

const ROW = { id: "INV-1", party_id: "P-1", total_cents: 148_000, status: "open", due_ts: null };
const ITEM = { shipment_id: "SHP-1", lat_e6: 39_739_236, lon_e6: -104_990_251, status: "healthy" };

afterEach(() => vi.clearAllMocks());

describe("§863: the invoices seam refuses what used to white-screen the portal (REQ-085/073)", () => {
  it("a well-formed body parses through (non-vacuity — every refusal below needs an acceptance)", async () => {
    get.mockResolvedValue({ invoices: [ROW] });
    const rows = await fetchPartyInvoices();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.total_cents).toBe(148_000);
  });

  it("a body with NO invoices key THROWS — it must never reach a render as undefined", async () => {
    // The measured defect: `PAGEERROR: Cannot read properties of undefined (reading 'length')`, empty <body>.
    // A throw here lands in each caller's existing .catch and becomes an honest error state.
    get.mockResolvedValue({ board: [] }); // the shape the e2e route mock returned for every /v1/**
    await expect(fetchPartyInvoices()).rejects.toThrow();
  });

  it("a row missing total_cents THROWS — NaN must never be rendered as a statement total", async () => {
    const { total_cents: _drop, ...noTotal } = ROW;
    get.mockResolvedValue({ invoices: [noTotal] });
    await expect(fetchPartyInvoices()).rejects.toThrow();
  });

  it("due_ts NULL is a value, not an absence — honest 'no terms', never invented as overdue", async () => {
    get.mockResolvedValue({ invoices: [{ ...ROW, due_ts: null }] });
    expect((await fetchPartyInvoices())[0]?.due_ts).toBeNull();

    get.mockResolvedValue({ invoices: [{ ...ROW, due_ts: 1_700_000_000_000 }] });
    expect((await fetchPartyInvoices())[0]?.due_ts).toBe(1_700_000_000_000);
  });

  it("an unknown key is STRIPPED, not thrown on — and is genuinely absent from the row", async () => {
    // The allowlist the three components describe in prose, enforced at runtime. Asserting the key is GONE
    // (not merely that parsing survived) is what makes this the allowlist rather than mere tolerance: an
    // internal that leaked onto the wire cannot reach a component that decides to render `Object.entries`.
    get.mockResolvedValue({ invoices: [{ ...ROW, internal_margin_cents: 9_900, party_secret: "x" }] });
    const row = (await fetchPartyInvoices())[0] as unknown as Record<string, unknown>;
    expect(row).toBeDefined();
    expect("internal_margin_cents" in row, "a leaked internal must not survive the seam").toBe(false);
    expect("party_secret" in row).toBe(false);
    expect(row["total_cents"]).toBe(148_000);
  });
});

describe("§863: the board seam is STRICT, and maps e6 coordinates without inventing a heading", () => {
  it("a well-formed board maps to fleet items in degrees", async () => {
    get.mockResolvedValue({ board: [ITEM], as_of: 1_700_000_000_000 });
    const { items, asOf } = await fetchPartyBoard("P-1");

    expect(items).toHaveLength(1);
    expect(items[0]?.lat).toBeCloseTo(39.739236, 6);
    expect(items[0]?.lng).toBeCloseTo(-104.990251, 6);
    expect(items[0]?.bearing, "the board carries no heading; a chevron would invent one").toBe(0);
    expect(items[0]?.kind).toBe("at_rest");
    expect(items[0]?.party_refs).toEqual(["P-1"]);
    expect(asOf).toBe(1_700_000_000_000);
  });

  it("an EXTRA field on an item throws — the allowlist mirrors the server projection exactly", async () => {
    get.mockResolvedValue({ board: [{ ...ITEM, party_id: "P-1" }], as_of: 1 });
    await expect(fetchPartyBoard("P-1")).rejects.toThrow();
  });

  it("an unknown status throws rather than rendering an unstyled mark", async () => {
    get.mockResolvedValue({ board: [{ ...ITEM, status: "unknown" }], as_of: 1 });
    await expect(fetchPartyBoard("P-1")).rejects.toThrow();
  });

  it("freshnessLabel is UTC — deterministic across machines and CI timezones", () => {
    expect(freshnessLabel(Date.UTC(2026, 6, 10, 14, 32, 7))).toBe("14:32:07");
  });
});

describe("§863: the two seams disagree ON PURPOSE — one payload, two verdicts", () => {
  it("the SAME extra field is stripped by invoices and refused by the board", async () => {
    // The pin that keeps the asymmetry alive. Whoever makes these two files consistent — in either direction —
    // fails here and has to read both headers first. Making invoices strict turns a forward-compatible server
    // into a blank billing page; making the board lax lets an unmirrored projection field render.
    get.mockResolvedValue({ invoices: [{ ...ROW, added_by_a_later_server: true }] });
    await expect(
      fetchPartyInvoices(),
      "invoices must tolerate a new server field — strictness here is a blank billing page",
    ).resolves.toHaveLength(1);

    get.mockResolvedValue({ board: [{ ...ITEM, added_by_a_later_server: true }], as_of: 1 });
    await expect(
      fetchPartyBoard("P-1"),
      "the board must refuse a field its allowlist does not mirror",
    ).rejects.toThrow();
  });
});
