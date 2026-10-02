// Tests for the "moorish" 16-fold medallion: src/pattern/rosette16/moorish.js
//   node --test tests/rosette-moorish.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildRosette, cutRosette, fold, splitByLine, STAGES } from '../src/pattern/rosette16/moorish.js';
import { area, centroid, isSimple, pointInPolygon, dist, orient } from '../src/pattern/geom.js';
import { checkPartition } from '../src/pattern/cut.js';
import { PAL } from '../src/pattern/palette.js';
import { MEDALLION } from '../src/config.js';

// Build once: the whole medallion takes about 0.1 s.
const ros = buildRosette();
const res = cutRosette(ros);
const g = ros.geo;
const DEG = Math.PI / 180;
const rot = (p, deg) => [p[0] * Math.cos(deg * DEG) - p[1] * Math.sin(deg * DEG), p[0] * Math.sin(deg * DEG) + p[1] * Math.cos(deg * DEG)];
const mirror = p => [p[0], -p[1]];
const radius = p => Math.hypot(p[0], p[1]);

/** A point lookup with tolerance: does `pts` contain a point within tol of p? */
function pointSet(pts, tol = 1e-6) {
  const cell = 1e-3, grid = new Map();
  const k = (x, y) => `${x},${y}`;
  for (const p of pts) {
    const key = k(Math.floor(p[0] / cell), Math.floor(p[1] / cell));
    (grid.get(key) ?? grid.set(key, []).get(key)).push(p);
  }
  return q => {
    const cx = Math.floor(q[0] / cell), cy = Math.floor(q[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const p of grid.get(k(cx + dx, cy + dy)) ?? []) if (dist(p, q) <= tol) return p;
    }
    return null;
  };
}

