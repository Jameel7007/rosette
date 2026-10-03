// End-to-end check of the real app: cold server, fresh pages, real input, rendered output.
//
//   node scripts/verify-app.mjs [--port 5193] [--base http://host:port] [--only run,finish,...]
//
// Without --base it starts its own Vite dev server on --port (a cold start) and stops it at
// the end. Every page is a fresh browser context, so nothing is cached between checks.
//
// Sections (all by default):
//   run      the opening in real time at speed 1 (~2.5 s and ~5 s after navigation), the
//            medallion and the field front as they happen, a contact sheet of the whole
//            pull-back, frame rate during the busiest drop and after landing
//   finish   Finish by a real click, the automatic light sweep (glint shots where the sun
//            passes behind the panel), the finished panel after it, then a real pointer drag
//            to the highest elevation (straight overhead), with crops to look for shadow acne
//   closeup  zoomed right in (real wheel) on the finished panel: Sweep light at its low point
//            and at the glint, then overhead: the hardest case for shadow acne
//   input    Speed (each step, measured from the HUD counter), Finish, Sweep light, Sound,
//            wheel, drag, double-click, Replay: each judged from pixels or the HUD text
//   reduced  prefers-reduced-motion: finished panel at once (no fly-out), no automatic sweep
//   phone    390 × 844 touch viewport: opening and finished panel; the HUD must not cover
//            the panel's centre
//   legacy   ?legacy=1, the prototype's square tesserae, still runs (for side-by-side looks)
//   build    npm run build → dist/index.html opened from file:// (the single-file build), and
//            the same file with workers blocked (the main-thread fallback)
//   glint    the Sweep light button on a still view (reduced motion), finished and overhead:
//            every frame against the frame before the sweep, with gold and glaze told apart by
//            a mask render (see glintProbe below), not by colour
//   glint-motion  the same measure with normal motion, on the path a viewer actually takes:
//            Finish by a real click (a real tap on the phone) and the automatic sweep that
//            follows while the camera is still flying out. Each probed frame is compared with
//            the same frame drawn again with the sun at rest (motionProbe below), so a camera
//            that moves during the sweep does not count as wash. Judged: worst glaze wash,
//            peak gold flash, the sun's lowest point, its largest step per frame
//
// What counts as evidence: screenshots (capture/app/*.png, look at them), pixel statistics
// of those screenshots, the HUD's text, frame times from our own requestAnimationFrame
// recorder, long tasks from a PerformanceObserver installed before the page's scripts.
// window.__seek is never used here. window.__startup (the app's own build timings) is read
// once and reported as such.
import { spawn, execSync } from 'child_process';
import { mkdirSync, writeFileSync, statSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { launch, collectConsole } from './lib/browser.mjs';
import { SUN, SWEEP_FLOOR } from '../src/anim/light.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PORT = +opt('port', 5193);
const ONLY = opt('only', 'run,finish,glint,glint-motion,closeup,input,reduced,phone,legacy,build').split(',');
const OUT = resolve(ROOT, 'capture/app');
mkdirSync(OUT, { recursive: true });

const W = 1280, H = 800;
const TIMING = { T_START: 0.9, T_SPAN: 46, P_EXP: 0.42, D: 0.55 };   // config.js (the schedule contract)
const SWEEP_DELAY = 1.2, SWEEP_SECONDS = 11;                       // main.js, anim/light.js
// The light's clock advances by capped frame steps (main.js MAX_DT), and taking a screenshot
// can stall a frame, so the sweep can run a little behind wall time: waits for "after the
// sweep" add this margin, and sweep moments (p) below are nominal, from wall time.
const SWEEP_MARGIN = 3000;
const summary = { started: new Date().toISOString(), sections: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ server

async function startServer() {
  const proc = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('vite did not start:\n' + out)), 30000);
    const on = d => { out += d; if (/ready in/.test(out)) { clearTimeout(timer); res(); } };
    proc.stdout.on('data', on); proc.stderr.on('data', on);
    proc.on('exit', code => { clearTimeout(timer); rej(new Error(`vite exited (${code}):\n${out}`)); });
  });
  return proc;
}

// ------------------------------------------------------------------ in-page instruments

/** Installed before the app's scripts: our own frame clock and long-task log. */
function instruments() {
  window.__frameTimes = [];
  const loop = t => { window.__frameTimes.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__long = [];
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* not supported */ }
  // A page reload (e.g. the dev server reacting to someone else's edit) would restart the
  // run silently; this id changes on every load, so we can tell.
  window.__loadId = Math.random();
}

async function openPage(browser, url, ctxOpts = {}) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ...ctxOpts });
  const page = await context.newPage();
  const log = collectConsole(page);
  await page.addInitScript(instruments);
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__loadId !== undefined);
  const loadId = await page.evaluate(() => window.__loadId);
  page.assertSameLoad = async where => {
    const id = await page.evaluate(() => window.__loadId);
    if (id !== loadId) throw new Error(`page reloaded during ${where} (dev server HMR?): rerun`);
  };
  return { page, log, context };
}

/** The HUD as the viewer reads it. */
const readHud = page => page.evaluate(() => {
  const $ = id => document.getElementById(id);
  const n = +$('n').textContent.replace(/[^\d]/g, '');
  const total = +($('of').textContent.replace(/[^\d]/g, '') || 0);
  return { stage: $('stage').textContent, n, total, speed: $('speed').textContent, sound: $('sound').textContent,
    soundPressed: $('sound').getAttribute('aria-pressed'), now: Math.round(performance.now()) };
});
const waitReady = page => page.waitForFunction(() => /\d/.test(document.getElementById('of').textContent), null, { timeout: 60000 });
const waitCount = (page, n, timeout = 120000) =>
  page.waitForFunction(k => +document.getElementById('n').textContent.replace(/[^\d]/g, '') >= k, n, { timeout, polling: 50 });
const waitPageTime = (page, ms) => page.waitForFunction(t => performance.now() >= t, ms, { timeout: ms + 60000, polling: 20 });

/** Sim time implied by a landed count (inverse of the schedule's start-time curve + drop). */
const simAtLanded = (n, N) => n <= 0 ? 0 : TIMING.T_START + TIMING.T_SPAN * Math.pow(n / N, TIMING.P_EXP) + TIMING.D;

