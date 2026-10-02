// Dev harness for the GPU zellige build (scene/pieces.js + anim/schedule.js).
// Self-contained on purpose: a flat mortar plane, the prototype's sun / hemisphere / PMREM
// environment, and ~12,000 synthetic pieces of mixed shapes, so the piece pipeline can be
// looked at and measured without the rest of the app.

import * as THREE from 'three';
import { makeSchedule, dropPhase } from '../src/anim/schedule.js';
import { createPieces, makeTileSystem, PIECE_LOOK } from '../src/scene/pieces.js';
import { buildSlabs } from '../src/scene/extrude.js';
import { stream, jitter } from '../src/util/rand.js';
import { TIMING, PIECE } from '../src/config.js';

const params = new URLSearchParams(location.search);
const num = (key, fallback) => (params.has(key) ? Number(params.get(key)) : fallback);
const VIEW = params.get('view') ?? 'auto';
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ renderer, scene, light

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoftShadowMap is gone in r186

const scene = new THREE.Scene();
scene.background = new THREE.Color('#5d564c');
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1200);

/** The prototype's made-up room: a warm gradient sphere and three bright "windows", via PMREM. */
function makeEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer), room = new THREE.Scene();
  const sphere = new THREE.SphereGeometry(40, 32, 16), pos = sphere.attributes.position, cols = [];
  const lo = new THREE.Color(0.16, 0.13, 0.10), hi = new THREE.Color(0.85, 0.80, 0.72), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 40;
    c.copy(lo).lerp(hi, Math.min(1, Math.max(0, (y + 0.15) * 1.3)));
    cols.push(c.r, c.g, c.b);
  }
  sphere.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  room.add(new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));
  const panel = (w, h, x, y, z, k) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k * 0.94, k * 0.84), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m);
  };
  panel(22, 12, -18, 26, 14, 7); panel(10, 30, 24, 14, -10, 3); panel(30, 6, 0, 34, -20, 2.5);
  const texture = pmrem.fromScene(room, 0.03).texture;
  pmrem.dispose();
  return texture;
}
const envMap = makeEnvironment();

// r186 lighting is physically based: the prototype's intensities × π.
const hemi = new THREE.HemisphereLight(0xfff3e2, 0x4c4337, 0.45 * Math.PI);
const sun = new THREE.DirectionalLight(0xfff0d6, 1.9 * Math.PI);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.03;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 320;
scene.add(hemi, sun, sun.target);

const bed = new THREE.Mesh(new THREE.PlaneGeometry(180, 180),
  new THREE.MeshStandardMaterial({ color: '#bdb3a3', roughness: 0.95, metalness: 0, envMap, envMapIntensity: 0.35 }));
bed.rotation.x = -Math.PI / 2;
bed.receiveShadow = true;
scene.add(bed);

// ------------------------------------------------------------------ synthetic pieces

