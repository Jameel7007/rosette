// Tests for the app wiring around the zellige pieces: the HUD's stage labels, the fitted
// shadow depth, the aimed light sweep (more in light-aim.test.mjs), the camera (reduced-motion snap, the slow turn, pinch)
// and the performance guard (pixel ratio ceiling and governor).
// Runs in Node (three.js works without a DOM). The real-browser checks are in
// scripts/verify-app.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createStageLabel, LABEL } from '../src/ui/hud.js';
import { createLightRig, sweepAim, SUN } from '../src/anim/light.js';
import { createCameraRig, FRAMING } from '../src/anim/camera.js';
import { pixelRatioCeiling, QUALITY } from '../src/scene/renderer.js';
import { createGovernor, GOVERNOR } from '../src/scene/governor.js';
import { composePanel } from '../src/pattern/compose.js';
import { makeSchedule } from '../src/anim/schedule.js';
import { TIMING } from '../src/config.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const elevOf = p => Math.atan2(p.y, Math.hypot(p.x, p.z));

// ---------- stage labels ----------

/** A tiny laid sequence: unit squares with given stages, one per second. */
function strip(stages) {
  const pieces = stages.map(stage => ({ stage, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }));
  return { pieces, t0: Float32Array.from(stages, (_, i) => i) };
}

test('stage label: null before the first piece, then the stage covering most area recently', () => {
  const { pieces, t0 } = strip(['A', 'A', 'B', 'B', 'B']);
  const at = createStageLabel(pieces, t0, { window: 1.5, hold: 1.3 });
  assert.equal(at(-0.5), null);
  assert.equal(at(0), 'A');
  assert.equal(at(1.2), 'A');
  assert.equal(at(2.2), 'A', 'a tie (one A, one B in the window) keeps the current label');
  assert.equal(at(3.2), 'B', 'two B to none: B takes over');
});

test('stage label: thin interleaved pieces do not take the label from the big ones', () => {
  // kite (area 1), strap (0.1), strap (0.1), kite, strap, strap, ... : the prototype's rule
  // ("latest piece") would flip on every piece
  const pieces = [], t0 = [];
  const sq = s => [[0, 0], [s, 0], [s, s], [0, s]];
  for (let k = 0; k < 30; k++) {
    pieces.push({ stage: k % 3 ? 'Strapwork' : 'Petal kites', poly: k % 3 ? sq(Math.sqrt(0.1)) : sq(1) });
    t0.push(k * 0.2);
  }
  const at = createStageLabel(pieces, Float32Array.from(t0));
  const seen = new Set();
  for (let t = 0.5; t < 6; t += 1 / 60) seen.add(at(t));
  assert.deepEqual([...seen], ['Petal kites']);
});

test('stage label: Replay (time going back) starts fresh', () => {
  const { pieces, t0 } = strip(['A', 'B', 'B', 'B']);
  const at = createStageLabel(pieces, t0);
  assert.equal(at(3.5), 'B');
  assert.equal(at(0.1), 'A');
});

test('stage label on the real panel: few changes, in laying order', () => {
  const { pieces } = composePanel();
  const s = makeSchedule(pieces, TIMING);
  const at = createStageLabel(s.pieces, s.t0);
  const changes = [];
  for (let t = 0; t < s.T_END + 0.1; t += 1 / 60) {
    const l = at(t);
    if (l !== changes.at(-1)?.label) changes.push({ label: l, t });
  }
  const labels = changes.map(c => c.label);
  assert.equal(labels[0], null);
  assert.equal(labels[1], 'Central 16-point star');
  assert.equal(labels.at(-1), 'Border');
  assert.ok(changes.length <= 16, `${changes.length} changes (the per-piece rule gives ~380)`);
  // Nothing flickers: every label after the first stays up for at least half a second
  for (let i = 1; i < changes.length - 1; i++) {
    assert.ok(changes[i + 1].t - changes[i].t >= 0.5, `${changes[i].label} shown for ${(changes[i + 1].t - changes[i].t).toFixed(2)} s`);
  }
  assert.ok(LABEL.WINDOW > 0 && LABEL.HOLD >= 1);
});

// ---------- shadow depth ----------

