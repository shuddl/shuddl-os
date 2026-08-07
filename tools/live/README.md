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

## The evidence email (WP-06, REQ-087/129)

    pnpm exec tsx --tsconfig tools/live/tsconfig.render.json tools/live/render-email.ts

Screenshots the SENDABLE form — `renderEvidenceEmail(...).html` (tokens inlined to
literals) inside the sender's own `wrapFragment` doctype+charset wrap — so the PNG is
what a consignee's mail client renders, not the portal preview. Static html, no WebGL
flags needed. Data = the REQ-167-clean portal fixture (SHP-40206 / INV-40206 /
$1,480.00), no photo urls (the documentary placeholder slots are the stable canonical
form). `tsconfig.render.json` exists because tsx applies `jsx: react-jsx` per-file via
the tsconfig's include — it must span the @shuddl/agents + @shuddl/design .tsx sources.
Output: `tools/live/out/evidence-email.png` (committed).

## What is committed in `out/`, and what it is NOT (audit §513)

Thirteen PNGs are committed here. **None is a gate input** — the design CI's baseline is the five blessed
screenshots in `tests/visual/blessed/` (`command`, `driver`, `evidence-email`, `portal`, `status`), a
different directory with a different purpose. Nothing globs `out/`, and no code names a file in it: these
scripts take their output path from `process.argv`, so every filename here was typed on a command line.

That is why an "is it referenced?" grep reports zero for most of them and means nothing. Recorded so the
next reader does not re-run that search: an audit pass spent six runs on exactly this false trail once
already.

| file(s) | what it is |
|---|---|
| `evidence-email.png`, `portal.png`, `driver.png`, `driver-signature.png` | cited from `docs/` — the live evidence behind written claims |
| `command-app-{demotiles,mapbox,openfreemap}.png` | the tile-source comparison that caught the blank-basemap bug this README opens with — `demotiles` lacks the greige style's source-layers |
| `command-real.png`, `driver-{arrive,count,daysheet,depart,photo}.png` | per-screen renders from the same investigations |

They are kept, not pruned: they are the record of a real defect being caught by real pixels, which is the
whole argument for this harness. **If you delete one, delete the claim it supports too.**
