// Position generalization (REQ-074) — the client mirror of the WP-02 redaction. A party/consignee
// lens must not resolve an exact position until the shipment is out for delivery: coords are rounded
// to ~city granularity (1 decimal ≈ 11km) pre-OFD, exact post-OFD. In production the server sends
// the coarse coords already; this generalizer enforces the same law against the synthetic source and
// as defence-in-depth.

interface HasPoint {
  geometry: { coordinates: number[] };
}

/** Round to one decimal (~city, ~11km). */
function coarsen(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Return a copy of `feature` with its lng/lat coarsened to ~city precision unless
 * `outForDelivery` is true, in which case the exact feature is returned unchanged. Any extra
 * coordinate components (e.g. elevation) are preserved. The input is never mutated.
 */
export function generalizePosition<F extends HasPoint>(feature: F, outForDelivery: boolean): F {
  if (outForDelivery) return feature;
  const coords = feature.geometry.coordinates;
  const lng = coords[0];
  const lat = coords[1];
  if (lng === undefined || lat === undefined) return feature;
  const coordinates = [coarsen(lng), coarsen(lat), ...coords.slice(2)];
  return { ...feature, geometry: { ...feature.geometry, coordinates } } as F;
}