test('shadow fit: near/far hug the box along the light; bias is 0.01 world units', () => {
  const sun = new THREE.DirectionalLight();
  const light = createLightRig(sun);
  light.update(0);
  light.fitShadow(3.2, 1);
  const sc = sun.shadow.camera;
  const S = 3.2 * SUN.SHADOW_PER_F + SUN.SHADOW_PAD;
  const depth = S / Math.sin(Math.atan(SUN.REST_SLOPE)) + SUN.SHADOW_DEPTH_PAD;
  assert.ok(near(sc.near, SUN.DISTANCE - depth, 1e-9));
  assert.ok(near(sc.far, SUN.DISTANCE + depth, 1e-9));
  assert.ok(near(sun.shadow.bias * (sc.far - sc.near), -SUN.SHADOW_BIAS_WORLD, 1e-12));
  // The prototype's -0.0006 over 1..320 was ~0.19 world units, 19× this
  assert.ok(near(-0.0006 * (320 - 1), -0.1914, 1e-4));
});

test('shadow fit: the legacy build keeps the prototype numbers', () => {
  const sun = new THREE.DirectionalLight();
  const light = createLightRig(sun, { prototypeShadow: true });
  light.update(0);
  light.fitShadow(57, 1);
  assert.equal(sun.shadow.camera.near, 1);
  assert.equal(sun.shadow.camera.far, 320);
  assert.equal(sun.shadow.bias, -0.0006);
});

// ---------- the aimed sweep ----------

/** A camera position at elevation `el`, azimuth `az` (light.js convention: atan2(z, x)), distance d. */
const viewAt = (el, az, d = 200) =>
  new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(d);

/** Runs one whole sweep for a fixed view; returns the sun's lowest point and where it faces the viewer. */
function sweepFrom(view, reach) {
  const sun = new THREE.DirectionalLight();
  const light = createLightRig(sun);
  light.update(0, view, reach);
  const rest = sun.position.clone();
  light.sweep(1);
  const viewAz = Math.atan2(view.z, view.x);
  const opposite = a => Math.abs(Math.atan2(Math.sin(a - viewAz - Math.PI), Math.cos(a - viewAz - Math.PI)));
  let facing = { off: 9 }, lowest = 9, highest = -9;
  for (let t = 1; t <= 1 + SUN.SWEEP_SECONDS; t += 0.005) {
    light.update(t, view, reach);
    const el = elevOf(sun.position), off = opposite(Math.atan2(sun.position.z, sun.position.x));
    if (off < facing.off) facing = { off, el };
    lowest = Math.min(lowest, el); highest = Math.max(highest, el);
  }
  light.update(2 + SUN.SWEEP_SECONDS, view, reach);
  return { facing, lowest, highest, backAtRest: sun.position.distanceTo(rest) < 1e-9 };
}

const PROTOTYPE_DIP = Math.atan(SUN.REST_SLOPE - SUN.SWEEP_DIP);   // ≈ 26.6°

test('aimed sweep: behind the panel the sun stops GLAZE_CLEARANCE below the far edge\'s mirror height', () => {
  // A steep view (80° up, framing the whole panel): there is room below the band
  const view = viewAt(80 * Math.PI / 180, 0.48, 214), reach = 57;
  const r = sweepFrom(view, reach);
  const { far, side } = sweepAim(view, reach);
  assert.equal(side, 'below');
  // facing the viewer the sun sits ~at the aim (the ease back toward rest lifts it a little)
  assert.ok(Math.abs(r.facing.el - (far - SUN.GLAZE_CLEARANCE)) < 0.05,
    `facing the viewer at ${r.facing.el.toFixed(3)} rad, aimed ${(far - SUN.GLAZE_CLEARANCE).toFixed(3)}`);
  // and never rises above the aim (or rest, where it starts and ends)
  assert.ok(r.highest <= Math.max(Math.atan(SUN.REST_SLOPE), far - SUN.GLAZE_CLEARANCE) + 1e-9);
  assert.ok(r.lowest < PROTOTYPE_DIP + 0.12, `still drops low on the viewer's side (${r.lowest.toFixed(3)} rad)`);
  assert.ok(r.backAtRest, 'back at rest');
});

test('aimed sweep: for every view the rig allows, the sun never drops below the prototype\'s dip', () => {
  // The review found views under ~45° (the 24° opening, a low drag) sent the sun to 7° and,
  // at the lowest drag, below the horizon. Every elevation from EL_MIN to EL_MAX, all round.
  for (let el = FRAMING.EL_MIN; el <= FRAMING.EL_MAX + 1e-9; el += (FRAMING.EL_MAX - FRAMING.EL_MIN) / 12) {
    for (let az = 0; az < 2 * Math.PI; az += Math.PI / 8) {
      for (const reach of [3.2, 20, 57, 125]) {
        const r = sweepFrom(viewAt(el, az, 120), reach);
        assert.ok(r.lowest >= PROTOTYPE_DIP - 1e-6,
          `view ${(el * 180 / Math.PI).toFixed(1)}° az ${az.toFixed(2)} reach ${reach}: lowest sun ${(r.lowest * 180 / Math.PI).toFixed(1)}°`);
      }
    }
  }
});

