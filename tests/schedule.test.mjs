// Tests for src/anim/schedule.js: start times, the binary-searched counters against a
// brute-force count, the prefix max of r, stage labels, and the drop curve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSchedule, dropPhase } from '../src/anim/schedule.js';
import { mulberry } from '../src/util/rand.js';

const TIMING = { T_START: 0.9, T_SPAN: 46, P_EXP: 0.42, D: 0.55 };

/** Random pieces with a few duplicate seq values (to exercise the stable sort). */
function randomPieces(n, rand) {
  const stages = ['Centre', 'Petals', 'Field', 'Border'];
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    seq: Math.floor(rand() * n * 0.7),   // ~30% collisions
    r: rand() * 52,
    stage: stages[Math.floor(rand() * stages.length)],
  }));
}

test('pieces are stably sorted by seq', () => {
  const rand = mulberry(1);
  const s = makeSchedule(randomPieces(500, rand), TIMING);
  for (let i = 1; i < s.N; i++) {
    const a = s.pieces[i - 1], b = s.pieces[i];
    assert.ok(a.seq < b.seq || (a.seq === b.seq && a.id < b.id), `order broken at ${i}`);
  }
});

test('t0 follows the prototype curve and is monotonic', () => {
  const s = makeSchedule(randomPieces(2000, mulberry(2)), TIMING);
  assert.equal(s.t0[0], Math.fround(TIMING.T_START));
  for (let i = 1; i < s.N; i++) assert.ok(s.t0[i] >= s.t0[i - 1], `t0 not monotonic at ${i}`);
  for (const i of [1, 9, 100, 1999]) {
    const expected = TIMING.T_START + TIMING.T_SPAN * Math.pow(i / s.N, TIMING.P_EXP);
    assert.ok(Math.abs(s.t0[i] - expected) < 1e-5, `t0[${i}]`);
  }
  assert.equal(s.T_END, s.t0[s.N - 1] + TIMING.D);
  assert.equal(s.D, TIMING.D);
  // The prototype's feel: with its 10,665 tiles the first 9 take about 2.5 s.
  const proto = makeSchedule(randomPieces(10665, mulberry(6)), TIMING);
  const firstNine = proto.t0[9] - proto.t0[0];
  assert.ok(firstNine > 2 && firstNine < 3, `first nine took ${firstNine} s`);
});

test('startedAt / landedAt / rLaidAt / stageAt match brute force', () => {
  const rand = mulberry(3);
  for (let sim = 0; sim < 40; sim++) {
    const n = 1 + Math.floor(rand() * 3000);
    const s = makeSchedule(randomPieces(n, rand), TIMING);
    const probes = [-1, 0, s.t0[0], s.T_END, s.T_END + 1];
    for (let k = 0; k < 60; k++) probes.push(rand() * (s.T_END + 2) - 1);
    // Exact boundary values: sim equal to some t0 and to some t0 + D.
    for (let k = 0; k < 10; k++) {
      const i = Math.floor(rand() * n);
      probes.push(s.t0[i], s.t0[i] + s.D);
    }
    for (const t of probes) {
      let started = 0, landed = 0, rMax = 0;
      for (let i = 0; i < n; i++) {
        if (s.t0[i] <= t) { started++; rMax = Math.max(rMax, s.pieces[i].r); }
        if (s.t0[i] + s.D <= t) landed++;
      }
      assert.equal(s.startedAt(t), started, `startedAt(${t}) n=${n}`);
      assert.equal(s.landedAt(t), landed, `landedAt(${t}) n=${n}`);
      assert.equal(s.rLaidAt(t), rMax, `rLaidAt(${t})`);
      assert.equal(s.stageAt(t), started ? s.pieces[started - 1].stage : null, `stageAt(${t})`);
    }
  }
});

test('rLaidAt is a prefix max, not the last piece', () => {
  const pieces = [
    { seq: 0, r: 0, stage: 'a' },
    { seq: 1, r: 5, stage: 'b' },
    { seq: 2, r: 3, stage: 'c' },   // laid after a farther piece: max must stay 5
  ];
  const s = makeSchedule(pieces, TIMING);
  assert.equal(s.rLaidAt(s.t0[2]), 5);
  assert.equal(s.stageAt(s.t0[2]), 'c');
});

