# Rosette in Tesserae: project brief for Claude Code

## 1. What this is

A browser-only 3D animation of an Islamic mosaic being laid piece by piece. It starts as an extreme close-up of a single center piece pressed into mortar. Then tiles drop in one at a time, ring by ring, faster and faster. The camera pulls back as the piece grows, until a whole square panel is finished, and it ends with a light sweep that makes the gold pieces glint.

It was inspired by a viral clip (Paolo Rosson, @redp314) in which Claude laid a Roman duck mosaic in 7,446 tiles using only browser code. Our version swaps the figurative Roman subject for Islamic geometry.

**Current state:** a working single-file prototype, `rosette.html`, about 450 lines. It uses Three.js r128 from the cdnjs CDN. It lays 10,665 tiles in about 47 seconds at 1× speed.

**Goal of the next phase:** turn it from *opus tessellatum* (square tiles colored by position) into true **zellige**, where every piece is cut to its exact geometric shape. Also move it into a proper project structure, polish the look, and add video export.

---

## 2. How the prototype works (plain-language map)

### 2.1 The pattern is a color function
`colorAt(x, z)` returns a color key and a stage name for any point on the floor. Tiles are placed first, then each tile asks "what color am I?" based on where its center sits.

| Zone | Rule | Stage label |
|---|---|---|
| r < 0.72 | white center piece | The center point |
| 0.72 to 1.78 | 8 black wedges | The center point |
| 1.78 to 2.92 | 16 gold pieces | First gold ring |
| 2.92 to 11 | 8-point star (`starR`), turquoise core, lapis fill, black outline, white ground | Eight-point star |
| 11 to 14 | black / gold / black rings | Framing rings |
| 14 to 21 | 16 pointed petals, green fill, turquoise midrib, black outline, terracotta dots between | Sixteen petals |
| 21 to 25 | black ring, then 32-tooth lapis sawtooth | Sawtooth band |
| 25 to 31 | black / gold / terracotta / black rings, then white halo | Outer rings |
| square field to ±46 | star-and-cross lattice (spacing 46/4.5), alternating lapis/turquoise stars, ochre cross centers | Star-and-cross field |
| ±46 to ±52 | black line, terracotta/white triangle band, black line, gold edge, 3×3 corner squares | Border |

Palette keys: `W` cream, `K` manganese black, `B` lapis, `T` turquoise, `G` green, `O` ochre, `R` terracotta, `A` gold (metallic).

### 2.2 Tile layout ("andamento", the direction the tile rows run)
- **Center (57 pieces):** real wedge-shaped pieces cut along rings. Rings have 1, 8, 16, 24 and 32 pieces. Each is its own mesh, made with `ExtrudeGeometry` (a flat outline pushed up into a slab with beveled edges).
- **Rosette rings r = 5 to 31 (about 3,000 tiles):** one row per unit of radius. The tile count per ring is a multiple of 16, so the 16-fold symmetry holds, and alternate rings are offset by half a tile so the joints stagger like real mosaic.
- **Field and border (about 7,600 tiles):** a straight 1×1 grid that skips anything inside r < 31.8.

### 2.3 Rendering
- **Instancing:** one shared beveled tile shape drawn thousands of times, with a per-tile position, rotation, scale and color. There are two instanced meshes, glazed and gold, which keeps it fast.
- **Materials:** `MeshStandardMaterial`. Glaze uses roughness 0.24, metal 0. Gold uses metal 1, roughness 0.24. Reflections come from a made-up environment: a sphere with a light gradient plus three bright "window" panels, baked with `PMREMGenerator`. Without it, the gold would look dark brown.
- **Light:** one warm directional "sun" with soft shadows, plus a soft hemisphere fill. The shadow box shrinks and grows with the camera so the shadows stay sharp in the close-up.
- **Mortar bed:** a 2048px canvas texture (noise, aggregate grains, pits) and a matching bump texture for surface relief. The red underdrawing (sinopia) is painted on the same canvas, so the tiles cover it as they land. A low stone curb and an outer floor sit around the bed.
- **Tone mapping:** ACES filmic, exposure 0.92, sRGB output.

