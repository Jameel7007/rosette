// Tests for the zellige engine: geom.js, graph.js, strap.js, cut.js.
//   node --test tests/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pc from 'polygon-clipping';
import {
  area, centroid, ensureCCW, isSimple, insetPolygon, mitreOffset, wobble, circlePoly,
  annularSector, arcSegments, pointInPolygon, distToBoundary, segIntersect, interiorPoint,
} from '../src/pattern/geom.js';
import { buildArrangement } from '../src/pattern/graph.js';
import { strapwork } from '../src/pattern/strap.js';
import { clipPieces, splitStar, splitRun, bandPieces, finishPieces, checkPartition } from '../src/pattern/cut.js';
import { mulberry } from '../src/util/rand.js';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** (a) A square grid of full lines 0..n. */
function gridLines(n) {
  const segs = [];
  for (let i = 0; i <= n; i++) { segs.push([[i, 0], [i, n]]); segs.push([[0, i], [n, i]]); }
  return segs;
}

/** (b) Hankin's method on a 4.8.8 patch at 67.5°: 8-point stars in the octagons and
 *  4-point stars in the squares, meeting tip to tip at shared edge midpoints. */
const P = 4.6;
function hankinMotif(tile, theta) {
  const n = tile.length, mids = [], fwd = [], back = [];
  const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  for (let i = 0; i < n; i++) {
    const a = tile[i], b = tile[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    mids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    fwd.push(rot(d, theta));            // leans into the (CCW) tile
    back.push(rot([-d[0], -d[1]], -theta));
  }
  const segs = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const X = segIntersect(mids[i], [mids[i][0] + 50 * fwd[i][0], mids[i][1] + 50 * fwd[i][1]],
                           mids[j], [mids[j][0] + 50 * back[j][0], mids[j][1] + 50 * back[j][1]]).point;
    segs.push([mids[i], X], [X, mids[j]]);
  }
  return segs;
}
function hankin488(k) {
  const theta = (67.5 * Math.PI) / 180;
  const R8 = P / 2 / Math.cos(Math.PI / 8), R4 = (P * (Math.SQRT2 - 1)) / Math.SQRT2;
  const segs = [];
  for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
    const oct = Array.from({ length: 8 }, (_, m) => { const a = Math.PI / 8 + (m * Math.PI) / 4; return [i * P + R8 * Math.cos(a), j * P + R8 * Math.sin(a)]; });
    segs.push(...hankinMotif(oct, theta));
    if (i < k && j < k) {
      const sq = Array.from({ length: 4 }, (_, m) => { const a = (m * Math.PI) / 2; return [(i + 0.5) * P + R4 * Math.cos(a), (j + 0.5) * P + R4 * Math.sin(a)]; });
      segs.push(...hankinMotif(sq, theta));
    }
  }
  return segs;
}

/** (c) A circle drawn as 128 segments plus 16 spokes from the centre. */
function circleSpokes(R = 8, n = 128, spokes = 16) {
  const ring = circlePoly(R, n);
  const segs = ring.map((p, i) => [p, ring[(i + 1) % n]]);
  for (let k = 0; k < spokes; k++) segs.push([[0, 0], ring[(k * n) / spokes]]);
  return segs;
}

const piecesOf = sw => [...sw.fills, ...sw.straps];
const sumArea = ps => ps.reduce((s, p) => s + area(p.poly ?? p), 0);
const codes = sw => sw.warnings.map(w => w.code);

/** Assert that strapwork pieces, clipped to `region`, partition it exactly. */
function assertPartition(sw, region, label) {
  for (const p of piecesOf(sw)) assert.ok(isSimple(p.poly) && area(p.poly) > 0, `${label}: piece not simple/CCW`);
  // Unclipped: the pieces tile the outline exactly.
  const outlineArea = sw.outline.reduce((s, r) => s + area(r), 0);
  assert.ok(Math.abs(sumArea(piecesOf(sw)) - outlineArea) < 1e-9 * outlineArea, `${label}: pieces vs outline area`);
  const clipped = clipPieces(piecesOf(sw), { inside: region, minArea: 0 });
  const chk = checkPartition(clipped, region);
  assert.equal(chk.invalid.length, 0, `${label}: invalid clipped pieces`);
  assert.equal(chk.overlaps.length, 0, `${label}: overlaps ${JSON.stringify(chk.overlaps.slice(0, 3))}`);
  assert.ok(chk.relError < 1e-9, `${label}: area error ${chk.relError}`);
  return clipped;
}

