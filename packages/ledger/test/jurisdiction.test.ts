import { describe, expect, it } from "vitest";
import { deriveOperatingState, UNKNOWN_JURISDICTION, SYNTHETIC_US_STATES } from "../src/geo/jurisdiction.js";
import {
  buildFromRaw,
  resolveStateE6,
  loadPolygonSource,
  validateArtifact,
  FAIL_CLOSED_STATE,
  type PolygonSource,
} from "../src/geo/polygon-source.js";
import fixtureRaw from "../../../fixtures/jurisdiction/us-states.synthetic.json?raw";
import manifestRaw from "../../../fixtures/jurisdiction/manifest.json?raw";

// REQ-166 — Task 13. deriveOperatingState is now a VERSIONED point-in-polygon resolver over a
// hash-pinned admin-boundary artifact, replacing the coarse five-box stub. The load-bearing property is
// FAIL-CLOSED: a malformed artifact, an out-of-range coordinate, a point on a state line, a point
// outside all coverage, or a point inside more than one state derives to "XX", so the consent gate
// blocks rather than judging a stamp against the WRONG state. The five-box stub was fail-OPEN on
// coastal/border cases (ocean off Big Sur and Reno-NV both derived to a confident "CA"); point-in-
// polygon over a real coastline resolves both to "XX". The active artifact is SYNTHETIC (5 states);
// the licensed all-states dataset is a BLOCKED external HOLD (fixtures/jurisdiction/manifest.json).

