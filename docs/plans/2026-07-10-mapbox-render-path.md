# Mapbox render path — prove the SHUDDL map on Mapbox tiles (owner token)

> Executes immediately. Deliverable = a real headless render of the SHUDDL greige map + fleet on **Mapbox** vector tiles with the owner's token, plus a config seam so the app can use Mapbox (owner preference / promo) or self-hosted MapLibre (product default, REQ-075).

**Context:** owner supplied a Mapbox public token + a Studio style URL. The style is empty (0 layers, terrain only), so we render the **SHUDDL greige style applied to Mapbox Streets v8 vectors** (schema: `road`/`water`/`place_label`/`admin`) via the token — not the empty Studio style. No token is committed; it is passed at runtime (env / inline temp file, gitignored).

**REQ-075 tension (flagged, owner decides):** REQ-075 says self-hosted vectors, no third-party branding. Mapbox is third-party branded/hosted. This path is owner-directed; the plan keeps MapLibre+OpenFreeMap as the committed default and makes Mapbox an opt-in via env token, so nothing about the product's shipped default changes without a register amendment.

### Task 1: Render SHUDDL greige + fleet on Mapbox tiles (owner token) — PROVE IT
- Build a render using Mapbox GL JS v3 + the token; style = the SHUDDL greige paint mapped onto `mapbox://mapbox.mapbox-streets-v8` source-layers (`road`→signal 5–8%, `water`→ink 6%, `place_label`→mono signal-55, `admin`→dashed signal-12); add the SHUDDL entities (chevrons/rest/exception + world-dim).
- Render headless (system Chrome + SwiftShader), **look at the PNG**, iterate until the greige-on-Mapbox map genuinely renders with streets + fleet. Token stays in a gitignored temp file.

### Task 2: Config seam in the app (no committed token)
- `packages/map`: `greigeStyleMapbox(token)` builds the greige style on Mapbox Streets v8; `MapCanvas` accepts an optional `mapboxToken` — when set (from `import.meta.env.VITE_MAPBOX_TOKEN`), use Mapbox GL JS / the Mapbox source; else the MapLibre + OpenFreeMap default. Token only ever from env, never committed (gitleaks-safe).
- Commit the code + a Mapbox render screenshot as evidence; `.env.example` documents `VITE_MAPBOX_TOKEN`. `pnpm verify` green.
