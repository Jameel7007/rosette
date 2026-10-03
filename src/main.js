// Boot, the frame loop and the HUD wiring.
//
// main.js knows nothing about how tiles are built or animated. It talks to one tile-system
// object (docs/CONTRACTS.md §4.3):
//   { count, T_END, update(sim), startedAt(sim), landedAt(sim), stageAt(sim), rLaidAt(sim), reset() }
// The zellige pieces (scene/pieces.js) provide it; so does the prototype's square tesserae
// (legacy/tiles.js), still reachable at ?legacy=1 for side-by-side comparison.
//
// Startup order (zellige): renderer → bare mortar bed → first frame on screen ("Preparing the
// bed") → compose the panel in a Web Worker → paint its underdrawing on the bed → build the
// pieces → start the clock. The page shows the bed and the HUD at once instead of a blank
// screen while ten thousand pieces are cut, and it stays responsive while they are.
//
// Why a worker (measured on cold loads in headless Chrome, with Chrome's CPU throttle standing
// in for slower machines): on the main thread, composePanel took 0.42 s here, 0.90 s at 2×
// throttle and 1.83 s at 4× (a mid-range phone), one unbroken freeze each time. Building the
// meshes from its output takes 0.07 / 0.14 / 0.31 s, so that part stays here, where three.js
// is. With the worker the longest main-thread task after the first frame is ~0.1 s (0.4 s at
// 4×), and the main thread still has a fallback (composeOffThread below).
import { mulberry, stream, SEED } from './util/rand.js';
import { createRenderer, pixelRatioCeiling } from './scene/renderer.js';
import { createGovernor } from './scene/governor.js';
import { createBed } from './scene/bed.js';
import { createCameraRig, portraitFactor } from './anim/camera.js';
import { createLightRig } from './anim/light.js';
import { createHud, createStageLabel } from './ui/hud.js';
import { createClicks } from './audio/clicks.js';
import ComposeWorker from './compose.worker.js?worker&inline';
import { createZelligeTiles } from './scene/pieces.js';
import { legacySinopia } from './legacy/pattern.js';
import { createLegacyTiles } from './legacy/tiles.js';

const SPEEDS = [1, 2, 4, 8];
const MAX_DT = 0.05;        // cap a frame's step (a hidden tab or a hitch should not skip tiles)
const SWEEP_DELAY = 1.2;    // seconds after the last tile lands before the finale sweep
const FPS_WINDOW = 60;      // frames in the rolling fps mean (window.__fps)
const GOVERN_AFTER = 1;     // seconds after the clock starts before the frame rate is judged
const LEGACY = new URLSearchParams(location.search).get('legacy') === '1';

