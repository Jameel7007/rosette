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
- **Video export with no dropped frames.** The piece can be rendered into an MP4 for Reels, TikTok or a
  portfolio. It is not a screen recording: every frame is rendered on a fixed 1/60 s step and handed to
  the browser's video encoder (WebCodecs) with its exact timestamp, and the landing clicks are
  rendered offline to match. A slow machine just takes longer.

The full story, including the alternatives considered and likely interview questions, is in
[docs/architecture.md](docs/architecture.md). The module contracts are in
[docs/CONTRACTS.md](docs/CONTRACTS.md), and the original brief is in
[reference/ROSETTE_BRIEF.md](reference/ROSETTE_BRIEF.md).

## Run it

Requires Node 20.19+ or 22.12+ (Vite 8).

```bash
npm install
npm run dev          # dev server on http://localhost:5191
npm test             # 173 unit tests in Node (pattern engine, schedule, slabs, camera, light, governor, export)
npm run build        # ONE self-contained HTML file: dist/index.html (works from file://)
npm run preview      # serve dist/ on http://localhost:5196
npm run build:site   # a normal multi-file site in dist-site/
```

In the page:

- **Replay**, **Speed** (1×, 2×, 4×, 8×), **Finish**, **Sweep light**, **Sound** and **Export video**
  in the HUD.
- Drag (one finger) to turn the view, use the wheel or pinch with two fingers to zoom, and
  double-click to go back to the automatic camera.
- `?legacy=1` runs the original prototype's square tesserae, ported unchanged, for side-by-side
  comparison.
- With `prefers-reduced-motion`, the finished panel is shown at once, without the slow camera turn
  or the automatic light sweep.

## Export a video

From the page:

1. Wait until **Export video** in the HUD is enabled (the pieces are built), and click it.
2. Pick a **Format**: Vertical 1080×1920 (Reels, TikTok), Square 1080×1080 or Landscape 1920×1080.
   Pick a **Speed**: 1× (1:01) or 2× (0:37; the light sweep at the end keeps its real length). Choose
   **Title and counter** (burned into the picture) and **Sound** (the landing clicks).
3. The line under the options says what this browser will make, for example
   "1080×1920 · 60 fps · MP4 · H.264 + AAC", and any caution (Firefox: Opus sound instead of AAC;
   WebM where there is no H.264; a real-time recording that may drop frames where there is no
   WebCodecs).
4. Press **Start**. The HUD hides and the frames are shown as they are encoded, with progress, time
   elapsed and time left. **Cancel** stops it. (The real-time fallback also needs the tab kept in
   front, and says so.)
5. Press **Download** (the file is named like `rosette-1080x1920-1x.mp4`), then **Close**. The live
   piece carries on where it was. The video stays downloadable from the panel ("Download last video")
   until you start another, and leaving the page before downloading asks first.

On the development machine (Apple M2 Pro), Chrome makes a 1× video in about 23 to 25 seconds and a 2×
video in about 15. At 1× the files are about 170 to 200 MB (H.264 at a constant quantizer of 22, chosen
for the fine grout lines); Firefox takes about a minute for a 2× video. Escape closes the panel, except
during an export. The button is hidden in `?legacy=1`.

From a script, through the same panel in a headless browser (Chrome unless you say otherwise), with
the file then checked:

```bash
npm run record -- --preset vertical --speed 1 --sound
npm run record -- --preset square --speed 2 --no-overlay --browser firefox
npm run check-video -- capture/video/vertical-1x-sound.mp4 --preset vertical --speed 1 --sound --frames
```

`npm run record` options: `--preset vertical|square|landscape`, `--speed 1|2`, `--sound`,
`--no-overlay`, `--browser chromium|firefox|webkit`, `--throttle N` (slow Chrome's CPU N×; Chrome only),
`--reduced` (reduced motion), `--viewport 1280x800`, `--dpr 2`, `--tag name`, `--no-check`. It starts its
own Vite dev server on `--port` (default 5193) unless you pass `--base http://localhost:PORT`, or
`--url file:///…/dist/index.html` for the single-file build. It opens a fresh page, clicks Export video,
the format and speed chips and Start, clicks Download, and saves to `capture/video/<tag>.mp4` with a
`<tag>.record.json` and screenshots (before, panel, during, done, after). Then it runs `check-video` on
the file (exit code 1 if any check fails), which writes `<tag>.check.json` and, with `--frames`, six
stills to `capture/video/frames/`.

`check-video` measures the file, not the app: codec, size and frame rate; frame count against the
export plan; every frame's time exactly k/60; no repeated frame while pieces are moving; no one-frame
flicker; and, with sound, the clicks in sync with their landing frames as both ffmpeg and Apple's
AVFoundation decode them. Both scripts need `ffprobe` and `ffmpeg` in `/opt/homebrew/bin`
(`check-video` also takes `FFPROBE` and `FFMPEG`); the AVFoundation check runs on macOS when a Swift
compiler is available and is skipped otherwise. `--browser firefox` and `webkit` use Playwright's own browser builds from its cache.

How it works, and why it is built that way, is in section 7 of
[docs/architecture.md](docs/architecture.md#7-video-export).

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
| `npm run record -- …` | a video made through the real Export panel, downloaded and then checked (see [Export a video](#export-a-video)) |
| `npm run check-video -- <file> …` | an exported file measured against the export plan: frames, timing, repeats, flicker, sound sync |
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
  export/                  video export: plan.js (timeline, encoder choice), record.js (frame-stepped
                           encoding), audio.js (offline clicks), overlay.js, mp4.js, mediabunny.js
  ui/                      hud.js, export-panel.js, eta.js
  audio/clicks.js  util/rand.js
  legacy/                  the prototype's square tesserae (?legacy=1)
dev/pieces.html            harness for the GPU pieces on their own
scripts/                   headless-Chrome checks, video recording and checking, flat previews
tests/                     unit tests (node --test)
docs/                      architecture notes and module contracts
reference/                 the owner's brief and the original single-file prototype (three r128)
```

## Built with

three.js 0.186.1 (WebGL 2), plain JavaScript ES modules, Vite with `vite-plugin-singlefile`,
`polygon-clipping` for polygon unions and intersections, `mediabunny` 1.61.0 for writing MP4 and WebM
files from WebCodecs, and `playwright-core` for the browser checks (with ffmpeg for measuring the
exported videos). Fonts: Marcellus and Spline Sans Mono from Google Fonts.

## Credits

The idea came from a viral clip by Paolo Rosson (@redp314), in which Claude
laid a Roman duck mosaic in 7,446 tiles using only browser code. This project swaps the figurative
Roman subject for Islamic geometry and the square tesserae for cut zellige.

The pattern constructions follow E. H. Hankin's polygons-in-contact method, as developed for
computers by Craig S. Kaplan; the alternative `lee.js` medallion follows A. J. Lee's rosette as
described in Kaplan's "Computer Generated Islamic Star Patterns" (Bridges 2000).

Made by Thomas Mooney ([@Jameel7007](https://github.com/Jameel7007)).