function star(cx, cy, tip, notch, rot = 0) {
  return Array.from({ length: 16 }, (_, k) => {
    const a = rot + k * Math.PI / 8, r = k % 2 ? notch : tip;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}
function regular(cx, cy, R, n, rot = 0) {
  return Array.from({ length: n }, (_, k) => [cx + R * Math.cos(rot + k * TAU / n), cy + R * Math.sin(rot + k * TAU / n)]);
}
/** A strap: a parallelogram with 45° ends (bottom edge `len`, width `w`), centred, rotated. */
function strap(cx, cy, len, w, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [[-len / 2 - w / 2, -w / 2], [len / 2 - w / 2, -w / 2], [len / 2 + w / 2, w / 2], [-len / 2 + w / 2, w / 2]]
    .map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

/**
 * About `count` pieces on a grid of 2×2-unit blocks: big 8-point stars, bundles of thin
 * straps, hexagons, squares, small stars. 0.14 gaps, slight wobble, ~10% gold,
 * laid in order of distance from the centre.
 */
function synthPieces(count, rand) {
  const rs = jitter(rand);
  const goldShare = num('goldShare', 0.10);
  // Gold first, then the glazes in rough zellige proportions (cream and black dominate).
  const glazes = [['W', 0.24], ['K', 0.20], ['B', 0.16], ['T', 0.13], ['G', 0.11], ['O', 0.09], ['R', 0.07]];
  const keyOf = () => {
    if (rand() < goldShare) return 'A';
    let x = rand();
    for (const [key, share] of glazes) { if ((x -= share) < 0) return key; }
    return 'W';
  };
  const wobble = poly => poly.map(([x, y]) => [x + rs(0.02), y + rs(0.02)]);
  const all = [];
  const add = (poly, key) => {
    poly = wobble(poly);
    let a = 0, cx = 0, cy = 0, r = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], c = p[0] * q[1] - q[0] * p[1];
      a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
      r = Math.max(r, Math.hypot(p[0], p[1]));
    }
    cx /= 3 * a; cy /= 3 * a;
    const rc = Math.hypot(cx, cy);
    const stage = rc < 6 ? 'Centre' : rc < 20 ? 'Inner field' : rc < 40 ? 'Middle field' : 'Outer field';
    all.push({ poly, key, stage, kind: 'fill', seq: rc + rand() * 0.6, cx, cy, rc, r, ang: Math.atan2(cy, cx) });
  };

  const HALF = 30;   // blocks per half-side: ±60 units, trimmed to `count` by distance below
  for (let i = -HALF; i < HALF; i++) {
    for (let j = -HALF; j < HALF; j++) {
      const bx = 2 * i + 1, by = 2 * j + 1, key = keyOf(), kind = rand(), turn = (i + j) & 1;
      const cells = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
      if (kind < 0.12) {
        add(star(bx, by, 0.93, 0.93 * 0.95 / 1.75, turn * Math.PI / 8), key);
      } else if (kind < 0.42) {
        for (const off of [-0.66, -0.22, 0.22, 0.66]) {
          add(turn ? strap(bx + off, by, 1.2, 0.3, Math.PI / 2) : strap(bx, by + off, 1.2, 0.3, 0), key);
        }
      } else if (kind < 0.64) {
        for (const [dx, dy] of cells) add(regular(bx + dx, by + dy, 0.43, 6, turn * Math.PI / 6), key);
      } else if (kind < 0.84) {
        for (const [dx, dy] of cells) add(regular(bx + dx, by + dy, 0.43 * Math.SQRT2, 4, Math.PI / 4 + rs(0.03)), key);
      } else if (kind < 0.92) {
        for (const [dx, dy] of cells) add(star(bx + dx, by + dy, 0.43, 0.43 * 0.95 / 1.75), key);
      } else {
        add(regular(bx - 0.5, by - 0.5, 0.43 * Math.SQRT2, 4, Math.PI / 4), keyOf());
        add(regular(bx + 0.5, by - 0.5, 0.43, 6), keyOf());
        add(star(bx - 0.5, by + 0.5, 0.43, 0.233), keyOf());
        add(regular(bx + 0.5, by + 0.5, 0.43 * Math.SQRT2, 4, Math.PI / 4), keyOf());
      }
    }
  }
  all.sort((a, b) => a.seq - b.seq);
  return all.slice(0, count);
}

// ------------------------------------------------------------------ the system under test

const buildStart = performance.now();
const synth = synthPieces(num('n', 12000), stream('dev-pieces'));
const synthMs = performance.now() - buildStart;
const schedule = makeSchedule(synth, TIMING);
const pieces = createPieces(schedule, { envMap, rand: stream('pieces') });
if (params.has('ripple')) pieces.uniforms.uRipple.value = num('ripple', PIECE_LOOK.RIPPLE);
scene.add(pieces.group);
const tiles = makeTileSystem(schedule, pieces);
const stats = { ...pieces.stats, synthMs: Math.round(synthMs), totalBuildMs: Math.round(performance.now() - buildStart), T_END: +tiles.T_END.toFixed(2) };

// ------------------------------------------------------------------ camera and sun

let sim = num('t', 0), paused = params.get('pause') === '1';
const speed = num('speed', 1);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const target = new THREE.Vector3();

// Sun direction: the prototype's resting sun unless ?sunAz / ?sunEl (degrees) say otherwise.
let sunAz = params.has('sunAz') ? num('sunAz', 0) * Math.PI / 180 : -0.75;
let sunEl = params.has('sunEl') ? num('sunEl', 0) * Math.PI / 180 : Math.atan(1.25);

// Shadow depth bias in WORLD units. three's shadow.bias is in normalised depth, so the
// prototype's -0.0006 over a near 1 / far 320 shadow camera meant ~0.19 world units: enough to
// lift a 0.38-high piece's shadow off its own base. Here near/far hug the shadow box instead.
// ?bias=proto restores the prototype's numbers for comparison.
const BIAS_WORLD = params.get('bias') === 'proto' ? null : num('bias', 0.01);

function aimSun(halfSize) {
  const d = new THREE.Vector3(Math.cos(sunAz) * Math.cos(sunEl), Math.sin(sunEl), Math.sin(sunAz) * Math.cos(sunEl));
  const SUN_DISTANCE = 100;
  sun.position.copy(target).addScaledVector(d, SUN_DISTANCE);
  sun.target.position.copy(target);
  const sc = sun.shadow.camera;
  sc.left = -halfSize; sc.right = halfSize; sc.top = halfSize; sc.bottom = -halfSize;
  if (BIAS_WORLD === null) {
    sc.near = 1; sc.far = 320; sun.shadow.bias = -0.0006;
  } else {
    // The flat bed seen along a low sun stretches out in depth: a box ±halfSize across
    // holds bed up to halfSize / sin(elevation) away along the light.
    const depth = halfSize / Math.max(Math.sin(sunEl), 0.15) + 10;
    sc.near = SUN_DISTANCE - depth; sc.far = SUN_DISTANCE + depth;
    sun.shadow.bias = -BIAS_WORLD / (sc.far - sc.near);
  }
  sc.updateProjectionMatrix();   // a few multiplies; cheaper than tracking what changed
}

let framing = 3.2;   // the prototype's eased framing radius (Fs)
const framingFor = s => Math.min(66, Math.max(3.2, tiles.rLaidAt(s) * 1.12 + 2.4));
framing = framingFor(sim);

function updateCamera(dt) {
  if (VIEW === 'top') {
    target.set(0, 0, 0);
    camera.up.set(0, 0, -1);
    camera.position.set(0, 64 / Math.tan(camera.fov * Math.PI / 360) / Math.min(1, camera.aspect), 0.001);
    camera.lookAt(target);
    aimSun(70);
  } else if (VIEW === 'low') {
    // Low (24°, the prototype's opening elevation) and close, just outside the growing front:
    // landed pieces behind, pieces falling into the empty mortar in front, with their shadows.
    // rLaidAt is the farthest vertex laid so far; the falling pieces sit about a unit inside it.
    // a = 2.4 rad: the side of the front where the resting sun throws shadows outward, onto bare mortar.
    const a = 2.4, rFront = Math.max(2, tiles.rLaidAt(sim) - 1.2);
    target.set(Math.cos(a) * rFront, 0.9, Math.sin(a) * rFront);
    const around = a + 0.7, dist = 12, el = 0.4;
    camera.position.set(target.x + dist * Math.cos(el) * Math.cos(around), target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.sin(around));
    camera.lookAt(target);
    aimSun(16);
  } else if (VIEW === 'close') {
    // A few finished pieces filling the frame, to judge the bevel, glaze ripple and reflections.
    target.set(num('cx', 8), 0.2, num('cz', 5));
    const around = num('camAz', 40) * Math.PI / 180, dist = num('dist', 6), el = num('camEl', 32) * Math.PI / 180;
    camera.position.set(target.x + dist * Math.cos(el) * Math.cos(around), target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.sin(around));
    camera.lookAt(target);
    aimSun(12);
  } else if (VIEW === 'gold') {
    // A wide three-quarter view of the finished field, for glints under a low sun:
    // put the sun opposite the camera (?sunAz ≈ camera azimuth − 180°) at a similar height.
    const az = num('camAz', 120) * Math.PI / 180, el = num('camEl', 30) * Math.PI / 180, dist = num('dist', 40);
    target.set(num('cx', 0), 0, num('cz', 0));
    camera.position.set(target.x + dist * Math.cos(el) * Math.cos(az), dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.sin(az));
    camera.lookAt(target);
    aimSun(40);
  } else {
    // The prototype's automatic path: frame the laid radius, rise and turn as it grows.
    framing += (framingFor(sim) - framing) * Math.min(1, dt * 1.1);
    const k = smooth(3.2, 66, framing);
    const el = Math.min(1.45, Math.max(0.2, 0.42 + 0.72 * k));
    const az = 0.55 + 0.35 * k + sim * 0.004;
    let d = framing / Math.tan(camera.fov * Math.PI / 360) * 1.05;
    if (camera.aspect < 1) d /= Math.max(camera.aspect, 0.45);
    d *= 1.25 - 0.25 * Math.sin(el);
    target.set(0, 0, 0);
    camera.position.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
    camera.lookAt(target);
    aimSun(Math.min(70, framing * 1.5 + 3));
  }
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ loop, fps, hooks

const info = document.getElementById('info');
const frameStamps = [];
let prev = performance.now(), lastInfo = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  frameStamps.push(now);
  if (frameStamps.length > 121) frameStamps.shift();
  if (!paused) sim += dt * speed;
  tiles.update(sim);                 // ← the whole per-frame cost of the pieces: one uniform
  updateCamera(dt);
  renderer.render(scene, camera);
  if (now - lastInfo > 250) { lastInfo = now; showInfo(); }
  requestAnimationFrame(frame);
}

const fps = () => frameStamps.length < 2 ? 0
  : +(1000 * (frameStamps.length - 1) / (frameStamps.at(-1) - frameStamps[0])).toFixed(1);
const fmt = new Intl.NumberFormat('en-US');
function showInfo() {
  info.textContent =
    `${fmt.format(stats.pieces)} pieces · ${fmt.format(stats.vertices)} verts · ${fmt.format(stats.triangles)} tris\n` +
    `build ${stats.totalBuildMs} ms · view ${VIEW}\n` +
    `t ${sim.toFixed(2)} / ${stats.T_END} · started ${fmt.format(tiles.startedAt(sim))} · landed ${fmt.format(tiles.landedAt(sim))}\n` +
    `${tiles.stageAt(sim) ?? 'Preparing the bed'} · ${fps()} fps`;
}

Object.defineProperty(window, '__fps', { get: fps });
window.__stats = stats;
window.__seek = t => { sim = t; framing = framingFor(t); };
window.__pause = (p = true) => { paused = p; };
window.__sun = (azDeg, elDeg) => { sunAz = azDeg * Math.PI / 180; sunEl = elDeg * Math.PI / 180; };
window.__ripple = x => { pieces.uniforms.uRipple.value = x; };
window.__tiles = tiles;
window.__three = { THREE, renderer, scene, camera, pieces, sun, bed };   // for profiling from the console

/**
 * GPU throughput without vsync: render `frames` frames back to back, then force the GPU to
 * finish (a 1-pixel readPixels) and divide. Also times the CPU side of each frame (the uniform
 * write + three.js render call), which must not depend on the piece count.
 */
window.__bench = (frames = 120) => {
  const gl = renderer.getContext(), px = new Uint8Array(4);
  updateCamera(0);
  renderer.render(scene, camera);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let cpu = 0;
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    const c0 = performance.now();
    tiles.update(sim);
    renderer.render(scene, camera);
    cpu += performance.now() - c0;
  }
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const total = performance.now() - start;
  return {
    frames, msPerFrame: +(total / frames).toFixed(2), fpsEquivalent: +(1000 * frames / total).toFixed(1),
    cpuMsPerFrame: +(cpu / frames).toFixed(3),
    drawCalls: renderer.info.render.calls, trianglesPerFrame: renderer.info.render.triangles,
    canvas: `${renderer.domElement.width}×${renderer.domElement.height}`,
  };
};

