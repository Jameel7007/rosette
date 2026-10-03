// Tests for src/scene/extrude.js: the slab mesh builder that runs before anything reaches the GPU.
// Every shape is checked for: outward-facing triangles, a closed and consistently wound
// surface, top faces facing +y, a sane volume, and an inset top cap that does not cross itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import { planSlab, buildSlabs, isSimplePolygon, signedArea, cleanPolygon, SLAB } from '../src/scene/extrude.js';

const H = 0.38, BEVEL = 0.07;
const OPTS = { height: H, bevel: BEVEL };

// ---------------------------------------------------------------- shapes

function star8(tip = 1.75, notch = 0.95, cx = 0, cy = 0, rot = 0) {
  const pts = [];
  for (let k = 0; k < 16; k++) {
    const a = rot + (k * Math.PI) / 8, r = k % 2 ? notch : tip;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
const strap = [[0, 0], [1.2, 0], [1.5, 0.3], [0.3, 0.3]];             // 0.3 × 1.2, 45° ends
const hexagon = Array.from({ length: 6 }, (_, k) => [0.5 * Math.cos(k * Math.PI / 3), 0.5 * Math.sin(k * Math.PI / 3)]);
const ngon32 = Array.from({ length: 32 }, (_, k) => [Math.cos(k * Math.PI / 16), Math.sin(k * Math.PI / 16)]);
// A square with a quarter disc bitten out of one corner: concave, with a polygonal arc.
const bitten = [[1, 0], [2, 0], [2, 2], [0, 2], [0, 1],
  ...Array.from({ length: 7 }, (_, k) => { const a = Math.PI / 2 * (1 - (k + 1) / 8); return [Math.cos(a), Math.sin(a)]; })];
// A star clipped by a disc with polygon-clipping, the way cut.js will produce boundary pieces.
const disc = Array.from({ length: 48 }, (_, k) => [1.6 + 1.3 * Math.cos(k * Math.PI / 24), 0.4 + 1.3 * Math.sin(k * Math.PI / 24)]);
const clippedStar = polygonClipping.difference([star8()], [disc])[0][0].slice(0, -1);   // drop the closing point
const sliver = [[0, 0], [1, 0], [0.5, 0.08]];

// ---------------------------------------------------------------- mesh checks

function buildOne(poly, id = 0) {
  return buildSlabs([{ poly, id, pivot: [0, 0] }], OPTS);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function checkMesh(name, mesh, { strictNormals = true } = {}) {
  const P = i => [mesh.position[3 * i], mesh.position[3 * i + 1], mesh.position[3 * i + 2]];
  const Nrm = i => [mesh.normal[3 * i], mesh.normal[3 * i + 1], mesh.normal[3 * i + 2]];
  const idx = mesh.index;
  let volume = 0, topTris = 0;

  // Weld vertices by position so the hard-corner copies count as one point.
  const key = i => P(i).map(v => Math.round(v * 1e6)).join(',');
  const weld = new Map(), id = new Uint32Array(mesh.vertices);
  for (let i = 0; i < mesh.vertices; i++) { const k = key(i); if (!weld.has(k)) weld.set(k, weld.size); id[i] = weld.get(k); }
  const directed = new Map();

  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const g = cross(sub(P(b), P(a)), sub(P(c), P(a)));       // geometric normal (right hand)
    const area2 = Math.hypot(...g);
    assert.ok(area2 > 1e-12, `${name}: degenerate triangle ${t / 3}`);
    // Each triangle faces the same way as its vertex normals.
    const nSum = [0, 0, 0];
    for (const v of [a, b, c]) { const n = Nrm(v); nSum[0] += n[0]; nSum[1] += n[1]; nSum[2] += n[2]; }
    if (strictNormals) assert.ok(dot(g, nSum) > 0, `${name}: triangle ${t / 3} faces against its normals`);
    // Top cap triangles (all normals straight up) must face +y.
    if ([a, b, c].every(v => Nrm(v)[1] === 1)) { topTris++; assert.ok(g[1] > 0, `${name}: top face points down`); }
    volume += dot(P(a), cross(P(b), P(c))) / 6;               // divergence theorem
    for (const [u, w] of [[a, b], [b, c], [c, a]]) {
      const k = id[u] + '>' + id[w];
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  // Closed and consistently wound: every directed edge appears once, and its reverse once.
  for (const [k, count] of directed) {
    assert.equal(count, 1, `${name}: directed edge ${k} used ${count} times`);
    const [u, w] = k.split('>');
    assert.ok(directed.has(w + '>' + u), `${name}: edge ${k} is a hole in the surface`);
  }
  // Every normal is unit length.
  for (let i = 0; i < mesh.vertices; i++) assert.ok(Math.abs(Math.hypot(...Nrm(i)) - 1) < 1e-6, `${name}: normal ${i} not unit`);
  assert.ok(topTris > 0, `${name}: no top cap`);
  return { volume };
}

function checkShape(name, poly, checkOpts) {
  const plan = planSlab(poly, { bevel: BEVEL });
  assert.ok(plan, `${name}: planSlab returned null`);
  const mesh = buildOne(poly);
  const { volume } = checkMesh(name, mesh, checkOpts);
  // The inset top-cap outline is a proper polygon inside the piece.
  assert.ok(isSimplePolygon(plan.top), `${name}: top cap self-intersects`);
  assert.ok(signedArea(plan.top) > 0, `${name}: top cap inverted`);
  const outer = signedArea(plan.pts), inner = signedArea(plan.top);
  assert.ok(volume > inner * H - 1e-9 && volume < outer * H + 1e-9,
    `${name}: volume ${volume.toFixed(4)} outside [${(inner * H).toFixed(4)}, ${(outer * H).toFixed(4)}]`);
  return { plan, mesh, volume };
}

// ---------------------------------------------------------------- tests

test('8-point star: closed, outward, crisp points, inset does not cross at the 45° tips', () => {
  const { plan, mesh } = checkShape('star', star8());
  assert.equal(plan.n, 16);
  assert.equal(plan.hardCount, 16, 'every star corner (tips 135°, notches 90° turn) is hard');
  assert.equal(plan.scale, 1, 'a full-size star gets the full bevel');
  assert.equal(mesh.vertices, 5 * 16 + 3 * 16);
  // The tip mitre (1/sin 22.5° ≈ 2.61) is under the limit, so the top cap tip is exact:
  // the inset edges stay parallel to the outline at the bevel distance.
  const tipHalfAngle = Math.atan2(0.95 * Math.sin(Math.PI / 8), 1.75 - 0.95 * Math.cos(Math.PI / 8));
  const tip = plan.top[0];
  assert.ok(Math.abs(tip[0] - (1.75 - BEVEL / Math.sin(tipHalfAngle))) < 1e-9, `tip inset at ${tip[0]}`);
  assert.ok(Math.abs(tip[1]) < 1e-9);
});

test('star tip with a capped mitre (very sharp point) still builds a valid slab', () => {
  // Tips about 25°: the mitre would be 4.6 × the bevel, capped at 3.
  checkShape('sharp star', star8(1.75, 0.6));
  // A 22.5° kite point, the sharpest angle in 16-fold work.
  const a = Math.PI / 16;
  checkShape('22.5° kite', [[0, 0], [2 * Math.cos(a), -2 * Math.sin(a)], [2.3, 0], [2 * Math.cos(a), 2 * Math.sin(a)]]);
});

test('thin strap 0.3 × 1.2 with 45° ends', () => {
  const { plan } = checkShape('strap', strap);
  assert.equal(plan.scale, 1);
  assert.equal(plan.hardCount, 4);
});

test('hexagon stays small: under 60 vertices', () => {
  const { mesh } = checkShape('hexagon', hexagon);
  assert.ok(mesh.vertices < 60, `${mesh.vertices} vertices`);
  assert.equal(mesh.vertices, 48);
  assert.equal(mesh.triangles, 4 + 4 + 6 * 6);
});

test('concave pieces: bitten square and a star clipped by a disc', () => {
  const { plan } = checkShape('bitten', bitten);
  assert.equal(plan.convex, false);
  // The arc vertices turn gently (11.25°), so only the 3 square corners and the 2 arc ends are hard.
  assert.equal(plan.hardCount, 5);
  const clipped = checkShape('clipped star', clippedStar);
  assert.equal(clipped.plan.convex, false);
});

test('a smooth 32-gon has no split normals: shading is continuous around it', () => {
  const { plan, mesh } = checkShape('32-gon', ngon32);
  assert.equal(plan.hardCount, 0);
  assert.equal(mesh.vertices, 5 * 32);
});

test('a sliver too thin for the full bevel gets a smaller one and stays closed', () => {
  // A 9° point squashed into 0.08 units: the capped mitre twists the bevel so much that a
  // shading normal can disagree with its facet. The surface is still closed and outward.
  const { plan } = checkShape('sliver', sliver, { strictNormals: false });
  assert.ok(plan.scale < 1 && plan.scale > 0, `bevel scale ${plan.scale}`);
});

test('clockwise input and duplicate points are cleaned up', () => {
  const cw = [...hexagon].reverse();
  const dup = [hexagon[0], hexagon[0], ...hexagon.slice(1), [hexagon[5][0] + 1e-5, hexagon[5][1]]];
  assert.ok(signedArea(cleanPolygon(cw)) > 0);
  assert.equal(cleanPolygon(dup).length, 6);
  checkShape('cw hexagon', cw);
  assert.equal(cleanPolygon([[0, 0], [1, 0], [2, 0]]), null, 'collinear points are not a polygon');
});

test('pieceId is written per vertex and is exact for large ids', () => {
  const big = 16_000_000;   // float32 holds integers exactly up to 2^24 = 16,777,216
  const mesh = buildSlabs([
    { poly: hexagon, id: 3, pivot: [0, 0] },
    { poly: strap, id: big, pivot: [0.75, 0.15] },
  ], OPTS);
  const hexVerts = 48;
  for (let i = 0; i < mesh.vertices; i++) assert.equal(mesh.pieceId[i], i < hexVerts ? 3 : big);
  // Indices of the second piece point at its own vertices only.
  for (let t = 0; t < mesh.index.length; t++) {
    const v = mesh.index[t];
    assert.equal(mesh.pieceId[v], t < (4 + 4 + 36) * 3 ? 3 : big);
  }
});

test('12,000 mixed pieces build quickly into one set of buffers', () => {
  const items = [];
  const shapes = [hexagon, strap, star8(0.9, 0.49), [[-0.43, -0.43], [0.43, -0.43], [0.43, 0.43], [-0.43, 0.43]], bitten.map(p => [p[0] * 0.5, p[1] * 0.5])];
  for (let i = 0; i < 12000; i++) {
    const s = shapes[i % shapes.length], ox = (i % 110) * 2, oy = Math.floor(i / 110) * 2;
    items.push({ poly: s.map(p => [p[0] + ox, p[1] + oy]), id: i, pivot: [ox, oy] });
  }
  const t = performance.now();
  const mesh = buildSlabs(items, OPTS);
  const ms = performance.now() - t;
  console.log(`  12k pieces: ${mesh.vertices} vertices, ${mesh.triangles} triangles in ${ms.toFixed(0)} ms (Node)`);
  assert.equal(mesh.pieces, 12000);
  assert.equal(mesh.skipped.length, 0);
  assert.ok(ms < 3000, `build took ${ms} ms`);
});

// ---------------------------------------------------------------- createPieces (no GPU needed)
// three.js builds materials, textures and geometry fine in Node; only drawing needs WebGL.
import * as THREE from 'three';
import { createPieces, createZelligeTiles, makeTileSystem, glazeColor, PIECE_LOOK, DETAIL } from '../src/scene/pieces.js';
import { makeSchedule } from '../src/anim/schedule.js';
import { stream, mulberry } from '../src/util/rand.js';
import { PAL, VARIATION } from '../src/pattern/palette.js';
import { TIMING, PIECE } from '../src/config.js';

function fieldOfPieces(n) {
  const keys = ['W', 'K', 'B', 'T', 'G', 'O', 'R', 'A'];
  return Array.from({ length: n }, (_, i) => {
    const ox = (i % 40) * 2, oy = Math.floor(i / 40) * 2;
    const poly = (i % 3 === 0 ? hexagon : i % 3 === 1 ? strap : star8(0.9, 0.49)).map(p => [p[0] + ox, p[1] + oy]);
    return { poly, key: keys[i % keys.length], seq: n - i, cx: ox, cy: oy, r: Math.hypot(ox, oy), stage: 'Field' };
  });
}

test('createPieces: data texture holds each piece\'s numbers in the documented layout', () => {
  const schedule = makeSchedule(fieldOfPieces(700), TIMING);
  const built = createPieces(schedule, { rand: stream('pieces') });
  const tex = built.uniforms.uPieceData.value;
  assert.equal(tex.image.width, 2048, 'rows are 512 pieces × 4 texels');
  assert.equal(tex.image.height, 2);
  assert.equal(tex.type, THREE.FloatType);
  assert.equal(tex.magFilter, THREE.NearestFilter);
  const d = tex.image.data;
  const hsl = {};
  for (let i = 0; i < schedule.N; i++) {
    const piece = schedule.pieces[i], gold = piece.key === 'A';
    const [t0, cx, cz, yb, fx, fz, spin, sy, rx, rz, rough, seed, r, g, b] = d.subarray(i * 16, i * 16 + 15);
    assert.equal(t0, schedule.t0[i]);
    assert.equal(cx, Math.fround(piece.cx)); assert.equal(cz, Math.fround(piece.cy));
    assert.ok(yb <= -0.03 + 1e-7 && yb >= -0.06 - 1e-7, `yb ${yb}`);
    assert.ok(sy >= 0.88 - 1e-7 && sy <= 1.12 + 1e-7, `sy ${sy}`);
    assert.ok(Math.abs(fx) <= 0.7 && Math.abs(fz) <= 0.7 && Math.abs(spin) <= 0.9);
    const tilt = gold ? PIECE_LOOK.TILT_GOLD : PIECE_LOOK.TILT;
    assert.ok(Math.abs(rx) <= tilt + 1e-7 && Math.abs(rz) <= tilt + 1e-7);
    const [lo, hi] = gold ? PIECE_LOOK.ROUGH_GOLD : PIECE_LOOK.ROUGH_GLAZE;
    assert.ok(rough >= lo - 1e-6 && rough <= hi + 1e-6, `roughness ${rough}`);
    assert.ok(seed >= 0 && seed < 1);
    // Colour is linear RGB near the palette colour; the jitter is measured in sRGB HSL.
    new THREE.Color(r, g, b).getHSL(hsl, THREE.SRGBColorSpace);
    const base = {}; new THREE.Color(PAL[piece.key]).getHSL(base, THREE.SRGBColorSpace);
    const maxL = (VARIATION.light[piece.key] ?? VARIATION.light.default) + (gold ? 0 : VARIATION.kiln.light) + 1e-3;
    assert.ok(Math.abs(hsl.l - base.l) <= maxL, `lightness jitter ${hsl.l - base.l} for ${piece.key}`);
  }
  assert.equal(built.stats.pieces, 700);
  assert.equal(built.stats.gold + built.stats.glaze, 700);
  assert.equal(built.meshes.length, 2);
  // Every mesh vertex points at a piece of the right material.
  for (const mesh of built.meshes) {
    const ids = mesh.geometry.getAttribute('pieceId').array;
    const wantGold = mesh.material.metalness === 1;
    for (let v = 0; v < ids.length; v += 97) assert.equal(schedule.pieces[ids[v]].key === 'A', wantGold);
    assert.ok(mesh.customDepthMaterial, 'shadows use the animated depth material');
    assert.ok(mesh.castShadow && mesh.receiveShadow);
  }
  built.dispose();
});

test('createPieces is deterministic for a given random stream', () => {
  const pieces = fieldOfPieces(120);
  const a = createPieces(makeSchedule(pieces, TIMING), { rand: stream('pieces') });
  const b = createPieces(makeSchedule(pieces, TIMING), { rand: stream('pieces') });
  assert.deepEqual(a.uniforms.uPieceData.value.image.data, b.uniforms.uPieceData.value.image.data);
});

test('glaze colours: jitter in sRGB HSL, rare kiln pieces, gold never kiln-fired', () => {
  const rand = mulberry(9), hsl = {}, base = {};
  new THREE.Color(PAL.G).getHSL(base, THREE.SRGBColorSpace);
  let kiln = 0;
  for (let i = 0; i < 5000; i++) {
    glazeColor('G', rand).getHSL(hsl, THREE.SRGBColorSpace);
    if (Math.abs(hsl.l - base.l) > VARIATION.light.default + 1e-3) kiln++;
  }
  assert.ok(kiln > 20 && kiln < 200, `${kiln} kiln pieces in 5000 (chance ${VARIATION.kiln.chance})`);
  new THREE.Color(PAL.A).getHSL(base, THREE.SRGBColorSpace);
  for (let i = 0; i < 2000; i++) {
    glazeColor('A', rand).getHSL(hsl, THREE.SRGBColorSpace);
    assert.ok(Math.abs(hsl.l - base.l) <= VARIATION.light.default + 1e-3);
  }
});

test('shader injection finds every three.js chunk it needs (r186 standard + depth)', () => {
  const built = createPieces(makeSchedule(fieldOfPieces(10), TIMING), {});
  const run = (material, lib) => {
    const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    material.onBeforeCompile(shader);
    return shader;
  };
  const std = run(built.materials.glaze, THREE.ShaderLib.standard);
  assert.match(std.vertexShader, /PiecePose piecePose = computePiecePose\(\);/);
  assert.match(std.vertexShader, /vec3 objectNormal = poseNormal\( piecePose, normal \);/);
  assert.match(std.vertexShader, /vec3 transformed = posePosition\( piecePose, position \);/);
  assert.doesNotMatch(std.vertexShader, /#include <begin_vertex>|#include <beginnormal_vertex>/);
  assert.match(std.fragmentShader, /roughnessFactor = vPieceRough;/);
  assert.match(std.fragmentShader, /diffuseColor\.rgb \*= vPieceColor;/);
  assert.match(std.fragmentShader, /rippleSlope\( vRippleUV/);
  // The pose must come before the first chunk that uses it.
  assert.ok(std.vertexShader.indexOf('computePiecePose();') < std.vertexShader.indexOf('poseNormal( piecePose'));
  assert.equal(std.uniforms.uSim, built.uniforms.uSim, 'materials share the uniform objects');
  const depth = run(built.materials.depth, THREE.ShaderLib.depth);
  assert.match(depth.vertexShader, /vec3 transformed = posePosition\( piecePose, position \);/);
  assert.equal(depth.uniforms.uSim, built.uniforms.uSim);
  assert.equal(built.materials.depth.depthPacking, THREE.RGBADepthPacking);
  built.dispose();
});

test('the tile system: one uniform per frame, schedule queries, reset', () => {
  const scene = new THREE.Scene();
  const tiles = createZelligeTiles(scene, fieldOfPieces(50), { rand: stream('pieces') });
  assert.equal(tiles.count, 50);
  assert.ok(tiles.T_END > TIMING.T_START);
  assert.equal(scene.getObjectByName('pieces').children.length, 2);
  assert.ok(scene.getObjectByName('pieces-glaze') && scene.getObjectByName('pieces-gold'));
  tiles.update(12.5);
  assert.equal(tiles.landedAt(1e9), 50);
  assert.equal(tiles.startedAt(0), 0);
  assert.equal(tiles.stageAt(1e9), 'Field');
  for (const k of ['count', 'T_END', 'update', 'startedAt', 'landedAt', 'stageAt', 'rLaidAt', 'reset']) assert.ok(k in tiles, k);
  tiles.dispose();
  assert.equal(scene.getObjectByName('pieces'), undefined);

  // makeTileSystem.update writes exactly the shared uSim uniform.
  const schedule = makeSchedule(fieldOfPieces(5), TIMING);
  const pieces = createPieces(schedule, {});
  const sys = makeTileSystem(schedule, pieces);
  sys.update(7.25);
  assert.equal(pieces.uniforms.uSim.value, 7.25);
  sys.reset();
  assert.equal(pieces.uniforms.uSim.value, 0);
  pieces.dispose();
});

// ---------------------------------------------------------------- far-view slabs, facets, draw order

test('far-view index list: same vertices, closed surface, caps kept, no bevel rings', () => {
  for (const [name, poly] of [['star', star8()], ['strap', strap], ['hexagon', hexagon], ['clipped star', clippedStar]]) {
    const mesh = buildOne(poly);
    const far = { ...mesh, index: mesh.lodIndex };
    checkMesh(`${name} (far view)`, far, { strictNormals: false });   // one band from up-normals to side-normals, then the wall
    assert.ok(mesh.lodTriangles < mesh.triangles * 0.85, `${name}: ${mesh.lodTriangles} vs ${mesh.triangles} triangles`);
    // The far list skips the bevel's middle rings: only the top cap, the bevel's last ring
    // (facing sideways), the foot ring and the bottom cap
    const used = new Set(mesh.lodIndex);
    const plan = planSlab(poly, { bevel: BEVEL });
    const ringSize = plan.n + plan.hardCount;
    // writeSlab's vertex order: top cap ring (n), bevel rings 1..segments, foot ring, bottom ring
    const bevelRings = [plan.n, plan.n + (SLAB.BEVEL_SEGMENTS - 1) * ringSize];
    for (let v = bevelRings[0]; v < bevelRings[1]; v++) assert.ok(!used.has(v), `${name}: far view uses bevel vertex ${v}`);
  }
});

test('createPieces: gold carries a facet gain, glaze none; pieces draw before the bed', () => {
  const schedule = makeSchedule(fieldOfPieces(64), TIMING);
  const built = createPieces(schedule, { rand: stream('pieces') });
  const d = built.uniforms.uPieceData.value.image.data;
  for (let i = 0; i < schedule.N; i++) {
    assert.equal(d[i * 16 + 15], schedule.pieces[i].key === 'A' ? PIECE_LOOK.FACET_GOLD : 0);
  }
  for (const mesh of built.meshes) assert.ok(mesh.renderOrder < 0, 'pieces first: the bed under them is depth-rejected');
  // setDetail swaps to the far-view geometry below ~a pixel of bevel, with hysteresis
  const bevelPx = px => px / PIECE.BEVEL;
  assert.equal(built.setDetail(bevelPx(2)), false);
  const fullGeometry = built.meshes[0].geometry;
  assert.equal(built.setDetail(bevelPx(DETAIL.FAR_BELOW_PX * 0.9)), true);
  assert.notEqual(built.meshes[0].geometry, fullGeometry);
  assert.equal(built.meshes[0].geometry.getAttribute('position'), fullGeometry.getAttribute('position'), 'vertices are shared');
  assert.equal(built.setDetail(bevelPx((DETAIL.FAR_BELOW_PX + DETAIL.NEAR_ABOVE_PX) / 2)), true, 'stays far until clearly bigger');
  assert.equal(built.setDetail(bevelPx(DETAIL.NEAR_ABOVE_PX * 1.1)), false);
  assert.equal(built.meshes[0].geometry, fullGeometry);
  built.dispose();
});
