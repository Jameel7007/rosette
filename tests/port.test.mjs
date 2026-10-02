// Tests for the prototype port: the legacy pattern, the sinopia drawing, the legacy tile
// system's interface (docs/CONTRACTS.md §4.3), and the camera and light rigs.
// Runs in Node: three.js itself works without a DOM; only canvases and WebGL are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

import { colorAt, starR, rosette, field, L, legacySinopia } from '../src/legacy/pattern.js';
import { createLegacyTiles } from '../src/legacy/tiles.js';
import { drawSinopia } from '../src/scene/bed.js';
import { rawHex } from '../src/scene/renderer.js';
import { createCameraRig, FRAMING, portraitFactor } from '../src/anim/camera.js';
import { createLightRig, SUN } from '../src/anim/light.js';
import { mulberry, SEED } from '../src/util/rand.js';
import { PAL } from '../src/pattern/palette.js';

const TAU = Math.PI * 2;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------- legacy pattern ----------

test('legacy pattern is pure JS (no three.js import)', () => {
  const src = readFileSync(new URL('../src/legacy/pattern.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]three/);
});

test('starR: points at Ro, inner corners at Ri, 8-fold and mirror symmetric', () => {
  assert.ok(near(starR(0, 10.9, 6.3, 8), 10.9));
  assert.ok(near(starR(TAU / 16, 10.9, 6.3, 8), 6.3));
  for (const th of [0.1, 0.33, 1.7, -2.2]) {
    assert.ok(near(starR(th, 10.9, 6.3, 8), starR(th + TAU / 8, 10.9, 6.3, 8), 1e-9), 'rotational');
    assert.ok(near(starR(th, 10.9, 6.3, 8), starR(-th, 10.9, 6.3, 8), 1e-9), 'mirror');
  }
});

test('colorAt: the prototype zones', () => {
  assert.deepEqual(colorAt(0, 0), ['W', 'The center point']);
  assert.deepEqual(colorAt(1.2, 0), ['K', 'The center point']);
  assert.deepEqual(colorAt(0, 2.3), ['A', 'First gold ring']);
  assert.deepEqual(colorAt(4, 0), ['T', 'Eight-point star']);    // turquoise core
  assert.deepEqual(colorAt(8, 0), ['B', 'Eight-point star']);    // lapis along a star point
  assert.deepEqual(colorAt(12.5, 0), ['A', 'Framing rings']);
  assert.deepEqual(colorAt(26.5, 0), ['A', 'Outer rings']);
  assert.deepEqual(colorAt(L * 3.5, L * 3.5), ['O', 'Star-and-cross field']);  // a cross centre
  assert.deepEqual(colorAt(51.5, 0), ['A', 'Border']);           // gold edge
  assert.deepEqual(colorAt(48.5, 48.5), ['A', 'Border']);        // gold corner square
  assert.deepEqual(colorAt(48, 46.5), ['K', 'Border']);
});

test('colorAt: the medallion is 8-fold symmetric (rotation by 45° and mirror)', () => {
  const rand = mulberry(7);
  for (let i = 0; i < 2000; i++) {
    const r = 0.8 + rand() * 30, th = rand() * TAU;
    const key = rosette(r, th)[0];
    assert.equal(rosette(r, th + TAU / 8)[0], key, `rotation at r=${r.toFixed(2)}`);
    assert.equal(rosette(r, -th)[0], key, `mirror at r=${r.toFixed(2)}`);
  }
});

test('field: stars alternate lapis / turquoise from cell to cell', () => {
  assert.notEqual(field(L * 4, 0)[0], field(L * 4, L)[0]);
  assert.ok(['B', 'T'].includes(field(L * 4, 0)[0]));
});

test('legacySinopia: the prototype lines', () => {
  const s = legacySinopia();
  assert.deepEqual(s.circles.map(c => c.r), [3, 11, 14, 22, 25, 29, 31]);
  assert.deepEqual(s.rects.map(r => r.max[0]), [46, 52]);
  assert.equal(s.polylines.length, 1 + 8 + 9);          // star, 8 spokes, 9 lattice strokes
  const star = s.polylines[0].pts;
  assert.equal(star.length, 721);
  assert.ok(near(star[0][0], star[720][0], 1e-9) && near(star[0][1], star[720][1], 1e-9));
  for (const pl of s.polylines.slice(9)) assert.equal(pl.paths.length, 2);  // vertical + horizontal in one stroke
});

// ---------- sinopia drawing ----------

/** A 2D-context stand-in that records what was drawn. */
function recorder() {
  const calls = [];
  const g = {
    save() {}, restore() {},
    beginPath() { calls.push(['begin']); },
    closePath() { calls.push(['close']); },
    moveTo(x, y) { calls.push(['move', x, y]); },
    lineTo(x, y) { calls.push(['line', x, y]); },
    arc(x, y, r) { calls.push(['arc', x, y, r]); },
    stroke() { calls.push(['stroke', this.strokeStyle, this.lineWidth]); },
    strokeRect(x, y, w, h) { calls.push(['rect', x, y, w, h, this.strokeStyle, this.lineWidth]); },
  };
  return { g, calls };
}

test('drawSinopia maps pattern units to canvas pixels', () => {
  const { g, calls } = recorder();
  const spec = {
    color: [160, 62, 40],
    circles: [{ r: 3, width: 0.2, alpha: 0.72 }],
    rects: [{ min: [-46, -46], max: [46, 46], width: 0.2, alpha: 0.72 }],
    polylines: [
      { pts: [[0, 0], [10, 5]], width: 0.09, alpha: 0.38 },
      { paths: [[[1, -2], [1, 2]], [[-2, 1], [2, 1]]], width: 0.09, alpha: 0.38 },
      { pts: [[0, 0], [1, 0], [1, 1]], width: 0.1, alpha: 0.5, closed: true },
    ],
  };
  drawSinopia(g, spec, { size: 1140, ext: 114 });   // 10 px per unit, origin at pixel 570
  assert.deepEqual(calls[1], ['arc', 570, 570, 30]);
  assert.deepEqual(calls[2], ['stroke', 'rgba(160,62,40,0.72)', 2]);
  assert.deepEqual(calls[3], ['rect', 110, 110, 920, 920, 'rgba(160,62,40,0.72)', 2]);
  assert.deepEqual(calls.slice(4, 7), [['begin'], ['move', 570, 570], ['line', 670, 620]]);
  assert.equal(calls[7][1], 'rgba(160,62,40,0.38)');
  assert.ok(near(calls[7][2], 0.9), 'width 0.09 units = 0.9 px');
  // two sub-paths, one stroke (so their crossing is not drawn twice)
  const multi = calls.slice(8, 14);
  assert.deepEqual(multi.map(c => c[0]), ['begin', 'move', 'line', 'move', 'line', 'stroke']);
  assert.ok(calls.some(c => c[0] === 'close'));
});

test('rawHex reads a hex number as linear, like r128 did', () => {
  const c = rawHex(0x4c4337);
  assert.ok(near(c.r, 0x4c / 255) && near(c.g, 0x43 / 255) && near(c.b, 0x37 / 255));
  // whereas a plain Color(hex) decodes sRGB → linear (much darker)
  assert.ok(new THREE.Color(0x4c4337).r < c.r / 3);
});

// ---------- legacy tile system ----------

// Built once: ~10.7k tiles with real ExtrudeGeometry and InstancedMesh, no renderer needed
const scene = new THREE.Scene();
const tiles = createLegacyTiles(scene, { rand: mulberry(SEED), envMap: null });
const { T_START, T_SPAN, P_EXP, D } = { T_START: 0.9, T_SPAN: 46, P_EXP: 0.42, D: 0.55 };

test('legacy tiles implement the CONTRACTS §4.3 interface', () => {
  for (const k of ['update', 'startedAt', 'landedAt', 'stageAt', 'rLaidAt', 'reset']) assert.equal(typeof tiles[k], 'function', k);
  assert.equal(tiles.count, 10665);   // the brief's count
  assert.ok(near(tiles.T_END, T_START + T_SPAN * Math.pow((tiles.count - 1) / tiles.count, P_EXP) + D, 1e-9));
  // Centre rings of 1, 8, 16, 24 and 32 cut pieces (the brief's "57" leaves out the 24 ring)
  assert.equal(tiles.stats.custom, 81);
});

test('startedAt / landedAt match a brute-force count of the schedule', () => {
  const N = tiles.count;
  const t0 = i => T_START + T_SPAN * Math.pow(i / N, P_EXP);
  for (const sim of [0, 0.9, 1.0, 1.45, 3.3, 12, 30.5, 47, tiles.T_END + 0.01, 100]) {
    let started = 0, landed = 0;
    for (let i = 0; i < N; i++) { if (t0(i) <= sim) started++; if ((sim - t0(i)) / D >= 1) landed++; }
    assert.equal(tiles.startedAt(sim), started, `started at ${sim}`);
    assert.equal(tiles.landedAt(sim), landed, `landed at ${sim}`);
  }
  assert.equal(tiles.landedAt(tiles.T_END + 0.01), N);   // what Finish jumps to
});

test('stageAt and rLaidAt follow the laying order', () => {
  assert.equal(tiles.stageAt(0), null);
  assert.equal(tiles.rLaidAt(0), 0);
  assert.equal(tiles.stageAt(1), 'The center point');
  let prev = 0;
  for (let sim = 0; sim < 50; sim += 0.25) {
    const r = tiles.rLaidAt(sim);
    assert.ok(r >= prev, 'rLaid never shrinks');
    prev = r;
  }
  assert.ok(prev > 72 && prev < 73.5, `the corner tiles are about 72.8 out (got ${prev})`);
  assert.equal(tiles.stageAt(12), 'Eight-point star');
});

test('update poses tiles from sim; reset hides them; going back in time re-lays', () => {
  const ims = scene.children.filter(o => o.isInstancedMesh);
  const customs = scene.children.filter(o => o.isMesh && !o.isInstancedMesh);
  const m = new THREE.Matrix4(), scale = new THREE.Vector3();
  const shown = () => ims.reduce((n, im) => {
    for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); scale.setFromMatrixScale(m); if (scale.y > 0) n++; }
    return n;
  }, 0) + customs.filter(c => c.visible).length;

  assert.equal(shown(), 0);
  tiles.update(12);
  assert.equal(shown(), tiles.startedAt(12));
  tiles.update(tiles.T_END + 0.01);
  assert.equal(shown(), tiles.count);
  tiles.update(12);                       // a backward seek
  assert.equal(shown(), tiles.startedAt(12));
  tiles.reset();
  assert.equal(shown(), 0);
});

