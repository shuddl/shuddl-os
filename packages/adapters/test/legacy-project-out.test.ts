import { describe, expect, it } from "vitest";
import {
  projectOut,
  serializeOutboundCsv,
  mapLegacyExport,
  parseSheet,
  stableStringify,
  LegacyMirrorConfigSchema,
  type LegacyMirrorConfig,
  type ProjectableEvent,
} from "../src/index.js";

// REQ-022 (WP-15 Task 5) — the WRITE-BACK half of the overlay + the no-ping-pong proof. project-OUT is the PURE
// INVERSE of the Task-4 mirror-IN: it takes SHUDDL's own facts and emits incumbent-format rows, each EMBEDDING the
// originating SHUDDL event id in the config's echoColumn. When the incumbent echoes that row back, the mirror-IN
// recognizes the echo and produces NO event — the bidirectional cycle CONVERGES (no unbounded growth, no
// oscillation). These tests exercise the LAW on the deterministic core: no worker, no D1, no DO.

// The SAME synthetic config the Task-4 mirror-IN test uses (the ONE echo contract, shared). In production the 171
// literal headers + record kinds are TENANT-PACK config outside the repo (genesis/13, REQ-167).
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

// A native quote.priced as SHUDDL emits it natively (a RICHER payload than the mirror's minimal shape — project-OUT
// extracts only the incumbent's number the config maps).
const nativeQuote = (over: Partial<ProjectableEvent> = {}): ProjectableEvent => ({
  id: "nat_q_0001",
  kind: "quote.priced",
  source: "native",
  streamKey: "SH-N1",
  naturalKey: "N-Q1",
  cursor: 10,
  payload: {
    sell: 120_000,
    lines: [{ kind: "freight", code: "LH", amount_cents: 100_000 }, { kind: "fuel", code: "FSC", amount_cents: 20_000 }],
    floors: { contribution: 90_000, full: 110_000, target: 118_000 },
    versions: { rate_config_ids: ["rc_2026_07"] },
    basis: { miles: 480 },
  },
  ...over,
});