// ---------------------------------------------------------------------------------------
// geom.js
// ---------------------------------------------------------------------------------------

test('geom: area, centroid, winding', () => {
  const sq = square(0, 0, 2, 1);
  assert.equal(area(sq), 2);
  assert.equal(area(sq.slice().reverse()), -2);
  assert.deepEqual(centroid(sq), [1, 0.5]);
  assert.equal(area(ensureCCW(sq.slice().reverse())), 2);
  assert.ok(isSimple(sq));
  assert.ok(!isSimple([[0, 0], [1, 1], [1, 0], [0, 1]]), 'bow-tie is not simple');
  const L = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  assert.ok(pointInPolygon(interiorPoint(L), L) && distToBoundary(interiorPoint(L), L) > 1e-3);
});

test('geom: mitred inset keeps edges parallel and collapses short edges', () => {
  const sq = insetPolygon(square(0, 0, 2, 2), 0.25);
  assert.ok(Math.abs(area(sq) - 1.5 * 1.5) < 1e-12);
  // A trapezoid whose short top edge vanishes under a large inset: it collapses to a
  // triangle (an edge event) rather than turning inside out.
  // (Its sides meet at an apex 1/6 above the top edge; the inset triangle's apex drops
  // below the inset top edge once d > ~0.58.)
  const trap = [[0, 0], [4, 0], [2.2, 1.5], [1.8, 1.5]];
  assert.equal(mitreOffset(trap, 0.5).collapsed, 0);
  const res = mitreOffset(trap, 0.62);
  assert.ok(res && res.collapsed === 1 && res.pts.length === 3);
  assert.ok(isSimple(res.pts) && area(res.pts) > 0);
  assert.equal(insetPolygon(square(0, 0, 1, 1), 0.6), null, 'too small to inset');
});

test('geom: annular sectors share the circle grid exactly', () => {
  const n = arcSegments(5, 0.5);
  assert.equal(n % 16, 0);
  const sec = annularSector(3, 5, 0.1, 1.3, 0.5);
  const ring = circlePoly(5, n);
  // Every interior arc vertex is exactly a vertex of the shared circle polygon.
  const onGrid = sec.slice(1, sec.findIndex(p => Math.hypot(...p) < 4) - 1);
  assert.ok(onGrid.length > 0 && onGrid.every(p => ring.some(q => q[0] === p[0] && q[1] === p[1])));
});

// ---------------------------------------------------------------------------------------
// graph.js
// ---------------------------------------------------------------------------------------


test('graph: splits crossings, merges duplicates and overlaps, snaps noise, prunes dangling ends', () => {
  const segs = [
    [[0, 0], [4, 0]], [[4, 0], [4, 4]], [[4, 4], [0, 4]], [[0, 4], [0, 0]], // a square
    [[0, 0], [4, 0]],                   // exact duplicate
    [[1, 0], [3, 0]],                   // collinear overlap
    [[2, 0], [2, 4]],                   // T-touches at both ends: two faces
    [[3, 2], [6, 2]],                   // crosses the right side; dangles on both sides of it
    [[4 + 1e-12, 4], [4, 4 - 1e-12]],   // floating-point noise: snaps to the corner
  ];
  const arr = buildArrangement(segs);
  assert.equal(arr.faces.length, 2);
  assert.equal(arr.vertices.length, 9); // corners, (1,0) (2,0) (3,0), (2,4), and (4,2) on the right side
  assert.equal(arr.edges.length, 10);
  assert.equal(arr.outer.length, 1);
  const dangling = arr.warnings.find(w => w.code === 'dangling');
  assert.ok(dangling && /pruned 2/.test(dangling.msg));
  assert.ok(Math.abs(arr.faces.reduce((s, f) => s + f.area, 0) - 16) < 1e-12);
  for (const f of arr.faces) assert.ok(area(f.poly) > 0);
  // Proper crossings in the middle of segments are split too.
  const x = buildArrangement([[[0, 0], [2, 2]], [[0, 2], [2, 0]], [[0, 0], [0, 2]], [[2, 0], [2, 2]]]);
  assert.equal(x.faces.length, 2);
  assert.ok(x.vertices.some(([a, b]) => Math.abs(a - 1) < 1e-12 && Math.abs(b - 1) < 1e-12));
});

