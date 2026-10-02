// Compares the port (http://localhost:5193/) against the r128 prototype
// (/reference/prototype.html) frame for frame, then checks the port with real input.
//
//   node scripts/compare-port.mjs [base=http://localhost:5193] [--only compare|input|phone]
//
// 1. compare: both pages get the same virtual clock (requestAnimationFrame and
//    performance.now are replaced before any page script runs), so they step through
//    exactly the same frames with dt = 1/60 s and land on the same simulation state. At
//    each checkpoint we screenshot both (HUD hidden for the numbers, shown for the
//    composites) and measure the mean absolute pixel difference, the mean signed
//    difference per channel (a tone or brightness shift shows up here), and the share of
//    pixels that differ by more than 24/255.
//    Output: capture/port/<name>-side.png (prototype | port), <name>-diff.png (|diff| × 4).
//
//    The port deliberately fixes one prototype bug: the slab under the bed had its top 0.01
//    under the mortar, so it z-fought through the bed and grout in flat, blocky patches (see
//    BED.UNDER_TOP in src/scene/bed.js). So the port is measured twice: against the
//    prototype as it is ("raw"), and against the prototype with the same slab fix injected
//    ("fixed"; reference/prototype.html is not edited). "fixed" is the port-equivalence number.
// 2. input: real mouse clicks on the HUD buttons, a real pointer drag, wheel and
//    double-click on the canvas, measured from rendered pixels.
// 3. phone: a 390×844 portrait viewport at the opening and the finished panel.
import { mkdirSync, writeFileSync } from 'fs';
import { launch, collectConsole } from './lib/browser.mjs';

const args = process.argv.slice(2);
const BASE = (args.find(a => a.startsWith('http')) || 'http://localhost:5193').replace(/\/$/, '');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const OUT = 'capture/port';
const W = 1280, H = 800;
mkdirSync(OUT, { recursive: true });

const PAGES = { proto: `${BASE}/reference/prototype.html`, port: `${BASE}/` };

// Checkpoints. `seek` jumps the sim clock, then `frames` frames run at 1/60 s, so the camera
// has time to ease. T_END ≈ 47.45 s; the finale sweep starts 1.2 s later and lasts 11 s.
const CHECKPOINTS = [
  { name: 'a-opening-2s', frames: 120 },                    // sim 2.0
  { name: 'b-rings-12s', seek: 8, frames: 240 },            // sim 12
  { name: 'c-field-30s', seek: 26, frames: 240 },           // sim 30
  { name: 'd-complete-50s', seek: 46, frames: 240 },        // sim 50: done, sweep just begun
  { name: 'e-sweep-mid', frames: 249 },                     // sim ≈ 54.15: sweep halfway, sun low
  { name: 'f-after-sweep', frames: 450 },                   // sim ≈ 61.65: sweep over
];

/**
 * Runs in the prototype page before its scripts: when three r128 publishes BoxGeometry,
 * swap in a version that makes the 114 × 0.6 × 114 under-bed slab 0.12 tall, so (centred
 * at y = -0.31 as before) its top sits at -0.25 like the port's.
 */
function prototypeSlabFix() {
  let three;
  Object.defineProperty(window, 'THREE', {
    configurable: true,
    get() { return three; },
    set(v) {
      three = v;
      let Box;
      Object.defineProperty(v, 'BoxGeometry', {
        configurable: true, enumerable: true,
        get() { return Box; },
        set(B) {
          Box = class extends B {
            constructor(w, h, d, ...rest) { super(w, w === 114 && h === 0.6 && d === 114 ? 0.12 : h, d, ...rest); }
          };
        },
      });
    },
  });
}

/** Runs in the page before its own scripts: a frame clock we step by hand. */
function virtualClock() {
  let now = 0, queue = [];
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
  window.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  window.__advance = (frames, dtMs = 1000 / 60) => {
    for (let i = 0; i < frames; i++) {
      now += dtMs;
      const q = queue; queue = [];
      for (const cb of q) cb(now);
    }
    return now;
  };
  window.__queued = () => queue.length;
}