test('glaze colours are jittered in sRGB HSL around the palette (as the prototype did)', () => {
  const im = scene.children.find(o => o.isInstancedMesh && o.material.metalness === 0);
  const c = new THREE.Color(), hsl = {}, base = {};
  const lightJitter = { K: 0.035, W: 0.045 };
  // Keys aren't stored on the mesh, so match each colour to the nearest palette entry in sRGB
  const palette = Object.entries(PAL).filter(([k]) => k !== 'A').map(([k, hex]) => [k, new THREE.Color(hex).getHSL({}, THREE.SRGBColorSpace)]);
  for (let i = 0; i < im.count; i += 37) {
    c.fromArray(im.instanceColor.array, i * 3).getHSL(hsl, THREE.SRGBColorSpace);
    const [key, b] = palette.reduce((best, p) => {
      const d = Math.abs(p[1].l - hsl.l) + Math.abs(p[1].s - hsl.s) + Math.min(Math.abs(p[1].h - hsl.h), 1 - Math.abs(p[1].h - hsl.h));
      return d < best[2] ? [p[0], p[1], d] : best;
    }, [null, null, Infinity]);
    Object.assign(base, b);
    const lj = lightJitter[key] ?? 0.07;
    assert.ok(Math.abs(hsl.l - base.l) <= lj + 1e-6, `${key}: lightness ${hsl.l.toFixed(3)} vs ${base.l.toFixed(3)} ± ${lj}`);
  }
});