test('aimed sweep: a low view passes ABOVE the mirror band (no 27° glare, no sinking sun)', () => {
  // The opening close-up: its mirror band (~19-36°) holds the prototype's 27° dip, which
  // washed the glaze out, and dipping under it sent the sun toward the horizon
  const view = viewAt(0.42, 1.0, 12), reach = 3.2;
  const r = sweepFrom(view, reach);
  const { near, side } = sweepAim(view, reach);
  assert.equal(side, 'above');
  assert.ok(Math.abs(r.facing.el - (near + SUN.GLAZE_CLEARANCE)) < 0.05,
    `facing at ${r.facing.el.toFixed(3)} rad, aimed above the near edge's mirror at ${(near + SUN.GLAZE_CLEARANCE).toFixed(3)}`);
  assert.ok(r.lowest >= PROTOTYPE_DIP - 1e-9);
});

test('aimed sweep: the sun never jumps, even while the camera flies out mid-sweep', () => {
  // After an early Finish the camera rises from the close-up while the sweep runs
  const sun = new THREE.DirectionalLight(), light = createLightRig(sun);
  light.sweep(0);
  let prev = null, worst = 0;
  for (let t = 0; t <= SUN.SWEEP_SECONDS; t += 1 / 60) {
    const k = Math.min(1, t / 4);                    // 24° → 65° over 4 s, framing 3.2 → 57
    light.update(t, viewAt(0.42 + 0.72 * k, 0.6, 12 + 200 * k), 3.2 + 53.8 * k);
    if (prev) worst = Math.max(worst, sun.position.distanceTo(prev) / SUN.DISTANCE);
    prev = sun.position.clone();
  }
  assert.ok(worst < 0.05, `largest step ${worst.toFixed(4)} rad-ish per frame`);
});

// ---------- camera ----------

test('camera snap: reduced motion frames the finished panel at once', () => {
  const canvas = Object.assign(new EventTarget(), { setPointerCapture() {} });
  const camera = new THREE.PerspectiveCamera(32, 1.6, 0.1, 1200);
  const rig = createCameraRig(camera, canvas);
  rig.snap(73.5);
  rig.update(1 / 60, 73.5, 48);
  assert.ok(near(rig.framing, FRAMING.F_MAX, 1e-9), 'no easing from the close-up');
});

test('camera: the drag can reach straight overhead (within a degree)', () => {
  assert.ok(FRAMING.EL_MAX > (89 * Math.PI) / 180 && FRAMING.EL_MAX < Math.PI / 2);
});

const fakeCanvas = () => Object.assign(new EventTarget(), { setPointerCapture() {} });
const pointer = (type, id, x, y) => Object.assign(new Event(type), { clientX: x, clientY: y, pointerId: id });
const azOf = p => Math.atan2(p.x, p.z);

test('camera: Finish and Replay do not snap the slow turn round', () => {
  const camera = new THREE.PerspectiveCamera(32, 1.6, 0.1, 1200);
  const rig = createCameraRig(camera, fakeCanvas());
  rig.snap(30);   // framing settled, so only the slow turn moves the azimuth
  let sim = 0;
  for (let i = 0; i < 600; i++) rig.update(1 / 60, 30, (sim += 1 / 60));   // 10 s of laying
  const before = azOf(camera.position);
  rig.update(1 / 60, 30, 47.46);   // Finish: sim jumps ~37 s ahead
  assert.ok(Math.abs(azOf(camera.position) - before) < 0.001, `Finish turned the view ${(azOf(camera.position) - before).toFixed(4)} rad`);
  rig.update(1 / 60, 30, 0);       // Replay: back to 0
  assert.ok(Math.abs(azOf(camera.position) - before) < 0.001, 'Replay does not turn it back');
  // Normal play still turns at AZ_DRIFT per sim second (the prototype's rate)
  const a0 = azOf(camera.position);
  sim = 0;
  for (let i = 0; i < 60; i++) rig.update(1 / 60, 30, (sim += 4 / 60));   // 1 s at 4×
  assert.ok(Math.abs(azOf(camera.position) - a0 - 4 * FRAMING.AZ_DRIFT) < 1e-6);
});

test('camera: with drift off (reduced motion) the finished view holds still', () => {
  const camera = new THREE.PerspectiveCamera(32, 1.6, 0.1, 1200);
  const rig = createCameraRig(camera, fakeCanvas(), { drift: false });
  rig.snap(73.5);
  rig.update(1 / 60, 73.5, 47.5);
  const p = camera.position.clone();
  for (let i = 0, sim = 47.5; i < 600; i++) rig.update(1 / 60, 73.5, (sim += 1 / 60));
  assert.ok(camera.position.distanceTo(p) < 1e-9);
});

