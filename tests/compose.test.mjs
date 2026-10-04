// Tests for the panel composition: src/pattern/compose.js, src/pattern/border.js, and the
// merge helpers compose.js added to src/pattern/cut.js.
//   node --test tests/compose.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { composePanel, COMPOSE } from '../src/pattern/compose.js';
import { buildBorder, BORDER, LINE_COUNTS } from '../src/pattern/border.js';
import { checkPartition, absorbPieces, sharedLength, removeSpikes } from '../src/pattern/cut.js';
import { area, centroid, isSimple, pointInPolygon, dist } from '../src/pattern/geom.js';
import { PAL } from '../src/pattern/palette.js';
import { PANEL } from '../src/config.js';

// Build once (about 0.6 s); `exact: true` also returns the pieces before grout, in laying order.
const t0 = performance.now();
const res = composePanel({ exact: true });
const coldMs = performance.now() - t0;
const { pieces, sinopia, stats, exact } = res;
const square = s => [[-s, -s], [s, -s], [s, s], [-s, s]];
const across = poly => { let m = 0; for (const p of poly) for (const q of poly) m = Math.max(m, dist(p, q)); return m; };

test('contract: every piece has the fields of CONTRACTS §3.3, in laying order', () => {
  assert.ok(pieces.length > 0);
  pieces.forEach((p, i) => {
    assert.equal(p.seq, i, 'pieces are sorted by seq, and seq is 0..N-1');
    assert.ok(Array.isArray(p.poly) && p.poly.length >= 3);
    assert.ok(p.key in PAL, `palette key ${p.key}`);
    assert.ok(typeof p.stage === 'string' && p.stage.length > 0, 'stage label non-empty');
    assert.ok(typeof p.kind === 'string' && p.kind.length > 0);
    assert.ok(['medallion', 'field', 'border'].includes(p.region));
    const [cx, cy] = centroid(p.poly);
    assert.ok(Math.abs(p.cx - cx) < 1e-9 && Math.abs(p.cy - cy) < 1e-9, 'cx, cy is the area centroid');
    assert.ok(Math.abs(p.rc - Math.hypot(cx, cy)) < 1e-9);
    assert.ok(Math.abs(p.ang - Math.atan2(cy, cx)) < 1e-9);
    assert.ok(Math.abs(p.r - Math.max(...p.poly.map(q => Math.hypot(q[0], q[1])))) < 1e-9, 'r is the farthest vertex');
  });
});

test('partition: before grout the pieces tile the square |x|,|y| ≤ 52 exactly', () => {
  const chk = checkPartition(exact, [square(PANEL.BORDER)]);
  assert.equal(chk.invalid.length, 0, 'every exact piece simple and counter-clockwise');
  assert.equal(chk.overlaps.length, 0, `overlaps ${JSON.stringify(chk.overlaps.slice(0, 3))}`);
  assert.ok(chk.relError < 1e-9, `area error ${chk.relError}`);
});

test('count: at least 8,000 finished pieces, none dropped by the grout', t => {
  t.diagnostic(`${pieces.length} pieces: ${JSON.stringify(stats.byRegion)}`);
  assert.ok(pieces.length >= 8000, `${pieces.length} pieces`);
  assert.equal(stats.drops, 0, 'no piece too small for the grout (each would be a mortar hole)');
  assert.equal(pieces.length, exact.length, 'every exact piece became a tile');
  assert.deepEqual(stats.warnings, []);
});

test('pieces: every finished piece simple, counter-clockwise, at least 0.05', () => {
  for (const p of pieces) {
    const a = area(p.poly);
    assert.ok(a > 0 && isSimple(p.poly), `${p.region}:${p.kind} at (${p.cx.toFixed(2)}, ${p.cy.toFixed(2)}) is not simple and CCW`);
    assert.ok(a >= 0.05, `${p.region}:${p.kind} at (${p.cx.toFixed(2)}, ${p.cy.toFixed(2)}) has area ${a}`);
  }
});

test('opening: the first piece is the gold khatem at the centre, under 1.6 across', () => {
  const [first] = pieces;
  assert.equal(first.region, 'medallion');
  assert.equal(first.key, 'A');
  assert.ok(pointInPolygon([0, 0], first.poly), 'it covers the centre');
  const w = across(first.poly);
  assert.ok(w > 0.8 && w < 1.6, `${w.toFixed(3)} across`);
});

