# Operational map — 1,000 live shipments on the infinite canvas

Copy-paste Mapbox/MapLibre GL JS for the SHUDDL operational canvas. Written for **MapLibre GL JS** (the shipped product, REQ-075 self-hosted, no token) — the same code runs on **Mapbox GL JS** by swapping the constructor import, the style/tile source, and adding a token. Every API used here (`addSource`, `addLayer`, `setData`, `setFeatureState`, GeoJSON clustering, expressions, `map.on(event, layerId, …)`) exists in both — with **one divergence flagged inline in §8**: `getClusterExpansionZoom` is a Promise on MapLibre and a callback on Mapbox.

The architecture, and *why* each piece is shaped this way (all from Mapbox's own performance guidance):

- **Layers, never `Marker`s.** DOM markers die at hundreds; GL layers render thousands on WebGL.
- **Source strategy depends on whether the movers must cluster.** In SHUDDL almost every shipment is *moving*, and all 1,000 must cluster when zoomed out — so use **ONE clustered source** and update it with a **throttled `setData` (~20–30fps, not every frame)**. MapLibre/Mapbox recluster on a **worker thread**, so the throttled data tick doesn't block the 60fps paint. (The alternative — a separate *unclustered* `fleet-live` source for a handful of movers over a large *static clustered* backdrop — only applies when you have many static features and few movers. That is NOT the fleet case; don't split a set that must both animate and cluster.)
- **Few layers, data-driven.** One `circle` layer + one `symbol` (chevron) layer + a couple of state overlays, all styled by expressions — not one layer per state.
- **State via `setFeatureState`,** which updates a feature's state without re-parsing geometry. Requires stable numeric feature ids (`promoteId` below).

