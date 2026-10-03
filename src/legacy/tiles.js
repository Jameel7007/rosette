// The prototype's tile system, ported unchanged: ~10.6k square tesserae plus 81 cut centre
// pieces, coloured by position (legacy/pattern.js), dropped one at a time by a CPU loop.
//
// It implements the tile-system interface main.js talks to (docs/CONTRACTS.md §4.3):
//   { count, T_END, update(sim), startedAt(sim), landedAt(sim), stageAt(sim), rLaidAt(sim), reset() }
// so the zellige build can replace it with a single line in main.js.
//
// Everything here runs per frame on the CPU, but only over the tiles currently in the air
// (the window [lo, hi) of the sorted list), so the cost stays small even at 10k tiles.
import * as THREE from 'three';
import { TIMING } from '../config.js';
import { PROTOTYPE_PAL as PAL } from '../pattern/palette.js';   // the prototype's colours, frozen
import { jitter } from '../util/rand.js';
import { colorAt } from './pattern.js';

const TAU = Math.PI * 2;
const isGold = t => t.key === 'A';   // the prototype's one metallic key

/** The prototype's tile dimensions (kept local so tuning the zellige pieces never moves the reference). */
export const LEGACY = {
  GAP: 0.14,     // grout gap
  BEV: 0.07,     // bevel size
  BT: 0.07,      // bevel thickness
  DEPTH: 0.24,   // extrusion depth (slab is DEPTH + 2·BT tall)
  R_MEDALLION: 31,      // circular rows run out to here
  R_GRID: 31.8,         // the square grid starts here (the known bare-mortar gap is between)
  FIELD_SWEEP_A0: -2.2, // angle where each field "ring" starts, so the field sweeps like a hand
};

const { GAP, BEV, BT, DEPTH } = LEGACY;
const EXTRUDE = { depth: DEPTH, bevelEnabled: true, bevelThickness: BT, bevelSize: BEV, bevelSegments: 2, curveSegments: 1, steps: 1 };

/** ExtrudeGeometry builds along +z; turn it so the slab lies flat with its bottom at y = 0. */
function lieFlat(geo) {
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, BT, 0);
  return geo;
}

/** The one shared square tile: unit square shrunk by the bevel (the bevel grows it back). */
function boxGeometry() {
  const s = new THREE.Shape(), h = 0.5 - BEV;
  s.moveTo(-h, -h); s.lineTo(h, -h); s.lineTo(h, h); s.lineTo(-h, h); s.lineTo(-h, -h);
  return lieFlat(new THREE.ExtrudeGeometry(s, EXTRUDE));
}

/** A ring-sector piece between radii ri..ro and angles a0..a1 (an octagon when ri = 0). */
function wedgeGeometry(ri, ro, a0, a1) {
  const ins = GAP / 2 + BEV, s = new THREE.Shape(), pts = [];
  if (ri <= 0) {
    const rr = ro - ins;
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + TAU / 16; pts.push([rr * Math.cos(a), rr * Math.sin(a)]); }
  } else {
    // Inset each side by the same arc length, so the grout is even on both radii
    const R1 = ro - ins, R0 = ri + ins, o1 = ins / R1, o0 = ins / R0, seg = 4;
    for (let i = 0; i <= seg; i++) { const a = a0 + o1 + (a1 - a0 - 2 * o1) * i / seg; pts.push([R1 * Math.cos(a), R1 * Math.sin(a)]); }
    for (let i = seg; i >= 0; i--) { const a = a0 + o0 + (a1 - a0 - 2 * o0) * i / seg; pts.push([R0 * Math.cos(a), R0 * Math.sin(a)]); }
  }
  // Centre the outline on its vertex average, so the mesh pivots (tumbles) about the piece
  let cx = 0, cz = 0;
  pts.forEach(p => { cx += p[0]; cz += p[1]; });
  cx /= pts.length; cz /= pts.length;
  // Shape y = -(z - cz): after lieFlat's -90° turn about x, shape y becomes world -z
  pts.forEach((p, i) => { const X = p[0] - cx, Y = -(p[1] - cz); i ? s.lineTo(X, Y) : s.moveTo(X, Y); });
  return { geo: lieFlat(new THREE.ExtrudeGeometry(s, EXTRUDE)), cx, cz };
}

/**
 * The tile list in laying order. Every rand() call happens in the prototype's order, so the
 * same stream gives the same jitter.
 */
