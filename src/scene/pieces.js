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
  SY: [0.88, 1.12],           // per-piece height scale
  YB: [-0.03, -0.06],         // how far each piece sinks into the mortar
  TUMBLE: 0.7,                // fx, fz: ± radians of tumble at the start of the fall
  SPIN: 0.9,                  // ± radians of spin at the start of the fall
  ROUGH_GLAZE: [0.15, 0.35],  // per-piece roughness
  ROUGH_GOLD: [0.18, 0.30],
  ENV_GLAZE: 0.65,            // the prototype's reflection strengths
  ENV_GOLD: 1.35,
  RIPPLE: 0.05,               // glaze ripple slope; 0 = perfectly flat glaze
  RIPPLE_FREQ: 1.25,          // ripple cycles per unit (lowest octave)
};

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
      color.r, color.g, color.b, 0,
    ], i * 16);
    (gold ? goldItems : glazeItems).push({ poly: piece.poly, id: i, pivot: [cx, cy] });
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
      shader.fragmentShader = fs;
    };
    // Glaze and gold differ only in uniforms, so they share one compiled program.
    material.customProgramCacheKey = () => 'rosette-pieces-standard-1';
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
  let vertices = 0, triangles = 0, reducedBevel = 0;
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

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `pieces-${name}`;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.customDepthMaterial = depthMaterial;
    group.add(mesh);
    meshes.push(mesh);
    vertices += built.vertices;
    triangles += built.triangles;
    reducedBevel += built.reducedBevel;
    skipped.push(...built.skipped);
  }

  const stats = {
    pieces: N - skipped.length, vertices, triangles,
    glaze: glazeItems.length, gold: goldItems.length,
    reducedBevel, skipped: skipped.length,
    dataTexture: `${width}×${rows} RGBA32F`,
    buildMs: Math.round(performance.now() - startMs),
  };

  return {
    group,
    /** The whole per-frame cost: one uniform write. */
    setSim(sim) { uniforms.uSim.value = sim; },
    stats,
    uniforms,
    materials: { glaze: glazeMaterial, gold: goldMaterial, depth: depthMaterial },
    meshes,
    dispose() {
      for (const mesh of meshes) mesh.geometry.dispose();
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
    // All piece state is a function of sim, so there is nothing to clear: back to "none started".
    reset() { pieces.setSim(0); },
  };
}
