import { describe, expect, it } from "vitest";
import { EVENT_KINDS, eventFixture, type EventKind, type Visibility } from "@shuddl/contracts";
import { buildChain } from "../src/chain.js";
import { KIND_VISIBILITY_DEFAULTS, UNRESOLVED_VISIBILITY, resolveVisibility } from "../src/visibility.js";
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
  it("REQ-180 floor: a tenant policy can NOT widen call.transcribed — it stays internal", () => {
    // Pre-REQ-180 this widened to counterparty; the INTERNAL_FLOOR now clamps inherently-internal kinds.
    expect(resolveVisibility("call.transcribed", { "call.transcribed": "counterparty" }, undefined)).toBe(
      "internal",
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
  it("invoice.corrected INHERITS the corrected event's visibility EXACTLY — internal AND counterparty (I7 nets inside one lens)", () => {
    expect(resolveVisibility("invoice.corrected", undefined, undefined, "internal")).toBe("internal");
    expect(resolveVisibility("invoice.corrected", undefined, undefined, "counterparty")).toBe("counterparty");
    // inheritance wins even over a request — the correction must sit in the SAME lens as the original (either way)
    expect(resolveVisibility("invoice.corrected", undefined, "counterparty", "internal")).toBe("internal");
    expect(resolveVisibility("invoice.corrected", undefined, "internal", "counterparty")).toBe("counterparty");
  });
  it("Task 8 — invoice.corrected with NO resolvable parent visibility returns UNRESOLVED (fail closed — never the default)", () => {
    // Pre-fix this fell back to counterparty (a phantom-charge lens leak). Now an unresolved parent is a hard
    // sentinel the sequencer rejects — a correction may NEVER default its lens.
    expect(resolveVisibility("invoice.corrected", undefined, undefined)).toBe(UNRESOLVED_VISIBILITY);
    // a request cannot conjure a visibility either — without a parent it stays UNRESOLVED
    expect(resolveVisibility("invoice.corrected", undefined, "internal")).toBe(UNRESOLVED_VISIBILITY);
    // even a tenant policy naming invoice.corrected cannot supply the lens — inheritance is exact-parent-only
    expect(resolveVisibility("invoice.corrected", { "invoice.corrected": "internal" }, undefined)).toBe(UNRESOLVED_VISIBILITY);
  });
});

// REQ-180 — the NEVER-WIDEN FLOOR. Inherently-internal kinds (margin/credit/consent/control) can never be
// widened past the tenant lens by a tenant POLICY or a per-event requested_visibility. The floor clamps the
// FAIL-CLOSED SUPERSET: all SEVEN code-default-internal kinds (the register names six + EXCLUDES split.computed;
// split.computed carries interline/margin internals and is code-default-internal, so it is clamped too).
describe("REQ-180: INTERNAL_FLOOR clamps inherently-internal kinds — policy/request can never WIDEN them", () => {
  const FLOORED: EventKind[] = [
    "call.transcribed",
    "credit.checked",
    "approval.requested",
    "approval.decided",
    "agent.acted",
    "authority.flipped",
    "split.computed",
  ];
  it.each(FLOORED.map((k) => [k] as const))(
    "a tenant policy widening %s to counterparty still resolves internal",
    (kind) => {
      expect(resolveVisibility(kind, { [kind]: "counterparty" }, undefined)).toBe("internal");
    },
  );
  it.each(FLOORED.map((k) => [k] as const))(
    "a tenant policy widening %s to public still resolves internal",
    (kind) => {
      expect(resolveVisibility(kind, { [kind]: "public" }, undefined)).toBe("internal");
    },
  );
  it.each(FLOORED.map((k) => [k] as const))(
    "a requested_visibility widening %s to counterparty still resolves internal",
    (kind) => {
      expect(resolveVisibility(kind, undefined, "counterparty")).toBe("internal");
    },
  );
  it("the floor holds even when BOTH a widening policy AND a widening request are present", () => {
    expect(resolveVisibility("credit.checked", { "credit.checked": "public" }, "public")).toBe("internal");
    expect(resolveVisibility("split.computed", { "split.computed": "counterparty" }, "counterparty")).toBe(
      "internal",
    );
    expect(resolveVisibility("approval.decided", { "approval.decided": "public" }, "counterparty")).toBe(
      "internal",
    );
  });
  it("a NON-internal kind is UNAFFECTED by the floor (booking.created still resolves normally)", () => {
    expect(resolveVisibility("booking.created", undefined, undefined)).toBe("counterparty");
    // a policy MAY still widen a non-floored kind to public
    expect(resolveVisibility("booking.created", { "booking.created": "public" }, undefined)).toBe("public");
    // and a request MAY still narrow it
    expect(resolveVisibility("booking.created", undefined, "internal")).toBe("internal");
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

// REQ-074 / I6 / doc 07 §02: exact coordinates are an ops/driver privilege. Geo rides MANY
// kinds — top-level on position.updated, nested `payload.geo` on pod.signed/custody.transferred,
// and any loose-payload kind could carry it. Generalization must be STRUCTURAL (walk the payload)
// so a party lens pre-OFD never leaks the exact dock, on any kind.
describe("party geo-privacy is structural: every geo-bearing kind, nested or top-level", () => {
  const LAT = 37_421_777;
  const LON = -122_084_333;
  const COARSE_LAT = 37_400_000;
  const COARSE_LON = -122_100_000;
  const SIG = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const geoStamp = { lat_e6: LAT, lon_e6: LON, accuracy_m: 5 };

  // Geo rides only the kinds whose payload contract actually carries it (WP-05 shaped these):
  // position.updated (top-level), pod.signed/custody.transferred/stop.arrived/stop.departed/
  // delivery.evidenced (nested payload.geo), plus exception.raised which stays a loose JsonObject
  // kind — proving the coarsening walk is STRUCTURAL, not a per-kind allowlist. Each build supplies
  // the kind's full valid payload with geoStamp injected.
  const cases: Array<{ kind: EventKind; build: () => ReturnType<typeof eventFixture> }> = [
    { kind: "position.updated", build: () => eventFixture("position.updated", { payload: { lat_e6: LAT, lon_e6: LON, accuracy_m: 5, speed_cms: 1_500 } }) },
    { kind: "pod.signed", build: () => eventFixture("pod.signed", { payload: { signature_hash: SIG, geo: geoStamp } }) },
    { kind: "custody.transferred", build: () => eventFixture("custody.transferred", { payload: { from_party: "a", to_party: "b", geo: geoStamp } }) },
    { kind: "stop.arrived", build: () => eventFixture("stop.arrived", { payload: { geo: geoStamp, auto: true } }) },
    { kind: "stop.departed", build: () => eventFixture("stop.departed", { payload: { geo: geoStamp, auto: true } }) },
    { kind: "delivery.evidenced", build: () => eventFixture("delivery.evidenced", { payload: { placed_photo_hash: SIG, geo: geoStamp } }) },
    { kind: "exception.raised", build: () => eventFixture("exception.raised", { payload: { geo: geoStamp } }) },
  ];

  // geo lives at payload.geo (nested) or at the payload root (position.updated).
  const geoOf = (p: Record<string, unknown>): Record<string, unknown> =>
    ("geo" in p ? p.geo : p) as Record<string, unknown>;

  it.each(cases)("$kind — party pre-OFD: coarse geo, accuracy dropped (asserted on the serialized body)", ({ build }) => {
    const r = redactEvent({ scope: "party" }, build(), false);
    const body = JSON.stringify(r.payload);
    expect(body).not.toContain(String(LAT)); // exact latitude never appears
    expect(body).not.toContain("accuracy_m");
    const g = geoOf(r.payload as Record<string, unknown>);
    expect(g.lat_e6).toBe(COARSE_LAT);
    expect(g.lon_e6).toBe(COARSE_LON);
    expect(g.accuracy_m).toBeUndefined();
  });

  it.each(cases)("$kind — party post-OFD: exact geo unlocks", ({ build }) => {
    const g = geoOf(redactEvent({ scope: "party" }, build(), true).payload as Record<string, unknown>);
    expect(g.lat_e6).toBe(LAT);
    expect(g.lon_e6).toBe(LON);
    expect(g.accuracy_m).toBe(5);
  });

  it.each(cases)("$kind — driver lens: geo always exact (ops/driver privilege)", ({ build }) => {
    const g = geoOf(redactEvent({ scope: "driver" }, build(), false).payload as Record<string, unknown>);
    expect(g.lat_e6).toBe(LAT);
    expect(g.accuracy_m).toBe(5);
  });
});

// audit §267 — INTERNAL_FLOOR is DERIVED from KIND_VISIBILITY_DEFAULTS rather than re-typed. This is the
// identity test: the floor must be exactly the code-default-internal kinds, so re-typing it as a literal
// (the previous shape) fails the moment the two diverge.
describe("§267: the internal visibility FLOOR is exactly the code-default-internal kinds", () => {
  const internalByDefault = (Object.entries(KIND_VISIBILITY_DEFAULTS) as ReadonlyArray<[EventKind, string]>)
    .filter(([, v]) => v === "internal")
    .map(([k]) => k)
    .sort();

  it("is non-vacuous: some kinds default to internal and some do not", () => {
    expect(internalByDefault.length).toBeGreaterThan(0);
    expect(internalByDefault.length).toBeLessThan(Object.keys(KIND_VISIBILITY_DEFAULTS).length);
  });

  it("clamps EVERY code-default-internal kind (a floor may be too strict, never too loose)", () => {
    for (const k of internalByDefault) {
      // requested `counterparty` — the widening a floor must refuse; policy undefined so only the floor acts.
      expect(resolveVisibility(k as EventKind, undefined, "counterparty"), `${k} defaults to internal but was not clamped`).toBe("internal");
    }
  });
});
