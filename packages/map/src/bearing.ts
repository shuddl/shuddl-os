// The pure heading math for the map instrument (REQ-075, REQ-208). Kept out of MapCanvas.tsx (which
// pulls in maplibre-gl) so it is unit-testable with no WebGL. keep-map-instrument-truthful: a rendered
// chevron must point where the ledger says the vehicle faces — never a glide artifact. The glide loop
// that consumes this lives in `glide.ts`.

/**
 * Great-circle INITIAL bearing from (lng,lat) to (tlng,tlat). 0° = north (matches the chevron art),
 * clockwise. L-6 (REQ-208): the previous planar `atan2(Δlng, Δlat)` omitted the cos(lat) scaling, so
 * a degree of longitude was over-weighted and headings skewed toward due-east as latitude rose (a
 * true 45° NE course at 60°N rendered ~63°). The great-circle form (cos-lat terms in x and y) is
 * correct everywhere on the globe.
 */
export function bearingTo(lng: number, lat: number, tlng: number, tlat: number): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const lat1 = toRad(lat);
  const lat2 = toRad(tlat);
  const dLon = toRad(tlng - lng);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// H-2 (REQ-208): below this glide-delta magnitude a mark is effectively AT REST. Deriving a heading
// from a ~zero delta yields atan2(0,0) === 0 → a due-north snap that clobbers the real ledger
// heading. ~1e-6° ≈ 0.1 m; we compare the SQUARED delta against EPS² to avoid a sqrt per feature.
// Consumed by `glide.ts`, which owns the per-frame ease.
const BEARING_EPS = 1e-6;
export const BEARING_EPS2 = BEARING_EPS * BEARING_EPS;
