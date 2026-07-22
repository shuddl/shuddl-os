import { describe, expect, it } from "vitest";
import {
  mapLegacyExport,
  LegacyMirrorConfigSchema,
  parseSheet,
  type LegacyMirrorConfig,
  type MirrorRecord,
} from "../src/index.js";
import genericExport from "../../../fixtures/legacy-mirror/generic-export.csv?raw";

// REQ-021 / REQ-022 / REQ-035 (WP-15 Task 4) — the PURE, config-driven 171-col legacy-mirror mapper. These
// tests exercise the LAW directly on the deterministic core: no worker, no D1, no DO. A legacy export row →
// the SAME canonical event kind SHUDDL emits natively, tagged source:'legacy', with a DETERMINISTIC id seed
// (echo-safe) — OR an echo-skip / a quarantine / a continuous gap row. NOTHING is ever silently dropped.

// The generic, config-driven mapping for the synthetic fixture. In production these 171 literal headers +
// pro-ranges + cadence are TENANT-PACK config OUTSIDE the repo (genesis/13, REQ-167); the repo ships this
// SYNTHETIC neutral config + fixture (no vendor identity).
const CONFIG: LegacyMirrorConfig = LegacyMirrorConfigSchema.parse({
  typeColumn: "rec_type",
  cursorColumn: "feed_seq",
  echoColumn: "shuddl_ref",
  keyColumn: "rec_id",
  streamColumn: "ship_ref",
  records: [
    { kind: "quote.priced", module: "rating", match: "RATE", fields: { sell_cents: { column: "amount_cents" } } },
    { kind: "invoice.issued", module: "invoicing", match: "INVOICE", fields: { total_cents: { column: "amount_cents" } } },
    { kind: "split.computed", module: "settlement", match: "SETTLE", fields: { total_cents: { column: "amount_cents" } } },
    { kind: "dispatch.assigned", module: "dispatch", match: "DISPATCH", fields: { driver: { column: "driver_ref" } } },
    {
      kind: "appointment.set",
      module: "dispatch",
      match: "APPOINT",
      fields: {
        facility: { column: "facility_ref" },
        slot: { column: "slot_ref" },
        window_start_ms: { column: "win_start_ms" },
        window_end_ms: { column: "win_end_ms" },
      },
    },
  ],
});

const eventOf = (records: MirrorRecord[], kind: string) => records.find((r) => r.event?.kind === kind)?.event;

describe("mapLegacyExport — a legacy export row becomes the RIGHT source:'legacy' canonical event", () => {
  it("a rated row → quote.priced (source:legacy); an invoice row → invoice.issued; settlement/dispatch/appt too", () => {
    const r = mapLegacyExport(parseSheet(genericExport), CONFIG);

    const priced = eventOf(r.records, "quote.priced");
    expect(priced?.source).toBe("legacy");
    expect(priced?.module).toBe("rating");
    expect(priced?.payload["sell"]).toBe(120_000);
    // The itemized lines the invoice would project must sum to sell (penny-parity, mirrors QuotePricedPayload).
    const lines = priced?.payload["lines"] as Array<{ amount_cents: number }>;
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(120_000);

    const invoice = eventOf(r.records, "invoice.issued");
    expect(invoice?.source).toBe("legacy");
    expect(invoice?.module).toBe("invoicing");
    const ilines = invoice?.payload["lines"] as Array<{ amount_cents: number }>;
    expect(ilines.reduce((s, l) => s + l.amount_cents, 0)).toBe(120_000);

    const split = eventOf(r.records, "split.computed");
    expect(split?.payload["total_cents"]).toBe(90_000);
    const allocs = split?.payload["allocations"] as Array<{ share_bps: number }>;
    expect(allocs.reduce((s, a) => s + a.share_bps, 0)).toBe(10_000); // whole pie (mirrors SplitComputedPayload)

    const dispatch = eventOf(r.records, "dispatch.assigned");
    expect(dispatch?.payload["driver_user_id"]).toBe("DRV-7");

    const appt = eventOf(r.records, "appointment.set");
    expect(appt?.payload["facility_id"]).toBe("FAC-3");
    expect(appt?.payload["window_start_ts"]).toBe(1_720_000_000_000);
    expect(appt?.payload["window_end_ts"]).toBe(1_720_003_600_000);
  });

  it("is PURE + DETERMINISTIC — the same (sheet, config) yields a byte-identical result twice", () => {
    const sheet = parseSheet(genericExport);
    expect(mapLegacyExport(sheet, CONFIG)).toEqual(mapLegacyExport(sheet, CONFIG));
  });
});

