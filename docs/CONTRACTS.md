# Rosette in Tesserae: module contracts

This is the shared spec that every module is built against. The *why* lives in
`reference/ROSETTE_BRIEF.md` (the owner's brief) and the working prototype is
`reference/prototype.html` (Three r128, one file). Read both before changing anything.

Goal of this phase: replace the prototype's *opus tessellatum* (square tiles coloured by
position) with true **zellige**: the pattern is generated as real polygons (Hankin's method
on a 4.8.8 tiling, contact angle 67.5°, with a 16-fold rosette medallion at the centre), cut
into inset, slightly wobbled pieces, and animated by a vertex-shader drop.

## 1. Conventions

- **Units** are the prototype's: one unit ≈ one prototype tessera. Panel field is the square
  `|x|,|z| ≤ 46`; border `46..52`; mortar bed `EXT = 114` wide.
- **Plane ↔ world.** Pattern code works in a 2D plane `(x, y)`; world position is
  `(x, 0, y)` (pattern `y` → world `z`). Y is up in the world.
- **Points** are plain arrays `[x, y]`. **Polygons** are arrays of points, *not* closed (no
  repeated first point), simple, wound **counter-clockwise in the math sense** (positive
  signed area `½Σ(xᵢyᵢ₊₁ − xᵢ₊₁yᵢ)`). Note: CCW in (x, z) seen from +y is *clockwise* on
  screen and its cross-product normal points −y, so the mesh builder must flip winding for
  top faces (test it).
- **Segments** are `[[x1, y1], [x2, y2]]`.
- `src/pattern/**` is **pure JavaScript with no three.js import**, so it runs in Node for
  tests and scripts. Only `src/scene/**`, `src/anim/camera.js`, `src/anim/light.js` and
  `src/main.js` touch three.js.
- **Randomness** only from `src/util/rand.js`: `stream('pattern')`, `stream('pieces')`,
  `stream('bed')`, … never `Math.random()` (except audio noise, as in the prototype).
- Tests: `node --test tests/*.test.mjs` (`npm test`). One test file per module owner.
- ES modules everywhere; three.js is `three@0.186.1` (pinned; `three/addons/...` for addons).

## 2. Parameters (defaults; tune in one place, `src/config.js`)

| Name | Default | Meaning |
|---|---|---|
| `GROUT` | 0.12 | grout gap between pieces (each piece inset by `GROUT/2`); was 0.14, narrowed so the straps read as ribbons |
| `BEVEL` | 0.07 | bevel size on each piece's top edge |
| `HEIGHT` | 0.38 | piece thickness before per-piece scale (prototype: 0.24 + 2×0.07) |
| `WOBBLE` | 0.03 | max vertex jitter (hand-chipped edges), 0.02–0.04 |
| `FIELD.P` | 92/20 = 4.6 | 4.8.8 period (octagon centre to octagon centre); `46 = 10·P`, so the panel edge is a mirror line through octagon centres |
| `FIELD.THETA` | 67.5° | Hankin contact angle |
| `FIELD.STRAP` | 0.1·P = 0.46 | strap (outline band) width in the field |
| `MEDALLION.R_F` | ≤ 29.5 | outer radius of the medallion including its frame bands; the field is clipped outside it |
| timing | `T_START 0.9, T_SPAN 46, P_EXP 0.42, D 0.55, DROP 2.6` | the prototype's schedule: piece *i* starts at `T_START + T_SPAN·(i/N)^P_EXP`, falls `DROP` over `D` s |

## 3. Pattern pipeline (all in `src/pattern/`)

```
design modules (lines)          engine                          composition
hankin.js  ─ segments ─┐
rosette16.js ─ segments ┼→ graph.js  arrangement → faces
                        │   strap.js  faces → fills + strap runs (exact partition)
                        └→ cut.js    clip to region · split large · inset grout · wobble
                                     ↓
                               compose.js → Piece[]  → anim/schedule.js → scene/pieces.js
```

### 3.1 `geom.js`, `graph.js`, `strap.js`, `cut.js` — the engine

- `geom.js`: `area(poly)` (signed), `centroid(poly)`, `ensureCCW(poly)`, `isSimple(poly)`,
  `insetPolygon(poly, d)` (mitred inward offset; returns `null` if it degenerates),
  `wobble(poly, rand, amp)`, `circlePoly(r, n)`, `annularSector(r0, r1, a0, a1, maxSeg)`,
  `segIntersect`, small vector helpers.
- `graph.js`: `buildArrangement(segments, {eps})` → planar arrangement: splits segments at
  every crossing, merges duplicate/overlapping collinear pieces, snaps near-equal vertices,
  and returns `{ vertices, edges, faces }` where each bounded face is
  `{ id, poly (CCW), verts (vertex ids in order), area, centroid }` (outer face excluded).
