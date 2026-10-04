// Tests for what the light sweep does besides moving the sun (anim/light.js MOOD, sweepMood):
// the room light dims, the sun warms, the gold glints, and all of it returns exactly to rest.
//
// Why it exists: moving the sun alone was nearly invisible from the finished view (the owner
// pressed Sweep light in Chrome and saw nothing; measured at 1280×800 the panel dimmed ~9 % and
// no gold flashed). The real-browser look is checked with screenshots; these pin the numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createLightRig, sweepMood, MOOD, MOOD_REST, SUN } from '../src/anim/light.js';

const F = 1 / 60;

test('sweepMood: exactly the rest light outside the sweep', () => {
  for (const p of [-1, -0.01, 0, 1, 1.5, NaN]) {
    const m = sweepMood(p, 0.7);
    assert.equal(m.fill, 1); assert.equal(m.background, 1); assert.equal(m.gain, 1);
    assert.equal(m.warmth, 0); assert.equal(m.glint, 0); assert.equal(m.sunAz, 0.7);
  }
  assert.deepEqual(Object.keys(MOOD_REST).sort(), ['background', 'fill', 'gain', 'glint', 'sunAz', 'warmth']);
});

test('sweepMood: the deepest change at the middle, eased in and out with no step', () => {
  const mid = sweepMood(0.5, 0);
  assert.ok(Math.abs(mid.fill - MOOD.FILL) < 1e-12);
  assert.ok(Math.abs(mid.background - MOOD.BACKGROUND) < 1e-12);
  assert.ok(Math.abs(mid.gain - MOOD.SUN_GAIN) < 1e-12);
  assert.ok(Math.abs(mid.warmth - 1) < 1e-12);
  assert.ok(Math.abs(mid.glint - 1) < 1e-12);
  // symmetric, monotonic toward the middle
  let prev = 1;
  for (let p = 0.01; p <= 0.5; p += 0.01) {
    const a = sweepMood(p, 0), b = sweepMood(1 - p, 0);
    assert.ok(Math.abs(a.fill - b.fill) < 1e-9);
    assert.ok(a.fill <= prev + 1e-12); prev = a.fill;
  }
  // sin²: zero slope at both ends, so the first and last frames barely differ from rest
  const first = sweepMood(F / SUN.SWEEP_SECONDS, 0);
  assert.ok(1 - first.fill < 1e-4, `first frame fill ${first.fill}`);
  assert.ok(first.warmth < 1e-4);
});

test('sweepMood: the room really dims (the change has to be visible)', () => {
  assert.ok(MOOD.FILL <= 0.6, 'room light at the middle at most 60 % of rest');
  assert.ok(MOOD.SUN_GAIN >= 1, 'the sun does not fade with the room');
  assert.ok(MOOD.BACKGROUND > MOOD.FILL && MOOD.BACKGROUND < 1, 'the background dims, but less than the room');
});

test('light rig: mood follows the sweep, carries the sun azimuth, and returns to rest', () => {
  const sun = new THREE.DirectionalLight();
  const rig = createLightRig(sun);
  const view = new THREE.Vector3(30, 120, 40), reach = 57;
  rig.update(0, view, reach);
  assert.deepEqual(rig.mood, MOOD_REST);
  rig.sweep(0);
  let deepest = 1, maxGlint = 0;
  for (let t = F; t < SUN.SWEEP_SECONDS + 1; t += F) {
    rig.update(t, view, reach);
    const m = rig.mood;
    deepest = Math.min(deepest, m.fill); maxGlint = Math.max(maxGlint, m.glint);
    // the glint follows the sun's actual azimuth
    assert.ok(Math.abs(Math.atan2(sun.position.z, sun.position.x) - Math.atan2(Math.sin(m.sunAz), Math.cos(m.sunAz))) < 1e-9);
  }
  assert.ok(deepest < MOOD.FILL + 0.01, `deepest fill ${deepest}`);
  assert.ok(maxGlint > 0.99);
  assert.equal(rig.sweeping, false);
  assert.equal(rig.mood.fill, 1); assert.equal(rig.mood.glint, 0);
});

test('light rig: cancel puts the light back at once; mood:false (the prototype build) never changes it', () => {
  const sun = new THREE.DirectionalLight();
  const rig = createLightRig(sun);
  const view = new THREE.Vector3(30, 120, 40);
  rig.sweep(0);
  rig.update(5, view, 57);
  assert.ok(rig.mood.fill < 0.8);
  rig.cancel();
  assert.deepEqual({ ...rig.mood, sunAz: 0 }, { ...MOOD_REST, sunAz: 0 });

  const legacy = createLightRig(new THREE.DirectionalLight(), { prototypeShadow: true, mood: false });
  legacy.sweep(0);
  for (let t = 0; t < 12; t += 0.25) { legacy.update(t); assert.equal(legacy.mood, MOOD_REST); }
});