test('camera: two fingers pinch to zoom, one finger still turns', () => {
  const camera = new THREE.PerspectiveCamera(32, 0.46, 0.1, 1200);
  const canvas = fakeCanvas();
  const rig = createCameraRig(camera, canvas);
  rig.snap(60);
  rig.update(1 / 60, 60, 10);
  const az0 = azOf(camera.position);
  canvas.dispatchEvent(pointer('pointerdown', 1, 150, 400));
  canvas.dispatchEvent(pointer('pointerdown', 2, 250, 400));   // spread 100
  canvas.dispatchEvent(pointer('pointermove', 1, 100, 400));
  canvas.dispatchEvent(pointer('pointermove', 2, 300, 400));   // spread 200: fingers apart
  assert.ok(Math.abs(rig.zoom - 0.5) < 1e-9, `zoom ${rig.zoom}`);
  rig.update(1 / 60, 60, 10);
  assert.ok(Math.abs(azOf(camera.position) - az0) < 1e-9, 'a symmetric pinch does not turn the view');
  canvas.dispatchEvent(pointer('pointerup', 2, 300, 400));
  canvas.dispatchEvent(pointer('pointermove', 1, 60, 400));    // the remaining finger turns, from where it is
  rig.update(1 / 60, 60, 10);
  assert.ok(Math.abs(azOf(camera.position) - az0) > 0.1, 'one finger turns the view again');
  assert.ok(Math.abs(rig.zoom - 0.5) < 1e-9, 'and leaves the zoom alone');
});

// ---------- pixel ratio and the performance guard ----------

test('pixel ratio ceiling: 2 at most, and no more than ~5 Mpx in all', () => {
  assert.equal(pixelRatioCeiling(2, 1280, 800), 2);                  // 4.1 Mpx
  assert.ok(near(pixelRatioCeiling(2, 1920, 1080), Math.sqrt(QUALITY.MAX_PIXELS / (1920 * 1080))));
  assert.equal(pixelRatioCeiling(3, 390, 844), 2);
  assert.equal(pixelRatioCeiling(1, 3840, 2160), 1, 'never below 1 for the ceiling');
  assert.equal(pixelRatioCeiling(0.8, 1280, 800), 0.8, 'a zoomed-out browser keeps its own ratio');
});

test('governor: steps down after 2 s of slow frames, not for a short hitch, never below 1', () => {
  const applied = [];
  const g = createGovernor({ ceiling: 2, apply: r => applied.push(r) });
  for (let i = 0; i < 300; i++) g.frame(i % 50 === 0 ? 90 : 16.7);   // 60 fps with hitches
  assert.deepEqual(applied, [], 'steady 60 fps with occasional hitches keeps the ratio');
  for (let i = 0; i < 160; i++) g.frame(20);                        // 50 fps for 3.2 s
  assert.deepEqual(applied, [1.75]);
  for (let i = 0; i < 2000; i++) g.frame(25);
  assert.equal(g.ratio, GOVERNOR.MIN_RATIO);
  assert.equal(applied.at(-1), 1);
});

test('governor: steps back up with room to spare, but not to a ratio that was too slow', () => {
  const g = createGovernor({ ceiling: 2, apply: () => {} });
  for (let i = 0; i < 200; i++) g.frame(25);                        // too slow at 2
  assert.equal(g.ratio, 1.75);
  for (let i = 0; i < 1000; i++) g.frame(8.3);                      // 120 fps for 8 s
  assert.equal(g.ratio, 1.75, '2 proved too slow: it is not tried again soon');
  for (let i = 0; i < 3000; i++) g.frame(8.3);                      // ... until 30 s of room to spare
  assert.equal(g.ratio, 2, 'then it is forgiven and tried again');
  for (let i = 0; i < 200; i++) g.frame(25);                        // still too slow: back down
  assert.equal(g.ratio, 1.75);
  g.reset(2);                                                       // a resize starts over
  assert.equal(g.ratio, 2);
  // A step needs the window full (30 frames) and then 2 s of slow frames: 30 + 80 at 25 ms
  const h = createGovernor({ ceiling: 2, apply: () => {} });
  for (let i = 0; i < 2 * 110; i++) h.frame(25);
  assert.equal(h.ratio, 1.5);
  for (let i = 0; i < 1000; i++) h.frame(8.3);
  assert.equal(h.ratio, 1.5, 'not back to 1.75 soon either: it proved too slow too');
  for (let i = 0; i < 1000; i++) h.frame(1000);                     // a hidden tab: ignored
  assert.equal(h.ratio, 1.5);
});