### 2.4 Animation
- **Schedule:** tile *i* starts at `0.9 + 46 × (i/N)^0.42` seconds. The power curve makes the first tiles slow and deliberate (the first 9 take about 2.5 s) and the outer field fast.
- **Drop:** each tile falls 2.6 units over 0.55 s with gravity easing, tumbles slightly and settles, then gets a tiny 0.06 bounce.
- **Active window:** only tiles in flight are updated each frame (pointers `lo` and `hi` into the sorted list).
- **Camera:** framing follows the radius laid so far, eased toward its target. The view starts at 24° elevation and close, and ends at about 64° and wide. It turns slowly as it goes. The user can drag, scroll and double-click to adjust the view on top of the automatic path.
- **Finale:** when the last tile lands, the light orbits once over 11 s and drops low partway through, so the gold glints.
- **HUD:** tile counter, stage name, progress bar, and Replay / Speed (1, 2, 4, 8×) / Finish / Sweep light / Sound buttons. Sound is a filtered noise click per landing, throttled, generated with WebAudio.

### 2.5 Known weaknesses
1. **Edges look stepped.** Color comes from the tile's center, so the petals and field stars come out jagged and look pixelated. This is the main problem.
2. **The field is a flat grid.** In real mosaic, the rows bend around each motif (contour rows). Here they don't.
3. **There's a gap ring at r 31 to 31.8,** where the circular rows meet the square grid. Bare mortar shows through.
4. **Tiles are perfect boxes,** so the surface doesn't have the hand-made wobble of real glaze.
5. **Everything is in one file**, so it's hard to extend.

---

## 3. Next phase: true zellige

### 3.1 The core change
Generate the pattern as **actual polygons first**, then cut each polygon into pieces. This replaces "place squares, then color them".

Zellige vocabulary to model:
- **Star pieces:** 8-point (and later 12- and 16-point) stars, one piece each when small, or split into a center plus points when large.
- **Kites, darts, "bows" (the shape called *saft*), crosses, hexagonal "candies".** These are the standard cut shapes that fill between the stars.
- **Strapwork outline:** the black or white bands that run between shapes as interlaced straps. They are cut as thin parallelogram pieces.

### 3.2 Pattern generation, recommended approach
Use **Hankin's "polygons in contact" method**, which is the standard construction for Islamic star patterns:
1. Start from a base tiling: squares + octagons (4.8.8) for the 8-fold field. Later add hexagons for 6/12-fold and the 16-fold central rosette.
2. From the midpoint of every edge, draw two rays at a contact angle θ (start at 67.5° for 8-fold) into the polygon.
3. Extend each ray until it meets its neighbor. The resulting line segments are the strap centerlines.
4. Offset each centerline by ± half the strap width to get the strap polygons. The regions left between the straps are the star, kite and cross pieces.
5. Use a polygon-clipping library to do the boolean operations reliably: `clipper-lib` / `clipper2-js`, or `polygon-clipping` from npm.

For the **central rosette**, construct a 16-point rosette explicitly (classic *Moorish* rosette): a central 16-point star, a ring of 16 kite "petals", then a ring of 16 bows, using polar construction. Fit it into the 8-fold field with transition pieces. The From the Point project already has this construction logic. Reuse it.

### 3.3 Cutting pieces
- A small region becomes one piece.
- A large region (big star, wide strap) gets split into several pieces: radially for stars, along the length for straps, with a target piece size of about 1 unit.
- **Inset** every piece outline by half the grout width (about 0.06 to 0.08) before extruding.
- **Wobble:** jitter each vertex by about 0.02 to 0.04 so the edges look hand-chipped, not laser-cut.

### 3.4 Geometry and rendering
- Each piece has a unique outline, so instancing a single shape no longer works. Options:
  - **(Preferred)** Merge all pieces into a few large buffers grouped by material (glaze, gold). Store a per-vertex `pieceId` attribute, and give the shader a small data texture with each piece's start time and final transform. The drop animation then runs in the vertex shader (the GPU program that positions every corner of every shape), with no per-frame CPU work. This handles 20k+ pieces easily.
  - (Simpler) Group pieces by repeated shape. Zellige repeats shapes heavily, so instance each shape type (all identical kites share one mesh with many copies). This works because most pieces are copies of about 10 to 30 shapes.
- **Glaze:** add a subtle normal-map ripple (a texture that fakes tiny bumps in the lighting) so reflections wobble the way real zellige does. Vary roughness per piece (0.15 to 0.35) through the data texture.
- **Glaze color:** real zellige has strong tile-to-tile variation, especially in the greens and blues. Increase the lightness jitter to about ±8% and add rare darker or lighter "kiln" pieces.
- **Gold:** keep it metallic and add a slight per-piece tilt so each one catches the light at a different moment during the sweep.
- **Lighting:** consider a real HDR environment map, bundled locally (e.g. a Poly Haven interior HDRI, converted with `RGBELoader`), so reflections look like a room with a window.

