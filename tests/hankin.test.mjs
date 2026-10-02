// Tests for the 8-fold field (src/pattern/hankin.js): the 4.8.8 tiling, Hankin's lines at
// 67.5°, their symmetry, and the faces the engine finds between them.
//   node --test tests/hankin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildField, tiling488, FIELD_STAGE } from '../src/pattern/hankin.js';
import { buildArrangement } from '../src/pattern/graph.js';
import { strapwork } from '../src/pattern/strap.js';
import { clipPieces, checkPartition } from '../src/pattern/cut.js';
import { area, distToSegment, ensureCCW, circlePoly } from '../src/pattern/geom.js';
import { FIELD, PANEL } from '../src/config.js';

const P = FIELD.P;
const DEG = 180 / Math.PI;

// The default field (the whole panel) is used by several tests; build it once.
const field = buildField();
// A smaller patch for the (slower) engine-level checks.
const patch = buildField({ bounds: { halfW: 3 * P, halfH: 3 * P } });
const patchArr = buildArrangement(patch.segments);

/** Interior angle (degrees) at every vertex of a counter-clockwise polygon. */
function interiorAngles(poly) {
  const n = poly.length;
  return poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
    let t = Math.atan2(a[1] - p[1], a[0] - p[0]) - Math.atan2(b[1] - p[1], b[0] - p[0]);
    while (t <= 0) t += 2 * Math.PI;
    return t * DEG;
  });
}

/** Order-free key for a segment, rounded so float noise of ~1e-9 doesn't matter. */
const ptKey = ([x, y]) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
const segKey = ([a, b]) => [ptKey(a), ptKey(b)].sort().join('|');

/** Every tiling edge of the tiles behind a field built with bounds ±halfW, by midpoint. */
function tilingEdges(halfW = PANEL.HALF) {
  const n = Math.ceil(halfW / P) + 1;
  const edges = new Map();
  for (const t of tiling488(P, n, n)) {
    t.poly.forEach((p, k) => {
      const q = t.poly[(k + 1) % t.poly.length];
      const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      edges.set(ptKey(mid), { mid, dir: [q[0] - p[0], q[1] - p[1]] });
    });
  }
  return edges;
}

/**
 * For each segment, the tiling edge midpoints lying on it (found through a coarse grid so
 * this stays fast), and whether that midpoint is an end of the segment (a half line on the
 * patch's rim) or inside it (a whole line through two tiles).
 */
function midpointsOn(segments, edges) {
  const cell = P / 2, grid = new Map();
  const cellKey = (i, j) => `${i},${j}`;
  for (const e of edges.values()) {
    const k = cellKey(Math.floor(e.mid[0] / cell), Math.floor(e.mid[1] / cell));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(e);
  }
  return segments.map(([a, b]) => {
    const hits = [];
    for (let i = Math.floor(Math.min(a[0], b[0]) / cell); i <= Math.floor(Math.max(a[0], b[0]) / cell); i++) {
      for (let j = Math.floor(Math.min(a[1], b[1]) / cell); j <= Math.floor(Math.max(a[1], b[1]) / cell); j++) {
        for (const e of grid.get(cellKey(i, j)) ?? []) if (distToSegment(e.mid, a, b) < 1e-9) hits.push(e);
      }
    }
    const atEnd = hits.length === 1 &&
      Math.min(Math.hypot(a[0] - hits[0].mid[0], a[1] - hits[0].mid[1]), Math.hypot(b[0] - hits[0].mid[0], b[1] - hits[0].mid[1])) < 1e-9;
    return { hits, atEnd };
  });
}

// ---------------------------------------------------------------------------------------
// The base tiling
// ---------------------------------------------------------------------------------------