describe("projectOut — the PURE inverse: embed the SHUDDL event id in the echoColumn + invert the field mapping", () => {
  it("embeds the native event id in the echoColumn and writes the control + inverse-field columns", () => {
    const rows = projectOut([nativeQuote()], CONFIG);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.eventId).toBe("nat_q_0001");
    expect(row?.kind).toBe("quote.priced");
    // THE ECHO EMBED (REQ-022) — the native id rides the SHARED echoColumn so the incumbent's echo is recognized.
    expect(row?.cells["shuddl_ref"]).toBe("nat_q_0001");
    // control columns (the inverse of the mirror-IN control reads).
    expect(row?.cells["rec_type"]).toBe("RATE");
    expect(row?.cells["feed_seq"]).toBe("10");
    expect(row?.cells["rec_id"]).toBe("N-Q1");
    expect(row?.cells["ship_ref"]).toBe("SH-N1");
    // the field inverse: the incumbent's number, written to the SAME legacy column the mirror-IN reads it from.
    expect(row?.cells["amount_cents"]).toBe("120000");
  });

  it("a value round-trips — clear the echo id and the mirror-IN rebuilds the SAME canonical number", () => {
    const [row] = projectOut([nativeQuote()], CONFIG);
    // Simulate a GENUINE legacy row (strip the echo id) and feed the projected cells back through the mirror-IN.
    const cleared = { eventId: "", kind: "quote.priced" as const, cells: { ...row!.cells, shuddl_ref: "" } };
    const feed = parseSheet(serializeOutboundCsv([cleared], CONFIG));
    const { records } = mapLegacyExport(feed, CONFIG);
    expect(records[0]?.event?.kind).toBe("quote.priced");
    expect(records[0]?.event?.payload["sell"]).toBe(120_000); // the load-bearing number survived out-and-back
  });

  it("inverts every mirror kind's number (invoice total sums the lines; split/dispatch/appointment too)", () => {
    const events: ProjectableEvent[] = [
      { id: "e_inv", kind: "invoice.issued", source: "native", streamKey: "S1", naturalKey: "K1", cursor: 1, payload: { invoice_id: "INV-9", party_id: "P-1", division: "north", lines: [{ line_no: 1, kind: "freight", amount_cents: 70_000 }, { line_no: 2, kind: "accessorial", amount_cents: 30_000 }] } },
      { id: "e_split", kind: "split.computed", source: "native", streamKey: "S2", naturalKey: "K2", cursor: 2, payload: { total_cents: 90_000, allocations: [{ party_id: "CARRIER-4", share_bps: 10_000 }] } },
      { id: "e_disp", kind: "dispatch.assigned", source: "native", streamKey: "S3", naturalKey: "K3", cursor: 3, payload: { driver_user_id: "DRV-7", asset_id: "TRK-2" } },
      { id: "e_appt", kind: "appointment.set", source: "native", streamKey: "S4", naturalKey: "K4", cursor: 4, payload: { leg_kind: "delivery", facility_id: "FAC-3", slot_key: "SLOT-9", window_start_ts: 1_720_000_000_000, window_end_ts: 1_720_003_600_000 } },
    ];
    const byKind = new Map(projectOut(events, CONFIG).map((r) => [r.kind, r.cells]));
    expect(byKind.get("invoice.issued")?.["amount_cents"]).toBe("100000"); // Σ lines (penny-parity)
    expect(byKind.get("split.computed")?.["amount_cents"]).toBe("90000");
    expect(byKind.get("dispatch.assigned")?.["driver_ref"]).toBe("DRV-7");
    expect(byKind.get("appointment.set")?.["facility_ref"]).toBe("FAC-3");
    expect(byKind.get("appointment.set")?.["win_start_ms"]).toBe("1720000000000");
    expect(byKind.get("appointment.set")?.["win_end_ms"]).toBe("1720003600000");
    // every projected row still carries its echo id.
    for (const cells of byKind.values()) expect(cells["shuddl_ref"]).not.toBe("");
  });

  it("is PURE + DETERMINISTIC — the same (events, config) yields a byte-identical result twice", () => {
    const events = [nativeQuote()];
    expect(projectOut(events, CONFIG)).toEqual(projectOut(events, CONFIG));
    expect(serializeOutboundCsv(projectOut(events, CONFIG), CONFIG)).toBe(serializeOutboundCsv(projectOut(events, CONFIG), CONFIG));
  });

  it("skips non-MIRROR_KINDS events (only the outbound-relevant native facts are projected)", () => {
    const events: ProjectableEvent[] = [
      nativeQuote(),
      { id: "e_pod", kind: "pod.signed", source: "native", streamKey: "S9", naturalKey: "K9", cursor: 9, payload: { evidence: ["x"] } },
      { id: "e_gps", kind: "gps.ping", source: "native", streamKey: "S8", naturalKey: "K8", cursor: 8, payload: { lat: 1, lon: 2 } },
    ];
    const rows = projectOut(events, CONFIG);
    expect(rows.map((r) => r.kind)).toEqual(["quote.priced"]); // pod.signed / gps.ping are not projected outbound
  });

  it("REFUSES to project a fact with an empty id — a blank echoColumn would be a silent ping-pong (REQ-022)", () => {
    expect(() => projectOut([nativeQuote({ id: "" })], CONFIG)).toThrow(/id/i);
    expect(() => projectOut([nativeQuote({ id: "   " })], CONFIG)).toThrow(/id/i);
  });
});

// ── the ledger simulation (a PURE stand-in for the worker's append/dedupe). The worker mints the event id from the
//    draft.idSeed via deterministicUuid + the DO dedupes by id; here a pure FNV fold reproduces that: same seed →
//    same id (dedupe), changed content → new id (a correction). Native seeds carry their own ids. ────────────────
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
const mintLegacyId = (idSeed: string): string => `lg_${fnv1a(idSeed)}`;

interface LedgerEvent {
  id: string;
  kind: ProjectableEvent["kind"];
  source: string;
  streamKey: string;
  naturalKey: string;
  cursor: number;
  payload: Record<string, unknown>;
}