test('edge cases: before the first piece, after T_END, N = 1, N = 0', () => {
  const s = makeSchedule(randomPieces(100, mulberry(4)), TIMING);
  assert.equal(s.startedAt(0), 0);
  assert.equal(s.landedAt(0), 0);
  assert.equal(s.stageAt(0), null);
  assert.equal(s.rLaidAt(0), 0);
  assert.equal(s.startedAt(s.T_END), 100);
  assert.equal(s.landedAt(s.T_END), 100);
  assert.equal(s.landedAt(1e9), 100);

  const one = makeSchedule([{ seq: 7, r: 0.5, stage: 'The centre' }], TIMING);
  assert.equal(one.N, 1);
  assert.equal(one.t0[0], Math.fround(TIMING.T_START));
  assert.equal(one.T_END, one.t0[0] + TIMING.D);
  assert.equal(one.startedAt(TIMING.T_START - 1e-3), 0);
  assert.equal(one.startedAt(one.t0[0]), 1);
  assert.equal(one.landedAt(one.T_END - 1e-3), 0);
  assert.equal(one.landedAt(one.T_END), 1);
  assert.equal(one.stageAt(10), 'The centre');
  assert.equal(one.rLaidAt(10), 0.5);

  const none = makeSchedule([], TIMING);
  assert.equal(none.N, 0);
  assert.equal(none.startedAt(100), 0);
  assert.equal(none.stageAt(100), null);
  assert.equal(none.rLaidAt(100), 0);
});

test('methods work unbound (main.js may pass them around)', () => {
  const { startedAt, landedAt, stageAt, rLaidAt } = makeSchedule(randomPieces(50, mulberry(5)), TIMING);
  assert.equal(startedAt(100), 50);
  assert.equal(landedAt(100), 50);
  assert.equal(typeof stageAt(100), 'string');
  assert.ok(rLaidAt(100) > 0);
});

test('dropPhase is the prototype pose curve', () => {
  const DROP = 2.6;
  assert.equal(dropPhase(-0.01, DROP).visible, false);
  assert.deepEqual(dropPhase(0, DROP), { visible: true, y: DROP, f: 1 });
  const mid = dropPhase(0.4, DROP);                 // q = 0.5
  assert.ok(Math.abs(mid.y - DROP * 0.75) < 1e-12);
  assert.ok(Math.abs(mid.f - 0.5) < 1e-12);
  const bounce = dropPhase(0.9, DROP);              // q = 0.5: top of the bounce
  assert.ok(Math.abs(bounce.y - 0.06) < 1e-12);
  assert.equal(bounce.f, 0);
  assert.deepEqual(dropPhase(1, DROP), { visible: true, y: 0, f: 0 });
  // Continuous at the fall/settle seam (y → 0, f → 0 from both sides).
  const before = dropPhase(0.8 - 1e-9, DROP), after = dropPhase(0.8, DROP);
  assert.ok(Math.abs(before.y - after.y) < 1e-6 && Math.abs(before.f - after.f) < 1e-6);
});

test('rCoveredAt: the radius inside which every piece has landed', () => {
  // Rings of square pieces laid outward, then one late piece near the centre
  const sq = (cx, cy, h = 0.4) => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
  const pieces = [
    { seq: 0, r: 0.6, poly: sq(0, 0) },           // covers the centre: inner radius 0
    { seq: 1, r: 3.6, poly: sq(3, 0) },           // inner radius 2.6
    { seq: 2, r: 6.6, poly: sq(0, 6) },           // inner radius 5.6
    { seq: 3, r: 2.6, poly: sq(-2, 0) },          // laid late, but nearer: inner radius 1.6
  ];
  const s = makeSchedule(pieces, TIMING);
  const landed = k => (k === 0 ? 0 : s.t0[k - 1] + s.D + 1e-6);   // sim right after k pieces landed
  assert.equal(s.rCoveredAt(0), 0);
  assert.ok(Math.abs(s.rCoveredAt(landed(1)) - 1.6) < 1e-9, 'the late inner piece holds the covered radius back');
  assert.ok(Math.abs(s.rCoveredAt(landed(3)) - 1.6) < 1e-9);
  assert.equal(s.rCoveredAt(landed(4)), Infinity, 'all landed');
  assert.equal(makeSchedule([], TIMING).rCoveredAt(5), Infinity);
});