> **The one correctness trap that breaks naive builds: `feature-state` is PAINT-ONLY.** It cannot be read from `layout` properties (`text-field`, `icon-image`, `icon-size`, `*-sort-key`) or from a layer `filter` — those evaluate before feature-state exists. So: use `feature-state` for **paint** (opacity, color, `circle-radius`, `circle-stroke-width`, `icon-opacity`), and **mirror status into feature *properties*** (`statusStr`, `statusNum`, `chip`) for everything a `layout`/`filter`/`sort-key`/cluster-aggregation needs. Read paint with `["coalesce", ["feature-state","status"], ["get","statusStr"], "healthy"]` so it works whether the state was applied yet or not. On a **clustered source updated by `setData`**, feature-state survival across a recluster is **not guaranteed** (the libraries don't document it either way, and clusters regenerate) — so treat the property mirror as mandatory and re-assert state for the small non-healthy set after each `setData`. Defensive by design.

## 1. Init + custom greige basemap

```js
// MapLibre: import maplibregl from 'maplibre-gl';  (product; no token)
// Mapbox:   import mapboxgl  from 'mapbox-gl';  mapboxgl.accessToken = '...';  (promo)
const map = new maplibregl.Map({
  container: 'map',
  style: './greige-style.json',   // the custom style — NEVER a default street/dark style
  center: [-98.5, 39.5], zoom: 4, // CONUS; the fleet reads as red density from here
  attributionControl: false,      // no third-party branding (REQ-075)
});

const TOK = { field:'#D5D1CC', signal:'#FF4A33', ink:'#1A1A1A', progress:'#00C4B4' };
```

## 2. Source — one clustered fleet, with a promotable id

`feature-state` needs an id. Give every entity a stable `id` property and `promoteId` it so `setFeatureState` can target it. Note: on a *clustered* source a `setData` reclusters and can drop feature-state, which is why status is also mirrored into properties (§4).

```js
map.on('load', () => {
  // ONE clustered source for the whole fleet. clusterProperties aggregates the worst state in a
  // cluster so a cluster CONTAINING an exception can stay lit while its neighbors dim (§6).
  map.addSource('fleet', {
    type: 'geojson', promoteId: 'id',
    data: fleetFC,
    cluster: true, clusterRadius: 48, clusterMaxZoom: 7,
    clusterProperties: { maxStatus: ['max', ['get', 'statusNum']] },
  });
});
```

Each feature: `{ type:'Feature', id, geometry:{type:'Point',coordinates:[lng,lat]},
properties:{ id, kind:'truck|at_rest|facility|delivered', bearing, label, shipment_id,
statusStr:'healthy', statusNum:0, chip:'' } }`.
Status lives in **both** places: as **feature-state** for paint (§4), and **mirrored into `statusStr`/`statusNum`/`chip` properties** for layout/filter/sort and the `clusterProperties` aggregation — because layout and cluster-aggregation cannot read feature-state.

## 3. Layers — combined, data-driven, few

```js
// (a) Clusters: 1,000 points → counts at low zoom. Single red family; size by count (geometry, not color).
map.addLayer({ id:'clusters', type:'circle', source:'fleet', filter:['has','point_count'],
  paint:{
    'circle-color': TOK.signal, 'circle-opacity': 0.85,
    'circle-radius': ['step', ['get','point_count'], 12, 50, 18, 250, 26],
    'circle-stroke-color': TOK.field, 'circle-stroke-width': 1,
  }});
map.addLayer({ id:'cluster-count', type:'symbol', source:'fleet', filter:['has','point_count'],
  layout:{ 'text-field':['get','point_count_abbreviated'], 'text-font':['JetBrains Mono Regular'],
           'text-size':11, 'text-letter-spacing':0.08 },
  paint:{ 'text-color': TOK.field }});

// (b) At-rest squares + facilities (unclustered leaves). Shape by kind; opacity/rings by STATE (§5).
map.addLayer({ id:'rest', type:'circle', source:'fleet', filter:['!',['has','point_count']],
  paint:{
    'circle-color': TOK.signal,
    // exception fully lit, at-risk full, delivered faded, healthy solid — geometry/opacity only:
    'circle-opacity': ['match', ['coalesce',['feature-state','status'],'healthy'],
                        'exception', 1.0, 'at-risk', 1.0, 0.9],
    'circle-radius': ['interpolate',['linear'],['zoom'], 6, 3, 12, 6, 16, 9],
    // delivered <24h reads as a hollow outline (fill transparent, stroke red):
    'circle-stroke-color': TOK.signal, 'circle-stroke-width': 1,
  }});

// (c) Moving trucks as chevrons oriented to heading (icon-rotate from the bearing property).
//     Register a small chevron image once (map.addImage) or via the style sprite. The chevron art MUST
//     point UP (north) at 0deg, since icon-rotate applies the bearing (clockwise degrees) on top of it.
map.addLayer({ id:'trucks', type:'symbol', source:'fleet',
  filter:['all',['!',['has','point_count']],['==',['get','kind'],'truck']],
  layout:{ 'icon-image':'chevron', 'icon-rotate':['get','bearing'], 'icon-rotation-alignment':'map',
           'icon-size':['interpolate',['linear'],['zoom'], 6, 0.5, 14, 1.1], 'icon-allow-overlap':true },
  paint:{ 'icon-opacity': ['case', ['boolean',['feature-state','dimmed'],false], 0.35, 1] }});

// (d) The single sanctioned teal: the ETA fill on one focused shipment's remaining route (a line source).
map.addLayer({ id:'eta', type:'line', source:'focus-route',
  paint:{ 'line-color': TOK.progress, 'line-width': 2, 'line-opacity': 0.9 }});
```

> **Glyph reality — on-brand mono ON THE MAP requires self-hosted glyphs.** `text-font` resolves against the style's `glyphs` endpoint. A public demo tile provider (OpenFreeMap, Mapbox) serves only its own fonts (Noto Sans, Metropolis, DIN) — **not** JetBrains Mono. So a single-file demo's map labels/cluster-counts/chips fall back to the provider's font (uppercase + tracked, still readable). To get true `--mono` on the map in production you must **self-host JetBrains Mono glyph PBFs** and point `glyphs` at them (also required for the Driver PWA's offline map, REQ-075). The HTML *chrome* (nav, KPI strip, lens panel) uses the real fonts via CSS and is unaffected. Don't claim on-map mono in a CDN-tile demo — it will diverge.

