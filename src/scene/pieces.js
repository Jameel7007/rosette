// The zellige pieces on the GPU: two merged meshes (glaze and gold) holding every piece at its
// final resting place, a float data texture with each piece's numbers, and a vertex shader that
// drops each piece into place on its own schedule.
//
// Per-frame CPU cost: setSim() writes one uniform. Nothing here loops over pieces after the
// build, so 15,000 pieces cost the CPU the same per frame as 15.
//
// Build:   schedule.pieces ──► per-piece random numbers + colour ──► data texture (4 texels each)
//                          └─► outlines ──► extrude.js ──► one indexed BufferGeometry per material
// Frame:   uniform uSim ──► vertex shader poses every piece (scene/shaders/drop.js)

import * as THREE from 'three';
import { buildSlabs } from './extrude.js';
import { makeSchedule } from '../anim/schedule.js';
import * as drop from './shaders/drop.js';
import { PAL, METAL, VARIATION } from '../pattern/palette.js';
import { PIECE, TIMING } from '../config.js';
import { stream, jitter } from '../util/rand.js';

/** The look of the pieces: the prototype's random ranges plus the new glaze controls. */
export const PIECE_LOOK = {
  TILT: 0.03,                 // final resting tilt rx, rz: ± radians (prototype)
  TILT_GOLD: 0.05,            // gold tilts a little more, so pieces glint at different moments
  // Gold facets: each gold top face is SHADED as if it leaned this many times further along its
  // resting tilt (so up to ±0.05 × (1 + 8) = ±0.45 rad, ~26°, per axis). Lustre glaze is never
  // optically flat and every piece is bedded at its own angle; that spread is what makes the gold
  // flash piece by piece while the sun passes (anim/light.js keeps the sun away from the glaze's
  // own mirror angle, so only faceted gold can reach it). At rest it also makes the gold read as
  // metal: neighbouring pieces mirror different parts of the room, some bright, some dark.
  // Why shading only: tilting the slabs that far would lift the 5-unit darts' tips over a unit
  // out of the bed. Glaze pieces have no facet (0), so their look is unchanged.
  // Tuned on rendered sweeps (gold found by a mask render): 4, 6, 8, 10 → 8.
  FACET_GOLD: 8,
  SY: [0.88, 1.12],           // per-piece height scale
  YB: [-0.03, -0.06],         // how far each piece sinks into the mortar
  TUMBLE: 0.7,                // fx, fz: ± radians of tumble at the start of the fall
  SPIN: 0.9,                  // ± radians of spin at the start of the fall
  ROUGH_GLAZE: [0.15, 0.35],  // per-piece roughness
  // Gold roughness (was 0.18-0.30): with facets, a slightly broader highlight lets more pieces
  // catch the passing sun, and each flash lasts long enough to see (sharper gold measured fewer)
  ROUGH_GOLD: [0.25, 0.38],
  ENV_GLAZE: 0.65,            // the prototype's reflection strengths
  ENV_GOLD: 1.35,
  // Bevel of the black (K) strap pieces. A strap piece is ~0.36 wide; two full 0.07 bevels
  // turned ~40% of it into a lighter rounded edge, so overhead the straps read as grey-edged
  // bars. Half the bevel keeps them black and continuous (rendered before/after, config.js GROUT).
  BEVEL_STRAP: 0.035,
  GLINT_WIDTH: 0.30,          // radians of sun azimuth each gold piece's sweep flash lasts (≈0.8 s mid-sweep)
  GLINT_GAIN: 7.0,            // flash brightness (HDR, before tone mapping); anim/light.js MOOD has the why
  RIPPLE: 0.05,               // glaze ripple slope; 0 = perfectly flat glaze
  RIPPLE_FREQ: 1.25,          // ripple cycles per unit (lowest octave)
};

/**
 * When to draw the far-view slabs (extrude.js: the bevel's middle ring left out). The bevel is
 * PIECE.BEVEL wide; once that is about a pixel on screen its rounded profile cannot be seen,
 * only paid for. Rendered side by side at the finished view (bevel 0.46 and 0.91 px), the two
 * differ in 0.4-0.6% of pixels and look the same in 4× crops; the GPU time drops 6-14% there.
 * Two thresholds (hysteresis) so the switch does not flicker while the camera eases.
 */
export const DETAIL = { FAR_BELOW_PX: 1.0, NEAR_ABOVE_PX: 1.3 };

/** Pieces per row of the data texture: 512 pieces × 4 texels = 2048 texels, the widest
 *  texture every WebGL2 device must support. 15,000 pieces is then 30 rows. */
const PIECES_PER_ROW = 512;

const clamp01 = x => Math.min(1, Math.max(0, x));