// ---------- camera and light ----------

function fakeCanvas() {
  const t = new EventTarget();
  t.setPointerCapture = () => {};
  return t;
}
const pointer = (type, x, y) => Object.assign(new Event(type), { clientX: x, clientY: y, pointerId: 1 });

test('camera rig: opening close-up, framing eases out, drag / wheel / double-click', () => {
  const camera = new THREE.PerspectiveCamera(32, 1.6, 0.1, 1200);
  const canvas = fakeCanvas();
  const rig = createCameraRig(camera, canvas);
  rig.update(1 / 60, 0, 0);
  const el0 = Math.asin(camera.position.y / camera.position.length());
  assert.ok(near(el0, FRAMING.EL0, 1e-6), 'starts at the low close-up elevation');
  const d0 = camera.position.length();

  for (let i = 0; i < 600; i++) rig.update(1 / 60, 60, 10);     // fully laid: framing eases out
  assert.ok(near(rig.framing, FRAMING.F_MAX, 0.01));
  const wide = camera.position.clone();
  assert.ok(wide.length() > 10 * d0);

  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  canvas.dispatchEvent(pointer('pointermove', 40, 140));
  canvas.dispatchEvent(pointer('pointerup', 40, 140));
  rig.update(1 / 60, 60, 10);
  assert.ok(camera.position.distanceTo(wide) > 1, 'drag turns the view');

  const wheel = Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 400 });
  canvas.dispatchEvent(wheel);
  assert.ok(wheel.defaultPrevented, 'wheel does not scroll the page');
  assert.ok(near(rig.zoom, Math.exp(0.4), 1e-9));
  for (let i = 0; i < 50; i++) canvas.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 400 }));
  assert.equal(rig.zoom, 2.2, 'zoom is clamped');

  canvas.dispatchEvent(new Event('dblclick'));
  rig.update(1 / 60, 60, 10);
  assert.ok(camera.position.distanceTo(wide) < 0.01, 'double-click resets the view');
  rig.dispose();
});