describe("THE LAW — echo detection: a row carrying an embedded SHUDDL id is NOT re-appended (REQ-022, no ping-pong)", () => {
  it("the row whose echo column is non-empty is marked echo and produces NO event", () => {
    const r = mapLegacyExport(parseSheet(genericExport), CONFIG);
    const echoed = r.records.filter((rec) => rec.echo);
    expect(echoed).toHaveLength(1);
    expect(echoed[0]?.naturalKey).toBe("R-1006");
    expect(echoed[0]?.event).toBeUndefined(); // a SHUDDL fact echoed back is NOT mirrored as legacy
    // …and no quote.priced was minted for that echoed stream.
    expect(r.records.some((rec) => rec.event?.streamKey === "SH-1003")).toBe(false);
  });
});

describe("THE LAW — deterministic (echo-safe) id seed: same row → same seed; changed content → new seed", () => {
  it("re-mapping the identical row reproduces the identical idSeed; a changed amount changes it", () => {
    const seedOf = (csv: string) => mapLegacyExport(parseSheet(csv), CONFIG).records.find((x) => x.event)?.event?.idSeed;
    const base = "rec_id,rec_type,feed_seq,shuddl_ref,ship_ref,amount_cents\nR-1,RATE,1,,SH-1,120000\n";
    const changed = "rec_id,rec_type,feed_seq,shuddl_ref,ship_ref,amount_cents\nR-1,RATE,1,,SH-1,999999\n";
    expect(seedOf(base)).toBe(seedOf(base)); // deterministic — no Date/random
    expect(seedOf(base)).not.toBe(seedOf(changed)); // a changed value is a NEW event (never a silent overwrite)
  });
});

describe("THE LAW — continuous no-silent-drop: every unmapped column is a gap row, values retained", () => {
  it("misc_note + legacy_status map to no canonical field → 2 unmapped gap rows with samples", () => {
    const r = mapLegacyExport(parseSheet(genericExport), CONFIG);
    const unmapped = r.gapRows.filter((g) => g.reason === "unmapped").map((g) => g.column).sort();
    expect(unmapped).toEqual(["legacy_status", "misc_note"]);
    for (const g of r.gapRows) expect(g.sample).not.toBeNull(); // every gap carries a human sample (nothing hidden)
  });

  it("a below-floor field mapping is a low_confidence gap and is NOT silently applied", () => {
    const weak = LegacyMirrorConfigSchema.parse({
      ...CONFIG,
      records: [{ kind: "quote.priced", module: "rating", match: "RATE", fields: { sell_cents: { column: "amount_cents", confidence: 0.5 } } }],
    });
    const r = mapLegacyExport(parseSheet("rec_id,rec_type,feed_seq,shuddl_ref,ship_ref,amount_cents\nR-1,RATE,1,,SH-1,120000\n"), weak);
    // The weak field is routed to review (a gap), so the required sell is absent → the row can't price → quarantine.
    expect(r.gapRows.some((g) => g.reason === "low_confidence" && g.column === "amount_cents")).toBe(true);
    expect(r.records[0]?.event).toBeUndefined();
    expect(r.records[0]?.quarantine).toBeDefined();
  });

  it("the per-row values of unmapped columns are RETAINED on the event draft (never lost)", () => {
    const r = mapLegacyExport(parseSheet(genericExport), CONFIG);
    const priced = r.records.find((rec) => rec.event?.kind === "quote.priced")?.event;
    expect(priced?.retainedRefs["misc_note"]).toBe("rush lane");
    expect(priced?.retainedRefs["legacy_status"]).toBe("OPEN");
  });
});

describe("THE LAW — quarantine, never drop: a malformed / unknown row is retained, never thrown", () => {
  it("a RATE row with no amount → quarantine (missing field); an unknown rec_type → quarantine, raw retained", () => {
    const r = mapLegacyExport(parseSheet(genericExport), CONFIG);
    const missing = r.records.find((rec) => rec.naturalKey === "R-1007");
    expect(missing?.quarantine?.reason).toBe("missing_field");
    expect(missing?.event).toBeUndefined();
    expect(missing?.quarantine?.raw["ship_ref"]).toBe("SH-1004"); // the whole row is retained inline

    const unknown = r.records.find((rec) => rec.naturalKey === "R-1008");
    expect(unknown?.quarantine?.reason).toBe("unknown_type");
    expect(unknown?.quarantine?.raw["rec_type"]).toBe("WIDGET");
    expect(unknown?.quarantine?.raw["amount_cents"]).toBe("4200"); // nothing from the odd row is lost
  });
});

describe("LegacyMirrorConfigSchema — a bad config is a hard reject at the boundary (Zod)", () => {
  it("rejects a record naming a kind the mirror does not support", () => {
    expect(() =>
      LegacyMirrorConfigSchema.parse({ ...CONFIG, records: [{ kind: "pod.signed", module: "rating", match: "X", fields: {} }] }),
    ).toThrow();
  });
  it("rejects a config missing a required control column", () => {
    const { typeColumn: _omit, ...rest } = CONFIG;
    expect(() => LegacyMirrorConfigSchema.parse(rest)).toThrow();
  });
});