function boot() {
  // Startup timings (window.__startup), in ms of page time: performance.now() counts from the
  // navigation, so these include loading the page, the fonts and the scripts.
  const timing = { boot: Math.round(performance.now()) };
  window.__startup = timing;
  const stamp = name => { timing[name] = Math.round(performance.now()); };

  const canvas = document.getElementById('c');
  const stage = createRenderer(canvas);
  if (!stage) {
    // No WebGL: say so, and take away the HUD that would promise a panel ("Preparing the
    // bed", live-looking buttons) that will never come
    document.querySelector('.hud').hidden = true;
    document.getElementById('err').hidden = false;
    return;
  }
  const { renderer, scene, camera, sun, resize, fitFog } = stage;
  stamp('renderer');

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Reduced motion: no slow automatic turn either, so the finished panel holds still
  const rig = createCameraRig(camera, canvas, { drift: !reduceMotion });
  const light = createLightRig(sun, { prototypeShadow: LEGACY });
  const clicks = createClicks();

  let tiles = null;     // the tile system, once built
  let stageAt = null;   // sim → HUD stage label
  let sim = 0;          // simulation time (seconds at 1×): what the tiles are a function of
  let clock = 0;        // wall-clock time (capped steps): drives the light sweep
  let speed = 1;
  let autoSwept = false;
  let prevLanded = 0;
  let pendingFinish = false;   // Finish pressed while the panel was still being prepared
  let readyClock = Infinity;   // clock time the tiles started (the governor waits a moment after)
  let shadowDirty = true;      // the pieces jumped (start, Finish, Replay): redraw the shadow map

  const hud = createHud({
    replay() {
      // Before the pieces exist there is nothing to replay (the laying starts from 0 anyway)
      pendingFinish = false;
      if (!tiles) return;
      sim = 0; tiles.reset(); light.cancel(); shadowDirty = true;
    },
    speed() { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; return speed; },
    finish() {
      // Pressed during "Preparing the bed": remember it, and start() applies it
      if (!tiles) { pendingFinish = true; return; }
      if (sim < tiles.T_END) { sim = tiles.T_END + 0.01; shadowDirty = true; }
    },
    sweep() { light.sweep(clock); },
    sound() { return clicks.toggle(); },
  });

  /** Hands the built tile system to the loop. Before this, the clock stays at 0. */
  function start(built, labels) {
    tiles = built;
    stageAt = labels;
    hud.setTotal(tiles.count);
    // Reduced motion (or Finish pressed early): show the finished panel, framed at once (no
    // fly-out from the close-up). Reduced motion also skips the automatic sweep.
    const finished = reduceMotion || pendingFinish;
    sim = finished ? tiles.T_END + 0.01 : 0;
    if (finished) rig.snap(tiles.rLaidAt(sim));
    pendingFinish = false;
    prevLanded = tiles.landedAt(sim);
    readyClock = clock;
    shadowDirty = true;
    stamp('ready');
  }

  // Start composing at once: the worker cuts the polygons while this thread paints the bed.
  const panelReady = LEGACY ? null : composeOffThread();

  let bed;
  if (LEGACY) {
    // The prototype, exactly: ONE random stream with its seed, drawn in its order (bed
    // texture, floor texture, then tiles), so every grain, jitter and colour matches it.
    const rand = mulberry(SEED);
    bed = createBed(scene, { renderer, envMap: stage.envMap, rand, sinopia: legacySinopia() });
    const legacy = createLegacyTiles(scene, { rand, envMap: stage.envMap });
    hud.setSubtitle('Eight-fold, laid from the center point · prototype');
    start(legacy, legacy.stageAt);
  } else {
    // Named streams: each subsystem draws its own numbers, so the bed's grain never depends
    // on how many numbers the pattern or the pieces used (util/rand.js).
    bed = createBed(scene, { renderer, envMap: stage.envMap, rand: stream('bed'), sinopia: null });
  }
  stamp('bed');

  /**
   * The panel's polygons, composed in a worker. If a worker cannot START (very old browser, a
   * strict content policy), the same function runs here on the main thread instead: slower to
   * appear, same panel. If the worker started but composing itself failed, running it again
   * here would fail the same way, so that error is passed on instead.
   */
  function composeOffThread() {
    return new Promise((resolve, reject) => {
      let worker;
      const cannotStart = why => reject(Object.assign(new Error(why), { fallback: true }));
      try { worker = new ComposeWorker(); } catch (err) { cannotStart(err?.message ?? String(err)); return; }
      worker.onmessage = e => {
        worker.terminate();
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
      };
      // A worker blocked by a content policy fires a plain Event (no message): name its type
      worker.onerror = e => { worker.terminate(); cannotStart(e?.message || `worker ${e?.type ?? 'error'}`); };
      worker.postMessage({});
    }).catch(async err => {
      if (!err.fallback) throw err;
      console.warn('compose worker unavailable, composing on the main thread:', err.message);
      const { composePanel } = await import('./pattern/compose.js');
      const t = performance.now();
      const panel = composePanel();
      return { ...panel, ms: Math.round(performance.now() - t), mainThread: true };
    });
  }

  /** The zellige build, started once the bare bed is on screen. */
  async function buildZellige() {
    const panel = await panelReady;                    // pure JS: polygons, order, sinopia
    stamp('panelArrived');
    timing.composeMs = panel.ms;                       // time spent composing (in the worker)
    timing.composeSteps = panel.stats.ms;              // compose's own breakdown
    timing.composeOnMainThread = !!panel.mainThread;
    bed.paintSinopia(panel.sinopia);                   // the setter's red underdrawing
    stamp('sinopia');
    const built = createZelligeTiles(scene, panel.pieces, { envMap: stage.envMap, rand: stream('pieces') });
    stamp('pieces');
    // Compile the glaze/gold shader program without blocking (KHR_parallel_shader_compile).
    // On the very first cold run the first frame with pieces was a 0.37 s long task, most
    // likely this compile on an empty shader cache; with this it measures ~13 ms. The group
    // stays hidden meanwhile, so no frame asks for the program before it is ready. (The shadow
    // depth program is small and still compiles in the first shadow pass.)
    built.group.visible = false;
    await renderer.compileAsync(built.group, camera, scene);
    built.group.visible = true;
    stamp('compiled');
    const labels = createStageLabel(built.schedule.pieces, built.schedule.t0);
    timing.pieceStats = built.stats;
    start(built, labels);
  }

  /** The build failed (both the worker and the fallback, or the mesh build): say so on the HUD. */
  function buildFailed(err) {
    console.error('the panel could not be built:', err);
    hud.setStage('Could not lay the panel');
  }

  // The pixel ratio: a ceiling from the window size (renderer.js), and a governor that steps
  // down from it on machines that cannot hold ~60 fps (scene/governor.js)
  const ceiling = () => pixelRatioCeiling(window.devicePixelRatio, window.innerWidth, window.innerHeight);
  const governor = createGovernor({ ceiling: ceiling(), apply: ratio => resize(ratio) });
  window.addEventListener('resize', () => governor.reset(ceiling()));   // reset() resizes too
  resize(governor.ratio);

  // Dev aids: jump the simulation clock; read the frame rate and the pixel ratio in use
  window.__seek = t => { sim = t; rig.syncDrift(t); shadowDirty = true; };
  window.__fps = 0;
  window.__pixelRatio = () => governor.ratio;
  const intervals = [];
  let intervalSum = 0;

  renderer.shadowMap.autoUpdate = false;   // redrawn only when something it shows has moved (below)

  let prev = performance.now();
  let frames = 0;
  function frame(now) {
    const ms = now - prev;
    prev = now;
    const dt = Math.min(MAX_DT, ms / 1000);
    clock += dt;

    intervals.push(ms); intervalSum += ms;
    if (intervals.length > FPS_WINDOW) intervalSum -= intervals.shift();
    window.__fps = intervalSum > 0 ? Math.round(10000 * intervals.length / intervalSum) / 10 : 0;
    if (clock - readyClock > GOVERN_AFTER) governor.frame(ms);

    let landed = 0, started = 0, rLaid = 0;
    if (tiles) {
      sim += dt * speed;
      tiles.update(sim);
      landed = tiles.landedAt(sim);
      started = tiles.startedAt(sim);
      rLaid = tiles.rLaidAt(sim);
      if (landed > prevLanded) clicks.tick(landed - prevLanded, landed);
      prevLanded = landed;
      // The underdrawing disappears under pieces as they land (zellige build only)
      if (tiles.rCoveredAt) bed.setCovered(tiles.rCoveredAt(sim));

      if (landed >= tiles.count && !autoSwept && !reduceMotion) {
        autoSwept = true;   // once per page load, as in the prototype (Replay does not re-arm it)
        light.sweep(clock + SWEEP_DELAY);
      }
      hud.update({ landed, started, total: tiles.count, stage: stageAt(sim) });
    }

    rig.update(dt, rLaid, sim);
    // On a portrait screen the camera backs off to fit the width, and zooming out (wheel or
    // pinch) backs it off further; the fog backs off with it, or the panel sinks into it
    fitFog(portraitFactor(camera.aspect) * Math.max(1, rig.zoom));
    // Far-view slabs once the bevel is under a pixel (scene/pieces.js DETAIL): device pixels
    // per world unit at the panel's centre
    tiles?.setDetail?.(canvas.height / (2 * camera.position.length() * Math.tan(camera.fov * Math.PI / 360)));

    const wasSweeping = light.sweeping;
    // The sweep aims its high point at the viewer, just below the mirror height of the far
    // edge on screen (the legacy build keeps the prototype's sweep, which ignores the viewer)
    light.update(clock, LEGACY ? null : camera.position, rig.framing * rig.zoom);
    const boxMoved = light.fitShadow(rig.framing, rig.zoom);   // after update: the depth fit uses the sun's height

    // The shadow map only changes when a piece moves, the sun moves or the shadow box moves.
    // Once the panel is laid and still, that is almost never, and the depth pass over every
    // piece's triangles is skipped.
    const moving = tiles && sim <= tiles.T_END;
    if (shadowDirty || moving || wasSweeping || light.sweeping || boxMoved || !tiles) {
      renderer.shadowMap.needsUpdate = true;
      shadowDirty = false;
    }

    const r0 = performance.now();
    renderer.render(scene, camera);
    if (tiles && timing.firstPiecesRenderMs === undefined) timing.firstPiecesRenderMs = Math.round(performance.now() - r0);
    requestAnimationFrame(frame);

    // Build the pieces only after the first frame has been presented: the rAF callback runs
    // before the browser paints, so a timeout from here runs after that paint. (The worker
    // has been composing since boot; the build waits for it if it is not done yet.)
    if (++frames === 1) {
      stamp('firstFrame');
      if (!LEGACY) setTimeout(() => buildZellige().catch(buildFailed), 0);
    }
  }
  requestAnimationFrame(frame);
}

boot();