function buildTileList(rand) {
  const rs = jitter(rand);
  const tiles = [];
  const mkTile = o => {
    const [key, stage] = colorAt(o.x, o.z);
    o.key = key; o.stage = stage; o.r = Math.hypot(o.x, o.z);
    // Final resting pose: a hair off level, bedded slightly into the mortar, varied thickness
    o.rx = rs(0.03); o.rz = rs(0.03); o.sy = 0.88 + rand() * 0.24; o.yb = -0.03 - rand() * 0.03;
    // Tumble while falling (fades out as it lands)
    o.fx = rs(0.7); o.fz = rs(0.7); o.spin = rs(0.9);
    tiles.push(o);
    return o;
  };

  // Centre: 81 cut pieces in rings of 1, 8, 16, 24, 32; alternate rings offset half a piece
  const inner = [[0, 0.72, 1], [0.76, 1.76, 8], [1.8, 2.9, 16], [2.95, 3.95, 24], [4, 5, 32]];
  inner.forEach(([ri, ro, n], ring) => {
    const off = ring % 2 ? Math.PI / n : 0;
    for (let j = 0; j < n; j++) {
      const a0 = off + j / n * TAU, a1 = off + (j + 1) / n * TAU;
      const w = wedgeGeometry(ri, ro, a0, a1);
      const t = mkTile({ x: w.cx, z: w.cz, ry: 0, sx: 1, sz: 1, custom: true, geo: w.geo });
      if (ri <= 0) { t.x = 0; t.z = 0; t.r = 0; }
    }
  });

  // Medallion rows r = 5..31: one row per unit radius, a multiple of 16 tiles per row so the
  // 16-fold symmetry holds; odd rows shifted half a tile so joints stagger
  for (let k = 5; k < LEGACY.R_MEDALLION; k++) {
    const rm = k + 0.5, N = Math.max(32, Math.round(TAU * rm / 16) * 16), w = TAU * rm / N, off = (k % 2) * 0.5;
    for (let j = 0; j < N; j++) {
      const th = (j + 0.5 + off) / N * TAU + rs(0.08 / rm);
      mkTile({ x: rm * Math.cos(th), z: rm * Math.sin(th), ry: Math.PI / 2 - th + rs(0.05), sx: w - GAP + rs(0.04), sz: 1 - GAP + rs(0.04) });
    }
  }

  // Field and border: a straight 1×1 grid outside r = 31.8, laid ring by ring (by whole
  // units of radius), sweeping around each ring from angle A0
  const outer = [];
  for (let i = -52; i < 52; i++) for (let j = -52; j < 52; j++) {
    const x = i + 0.5, z = j + 0.5, r = Math.hypot(x, z);
    if (r < LEGACY.R_GRID) continue;
    outer.push({ x: x + rs(0.03), z: z + rs(0.03), ry: rs(0.05), sx: 1 - GAP + rs(0.05), sz: 1 - GAP + rs(0.05), _r: r, _a: Math.atan2(z, x) });
  }
  const A0 = LEGACY.FIELD_SWEEP_A0;
  outer.forEach(o => { o._k = Math.floor(o._r) + ((((o._a - A0) % TAU) + TAU) % TAU) / TAU; });
  outer.sort((a, b) => a._k - b._k).forEach(o => mkTile(o));

  return tiles;
}

