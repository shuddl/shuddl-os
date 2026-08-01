# Exception-halo: pulse parity across circle AND symbol marks

## The gap this closes
Today `applyPulse` (`packages/map/src/MapCanvas.tsx:123-139`) only writes
`circle-stroke-width` on the `rest` and `clusters` layers. The `trucks` layer is a
`symbol` (`packages/map/src/entities.ts:110-123`); its `icon-opacity` is set to a
STATIC `keepLeaf` case by `setWorldDim` (`entities.ts:181`) and its `icon-size` is a
static zoom interpolation. So a truck (a *moving* entity) carrying
`statusStr==="exception"` is exempted from the world-dim but its coral chevron never
throbs. The alarm mark the eye tracks is dead still. Per `genesis/07-DESIGN-SYSTEM.md:47`
the exception "mark pulses at 100% opacity AND the rest of the map dims to 35%" — both
halves are required, for every kind, whether the mark is a circle or a symbol.

## Why not just pulse the symbol
`feature-state` is paint-only (MapLibre: "can only be used with paint properties that
support data-driven styling"). `icon-size` is a `layout` property — it can't read
feature-state and re-laying-out a symbol every frame is expensive. `icon-opacity` is
paint but pulsing opacity fights the world-dim opacity exemption on the same property.
Cleaner: decouple the alarm from the mark.

## The fix — one kind-independent halo circle under every mark
Add a `circle` layer FIRST in draw order (under clusters/marks), filtered to the
exception state via the same coalesce the rest of the module uses. It throbs on the
`urgent` sine regardless of what layer draws the mark above it — trucks (symbol),
at_rest/facility/delivered (circle) all inherit the throb.

```ts
// entities.ts — add to entityLayers(), FIRST so it sits under every mark.
const exceptionHalo: LayerSpecification = {
  id: "exception-halo",
  type: "circle",
  source: "fleet",
  filter: [
    "all",
    ["!", ["has", "point_count"]],
    // paint-safe status read; halo shows only for exceptions
    ["==", ["coalesce", ["feature-state", "status"], ["get", "statusStr"], "healthy"], "exception"],
  ],
  paint: {
    "circle-color": TOKENS.signal,
    "circle-opacity": 0,                 // fill invisible; the RING is the alarm
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 8, 16, 20],
    "circle-stroke-color": TOKENS.signal,
    "circle-stroke-width": 2,            // animated by applyPulse below
  },
};
// return order: [exceptionHalo, clusters, clusterCount, rest, trucks, chips, eta]
```

Note: `filter` can't read `feature-state` reliably for instant paint, so the halo also
needs the `statusStr` PROPERTY mirror (already flushed by useFleet on the throttled
setData). That is the same property/feature-state duality the module already relies on.

```ts
// MapCanvas.tsx — extend applyPulse so the halo rides the SAME 1.6s urgent sine.
function applyPulse(map: maplibregl.Map, ts: number): void {
  const urgent = 0.5 + 0.5 * Math.sin((ts / 1600) * 2 * Math.PI); // genesis/07:79
  const calm   = 0.5 + 0.5 * Math.sin((ts / 3000) * 2 * Math.PI);
  map.setPaintProperty("exception-halo", "circle-stroke-width", 2 + 5 * urgent);
  map.setPaintProperty("exception-halo", "circle-radius",
    ["interpolate", ["linear"], ["zoom"], 6, 8 + 4 * urgent, 16, 20 + 8 * urgent]);
  map.setPaintProperty("rest", "circle-stroke-width", [/* unchanged leaf throb */]);
  map.setPaintProperty("clusters", "circle-stroke-width", [/* unchanged cluster throb */]);
}
```

## Parity checklist when you add an EntityKind (entities.ts:14)
- [ ] Does the halo filter match this kind? (it filters by status, not kind — so yes by default; keep it kind-agnostic)
- [ ] Does `setWorldDim` exempt this kind's mark at 100%? (add the layer to the keepLeaf set)
- [ ] Under reduced-motion, does the halo render ONE static frame at `urgent=?` (pulseFrame(0))?
- [ ] Test: an exception on a `truck` throbs (not just at_rest). This is the case the current code misses.

## Reduced-motion
`applyPulse` under `prefers-reduced-motion` is called once at ts=0 (`MapCanvas.tsx:227-228`);
the halo then renders a single static ring — visible but not animated, honoring
`genesis/07-DESIGN-SYSTEM.md:79` motion law.