/** Frame statistics between two page times (ms), from our own rAF recorder. */
const frameStats = (page, from, to) => page.evaluate(([a, b]) => {
  const t = window.__frameTimes.filter(x => x >= a && x <= b);
  if (t.length < 2) return null;
  const dts = t.slice(1).map((x, i) => x - t[i]).sort((p, q) => p - q);
  const pct = p => dts[Math.min(dts.length - 1, Math.floor(p * dts.length))];
  return { frames: t.length, seconds: +((t[t.length - 1] - t[0]) / 1000).toFixed(2),
    fps: +((t.length - 1) / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1),
    medianMs: +pct(0.5).toFixed(1), p95Ms: +pct(0.95).toFixed(1), worstMs: +dts[dts.length - 1].toFixed(1),
    over33ms: dts.filter(d => d > 33.4).length };
}, [from, to]);

async function shot(page, name, opts = {}) {
  const path = `${OUT}/${name}.png`;
  const buf = await page.screenshot({ path, ...opts });
  return { name, path: path.replace(ROOT + '/', ''), buf };
}

// ------------------------------------------------------------------ image maths (2D canvas in a blank page)

async function makeLab(browser) {
  const page = await browser.newPage();
  await page.setContent('<body></body>');
  const call = (fn, arg) => page.evaluate(fn, arg);
  const prelude = `
    const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + src; });
    const pixels = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height); };`;
  return {
    /** Mean absolute channel difference (0..255) and share of pixels differing by > 24. */
    diff: (a, b) => call(new Function('x', `${prelude} return (async () => {
      const [ia, ib] = await Promise.all([load(x.a), load(x.b)]); const da = pixels(ia).data, db = pixels(ib).data;
      let s = 0, big = 0; for (let i = 0; i < da.length; i += 4) { let m = 0; for (let c = 0; c < 3; c++) { const d = Math.abs(da[i+c] - db[i+c]); s += d; m = Math.max(m, d); } if (m > 24) big++; }
      return { meanAbs: +(s / (da.length / 4 * 3)).toFixed(2), changed: +(big / (da.length / 4)).toFixed(4) }; })()`), { a: a.toString('base64'), b: b.toString('base64') }),
    /**
     * Gold catching the light, in a region: pixels of gold hue (32-58°) with saturation > 0.3
     * and value > 0.93 (at rest the gold sits around value 0.8), plus the region's mean
     * saturation (it drops when the glaze washes out under glare).
     */
    gold: (a, region) => call(new Function('x', `${prelude} return (async () => {
      const img = await load(x.a); const d = pixels(img).data; const [x0, y0, w, h] = x.region;
      let gold = 0, sat = 0;
      for (let y = y0; y < y0 + h; y++) for (let xx = x0; xx < x0 + w; xx++) {
        const i = (y * img.width + xx) * 4, r = d[i] / 255, g = d[i+1] / 255, b = d[i+2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0;
        let hue = 0; if (mx > mn) { if (mx === r) hue = 60 * (((g - b) / (mx - mn)) % 6); else if (mx === g) hue = 60 * ((b - r) / (mx - mn) + 2); else hue = 60 * ((r - g) / (mx - mn) + 4); }
        if (hue < 0) hue += 360;
        if (hue > 32 && hue < 58 && s > 0.3 && mx > 0.93) gold++;
        sat += s;
      }
      return { goldHighlightPx: gold, meanSaturation: +(sat / (w * h)).toFixed(3) }; })()`), { a: a.toString('base64'), region }),
    /** A crop scaled up (nearest neighbour), for looking at shadow edges and acne. */
    crop: (a, [x0, y0, w, h], scale) => call(new Function('x', `${prelude} return (async () => {
      const img = await load(x.a); const c = document.createElement('canvas'); c.width = x.w * x.scale; c.height = x.h * x.scale;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(img, x.x0, x.y0, x.w, x.h, 0, 0, c.width, c.height);
      return c.toDataURL('image/png').split(',')[1]; })()`), { a: a.toString('base64'), x0, y0, w, h, scale }).then(b => Buffer.from(b, 'base64')),
    /** Contact sheet: images in a grid, each scaled to cellW wide, with a caption. */
    sheet: (imgs, cols, cellW) => call(new Function('x', `${prelude} return (async () => {
      const ims = await Promise.all(x.imgs.map(load)); const cellH = Math.round(x.cellW * ims[0].height / ims[0].width);
      const rows = Math.ceil(ims.length / x.cols); const c = document.createElement('canvas'); c.width = x.cols * x.cellW; c.height = rows * cellH;
      const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
      ims.forEach((im, k) => { const px = (k % x.cols) * x.cellW, py = Math.floor(k / x.cols) * cellH; g.drawImage(im, px, py, x.cellW, cellH);
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(px, py, 150, 20); g.fillStyle = '#fff'; g.font = '13px monospace'; g.fillText(x.labels[k], px + 4, py + 14); });
      return c.toDataURL('image/png').split(',')[1]; })()`), { imgs: imgs.map(b => b.toString('base64')), cols, cellW, labels: imgs.labels ?? [] }).then(b => Buffer.from(b, 'base64')),
  };
}
const save = (name, buf) => { writeFileSync(`${OUT}/${name}.png`, buf); return `capture/app/${name}.png`; };

// ------------------------------------------------------------------ sections