test('contract: buildRosette returns the fields of CONTRACTS §3.2', () => {
  assert.ok(Array.isArray(ros.segments) && ros.segments.length > 0);
  for (const s of ros.segments) assert.ok(s.length === 2 && s.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  assert.ok(Math.abs(ros.strap - 0.46) < 1e-9, 'strap width matches the field');
  assert.equal(typeof ros.classify, 'function');
  assert.ok(ros.R_M > 20 && ros.R_M < ros.R_F, `R_M ${ros.R_M}`);
  assert.ok(ros.R_F <= MEDALLION.R_F_MAX + 1e-12, 'medallion fits r ≤ 29.5');
  assert.ok(Array.isArray(ros.sinopia.circles) && Array.isArray(ros.sinopia.lines) && ros.sinopia.lines.length >= 32);
  // Bands: contiguous from R_M to R_F, each cut into a multiple of 16 sectors.
  let r = ros.R_M;
  for (const b of ros.bands) {
    assert.ok(Math.abs(b.r0 - r) < 1e-12 && b.r1 > b.r0, 'bands are contiguous');
    assert.equal(b.count % 16, 0);
    assert.ok(b.key in PAL && typeof b.stage === 'string');
    r = b.r1;
  }
  assert.ok(Math.abs(r - ros.R_F) < 1e-12, 'the last band ends at R_F');
});

test('construction: the drawing is what the steps say it is', () => {
  // Star points on the tip axes; the star side runs straight on through the point to the kite tip.
  assert.ok(Math.abs(g.T[1]) < 1e-12 && Math.abs(radius(g.T) - g.r_t) < 1e-12);
  assert.ok(Math.abs(orient(g.Dm, g.T, g.P)) < 1e-9, 'dent, star point and kite tip are collinear');
  assert.ok(Math.abs(Math.atan2(g.P[1], g.P[0]) / DEG - 11.25) < 1e-9, 'the kite tip is on the dent axis');
  // Petal flank parallel to the tip axis; crown line parallel to the star side.
  assert.ok(Math.abs(g.S[1] - g.T1[1]) < 1e-9, 'the shoulder is on the flank');
  const dirStar = Math.atan2(g.D[1] - g.T[1], g.D[0] - g.T[0]);   // the other side of the same point
  const dirCrown = Math.atan2(g.S[1] - g.C[1], g.S[0] - g.C[0]);
  assert.ok(Math.abs(Math.sin(dirStar - dirCrown)) < 1e-9, 'crown line ∥ star side');
  // Eight-point stars: inner point on the crown, outer point on the frame line, side points on
  // the dent axes (touching their neighbours), 45° points.
  assert.ok(Math.abs(radius(g.star8Tip(4)) - g.r_c) < 1e-9);
  assert.ok(Math.abs(radius(g.star8Tip(0)) - g.R_line) < 1e-9);
  assert.ok(Math.abs(Math.atan2(g.star8Tip(2)[1], g.star8Tip(2)[0]) / DEG - 11.25) < 1e-9);
  const t = g.star8Tip(0), a = g.star8Dent(0), b = g.star8Dent(7);
  const tipAngle = Math.acos(((a[0] - t[0]) * (b[0] - t[0]) + (a[1] - t[1]) * (b[1] - t[1])) / (dist(a, t) * dist(b, t))) / DEG;
  assert.ok(Math.abs(tipAngle - 45) < 1e-9, `star points are 45°, got ${tipAngle}`);
  // The frame strap's outer edge is the disk edge.
  assert.ok(Math.abs(g.R_line + ros.strap / 2 / Math.cos(Math.PI / g.G) - g.R_M) < 1e-12);
});

test('symmetry: the centre lines have all 32 mirror lines of D16', () => {
  const verts = res.arr.vertices;
  const has = pointSet(verts);
  for (const v of verts) {
    assert.ok(has(rot(v, 22.5)), `rotation by 22.5° misses ${v}`);
    assert.ok(has(mirror(v)), `mirror misses ${v}`);
  }
  const mids = pointSet(res.arr.edges.map(e => { const p = verts[e.a], q = verts[e.b]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; }));
  for (const e of res.arr.edges) {
    const m = [(verts[e.a][0] + verts[e.b][0]) / 2, (verts[e.a][1] + verts[e.b][1]) / 2];
    assert.ok(mids(rot(m, 22.5)) && mids(mirror(m)), 'edges map onto edges');
  }
});

test('symmetry: coloured pieces repeat every 45° and mirror (8-fold colour alternation)', () => {
  const fills = res.exact.filter(p => p.kind !== 'strap' && p.kind !== 'band');
  const cents = fills.map(p => centroid(p.poly));
  const at = pointSet(cents);
  const byCentroid = new Map(cents.map((c, i) => [c, fills[i]]));
  for (const p of fills) {
    for (const tf of [q => rot(q, 45), mirror]) {
      const hit = at(tf(centroid(p.poly)));
      assert.ok(hit, `${p.kind} has no image`);
      const q = byCentroid.get(hit);
      assert.equal(q.key, p.key, `${p.kind} changes colour under symmetry`);
      assert.ok(Math.abs(area(q.poly) - area(p.poly)) < 1e-9);
    }
  }
});

test('faces: every face is classified, with the expected counts', () => {
  const counts = {};
  for (const f of res.arr.faces) {
    const c = ros.classify(f);
    assert.notEqual(c.kind, 'unknown', `face ${f.id} at ${f.centroid} is not classified`);
    assert.ok(c.key in PAL, `bad key ${c.key}`);
    assert.ok(Object.values(STAGES).includes(c.stage));
    assert.ok(Number.isInteger(c.layer) && c.layer >= 0);
    assert.ok(['none', 'centre+points', 'run'].includes(c.split) || /^wedges:\d+/.test(c.split));
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }
  assert.deepEqual(counts, { star16: 1, kite: 16, petal: 16, bow: 16, star8: 16, candy: 32, rim: 32 });
  // Layers grow outward: the centre first, the rim last.
  const layerOf = kind => ros.classify(res.arr.faces.find(f => ros.classify(f).kind === kind)).layer;
  const order = ['star16', 'kite', 'petal', 'bow', 'star8', 'rim'].map(layerOf);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // The fold puts every point in the construction wedge.
  for (const f of res.arr.faces) {
    const a = Math.atan2(fold(f.centroid).p[1], fold(f.centroid).p[0]) / DEG;
    assert.ok(a >= -1e-9 && a <= 11.25 + 1e-9);
  }
});

test('engine: clean arrangement and strapwork (no dangling, nested, invalid or fallback)', () => {
  assert.deepEqual(res.warnings.map(w => w.code), []);
  assert.equal(res.sw.fills.length, res.arr.faces.length, 'every face keeps a fill');
});

test('partition: the exact pieces tile the medallion disk exactly', () => {
  const chk = checkPartition(res.exact, ros.outerPoly);
  assert.equal(chk.invalid.length, 0, 'every piece simple and counter-clockwise');
  assert.equal(chk.overlaps.length, 0, `overlaps ${JSON.stringify(chk.overlaps.slice(0, 3))}`);
  assert.ok(chk.relError < 1e-9, `area error ${chk.relError}`);
  // And the strapwork alone tiles the disk inside the frame bands.
  const inner = res.exact.filter(p => p.kind !== 'band');
  const chkDisk = checkPartition(inner, ros.diskPoly);
  assert.ok(chkDisk.ok, `disk partition: ${JSON.stringify({ rel: chkDisk.relError, ov: chkDisk.overlaps.length })}`);
});

test('opening: the first piece is a small, chunky khatem at the centre', () => {
  const first = res.tiles.filter(p => p.layer === 0);
  assert.equal(first.length, 1, 'one piece in layer 0');
  const [k] = first;
  assert.ok(pointInPolygon([0, 0], k.poly), 'it covers the centre');
  let across = 0;
  for (const p of k.poly) for (const q of k.poly) across = Math.max(across, dist(p, q));
  assert.ok(across >= 0.8 && across <= 1.6, `centre piece is ${across.toFixed(3)} across`);
  assert.equal(k.key, 'A');
  // The opening close-up (about ±3 units): a few chunky pieces, nothing sliver-like.
  const near = res.tiles.filter(p => p.poly.every(q => radius(q) < 3.2));
  assert.ok(near.length >= 9 && near.length <= 60, `${near.length} pieces within r < 3.2`);
  for (const p of near) assert.ok(area(p.poly) > 0.4, `small piece near the centre: ${area(p.poly)}`);
});

test('pieces: count, sizes, palette, and gold used sparingly', () => {
  const n = res.tiles.length;
  assert.ok(n >= 800 && n <= 2100, `piece count ${n}`);
  assert.equal(res.dropped.length, 0, 'no piece dropped for being too small');
  let gold = 0, total = 0;
  for (const p of res.tiles) {
    const a = area(p.poly);
    assert.ok(a > 0.05, `sliver ${p.kind} ${a}`);
    assert.ok(isSimple(p.poly) && a > 0, 'finished pieces are simple and counter-clockwise');
    assert.ok(p.key in PAL, `key ${p.key}`);
    total += a;
    if (p.key === 'A') gold += a;
  }
  // Exact (uncut-for-grout) pieces stay near the target size; strap pieces are long and thin.
  for (const p of res.exact) if (p.kind !== 'strap') assert.ok(area(p.poly) <= 3.3, `${p.kind} piece of area ${area(p.poly)}`);
  assert.ok(gold / total < 0.08, `gold covers ${(100 * gold / total).toFixed(1)}%`);
});

test('determinism and options', () => {
  const again = cutRosette(buildRosette());
  assert.equal(again.tiles.length, res.tiles.length);
  assert.deepEqual(again.tiles[100].poly, res.tiles[100].poly);
  // The palette can be overridden without touching the geometry.
  const alt = buildRosette({ keys: { bow: ['G', 'G'] } });
  const bow = res.arr.faces.find(f => ros.classify(f).kind === 'bow');
  assert.equal(alt.classify(bow).key, 'G');
  assert.equal(alt.segments.length, ros.segments.length);
});

test('splitByLine halves a symmetric piece exactly', () => {
  const kite = [[0, 0], [2, -1], [5, 0], [2, 1]];
  const [l, r] = splitByLine(kite, [0, 0], [1, 0]);
  assert.ok(Math.abs(area(l) + area(r) - area(kite)) < 1e-12 && Math.abs(area(l) - area(r)) < 1e-12);
});

test('src/pattern stays free of three.js', () => {
  const src = readFileSync(new URL('../src/pattern/rosette16/moorish.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]three/.test(src));
});