// ------------------------------------------------------------------ pose check: GPU vs the prototype's CPU pose

/**
 * For a few shapes and a range of drop progress values, render the GPU-posed piece and a CPU
 * copy posed with the prototype's own Object3D code (position, Euler rotation, scale), both lit
 * and shadowed the same way, and compare the images pixel by pixel. Matching images mean the
 * shader's positions, normals (lighting) and shadow pass all reproduce the prototype's pose.
 */
window.__poseCheck = async () => {
  const SIZE = 384;
  const DROP = TIMING.DROP;
  const checkScene = new THREE.Scene();
  checkScene.background = new THREE.Color(0, 0, 0);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: '#bdb3a3', roughness: 0.95, envMap, envMapIntensity: 0.35 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const light = new THREE.DirectionalLight(0xfff0d6, 1.9 * Math.PI);
  light.position.set(-6, 9, -4);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  Object.assign(light.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 40 });
  light.shadow.camera.updateProjectionMatrix();
  light.shadow.bias = -0.0006;
  light.shadow.normalBias = 0.03;
  checkScene.add(ground, light, new THREE.HemisphereLight(0xfff3e2, 0x4c4337, 0.45 * Math.PI));
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  cam.position.set(4.2, 3.6, 5.2);
  cam.lookAt(0, 0.9, 0);
  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 0 });

  const grab = () => {
    renderer.setRenderTarget(rt);
    renderer.render(checkScene, cam);
    const out = new Uint8Array(SIZE * SIZE * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, out);
    renderer.setRenderTarget(null);
    return out;
  };
  const compare = (a, b) => {
    let differ = 0, sum = 0, worst = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > 3) differ++;
      sum += d; worst = Math.max(worst, d);
    }
    const n = a.length / 4;
    return { differ: +(differ / n * 100).toFixed(3), mean: +(sum / n).toFixed(3), worst };
  };

  const shapes = {
    star: star(0, 0, 1.75, 0.95),
    strap: strap(0, 0, 1.2, 0.3, 0.4),
    hexagon: regular(0, 0, 0.9, 6, 0.2),
    concave: [[1, 0], [2, 0], [2, 2], [0, 2], [0, 1], ...Array.from({ length: 7 }, (_, k) => {
      const a = Math.PI / 2 * (1 - (k + 1) / 8); return [Math.cos(a), Math.sin(a)];
    })].map(([x, y]) => [x - 1, y - 1]),
  };
  const phases = [-0.05, 0.0, 0.1, 0.3, 0.5, 0.7, 0.79, 0.85, 0.95, 1.0, 3.0];
  const rows = [];
  let showcase = null;

  for (const [name, poly] of Object.entries(shapes)) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], c = p[0] * q[1] - q[0] * p[1];
      a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
    }
    cx /= 3 * a; cy /= 3 * a;
    const sched = makeSchedule([{ poly, key: 'W', seq: 0, cx, cy, r: 2, stage: name }], TIMING);
    const gpu = createPieces(sched, { envMap, rand: stream('check-' + name) });
    gpu.uniforms.uRipple.value = 0;               // the CPU copy has no ripple
    checkScene.add(gpu.group);
    const [t0, px, pz, yb, fx, fz, spin, sy, rx, rz, roughness, , r, g, b] = gpu.uniforms.uPieceData.value.image.data;

    // The CPU copy: same slab, recentred on the pivot, posed exactly like the prototype's tiles.
    const built = buildSlabs([{ poly, id: 0, pivot: [px, pz] }], { height: PIECE.HEIGHT, bevel: PIECE.BEVEL });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(built.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(built.normal, 3));
    geo.setIndex(new THREE.BufferAttribute(built.index, 1));
    geo.translate(-px, 0, -pz);
    const ref = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, g, b), roughness, metalness: 0, envMap, envMapIntensity: PIECE_LOOK.ENV_GLAZE,
    }));
    ref.castShadow = ref.receiveShadow = true;
    checkScene.add(ref);

    for (const p of phases) {
      const s = t0 + p * TIMING.D;
      gpu.setSim(s); gpu.group.visible = true; ref.visible = false;
      const imgGPU = grab();
      gpu.group.visible = false;
      const ph = dropPhase(Math.min(p, 1), DROP);      // the prototype clamps p at 1
      ref.visible = ph.visible;
      ref.position.set(px, yb + ph.y, pz);
      ref.rotation.set(rx + fx * ph.f, spin * ph.f, rz + fz * ph.f);
      ref.scale.set(1, sy, 1);
      const imgCPU = grab();
      ref.visible = false;
      const imgEmpty = grab();
      const vsCPU = compare(imgGPU, imgCPU), covered = compare(imgGPU, imgEmpty);
      rows.push({ shape: name, p, coveragePct: covered.differ, differPct: vsCPU.differ, meanDiff: vsCPU.mean, worst: vsCPU.worst });
      if (name === 'star' && p === 0.3) showcase = { imgGPU, imgCPU };
    }
    checkScene.remove(gpu.group, ref);
    gpu.dispose();
    geo.dispose();
  }
  rt.dispose();

  // Show the GPU and CPU renders of one mid-fall star, and their difference ×8, for a screenshot.
  const box = document.getElementById('check');
  box.style.display = 'grid';
  const panel = (label, pixels) => {
    const fig = document.createElement('figure'), c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const ctx = c.getContext('2d'), img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) img.data.set(pixels.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
    ctx.putImageData(img, 0, 0);
    fig.append(c, Object.assign(document.createElement('figcaption'), { textContent: label }));
    box.append(fig);
  };
  const diff = new Uint8Array(showcase.imgGPU.length);
  for (let i = 0; i < diff.length; i += 4) {
    for (let k = 0; k < 3; k++) diff[i + k] = Math.min(255, 8 * Math.abs(showcase.imgGPU[i + k] - showcase.imgCPU[i + k]));
    diff[i + 3] = 255;
  }
  panel('GPU vertex shader, p = 0.3', showcase.imgGPU);
  panel('CPU prototype pose, p = 0.3', showcase.imgCPU);
  panel('|difference| × 8', diff);
  window.__poseCheckResult = rows;
  return rows;
};

if (params.get('check') === 'pose') {
  paused = true;
  info.style.display = 'none';
  window.__poseCheck().catch(e => { console.error(e); window.__poseCheckResult = { error: String(e) }; });
} else {
  requestAnimationFrame(frame);
}