test('graph: the 4.8.8 Hankin patch has stars, crosses and hexagons', () => {
  const arr = buildArrangement(hankin488(1));
  const sizes = {};
  for (const f of arr.faces) sizes[f.verts.length] = (sizes[f.verts.length] ?? 0) + 1;
  // 3×3 octagons → 9 eight-point stars (16-gons); 2×2 squares → 4 four-point stars
  // (8-gons); one hexagon around each of the squares' 16 corners, where two octagons and a
  // square meet.
  assert.equal(sizes[16], 9);
  assert.equal(sizes[8], 4);
  assert.equal(sizes[6], 16);
  assert.equal(arr.warnings.length, 0);
});

// ---------------------------------------------------------------------------------------
// strap.js: exact partition
// ---------------------------------------------------------------------------------------

test('strapwork (a): square grid partitions an interior region exactly', () => {
  const sw = strapwork(buildArrangement(gridLines(6)), { width: 0.2 });
  assert.deepEqual(codes(sw), []);
  assert.equal(sw.fills.length, 36);
  assertPartition(sw, square(0.5, 0.5, 5.5, 5.5), 'grid');
  // A region that runs along strap centre lines and through junctions works too.
  assertPartition(sw, square(1, 1, 5, 4), 'grid on lines');
});

test('strapwork (b): 8-fold star patch partitions exactly, with mitred straps of uniform width', () => {
  const arr = buildArrangement(hankin488(2));
  const width = 0.1 * P;
  const sw = strapwork(arr, { width });
  assert.deepEqual(codes(sw), []);
  assert.equal(sw.fills.length, arr.faces.length);
  assertPartition(sw, square(-1.6 * P, -1.6 * P, 1.6 * P, 1.6 * P), 'hankin');
  assertPartition(sw, ensureCCW(circlePoly(1.8 * P, 96)), 'hankin disk');
  // Uniform width, mitred: every side of every fill is parallel to one of its face's centre
  // lines and exactly width/2 from it (corners are where these offset lines meet).
  const lineDist = (p, a, b) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (const f of sw.fills) {
    const fp = arr.faces[f.faceId].poly;
    f.poly.forEach((p, i) => {
      const q = f.poly[(i + 1) % f.poly.length];
      const ok = fp.some((a, k) => {
        const b = fp[(k + 1) % fp.length];
        const par = Math.abs((q[0] - p[0]) * (b[1] - a[1]) - (q[1] - p[1]) * (b[0] - a[0])) <= 1e-9 * Math.hypot(q[0] - p[0], q[1] - p[1]) * Math.hypot(b[0] - a[0], b[1] - a[1]);
        return par && Math.abs(lineDist(p, a, b) - width / 2) < 1e-9 && Math.abs(lineDist(q, a, b) - width / 2) < 1e-9;
      });
      assert.ok(ok, `fill ${f.faceId} side ${i} is not an offset centre line`);
    });
  }
});

