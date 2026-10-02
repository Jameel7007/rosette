// Headless GPU checks for the zellige pieces (dev/pieces.html). Needs the dev server running:
//   npx vite --port 5192 --strictPort &
//   node scripts/check-pieces.mjs [http://localhost:5192] [--only pose,shots,fps]
//
// 1. pose:  GPU-posed pieces vs the prototype's CPU pose, pixel by pixel (positions, lighting
//           through the rotated normals, and the shadow pass), across the whole drop.
// 2. shots: screenshots into capture/pieces/ (look at them!).
// 3. fps:   requestAnimationFrame fps during the busiest drop and after landing, plus a
//           vsync-free GPU benchmark and the per-frame CPU time at 1,000 vs 12,000 pieces.
// Exits non-zero if any check fails or the console is not clean.
import { mkdirSync } from 'fs';
import { launch, collectConsole } from './lib/browser.mjs';

const args = process.argv.slice(2);
const base = args.find(a => a.startsWith('http')) ?? 'http://localhost:5192';
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const want = name => !onlyArg || onlyArg.includes(name);
const OUT = 'capture/pieces';
mkdirSync(OUT, { recursive: true });

const browser = await launch();
const failures = [];
const consoleLines = [];

async function open(query, { w = 1280, h = 800, dpr = 1 } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const log = collectConsole(page);
  await page.goto(`${base}/dev/pieces.html${query}`);
  await page.waitForFunction(() => window.__stats, null, { timeout: 60_000 });
  return { page, log, done: async () => { consoleLines.push(...log.map(l => `${query}: ${l}`)); await page.close(); } };
}

// ---------------------------------------------------------------- 1. pose check
if (want('pose')) {
  const { page, done } = await open('?check=pose', { w: 1240, h: 460 });
  await page.waitForFunction(() => window.__poseCheckResult, null, { timeout: 120_000 });
  const rows = await page.evaluate(() => window.__poseCheckResult);
  if (rows.error) failures.push('pose check threw: ' + rows.error);
  else {
    console.log('\nPose check: GPU vs prototype CPU pose (differPct = % of pixels off by > 3/255)');
    console.table(rows);
    for (const r of rows) {
      if (r.differPct > 0.5) failures.push(`pose ${r.shape} p=${r.p}: ${r.differPct}% pixels differ`);
      if (r.p >= 0 && r.coveragePct < 0.5) failures.push(`pose ${r.shape} p=${r.p}: piece not in frame`);
      if (r.p < 0 && r.coveragePct > 0) failures.push(`pose ${r.shape} p=${r.p}: unstarted piece drew ${r.coveragePct}%`);
    }
  }
  await page.screenshot({ path: `${OUT}/pose-check.png` });
  await done();
}

// ---------------------------------------------------------------- 2. screenshots
if (want('shots')) {
  const shots = [
    // (a) low-angle close-up mid-drop: tumbling pieces, moving shadows on bare mortar
    ['low-middrop-t12', '?view=low&t=12&pause=1'],
    ['low-middrop-t30', '?view=low&t=30&pause=1'],
    ['auto-opening', '?t=2.2&pause=1'],
    // (b) finished, straight overhead
    ['top-finished', '?view=top&t=60&pause=1'],
    // (c) gold under a low sun: three sun azimuths, gold-rich close view, then the normal mix
    ['gold-sun-70', '?view=gold&t=60&pause=1&goldShare=0.6&sunAz=-70&sunEl=26&camAz=120&camEl=28&dist=14&cx=4&cz=-6'],
    ['gold-sun-60', '?view=gold&t=60&pause=1&goldShare=0.6&sunAz=-60&sunEl=26&camAz=120&camEl=28&dist=14&cx=4&cz=-6'],
    ['gold-sun-50', '?view=gold&t=60&pause=1&goldShare=0.6&sunAz=-50&sunEl=26&camAz=120&camEl=28&dist=14&cx=4&cz=-6'],
    ['gold-field', '?view=gold&t=60&pause=1&sunAz=-60&sunEl=28'],
    // glaze ripple: reflections of the sun on top faces, on and off
    ['close-ripple', '?view=close&t=60&pause=1&camAz=137&camEl=50&dist=7'],
    ['close-ripple-off', '?view=close&t=60&pause=1&camAz=137&camEl=50&dist=7&ripple=0'],
  ];
  for (const [name, query] of shots) {
    const { page, done } = await open(query);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`shot ${OUT}/${name}.png  (${query})`);
    await done();
  }
}

// ---------------------------------------------------------------- 3. fps
if (want('fps')) {
  const measure = async (page, seekTo, waitMs) => {
    await page.evaluate(t => window.__seek(t), seekTo);
    await page.waitForTimeout(waitMs);
    return page.evaluate(() => window.__fps);
  };
  for (const dpr of [1, 2]) {
    const { page, done } = await open('?view=auto', { dpr });
    await page.waitForTimeout(1500);
    const stats = await page.evaluate(() => window.__stats);
    const busy = await measure(page, 44.4, 2500);          // last ~3 s: the most pieces in the air
    const busyBench = await page.evaluate(() => { window.__pause(true); window.__seek(46.5); return window.__bench(120); });
    await page.evaluate(() => window.__pause(false));
    const landed = await measure(page, 60, 2500);
    const landedBench = await page.evaluate(() => { window.__pause(true); return window.__bench(120); });
    console.log(`\n1280×800 @ dpr ${dpr}: ${stats.pieces} pieces, ${stats.vertices} vertices, ${stats.triangles} triangles, build ${stats.totalBuildMs} ms (pieces ${stats.buildMs} ms)`);
    console.log(`  rAF fps while dropping (t 44.4→46.9): ${busy}   after landing: ${landed}`);
    console.log(`  GPU bench while dropping: ${JSON.stringify(busyBench)}`);
    console.log(`  GPU bench landed:         ${JSON.stringify(landedBench)}`);
    if (dpr === 1 && (busy < 55 || landed < 55)) failures.push(`fps below 55 at dpr 1: ${busy} / ${landed}`);
    await done();
  }
  // CPU cost per frame must not grow with the piece count.
  for (const n of [1000, 12000]) {
    const { page, done } = await open(`?view=auto&n=${n}&t=46&pause=1`);
    await page.waitForTimeout(1000);
    const bench = await page.evaluate(() => window.__bench(240));
    console.log(`  n=${n}: CPU ms/frame ${bench.cpuMsPerFrame}, draw calls ${bench.drawCalls}`);
    await done();
  }
}

await browser.close();
console.log(consoleLines.length ? '\nConsole:\n' + consoleLines.join('\n') : '\nconsole: clean');
if (consoleLines.length) failures.push('console not clean');
if (failures.length) { console.log('\nFAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('\nall piece checks passed');