/** The laying in real time at speed 1, untouched. */
async function sectionRun(browser, base, lab) {
  const { page, log, context } = await openPage(browser, base);
  const res = { shots: [] };
  const note = async (s, extra = {}) => { const h = await readHud(page); res.shots.push({ shot: s.path, ...h, simFromCount: h.total ? +simAtLanded(h.n, h.total).toFixed(2) : 0, ...extra }); return h; };

  await waitPageTime(page, 2500);
  await note(await shot(page, 'run-opening-2.5s'));
  await waitPageTime(page, 5000);
  await note(await shot(page, 'run-opening-5s'));
  await waitReady(page);
  res.startup = await page.evaluate(() => { const s = { ...window.__startup }; delete s.pieceStats; return s; });
  res.pieceStats = await page.evaluate(() => window.__startup.pieceStats);
  res.longTasks = await page.evaluate(() => window.__long);
  const N = (await readHud(page)).total;
  res.N = N;

  // A frame every ~3 s for the contact sheet, plus the named moments, until all have landed
  const strip = [], labels = [];
  const named = [[700, 'run-mid-medallion'], [3400, 'run-field-front']];
  let nextStrip = 0;
  let busiest = null;
  res.stageChanges = [];   // the HUD's stage label as the viewer sees it change
  while (true) {
    const h = await readHud(page);
    if (h.stage !== res.stageChanges.at(-1)?.stage) res.stageChanges.push({ stage: h.stage, atMs: h.now, n: h.n });
    if (h.now >= nextStrip) {
      const s = await shot(page, 'run-strip-tmp');
      strip.push(s.buf); labels.push(`${(h.now / 1000).toFixed(1)}s  n=${h.n}`);
      nextStrip = h.now + 3000;
    }
    while (named.length && h.n >= named[0][0]) {
      const [, name] = named.shift();
      await note(await shot(page, name));
    }
    // The busiest stretch: the schedule's landing rate peaks at the very end
    if (!busiest && h.n >= Math.round(N * 0.68)) busiest = { from: h.now, n: h.n };
    if (h.n >= N) { busiest.to = h.now; break; }
    await sleep(200);
  }
  res.fpsBusiestDrop = { ...(await frameStats(page, busiest.from, busiest.to)), fromCount: busiest.n,
    simFrom: +simAtLanded(busiest.n, N).toFixed(1) };
  const landedAt = (await readHud(page)).now;
  await sleep(1000);   // landed, sweep not yet started (it waits 1.2 s)
  res.fpsAfterLanding = await frameStats(page, landedAt, landedAt + 1000);
  await sleep(4000);   // into the automatic sweep
  res.fpsDuringSweep = await frameStats(page, landedAt + 2000, landedAt + 5000);
  await note(await shot(page, 'run-finished-sweeping'));
  strip.labels = labels;
  res.strip = save('run-pullback-sheet', await lab.sheet(strip, 4, 320));
  await page.assertSameLoad('run');
  res.console = log;
  await context.close();
  return res;
}

