// REQ-166 — the VERSIONED point-in-polygon jurisdiction resolver that replaces the coarse five-box
// stub. PURE / DETERMINISTIC (no D1, no R2, no Date, no random, no LLM, no network — REQ-024), so it is
// unit-testable and safe to run inside the sequencer / positions bypass and the PWA.
//
// WHAT THIS MODULE IS. It parses a version/hash-pinned admin-boundary ARTIFACT into an indexed polygon
// source, and answers "which USPS operating state contains this GPS point?" by exact even-odd
// point-in-polygon in INTEGER microdegree space (BigInt predicates — no float drift, no int overflow).
// It NEVER guesses: every load/parse/coverage failure, and every geometric ambiguity, resolves to the
// fail-closed sentinel "XX" (not a USPS code — so no ConsentAck can match it, and the REQ-166 consent
// gate blocks rather than judging a stamp against the WRONG state). A wrong classification here is a
// safety/authority defect (it gates GPS consent), so the ONLY acceptable failure mode is fail-closed.
//
// WHAT THIS MODULE IS NOT. It is not the artifact. The production-grade, cartographically-accurate,
// all-states+territories admin-boundary dataset is LICENSED and EXTERNAL — a BLOCKED go-live HOLD
// vendored through the approved fixture process (fixtures/jurisdiction/manifest.json). The in-repo
// SYNTHETIC 5-state set (fixtures/jurisdiction/us-states.synthetic.json) is a coarse test/dev stand-in
// that proves the ALGORITHM and the hash-mismatch fail-closed path — it is NOT survey-accurate and is
// clearly marked synthetic. Any coordinate outside its coverage derives to "XX" (fail-closed).
//
// TIE / BORDER POLICY (explicit + deterministic). A point resolves to a state's USPS code IFF it is
// STRICTLY INTERIOR to exactly one state. It resolves to "XX" when it is exterior to all, lies ON any
// polygon boundary edge (a shared state line is ambiguous), or is interior to more than one state
// (overlapping coverage). Boundary takes precedence over interior — an on-line point is never
// silently assigned to a neighbour.

/** The fail-closed sentinel: not a USPS code, so no ConsentAck can equal it (blocks, never passes). */
export const FAIL_CLOSED_STATE = "XX";

const MAX_LAT_E6 = 90_000_000;
const MAX_LON_E6 = 180_000_000;
const E6 = 1_000_000;

// ---- artifact shape (the on-disk / embedded form) ----------------------------------------------------
// Coordinates are GeoJSON-style [lon, lat] in DECIMAL DEGREES. A ring is a closed simple boundary
// (first==last is tolerated; we do not require it). A state may carry multiple rings (MultiPolygon /
// islands), evaluated under the even-odd rule. Holes are not used by the synthetic set but the even-odd
// accumulation across rings supports them if a licensed artifact carries them.
export type LngLat = readonly [number, number];
export type Ring = readonly LngLat[];
export interface ArtifactState {
  readonly code: string; // canonical uppercase 2-letter USPS code (never "XX")
  readonly polygons: readonly Ring[];
}
export interface JurisdictionArtifact {
  readonly schema: "shuddl.jurisdiction.v1";
  readonly version: string;
  readonly provenance: string;
  readonly coverage: readonly string[];
  readonly border_policy: string;
  readonly states: readonly ArtifactState[];
}

// ---- built (indexed) form used by the resolver -------------------------------------------------------
// Vertices are frozen to INTEGER microdegrees at build time; all geometry runs in this integer space.
interface PointE6 {
  readonly x: number; // lon_e6
  readonly y: number; // lat_e6
}
interface StateE6 {
  readonly code: string;
  readonly rings: readonly (readonly PointE6[])[];
}
export interface PolygonSource {
  readonly version: string;
  readonly states: readonly StateE6[];
}

export type ValidationResult =
  | { readonly ok: true; readonly artifact: JurisdictionArtifact }
  | { readonly ok: false; readonly reason: string };

const USPS = /^[A-Z]{2}$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate an untrusted parsed artifact WITHOUT any external dependency (this is an internal fixture
 * boundary, not an API boundary, so we hand-roll rather than pull a schema lib into the pure ledger).
 * Every failure path returns a structured reason — the caller fails closed. This is exhaustive on
 * purpose: a malformed polygon must be REJECTED, never coerced into a confident answer.
 */
