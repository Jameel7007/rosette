// Tests for where the light sweep passes behind the panel (anim/light.js: sweepAim, and the
// rig re-aiming it every frame).
//
// The defect these guard against: after a click on Finish the automatic sweep starts while
// the camera is still flying out of the low close-up. The sweep's side used to be chosen once,
// at that moment: "above the glaze's mirror band", right for the low camera. Once the camera
// settled at ~65° that put the sun at 83°, 2-3° from the near edge's mirror height, and for
// ~2 s the near third of the panel turned pastel (capture/review/DEFECT-finish-path-wash.png).
// The real-browser check of the same path is scripts/verify-app.mjs, section glint-motion.
//
// "Clearance" below is measured the honest way: the angle between the sun and the mirror
// direction of every glaze point on screen (rays through a grid of screen points, onto the
// bed), not the elevation band light.js reasons with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createLightRig, sweepAim, SUN, SWEEP_FLOOR } from '../src/anim/light.js';
import { createCameraRig, FRAMING, ORBIT } from '../src/anim/camera.js';
import { PANEL } from '../src/config.js';

const DEG = Math.PI / 180;
const F = 1 / 60;   // one frame
const elevOf = p => Math.atan2(p.y, Math.hypot(p.x, p.z));
const viewAt = (el, az, d) =>
  new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(d);
/** How far `h` lies outside the band [lo, hi] (negative: inside it). */
const outside = (h, lo, hi) => (h <= lo ? lo - h : h >= hi ? h - hi : -Math.min(h - lo, hi - h));

// ---------- sweepAim on its own ----------

test('sweepAim: full clearance whenever either side has room; otherwise the side with more', () => {
  const C = SUN.GLAZE_CLEARANCE;
  let full = 0, partial = 0;
  for (let el = 10; el <= 85; el += 0.5) {
    for (const reach of [0, 1, 3.2, 8, 17, 31, 45, 57, 73.5, 91, 125]) {
      for (const k of [1.5, 3.7, 8]) {
        const view = viewAt(el * DEG, 0.67, Math.max(reach, 3.2) * k);
        const a = sweepAim(view, reach);
        const at = `camera ${el}°, reach ${reach}, distance ×${k}`;
        assert.ok(a.height >= SWEEP_FLOOR - 1e-12 && a.height <= SUN.HIGH_MAX + 1e-12, `${at}: height ${(a.height / DEG).toFixed(1)}° out of range`);
        assert.ok(a.far <= a.near, `${at}: band upside down`);
        assert.ok(Math.abs(outside(a.height, a.far, a.near) - a.clearance) < 1e-9, `${at}: clearance is not the distance from the band`);
        const roomBelow = a.far - C >= SWEEP_FLOOR, roomAbove = a.near + C <= SUN.HIGH_MAX;
        if (roomBelow || roomAbove) {
          full++;
          assert.ok(a.clearance >= C - 1e-9, `${at}: only ${(a.clearance / DEG).toFixed(1)}° clear`);
          // as close to the band as the clearance allows (so the gold's facets can reach the sun),
          // below it when that fits
          if (roomBelow) assert.ok(a.side === 'below' && Math.abs(a.height - (a.far - C)) < 1e-12, at);
          else assert.ok(a.side === 'above' && Math.abs(a.height - (a.near + C)) < 1e-12, at);
        } else {
          partial++;
          const best = Math.max(a.far - SWEEP_FLOOR, SUN.HIGH_MAX - a.near);
          assert.ok(Math.abs(a.clearance - best) < 1e-9, `${at}: ${(a.clearance / DEG).toFixed(1)}° clear, ${(best / DEG).toFixed(1)}° possible`);
        }
      }
    }
  }
  assert.ok(full > 1000 && partial > 100, `both cases exercised (${full} with room, ${partial} without)`);
});