/** Area centroid of a polygon (fallback when a piece has no cx, cy). */
function centroid(poly) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n], c = p[0] * q[1] - q[0] * p[1];
    a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c;
  }
  return a ? [x / (3 * a), y / (3 * a)] : poly[0];
}

const _hsl = { h: 0, s: 0, l: 0 };
/**
 * One piece's glaze colour, in LINEAR RGB (what the shader wants). The jitter is applied in
 * sRGB HSL, like the prototype, so "±8% lightness" means what a potter would see.
 * Always draws exactly 6 numbers, so the stream stays aligned whatever happens.
 */
export function glazeColor(key, rand, out = new THREE.Color()) {
  const rs = jitter(rand);
  out.set(PAL[key] ?? PAL.W);                       // hex is sRGB: three converts it to linear
  out.getHSL(_hsl, THREE.SRGBColorSpace);
  const lightJitter = VARIATION.light[key] ?? VARIATION.light.default;
  const h = _hsl.h + rs(VARIATION.hue);
  const s = _hsl.s + rs(VARIATION.sat);
  let l = _hsl.l + rs(lightJitter);
  const kilnRoll = rand(), kilnDarker = rand() < 0.5, kilnSize = rand();
  // A rare "kiln" piece fired notably darker or lighter. Gold is not a glaze: no kiln pieces.
  if (!METAL.has(key) && kilnRoll < VARIATION.kiln.chance) {
    l += (kilnDarker ? -1 : 1) * VARIATION.kiln.light * (0.6 + 0.4 * kilnSize);
  }
  return out.setHSL(h, clamp01(s), clamp01(l), THREE.SRGBColorSpace);
}

/** Insert GLSL at a chunk anchor, failing loudly if three.js ever renames the chunk. */
function inject(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error(`pieces.js: shader anchor not found: ${anchor}`);
  return source.replace(anchor, replacement);
}

/**
 * Build the pieces.
 *
 * @param schedule  from anim/schedule.js makeSchedule(): pieceId = index in schedule.pieces
 * @param {object} opts
 * @param {THREE.Texture} opts.envMap   PMREM environment (given explicitly so envMapIntensity applies)
 * @param {() => number} [opts.rand]    random stream; default stream('pieces')
 * @returns {{ group: THREE.Group, setSim(sim:number): void, stats: object, dispose(): void,
 *   uniforms: object, materials: object, meshes: THREE.Mesh[] }}
 */