export function validateArtifact(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "artifact is not an object" };
  const a = raw as Record<string, unknown>;
  if (a.schema !== "shuddl.jurisdiction.v1") return { ok: false, reason: `unsupported schema ${String(a.schema)}` };
  if (typeof a.version !== "string" || a.version.length === 0) return { ok: false, reason: "missing version" };
  if (typeof a.provenance !== "string") return { ok: false, reason: "missing provenance" };
  if (!Array.isArray(a.coverage) || !a.coverage.every((c) => typeof c === "string")) {
    return { ok: false, reason: "coverage must be a string[]" };
  }
  if (typeof a.border_policy !== "string") return { ok: false, reason: "missing border_policy" };
  if (!Array.isArray(a.states) || a.states.length === 0) return { ok: false, reason: "states must be a non-empty array" };

  const seen = new Set<string>();
  for (let s = 0; s < a.states.length; s++) {
    const st = a.states[s] as Record<string, unknown>;
    if (typeof st !== "object" || st === null) return { ok: false, reason: `state ${s} is not an object` };
    if (typeof st.code !== "string" || !USPS.test(st.code)) return { ok: false, reason: `state ${s} code is not a 2-letter USPS code` };
    if (st.code === FAIL_CLOSED_STATE) return { ok: false, reason: `state ${s} uses the reserved sentinel XX` };
    if (seen.has(st.code)) return { ok: false, reason: `duplicate state ${st.code}` };
    seen.add(st.code);
    if (!Array.isArray(st.polygons) || st.polygons.length === 0) return { ok: false, reason: `state ${st.code} has no polygons` };
    for (let p = 0; p < st.polygons.length; p++) {
      const ring = st.polygons[p];
      // A valid closed ring needs at least 4 positions (GeoJSON: first==last, ≥3 distinct corners).
      if (!Array.isArray(ring) || ring.length < 4) return { ok: false, reason: `state ${st.code} ring ${p} has < 4 vertices` };
      for (let v = 0; v < ring.length; v++) {
        const pt = ring[v];
        if (!Array.isArray(pt) || pt.length !== 2 || !isFiniteNumber(pt[0]) || !isFiniteNumber(pt[1])) {
          return { ok: false, reason: `state ${st.code} ring ${p} vertex ${v} is not a finite [lon,lat]` };
        }
        const [lon, lat] = pt;
        if (lon < -180 || lon > 180) return { ok: false, reason: `state ${st.code} ring ${p} vertex ${v} lon out of range` };
        if (lat < -90 || lat > 90) return { ok: false, reason: `state ${st.code} ring ${p} vertex ${v} lat out of range` };
      }
    }
  }
  return { ok: true, artifact: raw as JurisdictionArtifact };
}

/** Convert a validated artifact to the integer-microdegree indexed source used by the resolver. */
export function buildPolygonSource(artifact: JurisdictionArtifact): PolygonSource {
  const states: StateE6[] = artifact.states.map((st) => ({
    code: st.code,
    rings: st.polygons.map((ring) => ring.map(([lon, lat]) => ({ x: Math.round(lon * E6), y: Math.round(lat * E6) }))),
  }));
  return { version: artifact.version, states };
}

/**
 * Validate + build in one step, FAIL-CLOSED: any validation failure (or a thrown error) yields null, so
 * every caller treats an unusable artifact as "no coverage" → "XX". This is the parse/coverage half of
 * the fail-closed contract; the hash half lives in {@link loadPolygonSource}.
 */
export function buildFromRaw(raw: unknown): PolygonSource | null {
  const v = validateArtifact(raw);
  if (!v.ok) return null;
  try {
    return buildPolygonSource(v.artifact);
  } catch {
    return null;
  }
}

// ---- exact integer geometry (BigInt predicates: no float drift, no 2^53 overflow) --------------------
// Microdegree deltas reach ~3.6e8; their products reach ~6.5e16, past Number.MAX_SAFE_INTEGER — so the
// orientation/cross-product predicates use BigInt. Determinism is absolute: same inputs, same answer.

function onSegment(a: PointE6, b: PointE6, px: number, py: number): boolean {
  const cross = BigInt(b.x - a.x) * BigInt(py - a.y) - BigInt(b.y - a.y) * BigInt(px - a.x);
  if (cross !== 0n) return false; // not collinear with the edge line
  // Collinear: on the segment iff within the edge's bounding box (inclusive).
  const withinX = px >= Math.min(a.x, b.x) && px <= Math.max(a.x, b.x);
  const withinY = py >= Math.min(a.y, b.y) && py <= Math.max(a.y, b.y);
  return withinX && withinY;
}

type RingHit = "boundary" | number; // "boundary" (on an edge) or a crossing count (0 or 1 per ring pass)