- `strap.js`: `strapwork(arr, opts)` → `{ fills, straps }`, an **exact partition** of the
  plane covered by the bounded faces plus half a strap width outside the outer boundary:
  - each face shrunk by `width/2` (mitred: strap edges stay parallel to the centre lines)
    → one **fill** `{ poly, faceId }`;
  - the bands along edges → **strap** pieces `{ poly, edgeIds, over }`, built from the
    shrunk-face corners around each edge, with a junction polygon at each vertex of degree ≥ 3;
  - `interlace: true` → at each 4-way crossing one strand passes over: its junction merges
    with the two edge bands on that strand into one long piece, the other strand is cut by
    grout. Over/under alternates along every strand (2-colour the faces; requires even
    degree, fall back to separate junctions where it isn't);
  - strap **runs** continue through degree-2 vertices whose turn is under `runTurnDeg`
    (e.g. a circle drawn as many short segments), then are cut across into pieces of about
    `targetLen` (never cutting through an over-crossing junction).
- `cut.js` (uses `polygon-clipping`): `clipPieces(pieces, {inside, outside})` (intersect
  with region polygons / subtract hole polygons; one input can yield several outputs; drops
  slivers below `minArea`), `splitStar(poly, centre, mode)` (radial: `centre+points` or
  `wedges:n`), `splitRun(poly, targetLen)`, `bandPieces({r0, r1, count, a0})` (annular
  sectors), `finishPieces(pieces, {grout, wobble, rand})` (inset by `grout/2`, wobble, validate:
  simple, CCW, area > min; never let wobble create self-intersection).
- Validation helpers: `checkPartition(pieces, regionArea)` (areas sum, no overlaps — spatial
  hash + polygon-clipping intersection) used by tests.

### 3.2 Design modules (lines + colouring)

A **design** produces centre lines and tells the composition how to colour/label faces:

```js
// src/pattern/hankin.js — the 8-fold field
buildField({ P, theta, bounds: {halfW, halfH}, strap }) → {
  segments,                 // Hankin centre lines covering bounds + one period of margin
  strap,                    // strap width
  classify(face) → { key, stage, kind },   // 'star8' | 'star4' | 'hex' | ...
  baseTiling,               // { octagons: Poly[], squares: Poly[] } for the sinopia drawing
}

// src/pattern/rosette16.js — the 16-fold medallion
buildRosette(opts) → {
  segments,                 // centre lines inside the medallion disk (radius R_M)
  strap,
  classify(face) → { key, stage, kind, layer, split },  // split: 'none' | 'centre+points' | 'wedges:n' | 'run'
  R_M,                      // radius of the strapwork disk (faces are clipped to it)
  bands: [{ r0, r1, key, stage, count }],   // frame rings outside R_M, cut into `count` sectors (multiple of 16)
  R_F,                      // outer radius of the last band
  sinopia: { circles: number[], lines: Segment[] },   // construction lines for the underdrawing
}
```

Lines must be **constructed** (compass-and-straightedge logic, Hankin rays, Lee's rosette —
see `~/Code/from-the-point/src/geometry/{hankin,rosette,tilings}.ts`), never traced
coordinates.

### 3.3 `Piece` — the output of `compose.js`

```js
{
  poly,      // final outline (inset by GROUT/2, wobbled), CCW, ≥ 3 points
  key,       // palette key: W K B T G O R A (see palette.js)
  stage,     // HUD label, e.g. 'Central 16-point star', 'Petal kites', 'Eight-point stars', 'Border'
  kind,      // 'fill' | 'strap' | 'band' | 'border' | ...
  seq,       // laying-order key: sort ascending = laying order
  cx, cy,    // area centroid
  rc,        // centroid distance from the centre
  r,         // max vertex distance from the centre (camera framing)
  ang,       // atan2(cy, cx)
}
```

**Laying order** (brief §3.5): centre piece first, then one ring at a time, slow at first;
within a ring, sweep around in one direction like a craftsman's hand; the field by distance
from the centre with a small random jitter so it reads as a growing front.

## 4. Animation and rendering

### 4.1 `src/anim/schedule.js`

```js
makeSchedule(pieces, { T_START, T_SPAN, P_EXP, D }) → {
  pieces,                   // sorted by seq (pieceId = index in this array)
  t0: Float32Array,         // start time per sorted piece
  N, D, T_END,
  startedAt(sim) → int,     // # pieces with t0 ≤ sim          (binary search)
  landedAt(sim) → int,      // # pieces with t0 + D ≤ sim      (binary search)
  stageAt(sim) → string|null,
  rLaidAt(sim) → number,    // max piece.r among started pieces (prefix max)
}
```

No per-frame loop over pieces anywhere: the frame cost must not grow with N on the CPU.

### 4.2 `src/scene/pieces.js` (+ `src/scene/shaders/`)

```js
createPieces(schedule, { envMap, rand }) → {
  group,            // THREE.Group: one merged mesh per material (glaze, gold)
  setSim(sim),      // sets a uniform; that is the whole per-frame cost
  stats,            // { pieces, vertices, triangles }
  dispose(),
}
```

- Each piece's outline is extruded into a chunky glazed slab (top cap, rounded bevel,
  sides, bottom) directly into merged, indexed buffers grouped by material. Vertices are
  stored at the piece's **final** world position. Attributes: `position`, `normal`, `pieceId`.
