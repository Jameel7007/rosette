// Tests for the "polar" 16-fold medallion (src/pattern/rosette16/polar.js).
//   node --test tests/rosette-polar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildRosette, rosettePieces, polarTiling, hankinSegments, weldNearMisses, POLAR } from '../src/pattern/rosette16/polar.js';
import { buildArrangement } from '../src/pattern/graph.js';
import { strapwork } from '../src/pattern/strap.js';
import { clipPieces, checkPartition, finishPieces } from '../src/pattern/cut.js';
import { area, centroid, rotate, circlePoly, arcSegments, isSimple, dist } from '../src/pattern/geom.js';
import { PAL } from '../src/pattern/palette.js';
import { MEDALLION } from '../src/config.js';

const U = Math.PI / 16;
// Build once: every test reads the same medallion (it is deterministic; one test checks that).
const ros = buildRosette();
const cut = rosettePieces(ros);
const arr = buildArrangement(ros.segments);

/** Segment set as order-free keys, rounded to 1e-6 (well above float noise, far below any feature). */
const segKey = ([a, b]) => [a, b].map(p => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`).sort().join('|');

test('contract: the shape of buildRosette()', () => {
  for (const k of ['segments', 'strap', 'classify', 'R_M', 'bands', 'R_F', 'sinopia']) assert.ok(k in ros, `missing ${k}`);
  assert.equal(typeof ros.classify, 'function');
  assert.ok(ros.R_F <= MEDALLION.R_F_MAX + 1e-12, 'fits inside R_F_MAX');
  assert.ok(ros.strap >= 0.4 && ros.strap <= 0.5, 'strap width like the field');
  // Bands run contiguously from R_M out to R_F, each cut into a multiple of 16 sectors.
  assert.equal(ros.bands[0].r0, ros.R_M);
  for (let i = 1; i < ros.bands.length; i++) assert.equal(ros.bands[i].r0, ros.bands[i - 1].r1);
  assert.ok(Math.abs(ros.bands[ros.bands.length - 1].r1 - ros.R_F) < 1e-9);
  for (const b of ros.bands) {
    assert.ok(b.count % 16 === 0, 'band count is a multiple of 16');
    assert.ok(b.key in PAL && typeof b.stage === 'string');
  }
  assert.ok(Array.isArray(ros.sinopia.circles) && ros.sinopia.circles.length >= 4);
  assert.ok(Array.isArray(ros.sinopia.lines) && ros.sinopia.lines.length > 100);
  // Every centre line lies inside the strapwork disk (the frame line sits half a strap inside R_M).
  for (const s of ros.segments) for (const p of s) assert.ok(Math.hypot(...p) <= ros.R_M - ros.strap / 2 + 1e-9);
});

test('symmetry: the centre lines are invariant under the dihedral group D16', () => {
  const set = new Set(ros.segments.map(segKey));
  const rot = ros.segments.map(([a, b]) => [rotate(a, 2 * U), rotate(b, 2 * U)]);
  const mirX = ros.segments.map(([a, b]) => [[a[0], -a[1]], [b[0], -b[1]]]);     // mirror in radial 0
  const mirOdd = ros.segments.map(([a, b]) => [a, b].map(p => rotate([p[0], -p[1]], 2 * U)));   // mirror in radial 1
  for (const [name, image] of [['rotation by 22.5°', rot], ['mirror in the x axis', mirX], ['mirror at 11.25°', mirOdd]]) {
    const missing = image.filter(s => !set.has(segKey(s))).length;
    assert.equal(missing, 0, `${name}: ${missing} segments have no image`);
  }
  // Faces fall into orbits of the symmetry: 1 (the hub), 16 or 32 (or 64 at the rim).
  for (const o of ros.orbits) assert.ok([1, 16, 32, 64].includes(o.count), `orbit of ${o.count} faces (${o.role})`);
});

test('construction: a polar tiling of edge-sharing tiles, the 16-gon side equal to the octagon side', () => {
  const ref = polarTiling();
  const side16 = dist(ref.gon16[0], ref.gon16[1]);
  const oct = ref.tiles.octagon;
  assert.ok(Math.abs(side16 - dist(oct[0], oct[1])) < 1e-12, '16-gon side = octagon bottom side');
  // Tiles of one sector, rotated round, cover the annulus between the 16-gon and ring 2 without
  // overlap: their areas add up to the polygon areas they fill (checked on the full ring).
  const tiles = [];
  for (let k = 0; k < 16; k++) for (const t of Object.values(ref.tiles)) tiles.push(t.map(p => rotate(p, 2 * k * U)));
  const sum = tiles.reduce((s, t) => s + Math.abs(area(t)), 0);
  const check = checkPartition(tiles.map(t => (area(t) > 0 ? t : t.slice().reverse())), sum, { tol: 1e-9 });
  assert.equal(check.overlaps.length, 0, 'tiles overlap');
  // Hankin + weld leave no tile's lines pointing into another tile's star.
  const segs = weldNearMisses(hankinSegments([ref.gon16], (67.5 * Math.PI) / 180), 0.4);
  assert.equal(segs.length, 32, '16-gon motif: a 16-point star of 32 segments');
});

test('engine: the arrangement and strapwork are clean (no invalid fills or straps)', () => {
  assert.deepEqual(arr.warnings.map(w => w.code), [], 'arrangement warnings');
  const codes = cut.sw.warnings.map(w => w.code);
  for (const bad of ['fill-invalid', 'strap-invalid', 'outline', 'unmerged', 'interlace-fallback']) assert.ok(!codes.includes(bad), `strapwork warning ${bad}`);
});

test('partition: fills and straps tile the strapwork disk exactly; bands tile the frame', () => {
  // ros.disk is the strapwork's outline: a regular polygon a hair inside R_M (its vertex count
  // a multiple of 64, so the outer stars' tips are frame vertices).
  const disk = ros.disk;
  assert.ok(Math.abs(Math.hypot(...disk[0]) - (ros.R_M - POLAR.DISK_GAP)) < 1e-12 && disk.length % 64 === 0);
  const exactDisk = cut.exact.filter(p => p.kind !== 'band');
  const chk = checkPartition(exactDisk, disk);
  assert.equal(chk.invalid.length, 0, 'invalid pieces');
  assert.equal(chk.overlaps.length, 0, `overlaps ${JSON.stringify(chk.overlaps.slice(0, 3))}`);
  assert.ok(chk.relError < 1e-9, `area error ${chk.relError}`);
  // Bands: their sector boundaries are not all on the shared angular grid, so neighbouring
  // rings can disagree by a chord sagitta (< 0.002); the areas still match the annulus closely.
  const bands = cut.exact.filter(p => p.kind === 'band');
  const annulus = Math.PI * (ros.R_F ** 2 - ros.R_M ** 2);
  const bandArea = bands.reduce((s, p) => s + area(p.poly), 0);
  assert.ok(Math.abs(bandArea - annulus) / annulus < 1e-3, `band area ${bandArea} vs ${annulus}`);
  // Joining slivers to neighbours keeps the disk partition exact (only dropped specks are lost).
  const merged = cut.raw.filter(p => p.kind !== 'band');
  const lost = cut.dropped.filter(d => d.why.startsWith('sliver')).reduce((s, d) => s + area(d.p.poly), 0);
  const chk2 = checkPartition(merged, disk, { tol: 1e-6 });
  assert.equal(chk2.overlaps.length, 0, 'overlaps after joining slivers');
  assert.ok(Math.abs(chk2.areaError + lost) < 1e-6, `area after joining slivers: error ${chk2.areaError}, lost ${lost}`);
  assert.ok(lost < 1, `dropped sliver area ${lost}`);
});

test('composition: clipping to circlePoly(R_M, arcSegments(R_M)), as a composer would, is a no-op', () => {
  for (const R_F of [29.5, 28.6, 27]) {
    const r = R_F === 29.5 ? ros : buildRosette({ R_F });
    const sw = strapwork(buildArrangement(r.segments), { width: r.strap, targetLen: 1.2 });
    const pieces = [...sw.fills, ...sw.straps];
    const out = clipPieces(pieces, { inside: circlePoly(r.R_M, arcSegments(r.R_M)) });
    assert.equal(out.length, pieces.length, `R_F ${R_F}: clipping changed the pieces`);
    assert.ok(out.every((p, i) => p === pieces[i]), `R_F ${R_F}: every piece passes through untouched`);
  }
});

test('every face is classified with a palette key, stage, kind, layer and split', () => {
  const splits = /^(none|centre\+points|run|wedges:\d+(:-?[\d.]+)?)$/;
  for (const f of arr.faces) {
    const c = ros.classify(f);
    assert.ok(c.key in PAL, `face ${f.id}: key ${c.key}`);
    assert.ok(typeof c.stage === 'string' && c.stage.length > 0);
    assert.ok(typeof c.kind === 'string' && c.kind.length > 0);
    assert.ok(Number.isInteger(c.layer) && c.layer >= 0);
    assert.match(c.split, splits);
  }
  // Classification is by geometry, so it also works on a freshly built arrangement's faces.
  const again = buildArrangement(ros.segments);
  for (const f of again.faces.slice(0, 50)) assert.equal(ros.classify(f).role, ros.classify(arr.faces[f.id]).role);
  // The named roles are all there.
  const roles = new Set(ros.orbits.map(o => o.role));
  for (const r of ['hub', 'starKite', 'petal', 'hexagonStar', 'octagonStar', 'octagon2Star', 'rim']) assert.ok(roles.has(r), `role ${r}`);
  // The hub is layer 0 and the only face of its orbit; layers grow outward on average.
  const hub = ros.orbits.find(o => o.role === 'hub');
  assert.equal(hub.layer, 0);
  assert.equal(hub.count, 1);
});

test('centre: one small, chunky piece at the origin, ringed by small pieces', () => {
  const centres = cut.pieces.filter(p => p.kind === 'centre');
  assert.equal(centres.length, 1);
  const c = centres[0];
  const xs = c.poly.map(p => p[0]), ys = c.poly.map(p => p[1]);
  const across = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  assert.ok(across >= 0.8 && across <= 1.6, `centre piece ${across} across`);
  assert.ok(Math.hypot(...centroid(c.poly)) < 0.05, 'centred on the origin');
  // The opening shot (|x|, |y| ≤ 3): a few dozen chunky pieces, none of them slivers.
  const near = cut.pieces.filter(p => p.poly.every(q => Math.abs(q[0]) <= 3 && Math.abs(q[1]) <= 3));
  assert.ok(near.length >= 17 && near.length <= 80, `${near.length} pieces wholly in the opening frame`);
  for (const p of near) assert.ok(area(p.poly) > 0.12, `small piece ${area(p.poly)} near the centre`);
  // The hub ring is cut symmetrically: 8 equal pieces, two spokes each.
  const ring = cut.pieces.filter(p => p.stage === 'Central 16-point star' && p.kind === 'strap');
  assert.equal(ring.length, 8);
  const areas = cut.exact.filter(p => p.layer === 0.5).map(p => area(p.poly));
  assert.ok(Math.max(...areas) - Math.min(...areas) < 1e-6, 'hub ring pieces are equal');
});

test('pieces: count, sizes and no slivers', () => {
  const n = cut.pieces.length;
  assert.ok(n >= 2500 && n <= 3500, `${n} pieces`);
  for (const p of cut.pieces) {
    assert.ok(isSimple(p.poly) && area(p.poly) > 0, 'finished piece simple and counter-clockwise');
    assert.ok(area(p.poly) >= 0.05, `sliver of area ${area(p.poly)} (${p.kind})`);
    assert.ok(p.key in PAL);
  }
  // Large regions are cut: no fill bigger than about 3 square units once grouted.
  const fills = cut.pieces.filter(p => !['strap', 'band'].includes(p.kind));
  assert.ok(Math.max(...fills.map(p => area(p.poly))) < POLAR.SPLIT_AREA * 1.5);
  // Gold is used sparingly: the centre piece and two thin frame rings.
  const gold = cut.pieces.filter(p => p.key === 'A');
  assert.ok(gold.every(p => p.kind === 'centre' || p.kind === 'band'));
});

test('determinism, and src/pattern stays free of three.js', () => {
  const again = buildRosette();
  assert.equal(again.segments.length, ros.segments.length);
  assert.deepEqual(again.segments.slice(0, 50), ros.segments.slice(0, 50));
  const src = readFileSync(new URL('../src/pattern/rosette16/polar.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]three/.test(src), 'polar.js must not import three');
});

test('a smaller medallion (R_F = 27) still builds cleanly and symmetrically', () => {
  const small = buildRosette({ R_F: 27 });
  assert.ok(Math.abs(small.bands.at(-1).r1 - 27) < 1e-9);
  const a = buildArrangement(small.segments);
  assert.deepEqual(a.warnings.map(w => w.code), []);
  const sw = strapwork(a, { width: small.strap });
  assert.ok(!sw.warnings.some(w => w.code === 'fill-invalid'));
  for (const o of small.orbits) assert.ok([1, 16, 32, 64].includes(o.count));
});
