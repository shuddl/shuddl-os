import { describe, expect, it } from "vitest";
import { EVENT_KINDS, LedgerEvent, EventInput, AgentActedPayload, QuotePricedPayload, eventFixture } from "../src/index.js";

describe("REQ-011: the 35-kind catalog", () => {
  it("exactly 35 kinds, matching doc 10 §01", () => expect(EVENT_KINDS.length).toBe(35));
  it("every kind has a parseable fixture (round-trip owner is packages/ledger)", () => {
    for (const kind of EVENT_KINDS) expect(LedgerEvent.parse(eventFixture(kind)).kind).toBe(kind);
  });
});
describe("REQ-005: agent.acted requires basis links", () => {
  it("rejects empty basis", () => {
    expect(() => AgentActedPayload.parse({ agent: "biller", action: "draft", basis: [], confidence_bps: 9000 })).toThrow();
  });
});
describe("I4: custody kinds need a device or the unwitnessed flag", () => {
  it("pod.signed without device and without unwitnessed is rejected", () => {
    const f = eventFixture("pod.signed");
    const bad = { ...f, actor: { party: f.actor.party } };
    expect(() => LedgerEvent.parse(bad)).toThrow(/unwitnessed|device/);
  });
  it("unwitnessed flag admits it", () => {
    const f = eventFixture("pod.signed");
    const ok = { ...f, actor: { party: f.actor.party }, payload: { ...f.payload, unwitnessed: true } };
    expect(LedgerEvent.parse(ok).kind).toBe("pod.signed");
  });
});
describe("I5: quotes pin rate_config versions", () => {
  it("quote.priced with empty rate_config_ids (or versions absent) is rejected", () => {
    const f = eventFixture("quote.priced");
    const p = f.payload as { versions: { rate_config_ids: string[] } };
    expect(() => LedgerEvent.parse({ ...f, payload: { ...p, versions: { rate_config_ids: [] } } })).toThrow();
    const rest: Record<string, unknown> = { ...p };
    delete rest.versions;
    expect(() => LedgerEvent.parse({ ...f, payload: rest })).toThrow();
  });
});
// ─── REQ-003/031 (WP-06 Biller) — quote.priced carries the itemized `lines` breakdown the INVOICE
// projects from, penny-exact: Σ lines.amount_cents === sell. A missing/empty breakdown, or one that does
// not total the sell, FAILS validation (fail loud, never misprice). ───────────────────────────────────
describe("REQ-003/031: quote.priced carries the penny-parity itemized lines", () => {
  const f = eventFixture("quote.priced");
  const payload = f.payload as { sell: number; lines: unknown[] };

  it("accepts a valid, non-empty breakdown whose Σ amount_cents === sell", () => {
    const p = QuotePricedPayload.parse(payload);
    expect(p.lines.length).toBeGreaterThan(0);
    expect(p.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(p.sell);
  });

  it("rejects a payload MISSING lines entirely", () => {
    const rest: Record<string, unknown> = { ...payload };
    delete rest.lines;
    expect(() => QuotePricedPayload.parse(rest)).toThrow();
    expect(() => LedgerEvent.parse({ ...f, payload: rest })).toThrow();
  });

  it("rejects an empty lines array (min 1)", () => {
    expect(() => QuotePricedPayload.parse({ ...payload, lines: [] })).toThrow();
  });

  it("rejects a breakdown whose Σ amount_cents !== sell (never misprice)", () => {
    const under = { ...payload, lines: [{ kind: "freight", code: "freight", amount_cents: payload.sell - 1 }] };
    expect(() => QuotePricedPayload.parse(under)).toThrow();
    const over = { ...payload, lines: [{ kind: "freight", code: "freight", amount_cents: payload.sell + 1 }] };
    expect(() => QuotePricedPayload.parse(over)).toThrow();
  });

  it("rejects a NEGATIVE line even when the breakdown still totals sell (I7: a line is a positive charge)", () => {
    // 130_000 + (−10_000) = 120_000 = sell — the sum is honest but a negative line is un-projectable to a
    // valid invoice line (money.ts InvoiceLine enforces amount_cents >= 0), so it must fail at the record.
    const bad = { ...payload, lines: [
      { kind: "freight", code: "freight", amount_cents: payload.sell + 10_000 },
      { kind: "accessorial", code: "discount", amount_cents: -10_000 },
    ] };
    expect(() => QuotePricedPayload.parse(bad)).toThrow();
  });

  it("round-trips through LedgerEvent.parse with lines intact and totalling sell", () => {
    // The authoritative frozen-byte hash pin lives in the ledger snapshot (roundtrip.test.ts) — the
    // contracts layer proves only that the payload survives parse and stays penny-exact across a JSON trip.
    const parsed = LedgerEvent.parse(JSON.parse(JSON.stringify(f)) as unknown);
    const pa = parsed.payload as { sell: number; lines: { amount_cents: number }[] };
    expect(pa.lines.length).toBeGreaterThan(0);
    expect(pa.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(pa.sell);
  });
});

describe("I4 mirror: custody.transferred", () => {
  it("no device + no unwitnessed rejected; unwitnessed admits", () => {
    const f = eventFixture("custody.transferred");
    const bare = { ...f, actor: { party: f.actor.party } };
    expect(() => LedgerEvent.parse(bare)).toThrow(/unwitnessed|device/);
    expect(LedgerEvent.parse({ ...bare, payload: { ...f.payload, unwitnessed: true } }).kind).toBe("custody.transferred");
  });
});
describe("integer-only law", () => {
  it("float ts / confidence rejected", () => {
    const f = eventFixture("quote.requested");
    expect(() => LedgerEvent.parse({ ...f, ts: 1.5 })).toThrow();
    expect(() => LedgerEvent.parse({ ...f, confidence: 0.9 })).toThrow();
  });
});
describe("REQ-019: interline split gross is non-negative", () => {
  it("rejects a negative total_cents at the boundary; admits zero and positive", () => {
    const f = eventFixture("split.computed");
    const p = f.payload as { total_cents: number; allocations: unknown };
    expect(() => LedgerEvent.parse({ ...f, payload: { ...p, total_cents: -1 } })).toThrow();
    expect(LedgerEvent.parse({ ...f, payload: { ...p, total_cents: 0 } }).kind).toBe("split.computed");
    expect(LedgerEvent.parse(f).payload).toMatchObject({ total_cents: 120_000 }); // fixture stays valid
  });
});

// ─── REQ-016 (WP-05 exit audit) — a device-namespaced event (carrying device_id, the offline dedupe
// key) MUST be co-signed BY that device: device_id === actor.device AND a signature is present. This
// binds the dedupe slot to the signing key so an unsigned / foreign-signed event cannot squat it. ─────
describe("REQ-016: device_id is bound to the signing key (device_id === actor.device AND sig present)", () => {
  const deviceBase = {
    id: "00000000-0000-4000-8000-0000000000d1",
    ts: 1_720_000_000_000,
    actor: { party: "party-carrier", device: "device-1" },
    party_refs: [] as string[],
    evidence: [] as never[],
    source: "native" as const,
    confidence: 10_000,
    kind: "freight.counted" as const,
    payload: { pieces: 3 },
    device_id: "device-1",
    device_seq: 0,
    sig: "c2ln", // presence is what the refine checks; the DO verifies validity against the JWK
  };

  it("accepts the honest case (device_id === actor.device, signed)", () => {
    expect(EventInput.parse(deviceBase).device_id).toBe("device-1");
  });
  it("rejects an UNSIGNED event carrying a device_id (the squatted-slot bypass)", () => {
    const unsigned: Record<string, unknown> = { ...deviceBase };
    delete unsigned.sig;
    expect(() => EventInput.parse(unsigned)).toThrow(/sig required when device_id/);
  });
  it("rejects device_id != actor.device (device A signing under device B's id)", () => {
    expect(() => EventInput.parse({ ...deviceBase, device_id: "device-2" })).toThrow(/device_id must equal actor\.device/);
  });
  it("rejects a device_id with NO actor.device at all", () => {
    expect(() => EventInput.parse({ ...deviceBase, actor: { party: "party-carrier" } })).toThrow(/device_id must equal actor\.device/);
  });
  it("LedgerEvent (the stored shape read back by rowToEvent) enforces the same binding", () => {
    const stored = {
      ...deviceBase,
      stream_id: "s:shp-1",
      shipment_id: "shp-1",
      seq: 0,
      recorded_at: 1_720_000_000_500,
      prev_hash: "0".repeat(64),
      visibility: "internal" as const,
    };
    expect(LedgerEvent.parse(stored).device_id).toBe("device-1");
    const unsigned: Record<string, unknown> = { ...stored };
    delete unsigned.sig;
    expect(() => LedgerEvent.parse(unsigned)).toThrow(/sig required when device_id/);
  });
});

// ─── REQ-049 (WP-05 exit audit) — an override's by/reason must be non-blank (rejected at PARSE, a clean
// VALIDATION_FAILED, not an unaccountable pass reaching the gate). The check is a refine on the trimmed
// length, NOT a transform, so a valid override's stored bytes/hash are unchanged (frozen-byte law). ────
describe("REQ-049: EventOverride by/reason must be non-blank", () => {
  const base = eventFixture("stop.departed");
  it("accepts a named + reasoned override", () => {
    expect(LedgerEvent.parse({ ...base, override: { by: "u-ops", reason: "receiver waiting" } }).override?.by).toBe("u-ops");
  });
  it("rejects a whitespace-only by or reason", () => {
    expect(() => LedgerEvent.parse({ ...base, override: { by: "  ", reason: "x" } })).toThrow();
    expect(() => LedgerEvent.parse({ ...base, override: { by: "u", reason: "   " } })).toThrow();
  });
  it("rejects an extra key on the override (.strict)", () => {
    expect(() => LedgerEvent.parse({ ...base, override: { by: "u", reason: "x", who: "y" } })).toThrow();
  });
});

// ─── REQ-016 (WP-05 exit audit) — position.updated accuracy_m is a GPS uncertainty RADIUS; a negative
// value is nonsensical (matches GeoStamp / PositionStamp min 0). ──────────────────────────────────────
describe("position.updated accuracy_m is non-negative", () => {
  const f = eventFixture("position.updated");
  it("accepts accuracy_m >= 0", () => {
    const e = LedgerEvent.parse({ ...f, payload: { ...(f.payload as object), accuracy_m: 0 } });
    expect((e.payload as { accuracy_m: number }).accuracy_m).toBe(0);
  });
  it("rejects a negative accuracy_m", () => {
    expect(() => LedgerEvent.parse({ ...f, payload: { ...(f.payload as object), accuracy_m: -1 } })).toThrow();
  });
});