- A float **data texture** holds per-piece data: `t0`, pivot (centroid), tumble
  (`fx, fz, spin`), final tilt (`rx, rz`), sink `yb`, height scale `sy`, roughness, linear colour,
  and a facet gain (gold only: the top face is shaded as if tilted further along `rx, rz`).
- Two index lists over the same vertices: the full slab, and a far-view one without the bevel's
  middle rings, swapped by `setDetail(pxPerUnit)` once the bevel is under ~1 px on screen.
- The **drop runs in the vertex shader** (`onBeforeCompile` on `MeshStandardMaterial`), with
  the prototype's exact pose: for `p = (uSim − t0)/D`: before 0 the piece is collapsed (no
  fragments); `p < 0.8`: `q = p/0.8, y = DROP(1−q²), f = 1−q`; else `q = (p−0.8)/0.2,
  y = 0.06 sin(πq), f = 0`; rotation `(rx + fx·f, spin·f, rz + fz·f)` about the pivot,
  height scaled by `sy`, lifted by `yb + y`. Normals rotate with it.
- **Shadows must animate too**: the same vertex code in a `customDepthMaterial`
  (`MeshDepthMaterial`, `RGBADepthPacking`), so falling pieces cast moving shadows and
  pieces that haven't started cast none.
- Glaze: subtle procedural normal ripple on top faces (reflections wobble), roughness
  0.15–0.35 per piece. Gold: metalness 1, per-piece tilt so pieces glint at different moments.
- Colour per piece from `palette.js` with `VARIATION` jitter applied in **sRGB** HSL.

### 4.3 What `main.js` needs from the tile system

`main.js` talks to one object so the prototype's tiles and the zellige pieces are
interchangeable:

```js
{ count, T_END, update(sim), startedAt(sim), landedAt(sim), stageAt(sim), rLaidAt(sim), reset() }
// optional (the zellige pieces have them, the legacy tiles do not):
//   rCoveredAt(sim)      radius inside which every piece has landed (the bed hides its sinopia there)
//   setDetail(pxPerUnit) full or far-view slabs
```

## 5. three r186 porting notes (prototype was r128)

1. Lighting is physically based only (legacy mode is gone): multiply `DirectionalLight`,
   `HemisphereLight` and `AmbientLight` intensities by π to match the r128 look.
2. `ColorManagement` is on: `new Color('#hex')` / `.set('#hex')` convert sRGB → linear
   automatically, so drop the prototype's manual `convertSRGBToLinear()` on hex colours.
   `new Color(r, g, b)` with numbers is taken as linear, as before. `offsetHSL/getHSL/setHSL`
   default to the linear working space — pass `THREE.SRGBColorSpace` to jitter in sRGB like
   the prototype did.
3. `renderer.outputEncoding` → `outputColorSpace` (sRGB is the default);
   `texture.encoding = sRGBEncoding` → `texture.colorSpace = THREE.SRGBColorSpace`.
4. When a material gets its environment from `scene.environment` (no own `envMap`), r163+
   uses `scene.environmentIntensity` instead of the material's `envMapIntensity`. Give each
   material `envMap` explicitly so the prototype's per-material intensities still apply.
   (Verify against `node_modules/three/src/renderers/WebGLRenderer.js`.)
5. `PCFSoftShadowMap` has been **removed** in r186 (it warns and falls back to
   `PCFShadowMap`, which now samples a hardware depth texture). Use `PCFShadowMap` (tune
   `shadow.radius` if it softens) and keep the prototype's soft look. `customDepthMaterial`
   is still honoured for directional-light shadows (`WebGLShadowMap.getDepthMaterial`).
   Check the console for any other deprecation warnings and resolve them.

## 6. Verification

- Dev server: `npm run dev -- --port <yours> --strictPort` (5191 is the app's registered port).
- Headless Chrome on the GPU: `scripts/lib/browser.mjs` (`launch()`), and
  `node scripts/shot.mjs <url> <out.png> [--w --h --wait --eval --evalWait]`.
- `window.__seek(t)` jumps the simulation clock (dev aid only; real-input checks use the HUD
  buttons and pointer events). `window.__pixelRatio()` reads the pixel ratio the performance
  guard (`scene/governor.js`) is using.
- Gold vs glaze in a rendered frame: scripts/verify-app.mjs `glint` draws a mask frame with the
  same camera through three's devtools hook (no change to src/), since honey ochre and gold are
  too close in colour to separate by hue.
- Measure rendered output (screenshots, pixel stats, fps), not internal state.
