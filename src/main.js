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
//
// The frame loop is split in two: step(dt) advances one *playback* of the piece by dt seconds
// and draws it; frame() feeds it the real frame time. A video export (export/record.js) plays
// its own playback through the same step(), exactly 1/60 s per encoded frame, at the video's
// size, then hands the page back exactly as it was (beginExport / endExport below).
import { mulberry, stream, SEED } from './util/rand.js';
import { createRenderer, pixelRatioCeiling } from './scene/renderer.js';
import { createGovernor } from './scene/governor.js';
import { createBed } from './scene/bed.js';
import { createCameraRig, portraitFactor } from './anim/camera.js';
import { createLightRig } from './anim/light.js';
import { createHud, createStageLabel } from './ui/hud.js';
import { createExportPanel } from './ui/export-panel.js';
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

  // A playback of the piece: its two clocks, its camera path and its sun. The page plays `live`;
  // a video export plays its own (beginExport), and `live` waits, untouched, until it is back.
  const live = {
    rig, light,
    sim: 0,          // simulation time (seconds at 1×): what the tiles are a function of
    clock: 0,        // wall-clock time (capped steps): drives the light sweep
    speed: 1,
    autoSweep: !reduceMotion,   // the finale sweep after the last piece (reduced motion: none)
    autoSwept: false,
    prevLanded: 0,
  };
  let run = live;              // the playback step() advances
  let pendingFinish = false;   // Finish pressed while the panel was still being prepared
  let readyClock = Infinity;   // clock time the tiles started (the governor waits a moment after)
  let shadowDirty = true;      // the pieces jumped (start, Finish, Replay): redraw the shadow map

  const hud = createHud({
    replay() {
      // Before the pieces exist there is nothing to replay (the laying starts from 0 anyway)
      pendingFinish = false;
      if (!tiles) return;
      live.sim = 0; tiles.reset(); light.cancel(); shadowDirty = true;
    },
    speed() { live.speed = SPEEDS[(SPEEDS.indexOf(live.speed) + 1) % SPEEDS.length]; return live.speed; },
    finish() {
      // Pressed during "Preparing the bed": remember it, and start() applies it
      if (!tiles) { pendingFinish = true; return; }
      if (live.sim < tiles.T_END) { live.sim = tiles.T_END + 0.01; shadowDirty = true; }
    },
    sweep() { light.sweep(live.clock); },
    sound() { return clicks.toggle(); },
  });

  // The Export video button and its panel (ui/export-panel.js). The host is what the exporter
  // borrows: the renderer's canvas, step() and the switch into and out of export mode (below).
  const exportPanel = createExportPanel({
    host: {
      get T_END() { return tiles.T_END; },
      get count() { return tiles.count; },
      get schedule() { return tiles.schedule; },   // { t0, D }: the export's click track
      canvas,
      begin: beginExport,
      step,
      redraw,
      contextLost: () => renderer.getContext().isContextLost(),
      end: endExport,
      snapshot,
    },
    soundOn: () => clicks.on,
    reduceMotion,
  });

  /** Hands the built tile system to the loop. Before this, the clock stays at 0. */
  function start(built, labels) {
    tiles = built;
    stageAt = labels;
    hud.setTotal(tiles.count);
    // Reduced motion (or Finish pressed early): show the finished panel, framed at once (no
    // fly-out from the close-up). Reduced motion also skips the automatic sweep.
    const finished = reduceMotion || pendingFinish;
    live.sim = finished ? tiles.T_END + 0.01 : 0;
    if (finished) rig.snap(tiles.rLaidAt(live.sim));
    pendingFinish = false;
    live.prevLanded = tiles.landedAt(live.sim);
    readyClock = live.clock;
    shadowDirty = true;
    // Only the zellige build can be exported (its schedule drives the export's sound); the
    // prototype build (?legacy=1) hides the button instead of leaving it dimmed for ever
    if (tiles.schedule) exportPanel.ready(); else exportPanel.unavailable();
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
  window.addEventListener('resize', () => {
    // During an export the canvas is the video's size; the new window size is applied after it
    if (exporting) { exporting.resized = true; return; }
    governor.reset(ceiling());   // reset() resizes too
  });
  resize(governor.ratio);

  // Dev aids: jump the simulation clock; read the frame rate and the pixel ratio in use
  window.__seek = t => { if (exporting) return; live.sim = t; rig.syncDrift(t); shadowDirty = true; };
  window.__fps = 0;
  window.__pixelRatio = () => governor.ratio;
  const intervals = [];
  let intervalSum = 0;

  renderer.shadowMap.autoUpdate = false;   // redrawn only when something it shows has moved (below)

  /** Device pixels per world unit at the panel's centre (for the far-view slabs). */
  const pxPerUnit = () => canvas.height / (2 * camera.position.length() * Math.tan(camera.fov * Math.PI / 360));

  /**
   * Advances the current playback by `dt` seconds and draws it. The live loop calls it once per
   * display frame with the real (capped) frame time; a video export calls it once per encoded
   * frame with exactly 1/60 s, so the picture depends on the frame count, never on wall time.
   * @returns {{ landed }} pieces landed so far (the export burns this counter into the video)
   */
  function step(dt) {
    const r = run;
    r.clock += dt;

    let landed = 0, started = 0, rLaid = 0;
    if (tiles) {
      r.sim += dt * r.speed;
      tiles.update(r.sim);
      landed = tiles.landedAt(r.sim);
      started = tiles.startedAt(r.sim);
      rLaid = tiles.rLaidAt(r.sim);
      // The clicks and the HUD belong to the live page (an export renders its sound offline)
      if (r === live && landed > r.prevLanded) clicks.tick(landed - r.prevLanded, landed);
      r.prevLanded = landed;
      // The underdrawing disappears under pieces as they land (zellige build only)
      if (tiles.rCoveredAt) bed.setCovered(tiles.rCoveredAt(r.sim));

      if (landed >= tiles.count && !r.autoSwept && r.autoSweep) {
        // Once per playback: for the live page once per page load, as in the prototype
        // (Replay does not re-arm it)
        r.autoSwept = true;
        r.light.sweep(r.clock + SWEEP_DELAY);
      }
      if (r === live) hud.update({ landed, started, total: tiles.count, stage: stageAt(r.sim) });
    }

    r.rig.update(dt, rLaid, r.sim);
    // On a portrait screen the camera backs off to fit the width, and zooming out (wheel or
    // pinch) backs it off further; the fog backs off with it, or the panel sinks into it
    fitFog(portraitFactor(camera.aspect) * Math.max(1, r.rig.zoom));
    // Far-view slabs once the bevel is under a pixel (scene/pieces.js DETAIL)
    tiles?.setDetail?.(pxPerUnit());

    const wasSweeping = r.light.sweeping;
    // The sweep aims its high point at the viewer, just below the mirror height of the far
    // edge on screen (the legacy build keeps the prototype's sweep, which ignores the viewer)
    r.light.update(r.clock, LEGACY ? null : camera.position, r.rig.framing * r.rig.zoom);
    const boxMoved = r.light.fitShadow(r.rig.framing, r.rig.zoom);   // after update: the depth fit uses the sun's height

    // The shadow map only changes when a piece moves, the sun moves or the shadow box moves.
    // Once the panel is laid and still, that is almost never, and the depth pass over every
    // piece's triangles is skipped.
    const moving = tiles && r.sim <= tiles.T_END;
    if (shadowDirty || moving || wasSweeping || r.light.sweeping || boxMoved || !tiles) {
      renderer.shadowMap.needsUpdate = true;
      shadowDirty = false;
    }

    const r0 = performance.now();
    renderer.render(scene, camera);
    if (tiles && r === live && timing.firstPiecesRenderMs === undefined) timing.firstPiecesRenderMs = Math.round(performance.now() - r0);
    return { landed };
  }

  /**
   * Draws the current moment again without advancing anything: after a lost WebGL context comes
   * back, the export redraws the frame it was on (export/record.js). The shadow map was lost with
   * the context, so it is redrawn too.
   */
  function redraw() {
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    return { landed: run.prevLanded };
  }

  /**
   * Paints the live piece, as it is now, onto a 2D context (the export panel's still preview
   * with reduced motion). step(0) draws the live playback without moving it, in this task, so
   * the WebGL canvas can be copied before the browser presents and clears it.
   */
  function snapshot(target) {
    if (exporting) return;
    step(0);
    target.drawImage(canvas, 0, 0, target.canvas.width, target.canvas.height);
  }

  let prev = performance.now();
  let frames = 0;
  function frame(now) {
    const ms = now - prev;
    prev = now;
    if (exporting) {
      // The exporter drives step() itself, one fixed step per encoded frame; the live
      // playback waits where it is
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(MAX_DT, ms / 1000);

    intervals.push(ms); intervalSum += ms;
    if (intervals.length > FPS_WINDOW) intervalSum -= intervals.shift();
    window.__fps = intervalSum > 0 ? Math.round(10000 * intervals.length / intervalSum) / 10 : 0;
    if (live.clock + dt - readyClock > GOVERN_AFTER) governor.frame(ms);

    step(dt);
    requestAnimationFrame(frame);

    // Build the pieces only after the first frame has been presented: the rAF callback runs
    // before the browser paints, so a timeout from here runs after that paint. (The worker
    // has been composing since boot; the build waits for it if it is not done yet.)
    if (++frames === 1) {
      stamp('firstFrame');
      if (!LEGACY) setTimeout(() => buildZellige().catch(buildFailed), 0);
    }
  }

  // ---------------------------------------------------------------- video export
  //
  // export/record.js borrows the renderer through this host. beginExport switches to a
  // deterministic render mode: the video's exact size at one pixel per pixel, no performance
  // governor (it would change the resolution mid-file), and a fresh playback from the first
  // piece with the live camera path (plus a fit of the whole panel at the end, anim/camera.js)
  // that ignores the viewer's input. endExport puts back everything the live page had.

  let exporting = null;   // while recording: what endExport restores

  function beginExport({ width, height, speed }) {
    const sc = sun.shadow.camera;
    exporting = {
      ratio: renderer.getPixelRatio(),
      far: tiles.setDetail?.(pxPerUnit()),     // which slabs the live view draws
      sun: sun.position.clone(),
      shadowBox: { left: sc.left, right: sc.right, top: sc.top, bottom: sc.bottom, near: sc.near, far: sc.far },
      shadowBias: sun.shadow.bias,
      resized: false,                          // set by the resize listener
    };
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Two things remember the past and would carry the live view into the video: the shadow box
    // is only rebuilt when it moves by more than 0.05 (light.fitShadow), and the slab detail has
    // a two-threshold band (pieces.setDetail). Measured by hashing every frame handed to the
    // encoder: exports started from a still, finished page and from a page mid-laying differed
    // in 2,214 of 2,246 frames. So both start from a known state: the box is rebuilt on the first
    // frame (an infinite width always counts as moved) and the full slabs are drawn. Now the
    // export does not depend on the live view: a video started mid-sweep from a zoomed, turned,
    // 8× page decodes identical to one started from a fresh page. (Across page loads, the bed's
    // grain canvas, drawn by the GPU, can come out 1 level different in a few pixels, and the
    // encoder then writes a different but equally good file; so determinism is checked on frame
    // counts, timing and pixels, never on file checksums.)
    sun.shadow.camera.right = Infinity;
    tiles.setDetail?.(Infinity);
    run = {
      rig: createCameraRig(camera, canvas, { drift: true, input: false, fit: true }),
      light: createLightRig(sun, { prototypeShadow: LEGACY }),
      sim: 0, clock: 0, speed,
      autoSweep: true,    // the video always ends with the sweep, even with reduced motion
      autoSwept: false,
      prevLanded: 0,
    };
    shadowDirty = true;
  }

  function endExport() {
    // Also called when beginExport failed part way (export/record.js calls end() from a finally):
    // nothing to undo if it never got as far as saving the live state
    const saved = exporting;
    if (!saved) return;
    if (run !== live) run.rig.dispose();
    run = live;
    exporting = null;
    // Size and pixel ratio: as they were, or, if the window changed meanwhile, what the resize
    // listener would have given it
    if (saved.resized) governor.reset(ceiling()); else resize(saved.ratio);
    tiles.setDetail?.(saved.far ? 0 : Infinity);
    // The sun and its shadow box exactly as the live light left them (light.fitShadow only
    // rewrites the box when it moves by more than 0.05)
    sun.position.copy(saved.sun);
    Object.assign(sun.shadow.camera, saved.shadowBox);
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = saved.shadowBias;
    tiles.update(live.sim);
    shadowDirty = true;
  }

  requestAnimationFrame(frame);
}

boot();
