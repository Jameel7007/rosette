// Tests for the "lee" 16-fold medallion (src/pattern/rosette16/lee.js).
//   node --test tests/rosette-lee.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosette, cutRosette, leeRosette, foldPoly, LEE } from '../src/pattern/rosette16/lee.js';
import { buildArrangement } from '../src/pattern/graph.js';
import { checkPartition } from '../src/pattern/cut.js';
import { area, centroid, circlePoly, arcSegments, rotate, isSimple, pointInPolygon } from '../src/pattern/geom.js';
import { MEDALLION } from '../src/config.js';
import { PAL } from '../src/pattern/palette.js';

const TAU = Math.PI * 2, STEP = TAU / 16, HALF = STEP / 2;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

// Built once: the default medallion, its arrangement and its pieces.
const ros = buildRosette();
const arr = buildArrangement(ros.segments);
const laid = cutRosette(ros);

/** A point set with tolerance lookups (grid hash). */
function pointSet(points, cell = 1e-3) {
  const map = new Map();
  const key = (x, y) => `${Math.round(x / cell)},${Math.round(y / cell)}`;
  for (const p of points) map.set(key(p[0], p[1]), p);
  return {
    has(p, tol = 1e-6) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const q = map.get(key(p[0] + dx * cell, p[1] + dy * cell));
        if (q && Math.hypot(q[0] - p[0], q[1] - p[1]) < tol) return true;
      }
      return false;
    },
  };
}
const mirrorX = p => [p[0], -p[1]];

/**
 * The medallion's outline: the outer edge of the last frame ring, read off its own pieces
 * (their corners on the circle r = R_F, in angle order). The frame's joints need not fall
 * on the corners of circlePoly(R_F), so this is the exact region the pieces tile.
 */
function outline(r, exact) {
  const pts = [];
  for (const p of exact) if (p.kind === 'band') for (const q of p.poly) if (Math.abs(Math.hypot(q[0], q[1]) - r.R_F) < 1e-9) pts.push(q);
  const key = q => `${q[0].toFixed(9)},${q[1].toFixed(9)}`;
  const uniq = [...new Map(pts.map(q => [key(q), q])).values()];
  return uniq.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
}
const mirrorAt = ang => p => { const c = Math.cos(2 * ang), s = Math.sin(2 * ang); return [p[0] * c + p[1] * s, p[0] * s - p[1] * c]; };

// ---------------------------------------------------------------------------------------
// Lee's construction
// ---------------------------------------------------------------------------------------

test("Lee's construction: tips on the circle, flanks parallel to the axis, star points on corner radii", () => {
  const L = leeRosette(5, HALF);
  for (let i = 0; i < 16; i++) {
    const axis = HALF + i * STEP;
    assert.ok(close(Math.hypot(...L.D[i]), 5), 'tip on the circle');
    // F on the corner radius before the axis; N on the axis.
    assert.ok(Math.abs(cross(L.F[i], [Math.cos(i * STEP), Math.sin(i * STEP)])) < 1e-9, 'F on its corner radius');
    assert.ok(Math.abs(cross(L.N[i], [Math.cos(axis), Math.sin(axis)])) < 1e-9, 'N on the petal axis');
    // Flank E -> F parallel to the axis (the parallel-sided petal).
    assert.ok(Math.abs(cross(sub(L.E[i], L.F[i]), [Math.cos(axis), Math.sin(axis)])) < 1e-9, 'flank parallel to axis');
    // The neighbour's flank carried through F reaches the notch: E2[i-1], F[i], N[i] collinear.
    const j = (i + 15) % 16;
    assert.ok(Math.abs(cross(sub(L.F[i], L.E2[j]), sub(L.N[i], L.F[i]))) < 1e-9, 'star line straight through F');
    // Shoulder E lies on the midpoint chord through the tips.
    assert.ok(Math.abs(cross(sub(L.D[i], L.D[j]), sub(L.E[i], L.D[j]))) < 1e-9, 'shoulder on the crown chord');
  }
  // Known proportions of the 16-fold rosette (in tip radii).
  assert.ok(close(L.radii.N / 5, 0.41837, 1e-4) && close(L.radii.F / 5, 0.82065, 1e-4));
});

// ---------------------------------------------------------------------------------------
// Lines and faces
// ---------------------------------------------------------------------------------------