class SimLedger {
  private readonly byId = new Map<string, LedgerEvent>();
  seedNative(ev: LedgerEvent): void {
    this.byId.set(ev.id, ev);
  }
  /** Ingest a legacy feed through the mirror-IN. Returns {appended, echoed}. Idempotent by id (the DO dedupe). */
  ingest(feedText: string, config: LegacyMirrorConfig): { appended: number; echoed: number } {
    const { records } = mapLegacyExport(parseSheet(feedText), config);
    let appended = 0;
    let echoed = 0;
    for (const rec of records) {
      if (rec.echo) {
        echoed += 1;
        continue;
      }
      const draft = rec.event;
      if (draft === undefined) continue; // a quarantine — never a silent append
      // Assert THE ONE stringify governs the seed (share-lint: the mirror-IN idSeed folds the SAME stableStringify).
      expect(draft.idSeed).toBe(`legacy|${draft.kind}|${draft.naturalKey}|${stableStringify(draft.payload)}`);
      const id = mintLegacyId(draft.idSeed);
      if (this.byId.has(id)) continue; // DO dedupe — a re-ingested identical row is NOT a new event
      this.byId.set(id, { id, kind: draft.kind, source: "legacy", streamKey: draft.streamKey, naturalKey: draft.naturalKey, cursor: rec.cursor ?? 0, payload: draft.payload });
      appended += 1;
    }
    return { appended, echoed };
  }
  /** Every SHUDDL-held fact, projected OUT to the incumbent (each row embeds its SHUDDL id in the echoColumn). */
  exportOutbound(config: LegacyMirrorConfig): string {
    const facts: ProjectableEvent[] = [...this.byId.values()].map((e) => ({ id: e.id, kind: e.kind, source: e.source, streamKey: e.streamKey, naturalKey: e.naturalKey, cursor: e.cursor, payload: e.payload }));
    return serializeOutboundCsv(projectOut(facts, config), config);
  }
  size(): number {
    return this.byId.size;
  }
}

describe("THE BIDIRECTIONAL ECHO SOAK — no ping-pong: the round-trip converges (REQ-022, the DoD centerpiece)", () => {
  it("N cycles converge: every projected row is echo-skipped, the event count STABILIZES (no growth, no oscillation)", () => {
    const led = new SimLedger();
    // 1. SHUDDL starts with native facts.
    led.seedNative({ id: "nat_q1", kind: "quote.priced", source: "native", streamKey: "SH-A", naturalKey: "NQ1", cursor: 100, payload: { sell: 120_000, lines: [{ kind: "freight", code: "L", amount_cents: 120_000 }], floors: { contribution: 0, full: 0, target: 0 }, versions: { rate_config_ids: ["rc"] }, basis: {} } });
    led.seedNative({ id: "nat_i1", kind: "invoice.issued", source: "native", streamKey: "SH-A", naturalKey: "NI1", cursor: 101, payload: { invoice_id: "INV-1", party_id: "P", division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "x" }] } });

    // 4 (setup). A GENUINE legacy fact enters ONCE (no echo id) → the mirror-IN mints exactly one source:'legacy' event.
    const genuineHeaders = "rec_id,rec_type,feed_seq,shuddl_ref,ship_ref,amount_cents\n";
    const genuine = genuineHeaders + "L-1,SETTLE,5,,SH-B,90000\n";
    const first = led.ingest(genuine, CONFIG);
    expect(first).toEqual({ appended: 1, echoed: 0 }); // it round-trips IN once
    const afterSeed = led.size();
    expect(afterSeed).toBe(3); // 2 native + 1 legacy

    // 2+3+4. Run the full cycle N times: project OUT everything → feed it BACK → assert EVERY row echo-skips, ZERO new.
    const N = 5;
    for (let i = 0; i < N; i++) {
      const outbound = led.exportOutbound(CONFIG);
      const { records } = mapLegacyExport(parseSheet(outbound), CONFIG);
      // EVERY projected row is recognized as a SHUDDL echo — none re-enters as a source:'legacy' event.
      expect(records.every((r) => r.echo)).toBe(true);
      const res = led.ingest(outbound, CONFIG);
      expect(res.appended).toBe(0); // ZERO new events on the round-trip (no ping-pong)
      expect(res.echoed).toBe(afterSeed); // all facts echoed back
      expect(led.size()).toBe(afterSeed); // the count is STABLE across every cycle (converged)
    }
    expect(led.size()).toBe(afterSeed); // no unbounded growth after N cycles
  });

  it("a genuine legacy row, once mirrored + re-exported, is echo-skipped (the legacy fact is not re-mirrored)", () => {
    const led = new SimLedger();
    const feed = "rec_id,rec_type,feed_seq,shuddl_ref,ship_ref,amount_cents\nL-9,INVOICE,3,,SH-Z,45000\n";
    expect(led.ingest(feed, CONFIG)).toEqual({ appended: 1, echoed: 0 }); // mirrored IN once
    // SHUDDL projects that mirrored fact back out (now carrying its SHUDDL id) → the incumbent echoes it → skipped.
    const outbound = led.exportOutbound(CONFIG);
    const { records } = mapLegacyExport(parseSheet(outbound), CONFIG);
    expect(records).toHaveLength(1);
    expect(records[0]?.echo).toBe(true);
    expect(led.ingest(outbound, CONFIG)).toEqual({ appended: 0, echoed: 1 }); // not re-mirrored
    expect(led.size()).toBe(1);
  });

  it("distinguishes CONVERGENCE from a real update: no content change → 0 new; a changed amount → exactly 1 correction", () => {
    const led = new SimLedger();
    const base = "rec_id,rec_type,feed_seq,shuddl_ref,ship_ref,amount_cents\nL-5,SETTLE,1,,SH-C,90000\n";
    expect(led.ingest(base, CONFIG).appended).toBe(1);
    expect(led.size()).toBe(1);

    // Re-ingest the IDENTICAL genuine row (a re-export with no change) → same idSeed → same id → DEDUPE (converged).
    const sameAgain = "rec_id,rec_type,feed_seq,shuddl_ref,ship_ref,amount_cents\nL-5,SETTLE,2,,SH-C,90000\n";
    expect(led.ingest(sameAgain, CONFIG).appended).toBe(0); // NO new event — this is convergence, not oscillation
    expect(led.size()).toBe(1);

    // A REAL content change (the incumbent corrected the amount) → new idSeed → a NEW event (a correction, +1).
    const corrected = "rec_id,rec_type,feed_seq,shuddl_ref,ship_ref,amount_cents\nL-5,SETTLE,3,,SH-C,88000\n";
    expect(led.ingest(corrected, CONFIG).appended).toBe(1); // exactly one correction, appended (never a silent overwrite)
    expect(led.size()).toBe(2);

    // …and the correction, once projected back out, ALSO converges (echo-skipped) — no oscillation after the change.
    const outbound = led.exportOutbound(CONFIG);
    expect(led.ingest(outbound, CONFIG)).toEqual({ appended: 0, echoed: 2 });
    expect(led.size()).toBe(2);
  });
});