const geo = (lat: number, lon: number): { lat_e6: number; lon_e6: number } => ({
  lat_e6: Math.round(lat * 1e6),
  lon_e6: Math.round(lon * 1e6),
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The active source, built exactly as jurisdiction.ts builds it — used to exercise the resolver core.
const activeSource = buildFromRaw(SYNTHETIC_US_STATES);
// Mirror jurisdiction.ts's null-source fail-closed contract for tests that feed a rejected artifact.
const deriveWith = (source: PolygonSource | null, lat: number, lon: number): string =>
  source ? resolveStateE6(source, Math.round(lat * 1e6), Math.round(lon * 1e6)) : FAIL_CLOSED_STATE;

describe("deriveOperatingState: interior points resolve to their USPS code (point-in-polygon)", () => {
  it.each([
    ["Bay Area CA", 37.421, -122.084, "CA"],
    ["Bay Area worker OUTSIDE fixture (37.435N)", 37.435, -122.084, "CA"], // helpers.ts OUTSIDE — must stay CA
    ["Seattle WA", 47.6062, -122.3321, "WA"],
    ["Portland OR", 45.5152, -122.6789, "OR"],
    ["Dallas TX", 32.7767, -96.797, "TX"],
    ["NYC NY", 40.7128, -74.006, "NY"],
  ])("%s → %s", (_label, lat, lon, code) => {
    expect(deriveOperatingState(geo(lat, lon))).toBe(code);
  });

  it("the resolver is actually loaded (not degenerate-to-XX): at least one interior point classifies", () => {
    expect(activeSource).not.toBeNull();
    expect(deriveOperatingState(geo(37.421, -122.084))).not.toBe(UNKNOWN_JURISDICTION);
  });
});

describe("deriveOperatingState: FAIL-CLOSED — coastal near-miss + the five-box regressions (REQ-166)", () => {
  // The exact cases the five-box stub misclassified as a confident "CA" (verified: boxes → "CA"):
  it("Pacific-ocean point 35 km off Big Sur (36.2,-122.3) → 'XX' (the boxes returned 'CA')", () => {
    expect(deriveOperatingState(geo(36.2, -122.3))).toBe(UNKNOWN_JURISDICTION);
    expect(deriveOperatingState(geo(36.2, -122.3))).not.toBe("CA");
  });
  it("Reno-NV neighbour bleed (39.5,-119.8) → 'XX' (the boxes returned 'CA')", () => {
    expect(deriveOperatingState(geo(39.5, -119.8))).toBe(UNKNOWN_JURISDICTION);
    expect(deriveOperatingState(geo(39.5, -119.8))).not.toBe("CA");
  });
  it("ocean off the WA coast (46.0,-124.9) → 'XX'", () => {
    expect(deriveOperatingState(geo(46.0, -124.9))).toBe(UNKNOWN_JURISDICTION);
  });
});

describe("deriveOperatingState: FAIL-CLOSED — unsupported states + open ocean (REQ-166)", () => {
  it.each([
    ["Boise ID", 43.615, -116.2023],
    ["Denver CO", 39.7392, -104.9903],
    ["Kansas (worker-test coord)", 38.5, -98.0],
    ["mid-Pacific", 30.0, -150.0],
  ])("%s is inside NO supported state → 'XX'", (_label, lat, lon) => {
    expect(deriveOperatingState(geo(lat, lon))).toBe(UNKNOWN_JURISDICTION);
  });
});

describe("deriveOperatingState: shared-border determinism (the Columbia OR/WA line)", () => {
  it("Portland (S of the line) stays OR; Vancouver-WA (N of the line) stays WA", () => {
    expect(deriveOperatingState(geo(45.5152, -122.6789))).toBe("OR");
    expect(deriveOperatingState(geo(45.6387, -122.6615))).toBe("WA");
  });
  it("a point EXACTLY on the shared border edge (45.60,-122.66) → 'XX' (boundary precedes interior)", () => {
    expect(deriveOperatingState(geo(45.6, -122.66))).toBe(UNKNOWN_JURISDICTION);
  });
  it("is deterministic — the same coordinate yields the same code on repeat", () => {
    const a = deriveOperatingState(geo(45.6387, -122.6615));
    const b = deriveOperatingState(geo(45.6387, -122.6615));
    expect(a).toBe(b);
    expect(a).toBe("WA");
  });
});

describe("deriveOperatingState: FAIL-CLOSED on malformed coordinates", () => {
  it.each([
    ["non-integer lat", { lat_e6: 37_421_000.5, lon_e6: -122_084_000 }],
    ["out-of-range lat (>90°)", { lat_e6: 95_000_000, lon_e6: -122_084_000 }],
    ["out-of-range lon (<-180°)", { lat_e6: 37_421_000, lon_e6: -200_000_000 }],
    ["NaN lon", { lat_e6: 37_421_000, lon_e6: Number.NaN }],
  ])("%s → 'XX'", (_label, bad) => {
    expect(deriveOperatingState(bad as { lat_e6: number; lon_e6: number })).toBe(UNKNOWN_JURISDICTION);
  });
});

describe("polygon-source: overlap ambiguity → 'XX' (interior to more than one state fails closed)", () => {
  it("a point interior to two overlapping states resolves to 'XX', never a confident first-match", () => {
    // Two synthetic states sharing the SAME square → any interior point is inside BOTH → ambiguous.
    const square = (code: string) => ({
      code,
      polygons: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]] as [number, number][]],
    });
    const overlap = buildFromRaw({
      schema: "shuddl.jurisdiction.v1",
      version: "overlap-test",
      provenance: "test",
      coverage: ["AA", "BB"],
      border_policy: "test",
      states: [square("AA"), square("BB")],
    });
    expect(overlap).not.toBeNull();
    expect(resolveStateE6(overlap!, 1_000_000, 1_000_000)).toBe(FAIL_CLOSED_STATE); // (1,1) inside both
  });
});