## 4. The state machine — `setFeatureState`, no geometry re-parse

State is applied per entity as events land. This is O(changed features), not O(fleet):

```js
// status ∈ 'healthy' | 'at-risk' | 'exception';  risk names the early warning.
// Apply to BOTH feature-state (paint) AND the mirrored properties (layout/filter/cluster) — see the
// paint-only caveat above. Updating a property requires patching the FeatureCollection + a (throttled)
// setData; feature-state is instant. Batch property mirrors with the animation setData in §7.
const STATUS_NUM = { healthy:0, 'at-risk':1, exception:2 };
function setEntityState(id, status, risk) {
  map.setFeatureState({ source:'fleet', id }, { status });          // paint, instant
  const f = fleetById.get(id);                                      // Map<id, feature>
  if (f) { f.properties.statusStr = status; f.properties.statusNum = STATUS_NUM[status];
           f.properties.chip = risk ? `${risk} ${f.properties.riskVal ?? ''}`.trim()
                              : status === 'exception' ? `EXCEPTION · ${f.properties.label}` : ''; }
  // caller flags the FC dirty so the next throttled setData (§7) flushes the property mirror
}
// e.g. dwell projection crosses a threshold → early warning (predictive, not an alarm):
setEntityState('shp-417', 'at-risk', 'DWELL');   // → breathing ring + "DWELL 4:12" chip
// an OS&D event lands → alarm:
setEntityState('shp-902', 'exception');          // → §6 world-dim + pulse
```

Paint reads state via `['coalesce', ['feature-state','status'], ['get','statusStr'], 'healthy']` (above). Mono chips are a `symbol` layer whose `text-field` is `['get','chip']` — a **property**, because `text-field` is layout and cannot read feature-state — filtered `['!=', ['get','chip'], '']` so healthy marks stay label-light.

## 5. The two pulses — one cheap global sine

At-risk *breathes* (~3s, calm); exception *pulses* (1.6s, urgent). Drive both from one rAF-updated paint property rather than per-feature timers. A stroke ring on the `rest` layer, its width/opacity a sine, gated by state:

```js
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
function pulse(ts) {
  const urgent = 0.5 + 0.5*Math.sin(ts/1600*2*Math.PI); // 1.6s
  const calm   = 0.5 + 0.5*Math.sin(ts/3000*2*Math.PI); // 3s
  map.setPaintProperty('rest','circle-stroke-width',
    ['match', ['coalesce',['feature-state','status'],'healthy'],
      'exception', 2 + 4*urgent,      // fat, throbbing ring
      'at-risk',   1 + 1.5*calm,      // gentle breathing ring
      1]);                            // healthy: static 1px
  if (!REDUCED) requestAnimationFrame(pulse);
}
if (!REDUCED) requestAnimationFrame(pulse); else pulse(0); // reduced-motion: one static frame at rest
```

## 6. The exception world-dim — obnoxiously loud via CONTRAST, not a new color

When any visible feature is `exception`, drop *everything else* to ≤35% so the one pulsing red mark is the only lit thing. **Do it with paint, not a DOM veil** — a full-viewport `<div>` veil cannot keep a single in-canvas GL mark lit *above* it without a second map/canvas, so it's the wrong tool. Instead, dim every layer's opacity by a `case` that exempts the exception (in the entity layers via `feature-state`; in clusters via the aggregated `maxStatus` property, since clusters have no feature-state):

Simplest robust pattern — dim the map layers by paint, keep the exception layer lit:

```js
function setWorldDim(on) {
  const dim = on ? 0.35 : 1;
  // Leaf entity layers exempt the exception via feature-state; CLUSTER layers have no feature-state,
  // so they exempt via the aggregated `maxStatus` property (2 === exception) — a cluster holding the
  // exception stays lit and throbbing while its neighbors dim.
  const keepLeaf    = ['case', ['==', ['coalesce',['feature-state','status'],['get','statusStr'],'healthy'], 'exception'], 1, dim];
  const keepCluster = ['case', ['==', ['get','maxStatus'], 2], 1, dim];
  map.setPaintProperty('rest','circle-opacity', keepLeaf);
  map.setPaintProperty('trucks','icon-opacity', keepLeaf);
  map.setPaintProperty('eta','line-opacity', on ? dim : 0.9);
  map.setPaintProperty('clusters','circle-opacity', keepCluster);
  map.setPaintProperty('cluster-count','text-opacity', keepCluster);
  document.body.classList.toggle('exception-active', on); // optional: --signal viewport-edge flash in CSS
}
```