test('strapwork (c): circle of 128 segments + 16 spokes partitions exactly; runs are cut to length', () => {
  const targetLen = 1.2, width = 0.46;
  const arr = buildArrangement(circleSpokes());
  const sw = strapwork(arr, { width, targetLen });
  assert.deepEqual(codes(sw), []);
  assert.equal(sw.fills.length, 16);
  assertPartition(sw, ensureCCW(circlePoly(7.5, 64)), 'circle inner');
  assertPartition(sw, sw.outline[0], 'circle all');
  // Each tee junction is carried by exactly one strap piece (never cut through), the circle
  // runs through it, and the spoke stops against it.
  const tees = arr.vertices.map((_, v) => v).filter(v => arr.out[v].length === 3);
  assert.equal(tees.length, 16);
  for (const v of tees) {
    const carriers = sw.straps.filter(s => s.vertexIds.includes(v));
    assert.equal(carriers.length, 1);
  }
  // Runs are cut into pieces of about targetLen (the centre-line length of an end piece also
  // includes the stretch hidden under its junction).
  const plain = sw.straps.filter(s => !s.vertexIds.length);
  assert.ok(plain.length > 100);
  for (const s of plain) assert.ok(s.len < 2.2 * targetLen && s.len > 0.3 * targetLen, `run piece length ${s.len}`);
});

test('strapwork: a face too small for the strap is absorbed and the partition stays exact', () => {
  const segs = gridLines(4);
  segs.push([[0, 2.05], [4, 2.05]]); // a thin row of faces, 0.05 tall, under a 0.2 strap
  const sw = strapwork(buildArrangement(segs), { width: 0.2 });
  assert.ok(codes(sw).includes('absorbed'));
  assertPartition(sw, square(0.3, 0.3, 3.7, 3.7), 'absorbed');
});

// ---------------------------------------------------------------------------------------
// strap.js: interlace
// ---------------------------------------------------------------------------------------

/** For every strand between two interlaced crossings, check it is over at one and under at
 *  the other. Walks the arrangement directly (independent of strap.js's own bookkeeping). */
function checkAlternation(arr, sw) {
  const overEdges = new Map(sw.crossings.map(c => [c.vertex, new Set(c.over)]));
  const { out, halfEdges: H } = arr;
  let pairs = 0;
  for (const [v, over] of overEdges) {
    for (const he of out[v]) {
      let cur = he;
      while (out[H[cur].to].length === 2) { const o = out[H[cur].to]; cur = o[0] === (cur ^ 1) ? o[1] : o[0]; }
      const w = H[cur].to;
      if (!overEdges.has(w)) continue;
      const overHere = over.has(he >> 1), overThere = overEdges.get(w).has(cur >> 1);
      assert.notEqual(overHere, overThere, `strand from crossing ${v} to ${w} does not alternate`);
      pairs++;
    }
  }
  return pairs;
}

test('interlace: over/under alternates along every strand of the star patch', () => {
  const arr = buildArrangement(hankin488(2));
  const sw = strapwork(arr, { width: 0.1 * P });
  const fourWay = arr.out.filter(o => o.length === 4).length;
  assert.equal(sw.crossings.length, fourWay, 'every 4-way crossing is interlaced');
  const pairs = checkAlternation(arr, sw);
  assert.ok(pairs > 2 * fourWay, `checked ${pairs} strand segments`);
  // Piece structure: the over strand's two bands and the junction are one piece; the under
  // strand's bands are in other pieces that stop at the junction.
  for (const c of sw.crossings) {
    const carrier = sw.straps.filter(s => s.vertexIds.includes(c.vertex));
    assert.equal(carrier.length, 1);
    assert.ok(carrier[0].over);
    assert.ok(c.over.every(e => carrier[0].edgeIds.includes(e)));
    assert.ok(c.under.every(e => !carrier[0].edgeIds.includes(e)));
  }
  // Square grid (every vertex even degree) alternates too.
  const g = buildArrangement(gridLines(7));
  const gs = strapwork(g, { width: 0.2 });
  assert.equal(gs.crossings.length, 36);
  checkAlternation(g, gs);
});