describe("polygon-source: malformed artifacts are REJECTED and fail closed to 'XX'", () => {
  const base = {
    schema: "shuddl.jurisdiction.v1",
    version: "v",
    provenance: "p",
    coverage: ["CA"],
    border_policy: "b",
  };
  const okRing = [[-2, -2], [-2, 2], [2, 2], [2, -2], [-2, -2]];
  it.each([
    ["wrong schema", { ...base, schema: "nope", states: [{ code: "CA", polygons: [okRing] }] }],
    ["empty states", { ...base, states: [] }],
    ["ring with < 4 vertices", { ...base, states: [{ code: "CA", polygons: [[[0, 0], [1, 1], [0, 0]]] }] }],
    ["NaN coordinate", { ...base, states: [{ code: "CA", polygons: [[[0, 0], [0, 2], [Number.NaN, 2], [0, 0]]] }] }],
    ["lon out of range", { ...base, states: [{ code: "CA", polygons: [[[999, 0], [0, 2], [2, 2], [999, 0]]] }] }],
    ["code is the XX sentinel", { ...base, states: [{ code: "XX", polygons: [okRing] }] }],
    ["duplicate state code", { ...base, states: [{ code: "CA", polygons: [okRing] }, { code: "CA", polygons: [okRing] }] }],
    ["non-USPS code", { ...base, states: [{ code: "california", polygons: [okRing] }] }],
  ])("%s → validateArtifact rejects, buildFromRaw is null, derive → 'XX'", (_label, bad) => {
    expect(validateArtifact(bad).ok).toBe(false);
    const source = buildFromRaw(bad);
    expect(source).toBeNull();
    expect(deriveWith(source, 37.421, -122.084)).toBe(FAIL_CLOSED_STATE);
  });

  it("a VALID artifact passes validateArtifact and builds", () => {
    expect(validateArtifact(SYNTHETIC_US_STATES).ok).toBe(true);
    expect(buildFromRaw(SYNTHETIC_US_STATES)).not.toBeNull();
  });
});

describe("polygon-source: the fixture-process loader is FAIL-CLOSED on hash mismatch (REQ-166)", () => {
  it("correct pinned hash → a source that classifies interiors correctly", async () => {
    const actual = await sha256Hex(fixtureRaw);
    const source = loadPolygonSource({ rawJson: fixtureRaw, expectedSha256: actual, actualSha256: actual });
    expect(source).not.toBeNull();
    expect(resolveStateE6(source!, 37_421_000, -122_084_000)).toBe("CA");
  });

  it("expected ≠ actual hash → null (fail closed), never a best-effort parse", () => {
    const source = loadPolygonSource({
      rawJson: fixtureRaw,
      expectedSha256: "0".repeat(64),
      actualSha256: "f".repeat(64),
    });
    expect(source).toBeNull();
  });

  it("TAMPERED bytes (hash of tampered ≠ pinned hash) → null (fail closed)", async () => {
    const pinned = await sha256Hex(fixtureRaw);
    const tampered = fixtureRaw.replace('"CA"', '"ZZ"'); // any edit changes the digest
    const tamperedHash = await sha256Hex(tampered);
    expect(tamperedHash).not.toBe(pinned);
    const source = loadPolygonSource({ rawJson: tampered, expectedSha256: pinned, actualSha256: tamperedHash });
    expect(source).toBeNull();
  });

  it("unparseable bytes (hash matches, JSON is garbage) → null (fail closed)", async () => {
    const garbage = "{ this is not json";
    const h = await sha256Hex(garbage);
    expect(loadPolygonSource({ rawJson: garbage, expectedSha256: h, actualSha256: h })).toBeNull();
  });
});

describe("fixture integrity: the active artifact is byte-bound to the hash-pinned fixture + manifest", () => {
  const manifest = JSON.parse(manifestRaw) as {
    artifacts: { id: string; role: string; kind: string; status: string; path: string | null; sha256: string | null }[];
  };
  const active = manifest.artifacts.find((a) => a.role === "active")!;
  const licensed = manifest.artifacts.find((a) => a.role === "production")!;

  it("the fixture bytes hash to the sha256 pinned in the jurisdiction manifest", async () => {
    expect(active.status).toBe("vendored");
    expect(active.path).toBe("fixtures/jurisdiction/us-states.synthetic.json");
    expect(await sha256Hex(fixtureRaw)).toBe(active.sha256);
  });

  it("the embedded SYNTHETIC_US_STATES const deep-equals the pinned fixture (no silent drift)", () => {
    expect(JSON.parse(fixtureRaw)).toEqual(SYNTHETIC_US_STATES);
  });

  it("the licensed all-states artifact is recorded as a BLOCKED external HOLD, not vendored", () => {
    expect(licensed.kind).toBe("licensed");
    expect(licensed.status).toBe("blocked");
    expect(licensed.sha256).toBeNull();
    expect(licensed.path).toBeNull();
  });
});