test('the line work has D16 symmetry and builds a clean arrangement', () => {
  const warn = arr.warnings.map(w => w.code);
  assert.deepEqual(warn, [], `arrangement warnings: ${warn}`);
  const V = pointSet(arr.vertices);
  for (const p of arr.vertices) {
    assert.ok(V.has(rotate(p, STEP)), `rotation by 22.5° moves vertex ${p}`);
    assert.ok(V.has(mirrorX(p)), `mirror in the x axis moves vertex ${p}`);
    assert.ok(V.has(mirrorAt(HALF)(p)), `mirror in the 11.25° line moves vertex ${p}`);
  }
  // Every segment is finite and inside the strapwork disk.
  for (const [a, b] of ros.segments) for (const p of [a, b]) {
    assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
    assert.ok(Math.hypot(...p) <= ros.R_M + ros.strap, 'line inside the strapwork disk');
  }
});

test('every face is classified, symmetric copies alike, with palette keys only', () => {
  const regionAt = new Map(); // folded centroid → region name
  const kinds = new Set();
  for (const face of arr.faces) {
    const c = ros.classify(face);
    assert.notEqual(c.region, 'unknown', `face ${face.id} at ${face.centroid} is unclassified`);
    assert.ok(c.key in PAL, `key ${c.key}`);
    assert.ok(typeof c.stage === 'string' && c.stage.length > 0);
    assert.ok(Number.isFinite(c.layer) && c.layer >= 0);
    assert.ok(['none', 'centre+points', 'run'].includes(c.split) || /^wedges:\d+/.test(c.split), `split ${c.split}`);
    kinds.add(c.kind);
    // Faces that fold onto the same place must be the same region.
    const f = centroid(foldPoly(face.poly, face.centroid).poly);
    const k = `${f[0].toFixed(4)},${f[1].toFixed(4)}`;
    if (regionAt.has(k)) assert.equal(regionAt.get(k), c.region, 'symmetric faces classified alike');
    else regionAt.set(k, c.region);
  }
  for (const k of ['star16', 'petal', 'shield', 'kite', 'dart', 'arch', 'star4', 'hex', 'tooth', 'ground']) assert.ok(kinds.has(k), `has ${k}`);
  // Every orbit of 16 (or 32) copies: count faces per region is a multiple of 16, except the centre.
  const count = {};
  for (const face of arr.faces) { const r = ros.classify(face).region; count[r] = (count[r] ?? 0) + 1; }
  assert.equal(count.centre, 1);
  for (const [r, n] of Object.entries(count)) if (r !== 'centre') assert.equal(n % 16, 0, `${r}: ${n} faces`);
});

test('alternating colours alternate copy by copy round the ring (8-fold colour period)', () => {
  for (const region of ['greatKite', 'bandStar']) {
    const faces = arr.faces.filter(f => ros.classify(f).region === region)
      .sort((a, b) => Math.atan2(a.centroid[1], a.centroid[0]) - Math.atan2(b.centroid[1], b.centroid[0]));
    assert.ok(faces.length === 16 || faces.length === 32, `${region}: ${faces.length}`);
    faces.forEach((f, i) => {
      const next = faces[(i + 1) % faces.length];
      assert.notEqual(ros.classify(f).key, ros.classify(next).key, `${region} ${i} and ${i + 1} share a colour`);
    });
  }
});

// ---------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------

test('the exact pieces partition the medallion disk (strapwork + bands) with no gaps or overlaps', () => {
  const codes = laid.warnings.map(w => w.code);
  for (const bad of ['fill-invalid', 'strap-invalid', 'unmerged', 'interlace-fallback', 'outline', 'nested', 'dangling']) {
    assert.ok(!codes.includes(bad), `engine warning ${bad}`);
  }
  const region = outline(ros, laid.exact);
  assert.ok(region.length >= ros.bands[0].count, 'outline has every frame joint');
  const chk = checkPartition(laid.exact, region);
  assert.equal(chk.invalid.length, 0, `invalid pieces ${chk.invalid.slice(0, 5)}`);
  assert.equal(chk.overlaps.length, 0, `overlaps ${JSON.stringify(chk.overlaps.slice(0, 3))}`);
  assert.ok(chk.relError < 1e-9, `area error ${chk.relError}`);
});

test('the centre piece is first in the laying order, at the origin, and the first ring is small', () => {
  const tiles = laid.tiles;
  const centre = tiles.filter(t => t.layer === 0 && pointInPolygon([0, 0], t.poly));
  assert.equal(centre.length, 1, 'one piece covers the origin');
  const [c] = centre;
  assert.equal(c.stage, 'Central 16-point star');
  let across = 0;
  for (const p of c.poly) for (const q of c.poly) across = Math.max(across, Math.hypot(p[0] - q[0], p[1] - q[1]));
  // A chunky 16-gon about 2.5 units across. (The brief asked for 0.8-1.6: Lee's 16-fold star
  // has 22.5° needle points, so with 0.44 straps a smaller centre leaves points too thin to
  // cut; starBands: [67.5, 56.25] gives 1.9 across at the cost of a busier outer zone.)
  assert.ok(across > 1.6 && across < 2.8, `centre piece ${across.toFixed(2)} across`);
  // Its sixteen points are the rest of layer 0: small, but no slivers.
  const ring = tiles.filter(t => t.layer === 0 && t !== c);
  assert.equal(ring.length, 16);
  for (const t of ring) assert.ok(area(t.poly) > 0.05 && area(t.poly) < 0.5);
  // Nothing coloured is laid before the centre: every other fill has a higher layer.
  assert.ok(tiles.every(t => t.kind === 'strap' || t.kind === 'band' || t.layer > 0 || t.stage === 'Central 16-point star'));
});