test('interlace: an odd loop falls back to a separate junction and still alternates elsewhere', () => {
  // Inner circle crossed by 3 spokes: three crossings round one loop cannot alternate.
  const inner = circlePoly(3, 48), outer = circlePoly(6, 96);
  const segs = [...inner.map((p, i) => [p, inner[(i + 1) % 48]]), ...outer.map((p, i) => [p, outer[(i + 1) % 96]])];
  for (let k = 0; k < 3; k++) segs.push([[0, 0], outer[k * 32]]);
  const arr = buildArrangement(segs);
  const sw = strapwork(arr, { width: 0.3 });
  assert.ok(codes(sw).includes('interlace-fallback'));
  assert.equal(sw.crossings.length, 2);
  checkAlternation(arr, sw);
  assertPartition(sw, square(-4, -4, 4, 4), 'odd loop');
  // With interlace off every junction is its own piece.
  const flat = strapwork(arr, { width: 0.3, interlace: false });
  assert.equal(flat.crossings.length, 0);
  assert.ok(flat.straps.every(s => !s.over));
});

// ---------------------------------------------------------------------------------------
// cut.js
// ---------------------------------------------------------------------------------------

test('finishPieces: inset + wobble keep sharp stars and thin straps valid', () => {
  const grout = 0.14, amp = 0.03;
  // A sharp 16-point star (about 14° tips), a thin sliver strap and a strapwork patch.
  const star = [];
  for (let k = 0; k < 32; k++) star.push(polarPt(k % 2 ? 1.2 : 4, (Math.PI * k) / 16));
  const thin = [[0, 0], [6, 0.02], [6.2, 0.25], [0.1, 0.23]];
  const sw = strapwork(buildArrangement(hankin488(1)), { width: 0.1 * P });
  const pieces = [{ poly: star, key: 'B' }, { poly: thin, key: 'K' }, ...piecesOf(sw).map(p => ({ ...p, key: 'K' }))];
  for (let seed = 1; seed <= 40; seed++) {
    const done = finishPieces(pieces, { grout, wobble: amp, rand: mulberry(seed) });
    assert.equal(done.length, pieces.length, 'nothing dropped');
    done.forEach((p, i) => {
      assert.ok(isSimple(p.poly) && area(p.poly) > 0, `seed ${seed} piece ${i} invalid`);
      // Every vertex stays inside its original piece, at least grout/2 − wobble from its edge,
      // so neighbours can never touch.
      const src = ensureCCW(pieces[i].poly);
      for (const q of p.poly) {
        assert.ok(pointInPolygon(q, src));
        assert.ok(distToBoundary(q, src) >= grout / 2 - amp - 1e-9);
      }
    });
    assert.equal(done[0].key, 'B', 'metadata is kept');
  }
  // Wobble alone never breaks a polygon, even a nearly degenerate one.
  const sliver = [[0, 0], [5, 0], [5, 0.001], [0, 0.0015]];
  for (let s = 1; s < 200; s++) assert.ok(isSimple(wobble(sliver, mulberry(s), 0.05)));
  // A piece too small for the grout is dropped and reported.
  const dropped = [];
  assert.equal(finishPieces([{ poly: square(0, 0, 0.1, 0.1) }], { grout, onDrop: (p, r) => dropped.push(r) }).length, 0);
  assert.equal(dropped.length, 1);
});
function polarPt(r, a) { return [r * Math.cos(a), r * Math.sin(a)]; }

