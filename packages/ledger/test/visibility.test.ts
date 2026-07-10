import { describe, expect, it } from "vitest";
import { EVENT_KINDS, eventFixture, type EventKind, type Visibility } from "@shuddl/contracts";
import { buildChain } from "../src/chain.js";
import { KIND_VISIBILITY_DEFAULTS, resolveVisibility } from "../src/visibility.js";
import { REDACTIONS, generalizePosition, redactEvent } from "../src/redact.js";

// The 7 margin/credit/consent/control kinds default to internal; every other kind is
// counterparty (doc 10 §01; I6). This set is the spec the exhaustiveness test checks.
const INTERNAL: ReadonlySet<EventKind> = new Set<EventKind>([
  "credit.checked",
  "split.computed",
  "call.transcribed",
  "approval.requested",
  "approval.decided",
  "agent.acted",
  "authority.flipped",
]);

describe("REQ-015 / I6: per-kind visibility defaults cover all 35 kinds", () => {
  it("the defaults map has exactly 35 entries (runtime exhaustiveness)", () => {
    expect(Object.keys(KIND_VISIBILITY_DEFAULTS).length).toBe(35);
  });
  it.each(EVENT_KINDS.map((k) => [k]))("%s has the correct default", (kind) => {
    const expected: Visibility = INTERNAL.has(kind) ? "internal" : "counterparty";
    expect(KIND_VISIBILITY_DEFAULTS[kind]).toBe(expected);
  });
  it("every catalog kind is present in the defaults map", () => {
    for (const kind of EVENT_KINDS) expect(KIND_VISIBILITY_DEFAULTS[kind]).toBeDefined();
  });
});

describe("resolveVisibility: default -> tenant policy -> per-event narrow-only", () => {
  it("uses the per-kind default when nothing overrides", () => {
    expect(resolveVisibility("pod.signed", undefined, undefined)).toBe("counterparty");
    expect(resolveVisibility("credit.checked", undefined, undefined)).toBe("internal");
  });
  it("tenant policy may WIDEN call.transcribed to counterparty", () => {
    expect(resolveVisibility("call.transcribed", { "call.transcribed": "counterparty" }, undefined)).toBe(
      "counterparty",
    );
  });
  it("tenant policy may also narrow", () => {
    expect(resolveVisibility("pod.signed", { "pod.signed": "internal" }, undefined)).toBe("internal");
  });
  it("a per-event request may ONLY narrow (counterparty -> internal)", () => {
    expect(resolveVisibility("pod.signed", undefined, "internal")).toBe("internal");
  });
  it("a per-event request can NEVER widen (internal default is not raised)", () => {
    expect(resolveVisibility("credit.checked", undefined, "counterparty")).toBe("internal");
    expect(resolveVisibility("credit.checked", undefined, "public")).toBe("internal");
    expect(resolveVisibility("pod.signed", undefined, "public")).toBe("counterparty");
  });
  it("a request narrows on top of a widening policy", () => {
    expect(resolveVisibility("call.transcribed", { "call.transcribed": "counterparty" }, "internal")).toBe(
      "internal",
    );
  });
  it("invoice.corrected INHERITS the corrected event's visibility (I7 nets inside one lens)", () => {
    expect(resolveVisibility("invoice.corrected", undefined, undefined, "internal")).toBe("internal");
    // inheritance wins even over a request — the correction must sit in the same lens as the original
    expect(resolveVisibility("invoice.corrected", undefined, "counterparty", "internal")).toBe("internal");
  });
  it("invoice.corrected without a corrected-visibility falls back to its default", () => {
    expect(resolveVisibility("invoice.corrected", undefined, undefined)).toBe("counterparty");
  });
});