test('sweepAim: the finished views', () => {
  const rigView = (aspect, userEl = 0, zoom = 1) => {
    const canvas = Object.assign(new EventTarget(), { setPointerCapture() {} });
    const camera = new THREE.PerspectiveCamera(32, aspect, 0.1, 1200);
    const rig = createCameraRig(camera, canvas);
    rig.snap(PANEL.BORDER * Math.SQRT2);
    const ev = (type, y) => Object.assign(new Event(type), { pointerId: 1, clientX: 0, clientY: y });
    canvas.dispatchEvent(ev('pointerdown', 0)); canvas.dispatchEvent(ev('pointermove', userEl / ORBIT.EL_PER_PX)); canvas.dispatchEvent(ev('pointerup', 0));
    if (zoom !== 1) canvas.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: Math.log(zoom) / ORBIT.ZOOM_PER_WHEEL, preventDefault() {} }));
    rig.update(F, 73.5, 48);
    return sweepAim(camera.position, rig.framing * rig.zoom);
  };
  // The default finished view (65°): the whole panel's far corner is on screen, so "below" sits
  // at the prototype's 27° dip: the same sweep the prototype ran here
  const def = rigView(1280 / 800);
  assert.equal(def.side, 'below');
  assert.ok(Math.abs(def.height - SWEEP_FLOOR) < 1e-12);
  // Overhead (dragged to the top): the band is high, so the sun can pass behind higher (~41°)
  const top = rigView(1280 / 800, 2);
  assert.ok(top.side === 'below' && top.clearance >= SUN.GLAZE_CLEARANCE - 1e-9 && top.height > 38 * DEG, `${(top.height / DEG).toFixed(1)}°`);
  // A low drag (31°): above the band, with the full clearance
  const low = rigView(1280 / 800, -2);
  assert.ok(low.side === 'above' && low.clearance >= SUN.GLAZE_CLEARANCE - 1e-9, `${low.side} ${(low.height / DEG).toFixed(1)}°`);
  // The phone's portrait view stands further back: below, with the full clearance
  const phone = rigView(390 / 844);
  assert.ok(phone.side === 'below' && phone.clearance >= SUN.GLAZE_CLEARANCE - 1e-9, `${phone.side}`);
});

// ---------- the rig, frame by frame, with the real camera rig ----------

const ray = new THREE.Raycaster(), bed = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3), hit = new THREE.Vector3();
/** Mirror directions (where a sun would glare) of the glaze on screen: a grid of screen rays onto the panel. */
function glazeMirrors(camera, gx = 24, gy = 15) {
  camera.updateMatrixWorld();
  const out = [];
  for (let j = 0; j <= gy; j++) {
    for (let i = 0; i <= gx; i++) {
      ray.setFromCamera({ x: (i / gx) * 2 - 1, y: 1 - (j / gy) * 2 }, camera);
      if (!ray.ray.intersectPlane(bed, hit) || Math.abs(hit.x) > PANEL.BORDER || Math.abs(hit.z) > PANEL.BORDER) continue;
      const v = camera.position.clone().sub(hit).normalize();
      out.push(new THREE.Vector3(-v.x, v.y, -v.z));
    }
  }
  return out;
}
/** The smallest angle between the sun and any of those mirror directions. */
const glare = (mirrors, sunPos) => {
  const l = sunPos.clone().normalize();
  let m = Math.PI;
  for (const v of mirrors) m = Math.min(m, l.angleTo(v));
  return m;
};

/**
 * main.js's frame loop, reduced to the camera and the light: a page whose laying is still at
 * the opening close-up (finish: true, then Finish is pressed and the automatic sweep follows
 * SWEEP_DELAY later while the camera flies out), or the finished panel at rest with the Sweep
 * light button pressed. Optional viewer input before the sweep (elevation drag, wheel zoom) and
 * during it (`during(t, input)`).
 */