test('laying order: medallion ring by ring with a sweep, then field and border by distance', () => {
  const nMed = pieces.filter(p => p.region === 'medallion').length;
  assert.ok(pieces.slice(0, nMed).every(p => p.region === 'medallion'), 'the medallion is laid first');
  // Medallion (exact pieces carry the design's layer): layers never go back, and inside a
  // layer the angle swept from A0 only grows.
  const sweep = p => { const [x, y] = centroid(p.poly); return (((Math.atan2(y, x) - COMPOSE.A0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); };
  for (let i = 1; i < nMed; i++) {
    const a = exact[i - 1], b = exact[i];
    assert.ok(b.layer >= a.layer, `layer goes back at ${i}`);
    if (b.layer === a.layer) assert.ok(sweep(b) >= sweep(a) - 1e-12, `sweep goes back at ${i}`);
  }
  // Field and border: distance plus a jitter of ±0.6, so a piece is never laid more than 1.2
  // (plus the wobble's centroid shift) closer in than one laid before it.
  let maxRc = 0, maxBack = 0;
  for (const p of pieces.slice(nMed)) {
    maxBack = Math.max(maxBack, maxRc - p.rc);
    maxRc = Math.max(maxRc, p.rc);
  }
  assert.ok(maxBack <= 2 * COMPOSE.jitter + 0.1, `a piece laid ${maxBack.toFixed(2)} inside the front`);
  assert.ok(maxBack > 0.5, 'the jitter is there (the front is ragged)');
});

test('determinism: the same seed lays the same panel; another seed only changes the wobble and jitter', () => {
  const again = composePanel();
  assert.equal(again.pieces.length, pieces.length);
  for (const i of [0, 1, 500, 5000, pieces.length - 1]) assert.deepEqual(again.pieces[i], pieces[i]);
  const other = composePanel({ seed: 7 });
  assert.equal(other.pieces.length, pieces.length, 'the geometry does not depend on the seed');
  assert.deepEqual(other.pieces[0].key, pieces[0].key);
  assert.notDeepEqual(other.pieces[0].poly, pieces[0].poly, 'the wobble does');
});

test('build time in Node', t => {
  const t1 = performance.now();
  composePanel();
  const warm = performance.now() - t1;
  t.diagnostic(`cold ${coldMs.toFixed(0)} ms, warm ${warm.toFixed(0)} ms; steps ${JSON.stringify(stats.ms)}`);
  // GitHub's build machines are about 2.5x slower than the M2 Pro this budget was set on
  const budget = process.env.CI ? 4000 : 1500;
  assert.ok(Math.min(coldMs, warm) < budget, `build takes ${Math.min(coldMs, warm).toFixed(0)} ms (over ${budget} ms)`);
});

test('field: no clip sliver left, and every 4.8.8 square has its gold pin', () => {
  const field = exact.filter(p => p.region === 'field');
  const small = field.filter(p => area(p.poly) < COMPOSE.sliver);
  assert.equal(small.length, 0, `field pieces under ${COMPOSE.sliver}: ${small.map(p => p.kind).join(', ')}`);
  assert.ok(!field.some(p => p.kind === 'star4'), 'no 4-point star specks');
  // Every pin sits on a 4.8.8 square centre ((i + ½)P, (j + ½)P), inside the field.
  const P = 92 / 20;
  const pins = pieces.filter(p => p.kind === 'pin');
  assert.ok(pins.length > 200, `${pins.length} pins`);
  for (const p of pins) {
    assert.equal(p.key, COMPOSE.pinKey);
    const i = p.cx / P - 0.5, j = p.cy / P - 0.5;
    assert.ok(Math.abs(i - Math.round(i)) < 0.05 && Math.abs(j - Math.round(j)) < 0.05, `pin at (${p.cx}, ${p.cy})`);
  }
  // Squares whose pin would be cut by the medallion or the panel edge lose it to a merge;
  // every other square has one.
  const expected = [];
  for (let a = -10; a < 10; a++) for (let b = -10; b < 10; b++) {
    const c = [(a + 0.5) * P, (b + 0.5) * P];
    if (Math.hypot(...c) > 29.5 + 0.4 && Math.max(Math.abs(c[0]), Math.abs(c[1])) < 46 - 0.4) expected.push(c);
  }
  assert.equal(pins.length, expected.length);
});

test('field: the knot treatment (star4: absorb) also partitions the panel exactly', () => {
  const alt = composePanel({ star4: 'absorb', exact: true });
  const chk = checkPartition(alt.exact, [square(PANEL.BORDER)]);
  assert.ok(chk.ok, JSON.stringify({ rel: chk.relError, ov: chk.overlaps.length, inv: chk.invalid.length }));
  assert.equal(alt.stats.drops, 0);
  assert.ok(alt.pieces.some(p => p.kind === 'knot') && !alt.pieces.some(p => p.kind === 'star4'));
});

test('stages: the HUD labels of every region', () => {
  const stages = new Set(pieces.map(p => p.stage));
  for (const s of ['Central 16-point star', 'Eight-point stars', 'Framing rings', 'Border']) assert.ok(stages.has(s), s);
  assert.ok(pieces.filter(p => p.region === 'border').every(p => p.stage === 'Border'));
  assert.ok(pieces.filter(p => p.region === 'field').every(p => p.stage === 'Eight-point stars'));
  assert.ok(pieces.filter(p => p.kind === 'band').every(p => p.stage === 'Framing rings'));
});

test('sinopia: a drawSinopia spec in the prototype red, with its two pens', () => {
  assert.deepEqual(sinopia.color, [160, 62, 40]);
  const pens = new Set();
  const finite = v => Number.isFinite(v);
  for (const c of sinopia.circles) { assert.ok(c.r > 0 && c.r <= 29.5 + 1e-9); pens.add(`${c.width}/${c.alpha}`); }
  for (const r of sinopia.rects) { assert.ok(r.min.every(finite) && r.max.every(finite)); pens.add(`${r.width}/${r.alpha}`); }
  for (const pl of sinopia.polylines) {
    assert.ok(Array.isArray(pl.paths) && pl.paths.length > 0);
    for (const path of pl.paths) assert.ok(path.length >= 2 && path.every(p => finite(p[0]) && finite(p[1])));
    pens.add(`${pl.width}/${pl.alpha}`);
  }
  assert.deepEqual([...pens].sort(), ['0.09/0.38', '0.2/0.72'], 'main 0.2 wide at 0.72, faint 0.09 at 0.38');
  // The 4.8.8 tiling is drawn only outside the medallion and inside the panel square.
  const tiling = sinopia.polylines[1].paths;
  assert.ok(tiling.length > 1000);
  for (const [a, b] of tiling) {
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    assert.ok(Math.hypot(...m) >= 29.5 - 1e-6 && Math.max(Math.abs(m[0]), Math.abs(m[1])) <= 46 + 1e-9);
  }
  // The panel and border edges are main lines.
  assert.ok(sinopia.rects.some(r => r.max[0] === 46 && r.alpha === 0.72) && sinopia.rects.some(r => r.max[0] === 52 && r.alpha === 0.72));
});

// ---------------------------------------------------------------------------------------
// Border
// ---------------------------------------------------------------------------------------

const border = buildBorder();

test('border: an exact partition of the ring 46..52, cut small', () => {
  const ring = 104 * 104 - 92 * 92;
  const chk = checkPartition(border.pieces, ring);
  assert.ok(chk.ok, JSON.stringify({ rel: chk.relError, ov: chk.overlaps.length, inv: chk.invalid.length }));
  for (const p of border.pieces) {
    assert.ok(area(p.poly) <= BORDER.maxArea + 1e-9, `${p.sub} piece of area ${area(p.poly)}`);
    assert.ok(area(p.poly) > 0.3, `${p.sub} piece of area ${area(p.poly)}`);
    assert.equal(p.stage, 'Border');
  }
});

test('border: 16 cream teeth per side, terracotta tips every 5.75 from x = -46', () => {
  const top = border.pieces.filter(p => p.sub === 'tooth' && centroid(p.poly)[1] > 47 && Math.abs(centroid(p.poly)[0]) < 47);
  // Tips: a terracotta piece with a vertex on the outer line, a cream piece with one on the inner line.
  const tipsR = new Set(), tipsW = new Set();
  for (const p of top) for (const [x, y] of p.poly) {
    if (p.key === 'R' && y === 50 && top.some(q => q !== p && q.key === 'W' && q.poly.some(v => v[0] === x && v[1] === 50))) tipsR.add(x);
    if (p.key === 'W' && y === 47) tipsW.add(x);
  }
  const R = [...tipsR].sort((a, b) => a - b);
  assert.equal(R.length, 17);
  R.forEach((x, k) => assert.equal(x, -46 + 5.75 * k));
  const W = [...tipsW].filter(x => Math.abs(x) < 47).sort((a, b) => a - b);
  assert.ok(W.length >= 16);
});

test('border: joints of neighbouring lines never meet', () => {
  const joints = (e0, n) => Array.from({ length: n - 1 }, (_, k) => -e0 + (2 * e0 * (k + 1)) / n);
  const gap = (a, b) => Math.min(...a.map(x => Math.min(...b.map(y => Math.abs(x - y)))));
  const A = joints(46, LINE_COUNTS.lineA), B = joints(50, LINE_COUNTS.lineB), G = joints(51, LINE_COUNTS.edge);
  assert.ok(gap(A, B) >= 0.25, `black lines: ${gap(A, B)}`);
  assert.ok(gap(B, G) >= 0.25, `black line and gold edge: ${gap(B, G)}`);
  // Pitches stay in the 1–1.5 range.
  for (const [e0, n] of [[46, LINE_COUNTS.lineA], [50, LINE_COUNTS.lineB], [51, LINE_COUNTS.edge]]) assert.ok(2 * e0 / n >= 1 && 2 * e0 / n <= 1.5);
});

test('border: the four sides are quarter turns and mirror images of each other', () => {
  const key = (x, y, k) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${k}`;
  const set = new Set(border.pieces.map(p => { const [x, y] = centroid(p.poly); return key(x, y, p.key); }));
  for (const p of border.pieces) {
    const [x, y] = centroid(p.poly);
    assert.ok(set.has(key(-y, x, p.key)), 'quarter turn');
    assert.ok(set.has(key(-x, y, p.key)), 'mirror');
    assert.ok(set.has(key(y, x, p.key)), 'diagonal mirror');
  }
  const pins = border.pieces.filter(p => p.sub === 'pin');
  assert.equal(pins.length, 4);
  for (const p of pins) { assert.equal(p.key, 'A'); assert.ok(Math.abs(area(p.poly) - 1.44) < 1e-9); }
});

// ---------------------------------------------------------------------------------------
// Merge helpers added to cut.js
// ---------------------------------------------------------------------------------------

test('sharedLength: collinear, opposite sides, with or without matching vertices', () => {
  const a = [[0, 0], [2, 0], [2, 1], [0, 1]];
  const b = [[0, 1], [1, 1], [2, 1], [2, 2], [0, 2]];   // split where a is not
  assert.ok(Math.abs(sharedLength(a, b) - 2) < 1e-12);
  const c = [[2, 0], [3, 0], [3, 0.5], [2, 0.5]];       // half of a's right side
  assert.ok(Math.abs(sharedLength(a, c) - 0.5) < 1e-12);
  assert.equal(sharedLength(a, [[5, 5], [6, 5], [6, 6]]), 0);
});

test('absorbPieces: a sliver goes to the neighbour it lies against, and the partition stays exact', () => {
  const big = { poly: [[0, 0], [4, 0], [4, 1], [0, 1]], kind: 'strap' };
  const other = { poly: [[0, 1], [4, 1], [4, 2], [0, 2]], kind: 'fill' };
  const sliver = { poly: [[4, 0], [4.05, 0], [4.05, 2], [4, 2]], kind: 'fill' };   // touches both
  const res = absorbPieces([big, other, sliver], { select: p => area(p.poly) < 0.15, rank: (s, c) => (c.kind === 'strap' ? 1 : 0) });
  assert.equal(res.pieces.length, 2);
  assert.equal(res.failed.length, 0);
  const grown = res.pieces.find(p => p.kind === 'strap');
  assert.ok(Math.abs(area(grown.poly) - 4.1) < 1e-12, 'the preferred (strap) neighbour took it: equal shared sides');
  assert.ok(checkPartition(res.pieces, 8.1).ok);
  // A sliver that barely touches the preferred neighbour goes to the one it lies along.
  const s2 = { poly: [[4, 0.9], [4.05, 0.9], [4.05, 2], [4, 2]], kind: 'fill' };
  const big2 = { poly: [[0, 0], [4, 0], [4, 0.9], [4, 1], [0, 1]], kind: 'strap' };
  const res2 = absorbPieces([big2, other, s2], { select: p => p === s2, rank: (s, c) => (c.kind === 'strap' ? 1 : 0) });
  assert.equal(res2.merged[0].into, other);
});

test('removeSpikes: a zero-width crack is removed, real corners are kept', () => {
  const crack = [[0, 0], [2, 0], [2, 2], [1, 2], [1, 1], [1, 2 + 1e-15], [0, 2]];
  const out = removeSpikes(crack);
  assert.ok(!out.some(p => p[0] === 1 && p[1] === 1), 'the crack tip is gone');
  assert.ok(Math.abs(area(out) - 4) < 1e-12 && isSimple(out));
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  assert.deepEqual(removeSpikes(L), L);
});

test('src/pattern stays free of three.js', () => {
  for (const f of ['compose.js', 'border.js']) {
    const src = readFileSync(new URL(`../src/pattern/${f}`, import.meta.url), 'utf8');
    assert.ok(!/from\s+['"]three/.test(src), f);
  }
});