/**
 * Even-odd point-in-ring in integer space with an EXACT on-edge test. Returns "boundary" if the point
 * lies on any edge of the ring; otherwise returns the number of ray crossings (an east-going ray)
 * contributed by this ring. The half-open `(a.y > py) !== (b.y > py)` rule dedupes shared vertices;
 * the intersect side is compared by cross-multiplication (BigInt) so a point exactly at a vertex or on
 * a horizontal edge is decided by the on-edge test, never by float rounding.
 */
function ringCrossings(ring: readonly PointE6[], px: number, py: number): RingHit {
  let crossings = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j];
    const b = ring[i];
    // Unreachable (i, j are always in [0, n) on a ≥4-vertex validated ring); the guard exists only to
    // narrow away `undefined` under noUncheckedIndexedAccess without a non-null assertion.
    if (a === undefined || b === undefined) continue;
    if (onSegment(a, b, px, py)) return "boundary";
    if ((a.y > py) !== (b.y > py)) {
      // The edge straddles the horizontal ray line y = py. Does it cross STRICTLY east of px?
      // Intersect x = a.x + (b.x-a.x)*(py-a.y)/(b.y-a.y). Compare px < intersect without division:
      //   (px - a.x) * (b.y - a.y)  ?  (b.x - a.x) * (py - a.y)   with the sign of (b.y - a.y).
      const dy = BigInt(b.y - a.y);
      const lhs = BigInt(px - a.x) * dy;
      const rhs = BigInt(b.x - a.x) * BigInt(py - a.y);
      const eastOfPoint = dy > 0n ? lhs < rhs : lhs > rhs;
      if (eastOfPoint) crossings ^= 1;
    }
  }
  return crossings;
}

type StateHit = "boundary" | "in" | "out";

function pointInState(state: StateE6, px: number, py: number): StateHit {
  let odd = 0;
  for (const ring of state.rings) {
    const hit = ringCrossings(ring, px, py);
    if (hit === "boundary") return "boundary";
    odd ^= hit;
  }
  return odd === 1 ? "in" : "out";
}

/**
 * The resolver. Returns the canonical USPS code of the state STRICTLY containing (lat_e6, lon_e6), or
 * "XX" fail-closed when: the coordinate is malformed/out-of-range; it lies on any boundary edge; it is
 * exterior to every state; or it is interior to more than one state. Deterministic and total.
 */
export function resolveStateE6(source: PolygonSource, lat_e6: number, lon_e6: number): string {
  // Malformed coordinates never produce a confident state (defensive: GeoStamp is Zod-checked upstream,
  // but this module is also called directly and must fail closed on garbage).
  if (!Number.isInteger(lat_e6) || !Number.isInteger(lon_e6)) return FAIL_CLOSED_STATE;
  if (Math.abs(lat_e6) > MAX_LAT_E6 || Math.abs(lon_e6) > MAX_LON_E6) return FAIL_CLOSED_STATE;

  const px = lon_e6;
  const py = lat_e6;
  let match: string | null = null;
  for (const state of source.states) {
    const hit = pointInState(state, px, py);
    if (hit === "boundary") return FAIL_CLOSED_STATE; // on a state line → ambiguous → fail closed
    if (hit === "in") {
      if (match !== null && match !== state.code) return FAIL_CLOSED_STATE; // interior to >1 → fail closed
      match = state.code;
    }
  }
  return match ?? FAIL_CLOSED_STATE;
}

export interface LoadArgs {
  /** The exact artifact bytes (UTF-8 JSON text) as delivered by the approved fixture process. */
  readonly rawJson: string;
  /** The sha256 the manifest PINS for those bytes. */
  readonly expectedSha256: string;
  /**
   * The sha256 actually computed over `rawJson` by the caller (WebCrypto in the workers pool, node:crypto
   * in Node tooling). Injected so this module stays pure/sync and free of any crypto/network import — the
   * hash is a value, the comparison is the deterministic decision.
   */
  readonly actualSha256: string;
}

/**
 * The fixture-process loader: verify the pinned hash, then parse + validate + build — FAIL-CLOSED at
 * every step. A hash mismatch (tampered or wrong-version bytes), unparseable JSON, or a malformed
 * artifact all return null, and the caller derives "XX". This is the code path a licensed artifact
 * flows through at vendor/verification time; the hot runtime path trusts the already-verified embedded
 * active source (see jurisdiction.ts) and does not re-hash per call.
 */
export function loadPolygonSource(args: LoadArgs): PolygonSource | null {
  if (args.actualSha256 !== args.expectedSha256) return null; // hash mismatch → fail closed
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.rawJson);
  } catch {
    return null; // unparseable bytes → fail closed
  }
  return buildFromRaw(parsed);
}