function runSweep({ aspect = 1.6, finish = false, userEl = 0, zoom = 1, during = null, every = 10 } = {}) {
  const canvas = Object.assign(new EventTarget(), { setPointerCapture() {} });
  const camera = new THREE.PerspectiveCamera(32, aspect, 0.1, 1200);
  const rig = createCameraRig(camera, canvas);
  const sun = new THREE.DirectionalLight(), light = createLightRig(sun);
  const ev = (type, y) => Object.assign(new Event(type), { pointerId: 1, clientX: 0, clientY: y });
  const input = {
    tilt(rad) { canvas.dispatchEvent(ev('pointerdown', 0)); canvas.dispatchEvent(ev('pointermove', rad / ORBIT.EL_PER_PX)); canvas.dispatchEvent(ev('pointerup', 0)); },
    zoom(f) { canvas.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: Math.log(f) / ORBIT.ZOOM_PER_WHEEL, preventDefault() {} })); },
  };
  let clock = 0, sim = finish ? 0.3 : 48, rLaid = finish ? 1 : 73.5;
  if (!finish) rig.snap(rLaid);
  if (userEl) input.tilt(userEl);
  if (zoom !== 1) input.zoom(zoom);
  const frame = () => { clock += F; sim += F; rig.update(F, rLaid, sim); light.update(clock, camera.position, rig.framing * rig.zoom); };
  for (let k = 0; k < 18; k++) frame();
  if (finish) { rLaid = 73.5; sim = 48; }     // Finish: the next frame sees every piece landed
  frame();
  const start = clock + (finish ? 1.2 : 0);   // main.js SWEEP_DELAY
  light.sweep(start);
  const res = { worst: Math.PI, worstAt: 0, lowest: Math.PI, highest: -Math.PI, maxStep: 0, maxElevStep: 0 };
  let prev = null, n = 0;
  while (clock < start + SUN.SWEEP_SECONDS + 0.2) {
    frame();
    const t = clock - start;
    if (during) during(t, input);
    const el = elevOf(sun.position);
    res.lowest = Math.min(res.lowest, el); res.highest = Math.max(res.highest, el);
    if (prev) { res.maxStep = Math.max(res.maxStep, sun.position.angleTo(prev)); res.maxElevStep = Math.max(res.maxElevStep, Math.abs(el - elevOf(prev))); }
    prev = sun.position.clone();
    if (t > 0 && ++n % every === 0) {
      const g = glare(glazeMirrors(camera), sun.position);
      if (g < res.worst) { res.worst = g; res.worstAt = t; }
    }
  }
  res.rest = glare(glazeMirrors(camera), sun.position);   // back at rest: the still picture's own glare
  res.camera = elevOf(camera.position);
  return res;
}
const deg = r => (r / DEG).toFixed(1) + '°';

test('Finish path: the automatic sweep keeps clear of the glaze once the camera settles (the 83° wash)', () => {
  // The old aim chose its side once, while the camera was low: 0.1° from the glaze's mirror at
  // 1280×800 and 0.2° at 1920×1080 in this model (the near third of the panel washed out)
  for (const [w, h] of [[1280, 800], [1920, 1080], [390, 844]]) {
    const r = runSweep({ aspect: w / h, finish: true, every: 4 });
    assert.ok(Math.abs(r.camera - 65.3 * DEG) < 0.5 * DEG, `the camera settled (${deg(r.camera)})`);
    assert.ok(r.worst >= 20 * DEG, `${w}×${h}: the sun came within ${deg(r.worst)} of the glaze's mirror (t = ${r.worstAt.toFixed(2)} s)`);
    assert.ok(r.highest < 52 * DEG, `${w}×${h}: it never rises over its rest height, i.e. no pass above the band (highest ${deg(r.highest)})`);
    assert.ok(r.lowest >= SWEEP_FLOOR - 1e-9, `${w}×${h}: lowest ${deg(r.lowest)}`);
  }
});