// §1498 (REQ-022/118) — THE CSV ESCAPING IS LOAD-BEARING AND WAS DEFENDED BY NOTHING.
//
// `csvField` carries the whole wire contract in one line — *"RFC-4180 escaping that round-trips through
// parseSheet: quote a field containing a comma, quote, CR or LF, and double any embedded quote"* — and every
// existing round-trip above feeds it values that contain NONE of those characters (`120000`, `nat_q_0001`,
// `SH-N1`). MEASURED at §1498: replacing the whole function body with `return value;` leaves the adapters
// suite **43/43 green**. The escaping had no watcher at all.
//
// It is not redundant either, which is the other explanation for a silent mutation (§1389). The cells are not
// SHUDDL-shaped ids: `keyColumn` carries `naturalKey` — the INCUMBENT'S OWN reference, read verbatim out of
// their export — and the field inverse writes `division`, `invoice_id`, `facility_id`, `slot_key`,
// `driver_user_id` and `asset_id` straight through. A division named `North, Central` or a legacy ref like
// `PO 12, LOT "A"` is ordinary freight data, and unescaped it shifts every column to its right by one for the
// rest of that row — a file that IMPORTS CLEANLY into the incumbent and is silently wrong. That is the
// output-defect shape: a bad output works, it just reaches the wrong person as the wrong number.
//
// These cases pin BOTH directions. Round-tripping alone would also pass if `csvField` quoted every field
// unconditionally, which would change the bytes the incumbent's importer reads; so the benign case asserts the
// field is emitted BARE, and the adversarial cases assert it survives out-and-back byte-identical.