const hud = (page, visible) => page.evaluate(v => {
  const el = document.querySelector('.hud');
  if (el) el.style.visibility = v ? '' : 'hidden';
}, visible);

async function openPage(browser, url, { virtual = false, slabFix = false, viewport = { width: W, height: H }, ...ctxOpts } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...ctxOpts });
  const page = await context.newPage();
  const log = collectConsole(page);
  if (virtual) await page.addInitScript(virtualClock);
  if (slabFix) await page.addInitScript(prototypeSlabFix);
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__seek === 'function', null, { timeout: 30000 });
  if (virtual) await page.waitForFunction(() => window.__queued() > 0);
  await page.evaluate(() => document.fonts.ready);
  // The Vite dev server reloads pages when watched files change (other agents edit this repo
  // too). A reload would silently restart the sequence, so mark the page and check the mark.
  await page.evaluate(() => { window.__runMark = 'compare-port'; });
  return { page, log, context };
}

async function assertNotReloaded(page, where) {
  const ok = await page.evaluate(() => window.__runMark === 'compare-port');
  if (!ok) throw new Error(`page reloaded during ${where} (dev server HMR?): rerun`);
}

// ---------- image maths, done in a blank page with a 2D canvas ----------

async function makeImageLab(browser) {
  const page = await browser.newPage();
  await page.setContent('<canvas id=x></canvas>');
  return {
    /** Stats for two PNG buffers, plus composite PNGs (as base64) to save. */
    async compare(a, b, labels) {
      return page.evaluate(async ({ a, b, labels }) => {
        const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + src; });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const w = ia.width, h = ia.height;
        const px = img => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h); };
        const da = px(ia).data, db = px(ib).data;
        let abs = 0, big = 0; const signed = [0, 0, 0], meanA = [0, 0, 0], meanB = [0, 0, 0];
        const diff = new ImageData(w, h);
        for (let i = 0; i < da.length; i += 4) {
          let m = 0;
          for (let c = 0; c < 3; c++) {
            const d = db[i + c] - da[i + c];
            abs += Math.abs(d); signed[c] += d; meanA[c] += da[i + c]; meanB[c] += db[i + c];
            m = Math.max(m, Math.abs(d));
            diff.data[i + c] = Math.min(255, Math.abs(d) * 4);
          }
          diff.data[i + 3] = 255;
          if (m > 24) big++;
        }
        const n = w * h, r1 = v => Math.round(v * 100) / 100;
        const side = document.createElement('canvas'); side.width = w * 2; side.height = h;
        const sg = side.getContext('2d');
        sg.drawImage(ia, 0, 0); sg.drawImage(ib, w, 0);
        sg.font = '600 18px ui-monospace, Menlo, monospace';
        labels.forEach((t, k) => { sg.fillStyle = 'rgba(0,0,0,.65)'; sg.fillRect(k * w + w / 2 - 110, 6, 220, 30); sg.fillStyle = '#fff'; sg.textAlign = 'center'; sg.fillText(t, k * w + w / 2, 28); });
        const dc = document.createElement('canvas'); dc.width = w; dc.height = h; dc.getContext('2d').putImageData(diff, 0, 0);
        return {
          mad: r1(abs / (n * 3)),
          signed: signed.map(s => r1(s / n)),
          meanProto: meanA.map(s => r1(s / n)),
          meanPort: meanB.map(s => r1(s / n)),
          bigPct: r1(100 * big / n),
          side: side.toDataURL('image/png').split(',')[1],
          diff: dc.toDataURL('image/png').split(',')[1],
        };
      }, { a: a.toString('base64'), b: b.toString('base64'), labels });
    },
    /** Mean absolute difference only (for the input checks). */
    async mad(a, b) { const r = await this.compare(a, b, ['', '']); return r.mad; },
  };
}

const save = (name, b64) => writeFileSync(`${OUT}/${name}`, Buffer.from(b64, 'base64'));

// ---------- 1. prototype vs port ----------