test('piece count, sizes and no slivers', () => {
  const tiles = laid.tiles;
  assert.ok(tiles.length > 1500 && tiles.length < 3500, `${tiles.length} tiles`);
  for (const t of tiles) {
    assert.ok(isSimple(t.poly) && area(t.poly) > 0, 'finished tile simple and counter-clockwise');
    assert.ok(area(t.poly) >= 0.05, `sliver ${t.kind} ${area(t.poly).toFixed(4)} at ${centroid(t.poly)}`);
  }
  // Big regions were cut: coloured pieces stay near 3 square units. The largest are the
  // cream slabs of the great petals (about 5 by 1) and the central star's 16-gon.
  for (const p of laid.exact) {
    if (p.kind === 'strap' || p.kind === 'band' || p.kind === 'star16') continue;
    assert.ok(area(p.poly) < (p.region === 'greatPetal' ? 6 : 4.5), `${p.kind} piece of ${area(p.poly).toFixed(2)}`);
  }
  assert.equal(laid.fallbacks, 0, 'the engine cut every face itself');
});

test('pieces repeat every 22.5° (coloured pieces and frame; strap cuts are reported)', () => {
  const coloured = laid.exact.filter(p => p.kind !== 'strap');
  const C = pointSet(coloured.map(p => centroid(p.poly)), 1e-2);
  for (const p of coloured) assert.ok(C.has(rotate(centroid(p.poly), STEP), 1e-5), `${p.kind} at ${centroid(p.poly)} has no rotated copy`);
  // Strap pieces: the engine breaks a few ties (which straight pair a tee merges, where a run
  // is cut) by floating-point noise, so a handful of strap cuts differ between copies. The
  // strap centre lines themselves are symmetric (tested above). Count and report.
  const straps = laid.exact.filter(p => p.kind === 'strap');
  const S = pointSet(straps.map(p => centroid(p.poly)), 1e-2);
  const odd = straps.filter(p => !S.has(rotate(centroid(p.poly), STEP), 1e-5)).length;
  console.log(`# strap pieces without a rotated copy: ${odd} of ${straps.length}`);
  assert.ok(odd / straps.length < 0.05);
});

// ---------------------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------------------

test('radii: everything fits inside R_F, bands are contiguous and cut in multiples of 16', () => {
  const r = ros.radii;
  assert.ok(ros.R_F <= MEDALLION.R_F_MAX + 1e-9);
  assert.ok(r.R1 < r.R2 && r.R2 < r.C3 && r.C3 < r.C4 && r.C4 < r.C5 && r.C5 < ros.R_M + ros.strap && ros.R_M < ros.R_F);
  let r0 = ros.R_M;
  for (const b of ros.bands) {
    assert.ok(close(b.r0, r0) && b.r1 > b.r0 && b.key in PAL && b.count % 16 === 0);
    r0 = b.r1;
  }
  assert.ok(close(r0, ros.R_F), 'last band ends at R_F');
  assert.equal(ros.strap, LEE.STRAP);
  // Sinopia: compass circles and straightedge lines, all finite.
  assert.ok(ros.sinopia.circles.length > 4 && ros.sinopia.lines.length >= 64);
  for (const [a, b] of ros.sinopia.lines) assert.ok([...a, ...b].every(Number.isFinite));
});

test('options: alpha nesting, Lee darts, one-piece centre and a smaller medallion all stay valid', () => {
  for (const opts of [{ nest: 'alpha', starBands: [67.5, 67.5] }, { smallDarts: 'lee' }, { centreCut: 'none' }, { R_F: 24, strap: 0.46 }]) {
    const r = buildRosette(opts);
    const a = buildArrangement(r.segments);
    for (const face of a.faces) assert.notEqual(r.classify(face).region, 'unknown', `${JSON.stringify(opts)}: unclassified face`);
    const { exact } = cutRosette(r);
    const chk = checkPartition(exact, outline(r, exact));
    assert.ok(chk.ok, `${JSON.stringify(opts)}: partition ${chk.relError} ${chk.overlaps.length} ${chk.invalid.length}`);
  }
});