describe("REQ-015 / I6: redaction is a read projection (party/driver lenses)", () => {
  it("strips floors/basis/versions from quote.priced for a party lens but keeps sell", () => {
    const e = eventFixture("quote.priced");
    const r = redactEvent({ scope: "party" }, e);
    const p = r.payload as Record<string, unknown>;
    expect(p.sell).toBe(120_000);
    expect(p.floors).toBeUndefined();
    expect(p.basis).toBeUndefined();
    expect(p.versions).toBeUndefined();
  });
  it("strips the same fields for a driver lens (non-tenant)", () => {
    const e = eventFixture("quote.priced");
    const p = redactEvent({ scope: "driver" }, e).payload as Record<string, unknown>;
    expect(p.floors).toBeUndefined();
    expect(p.sell).toBe(120_000);
  });
  it("a tenant lens redacts nothing (ops/finance/admin/read see everything)", () => {
    const e = eventFixture("quote.priced");
    const p = redactEvent({ scope: "tenant" }, e).payload as Record<string, unknown>;
    expect(p.floors).toBeDefined();
    expect(p.versions).toBeDefined();
    expect(p.basis).toBeDefined();
  });
  it("strips internal_note from exception.raised for non-tenant lenses", () => {
    const e = eventFixture("exception.raised", { payload: { internal_note: "margin at risk", code: 42 } });
    const party = redactEvent({ scope: "party" }, e).payload as Record<string, unknown>;
    expect(party.internal_note).toBeUndefined();
    expect(party.code).toBe(42);
    const tenant = redactEvent({ scope: "tenant" }, e).payload as Record<string, unknown>;
    expect(tenant.internal_note).toBe("margin at risk");
  });
  it("REDACTIONS names exactly the two redacted kinds and their paths", () => {
    expect(REDACTIONS["quote.priced"]).toEqual(["floors", "basis", "versions"]);
    expect(REDACTIONS["exception.raised"]).toEqual(["internal_note"]);
  });
});

describe("generalizePosition: ~11 km city granularity until out-for-delivery", () => {
  it("rounds lat_e6/lon_e6 to 0.1 deg and drops accuracy_m pre-OFD", () => {
    const g = generalizePosition({ lat_e6: 37_421_777, lon_e6: -122_084_333, accuracy_m: 5, speed_cms: 1_500 }, false);
    expect(g.lat_e6).toBe(37_400_000);
    expect(g.lon_e6).toBe(-122_100_000);
    expect(g.accuracy_m).toBeUndefined();
    expect(g.speed_cms).toBe(1_500);
  });
  it("returns exact coordinates once out-for-delivery", () => {
    const exact = { lat_e6: 37_421_777, lon_e6: -122_084_333, accuracy_m: 5 };
    const g = generalizePosition(exact, true);
    expect(g.lat_e6).toBe(37_421_777);
    expect(g.lon_e6).toBe(-122_084_333);
    expect(g.accuracy_m).toBe(5);
  });
});

describe("redactEvent + position.updated: party sees city granularity pre-OFD only", () => {
  const build = () =>
    eventFixture("position.updated", {
      payload: { lat_e6: 37_421_777, lon_e6: -122_084_333, accuracy_m: 5, speed_cms: 1_500 },
    });
  it("party lens pre-OFD generalizes", () => {
    const p = redactEvent({ scope: "party" }, build(), false).payload as Record<string, unknown>;
    expect(p.lat_e6).toBe(37_400_000);
    expect(p.accuracy_m).toBeUndefined();
  });
  it("party lens post-OFD keeps exact position", () => {
    const p = redactEvent({ scope: "party" }, build(), true).payload as Record<string, unknown>;
    expect(p.lat_e6).toBe(37_421_777);
    expect(p.accuracy_m).toBe(5);
  });
  it("driver lens keeps exact position (geo is an ops/driver privilege)", () => {
    const p = redactEvent({ scope: "driver" }, build(), false).payload as Record<string, unknown>;
    expect(p.lat_e6).toBe(37_421_777);
    expect(p.accuracy_m).toBe(5);
  });
});

describe("redactEvent never mutates the stored event; prev_hash/sig/hash pass through", () => {
  it("leaves the input event's payload untouched (deep clone)", () => {
    const e = eventFixture("quote.priced");
    const before = JSON.stringify(e.payload);
    redactEvent({ scope: "party" }, e);
    expect(JSON.stringify(e.payload)).toBe(before);
  });
  it("passes prev_hash / hash / sig through untouched", async () => {
    const [built] = await buildChain([
      eventFixture("position.updated", { payload: { lat_e6: 37_421_777, lon_e6: -122_084_333, accuracy_m: 5 } }),
    ]);
    const signed = { ...built!, sig: "AAAA" };
    const r = redactEvent({ scope: "party" }, signed, false);
    expect(r.prev_hash).toBe(signed.prev_hash);
    expect(r.hash).toBe(signed.hash);
    expect(r.sig).toBe("AAAA");
  });
});