test('clipPieces conserves area, splits pieces, and handles holes', () => {
  const sw = strapwork(buildArrangement(hankin488(1)), { width: 0.46 });
  const pieces = piecesOf(sw).map((p, i) => ({ ...p, tag: i }));
  const outline = sw.outline;
  const region = ensureCCW(circlePoly(5, 80));
  const hole = square(-1, -1, 1.5, 1.5);
  const clipped = clipPieces(pieces, { inside: region, outside: hole, minArea: 0 });
  const expected = pc.difference(pc.intersection(outline.map(r => [r]), [[region]]), [[hole]])
    .reduce((s, P) => s + area(P[0].slice(0, -1)) + P.slice(1).reduce((h, H) => h + area(H.slice(0, -1)), 0), 0);
  assert.ok(Math.abs(sumArea(clipped) - expected) < 1e-9 * expected);
  assert.ok(clipped.every(p => typeof p.tag === 'number'), 'metadata is kept');
  const chk = checkPartition(clipped, expected);
  assert.ok(chk.ok, JSON.stringify({ ...chk, overlaps: chk.overlaps.slice(0, 3) }));
  // A hole strictly inside one piece: the result is split into simple pieces.
  const big = [{ poly: square(0, 0, 10, 10), key: 'W' }];
  const ring = clipPieces(big, { outside: square(4, 4, 6, 6) });
  assert.ok(ring.length >= 2 && ring.every(p => isSimple(p.poly) && p.key === 'W'));
  assert.ok(Math.abs(sumArea(ring) - 96) < 1e-9);
  assert.ok(checkPartition(ring, 96).ok);
  // Untouched pieces pass straight through (same object).
  const inner = clipPieces(big, { inside: square(-1, -1, 11, 11) });
  assert.equal(inner[0], big[0]);
});

test('splitStar, splitRun and bandPieces conserve area', () => {
  const star = [];
  for (let k = 0; k < 16; k++) star.push(polarPt(k % 2 ? 1.3 : 3, (Math.PI * k) / 8));
  const A = area(star);
  const cp = splitStar(star, [0, 0], 'centre+points');
  assert.equal(cp.length, 9); // octagon + 8 points
  assert.ok(checkPartition(cp, A).ok);
  for (const n of [8, 16, 5, 2]) {
    const w = splitStar(star, [0, 0], `wedges:${n}`);
    assert.ok(w.length >= n);
    assert.ok(checkPartition(w, A).ok, `wedges:${n}`);
  }
  const strap = [[0, 0], [7, 1], [7.1, 1.5], [0.1, 0.5]];
  const runs = splitRun(strap, 1);
  assert.equal(runs.length, 7);
  assert.ok(checkPartition(runs, area(strap)).ok);
  // On the shared grid (count divides the grid), the ring is exactly the annulus between the
  // two grid circles.
  const ring = bandPieces({ r0: 4, r1: 5, count: 32 });
  assert.equal(ring.length, 32);
  const annulus = area(circlePoly(5, arcSegments(5))) - area(circlePoly(4, arcSegments(4)));
  const chk = checkPartition(ring, annulus);
  assert.ok(chk.ok && chk.relError < 1e-12, JSON.stringify(chk));
  // Offset sectors add their own end points on the circles; they still tile without gaps or
  // overlaps (the union's area equals the sum).
  const off = bandPieces({ r0: 4, r1: 5, count: 24, a0: 0.05 });
  const union = pc.union(...off.map(p => [p])).reduce((s, Q) => s + area(Q[0].slice(0, -1)) + Q.slice(1).reduce((h, H) => h + area(H.slice(0, -1)), 0), 0);
  assert.ok(checkPartition(off, union).ok);
});

// ---------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------

test('performance: arrangement + strapwork for ~10k segments under 2 s', () => {
  const segs = hankin488(10);
  assert.ok(segs.length >= 10000, `${segs.length} segments`);
  const t0 = performance.now();
  const arr = buildArrangement(segs);
  const t1 = performance.now();
  const sw = strapwork(arr, { width: 0.1 * P });
  const t2 = performance.now();
  console.log(`  perf: ${segs.length} segments → ${arr.faces.length} faces, ${sw.fills.length + sw.straps.length} pieces; ` +
    `arrangement ${(t1 - t0).toFixed(0)} ms + strapwork ${(t2 - t1).toFixed(0)} ms = ${(t2 - t0).toFixed(0)} ms`);
  assert.ok(t2 - t0 < 2000, `took ${(t2 - t0).toFixed(0)} ms`);
  assert.ok(!codes(sw).some(c => c === 'strap-invalid' || c === 'fill-invalid'));
});
