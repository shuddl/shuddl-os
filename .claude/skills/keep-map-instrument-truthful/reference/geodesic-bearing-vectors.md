# Geodesic-bearing test vectors + the two heading bugs

Bearing convention in this repo (`packages/map/src/MapCanvas.tsx:47-51`): `0° = north`,
clockwise, so the chevron art (`chevron.ts`, points north at 0°) and `icon-rotate:
["get","bearing"]` (`entities.ts:117`) agree. Bearing = `atan2(east, north)`.

## Bug 1 — cos(lat) omitted (MapCanvas.tsx:49)
Current: `atan2(tlng - lng, tlat - lat)`. A degree of longitude spans `cos(lat)` of the
ground distance of a degree of latitude, so the east term must be scaled:

    correct = atan2((tlng - lng) * cos(lat * PI/180), tlat - lat)

Omitting cos(lat) OVERSTATES the east component, rotating the heading toward due-east as
latitude rises. Error is 0 at the equator, grows poleward.

## Bug 2 — heading from a zero glide delta (MapCanvas.tsx:96-97)
`animateToward` overwrites `bearing` every frame from `(current → target)`. When a mark
is static (current == target) the delta is 0 and `atan2(0,0) === 0` → the chevron snaps
due-north, discarding the real ledger heading. Fix: skip the overwrite when the glide
delta magnitude is below an epsilon; the ledger `bearing` property stays authoritative.

    const dLng = t[0] - lng, dLat = t[1] - lat;
    if (dLng*dLng + dLat*dLat > EPS2) {          // only when it actually moved
      f.properties.bearing = bearingTo(lng, lat, t[0], t[1]);
    }                                             // else keep ledger heading

## Test vectors (a corrected bearingTo must satisfy these)
Origin O, target T (lng, lat in degrees). Expected = compass bearing, 0=N clockwise.
Tolerance ±0.5°. `current` computed the corrected (cos-lat) way.

| # | O (lng,lat)   | T (lng,lat)     | corrected exp | BUGGY current gives | why |
|---|---------------|-----------------|---------------|---------------------|-----|
| 1 | (-98, 0)      | (-98, 1)        | 0.0  (due N)  | 0.0                 | Δlng=0, cos irrelevant |
| 2 | (-98, 0)      | (-97, 0)        | 90.0 (due E)  | 90.0                | Δlat=0, cos irrelevant |
| 3 | (-98, 0)      | (-99, 0)        | 270.0 (due W) | 270.0               | equator, no error |
| 4 | (0, 60)       | (0.02, 60.01)   | 45.0          | 63.43               | cos(60)=0.5 → east halved; buggy skews E |
| 5 | (0, 60)       | (0.01, 60.02)   | ~26.57        | ~45.0               | high-lat NE skews toward E |
| 6 | (0, -45)      | (-0.014142, -45.01) | ~315 (NW) | ~305.26           | southern hemisphere, cos(45)≈0.707 |
| 7 | STATIC: O==T (0,60) | (0,60)    | KEEP ledger bearing | 0.0 (due-N snap) | Bug 2 — never derive from zero delta |

Vector 4 is the canonical regression: a truck genuinely heading 45° NE at 60°N renders
~63° (skewed east) under the buggy planar formula. Vector 7 guards Bug 2: a parked truck
must keep whatever heading the ledger stamped, not snap north.

## Reference implementation
```ts
function bearingTo(lng: number, lat: number, tlng: number, tlat: number): number {
  const east = (tlng - lng) * Math.cos((lat * Math.PI) / 180);
  const north = tlat - lat;
  const deg = (Math.atan2(east, north) * 180) / Math.PI;
  return (deg + 360) % 360;
}
```
For long legs prefer the great-circle initial bearing; for the ~0.2 glide step the
cos(lat)-corrected planar form above is exact enough (sub-degree over a GPS tick).