### 3.5 Laying order (the "storytelling")
Keep the current feel:
1. Center piece, then one ring at a time, slow at first.
2. Inside a ring, go around in one direction, like a craftsman's hand.
3. For the field, order by distance from the center, with a small random jitter so it reads as a growing front rather than perfect circles.
4. Optional: lay all the strapwork for a region first and fill the colored pieces after. That matches how zellige panels are actually assembled, face down, then flipped. A **"flip reveal"** finale is a strong option: build the panel face-down, then flip it over.

### 3.6 Stage labels
Update `stage` names to the zellige terms, for example: *Central 16-point star, Petal kites, Bows, Strapwork, Eight-point stars, Crosses, Border*.

---

## 4. Project structure (move off the single file)

```
rosette/
  index.html
  package.json            # vite, three (pin a version, e.g. 0.16x), polygon-clipping
  src/
    main.js               # boot, loop, HUD wiring
    pattern/
      hankin.js           # base tilings + contact-angle construction
      rosette16.js        # central rosette construction
      cut.js              # region → pieces, inset, wobble
      palette.js
    scene/
      renderer.js         # renderer, tone mapping, env map
      bed.js              # mortar canvas, sinopia drawing, curb
      pieces.js           # merged geometry + data texture, materials
      shaders/drop.glsl   # vertex-shader drop animation
    anim/
      schedule.js         # timing curve, order
      camera.js           # framing path + user orbit
      light.js            # sweep
    ui/hud.js
    audio/clicks.js
    export/record.js      # video capture
```

Use ES modules and current Three.js (`three/addons/...` for loaders). Keep a `npm run build` step that produces **one self-contained HTML file** (`vite-plugin-singlefile`) so it can still be shared as a single page.

---

## 5. Features to add

| Priority | Feature | Notes |
|---|---|---|
| P0 | Polygon-based zellige pattern | Section 3. The point of this phase. |
| P0 | Fix the circle-to-square transition | Zellige handles this naturally with transition pieces; no bare ring. |
| P1 | Video export | `canvas.captureStream(60)` + `MediaRecorder` (WebM). Add a deterministic "render mode" that steps a fixed 1/60 s per frame, so the export is smooth even on slow machines. Offer 1080×1080 and 1080×1920 (Reels/TikTok). |
| P1 | Pattern presets | 8-fold (current), 12-fold (Alhambra style), 16-fold rosette center. Dropdown in the HUD. |
| P1 | Palette presets | Fez (blue/green/white), Marrakesh (terracotta/ochre/green), Alhambra (blue/ochre/black/white), Umayyad gold. |
| P2 | Hand / trowel | A simple pair of tweezers or fingertips that places each early tile, hidden once the speed goes up. |
| P2 | Dust puff on landing | A small particle burst on the first ~100 tiles only. |
| P2 | Seeded randomness | URL `#seed` token so a specific version can be reshared. |
| P2 | Performance guard | Detect low FPS and drop shadow map size / pixel ratio automatically. |

---

## 6. Acceptance checks

- The opening frame looks like the reference: low-angle close-up, grainy mortar, red guide line, a few chunky glazed pieces with real shadows.
- Star edges are straight and crisp at full zoom-out, with no stepped look.
- At least 8,000 pieces, 60 fps on a mid laptop at 1× speed, with no per-frame CPU loop over all pieces.
- The finished panel reads clearly as zellige from straight overhead (fill the screen and compare with a photo of a Fez fountain panel).
- The gold visibly glints during the light sweep.
- It works at phone width, and the HUD doesn't cover the center of the panel.
- Video export produces a smooth file with no dropped frames.

---

## 7. Starter prompt for Claude Code

> Read `ROSETTE_BRIEF.md` and `rosette.html` (the working prototype). Set up the Vite project structure in section 4, porting the prototype's bed, lighting, camera path, HUD and audio unchanged. Then implement section 3: generate an 8-fold zellige pattern as real polygons with Hankin's method (4.8.8 base tiling, contact angle 67.5°), with a 16-point rosette at the center, cut into inset, slightly wobbled pieces, and animate them with the vertex-shader drop. Keep the current laying order and timing curve. Show me a screenshot of the opening close-up and the finished overhead view before moving on to the section 5 features.