describe("§1498 — serializeOutboundCsv escaping: adversarial cells survive the round trip", () => {
  // The column set is CONFIG-DERIVED (control columns + every mapped field column), so it is read off the
  // serializer's own header line rather than restated here — a restated list would pass while describing a
  // different file the day the config gains a record.
  const row = (cells: Record<string, string>): { eventId: string; kind: "quote.priced"; cells: Record<string, string> } => ({
    eventId: cells["shuddl_ref"] ?? "e1",
    kind: "quote.priced",
    cells,
  });
  const BASE = { rec_type: "RATE", feed_seq: "10", shuddl_ref: "nat_q_1", rec_id: "N-Q1", ship_ref: "SH-1" };
  /** The value that came back in the column named `header`. */
  const cellOf = (feed: { headers: string[]; rows: string[][] }, header: string): string | undefined =>
    feed.rows[0]?.[feed.headers.indexOf(header)];

  it("a benign value is emitted BARE — the escaping does not quote what needs no quoting", () => {
    const csv = serializeOutboundCsv([row({ ...BASE })], CONFIG);
    const [head, data] = csv.split("\n");
    // Computed from the header line, never restated: each column is its cell or empty, comma-joined, unquoted.
    expect(data).toBe(head!.split(",").map((h) => (BASE as Record<string, string>)[h] ?? "").join(","));
    expect(data).not.toContain('"'); // no gratuitous quoting — these are the bytes the incumbent's importer reads
  });

  it("a comma inside a cell does not create a column", () => {
    const cells = { ...BASE, rec_id: "PO 12, LOT 4" };
    const csv = serializeOutboundCsv([row(cells)], CONFIG);
    const feed = parseSheet(csv);
    expect(feed.headers).toEqual(csv.split("\n")[0]!.split(",")); // the header line itself is unshifted
    expect(feed.rows).toHaveLength(1);
    expect(feed.rows[0]).toHaveLength(feed.headers.length); // the load-bearing invariant: no column shift
    expect(cellOf(feed, "rec_id")).toBe("PO 12, LOT 4");
    expect(cellOf(feed, "ship_ref")).toBe("SH-1"); // the cell to its RIGHT is still itself, not the comma's tail
  });

  it("embedded quotes are doubled and recovered verbatim", () => {
    const csv = serializeOutboundCsv([row({ ...BASE, rec_id: 'LOT "A"' })], CONFIG);
    expect(csv).toContain('"LOT ""A"""'); // RFC-4180: quote the field, double the inner quotes
    expect(cellOf(parseSheet(csv), "rec_id")).toBe('LOT "A"');
  });

  it("a CR, an LF and a CRLF inside a cell do not create a record", () => {
    for (const brk of ["\r", "\n", "\r\n"]) {
      const feed = parseSheet(serializeOutboundCsv([row({ ...BASE, rec_id: `LINE1${brk}LINE2` })], CONFIG));
      expect(feed.rows, `a ${JSON.stringify(brk)} split the record`).toHaveLength(1);
      expect(cellOf(feed, "rec_id")).toBe(`LINE1${brk}LINE2`); // both halves stayed in the one cell, verbatim
      expect(cellOf(feed, "ship_ref")).toBe("SH-1");
    }
  });

  it("EVERY cell survives out-and-back byte-identical, whichever column carries the hostile value", () => {
    const hostile = 'North, "Central"\r\nsouth';
    for (const col of Object.keys(BASE)) {
      const cells: Record<string, string> = { ...BASE, [col]: hostile };
      const feed = parseSheet(serializeOutboundCsv([row(cells)], CONFIG));
      expect(feed.rows, `${col} broke the record count`).toHaveLength(1);
      for (const header of feed.headers) {
        expect(cellOf(feed, header), `${col} hostile → ${header} came back wrong`).toBe(cells[header] ?? "");
      }
    }
  });

  it("the mirror-IN still recovers the number when the legacy ref carries a comma (the real path)", () => {
    const ev: ProjectableEvent = { ...nativeQuote(), naturalKey: 'PO 12, LOT "A"' };
    const [projected] = projectOut([ev], CONFIG);
    const cleared = { eventId: "", kind: "quote.priced" as const, cells: { ...projected!.cells, shuddl_ref: "" } };
    const feed = parseSheet(serializeOutboundCsv([cleared], CONFIG));
    const { records } = mapLegacyExport(feed, CONFIG);
    expect(records[0]?.event?.payload["sell"]).toBe(120_000); // the number is still in the number's column
  });
});