export function createPieces(schedule, { envMap = null, rand = stream('pieces'), height = PIECE.HEIGHT,
  bevel = PIECE.BEVEL, dropHeight = TIMING.DROP, look = PIECE_LOOK } = {}) {
  const startMs = performance.now();
  const { pieces, t0, N, D } = schedule;
  const rs = jitter(rand);
  const between = ([a, b]) => a + (b - a) * rand();

  // ---- per-piece numbers into the data texture, outlines into two lists by material
  const perRow = Math.max(1, Math.min(N, PIECES_PER_ROW));
  const width = perRow * drop.TEXELS_PER_PIECE, rows = Math.max(1, Math.ceil(N / perRow));
  const data = new Float32Array(width * rows * 4);
  const glazeItems = [], goldItems = [];
  const color = new THREE.Color();

  for (let i = 0; i < N; i++) {
    const piece = pieces[i];
    const gold = METAL.has(piece.key);
    const [cx, cy] = Number.isFinite(piece.cx) && Number.isFinite(piece.cy) ? [piece.cx, piece.cy] : centroid(piece.poly);
    // Same draws, same order as the prototype's mkTile: rx, rz, sy, yb, fx, fz, spin.
    const tilt = gold ? look.TILT_GOLD : look.TILT;
    const rx = rs(tilt), rz = rs(tilt);
    const sy = between(look.SY), yb = between(look.YB);
    const fx = rs(look.TUMBLE), fz = rs(look.TUMBLE), spin = rs(look.SPIN);
    const roughness = between(gold ? look.ROUGH_GOLD : look.ROUGH_GLAZE);
    const seed = rand();
    glazeColor(piece.key, rand, color);

    // Piece i owns texels 4i..4i+3 (16 floats). Rows are a multiple of 4 texels wide, so a
    // piece never straddles two rows. Layout documented in shaders/drop.js.
    data.set([
      t0[i], cx, cy, yb,
      fx, fz, spin, sy,
      rx, rz, roughness, seed,
      color.r, color.g, color.b, gold ? look.FACET_GOLD : 0,
    ], i * 16);
    // The black strapwork may take a smaller bevel than the rest (PIECE_LOOK.BEVEL_STRAP)
    const ownBevel = piece.key === 'K' && look.BEVEL_STRAP ? look.BEVEL_STRAP : undefined;
    (gold ? goldItems : glazeItems).push({ poly: piece.poly, id: i, pivot: [cx, cy], bevel: ownBevel });
  }

  const texture = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  // ---- shared uniforms: the same objects go into every material, so setSim writes one number
  const uniforms = {
    uPieceData: { value: texture },
    uSim: { value: 0 },
    uDropTime: { value: D },
    uDropHeight: { value: dropHeight },
    uRipple: { value: look.RIPPLE },
    uRippleFreq: { value: look.RIPPLE_FREQ },
    uGlint: { value: 0 },
    uSunAz: { value: 0 },
    uGlintWidth: { value: look.GLINT_WIDTH },
    uGlintGain: { value: look.GLINT_GAIN },
  };

  const patchStandard = material => {
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      let vs = shader.vertexShader;
      vs = inject(vs, '#include <common>', '#include <common>\n' + drop.poseParsVertex + drop.lookParsVertex);
      vs = inject(vs, 'void main() {', 'void main() {\n' + drop.poseMainStart);
      vs = inject(vs, '#include <beginnormal_vertex>', drop.poseBeginNormal);
      vs = inject(vs, '#include <begin_vertex>', drop.poseBeginVertex + drop.lookVertex);
      shader.vertexShader = vs;
      let fs = shader.fragmentShader;
      fs = inject(fs, '#include <common>', '#include <common>\n' + drop.lookParsFragment);
      fs = inject(fs, '#include <color_fragment>', '#include <color_fragment>\n' + drop.lookColorFragment);
      fs = inject(fs, '#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + drop.lookRoughnessFragment);
      fs = inject(fs, '#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + drop.lookNormalFragment);
      fs = inject(fs, '#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + drop.lookEmissiveFragment);
      shader.fragmentShader = fs;
    };
    // Glaze and gold differ only in uniforms, so they share one compiled program.
    material.customProgramCacheKey = () => 'rosette-pieces-standard-2';
    return material;
  };

  const glazeMaterial = patchStandard(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.24, metalness: 0, envMap, envMapIntensity: look.ENV_GLAZE,
  }));
  const goldMaterial = patchStandard(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.24, metalness: 1, envMap, envMapIntensity: look.ENV_GOLD,
  }));

  // Shadows: the same pose in the depth pass, so falling pieces cast moving shadows and pieces
  // that have not started (collapsed to a point) cast none.
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader;
    vs = inject(vs, '#include <common>', '#include <common>\n' + drop.poseParsVertex);
    vs = inject(vs, 'void main() {', 'void main() {\n' + drop.poseMainStart);
    vs = inject(vs, '#include <begin_vertex>', drop.poseBeginVertex);
    shader.vertexShader = vs;
  };
  depthMaterial.customProgramCacheKey = () => 'rosette-pieces-depth-1';

  // ---- geometry
  const group = new THREE.Group();
  group.name = 'pieces';
  const meshes = [];
  let vertices = 0, triangles = 0, lodTriangles = 0, reducedBevel = 0;
  const details = [];   // per mesh: { mesh, full, far }: two geometries sharing one set of vertices
  const skipped = [];
  const lift = dropHeight + 0.1;
  for (const [name, items, material] of [['glaze', glazeItems, glazeMaterial], ['gold', goldItems, goldMaterial]]) {
    if (!items.length) continue;
    const built = buildSlabs(items, { height, bevel });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(built.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(built.normal, 3));
    geometry.setAttribute('pieceId', new THREE.BufferAttribute(built.pieceId, 1));
    geometry.setIndex(new THREE.BufferAttribute(built.index, 1));
    // Bounds that hold every pose: a vertex never gets farther from its pivot than its reach
    // (× the largest height scale), and the pivot rises at most DROP (+ the bounce).
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const grow = built.maxReach * look.SY[1] + lift;
    geometry.boundingBox.expandByScalar(grow);
    geometry.boundingSphere.radius += grow;

    // The far-view slabs: the same vertex buffers (three uploads a shared attribute once),
    // their own index list and bounds
    const farGeometry = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'pieceId']) farGeometry.setAttribute(name, geometry.getAttribute(name));
    farGeometry.setIndex(new THREE.BufferAttribute(built.lodIndex, 1));
    farGeometry.boundingBox = geometry.boundingBox;
    farGeometry.boundingSphere = geometry.boundingSphere;

    const mesh = new THREE.Mesh(geometry, material);
    details.push({ mesh, full: geometry, far: farGeometry });
    mesh.userData.detail = { full: geometry, far: farGeometry };   // both, for tools that compare them
    mesh.name = `pieces-${name}`;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.customDepthMaterial = depthMaterial;
    // Draw the pieces before the bed: three sorts opaque objects by material id first, and the
    // bed's materials are older, so it was drawn first and then covered. Drawn after the pieces,
    // the bed under them fails the depth test and its shader never runs (free on GPUs that
    // already skip hidden pixels, a saving on most laptop GPUs).
    mesh.renderOrder = -1;
    group.add(mesh);
    meshes.push(mesh);
    vertices += built.vertices;
    triangles += built.triangles;
    lodTriangles += built.lodTriangles;
    reducedBevel += built.reducedBevel;
    skipped.push(...built.skipped);
  }

  const stats = {
    pieces: N - skipped.length, vertices, triangles, lodTriangles,
    glaze: glazeItems.length, gold: goldItems.length,
    reducedBevel, skipped: skipped.length,
    dataTexture: `${width}×${rows} RGBA32F`,
    buildMs: Math.round(performance.now() - startMs),
  };

  let far = false;
  return {
    group,
    /** The whole per-frame cost: one uniform write. */
    setSim(sim) { uniforms.uSim.value = sim; },
    /** The light sweep's gold glint (anim/light.js MOOD): two uniform writes. */
    setGlint(glint, sunAz) { uniforms.uGlint.value = glint; uniforms.uSunAz.value = sunAz; },
    /**
     * Chooses the full or the far-view slabs from how big one world unit is on screen (device
     * pixels per unit at the panel's centre). O(1): it swaps an index buffer, at most once per
     * crossing. Returns true while the far-view slabs are drawn.
     */
    setDetail(pxPerUnit) {
      const bevelPx = bevel * pxPerUnit;
      const want = far ? bevelPx < DETAIL.NEAR_ABOVE_PX : bevelPx < DETAIL.FAR_BELOW_PX;
      if (want !== far) {
        far = want;
        for (const d of details) d.mesh.geometry = far ? d.far : d.full;
      }
      return far;
    },
    stats,
    uniforms,
    materials: { glaze: glazeMaterial, gold: goldMaterial, depth: depthMaterial },
    meshes,
    dispose() {
      for (const d of details) { d.full.dispose(); d.far.dispose(); }
      glazeMaterial.dispose(); goldMaterial.dispose(); depthMaterial.dispose();
      texture.dispose();
    },
  };
}

