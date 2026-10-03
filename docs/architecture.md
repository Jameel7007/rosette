# How Rosette in Tesserae works

A plain-language walk through the code: what the piece does, how a drawing of lines becomes ten
thousand cut tiles that fall into place, and why it is built the way it is. It is written for a
smart reader who is not a graphics specialist. File names are given throughout so every claim can
be checked in the code; numbers marked "measured" come from the project's own scripts on the
development machine (an Apple M2 Pro laptop), not from a spec sheet.

Contents

1. [What the piece does](#1-what-the-piece-does)
2. [The big picture](#2-the-big-picture)
3. [From lines to tiles: the pattern pipeline](#3-from-lines-to-tiles-the-pattern-pipeline)
4. [The GPU side](#4-the-gpu-side)
5. [Porting the prototype from three r128 to r186](#5-porting-the-prototype-from-three-r128-to-r186)
6. [Trade-offs and alternatives considered](#6-trade-offs-and-alternatives-considered)
7. [Testing and verification](#7-testing-and-verification)
8. [Status, open questions and limits](#8-status-open-questions-and-limits)
9. [Glossary](#9-glossary)
10. [Ten likely interview questions](#10-ten-likely-interview-questions)

---

## 1. What the piece does

A browser page that shows a Moroccan **zellige** panel being laid by hand, one piece at a time,
from the centre outward. Nothing is a video: every piece is generated, cut and animated by code
in the page.

What you see, in order:

1. **The opening.** An extreme close-up, 24° above a bed of grainy mortar. The setter's red
   underdrawing (the *sinopia*) is already on the mortar. A small gold eight-pointed star, the
   *khatam*, drops into the middle and settles with a tiny bounce, casting a real shadow.
2. **The laying.** Piece after piece follows, slowly at first (the first ten start over 2.4
   seconds), then faster and faster. Piece *i* of *N* starts at `0.9 + 46·(i/N)^0.42` seconds,
   the prototype's curve. The central medallion goes down ring by ring, each ring swept round in
   one direction like a craftsman's hand; then the field and the border spread out as a ragged,
   growing front.
3. **The pull-back.** The camera follows how far the laid area reaches. It eases out and rises
   from the 24° close-up to about 65°, turning slowly as it goes.
4. **The finish.** All 10,209 pieces have landed at about 47.4 seconds (at 1× speed). 1.2 seconds
   later the sun makes one 11-second orbit around the panel, and the gold pieces glint.

The HUD shows a counter, the name of the stage being laid ("Petal kites", "Bows", "Eight-point
stars", ...), a progress bar, and buttons: Replay, Speed (1×, 2×, 4×, 8×), Finish, Sweep light and
Sound. One finger or the mouse turns the view, the wheel or a two-finger pinch zooms, and a
double-click puts the camera back on its automatic path.

**Where it came from.** The project started as a single-file prototype (`reference/prototype.html`,
three.js r128, about 450 lines). It laid square tiles and coloured each one by asking "what colour
is the pattern under my centre?" That is Roman *opus tessellatum*, and its curves come out stepped,
like pixels. This phase turned it into true zellige: the pattern is generated as exact polygons
first, and the tiles are cut from those polygons, the way a craftsman cuts glazed tile to shape.

|                  | Prototype (`?legacy=1`)                    | Now (default)                                     |
|------------------|--------------------------------------------|---------------------------------------------------|
| Pattern          | a colour function of floor position        | real polygons: Hankin's method + a 16-fold medallion |
| Tiles            | 10,665 tiles, nearly all squares           | 10,209 pieces, each cut to its exact shape          |
| Edges            | stepped                                    | straight and crisp, with hand-chipped wobble        |
| Animation        | CPU loop over the tiles in the air         | vertex shader on the GPU; the CPU writes one number |
| three.js         | r128, one file                             | r186, ES modules, Vite                              |

The prototype is still in the app at `?legacy=1`, kept faithful on purpose, so the new build can
be compared with it side by side and measured against it.

---

## 2. The big picture

The program has two phases: **build once**, then **draw every frame**.

```
 BUILD ONCE (about half a second, mostly in a Web Worker)

  hankin.js ── field lines ──┐
  moorish.js ─ medallion ────┼─► compose.js ──► 10,209 Piece objects ──► schedule.js
  border.js ── border pieces ┘   (pure JavaScript,  {poly, key, stage,      start time t0
                                  no three.js)        seq, ...}             for every piece
                                                                               │
                                                                               ▼
                                       pieces.js + extrude.js: two merged meshes (glaze, gold)
                                       + one float "data texture" with 16 numbers per piece

 EVERY FRAME

  main.js:  sim += dt × speed ──► write ONE uniform (uSim) ──► vertex shader poses every piece
                              └─► binary searches over t0 ──► HUD count, stage label, camera
```

The rule that makes the second half cheap: **a piece's position is a pure function of the clock.**
Given `sim` (simulation time in seconds) and the piece's own fixed numbers, the GPU can work out
where the piece is. So nothing on the CPU has to remember or update per-piece state.

### Module map

| Path | What it does |
|---|---|
| `src/config.js` | every tunable number in one place: panel size, grout, bevel, wobble, field period, timing |
| `src/pattern/geom.js` | plane geometry: areas, centroids, mitred inset, wobble, circles |
| `src/pattern/graph.js` | turns a soup of line segments into a planar graph and its faces |
| `src/pattern/strap.js` | turns faces into strapwork (black bands) and fills (coloured pieces), with over/under |
| `src/pattern/cut.js` | clipping, splitting large pieces, grout inset + wobble, merging slivers, partition checks |
| `src/pattern/hankin.js` | the 8-fold field: 4.8.8 tiling + Hankin's rays at 67.5° |
| `src/pattern/rosette16/moorish.js` | the 16-fold medallion (the owner's choice) and its cuts |
| `src/pattern/rosette16/lee.js`, `polar.js` | two other medallion designs, kept for later |
| `src/pattern/border.js` | the border band from 46 to 52 units |
| `src/pattern/compose.js` | puts the three together, cleans up, orders, finishes, draws the sinopia spec |
| `src/pattern/palette.js` | glaze colours, the gold key, colour variation |
| `src/compose.worker.js` | runs `composePanel()` off the main thread |
| `src/anim/schedule.js` | start times and O(log N) "how far along are we?" queries |
| `src/scene/extrude.js` | outlines → chunky bevelled slabs, written straight into typed arrays |
| `src/scene/pieces.js` | merged meshes, the data texture, materials, shader injection |
| `src/scene/shaders/drop.js` | the GLSL for the drop, the glaze ripple and the gold facets |
| `src/scene/renderer.js` | renderer, scene, camera, reflection environment, lights, pixel-ratio ceiling |
| `src/scene/governor.js` | the performance guard: lowers the pixel ratio if frames are slow |
| `src/scene/bed.js` | the mortar bed, its sinopia layer, curb, floor |
| `src/anim/camera.js` | the automatic camera path plus drag, wheel and pinch |
| `src/anim/light.js` | the sun, the light sweep, the shadow box |
| `src/ui/hud.js` | the HUD and the area-weighted stage label |
| `src/audio/clicks.js` | landing clicks, synthesised with WebAudio |
| `src/legacy/` | the prototype's square tesserae, ported unchanged |
| `src/main.js` | boot, startup order, the frame loop, button wiring |

Two conventions run through all of it:

- **`src/pattern/**` never imports three.js.** It is plain JavaScript, so the same code runs in
  Node for the tests and preview scripts, and in a Web Worker in the browser. A test
  (`tests/compose.test.mjs`, "src/pattern stays free of three.js") enforces it.
- **Units are the prototype's tesserae.** The field is the square `|x|, |y| ≤ 46`, the border runs
  to 52, the mortar bed is 114 wide. Pattern code works in a flat plane `(x, y)`; in the 3D world
  that point is `(x, 0, y)`, with y up. Polygons are arrays of `[x, y]` points, counter-clockwise.

---

## 3. From lines to tiles: the pattern pipeline

```
 1  CENTRE LINES    hankin.js, moorish.js: straight segments (Hankin rays, medallion lines)
        │
        ▼
 2  FACES           graph.js: split every line at every crossing, walk the regions they enclose
        │
        ▼
 3  STRAPS + FILLS  strap.js: shrink each face by half a strap width, bands between the faces,
        │           over/under at every crossing
        ▼
 4  PIECES          the design's cuts + cut.js: clip to the panel, carve the gold pins, merge
        │           slivers, cut big regions as a craftsman would   (border.js pieces join here)
        ▼
 5  TILES           compose.js: put them in laying order, inset by half the grout, wobble corners
```

### 3.1 What a zellige panel is made of

Islamic geometric patterns are drawn as **centre lines**. In zellige, a black (sometimes white)
band, the **strapwork**, runs along every line, and the regions between the bands are filled with
coloured pieces: stars, kites, "bows", crosses, small hexagonal "candies". Where two bands cross,
one passes over the other, as if woven (**interlace**). Every piece is chipped by hand from a glazed
tile, so edges are never perfectly straight, and pieces are set with a thin joint of mortar
(**grout**) between them.

So the code has to produce, in order: the centre lines, the regions they enclose, the bands and
fills, the cut pieces, and finally the finished tiles with grout gaps and chipped edges.

### 3.2 Step 1: the centre lines (Hankin's method)

The field is drawn with **Hankin's "polygons in contact" method**, the standard construction for
Islamic star patterns (`src/pattern/hankin.js`):

1. **Start from a tiling.** Here the **4.8.8 tiling**: regular octagons on a square grid, with small
   squares (seen as diamonds) in the gaps. The octagon spacing is `P = 4.6` units, chosen so the
   panel edge at 46 = 10·P runs exactly through octagon centres. That makes the edge a mirror line
   of the pattern, so the field ends cleanly.
2. **From the midpoint of every tile edge, launch two rays into the tile**, each at the *contact
   angle* θ = 67.5° to the edge, and stop each ray where it meets the ray from the neighbouring
   edge.

```
        tile edge ──────────●──────────     ● = edge midpoint
                           ╱ ╲
                          ╱ θ ╲             the two rays lean into the tile at θ = 67.5°
                         ╱     ╲            and stop where they meet rays from the next edges
```

At 67.5° each octagon gets an eight-pointed star whose points are its edge midpoints, and each
square gets a small four-pointed star. The leftover regions around each tiling corner are hexagons.

**One line per crossing.** The two tiles that share an edge launch their rays from the same midpoint
at the same angle, so a ray in one tile and a ray in the other line up into one straight line
through the midpoint. The code joins them: each shared edge yields exactly two straight segments
that cross at its midpoint. That is what a craftsman would draw, and it keeps the line count honest.

The field module also says what each region is (`classify`): an eight-point star (lapis and
turquoise in a chequerboard), a four-point star, or a hexagon (cream).

### 3.3 Step 2: lines to regions (the planar arrangement)

The lines are just a list of segments. To get the regions between them, `src/pattern/graph.js`
builds a **planar arrangement** (a map of the drawing as a graph):

1. **Find every crossing.** Testing every pair of segments would be slow (thousands squared), so
   segments are dropped into a uniform grid and only segments sharing a grid cell are tested.
   Each segment is cut at every crossing, including "T" touches and overlapping collinear pieces.
2. **Snap** points closer than a tiny tolerance into one vertex, and merge duplicate edges.
3. **Prune dangling ends**: a line that stops without meeting anything encloses nothing.
4. **Walk the faces** with a *half-edge* structure: every edge is stored twice, once per direction.
   At each vertex the outgoing edges are sorted by angle. To follow the boundary of the region on
   the left of an edge u→v, you arrive at v and take the edge just clockwise of the way back.
   Loops that go counter-clockwise are the bounded regions (**faces**); the clockwise loop is the
   outside of the drawing.

The output is a list of faces, each a clean counter-clockwise polygon with its area and centroid,
plus the vertices and edges between them.

### 3.4 Step 3: strapwork and interlace

`src/pattern/strap.js` turns faces into the bands and fills. The whole construction rests on one
set of shared points, the **face corners**:

- Shrink every face inward by half the strap width, keeping each side parallel to its centre line
  (a *mitred* inset). The corner of face F at vertex v is where F's two shrunk sides meet.
- **Fill** of a face = its shrunk polygon (the coloured piece).
- **Band** along an edge = the four-sided piece between the corners of the two faces on either side.
- **Junction** at a crossing = the polygon through the corners of all the faces around it.

```
     corner of face A ●──────────────────────● corner of face A
                      │  band (black strap)  │   the centre line runs down the middle
     corner of face B ●──────────────────────● corner of face B

     every ● is ONE shared point: the fill of A, the band and the fill of B all use it
```

Because neighbouring pieces are built from the very same point objects, their sides match exactly.
If every piece is a simple counter-clockwise polygon, the pieces cover the region **exactly once**:
no gaps and no overlaps. This is called a *partition*, and the tests check it numerically.

**Interlace (over and under).** At each four-way crossing, one strand must pass over and the other
under, and along any strand it must alternate: over, under, over. Each crossing is a yes/no choice
(which strand goes over), and walking along a strand from one crossing to the next gives a rule
"the choices at these two crossings must differ". A breadth-first search assigns the choices and
checks every rule. This is the same thing as colouring the faces like a chessboard, which always
works when every crossing has an even number of edges. If a contradiction ever shows up (an odd
loop), that one crossing falls back to a plain junction piece and a warning is reported; the
default panel has none.

```
            ║                              ║
     ═══════╬═══════      becomes   ══════ ║ ══════
            ║                              ║
   the over-strand takes the junction and runs through as one long piece;
   the under-strand stops at a grout line on each side (that joint is what shows "under")
```

**Runs.** Bands also continue through gentle bends (a circle drawn as many short segments), and
long runs are cut across into pieces of about `targetLen`, never right next to a crossing they
carry, so the over-strand visibly continues past it.

### 3.5 The medallion (the Moorish rosette)

The centre of the panel is a 16-fold rosette, `src/pattern/rosette16/moorish.js`. It is
*constructed*, the way a setter (the *ma'allem*) lays one out on the floor with a cord compass and a
straightedge: no coordinate is typed in by hand. Everything follows from the frame radius
`R_F = 29.5`, the strap width and the 16 divisions of the circle.

- The circle has 16 **tip axes** (every 22.5°) and halfway between them 16 **dent axes**. The
  drawing is symmetric about all of them (16 mirror lines, the symmetry group D16), so it is built
  in one thin wedge from 0° to 11.25°, then mirrored and turned 16 times.
- **Frame:** four bands measured inward from `R_F`: gold 0.8, black 0.5, terracotta 1.5, black 0.6.
  So the strapwork disk ends at `R_M = 26.1`.
- **Eight-point stars** sit on the tip axes, sized so each touches the frame and its neighbours.
  That fixes the **crown** circle through their inner points (radius 17.29).
- **Central 16-point star** (radius 5.19): its sides make 22.5° with the tip axes, so each point is
  45°. That is the same 67.5° contact angle as the field, which is why medallion and field read as
  one pattern.
- The star's sides run on to make **petal kites**, then the long **petals**, then the **bows**
  between petals and under the eight-point stars, then the **candies** between the stars.

**How the medallion is cut.** Small regions are one piece. Regions larger than about 3 square
units are cut along the drawing's own lines, as a craftsman would:

- the central star: its 16 points cut off; its body inlaid with the gold khatam (the first piece
  laid, 1.6 units across, sized for the opening close-up), a ring of 8 and a ring of 16;
- petals: an outline band in one glaze (cut into strips) around an inlaid inner copy in a second
  glaze, cut across;
- **bows: a gold dart down the middle.** Seen whole from above, each bow read as a valentine
  heart, sixteen hearts in a ring. The owner asked for exactly one change to the medallion: break
  those hearts up. Each bow is now split down its axis by a gold dart drawn on four of its own
  construction corners (the neck tip, the two shoulders and the notch). The dart takes the neck,
  which was a fragile sliver, and leaves two lobes; each lobe is cut like a petal (outline band plus
  inlay), and the second lobe is the exact mirror of the first. The sixteen darts make a ring of
  gold glints between the petals;
- kites and candies: across their length; eight-point stars: a centre plus points, the centre
  quartered;
- frame bands: rings of trapezoids on one shared 128-sided polygon, so bands, disk and field all
  meet on the same corners.

If a designed cut ever fails, `cutRosette` falls back to an exact cut that needs no clipping library
and **says so** in its warnings. The default design produces no warnings (a test checks this).

### 3.6 The border

`src/pattern/border.js` builds the band from 46 to 52 directly as cut pieces: a black line, a
sawtooth of terracotta and cream triangles (16 teeth per side), a black line and a gold edge, with a
lapis square and a gold pin at each corner. The line pieces are about 1.24 long, with counts chosen
so the joints of neighbouring lines never line up. The four sides are exact quarter turns of each
other.

### 3.7 Step 4: composition (`src/pattern/compose.js`)

`composePanel()` assembles the whole panel into one list:

1. **Medallion**: `cutRosette(ros, { finish: false })` gives its exact pieces (before grout).
2. **Field**: Hankin lines → arrangement → strapwork with interlace, then **clipped** to the square
   `|x|, |y| ≤ 46`, minus the medallion's own outer 128-gon. Using the medallion's exact outer
   polygon (not a separate circle) is what makes field and medallion meet without a gap or an
   overlap. This closed the prototype's known bare ring of mortar between circle and square.
3. **Pins** (done on the field just before that clip, while neighbours still share their sides
   exactly): the four-point stars in the 4.8.8 squares are specks (0.145 square units before grout,
   0.033 after). Three treatments were rendered side by side; the chosen one replaces each with a
   small gold square through its four tips, carved out of the straps around it. It reads as a
   deliberate inlay at every strap knot and glints in the light sweep (276 pins in the panel).
4. **Border.**
5. **Clean-up**: clipping at the circle and the square leaves crumbs. Each sliver is merged
   (polygon union) into the neighbour it shares the most edge with, preferring a strap in the same
   region, the way a setter cuts the next piece a little bigger instead of setting a crumb. The
   default panel makes 92 such merges. Before grout, all pieces together still partition the square
   `|x|, |y| ≤ 52` exactly.
6. **Order** (next section).
7. **Finish**, every piece in one pass (`finishPieces` in `cut.js`):
   - **Grout**: inset each outline by `GROUT/2 = 0.06` with a mitred offset, so the joint is the same
     width everywhere (0.12 between neighbours).
   - **Wobble**: move each corner up to 0.03 in a random direction, so edges look hand-chipped. Each
     corner's allowance is capped at 0.45 × its clearance to the piece's other edges, and if the
     result were not a simple polygon the clean outline is kept. A piece can never fold over itself.
8. **Sinopia**: the spec of red lines to paint on the bed: the medallion's construction circles and
   rays, the 4.8.8 tiling outside the medallion, and the border's guide lines.

All randomness comes from named, seeded streams (`src/util/rand.js`: a mulberry32 generator, seeded
by the prototype's seed mixed with an FNV-1a hash of the stream's name). The pattern stream draws
the order jitter first, then the wobble, so the same seed always lays the same panel, and changing
how many numbers one subsystem uses never reshuffles another.

The result: **10,209 pieces** (2,041 medallion, 6,652 field, 1,516 border), median area 0.62 square
units, smallest 0.063, largest 4.0. Composing takes about half a second in Node on the development
machine (measured).

### 3.8 Laying order and timing

The brief asked to keep the prototype's storytelling:

- **Medallion:** by ring (`layer`) from the centre out. The khatam is alone in layer 0, so it is
  always first. Within a ring, by the angle swept from a fixed start (−2.2 rad) in one direction,
  like a hand going round; pieces cut from one region get fractional layers from their inside out.
  A strap goes down just before the first piece of the later region it borders.
- **Field and border:** by distance from the centre plus a random ±0.6, so the edge of the laid
  area is a ragged growing front rather than a perfect circle.

`src/anim/schedule.js` sorts the pieces into that order and gives each a start time
`t0 = 0.9 + 46·(i/N)^0.42`. The power below 1 makes the early pieces slow and deliberate and the
outer field fast. The start times are stored as 32-bit floats because the same values go to the GPU:
the CPU's count of "pieces started" and the shader's decision "has this piece started?" must agree.

### 3.9 How the pattern is checked

`tests/compose.test.mjs` and friends check, among other things:

- before grout, the pieces partition the square `|x|, |y| ≤ 52` exactly: their areas sum to the
  square's area within one part in a billion, and no two overlap (pairs found with a spatial hash,
  overlap measured with polygon clipping);
- every finished piece is a simple, counter-clockwise polygon of at least 0.05 square units;
- there are at least 8,000 pieces and none was dropped by the grout;
- the first piece is the gold khatam at the centre, under 1.6 across;
- the same seed gives the same panel, and another seed changes only the wobble and jitter;
- the medallion and field produce no warnings.

---

## 4. The GPU side

### 4.1 The problem

The prototype used **instancing**: one square tile shape, drawn ten thousand times with a different
position, rotation and colour each. That is fast, but it only works when every copy has the same
shape. Zellige pieces are each unique (clipped at boundaries, cut to fit, wobbled), so there is no
shared shape to instance. And the prototype animated tiles on the CPU, rewriting the transforms of
every tile in the air on every frame.

The brief's preferred plan, which is what was built: put every piece into a few big buffers, and
let the GPU animate them.

### 4.2 Merged buffers (`src/scene/extrude.js`)

Each piece's outline is turned into a chunky glazed slab: a flat top cap, a rounded bevel (a quarter
circle in 2 steps), a vertical side and a bottom (seen only while a piece tumbles).

```
   y = H  ___________        top cap, inset by the bevel
                     `-.     rounded bevel: normals turn smoothly from up to sideways
   y = H-b              |    vertical side
   y = 0  ______________|    bottom cap
```

Why not three.js's `ExtrudeGeometry`? At ten thousand unique pieces, building one geometry object
per piece and merging them costs seconds and a lot of garbage. Instead every piece is *planned*
first (cleaned outline, which corners are sharp, how much bevel fits, the triangulation of its caps),
the totals are summed, **one** set of typed arrays is allocated, and each piece writes its vertices
and triangles straight into its slice. Details that matter:

- normals are smooth around gentle corners but split at sharp ones (over 35°), so star points stay
  crisp;
- a thin sliver gets a smaller bevel (it tries 100%, 75%, 50%, ...) so it never turns inside out;
- convex caps are fanned from one corner; concave ones go through earcut (three's `ShapeUtils`);
- black strap pieces get half the bevel (0.035 instead of 0.07), so overhead they read as continuous
  black ribbons instead of grey-edged bars.

Pieces are stored at their **final, resting** position. There are two meshes: one for glaze and one
for gold (gold uses a metallic material). For the default panel that is 376,736 vertices and
343,220 triangles: about 15 MB of positions, normals, `pieceId`s and indices (about 18 MB with the
far-view index list below).

There is also a second **index list** over the same vertices, the "far view": it leaves out the
middle rings of the bevel. From far away the bevel is under a pixel wide, but with 4× multisampled
anti-aliasing every thin band along an edge still costs extra shading work, which made bevels the
biggest GPU cost of the finished view. `setDetail` swaps the list when the bevel drops under 1.0
device pixel and back above 1.3 (two thresholds so it does not flicker). The far list has 247,206
triangles; measured, the two look the same in 4× crops and differ in 0.4 to 0.6% of pixels.

### 4.3 `pieceId` and the data texture

Every vertex carries one extra number, `pieceId`: the index of its piece in laying order. (It is a
float; 32-bit floats hold whole numbers exactly up to about 16.7 million.)

Everything else about a piece lives in a **data texture**: an image that is not meant to be looked
at, just a grid of numbers the shader can read. Each piece owns 4 texels of 4 floats, 16 numbers:

| texel | r | g | b | a |
|---|---|---|---|---|
| 0 | start time `t0` | pivot x | pivot z | how far it sinks into the mortar `yb` |
| 1 | tumble fx | tumble fz | spin | height scale `sy` |
| 2 | resting tilt rx | resting tilt rz | roughness | ripple seed |
| 3 | colour r | colour g | colour b (linear RGB) | facet gain (gold 8, glaze 0) |

The texture is 2048 texels wide (512 pieces per row; 2048 is the widest texture every WebGL2 device
must support), so 10,209 pieces fill 20 rows: about 650 KB of 32-bit floats. The shader reads it
with `texelFetch` (an exact integer lookup, no filtering).

Why a texture and not the alternatives:

- **Uniforms** (shader constants) are far too few: a vertex shader is only guaranteed a few hundred
  vec4 slots, and this needs 40,836.
- **Vertex attributes** would copy all 16 numbers onto every vertex of the piece: about 24 MB
  instead of 650 KB.

The random numbers are drawn in the same order as the prototype's tile setup (tilt, height, sink,
tumble, spin), so the pieces fall the way the prototype's did.

### 4.4 The drop runs in the vertex shader

The vertex shader is the small GPU program that places every corner of every triangle on screen.
It runs for every vertex on every frame, in parallel. Here, for each vertex, it:

1. reads its piece's numbers with `pieceId`;
2. computes the piece's progress `p = (uSim − t0) / D`, with `D = 0.55` s;
3. poses the piece, exactly as the prototype did on the CPU:
   - `p < 0`: not started. The whole piece collapses to a single point, so its triangles have no
     area and draw nothing;
   - `0 ≤ p < 0.8`: falling. `q = p/0.8`, height `2.6·(1 − q²)` (gravity easing), tumble fraction
     `f = 1 − q`;
   - `0.8 ≤ p < 1`: settling. A tiny bounce `0.06·sin(πq)`;
   - `p ≥ 1`: resting;
4. rotates the vertex about the piece's pivot by `(rx + fx·f, spin·f, rz + fz·f)`, scales its height
   by `sy`, lifts it by `yb + y`, and rotates the normal the same way so the lighting stays right.

The shader code lives in `src/scene/shaders/drop.js`. It is not a separate material: it is spliced
into three.js's own `MeshStandardMaterial`, so the pieces keep three's full physically based
lighting, shadows and reflections. three.js builds its shaders from named snippets ("chunks"), and
`onBeforeCompile` lets you edit the source before it compiles. `pieces.js` replaces the
`#include <begin_vertex>` and `#include <beginnormal_vertex>` chunks with the posed versions, and
adds colour, roughness and normal tweaks in the fragment shader. A helper, `inject`, throws an error
if a chunk name is ever missing, so a three.js upgrade that renames one fails loudly instead of
silently drawing unposed pieces. Glaze and gold differ only in uniform values, so they share one
compiled program (`customProgramCacheKey`).

The same pose curve also exists in JavaScript (`dropPhase` in `schedule.js`). It is the reference:
the dev harness (`dev/pieces.html`, checked by `scripts/check-pieces.mjs`) compares GPU-posed
pieces with the CPU pose pixel by pixel across the whole drop.

### 4.5 Why the shadow pass needs the same code

Shadows are made with a **shadow map**: before drawing the picture, three.js renders the scene from
the sun's point of view, storing only how far away the nearest surface is. A point is in shadow if
something nearer to the sun covers it.

That pass uses a *different*, depth-only material. It knows nothing about the drop, so without help
it would draw every piece at its resting place from the first frame: the shadow of the finished
panel would lie on bare mortar, and falling pieces would cast no moving shadows. So the same pose
code is injected into a `MeshDepthMaterial` and given to the meshes as their `customDepthMaterial`.
Now pieces that have not started collapse in the shadow pass too (no shadow), and falling pieces
cast shadows that move with them.

The meshes' bounding spheres are also grown by the largest reach a piece can have while falling,
so three.js never culls a piece that is mid-air above the edge of the view.

### 4.6 Why the CPU cost per frame is constant

Here is everything `main.js` does per frame (`frame()`), and what each costs:

| Work | Cost |
|---|---|
| advance the clocks (`sim += dt × speed`) | constant |
| `tiles.update(sim)`: write `uSim` (one uniform shared by all three materials) | constant |
| pieces started / landed, laid radius: binary search over the sorted `t0` + a prefix-max table | O(log N) |
| covered radius for the sinopia: one binary search + a table lookup | O(log N) |
| stage label: two binary searches + a subtraction per stage (~9) over per-stage area totals | O(log N) |
| camera, fog, light, shadow box: a handful of trig | constant |
| far/near slab switch: compare one number, swap an index list at most once per crossing | constant |
| HUD: DOM writes only when the landed count changes | constant |
| draw: two piece meshes, so two draw calls (two more when the shadow map is redrawn) | constant |

Nothing loops over the pieces after the build, so 10,000 pieces cost the CPU per frame what 10
would. The work moved to the GPU: it re-poses all 376,736 vertices on every frame, including those
of pieces that are waiting or already resting. That is the trade-off (see 6.2), and it is cheap for
a GPU.

### 4.7 The look: glaze, ripple, gold

- **Colour.** Each piece's colour starts from the palette (`palette.js`, sRGB hex, as a potter would
  name them) and gets a small random shift in hue, saturation and lightness (lightness ±8%, less for
  black and cream). The shift is applied in sRGB HSL, as the prototype did, so "±8% lighter" means
  what an eye would see. About 2% of glaze pieces are "kiln" pieces, fired notably darker or
  lighter. Gold is not a glaze, so it is never kiln-fired.
- **Roughness** varies per piece (0.15 to 0.35 for glaze).
- **Ripple.** Real zellige glaze is not flat, so its reflections wobble. The fragment shader tilts
  the surface normal of each top face with three octaves of smooth gradient noise, computed with its
  exact derivative. The pattern is glued to the piece (it tumbles with it). Each octave fades out
  once one ripple is smaller than about 24 pixels on screen, so zoomed out the glaze reads as smooth
  and the GPU skips the work.
- **Gold facets.** Gold is metal (`metalness 1`), so it only shows what it reflects. A reflection
  environment is baked at start-up (a warm sphere with three bright "window" panels, pre-blurred into
  a PMREM) so the gold reads as gold rather than dark brown. Each gold top face is then *shaded* as if
  it leaned 8 times further along its small resting tilt (up to ±0.45 rad per axis), without moving
  the geometry. Neighbouring gold pieces therefore mirror different parts of the room, which reads as
  metal at rest and makes the gold flash piece by piece as the sun passes.

### 4.8 The light sweep and the glint (`src/anim/light.js`)

The brief's acceptance test: "the gold visibly glints during the light sweep". A flat polished top
shows the sun only when the sun sits where your line of sight would bounce: opposite you, at your
height above the panel. The prototype's sweep dipped to 27° while the finished view looks down from
about 65°, so the reflection never reached the camera.

The sweep orbits the sun once around the panel over 11 seconds (eased in and out), aimed at the
viewer:

- On the viewer's side it is low: raking light, long shadows.
- Behind the panel, where its reflection could reach the camera, it must avoid the **glaze's** mirror
  angle. The glaze is satin (broad reflection lobe), so wherever the sun comes near a point's mirror
  direction, the glaze there washes out to pastel, as much as the gold glints. Every point on screen
  has its own mirror height (lowest at the far edge, highest at the near edge), so the sun keeps 0.4
  rad (about 23°) away from that whole band. Normally it passes *below* the band; for a low view,
  where "below" would sink under the prototype's 27° dip, it passes *above* (capped at about 83°).
  The side is chosen once per sweep, so the sun never jumps.
- The gold still flashes because of its facets: as the sun moves, piece after piece swings through
  its own mirror angle, while the flat glaze stays saturated.

How it was measured (`scripts/verify-app.mjs`, section `glint`): honey ochre and gold are too close
in colour to tell apart by hue, so the script renders a second "mask" frame through three's devtools
hook with the same camera, gold in magenta and glaze in green, without touching `src/`. Then it counts
"flash" (gold pixels at least 40 brighter than at rest) and "wash" (glaze pixels that lost at least
0.15 saturation). Measured on the finished view: about 2,050 flash pixels with 4,300 to 5,200 washed,
against 3,204 flash with 56,865 washed for the earlier aim with flat gold. The honest trade-off: the
peak flash is about two thirds of what it was, but the glaze wash is about 11 times lower, so the
gold is now the thing that lights up. At the full view it reads as a sparkle along the ring, the
border and the pins, not one big flash.

### 4.9 The bed and the underdrawing that disappears (`src/scene/bed.js`)

The mortar is painted on a 2048-pixel canvas (noise, blotches, aggregate grains), with a matching
bump map so the grains catch the light, plus a stone curb and an outer floor.

The **sinopia** has its own one-channel texture layer, mixed over the mortar in the bed's shader. In
the zellige build the pieces are cut along the very construction lines the setter drew, so the
joints between pieces lie *on* the red lines; painted into the mortar, red showed through every grout
joint of the finished panel. So the layer fades out wherever every piece has landed: the schedule
keeps a "suffix minimum" table of each piece's closest distance to the centre, and `rCoveredAt(sim)`
looks it up by the landed count to get the radius inside which everything has landed. The bed fades
the lines out over 1.5 units inside that radius, with one uniform write per frame. Lines show on bare
mortar ahead of the laying and vanish under it. (The prototype build still paints them into the
colour map, as the prototype did.)

The 32 radial construction lines of the medallion start at the innermost construction circle, like
the rays of a compass rose, instead of at the centre: starting at the centre, they piled up into a
pink blob under the khatam in the opening close-up.

The slab under the bed sits at −0.25 instead of the prototype's −0.01. At −0.01 it was closer to the
bed surface than the depth buffer could tell apart once the camera pulled back, so it flickered
through the mortar in blocky patches ("z-fighting", in the prototype too).

### 4.10 Startup (`src/main.js`)

The page shows something at once, then builds:

1. renderer, scene, camera, lights, reflection environment;
2. the bare mortar bed;
3. **the first frame is drawn** ("Preparing the bed");
4. meanwhile, since boot, a **Web Worker** has been composing the panel (pure JavaScript, about half
   a second, measured 0.42 s on the main thread in headless Chrome and 1.83 s with Chrome's CPU
   throttled 4×). In a worker the page stays responsive: you can already drag and zoom. The worker is
   imported with Vite's `?worker&inline`, so the single-file build stays one file. If a worker cannot
   start (an old browser, a strict content policy), the same function runs on the main thread;
5. the sinopia is painted from the worker's result;
6. the meshes and data texture are built (about 0.07 s);
7. the shader is compiled with `renderer.compileAsync` while the pieces are hidden, so the first frame
   with pieces does not stall on compilation;
8. the clock starts.

Measured in a final dev run: first frame at 439 ms after navigation, ready at 1,115 ms
(`window.__startup`). The web fonts load without blocking the page. Pressing Finish while the bed is
still being prepared is remembered and applied when the pieces are ready. If building fails, the HUD
says "Could not lay the panel" instead of "Preparing the bed" forever.

Other robustness: with `prefers-reduced-motion`, the finished panel is shown at once, with no slow
turn and no automatic sweep. If the browser loses the WebGL context (a phone reclaiming GPU memory)
and restores it, the reflection environment, which was rendered on the GPU and is simply gone, is
baked again and handed back to every material. Without WebGL, the page says so and hides the HUD.

### 4.11 Holding the frame rate

The cost of a frame here is almost all **per pixel**: 4× multisampled edges of ten thousand bevelled
pieces. So the levers are about pixels:

- **Pixel-ratio ceiling** (`renderer.js`): never more than 2 device pixels per CSS pixel, and never
  more than 5 million pixels in all. Measured: a 1920×1080 window on a 2× screen (8.3 Mpx) held only
  49 to 54 fps; capped (ratio 1.55) it ran 81 to 88 fps.
- **Governor** (`governor.js`): averages the last 30 frame intervals. After 2 s above 17.5 ms (under
  about 57 fps) it lowers the pixel ratio by 0.25, never below 1. After 5 s under 12 ms it raises it
  again, but not back to a ratio that already proved too slow (no see-saw), until 30 s of spare time
  has passed. Intervals over 100 ms (a hidden tab) are ignored. Its cost is one add, one subtract and
  a compare per frame.
- **Far-view slabs** (4.2): measured GPU time at the finished view 9.82 → 8.58 ms.
- **Shadow map only when needed**: `autoUpdate` is off; the shadow map is redrawn while pieces are
  moving, while the sun sweeps, when the shadow box changes, and on start, Finish, Replay and context
  restore. A still, finished panel skips the depth pass over all its triangles.
- **Pieces drawn before the bed** (`renderOrder = -1`), so the bed's pixels hidden under pieces fail
  the depth test and are not shaded (a saving on GPUs that do not already skip hidden pixels; not
  measurable on this Apple GPU).

The brief asks for 60 fps on a mid-range laptop. What was measured and what was not is in section 8.

---

## 5. Porting the prototype from three r128 to r186

The prototype's look was tuned on three.js r128. Five years of three.js changes mean the same numbers
give a different picture on r186. The fixes, all in `src/scene/renderer.js`, `bed.js`, `pieces.js`
and `light.js`:

1. **Lights × π.** r186 only has physically based light units. r128's "legacy" lights had π folded
   in, so every light intensity is multiplied by π.
2. **Colour management.** r186 reads hex *strings* as sRGB and converts them to linear for lighting.
   The prototype's manual conversions are dropped. But r128 took a bare hex *number* as linear as-is,
   and the prototype used those for its lights and the under-bed slab, so a helper `rawHex` keeps
   those exact colours (otherwise the hemisphere's ground colour would come out about 4× darker).
3. **`outputEncoding` → `outputColorSpace`** (sRGB output, the default, stated explicitly).
4. **Environment intensity.** Since r163 a material that only inherits `scene.environment` ignores
   its own `envMapIntensity` (three uses `scene.environmentIntensity` instead; checked in
   `node_modules/three/src/renderers/WebGLRenderer.js`). Every material sets `envMap` itself, so the
   prototype's per-material reflection strengths still apply.
5. **`PCFSoftShadowMap` is removed** in r186 (it warns and falls back). The port uses `PCFShadowMap`
   with `shadow.radius = 1.6`, which gives about the same soft edge as r128's 3×3 filter.
6. **Fog colour.** r128 mixed fog into already-sRGB pixels with a linear colour; r186 converts the fog
   colour first. The fog colour is linearised once more, so distant floor fades to the same brown.
7. **Energy conservation.** r186's lighting takes the glaze's specular share out of its diffuse
   light, so the same light reads about 1% darker. Lights get ×1.05 back (measured to bring the mean
   signed pixel difference to about 0).
8. **HSL in sRGB.** `getHSL` / `setHSL` now default to the linear working space; colour jitter passes
   `SRGBColorSpace` to keep the prototype's behaviour.

Deliberate departures from the prototype, each measured and noted in the code: the under-bed slab
lowered to −0.25 (z-fighting); the shadow bias set in world units and the shadow box fitted to the
view (the prototype's fixed bias detached every shadow from its piece); fog that backs off with the
camera on portrait screens and when zoomed out (otherwise the panel sank into dark fog); the slow
camera turn no longer snapping round on Finish and Replay.

**How the port was proven.** `scripts/compare-port.mjs` loads the prototype and `?legacy=1` in
headless Chrome on the real GPU, gives both pages the same fake clock (it replaces
`requestAnimationFrame` and `performance.now` before any page script runs, stepping exactly 1/60 s),
and compares screenshots at six checkpoints. The prototype is measured as-is and with the same slab
fix injected (the reference file itself is not edited). Latest run: mean absolute difference 0.36 to
0.89 levels out of 255, and 0% of pixels off by more than 24, at every checkpoint. The legacy build
keeps a frozen copy of the prototype's palette (`PROTOTYPE_PAL`) so retuning the zellige colours
never moves the reference.

---

## 6. Trade-offs and alternatives considered

### 6.1 Instancing vs merged buffers

| | Instancing (prototype) | Group by shape | **Merged buffers (chosen)** |
|---|---|---|---|
| Idea | one shape, many copies | instance each repeated shape (all identical kites share one mesh) | every piece written into one buffer per material |
| Unique pieces | impossible | only if the wobble is dropped, and clipped edge pieces are still unique | free: each piece is its own outline |
| Draw calls | 2, plus one per cut centre piece (several dozen) | tens to hundreds | 2 |
| Per-piece data | instance matrix + colour | instance matrix + colour | data texture looked up by `pieceId` |
| Memory | smallest | small | largest (every vertex of every piece stored, about 15 MB) |

The brief listed grouping by shape as the simpler option, because zellige repeats shapes heavily.
But the wobble that makes the pieces look hand-cut also makes every piece unique, and so do the cuts
where the field meets the medallion and the square. Merged buffers keep both, with the same two draw
calls as the prototype.

### 6.2 CPU vs GPU animation

The prototype moved only the tiles in the air: two pointers into the sorted list, recomputing perhaps
a few dozen instance matrices per frame. That is cheap and easy to debug, although each such frame
also marked the whole instance-matrix buffer as changed, so three.js sent all ten thousand matrices
to the GPU again. Moving the drop into the vertex shader means no per-frame CPU work and nothing to
upload per frame. The costs: the GPU re-poses every vertex every frame; the pose has to reach two
shader programs (the main material and the shadow material); and a bug shows up as wrong pixels, not
as a value you can print. The project pays that last cost with a JavaScript reference copy of the
pose and a pixel-by-pixel GPU-vs-CPU check.

### 6.3 Which polygon library

The brief suggested `clipper-lib` / `clipper2-js` or `polygon-clipping`; the project uses
`polygon-clipping` (pinned at 0.15.7). The code does not record a head-to-head benchmark, so this is
what the code itself shows about the choice:

- it works directly on floating-point `[x, y]` arrays, the format the whole pattern engine uses
  (Clipper works on integer coordinates internally, so floats are scaled in and out);
- only union, intersection and difference are needed. The one operation Clipper is famous for,
  polygon offsetting, is done by the engine's own mitred inset (`geom.js`), because strapwork needs
  every piece built from exactly *shared* corner points, which a separate offset library would not
  guarantee;
- its weak spot showed up in practice: edges that coincide exactly, and cuts through a vertex, can
  make it fail. The code works around that in three ways: pieces that do not touch a boundary skip
  clipping entirely (a fast path that also keeps it quick); the designs avoid cutting through
  vertices; and where a cut can still fail, exact fallbacks that need no library (`fallbackCut`,
  `clipToConvex`) take over and report it.

### 6.4 Three medallion designs, and why Moorish

Three 16-fold medallions were built in full, each with its own tests and preview script:

| Design | Construction | What it looks like |
|---|---|---|
| **moorish** (chosen) | from the frame inward, as a setter lays it out: eight-point stars touching the frame, a central 16-point star at the field's own 67.5°, petals, bows, candies | a Nasrid / Fez rosette: petals and bows inside a ring of eight-point stars, framed by gold, black and terracotta bands |
| lee | A. J. Lee's rosette (after Kaplan, Bridges 2000) nested twice, then a crown of kites, a band of 32 four-point stars and a sawtooth | a long-pointed star with large plain cream panels between its points; its small darts are narrower than a strap, so a strap runs down their middle |
| polar | Hankin's method applied to a radial tiling of octagons; the lines form the star, petals and bows by themselves | a dense interlace of many small pieces flowing from centre to frame; polar distortion leaves near-misses that have to be welded shut |

The owner chose Moorish from side-by-side renders, and both automated reviewers had ranked it first.
What it has going for it, visible in the code: it shares the field's contact angle, so medallion and
field read as one pattern; it is built from `R_F` inward, so it fills its frame exactly; its regions
are large and clear, so they can be cut the way a craftsman would (outline bands and inlays); and its
opening close-up is a single chunky gold khatam.

The owner asked for exactly one change: break up the bows that read as sixteen valentine hearts
(done with the gold darts, 3.5). They explicitly **declined** three other suggestions: cutting petals
and bows into fewer, larger pieces; replacing the terracotta frame ring with a sawtooth (as in Lee);
and making the cream rim "candies" terracotta. Those stay as designed.

Lee and polar are kept as possible future presets. They are not plug-in ready: `compose.js` also
uses the medallion's exact outer polygon (`outerPoly`), its construction radii (`geo`) and
`cutRosette(ros, { finish: false })`, which only Moorish provides today (polar has `rosettePieces`
instead).

### 6.5 Smaller decisions worth knowing

- **Worker vs main thread for composing.** A worker keeps the page interactive during the half-second
  (up to two seconds on a slow phone) of cutting, at the cost of copying the result across
  (structured clone of plain arrays). Mesh building stays on the main thread, where three.js is.
- **Area-weighted stage label.** The prototype labelled the stage of the latest piece. Zellige lays a
  region's straps together with the pieces they outline, so the label flickered between "Strapwork"
  and the fill about 380 times. The HUD now names the stage covering the most area among pieces
  started in the last 1.5 s, with some hysteresis: 12 changes over the run, in laying order.
- **Gold facets in shading only.** Actually tilting the slabs by ±0.45 rad would lift the tips of the
  5-unit gold darts over a unit out of the bed. Shading-only facets get the glint without that.
- **Grout 0.12.** Rendered at 0.14, 0.12 and 0.10. At 0.14 every black strap sat in a wide cream joint
  and the strapwork read as a chain of separate bars; 0.12 is the low end of the brief's range.
- **GPU memory vs simplicity.** About 400 MB of GPU memory was measured at a 3840×2160 buffer,
  dominated by the multisampled framebuffer; the pixel cap cut that buffer by about 40%. Packing
  normals into 16-bit integers would save a little more but was not done.

---

## 7. Testing and verification

**Unit tests** (`npm test`, Node's built-in test runner, 144 tests, about 4 seconds):

| File | Tests | Covers |
|---|---|---|
| `tests/engine.test.mjs` | 15 | geometry, arrangement, strapwork, interlace, cutting |
| `tests/hankin.test.mjs` | 11 | the field's faces and symmetry |
| `tests/rosette-moorish.test.mjs` | 18 | the chosen medallion: partition, cuts, darts, no warnings |
| `tests/rosette-lee.test.mjs`, `rosette-polar.test.mjs` | 10, 11 | the other two designs |
| `tests/compose.test.mjs` | 20 | the whole panel: partition, sizes, order, determinism, border |
| `tests/pieces-geometry.test.mjs` | 17 | slabs, data texture layout, shader injection, the tile system |
| `tests/schedule.test.mjs` | 8 | start times and every query against brute force |
| `tests/app.test.mjs` | 18 | stage label, shadow fit, light sweep, camera, governor |
| `tests/port.test.mjs` | 16 | the prototype's pattern, tiles and rig still behave as before |

**Rendered checks** (headless Chrome on the real GPU, `scripts/`). The owner's rule: checks go
through the real input path (a cold load in a fresh page, real clicks, drags, wheel and touch
events) and measure the rendered output, not internal state. `window.__seek` exists, but only to
line up choreography; it is never evidence.

- `verify-app.mjs`: starts its own cold dev server and checks, from screenshots and pixel
  statistics: the opening and the run, Finish and the automatic sweep, close-ups for shadow acne,
  every HUD control, reduced motion, a phone viewport, the legacy build, the single-file build opened
  from `file://` (and with workers blocked), and the glint measurement (4.8).
- `compare-port.mjs`: port vs prototype, frame for frame (section 5).
- `check-pieces.mjs`: the GPU pose against the JavaScript pose, pixel by pixel, plus frame rate.
- `preview-*.mjs`: flat PNG previews of the field, each medallion and the whole panel, for looking at
  the pattern without the 3D scene.

---

## 8. Status, open questions and limits

**Done.** The phase-1 goal: the prototype ported to r186 in modules; the zellige engine; the field;
three medallions with Moorish chosen and its hearts broken up; the border; the composed panel of
10,209 pieces with no gap ring; GPU pieces with animated shadows; the aimed light sweep; the
performance guard; startup in a worker; the single-file build. 144 tests pass.

**Look changes made in review that wait for the owner's eye:** faceted gold; the honey ochre
`#a8721f` (darker than the gold, so the metal reads as metal; the prototype's was `#b98128`); the
narrower grout (0.12) with the thinner strap bevel; the sinopia rays starting at the first circle
(the owner may want a small centre mark).

**Not verified:**

- 60 fps on a real mid-range laptop GPU. This machine cannot be made GPU-slow, and the load test
  used to exercise the governor was CPU-bound, where the pixel ratio cannot help. Measured here:
  1280×800 at 2× ran 88 to 94 fps, 1920×1080 at 2× (capped to 1.55) 81 to 88 fps, phone size 105.
- On a 60 Hz display the governor can only step down: frames there never come faster than 16.7 ms.
- Two ~1.2 s main-thread blocks seen once on a cold first load were not reproduced in about 20 later
  cold loads; a cold GPU shader cache is the likely cause and was not tested.

**Deferred, with reasons:**

- At the default finished framing the panel's corners are cut off (most visible on a phone). Fixing
  it means changing the prototype's tuned pull-back, so it is left to the owner.
- Overhead the colours read lighter than the palette. That is the prototype's tuned lighting and
  exposure, which the legacy build still matches.
- From the default view the bows can still group into heart-like pairs; the cuts stay as the owner
  asked.
- The glaze ripple costs about 27% of GPU time when zoomed right in; changing it changes the look.
- A sharper bed texture for the close-up; smaller vertex formats (both for memory).

**Not built yet** (brief section 5, the next phase): video export, pattern and palette presets, a
hand or trowel placing the first pieces, dust puffs, a shareable `#seed` URL (the seeded streams are
ready for it).

---

## 9. Glossary

**Zellige.** Moroccan mosaic of hand-cut pieces of glazed terracotta set in mortar, usually in
geometric patterns. Each piece is chipped to shape from a glazed tile.

**Ma'allem.** A master craftsman; here, the setter who draws out and lays the panel.

**Tessera / tesserae.** A single mosaic piece / pieces. **Opus tessellatum** is Roman mosaic of
roughly square tesserae, which is what the prototype was.

**Strapwork.** The bands that run along a pattern's centre lines, between the coloured shapes.
**Interlace**: where two bands cross, one passes over and the other under, alternating.

**Khatam** (spelled `khatem` in the code). An eight-pointed star; the word means "seal". Here, the
gold first piece at the centre.

**Rosette.** A star surrounded by rings of petals; here 16-fold. **Petal, kite, bow, candy, dart**:
names of the shapes in it (the brief calls the bow *saft*).

**Hankin's method ("polygons in contact").** Described by E. H. Hankin in the 1920s and later made
into an algorithm by Craig Kaplan: from the midpoint of each edge of a tiling, draw two rays at a
fixed **contact angle** into each tile; where they meet, they form the star pattern.

**4.8.8 tiling.** A tiling where every corner is shared by a square and two octagons (4, 8, 8 sides).

**Sinopia.** The red underdrawing a craftsman paints on the bed before laying. The name comes from
Sinope, a Black Sea port whose red earth was used for it.

**Grout.** The thin gap of mortar between pieces. **Wobble**: the small random shift of each corner
that makes edges look hand-chipped.

**Andamento.** The direction in which rows of mosaic pieces run.

**D16.** The symmetry of a figure that looks the same after 16 rotations and 16 reflections.

**Planar arrangement.** The graph you get from a set of lines by splitting them at every crossing:
vertices, edges, and the faces they enclose. **Half-edge**: each edge stored once per direction, so
you can walk around a face.

**Mitred inset / offset.** Moving every side of a polygon inward by the same distance, keeping it
parallel, with sharp (not rounded) corners.

**Partition.** A set of pieces that covers a region exactly once: no gaps, no overlaps.

**Polygon boolean (clipping).** Union, intersection and difference of polygons.

**Earcut.** A standard algorithm for cutting a concave polygon into triangles.

**Vertex shader / fragment shader.** The two small programs a GPU runs: one positions every corner
of every triangle, the other colours every pixel.

**Uniform / attribute / varying.** A uniform is one value shared by every vertex in a draw (here
`uSim`). An attribute is a value per vertex (here `pieceId`). A varying passes a value from the
vertex shader to the fragment shader.

**Data texture.** A texture used as a table of numbers rather than as an image. Here 16 floats per
piece. **`texelFetch`**: reads one exact texel by integer coordinates.

**`onBeforeCompile`.** A three.js hook that lets you edit a built-in material's shader source before
it is compiled. **Shader chunk**: a named piece of that source (like `begin_vertex`).

**PBR, roughness, metalness.** Physically based rendering: materials described by how rough and how
metallic they are. **`MeshStandardMaterial`** is three.js's PBR material.

**Environment map, PMREM.** An image of the surroundings used for reflections. A PMREM (pre-filtered,
mipmapped radiance environment map) stores it blurred at several levels, so rough surfaces can look
up a blurrier reflection quickly.

**Shadow map, bias, acne.** A depth image rendered from the light. **Bias** is a small offset so a
surface does not shadow itself; too little gives speckled "acne", too much detaches shadows from
objects. **`customDepthMaterial`**: the material used for one object in that depth pass.

**Z-fighting.** Two surfaces so close that the depth buffer cannot tell which is in front, so they
flicker through each other.

**MSAA.** Multisample anti-aliasing: each pixel takes several samples along edges to smooth them.

**LOD (level of detail).** A simpler version of geometry used when it is small on screen. Here, the
far-view slab index.

**Device pixel ratio / pixel ratio.** How many real screen pixels per CSS pixel the canvas is drawn
at. 2 on most laptops' "retina" screens.

**Tone mapping (ACES).** Squeezing bright HDR light values into what a screen can show, with a filmic
curve. **sRGB vs linear**: lighting maths is done in linear values; screens and hex colours are sRGB.

**Web Worker.** A background thread in the browser for JavaScript that does not touch the page.
**Structured clone**: how data is copied between them.

**Binary search, prefix max, suffix min.** Finding a position in a sorted list in O(log N) steps;
tables of "largest so far" and "smallest from here on", built once, so later questions are lookups.

**Hysteresis.** Using two thresholds (one to switch on, another to switch back) so a value hovering
near the line does not flicker.

**Seeded random stream (mulberry32, FNV-1a).** A tiny random number generator that always gives the
same sequence for the same seed; FNV-1a is a small string hash used to give each subsystem its own
seed.

**WebGL context loss.** The browser can take the GPU away from a page (for example a phone freeing
memory); everything that lived only on the GPU must be rebuilt when it comes back.

---

## 10. Ten likely interview questions

**1. Why didn't you keep instancing, like the prototype?**
Instancing draws one shape many times. Zellige pieces are all different: clipped at boundaries, cut
to fit, and wobbled to look hand-made. So I write every piece's slab into one big buffer per material
(glaze and gold), at its final position, and keep each piece's per-piece numbers in a data texture
that the shader looks up by a `pieceId` stored on every vertex. It is still two draw calls, like the
prototype.

**2. What does the CPU do per frame, and why doesn't it grow with the number of pieces?**
It advances the clock and writes one uniform, `uSim`. The vertex shader computes each piece's pose
from `uSim` and the piece's start time. The HUD and camera ask "how many have landed? how far out
are we?" through binary searches over the sorted start times and precomputed tables, so O(log N).
Nothing loops over pieces per frame. The cost moved to the GPU, which re-poses every vertex every
frame; that is what GPUs are good at.

**3. Why do the shadows need a custom depth material?**
three.js draws shadows in a separate depth-only pass with its own material, which knows nothing
about my drop. Without the same pose code there, the shadow of the finished panel would be on bare
mortar from frame one and falling pieces would cast no moving shadows. So I inject the same GLSL
into a `MeshDepthMaterial` and set it as `customDepthMaterial`; pieces that have not started collapse
to a point in both passes.

**4. How do you generate the pattern?**
With Hankin's method. Start from a 4.8.8 tiling of octagons and squares. From the midpoint of every
edge, draw two rays at 67.5° into each tile, and stop them where they meet. That gives eight-point
stars in the octagons. The medallion is constructed with the same angle, like a craftsman with a
compass and straightedge, so the two match. Then a planar-graph step turns the lines into regions.

**5. How do you guarantee the pieces fit with no gaps or overlaps?**
Every strap and fill is built from one shared set of corner points, so neighbours share their sides
exactly. Before grout the whole panel is an exact partition of the square, and a test checks it: the
areas add up to the square's within one part in a billion, and a spatial hash finds no overlapping
pair. Slivers from clipping are merged into a neighbour rather than dropped. Then every piece is inset
by the same half-grout, so all joints are the same width.

**6. How does the over/under weaving work?**
Each crossing is a binary choice: which strand goes over. Along a strand, consecutive crossings must
differ, so each step gives a constraint between two crossings. A breadth-first search assigns the
choices; it is the same as two-colouring the faces like a chessboard. The strand that goes over is
one long piece through the crossing; the one that goes under is cut by a grout line on each side. If
a crossing ever cannot alternate, it falls back to a plain junction and the code warns.

**7. What's in the data texture, and why a texture?**
Sixteen floats per piece: start time, pivot, sink depth, tumble, spin, height scale, resting tilt,
roughness, a ripple seed, colour and a gold facet gain. Uniforms are limited to a few hundred vectors
and I need about 40,000. Attributes would copy those numbers onto every vertex: about 24 MB instead
of about 650 KB. A float texture read with `texelFetch` is compact and exact.

**8. You upgraded three.js from r128 to r186. How did you know nothing changed?**
I listed the breaking changes that affect the picture (light units ×π, colour management, removed
soft shadows, environment intensity, fog colour, energy conservation) and compensated for each. Then
I proved it: a script loads the original prototype and the port with the same fake clock, so they
render exactly the same frames, and compares screenshots. The mean difference is under one level out
of 255, and 0% of pixels are off by more than 24, at every checkpoint.

**9. How do you keep it smooth, and what haven't you proven?**
Frame cost here is per pixel, mostly anti-aliased bevel edges. So I cap the pixel ratio at 2 and the
buffer at 5 megapixels, a governor lowers the ratio in steps if frames stay slow, a far-view geometry
drops bevel detail that is under a pixel, and the shadow map is only redrawn when something moves.
Composing the pattern runs in a Web Worker so the page stays responsive while it is cut. What I have
not proven is 60 fps
on an actual mid-range laptop GPU: my machine is fast, and my slow-machine test was CPU-bound.

**10. The brief says the gold must glint. How did you make that happen, and how did you measure it?**
A flat shiny tile only shows the sun when the sun sits at your mirror angle. The original sweep never
got there. Aiming the sun at it made all the glaze wash out too, since the glaze is satin. So the sun
keeps a margin away from the glaze's mirror band, and the gold pieces are shaded as slightly faceted,
so each one swings through its own mirror angle as the sun moves. To measure it I could not tell gold
from ochre by colour, so a script renders a mask frame (gold magenta, glaze green) with the same
camera and counts gold pixels that flash and glaze pixels that wash out. The flash dropped by about a
third, but the wash dropped about elevenfold, so the gold is now what you notice.
