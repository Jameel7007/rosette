// Boot, the frame loop and the HUD wiring.
//
// main.js knows nothing about how tiles are built or animated. It talks to one tile-system
// object (docs/CONTRACTS.md §4.3):
//   { count, T_END, update(sim), startedAt(sim), landedAt(sim), stageAt(sim), rLaidAt(sim), reset() }
// Today that is the prototype's square tesserae (src/legacy/tiles.js); the zellige build
// replaces the one `createLegacyTiles` line below.
import { mulberry, SEED } from './util/rand.js';
import { createRenderer } from './scene/renderer.js';
import { createBed } from './scene/bed.js';
import { createCameraRig, portraitFactor } from './anim/camera.js';
import { createLightRig } from './anim/light.js';
import { createHud } from './ui/hud.js';
import { createClicks } from './audio/clicks.js';
import { legacySinopia } from './legacy/pattern.js';
import { createLegacyTiles } from './legacy/tiles.js';

const SPEEDS = [1, 2, 4, 8];
const MAX_DT = 0.05;        // cap a frame's step (a hidden tab or a hitch should not skip tiles)
const SWEEP_DELAY = 1.2;    // seconds after the last tile lands before the finale sweep
const FPS_WINDOW = 60;      // frames in the rolling fps mean (window.__fps)

function boot() {
  const canvas = document.getElementById('c');
  const stage = createRenderer(canvas);
  if (!stage) {
    document.getElementById('err').hidden = false;
    return;
  }
  const { renderer, scene, camera, envMap, sun, resize, fitFog } = stage;

  // Legacy randomness: ONE stream with the prototype's seed, drawn in the prototype's order
  // (bed texture, floor texture, then tiles), so every grain, jitter and colour matches it.
  // The zellige build moves to named streams (rand.js `stream('bed')`, `stream('pieces')`, …)
  // so subsystems stop depending on each other's draw counts.
  const rand = mulberry(SEED);

  // The red underdrawing is a drawing spec in pattern units (scene/bed.js drawSinopia); the
  // zellige build passes its own construction lines here instead of the prototype's
  createBed(scene, { renderer, envMap, rand, sinopia: legacySinopia() });

  // ---- the tile system: the zellige build swaps this one line ----
  const tiles = createLegacyTiles(scene, { rand, envMap });

  const rig = createCameraRig(camera, canvas);
  const light = createLightRig(sun);
  const clicks = createClicks();

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let sim = 0;          // simulation time (seconds at 1×): what the tiles are a function of
  let clock = 0;        // wall-clock time (capped steps): drives the light sweep
  let speed = 1;
  let autoSwept = false;
  let prevLanded = 0;

  const hud = createHud({
    replay() { sim = 0; tiles.reset(); light.cancel(); },
    speed() { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; return speed; },
    finish() { if (sim < tiles.T_END) sim = tiles.T_END + 0.01; },
    sweep() { light.sweep(clock); },
    sound() { return clicks.toggle(); },
  });
  hud.setTotal(tiles.count);

  // On a portrait screen the camera backs off to fit the width; the fog backs off with it
  const onResize = () => { resize(); fitFog(portraitFactor(camera.aspect)); };
  window.addEventListener('resize', onResize);
  onResize();

  // Reduced motion: skip the laying and show the finished panel, with no automatic sweep
  if (reduceMotion) sim = tiles.T_END + 0.01;

  // Dev aids: jump the simulation clock; read the frame rate
  window.__seek = t => { sim = t; };
  window.__fps = 0;
  const intervals = [];
  let intervalSum = 0;

  let prev = performance.now();
  function frame(now) {
    const ms = now - prev;
    prev = now;
    const dt = Math.min(MAX_DT, ms / 1000);
    clock += dt;

    intervals.push(ms); intervalSum += ms;
    if (intervals.length > FPS_WINDOW) intervalSum -= intervals.shift();
    window.__fps = intervalSum > 0 ? Math.round(10000 * intervals.length / intervalSum) / 10 : 0;

    sim += dt * speed;
    tiles.update(sim);

    const landed = tiles.landedAt(sim);
    if (landed > prevLanded) clicks.tick(landed - prevLanded, landed);
    prevLanded = landed;

    if (landed >= tiles.count && !autoSwept && !reduceMotion) {
      autoSwept = true;   // once per page load, as in the prototype (Replay does not re-arm it)
      light.sweep(clock + SWEEP_DELAY);
    }

    rig.update(dt, tiles.rLaidAt(sim), sim);
    light.fitShadow(rig.framing, rig.zoom);
    light.update(clock);
    hud.update({ landed, started: tiles.startedAt(sim), total: tiles.count, stage: tiles.stageAt(sim) });

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
