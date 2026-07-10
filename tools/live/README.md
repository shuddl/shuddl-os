# Live render verification (keyless, real browser)

Renders the actual built app in headless system Chrome against **live OpenFreeMap
vectors** (no Mapbox key; OpenMapTiles schema matches `greige-style.json`). This is
the real-pixel proof the unit tests can't give — it caught a shipped bug (the demo
tile source was `demotiles`, whose schema lacks the greige style's source-layers, so
the basemap rendered blank).

## Run
    pnpm --filter @shuddl/command build
    (cd apps/command && python3 -m http.server 8898 --directory dist &)
    node tools/live/render-app.mjs http://localhost:8898/ tools/live/out/command.png

Headless Chrome needs software WebGL flags (`--use-angle=swiftshader
--enable-unsafe-swiftshader`); `--disable-gpu` alone renders BLANK (no WebGL).
Evidence PNGs in `tools/live/out/`.