/** Largest index i in [0, n] such that pred(j) is true for all j < i (pred must be monotone). */
function countWhile(n, pred) {
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pred(mid)) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Builds the prototype's tiles and adds them to the scene.
 *
 * @param scene THREE.Scene
 * @param ctx   { rand, envMap }: rand is the shared legacy stream, already advanced past the
 *              bed and floor textures (the prototype's order)
 */
export function createLegacyTiles(scene, { rand, envMap }) {
  const rs = jitter(rand);
  const tiles = buildTileList(rand);
  const N = tiles.length;

  // Materials: white base colour, the per-tile colour comes from instanceColor / the clone
  const glazeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.24, metalness: 0, envMap, envMapIntensity: 0.65 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.24, metalness: 1, envMap, envMapIntensity: 1.35 });

  // Two instanced meshes (glazed, gold) for the square tiles; the custom centre pieces are meshes
  const boxGeo = boxGeometry();
  let nGlaze = 0, nGold = 0;
  tiles.forEach(t => { if (!t.custom) (isGold(t) ? nGold++ : nGlaze++); });
  const imGlaze = new THREE.InstancedMesh(boxGeo, glazeMat, nGlaze);
  const imGold = new THREE.InstancedMesh(boxGeo, goldMat, nGold);
  [imGlaze, imGold].forEach(m => {
    m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(m);
  });

  // Glaze colour per tile: palette + small jitter. The jitter is applied in sRGB HSL (as the
  // prototype did, before it converted to linear); r186 colours are linear inside, so we say
  // SRGBColorSpace explicitly on the way in and out.
  const col = new THREE.Color(), hsl = { h: 0, s: 0, l: 0 };
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);   // a not-yet-laid tile: collapsed, draws nothing
  const tileColor = t => {
    col.set(PAL[t.key]);
    const lj = t.key === 'K' ? 0.035 : t.key === 'W' ? 0.045 : 0.07;
    col.getHSL(hsl, THREE.SRGBColorSpace);
    const dh = rs(0.008), ds = rs(0.06), dl = rs(lj);   // the prototype's offsetHSL(h, s, l) order
    return col.setHSL(hsl.h + dh, hsl.s + ds, hsl.l + dl, THREE.SRGBColorSpace);
  };

  const customMats = [];
  let iGlaze = 0, iGold = 0;
  tiles.forEach(t => {
    if (t.custom) {
      const mat = (isGold(t) ? goldMat : glazeMat).clone();
      mat.color.copy(tileColor(t));
      customMats.push(mat);
      const m = new THREE.Mesh(t.geo, mat);
      m.castShadow = m.receiveShadow = true;
      m.visible = false;
      scene.add(m);
      t.mesh = m;
      return;
    }
    if (isGold(t)) { t.im = imGold; t.idx = iGold++; } else { t.im = imGlaze; t.idx = iGlaze++; }
    t.im.setColorAt(t.idx, tileColor(t));
    t.im.setMatrixAt(t.idx, ZERO);
  });
  [imGlaze, imGold].forEach(m => { m.instanceColor.needsUpdate = true; m.instanceMatrix.needsUpdate = true; });

  // Schedule: patient at the centre, quickening outward
  const { T_START, T_SPAN, P_EXP, D, DROP } = TIMING;
  const t0 = new Float64Array(N);
  tiles.forEach((t, i) => { t.t0 = t0[i] = T_START + T_SPAN * Math.pow(i / N, P_EXP); });
  const T_END = t0[N - 1] + D;

  // Prefix max of radius, so "how far out have we laid" is one lookup
  const rPrefix = new Float64Array(N);
  tiles.forEach((t, i) => { rPrefix[i] = Math.max(i ? rPrefix[i - 1] : 0, t.r); });

  // --- the CPU drop loop ---
  const dummy = new THREE.Object3D();
  let lo = 0, hi = 0, lastSim = 0;   // [lo, hi): tiles started but not yet landed

  /** Places tile t at drop progress p (0 = start of the fall, 1 = landed). */
  function pose(t, p) {
    let y = 0, f = 0;
    if (p < 1) {
      if (p < 0.8) { const q = p / 0.8; y = DROP * (1 - q * q); f = 1 - q; }   // gravity fall, tumble fading
      else { const q = (p - 0.8) / 0.2; y = 0.06 * Math.sin(Math.PI * q); f = 0; }  // a tiny bounce
    }
    const yy = t.yb + y;
    if (t.custom) {
      t.mesh.visible = true;
      t.mesh.position.set(t.x, yy, t.z);
      t.mesh.rotation.set(t.rx + t.fx * f, t.spin * f, t.rz + t.fz * f);
      t.mesh.scale.set(1, t.sy, 1);
      return;
    }
    dummy.position.set(t.x, yy, t.z);
    dummy.rotation.set(t.rx + t.fx * f, t.ry + t.spin * f, t.rz + t.fz * f);
    dummy.scale.set(t.sx, t.sy, t.sz);
    dummy.updateMatrix();
    t.im.setMatrixAt(t.idx, dummy.matrix);
    t.im.instanceMatrix.needsUpdate = true;
  }

  function reset() {
    lo = hi = 0; lastSim = 0;
    tiles.forEach(t => {
      t.done = false;
      if (t.custom) t.mesh.visible = false; else t.im.setMatrixAt(t.idx, ZERO);
    });
    imGlaze.instanceMatrix.needsUpdate = imGold.instanceMatrix.needsUpdate = true;
  }

  function update(sim) {
    // Going back in time (a dev seek) re-lays from scratch, so the picture is always a
    // function of sim, like the shader-driven zellige pieces
    if (sim < lastSim) reset();
    lastSim = sim;
    while (hi < N && t0[hi] <= sim) hi++;
    for (let i = lo; i < hi; i++) {
      const t = tiles[i];
      if (t.done) continue;
      const p = (sim - t.t0) / D;
      pose(t, Math.min(p, 1));
      if (p >= 1) t.done = true;
    }
    while (lo < hi && tiles[lo].done) lo++;
  }

  // Pure queries by binary search over the sorted start times
  const startedAt = sim => countWhile(N, i => t0[i] <= sim);
  const landedAt = sim => countWhile(N, i => (sim - t0[i]) / D >= 1);
  const stageAt = sim => { const n = startedAt(sim); return n ? tiles[n - 1].stage : null; };
  const rLaidAt = sim => { const n = startedAt(sim); return n ? rPrefix[n - 1] : 0; };

  return {
    count: N,
    T_END,
    update,
    startedAt,
    landedAt,
    stageAt,
    rLaidAt,
    reset,
    stats: { tiles: N, glazed: nGlaze, gold: nGold, custom: N - nGlaze - nGold },
    dispose() {
      [imGlaze, imGold].forEach(m => { scene.remove(m); m.dispose(); });
      tiles.forEach(t => { if (t.custom) { scene.remove(t.mesh); t.geo.dispose(); } });
      [boxGeo, glazeMat, goldMat, ...customMats].forEach(x => x.dispose());
    },
  };
}