test('tiling: regular octagons and squares with edge P/(1+√2), sharing every edge', () => {
  const a = P / (1 + Math.SQRT2);
  const tiles = tiling488(P, 2, 2);
  for (const t of tiles) {
    assert.ok(area(t.poly) > 0, 'counter-clockwise');
    t.poly.forEach((p, k) => {
      const q = t.poly[(k + 1) % t.poly.length];
      assert.ok(Math.abs(Math.hypot(q[0] - p[0], q[1] - p[1]) - a) < 1e-12, 'edge length a');
    });
    for (const ang of interiorAngles(t.poly)) assert.ok(Math.abs(ang - (t.kind === 'oct' ? 135 : 90)) < 1e-9);
  }
  // Flat-to-flat = P: the octagon at the origin has flat edges on x = ±P/2 and y = ±P/2.
  const o = tiles.find(t => t.kind === 'oct' && t.i === 0 && t.j === 0);
  assert.equal(Math.max(...o.poly.map(p => p[0])), P / 2);
  assert.equal(Math.min(...o.poly.map(p => p[1])), -P / 2);
  // Octagons + squares cover a period cell exactly: area(oct) + area(square) = P².
  const sq = tiles.find(t => t.kind === 'sq');
  assert.ok(Math.abs(area(o.poly) + area(sq.poly) - P * P) < 1e-12);
  // The base tiling handed to the sinopia: the tiles overlapping the panel.
  assert.equal(field.baseTiling.octagons.length, 21 * 21);
  assert.equal(field.baseTiling.squares.length, 20 * 20);
});

// ---------------------------------------------------------------------------------------
// The lines
// ---------------------------------------------------------------------------------------

test('lines: every segment runs through a tiling edge midpoint at the 67.5° contact angle', () => {
  const edges = tilingEdges();
  const found = midpointsOn(field.segments, edges);
  const throughMid = new Map(); // midpoint key → number of segments through it
  field.segments.forEach(([a, b], s) => {
    // Each segment is the pair of Hankin rays launched from one edge midpoint, one into each
    // tile (on the outermost edges of the patch, a single ray starting there).
    const { hits } = found[s];
    assert.equal(hits.length, 1, `segment ${s} passes through ${hits.length} midpoints`);
    const { mid, dir } = hits[0];
    throughMid.set(ptKey(mid), (throughMid.get(ptKey(mid)) ?? 0) + 1);
    // Contact angle: the (acute) angle between the line and the tiling edge.
    const sd = [b[0] - a[0], b[1] - a[1]];
    const c = Math.abs(sd[0] * dir[0] + sd[1] * dir[1]) / (Math.hypot(...sd) * Math.hypot(...dir));
    assert.ok(Math.abs(Math.acos(c) * DEG - FIELD.THETA) < 1e-9, `contact angle ${Math.acos(c) * DEG}`);
  });
  // Two lines cross at every edge midpoint, and a line shared by two tiles came out as one
  // segment: apart from the patch's rim, every segment is a whole line through its midpoint.
  for (const n of throughMid.values()) assert.equal(n, 2);
  assert.equal(throughMid.size, edges.size);
  const half = found.filter(f => f.atEnd).length, full = found.length - half;
  assert.ok(full > 10 * half, `${full} whole lines, ${half} half lines on the rim`);
  // No duplicates, and no two segments overlap: the engine splits each whole line only at its
  // midpoint (where its partner crosses it), so it makes exactly 2 edges per whole line and
  // 1 per half line, and merges nothing.
  assert.equal(new Set(field.segments.map(segKey)).size, field.segments.length);
  const patchHalf = midpointsOn(patch.segments, tilingEdges(3 * P)).filter(f => f.atEnd).length;
  assert.equal(patchArr.edges.length, 2 * (patch.segments.length - patchHalf) + patchHalf);
  assert.deepEqual(patchArr.warnings, []);
});

