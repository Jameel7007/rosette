# Rosette in Tesserae

A Moroccan **zellige** panel laid by hand, one piece at a time, in the browser. It opens on an
extreme close-up of grainy mortar with the setter's red underdrawing. A single gold eight-pointed
star drops into the centre. Then 10,209 pieces follow, ring by ring and faster and faster, while the
camera pulls back. Once the square panel is finished, the light sweeps round it once and the gold
glints.

Nothing on screen is a video or a photograph. The pattern is constructed with compass-and-straightedge
geometry, cut into pieces the way a craftsman would cut glazed tile, and animated on the GPU.

## What makes it zellige

- **The pattern is real polygons, not coloured squares.** The field is drawn with Hankin's
  "polygons in contact" method on a 4.8.8 tiling of octagons and squares, at a contact angle of 67.5°.
  At the centre is a 16-fold Moorish rosette, built from its frame inward and tied to the field by
  the same angle.
- **Strapwork with interlace.** Black bands run along every line of the pattern. Where two bands
  cross, they weave over and under, alternating along each strand.
- **Cut like a craftsman.** Big regions are cut along the pattern's own lines (outline bands, inlays,
  gold darts), and slivers are merged into their neighbours. Every piece is inset by half a grout
  joint and its corners are wobbled so the edges look hand-chipped. Before grout, the 10,209 pieces
  cover the panel exactly, with no gaps and no overlaps, and the tests check that.
- **One number per frame.** All pieces live in two merged meshes. A float texture holds 16 numbers per
  piece, and a vertex shader drops each piece on its own schedule (shadows included). Per frame, the
  CPU writes a single uniform, so its cost does not grow with the number of pieces.

The full story, including the alternatives considered and likely interview questions, is in
[docs/architecture.md](docs/architecture.md). The module contracts are in
[docs/CONTRACTS.md](docs/CONTRACTS.md), and the original brief is in
[reference/ROSETTE_BRIEF.md](reference/ROSETTE_BRIEF.md).

## Run it

Requires Node 20.19+ or 22.12+ (Vite 8).

```bash
npm install
npm run dev          # dev server on http://localhost:5191
npm test             # 144 unit tests in Node (pattern engine, schedule, slabs, camera, light, governor)
npm run build        # ONE self-contained HTML file: dist/index.html (works from file://)
npm run preview      # serve dist/ on http://localhost:5196
npm run build:site   # a normal multi-file site in dist-site/
```

In the page:

- **Replay**, **Speed** (1×, 2×, 4×, 8×), **Finish**, **Sweep light** and **Sound** in the HUD.
- Drag (one finger) to turn the view, use the wheel or pinch with two fingers to zoom, and
  double-click to go back to the automatic camera.
- `?legacy=1` runs the original prototype's square tesserae, ported unchanged, for side-by-side
  comparison.
- With `prefers-reduced-motion`, the finished panel is shown at once, without the slow camera turn
  or the automatic light sweep.

## Checks in a real browser

The scripts in `scripts/` drive headless Chrome on the real GPU through `playwright-core`. They look
for the Chrome for Testing build in the Playwright cache on macOS
(`~/Library/Caches/ms-playwright`), or use `CHROME_PATH` if it is set. Screenshots go to `capture/`,
which git ignores.

| Script | What it checks |
|---|---|
| `node scripts/verify-app.mjs` | the real app from a cold dev server, through real clicks, drags, wheel and touch: the run, Finish, the light sweep and glint, close-ups, every control, reduced motion, phone size, the legacy build, and the single-file build (it runs `npm run build`, so it rewrites `dist/`) |
| `node scripts/compare-port.mjs` | the port (`?legacy=1`) against the r128 prototype, frame for frame, on a shared fake clock (needs a dev server; default `http://localhost:5193`) |
| `node scripts/check-pieces.mjs` | the GPU drop against the JavaScript reference pose, pixel by pixel, plus frame rate (needs a dev server; uses `dev/pieces.html`) |
| `node scripts/preview-panel.mjs` | flat PNG previews of the composed panel, without the 3D scene |
| `node scripts/shot.mjs <url> <out.png>` | one screenshot of any page |

## Project layout

```
index.html                 HUD markup, canvas, font loading
src/
  main.js                  boot, startup order, frame loop, HUD wiring
  config.js                every tunable number: panel size, grout, bevel, wobble, timing
  compose.worker.js        composes the panel off the main thread
  pattern/                 pure JavaScript (no three.js): runs in Node, the browser and the worker
    geom.js graph.js       plane geometry; lines -> planar graph -> faces
    strap.js cut.js        strapwork and interlace; clipping, splitting, grout, wobble
    hankin.js              the 8-fold field
    rosette16/moorish.js   the 16-fold medallion (lee.js, polar.js: alternatives kept for later)
    border.js              the border band
    compose.js             the whole panel, in laying order, plus the underdrawing
    palette.js             glaze colours and variation
  anim/                    schedule.js (start times, fast queries), camera.js, light.js
  scene/                   renderer.js, governor.js, bed.js, extrude.js, pieces.js, shaders/drop.js
  ui/hud.js  audio/clicks.js  util/rand.js
  legacy/                  the prototype's square tesserae (?legacy=1)
dev/pieces.html            harness for the GPU pieces on their own
scripts/                   headless-Chrome checks and flat previews
tests/                     unit tests (node --test)
docs/                      architecture notes and module contracts
reference/                 the owner's brief and the original single-file prototype (three r128)
```

## Built with

three.js 0.186.1 (WebGL 2), plain JavaScript ES modules, Vite with `vite-plugin-singlefile`,
`polygon-clipping` for polygon unions and intersections, and `playwright-core` for the browser
checks. Fonts: Marcellus and Spline Sans Mono from Google Fonts.

## Credits

The idea came from a viral clip by Paolo Rosson (@redp314), in which Claude
laid a Roman duck mosaic in 7,446 tiles using only browser code. This project swaps the figurative
Roman subject for Islamic geometry and the square tesserae for cut zellige.

The pattern constructions follow E. H. Hankin's polygons-in-contact method, as developed for
computers by Craig S. Kaplan; the alternative `lee.js` medallion follows A. J. Lee's rosette as
described in Kaplan's "Computer Generated Islamic Star Patterns" (Bridges 2000).

Made by Thomas Mooney ([@Jameel7007](https://github.com/Jameel7007)).