/**
 * One call for main.js, mirroring createLegacyTiles(scene, { rand, envMap }):
 *
 *   const tiles = createZelligeTiles(scene, composedPieces, { envMap, rand: stream('pieces') });
 *
 * Schedules the pieces (prototype timing from config.js), builds the meshes, adds them to the
 * scene and returns the CONTRACTS §4.3 tile system (plus `stats` and `dispose`).
 */
export function createZelligeTiles(scene, pieceList, { envMap, rand = stream('pieces'), timing = TIMING } = {}) {
  const schedule = makeSchedule(pieceList, timing);
  const pieces = createPieces(schedule, { envMap, rand, dropHeight: timing.DROP });
  scene.add(pieces.group);
  return {
    ...makeTileSystem(schedule, pieces),
    stats: pieces.stats,
    group: pieces.group,   // the meshes (e.g. to precompile their shader before showing them)
    schedule,   // the pieces in laying order with their start times (e.g. for the HUD's labels)
    dispose() { scene.remove(pieces.group); pieces.dispose(); },
  };
}

/**
 * The tile-system object main.js talks to (CONTRACTS §4.3), built from a schedule and the
 * pieces made from it (createZelligeTiles above does exactly this):
 *
 *   const schedule = makeSchedule(composePieces(...), TIMING);
 *   const pieces = createPieces(schedule, { envMap, rand: stream('pieces') });
 *   scene.add(pieces.group);
 *   const tiles = makeTileSystem(schedule, pieces);
 *   // each frame: tiles.update(sim); then tiles.landedAt(sim), tiles.stageAt(sim), tiles.rLaidAt(sim) for HUD/camera
 *
 * Every method is O(1) or O(log N): update() is one uniform write, the queries are binary searches.
 */
export function makeTileSystem(schedule, pieces) {
  return {
    count: schedule.N,
    T_END: schedule.T_END,
    update(sim) { pieces.setSim(sim); },
    startedAt: schedule.startedAt,
    landedAt: schedule.landedAt,
    stageAt: schedule.stageAt,
    rLaidAt: schedule.rLaidAt,
    rCoveredAt: schedule.rCoveredAt,   // radius inside which everything has landed (the bed hides its underdrawing there)
    setDetail: pieces.setDetail,       // full or far-view slabs (see DETAIL)
    setGlint: pieces.setGlint,         // the light sweep's gold glint
    // All piece state is a function of sim, so there is nothing to clear: back to "none started".
    reset() { pieces.setSim(0); },
  };
}