test('lines: in each octagon the star is the {8/3} star polygon (ray from midpoint k aims at midpoint k + 3)', () => {
  const oct = tiling488(P, 0, 0).find(t => t.kind === 'oct').poly;
  const mids = oct.map((p, k) => { const q = oct[(k + 1) % 8]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; });
  // The two lines through the midpoint of edge 0 (the diagonal edge facing 45°).
  const through = patch.segments.filter(([a, b]) => distToSegment(mids[0], a, b) < 1e-9);
  assert.equal(through.length, 2);
  for (const [a, b] of through) {
    // Extended, each line passes through a midpoint three edges away (k + 3 or k − 3).
    const lineDist = m => Math.abs((b[0] - a[0]) * (m[1] - a[1]) - (b[1] - a[1]) * (m[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
    assert.ok(lineDist(mids[3]) < 1e-9 || lineDist(mids[5]) < 1e-9);
  }
});

test('lines: the 8-fold symmetry (D4) about the origin', () => {
  const keys = new Set(field.segments.map(segKey));
  const maps = {
    'rotate 90°': ([x, y]) => [-y, x],
    'rotate 180°': ([x, y]) => [-x, -y],
    'mirror x': ([x, y]) => [-x, y],
    'mirror y': ([x, y]) => [x, -y],
    'mirror diagonal': ([x, y]) => [y, x],
  };
  for (const [name, f] of Object.entries(maps)) {
    const missing = field.segments.filter(([a, b]) => !keys.has(segKey([f(a), f(b)])));
    assert.equal(missing.length, 0, `${name}: ${missing.length} segments have no image`);
  }
});

test('lines: the panel edge x = 46 (= 10P) is a mirror line', () => {
  assert.ok(Math.abs(10 * P - PANEL.HALF) < 1e-12);
  const keys = new Set(field.segments.map(segKey));
  // The patch reaches x = 11.5P = 52.9, so every segment within one period of the edge
  // must have its mirror image in the set.
  const near = field.segments.filter(s => s.every(([x]) => Math.abs(x - PANEL.HALF) <= P));
  assert.ok(near.length > 100);
  const m = ([x, y]) => [2 * PANEL.HALF - x, y];
  const missing = near.filter(([a, b]) => !keys.has(segKey([m(a), m(b)])));
  assert.equal(missing.length, 0, `${missing.length} of ${near.length} segments have no mirror image`);
});

// ---------------------------------------------------------------------------------------
// The faces (via the engine)
// ---------------------------------------------------------------------------------------

test('faces: 8-point and 4-point stars with 45° points, hexagons around the tiling vertices', () => {
  const angleSets = { star8: [45, 270], star4: [45, 225], hex: [90, 135] };
  const sides = { star8: 16, star4: 8, hex: 6 };
  for (const f of patchArr.faces) {
    const c = patch.classify(f);
    assert.ok(c.kind in sides, `face ${f.id} unclassified (${c.kind})`);
    assert.equal(f.verts.length, sides[c.kind], `face ${f.id} (${c.kind}) has ${f.verts.length} sides`);
    assert.equal(c.stage, FIELD_STAGE);
    for (const a of interiorAngles(f.poly)) {
      assert.ok(angleSets[c.kind].some(e => Math.abs(a - e) < 1e-6), `${c.kind} angle ${a}`);
    }
    if (c.kind === 'hex') {
      // Two right angles (at the octagon stars' inner corners) and four of 135°.
      const right = interiorAngles(f.poly).filter(a => Math.abs(a - 90) < 1e-6).length;
      assert.equal(right, 2);
    }
  }
  // The star tips are the tiling's edge midpoints (Hankin's rays start there).
  const edges = tilingEdges(3 * P);
  for (const f of patchArr.faces) {
    if (patch.classify(f).kind === 'hex') continue;
    interiorAngles(f.poly).forEach((a, k) => {
      if (Math.abs(a - 45) < 1e-6) assert.ok(edges.has(ptKey(f.poly[k])), 'star tip on an edge midpoint');
    });
  }
  // Hexagon centroids sit well clear of the star centres (what the classifier relies on).
  for (const f of patchArr.faces) {
    if (patch.classify(f).kind !== 'hex') continue;
    const [x, y] = f.centroid;
    const dOct = Math.hypot(x - Math.round(x / P) * P, y - Math.round(y / P) * P);
    const dSq = Math.hypot(x - (Math.floor(x / P) + 0.5) * P, y - (Math.floor(y / P) + 0.5) * P);
    assert.ok(dOct > 0.5 * P && dSq > 0.29 * P, `hex centroid ${dOct / P}P, ${dSq / P}P`);
  }
});

test('faces: per period cell, one 8-point star, one 4-point star and four hexagons', () => {
  // Assign each face to the cell holding its centroid, with the cell grid shifted by P/4 so
  // no centroid lies on a cell boundary (star centres sit at 0.25 and 0.75 of a cell).
  const cells = new Map();
  for (const f of patchArr.faces) {
    const [x, y] = f.centroid;
    const key = `${Math.floor(x / P + 0.25)},${Math.floor(y / P + 0.25)}`;
    if (!cells.has(key)) cells.set(key, { star8: 0, star4: 0, hex: 0 });
    cells.get(key)[patch.classify(f).kind]++;
  }
  // Interior cells only (the patch is octagons −4..4: the rim cells are open).
  let checked = 0;
  for (let i = -3; i < 3; i++) for (let j = -3; j < 3; j++) {
    assert.deepEqual(cells.get(`${i},${j}`), { star8: 1, star4: 1, hex: 4 }, `cell ${i},${j}`);
    checked++;
  }
  assert.equal(checked, 36);
  // And every degree is 2 (star inner corners) or 4 (crossings at the edge midpoints).
  for (const o of patchArr.out) assert.ok(o.length === 2 || o.length === 4);
});

test('classify: chequerboard of lapis and turquoise stars, ochre 4-point stars, cream hexagons', () => {
  const at = (x, y) => field.classify({ centroid: [x, y] });
  assert.deepEqual(at(0, 0), { key: 'B', stage: FIELD_STAGE, kind: 'star8' });
  assert.equal(at(P, 0).key, 'T');
  assert.equal(at(P, P).key, 'B');
  assert.equal(at(-3 * P, 2 * P).key, 'T');
  assert.equal(at(10 * P, 10 * P).key, 'B');
  assert.deepEqual(at(P / 2, -P / 2), { key: 'O', stage: FIELD_STAGE, kind: 'star4' });
  assert.equal(at(0.5 * P, 0.2 * P).kind, 'hex');
  assert.equal(at(0.5 * P, 0.2 * P).key, 'W');
  // A face can be passed without a centroid (it is computed from the polygon).
  assert.equal(field.classify({ poly: ensureCCW(circlePoly(0.5, 8)) }).kind, 'star8');
  // Every arrangement face of the patch gets a known palette key.
  for (const f of patchArr.faces) assert.ok(['B', 'T', 'O', 'W'].includes(patch.classify(f).key));
});

test('strapwork: the field interlaces at every crossing and partitions a panel corner exactly', () => {
  const sw = strapwork(patchArr, { width: patch.strap });
  assert.deepEqual(sw.warnings, []);
  assert.equal(sw.fills.length, patchArr.faces.length);
  const fourWay = patchArr.out.filter(o => o.length === 4).length;
  assert.equal(sw.crossings.length, fourWay);
  // A square region whose edge runs through octagon centres (like the panel edge), with a
  // round hole (like the medallion): the clipped pieces tile it with no gaps or overlaps.
  const region = [[-2 * P, -2 * P], [2 * P, -2 * P], [2 * P, 2 * P], [-2 * P, 2 * P]];
  const hole = ensureCCW(circlePoly(1.3 * P, 128));
  const pieces = clipPieces([...sw.fills, ...sw.straps], { inside: region, outside: hole, minArea: 0 });
  const chk = checkPartition(pieces, area(region) - area(hole));
  assert.ok(chk.ok, JSON.stringify({ ...chk, overlaps: chk.overlaps.slice(0, 3) }));
});

test('options: contact angle is in degrees and validated; bounds set the coverage', () => {
  assert.throws(() => buildField({ theta: (67.5 * Math.PI) / 180 }), /degrees/);
  assert.throws(() => buildField({ theta: 90 }), /degrees/);
  const small = buildField({ bounds: { halfW: 2 * P, halfH: P } });
  const xs = small.segments.flat().map(p => p[0]), ys = small.segments.flat().map(p => p[1]);
  // Covers the bounds plus at least one period of margin on every side.
  assert.ok(Math.max(...xs) >= 3 * P && Math.min(...xs) <= -3 * P);
  assert.ok(Math.max(...ys) >= 2 * P && Math.min(...ys) <= -2 * P);
  assert.ok(Math.max(...ys) < Math.max(...xs), 'not square: honours halfH');
  assert.equal(small.strap, FIELD.STRAP);
  assert.equal(buildField({ strap: 0.3 }).strap, 0.3);
  // Another contact angle still gives straight lines through the midpoints.
  const other = buildField({ theta: 72, bounds: { halfW: P, halfH: P } });
  assert.ok(buildArrangement(other.segments).faces.length > 0);
});

test('performance: the whole panel field builds and arranges quickly', () => {
  const t0 = performance.now();
  const f = buildField();
  const t1 = performance.now();
  const arr = buildArrangement(f.segments);
  const t2 = performance.now();
  console.log(`  field: ${f.segments.length} segments in ${(t1 - t0).toFixed(0)} ms; ` +
    `arrangement ${arr.faces.length} faces in ${(t2 - t1).toFixed(0)} ms`);
  assert.ok(t2 - t0 < 3000);
  assert.deepEqual(arr.warnings, []);
});