async function comparePages(browser, lab) {
  const pages = {
    proto: await openPage(browser, PAGES.proto, { virtual: true }),
    protoFixed: await openPage(browser, PAGES.proto, { virtual: true, slabFix: true }),
    port: await openPage(browser, PAGES.port, { virtual: true }),
  };
  const rows = [];
  const fmt = st => ({ mad: st.mad, signedRGB: st.signed.join(' '), over24pct: st.bigPct });
  for (const cp of CHECKPOINTS) {
    const shots = {};
    for (const [key, { page }] of Object.entries(pages)) {
      if (cp.seek !== undefined) await page.evaluate(t => window.__seek(t), cp.seek);
      await page.evaluate(f => window.__advance(f), cp.frames);
      await page.waitForTimeout(150);   // let the compositor present the last frame
      await assertNotReloaded(page, cp.name);
      await hud(page, true);
      const withHud = await page.screenshot();
      await hud(page, false);
      const bare = await page.screenshot();
      await hud(page, true);
      const text = await page.evaluate(() => ({ n: document.getElementById('n').textContent, stage: document.getElementById('stage').textContent }));
      shots[key] = { withHud, bare, text };
    }
    const raw = await lab.compare(shots.proto.bare, shots.port.bare, ['', '']);
    const fixed = await lab.compare(shots.protoFixed.bare, shots.port.bare, ['', '']);
    const pretty = await lab.compare(shots.proto.withHud, shots.port.withHud, ['prototype r128', 'port r186']);
    const prettyFixed = await lab.compare(shots.protoFixed.withHud, shots.port.withHud, ['prototype + slab fix', 'port r186']);
    save(`${cp.name}-side.png`, pretty.side);
    save(`${cp.name}-diff.png`, raw.diff);
    save(`${cp.name}-fixed-side.png`, prettyFixed.side);
    save(`${cp.name}-fixed-diff.png`, fixed.diff);
    const row = {
      checkpoint: cp.name,
      hud: `${shots.proto.text.n} ${shots.proto.text.stage} | ${shots.port.text.n} ${shots.port.text.stage}`,
      fixed: fmt(fixed),
      raw: fmt(raw),
      meanRGB: { proto: fixed.meanProto.join(' '), port: fixed.meanPort.join(' ') },
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const [proto, port] = [pages.proto, pages.port];
  console.log('console (prototype):', proto.log.length ? proto.log : 'clean');
  console.log('console (port):', port.log.length ? port.log : 'clean');
  for (const p of Object.values(pages)) await p.context.close();
  return rows;
}

// ---------- 2. real input on the port ----------

async function inputChecks(browser, lab) {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };
  const { page, log, context } = await openPage(browser, PAGES.port);
  const text = id => page.locator('#' + id).textContent();
  const count = async () => +(await text('n')).replace(/,/g, '');

  // Speed: four real clicks cycle 1→2→4→8→1; tiles land faster at 8×
  await page.waitForTimeout(1500);
  const seen = [];
  for (let i = 0; i < 4; i++) { await page.click('#speed'); seen.push(await text('speed')); }
  check('speed button cycles', seen.join(',') === 'Speed 2×,Speed 4×,Speed 8×,Speed 1×', seen.join(', '));
  const c1a = await count(); await page.waitForTimeout(1000); const c1b = await count();
  for (let i = 0; i < 3; i++) await page.click('#speed');   // → 8×
  const c8a = await count(); await page.waitForTimeout(1000); const c8b = await count();
  check('8× lays faster than 1×', (c8b - c8a) > 3 * (c1b - c1a), `1 s at 1×: +${c1b - c1a} tiles, 1 s at 8×: +${c8b - c8a} tiles`);
  await page.click('#speed');   // back to 1×

  // Finish: the HUD reaches the full count
  await page.click('#finish');
  await page.waitForTimeout(400);
  check('finish completes', (await text('stage')) === 'Complete' && (await text('n')) === '10,665', `${await text('n')} / ${await text('stage')}`);
  await page.screenshot({ path: `${OUT}/input-finished.png` });

  // Replay: back to the start
  await page.click('#replay');
  await page.waitForTimeout(300);
  const afterReplay = await count();
  check('replay restarts', afterReplay < 5, `count after replay: ${afterReplay}, stage "${await text('stage')}"`);
  await page.screenshot({ path: `${OUT}/input-replayed.png` });

  // Sound toggles aria-pressed (WebAudio starts inside the click)
  await page.click('#sound');
  check('sound toggles', (await page.getAttribute('#sound', 'aria-pressed')) === 'true' && (await text('sound')) === 'Sound on', await text('sound'));
  await page.click('#sound');

  // Orbit: measure against the scene's own drift. Finish, wait for the camera to settle
  // and the sweep to end, then compare (a) two frames 0.5 s apart with no input against
  // (b) before/after a real drag, wheel and double-click.
  await page.click('#finish');
  await page.waitForTimeout(15000);
  const box = await page.locator('#c').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const s0 = await page.screenshot(); await page.waitForTimeout(500); const s1 = await page.screenshot();
  const drift = await lab.mad(s0, s1);
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx - 25 * i, cy + 8 * i);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const s2 = await page.screenshot({ path: `${OUT}/input-dragged.png` });
  const dragged = await lab.mad(s1, s2);
  check('pointer drag turns the view', dragged > 4 * drift + 2, `MAD drift ${drift}, after drag ${dragged}`);
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(30); }
  await page.waitForTimeout(200);
  const s3 = await page.screenshot({ path: `${OUT}/input-wheeled.png` });
  const wheeled = await lab.mad(s2, s3);
  check('wheel zooms', wheeled > 4 * drift + 2, `MAD after wheel ${wheeled}`);
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(200);
  const s4 = await page.screenshot({ path: `${OUT}/input-reset.png` });
  const back = await lab.mad(s1, s4);
  check('double-click resets the view', back < dragged / 2, `MAD vs pre-drag frame ${back} (drag moved it by ${dragged})`);
  const pageScroll = await page.evaluate(() => [scrollX, scrollY]);
  check('wheel does not scroll the page', pageScroll[0] === 0 && pageScroll[1] === 0, JSON.stringify(pageScroll));

  await assertNotReloaded(page, 'input checks');
  const fps = await page.evaluate(() => window.__fps);
  check('__fps reported', fps > 0, `${fps} fps`);
  check('console clean', log.length === 0, log.length ? log.join(' | ') : 'no warnings or errors');
  await context.close();

  // Reduced motion: the finished panel at once, with no automatic sweep
  const rm = await openPage(browser, PAGES.port, { reducedMotion: 'reduce' });
  await rm.page.waitForTimeout(800);
  check('reduced motion shows the finished panel', (await rm.page.locator('#stage').textContent()) === 'Complete', await rm.page.locator('#stage').textContent());
  await rm.page.waitForTimeout(6000);
  await rm.page.screenshot({ path: `${OUT}/input-reduced-motion.png` });
  await rm.context.close();
  return results;
}

// ---------- 3. phone ----------

async function phoneChecks(browser) {
  for (const [name, url] of [['port', PAGES.port], ['proto', PAGES.proto]]) {
    const { page, log, context } = await openPage(browser, url, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, virtual: true });
    await page.evaluate(() => window.__advance(150));
    await page.screenshot({ path: `${OUT}/phone-${name}-opening.png` });
    await page.evaluate(() => { window.__seek(26); window.__advance(240); });
    await page.screenshot({ path: `${OUT}/phone-${name}-midway.png` });
    await page.evaluate(() => { window.__seek(46); window.__advance(300); });
    await assertNotReloaded(page, 'phone');
    await page.screenshot({ path: `${OUT}/phone-${name}-finished.png` });
    console.log(`phone ${name}: console`, log.length ? log : 'clean');
    await context.close();
  }
}

const browser = await launch();
const lab = await makeImageLab(browser);
if (!only || only === 'compare') await comparePages(browser, lab);
if (!only || only === 'input') await inputChecks(browser, lab);
if (!only || only === 'phone') await phoneChecks(browser);
await browser.close();