test('Sweep light on still views: the sweep keeps clear of the glaze on screen', () => {
  // [view, the clearance it keeps]. Zoomed-in views and the gap between ~45° and ~58° cannot
  // keep the full GLAZE_CLEARANCE: the sun would have to go under the prototype's dip or over
  // HIGH_MAX (anim/light.js header), so they hold less
  const cases = [
    ['default', {}, 20], ['overhead', { userEl: 2 }, 19], ['low drag', { userEl: -2 }, 25],
    ['zoomed (wheel)', { zoom: 0.55 }, 17], ['zoomed right in', { zoom: 0.3 }, 12], ['zoomed out', { zoom: 2.2 }, 25],
    ['low, zoomed in', { userEl: -2, zoom: 0.55 }, 20], ['phone', { aspect: 390 / 844 }, 25],
    ['phone, pinched in', { aspect: 390 / 844, zoom: 0.5 }, 20], ['phone, low', { aspect: 390 / 844, userEl: -2 }, 25],
    ['between sides (52°)', { userEl: -0.23 }, 10],
  ];
  for (const [name, opts, min] of cases) {
    const r = runSweep(opts);
    // The sun at rest is part of the still picture; the sweep must not glare more than that
    const bound = Math.min(min * DEG, r.rest);
    assert.ok(r.worst >= bound - 0.3 * DEG, `${name}: within ${deg(r.worst)} of the glaze's mirror (rest ${deg(r.rest)}, needs ${deg(bound)})`);
    assert.ok(r.lowest >= SWEEP_FLOOR - 1e-9, `${name}: lowest ${deg(r.lowest)}`);
  }
});

test('the sun never goes under the prototype\'s dip or over HIGH_MAX, for any view, even one that moves every frame', () => {
  // A random walk over everything the viewer can do (elevation 10°-85°, any azimuth, any reach)
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let run = 0; run < 40; run++) {
    const sun = new THREE.DirectionalLight(), light = createLightRig(sun);
    let el = (10 + 75 * rnd()) * DEG, az = 6.3 * rnd(), reach = 3.2 + 120 * rnd();
    light.sweep(0);
    for (let t = 0; t <= SUN.SWEEP_SECONDS + 0.1; t += F) {
      el = Math.min(85 * DEG, Math.max(10 * DEG, el + (rnd() - 0.5) * 0.08));
      az += (rnd() - 0.5) * 0.05;
      reach = Math.min(125, Math.max(3.2, reach * (1 + (rnd() - 0.5) * 0.05)));
      light.update(t, viewAt(el, az, reach * 3.7), reach);
      const e = elevOf(sun.position);
      assert.ok(e >= SWEEP_FLOOR - 1e-9 && e <= SUN.HIGH_MAX + 1e-9, `run ${run}, t ${t.toFixed(2)}: sun at ${deg(e)}`);
    }
  }
});

test('a change of side mid-sweep glides: no jump of the sun (or its shadows)', () => {
  // The sweep's own motion on a still view, for scale (~1° per frame mid-sweep)
  const still = runSweep({});
  // Worst case: the view jumps between a low (31°) and a high (65°) camera every 1.5 s, so the
  // aim flips between above and below the band at full facing too
  const sun = new THREE.DirectionalLight(), light = createLightRig(sun);
  light.sweep(0);
  let prev = null, worst = 0, flips = 0, lastSide = null;
  for (let t = 0; t <= SUN.SWEEP_SECONDS; t += F) {
    const lowNow = Math.floor(t / 1.5) % 2 === 0;
    const view = lowNow ? viewAt(31 * DEG, 0.67, 234) : viewAt(65.3 * DEG, 0.67, 213);
    light.update(t, view, 57);
    const side = sweepAim(view, 57).side;
    if (lastSide && side !== lastSide) flips++;
    lastSide = side;
    if (prev) worst = Math.max(worst, sun.position.angleTo(prev));
    prev = sun.position.clone();
  }
  assert.ok(flips >= 6, `the side flipped ${flips} times`);
  assert.ok(worst < 2.5 * DEG, `largest step ${deg(worst)} per frame (a still view: ${deg(still.maxStep)})`);
  // A real drag down to the low view while the sun is behind the panel (6 s in, over 0.4 s)
  const dragged = runSweep({ during: (t, input) => { if (t > 6 && t < 6.4) input.tilt(-2.6 * F / 0.4); } });
  assert.ok(dragged.maxStep < 2.5 * DEG, `drag: largest step ${deg(dragged.maxStep)} per frame`);
  assert.ok(dragged.lowest >= SWEEP_FLOOR - 1e-9);
  // ... and the old behaviour (side kept from the sweep's start) is gone: after the drag the
  // sun passes above the low view's band, clear of it, rather than through it at 27°
  assert.ok(dragged.highest > 60 * DEG, `highest ${deg(dragged.highest)}`);
});