test('portraitFactor: 1 on landscape, 1/aspect on portrait (capped)', () => {
  assert.equal(portraitFactor(1.6), 1);
  assert.equal(portraitFactor(1), 1);
  assert.ok(near(portraitFactor(390 / 844), 844 / 390));
  assert.ok(near(portraitFactor(0.3), 1 / FRAMING.PORTRAIT_MIN_ASPECT));
});

test('light rig: rest position, an 11 s sweep that dips low, shadow box follows framing', () => {
  const sun = new THREE.DirectionalLight();
  const light = createLightRig(sun);
  light.update(0);
  const elev = p => Math.atan2(p.y, Math.hypot(p.x, p.z));
  assert.ok(near(elev(sun.position), Math.atan(SUN.REST_SLOPE), 1e-9));
  const rest = sun.position.clone();

  light.sweep(10);
  light.update(9);
  assert.ok(sun.position.distanceTo(rest) < 1e-9, 'nothing happens before the start time');
  light.update(10 + SUN.SWEEP_SECONDS / 2);
  assert.ok(near(elev(sun.position), Math.atan(SUN.REST_SLOPE - SUN.SWEEP_DIP), 1e-9), 'lowest mid-sweep');
  assert.ok(near(Math.atan2(sun.position.z, sun.position.x), SUN.REST_ANGLE + Math.PI, 1e-9), 'half way round');
  light.update(10 + SUN.SWEEP_SECONDS + 0.01);
  assert.equal(light.sweeping, false);
  assert.ok(sun.position.distanceTo(rest) < 1e-9, 'back at rest');

  light.fitShadow(3.2, 1);
  assert.ok(near(sun.shadow.camera.right, 3.2 * 1.5 + 3));
  light.fitShadow(57, 2);
  assert.equal(sun.shadow.camera.right, 140);   // capped at 70, then × zoom
});
