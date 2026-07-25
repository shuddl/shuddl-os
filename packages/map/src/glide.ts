import type { FleetCollection } from "./entities.js";
import { BEARING_EPS2, bearingTo } from "./bearing.js";

// The render-smoothing glide (REQ-079/208). Kept out of MapCanvas.tsx (which pulls in maplibre-gl) so
// it is unit-testable with no WebGL, and separate from bearing.ts so the pure trig stays pure.

/** Ease per frame toward the target: 20% of the remaining distance, so a 30s-sparse GPS read renders
 * as continuous motion. Unchanged from the shipped value — this task changes WHEN we push, not how
 * fast a mark travels. */
const EASE = 0.2;

/** Below this residual the mark is home. Easing by a fixed fraction approaches a target
 * asymptotically and NEVER arrives, so without a snap `moved` would be true forever and the caller
 * could never skip a push. 1e-7° ≈ 1cm — far below both the render resolution and BEARING_EPS. */
const EPSILON = 1e-7;

/**
 * Ease each mark toward its target and, ONLY when it actually moved this frame (glide delta above
 * BEARING_EPS), re-derive `bearing` from the movement (H-2/REQ-208: a stationary or just-arrived mark
 * keeps whatever heading the ledger stamped — it never snaps north).
 *
 * Returns TRUE only if some coordinate actually changed, so the caller can skip a full setData. On a
 * clustered source that skip matters: MapLibre's `_applyDiffToSource` short-circuits for
 * `cluster: true`, so every setData reloads and re-parses EVERY tile of the source. Measured in ?perf
 * mode, 177 of those pushes over 8s moved nothing at all and rendered byte-identical frames.
 */
export function animateToward(fleet: FleetCollection, targets: ReadonlyMap<string, [number, number]>): boolean {
  let moved = false;
  for (const f of fleet.features) {
    const t = targets.get(String(f.id));
    if (!t) continue;
    const c = f.geometry.coordinates;
    const lng = c[0] ?? t[0];
    const lat = c[1] ?? t[1];
    const dLng = t[0] - lng;
    const dLat = t[1] - lat;
    const nLng = lng + dLng * EASE;
    const nLat = lat + dLat * EASE;

    if (Math.abs(t[0] - nLng) < EPSILON && Math.abs(t[1] - nLat) < EPSILON) {
      // Close enough to be home: land exactly on the target so the next frame can report no movement.
      if (lng !== t[0] || lat !== t[1]) moved = true;
      f.geometry.coordinates = [t[0], t[1]];
    } else {
      f.geometry.coordinates = [nLng, nLat];
      moved = true;
    }

    if (dLng * dLng + dLat * dLat > BEARING_EPS2) {
      f.properties.bearing = bearingTo(lng, lat, t[0], t[1]);
    }
  }
  return moved;
}