test('Sweep light during the opening, then Finish: the running sweep re-aims as the camera flies out', () => {
  // The sweep starts at the low close-up (24°: it passes above the band there), then Finish
  // sends the camera up to 65° mid-sweep. Aimed once, the old rig kept "above" and put the sun
  // at 83°, in the settled view's band; re-aimed every frame it follows the camera down to 27°
  const canvas = Object.assign(new EventTarget(), { setPointerCapture() {} });
  const camera = new THREE.PerspectiveCamera(32, 1.6, 0.1, 1200);
  const rig = createCameraRig(camera, canvas);
  const sun = new THREE.DirectionalLight(), light = createLightRig(sun);
  let clock = 0, sim = 0.3, rLaid = 1;
  const frame = () => { clock += F; sim += F; rig.update(F, rLaid, sim); light.update(clock, camera.position, rig.framing * rig.zoom); };
  for (let k = 0; k < 18; k++) frame();
  light.sweep(clock);
  assert.equal(sweepAim(camera.position, rig.framing * rig.zoom).side, 'above', 'the close-up passes above');
  for (let k = 0; k < 60; k++) frame();   // 1 s into the sweep
  rLaid = 73.5; sim = 48;                 // Finish
  let worst = Math.PI, prev = null, maxStep = 0, n = 0;
  while (light.sweeping) {
    frame();
    if (prev) maxStep = Math.max(maxStep, sun.position.angleTo(prev));
    prev = sun.position.clone();
    if (rig.framing > 0.99 * FRAMING.F_MAX && ++n % 4 === 0) worst = Math.min(worst, glare(glazeMirrors(camera), sun.position));
  }
  assert.ok(n > 100, 'the camera settled with most of the sweep still to run');
  assert.ok(worst >= 20 * DEG, `within ${deg(worst)} of the glaze's mirror once the camera settled`);
  assert.ok(maxStep < 2.5 * DEG, `largest step ${deg(maxStep)} per frame`);
});

test('a second sweep while one is under way does not snap the sun back to rest', () => {
  const sun = new THREE.DirectionalLight(), light = createLightRig(sun);
  const view = viewAt(65.3 * DEG, 0.67, 213);
  light.update(0, view, 57);
  light.sweep(0);
  let prev = null, worst = 0;
  for (let t = 0; t <= SUN.SWEEP_SECONDS + 1; t += F) {
    if (Math.abs(t - 4) < F / 2) light.sweep(t);          // Sweep light pressed again, mid-sweep
    if (Math.abs(t - 6) < F / 2) light.sweep(t + 1.2);    // the automatic sweep after Finish
    light.update(t, view, 57);
    if (prev) worst = Math.max(worst, sun.position.angleTo(prev));
    prev = sun.position.clone();
  }
  assert.ok(worst < 2 * DEG, `largest step ${deg(worst)} per frame`);
  assert.equal(light.sweeping, false, 'the first sweep finished, and no other was left pending');
  // Once it has finished, the button starts a new one as before
  light.sweep(SUN.SWEEP_SECONDS + 1.5);
  light.update(SUN.SWEEP_SECONDS + 4, view, 57);
  assert.ok(light.sweeping && sun.position.angleTo(prev) > 5 * DEG);
  // A sweep scheduled but not started yet (the 1.2 s after Finish) can still be brought forward
  const l2 = createLightRig(new THREE.DirectionalLight());
  l2.update(0, view, 57); l2.sweep(1.2); l2.update(0.5, view, 57); l2.sweep(0.5); l2.update(0.6, view, 57);
  assert.ok(l2.sweeping);
});