/** Finish by click, the automatic sweep, the finished panel, and straight overhead by drag. */
async function sectionFinish(browser, base, lab) {
  const { page, log, context } = await openPage(browser, base);
  const res = {};
  await waitReady(page);
  await page.waitForTimeout(300);
  await page.click('#finish');
  const clickAt = (await readHud(page)).now;
  res.afterFinish = await readHud(page);

  // The sweep, sampled every 0.025 of its length around the middle, where the sun passes
  // behind the panel (anim/light.js). Measured in the panel's middle (HUD excluded): bright
  // gold-hued pixels and colour saturation. A rough colour measure (honey ochre has the gold's
  // hue); the glint section measures gold and glaze properly, with a mask render.
  const PANEL_REGION = [330, 120, 630, 560];
  const sweepStart = clickAt + SWEEP_DELAY * 1000;
  const frames = [];
  for (let p = 0.4; p <= 0.751; p += 0.025) {
    await waitPageTime(page, sweepStart + p * SWEEP_SECONDS * 1000);
    frames.push({ p: +p.toFixed(3), buf: await page.screenshot() });
  }
  await waitPageTime(page, sweepStart + SWEEP_SECONDS * 1000 + SWEEP_MARGIN);
  const fin = await shot(page, 'finish-finished');
  res.finished = { shot: fin.path, ...(await lab.gold(fin.buf, PANEL_REGION)), hud: await readHud(page) };
  for (const f of frames) Object.assign(f, await lab.gold(f.buf, PANEL_REGION));
  const best = frames.reduce((a, b) => (b.goldHighlightPx > a.goldHighlightPx ? b : a));
  res.glint = frames.map(({ p, goldHighlightPx, meanSaturation }) => ({ p, goldHighlightPx, meanSaturation }));
  res.glintBest = { p: best.p, shot: save('finish-glint', best.buf), goldHighlightPx: best.goldHighlightPx };
  // The medallion's gold ring, at rest and at the glint, side by side (scaled ×2)
  const ringRest = await lab.crop(fin.buf, [440, 230, 200, 180], 2), ringGlint = await lab.crop(best.buf, [440, 230, 200, 180], 2);
  const pair = [ringRest, ringGlint]; pair.labels = ['at rest', `glint p=${best.p}`];
  res.glintBest.ringCrop = save('finish-glint-ring', await lab.sheet(pair, 2, 400));
  // Early in this window the sun is still fairly low (its lowest is near p ≈ 0.3, on the
  // viewer's side; the closeup section shoots that moment): raking light invites acne
  const lowFrame = frames[0];
  res.lowSunCrop = save('finish-sweep-p04-crop', await lab.crop(lowFrame.buf, [540, 330, 200, 140], 4));

  // Straight overhead: drag the pointer DOWN the canvas (the prototype's mapping, like
  // OrbitControls: pulling down tilts the view up), far enough to hit the elevation limit.
  await page.mouse.move(640, 250);
  await page.mouse.down();
  await page.mouse.move(640, 690, { steps: 25 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const top = await shot(page, 'finish-overhead');
  res.overhead = { shot: top.path, vsFinished: await lab.diff(fin.buf, top.buf) };
  // At the limit a further drag down must change nothing. The camera also turns slowly by
  // itself (0.004 rad per second), so compare against the same wait with no input.
  await page.waitForTimeout(700);
  const control = await page.screenshot();
  res.overhead.noInputDrift = await lab.diff(top.buf, control);
  await page.mouse.move(640, 250); await page.mouse.down(); await page.mouse.move(640, 450, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const top2 = await page.screenshot();
  res.overhead.furtherDragDown = await lab.diff(control, top2);
  // Crops for acne / shadow detail, and a drag back up to show the limit is only at the top
  res.overhead.cropCentre = save('finish-overhead-crop-centre', await lab.crop(top.buf, [540, 330, 200, 140], 4));
  res.overhead.cropField = save('finish-overhead-crop-field', await lab.crop(top.buf, [880, 180, 200, 140], 4));
  await page.mouse.move(640, 450); await page.mouse.down(); await page.mouse.move(640, 250, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(300);
  res.overhead.dragBackUp = await lab.diff(top2, await page.screenshot());
  await page.assertSameLoad('finish');
  res.console = log;
  await context.close();
  return res;
}

/**
 * Installed before the app's scripts for the glint section. three.js announces its renderer on
 * window.__THREE_DEVTOOLS__ (its devtools hook); wrapping that renderer's render() lets this
 * read the frame the app has just drawn (gl.readPixels: the real rendered output) and then draw
 * a second, measuring frame with the same camera and sun: everything hidden but the pieces, the
 * glaze pure green, the gold pure magenta. That mask says which pixels are gold. (By colour
 * alone the honey-ochre glaze and the gold are too close to tell apart reliably.) Nothing in
 * src/ is touched; the app's next frame is drawn normally.
 */
function glintProbe() {
  window.__THREE_DEVTOOLS__ = new EventTarget();
  window.__THREE_DEVTOOLS__.addEventListener('observe', e => {
    const r = e.detail;
    if (!r || !r.isWebGLRenderer || window.__probeRenderer) return;
    window.__probeRenderer = r;
    const render = r.render.bind(r);
    r.render = (scene, camera) => {
      render(scene, camera);
      const job = window.__probeJob;
      if (!job || !scene.isScene || !camera.isPerspectiveCamera) return;
      window.__probeJob = null;
      const gl = r.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const real = new Uint8Array(W * H * 4), mask = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, real);
      const undo = [];
      scene.traverse(o => {
        if (!o.isMesh) return;
        const m = o.material, glaze = o.name === 'pieces-glaze', gold = o.name === 'pieces-gold';
        if (glaze || gold) {
          const c = m.color.clone(), em = m.emissive.clone(), k = m.envMapIntensity;
          undo.push(() => { m.color.copy(c); m.emissive.copy(em); m.envMapIntensity = k; });
          m.color.setRGB(0, 0, 0); m.emissive.setRGB(gold ? 1 : 0, glaze ? 1 : 0, gold ? 1 : 0); m.envMapIntensity = 0;
        } else if (o.visible) { o.visible = false; undo.push(() => { o.visible = true; }); }
      });
      const bg = scene.background, fn = scene.fog.near, ff = scene.fog.far;
      scene.background = null; scene.fog.near = 1e6; scene.fog.far = 1e7;
      render(scene, camera);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      scene.background = bg; scene.fog.near = fn; scene.fog.far = ff;
      for (const u of undo) u();
      // Against the reference frame: gold pixels ≥40 luma brighter ("flash"), glaze pixels that
      // lost ≥0.15 saturation while getting lighter ("wash")
      if (job.setRef) window.__ref = real;
      const R = window.__ref;
      let gold = 0, glaze = 0, flash = 0, wash = 0;
      const sl = (d, i) => { const a = d[i], b = d[i + 1], c = d[i + 2], mx = Math.max(a, b, c), mn = Math.min(a, b, c); return [mx ? (mx - mn) / mx : 0, 0.2126 * a + 0.7152 * b + 0.0722 * c]; };
      for (let i = 0; i < real.length; i += 4) {
        const isGold = mask[i] > 90 && mask[i + 2] > 90 && mask[i + 1] < mask[i] - 40;
        const isGlaze = mask[i + 1] > 90 && mask[i + 1] > mask[i] + 40 && mask[i + 1] > mask[i + 2] + 40;
        if (!isGold && !isGlaze) continue;
        const [s1, l1] = sl(real, i), [s0, l0] = sl(R, i);
        if (isGold) { gold++; if (l1 - l0 >= 40) flash++; } else { glaze++; if (s0 - s1 >= 0.15 && l1 > l0) wash++; }
      }
      let sun = null; scene.traverse(o => { if (o.isDirectionalLight) sun = o; });
      job.resolve({ gold, glaze, flash, wash, sunElevDeg: +(Math.atan2(sun.position.y, Math.hypot(sun.position.x, sun.position.z)) * 180 / Math.PI).toFixed(1) });
    };
  });
  window.__probe = (opts = {}) => new Promise(resolve => { window.__probeJob = { ...opts, resolve }; });
}

/** The light sweep measured on still views: does the gold flash while the glaze stays put? */
async function sectionGlint(browser, base) {
  const res = {};
  for (const view of ['finished', 'overhead']) {
    const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const log = collectConsole(page);
    await page.addInitScript(instruments);
    await page.addInitScript(glintProbe);
    await page.goto(base, { waitUntil: 'commit' });
    await waitReady(page);
    await page.waitForTimeout(1500);   // reduced motion: the finished panel, framed, still
    if (view === 'overhead') {
      await page.mouse.move(640, 120); await page.mouse.down(); await page.mouse.move(640, 760, { steps: 25 }); await page.mouse.up();
      await page.waitForTimeout(800);
    }
    const rest = await page.evaluate(() => window.__probe({ setRef: true }));
    const restShot = await shot(page, `glint-${view}-rest`);
    await page.click('#sweep');
    const t0 = Date.now(), rows = [];
    let peak = { flash: -1 }, peakShot = null;
    while (Date.now() - t0 < SWEEP_SECONDS * 1000 + SWEEP_MARGIN) {
      const r = await page.evaluate(() => window.__probe());
      rows.push({ t: +((Date.now() - t0) / 1000).toFixed(2), ...r });
      if (r.flash > peak.flash) { peak = rows.at(-1); peakShot = await page.screenshot(); }
    }
    const end = await page.evaluate(() => window.__probe());
    save(`glint-${view}-peak`, peakShot);
    res[view] = {
      goldPx: rest.gold, glazePx: rest.glaze, restShot: restShot.path, peakShot: `capture/app/glint-${view}-peak.png`,
      peakFlash: peak.flash, peakFlashAt: peak.t, washAtPeakFlash: peak.wash,
      worstWash: Math.max(...rows.map(r => r.wash)), lowestSunDeg: Math.min(...rows.map(r => r.sunElevDeg)),
      highestSunDeg: Math.max(...rows.map(r => r.sunElevDeg)),
      backAtRest: { flash: end.flash, wash: end.wash },   // the sun is back: nothing should differ
      frames: rows.length,
    };
    res[view + 'Console'] = log;
    await context.close();
  }
  return res;
}

/**
 * Installed before the app's scripts for the glint-motion section. Like glintProbe, it wraps the
 * renderer three.js announces on its devtools hook; it also logs the sun and the camera on every
 * frame the app draws. On request, right after the app's own frame it reads that frame, draws it
 * AGAIN with the sun at its rest position (and the shadow box fitted for it, as anim/light.js
 * fitShadow would), then the gold/glaze mask frame. Flash and wash are counted against the
 * rest-sun copy of the same frame: with normal motion the camera keeps moving (the fly-out
 * after Finish, the slow turn), so the frame before the sweep is no reference. Afterwards the
 * shadow map is marked for redrawing, so the app's next frame is its own again.
 * @param K the rest pose and shadow-fit constants (anim/light.js SUN), and the rest direction
 */
function motionProbe(K) {
  window.__sunLog = [];   // [frame time, sun x, y, z, camera x, y, z]
  window.__restU = K.restU;
  window.__THREE_DEVTOOLS__ = new EventTarget();
  window.__THREE_DEVTOOLS__.addEventListener('observe', e => {
    const r = e.detail;
    if (!r || !r.isWebGLRenderer || window.__probeRenderer) return;
    window.__probeRenderer = r;
    const render = r.render.bind(r);
    let sun = null;
    r.render = (scene, camera) => {
      render(scene, camera);
      if (!(scene.isScene && camera.isPerspectiveCamera && scene.fog)) return;
      if (!sun) scene.traverse(o => { if (o.isDirectionalLight) sun = o; });
      const p = sun.position, c = camera.position;
      window.__sunLog.push([document.timeline.currentTime ?? performance.now(), p.x, p.y, p.z, c.x, c.y, c.z]);
      if (window.__sunLog.length > 30000) window.__sunLog.splice(0, 10000);
      const job = window.__probeJob;
      if (!job) return;
      window.__probeJob = null;
      const gl = r.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const real = new Uint8Array(W * H * 4), ref = new Uint8Array(W * H * 4), mask = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, real);
      // The same frame, sun at rest
      const sc = sun.shadow.camera, saved = { pos: p.clone(), near: sc.near, far: sc.far, bias: sun.shadow.bias };
      const re = Math.atan(K.REST_SLOPE), R = K.DISTANCE;
      p.set(Math.cos(K.REST_ANGLE) * R * Math.cos(re), Math.sin(re) * R, Math.sin(K.REST_ANGLE) * R * Math.cos(re));
      const depth = sc.right / Math.max(Math.sin(re), K.SHADOW_MIN_SIN) + K.SHADOW_DEPTH_PAD;
      sc.near = R - depth; sc.far = R + depth; sc.updateProjectionMatrix();
      sun.shadow.bias = -K.SHADOW_BIAS_WORLD / (sc.far - sc.near);
      r.shadowMap.needsUpdate = true;
      render(scene, camera);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, ref);
      p.copy(saved.pos); sc.near = saved.near; sc.far = saved.far; sc.updateProjectionMatrix(); sun.shadow.bias = saved.bias;
      // The mask: gold magenta, glaze green, everything else hidden
      const undo = [];
      scene.traverse(o => {
        if (!o.isMesh) return;
        const m = o.material, glaze = o.name === 'pieces-glaze', gold = o.name === 'pieces-gold';
        if (glaze || gold) {
          const cc = m.color.clone(), em = m.emissive.clone(), k = m.envMapIntensity;
          undo.push(() => { m.color.copy(cc); m.emissive.copy(em); m.envMapIntensity = k; });
          m.color.setRGB(0, 0, 0); m.emissive.setRGB(gold ? 1 : 0, glaze ? 1 : 0, gold ? 1 : 0); m.envMapIntensity = 0;
        } else if (o.visible) { o.visible = false; undo.push(() => { o.visible = true; }); }
      });
      const bg = scene.background, fn = scene.fog.near, ff = scene.fog.far;
      scene.background = null; scene.fog.near = 1e6; scene.fog.far = 1e7; r.shadowMap.needsUpdate = false;
      render(scene, camera);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      scene.background = bg; scene.fog.near = fn; scene.fog.far = ff;
      for (const u of undo) u();
      r.shadowMap.needsUpdate = true;
      // Gold ≥40 luma brighter than with the sun at rest ("flash"); glaze that lost ≥0.15
      // saturation while getting lighter ("wash"); flash counted per cell of a 16 × 10 grid too
      const GX = 16, GY = 10, grid = new Array(GX * GY).fill(0);
      const sl = (d, i) => { const a = d[i], b = d[i + 1], cc = d[i + 2], mx = Math.max(a, b, cc), mn = Math.min(a, b, cc); return [mx ? (mx - mn) / mx : 0, 0.2126 * a + 0.7152 * b + 0.0722 * cc]; };
      let gold = 0, glaze = 0, flash = 0, wash = 0;
      for (let i = 0; i < real.length; i += 4) {
        const isGold = mask[i] > 90 && mask[i + 2] > 90 && mask[i + 1] < mask[i] - 40;
        const isGlaze = mask[i + 1] > 90 && mask[i + 1] > mask[i] + 40 && mask[i + 1] > mask[i + 2] + 40;
        if (!isGold && !isGlaze) continue;
        const [s1, l1] = sl(real, i), [s0, l0] = sl(ref, i);
        if (isGold) {
          gold++;
          if (l1 - l0 >= 40) { flash++; const q = i / 4, x = q % W, y = H - 1 - Math.floor(q / W); grid[Math.floor(y * GY / H) * GX + Math.floor(x * GX / W)]++; }
        } else { glaze++; if (s0 - s1 >= 0.15 && l1 > l0) wash++; }
      }
      window.__probed = { W, H, real, ref };
      const deg = 180 / Math.PI;
      job.resolve({ gold, glaze, flash, wash, grid, sun: +(Math.atan2(p.y, Math.hypot(p.x, p.z)) * deg).toFixed(1),
        cam: +(Math.atan2(c.y, Math.hypot(c.x, c.z)) * deg).toFixed(1) });
    };
  });
  window.__probe = () => new Promise(res => { window.__probeJob = { resolve: res }; });
  /** PNG (base64) of the last probed frame: the real one, or its rest-sun copy. */
  window.__probedPng = which => {
    const { W, H } = window.__probed, px = window.__probed[which];
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    g.putImageData(img, 0, 0);
    return cv.toDataURL('image/png').split(',')[1];
  };
  /** Is the sun at its rest position? (the newest logged frame, or the last n frames) */
  window.__sunAtRest = (n = 1) => {
    const l = window.__sunLog;
    if (l.length < n) return false;
    return l.slice(-n).every(([, x, y, z]) => { const L = Math.hypot(x, y, z); return Math.hypot(x / L - window.__restU[0], y / L - window.__restU[1], z / L - window.__restU[2]) < 1e-4; });
  };
}

/** The light sweep with normal motion: Finish by a real click (tap), then the automatic sweep. */
async function sectionGlintMotion(browser, base, lab) {
  const restElev = Math.atan(SUN.REST_SLOPE);
  const K = { REST_ANGLE: SUN.REST_ANGLE, REST_SLOPE: SUN.REST_SLOPE, DISTANCE: SUN.DISTANCE, SHADOW_MIN_SIN: SUN.SHADOW_MIN_SIN,
    SHADOW_DEPTH_PAD: SUN.SHADOW_DEPTH_PAD, SHADOW_BIAS_WORLD: SUN.SHADOW_BIAS_WORLD,
    restU: [Math.cos(SUN.REST_ANGLE) * Math.cos(restElev), Math.sin(restElev), Math.sin(SUN.REST_ANGLE) * Math.cos(restElev)] };
  // Pass marks. Before the fix the desktop Finish path washed 50,284 glaze px (9% of the glaze on
  // screen) with the sun at 77°; still views wash ~0.5-1.5%
  const LIMIT = { washShare: 0.015, flashShare: 0.03, lowestSunDeg: SWEEP_FLOOR * 180 / Math.PI - 0.1, stepDeg: 2.5 };
  const res = { limits: LIMIT };
  const paths = [
    ['desktop', { viewport: { width: W, height: H }, deviceScaleFactor: 1 }, page => page.click('#finish')],
    ['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, page => page.tap('#finish')],
  ];
  for (const [name, ctx, pressFinish] of paths) {
    const context = await browser.newContext(ctx);
    const page = await context.newPage();
    const log = collectConsole(page);
    await page.addInitScript(instruments);
    await page.addInitScript(motionProbe, K);
    await page.goto(base, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__loadId !== undefined);
    const loadId = await page.evaluate(() => window.__loadId);
    await waitReady(page);
    await page.waitForTimeout(300);
    await pressFinish(page);
    if (name === 'desktop') await page.mouse.move(W - 30, 30);   // off the button
    // The automatic sweep starts SWEEP_DELAY after the last piece lands
    await page.waitForFunction(() => !window.__sunAtRest(), null, { timeout: 15000, polling: 'raf' });
    const start = await page.evaluate(() => { const l = window.__sunLog; for (let i = l.length - 1; i > 0; i--) { const [, x, y, z] = l[i - 1]; const L = Math.hypot(x, y, z); if (Math.hypot(x / L - window.__restU[0], y / L - window.__restU[1], z / L - window.__restU[2]) < 1e-4) return l[i][0]; } return l[0][0]; });
    const rows = [], sheet = [];
    let worst = null, peak = null, nextSheet = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < (SWEEP_SECONDS + 15) * 1000) {
      const r = await page.evaluate(() => window.__probe());
      const t = +(((await page.evaluate(() => performance.now())) - start) / 1000).toFixed(2);
      rows.push({ t, flash: r.flash, wash: r.wash, sun: r.sun, cam: r.cam, gold: r.gold, glaze: r.glaze });
      if (!worst || r.wash > worst.wash) worst = { t, ...r, png: await page.evaluate(() => window.__probedPng('real')) };
      if (!peak || r.flash > peak.flash) peak = { t, ...r, png: await page.evaluate(() => window.__probedPng('real')), refPng: await page.evaluate(() => window.__probedPng('ref')) };
      if (t >= nextSheet) { sheet.push({ label: `t=${t}s flash ${r.flash} wash ${r.wash} sun ${r.sun}°`, png: await page.evaluate(() => window.__probedPng('real')) }); nextSheet = t + 1.4; }
      if (t > 3 && await page.evaluate(() => window.__sunAtRest(12))) break;
      await sleep(60);
    }
    // The sun frame by frame (normal frames only: a probed frame is slow, and the next frame's
    // step is the app's capped catch-up, not a jump)
    const sunLog = await page.evaluate(s => window.__sunLog.filter(r => r[0] >= s - 100), start);
    let maxStep = 0, maxStepAt = 0, lowest = 90, highest = -90;
    for (let i = 0; i < sunLog.length; i++) {
      const [tt, x, y, z] = sunLog[i], L = Math.hypot(x, y, z), el = Math.asin(y / L) * 180 / Math.PI;
      lowest = Math.min(lowest, el); highest = Math.max(highest, el);
      if (i === 0 || tt - sunLog[i - 1][0] > 25) continue;
      const [, a, b, c] = sunLog[i - 1], M = Math.hypot(a, b, c);
      const step = Math.acos(Math.min(1, (x * a + y * b + z * c) / (L * M))) * 180 / Math.PI;
      if (step > maxStep) { maxStep = step; maxStepAt = (tt - start) / 1000; }
    }
    const sweepEnd = sunLog.filter(([, x, y, z]) => { const L = Math.hypot(x, y, z); return Math.hypot(x / L - K.restU[0], y / L - K.restU[1], z / L - K.restU[2]) >= 1e-4; }).at(-1)?.[0];
    // Images: the worst-wash frame, the glint at its peak against the same frame with the sun at
    // rest (cropped where the gold flashed most, ×3), and the sweep as a contact sheet
    const shotWorst = save(`glint-motion-${name}-worst-wash`, Buffer.from(worst.png, 'base64'));
    const { W: fw, H: fh } = await page.evaluate(() => ({ W: window.__probed.W, H: window.__probed.H }));
    const GX = 16, GY = 10, k = peak.grid.indexOf(Math.max(...peak.grid));
    const cw = Math.round(fw * 0.19), ch = Math.round(fh * 0.2);
    const cx = (k % GX + 0.5) * fw / GX, cy = (Math.floor(k / GX) + 0.5) * fh / GY;
    const box = [Math.max(0, Math.min(fw - cw, Math.round(cx - cw / 2))), Math.max(0, Math.min(fh - ch, Math.round(cy - ch / 2))), cw, ch];
    const pair = [await lab.crop(Buffer.from(peak.refPng, 'base64'), box, 3), await lab.crop(Buffer.from(peak.png, 'base64'), box, 3)];
    pair.labels = ['sun at rest (same frame)', `glint t=${peak.t}s`];
    const shotPair = save(`glint-motion-${name}-glint-pair`, await lab.sheet(pair, 2, 600));
    const strip = sheet.map(f => Buffer.from(f.png, 'base64')); strip.labels = sheet.map(f => f.label);
    const shotSheet = save(`glint-motion-${name}-sheet`, await lab.sheet(strip, 4, name === 'phone' ? 240 : 400));
    const glazeOnScreen = Math.max(...rows.map(r => r.glaze)), goldOnScreen = Math.max(...rows.map(r => r.gold));
    const out = {
      worstWash: worst.wash, worstWashAt: worst.t, worstWashSunDeg: worst.sun, worstWashCameraDeg: worst.cam,
      washShare: +(worst.wash / glazeOnScreen).toFixed(4),
      peakFlash: peak.flash, peakFlashAt: peak.t, washAtPeakFlash: peak.wash, flashShare: +(peak.flash / goldOnScreen).toFixed(4),
      sunDeg: [+lowest.toFixed(1), +highest.toFixed(1)], cameraDeg: [rows[0].cam, rows.at(-1).cam],
      maxSunStepDegPerFrame: +maxStep.toFixed(3), maxStepAt: +maxStepAt.toFixed(2),
      sweepSeconds: sweepEnd ? +((sweepEnd - start) / 1000).toFixed(1) : null, probes: rows.length,
      shots: { worstWash: shotWorst, glintPair: shotPair, sheet: shotSheet },
      rows: rows.map(r => [r.t, r.flash, r.wash, r.sun, r.cam]),
    };
    out.pass = {
      wash: out.washShare <= LIMIT.washShare, flash: out.flashShare >= LIMIT.flashShare,
      sunNeverUnderTheDip: lowest >= LIMIT.lowestSunDeg, noJump: maxStep <= LIMIT.stepDeg,
    };
    res[name] = out;
    res[name + 'Console'] = log;
    if (await page.evaluate(() => window.__loadId) !== loadId) throw new Error('page reloaded during glint-motion (dev server HMR?): rerun');
    await context.close();
  }
  return res;
}

/** Every control through real input, judged from pixels and the HUD text. */
async function sectionInput(browser, base, lab) {
  const { page, log, context } = await openPage(browser, base);
  const res = {};
  await waitReady(page);
  const N = (await readHud(page)).total;

  // Speed: each click steps 1 → 2 → 4 → 8 → 1. The rate is measured as sim seconds per wall
  // second, from the landed counter and the schedule's (public) timing curve.
  await waitCount(page, 60);
  const rate = async ms => {
    const a = await readHud(page); await page.waitForTimeout(ms); const b = await readHud(page);
    return +((simAtLanded(b.n, N) - simAtLanded(a.n, N)) / ((b.now - a.now) / 1000)).toFixed(2);
  };
  res.speed = [{ label: (await readHud(page)).speed, simPerSecond: await rate(1500) }];
  for (let k = 0; k < 3; k++) {
    await page.click('#speed');
    const label = (await readHud(page)).speed;
    const r = await rate(1500);
    res.speed.push({ label, simPerSecond: r });
    if (label === 'Speed 8×') {
      const t = (await readHud(page)).now;
      await page.waitForTimeout(2000);
      res.fpsAt8x = { ...(await frameStats(page, t, t + 2000)), n: (await readHud(page)).n };
    }
  }
  await page.click('#speed');
  res.speed.push({ label: (await readHud(page)).speed });

  // Finish, then wait out the automatic sweep so later comparisons see a still scene
  await page.click('#finish');
  res.finish = await readHud(page);
  await page.waitForTimeout((SWEEP_DELAY + SWEEP_SECONDS) * 1000 + SWEEP_MARGIN);
  const rest = await shot(page, 'input-rest');

  // Sweep light: the sun moves, so the shading changes
  await page.click('#sweep');
  await page.waitForTimeout(3000);
  const sw = await shot(page, 'input-sweep-3s');
  res.sweep = { shot: sw.path, vsRest: await lab.diff(rest.buf, sw.buf) };
  await page.waitForTimeout((SWEEP_SECONDS - 3) * 1000 + SWEEP_MARGIN);
  const rest2 = await shot(page, 'input-rest-2');
  res.sweep.afterEndVsRest = await lab.diff(rest.buf, rest2.buf);

  // Sound: the button toggles (the clicks themselves cannot be heard headless)
  await page.click('#sound');
  res.sound = { on: await readHud(page) };
  await page.click('#sound');
  res.sound.off = await readHud(page);

  // Wheel over the canvas: zoom out
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  const wh = await shot(page, 'input-wheel');
  res.wheel = { shot: wh.path, vsRest: await lab.diff(rest2.buf, wh.buf) };
  // Drag sideways: turn
  await page.mouse.move(400, 400); await page.mouse.down(); await page.mouse.move(700, 400, { steps: 15 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const dr = await shot(page, 'input-drag');
  res.drag = { shot: dr.path, vsWheel: await lab.diff(wh.buf, dr.buf) };
  // Double-click: back to the automatic view (only the slow automatic turn differs)
  await page.mouse.dblclick(640, 400);
  await page.waitForTimeout(300);
  const dc = await shot(page, 'input-dblclick');
  res.dblclick = { shot: dc.path, vsRest: await lab.diff(rest2.buf, dc.buf), dragVsRest: await lab.diff(rest2.buf, dr.buf) };

  // Replay: back to the bare bed, then the opening again
  await page.click('#replay');
  await page.waitForTimeout(150);
  res.replay = { right: await readHud(page) };
  const rp = await shot(page, 'input-replay');
  await page.waitForTimeout(3000);
  res.replay.after3s = await readHud(page);
  const rp3 = await shot(page, 'input-replay-3s');
  res.replay.shots = [rp.path, rp3.path];
  await page.assertSameLoad('input');
  res.console = log;
  await context.close();
  return res;
}

/**
 * The hardest case for shadow acne: zoomed right in on the finished panel, where one shadow
 * texel (the box still covers the whole panel) spans several screen pixels. Real wheel zoom,
 * then the Sweep light button (low raking sun, then the glint), then a drag to overhead.
 */
async function sectionCloseup(browser, base, lab) {
  const { page, log, context } = await openPage(browser, base);
  const res = {};
  await waitReady(page);
  await page.click('#finish');
  await page.waitForTimeout((SWEEP_DELAY + SWEEP_SECONDS) * 1000 + SWEEP_MARGIN);   // let the automatic sweep finish
  await page.mouse.move(640, 400);
  for (let k = 0; k < 6; k++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(50); }   // to the zoom limit
  await page.waitForTimeout(300);
  res.rest = (await shot(page, 'closeup-rest')).path;
  await page.click('#sweep');
  const t = (await readHud(page)).now;
  await waitPageTime(page, t + 0.3 * SWEEP_SECONDS * 1000);   // the sun's low point (viewer's side)
  const low = await shot(page, 'closeup-sweep-low');
  res.lowSun = { shot: low.path, crop: save('closeup-sweep-low-crop', await lab.crop(low.buf, [480, 300, 320, 200], 3)) };
  // Around the glint (the full-panel run peaks near p ≈ 0.58). No pixel metric here: at this
  // zoom the brightly lit ochre glaze fills the same hue bucket as gold, so look at the sheet.
  const moments = [];
  for (const p of [0.525, 0.575, 0.625]) {
    await waitPageTime(page, t + p * SWEEP_SECONDS * 1000);
    moments.push(await page.screenshot());
  }
  moments.labels = ['p=0.525', 'p=0.575', 'p=0.625'];
  res.glintSheet = save('closeup-glint-sheet', await lab.sheet(moments, 3, 640));
  await page.waitForTimeout(SWEEP_SECONDS * 300 + SWEEP_MARGIN);
  await page.mouse.move(640, 250); await page.mouse.down(); await page.mouse.move(640, 690, { steps: 25 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const top = await shot(page, 'closeup-overhead');
  res.overhead = { shot: top.path, crop: save('closeup-overhead-crop', await lab.crop(top.buf, [480, 300, 320, 200], 3)) };
  await page.assertSameLoad('closeup');
  res.console = log;
  await context.close();
  return res;
}

/** The prototype's square tesserae, kept at ?legacy=1 for side-by-side comparison. */
async function sectionLegacy(browser, base) {
  const { page, log, context } = await openPage(browser, base + '?legacy=1');
  await waitReady(page);
  await waitPageTime(page, 2500);
  const res = { opening: (await shot(page, 'legacy-opening')).path, hud: await readHud(page) };
  res.subtitle = await page.evaluate(() => document.getElementById('sub').textContent);
  await page.click('#finish');
  await page.waitForTimeout(4000);
  res.finished = { shot: (await shot(page, 'legacy-finished')).path, hud: await readHud(page) };
  await page.assertSameLoad('legacy');
  res.console = log;
  await context.close();
  return res;
}

async function sectionReduced(browser, base, lab) {
  const { page, log, context } = await openPage(browser, base, { reducedMotion: 'reduce' });
  await waitReady(page);
  await page.waitForTimeout(800);
  const a = await shot(page, 'reduced-motion');
  const hudA = await readHud(page);
  await page.waitForTimeout(4000);   // an automatic sweep would have started 1.2 s after landing
  const b = await shot(page, 'reduced-motion-4s');
  const res = { hud: hudA, shot: a.path, after4sVsFirst: await lab.diff(a.buf, b.buf), console: log };
  await page.assertSameLoad('reduced');
  await context.close();
  return res;
}

async function sectionPhone(browser, base) {
  const { page, log, context } = await openPage(browser, base,
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const res = {};
  await waitReady(page);
  await waitPageTime(page, 5000);
  res.opening = { shot: (await shot(page, 'phone-opening')).path, hud: await readHud(page) };
  // The HUD's boxes against the panel's centre (the camera looks at the centre, so it is the
  // middle of the screen): the clearance is the distance from the centre to the nearest box.
  res.hudBoxes = await page.evaluate(() => {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    return [...document.querySelectorAll('.pill')].map(el => {
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - cx, 0, cx - r.right), dy = Math.max(r.top - cy, 0, cy - r.bottom);
      return { box: [r.left, r.top, r.right, r.bottom].map(Math.round), coversCentre: dx === 0 && dy === 0, clearancePx: Math.round(Math.hypot(dx, dy)) };
    });
  });
  await page.tap('#finish');
  await page.waitForTimeout((SWEEP_DELAY + SWEEP_SECONDS) * 1000 + SWEEP_MARGIN);
  res.finished = { shot: (await shot(page, 'phone-finished')).path, hud: await readHud(page) };
  res.fps = await page.evaluate(() => { const t = window.__frameTimes; const k = t.length - 1; const a = t.findIndex(x => x >= t[k] - 2000); return +((k - a) / ((t[k] - t[a]) / 1000)).toFixed(1); });
  await page.assertSameLoad('phone');
  res.console = log;
  await context.close();
  return res;
}

async function sectionBuild(browser, lab) {
  const res = {};
  const t = Date.now();
  execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
  res.buildSeconds = +((Date.now() - t) / 1000).toFixed(1);
  res.distFiles = readdirSync(resolve(ROOT, 'dist'));
  res.bytes = statSync(resolve(ROOT, 'dist/index.html')).size;
  const { page, log, context } = await openPage(browser, 'file://' + resolve(ROOT, 'dist/index.html'));
  await waitReady(page);
  res.startup = await page.evaluate(() => { const s = { ...window.__startup }; delete s.pieceStats; delete s.composeSteps; return s; });
  await waitPageTime(page, 5000);
  res.opening = (await shot(page, 'build-file-opening')).path;
  await page.click('#finish');
  await page.waitForTimeout(1500);
  const f = await shot(page, 'build-file-finished');
  res.finished = { shot: f.path, hud: await readHud(page) };
  res.console = log;
  await context.close();

  // The fallback: a page where workers cannot start (as under a strict content policy) must
  // still compose the panel, on the main thread, and say so once in the console.
  const blocked = await openPage(browser, 'file://' + resolve(ROOT, 'dist/index.html'));
  await blocked.context.addInitScript(() => { window.Worker = function () { throw new Error('workers blocked (test)'); }; });
  await blocked.page.reload({ waitUntil: 'commit' });
  await waitReady(blocked.page);
  res.workerBlocked = {
    startup: await blocked.page.evaluate(() => ({ composeOnMainThread: window.__startup.composeOnMainThread, composeMs: window.__startup.composeMs, ready: window.__startup.ready })),
    hud: await readHud(blocked.page),
    console: blocked.log,
  };
  await blocked.context.close();
  return res;
}

// ------------------------------------------------------------------ main

let server = null;
const base = opt('base', null) ?? `http://localhost:${PORT}/`;
const browser = await launch();
try {
  if (!opt('base', null) && ONLY.some(s => s !== 'build')) {
    const t = Date.now();
    server = await startServer();
    summary.serverColdStartMs = Date.now() - t;
  }
  const lab = await makeLab(browser);
  const sections = { run: () => sectionRun(browser, base, lab), finish: () => sectionFinish(browser, base, lab),
    glint: () => sectionGlint(browser, base), 'glint-motion': () => sectionGlintMotion(browser, base, lab),
    closeup: () => sectionCloseup(browser, base, lab), legacy: () => sectionLegacy(browser, base),
    input: () => sectionInput(browser, base, lab), reduced: () => sectionReduced(browser, base, lab),
    phone: () => sectionPhone(browser, base), build: () => sectionBuild(browser, lab) };
  for (const name of ONLY) {
    const t = Date.now();
    process.stdout.write(`${name} … `);
    try {
      summary.sections[name] = await sections[name]();
      console.log(`done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    } catch (err) {
      summary.sections[name] = { error: String(err.stack || err) };
      console.log('FAILED: ' + err.message);
    }
  }
} finally {
  await browser.close();
  if (server) server.kill();
}
// Remove the scratch frame of the contact sheet
try { (await import('fs')).unlinkSync(`${OUT}/run-strip-tmp.png`); } catch { /* none */ }
writeFileSync(`${OUT}/verify.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