Crank loudness as far as the alarm warrants, all within the 5 tokens: dim to 0.2, enlarge the exception mark, add a `--signal` 2px viewport vignette that flashes on the 1.6s sine, or momentarily invert the exception region to `--ink-dark` ground (the driver-A2 inversion) with the mark in `--signal`. A literal sixth alarm hue is a doc-07/register amendment — do not add one silently.

## 7. The animation loop — move the fleet source once per (throttled) tick

Interpolate every truck toward its next known position; mutate the in-memory FeatureCollection in place; `setData` **once** per frame (one source update for all movers, per the "separate rapidly-updating source" guidance):

```js
function tick(ts) {
  for (const f of fleetFC.features) {  // one clustered source; movers are the truck-kind features
    const p = f.properties, [lng,lat] = f.geometry.coordinates;
    f.geometry.coordinates = [lng + (p.tlng-lng)*0.1, lat + (p.tlat-lat)*0.1]; // ease toward target
    p.bearing = bearingTo(lng, lat, p.tlng, p.tlat);
  }
  map.getSource('fleet').setData(fleetFC);   // ~20–30fps (throttle this call), not every frame; also flushes property mirrors
  if (!REDUCED) requestAnimationFrame(tick);
}
if (!REDUCED) requestAnimationFrame(tick);
```

Targets (`tlng/tlat`) come from `position.updated` ledger events (30s cadence); the ease makes 30s-sparse GPS read as continuous glide (doc 07: "duration = real elapsed, capped 800ms").

## 8. Click → lens panel; the map never navigates away

```js
map.on('click', 'trucks', (e) => openLensPanel(e.features[0].properties.shipment_id)); // right-side --ink-dark panel
map.on('click', 'clusters', async (e) => {
  const cid = e.features[0].properties.cluster_id;
  const src = map.getSource('fleet');
  // API DIVERGES: MapLibre GL v3/v4 returns a Promise<number> (the product path, shown here).
  // Mapbox GL JS still uses the CALLBACK form: src.getClusterExpansionZoom(cid, (err, z) => {...}).
  // This is one of the few places the two libraries differ — branch on which you target.
  const z = await src.getClusterExpansionZoom(cid);
  map.easeTo({ center: e.features[0].geometry.coordinates, zoom: z }); // descend into the cluster
});
map.on('mouseenter','trucks',()=>map.getCanvas().style.cursor='pointer');
map.on('mouseleave','trucks',()=>map.getCanvas().style.cursor='');
```

## 9. Cohesion / lens scoping across surfaces

Same code, three data scopes — enforced **server-side** (the lens layer, WP-02), never a client filter on a full dataset:
- **Command**: `fleetFC` = the whole tenant fleet.
- **Driver**: only this driver's assigned shipments; set the map `style` ground to `--ink-dark` (A2) — everything else identical.
- **Portal**: only this party's shipments; positions arrive **already generalized to ~city** until out-for-delivery (REQ-074). Do not receive exact coords client-side and blur them — the server sends coarse coords (the WP-02 redaction).

## Performance checklist (hold the 60fps/30fps bar, REQ-079)

- Layers not markers; ≤ ~6 entity layers total; combine by data-driven expressions.
- One `setData` per frame on the *small* live source only; static source updated only on real change.
- `setFeatureState` for status/dim — never re-`setData` the fleet to change a state.
- `promoteId` so ids survive updates; `icon-allow-overlap:true` only where needed.
- Cluster the static source; add `minzoom`/`maxzoom` to layers that don't apply at all zooms.
- `prefers-reduced-motion`: cancel both rAF loops, render one static frame, no world-dim loop.
