// Records a video through the REAL export UI in headless Chrome on the GPU, saves the download,
// then checks the file with scripts/check-video.mjs.
//
//   npm run record -- --preset vertical --speed 1 [--sound] [--no-overlay] [--throttle 4]
//                     [--base http://localhost:5193 | --port 5193] [--reduced] [--tag name]
//                     [--mbps 40] [--qp 22] [--encoder webm|mediarecorder]
//                     [--browser chromium|firefox|webkit]
//                     [--viewport 1280x800] [--dpr 2] [--url file:///…/dist/index.html] [--no-check]
//
// Real input path, as the owner's rule asks: a fresh browser context (cold page), the app's own
// Export video button, the panel's own chips and Start, a real click on Download (the file
// arrives through the browser's download event). Nothing is called inside the page except to
// READ what the page shows (the HUD counter, the canvas size and the pixel ratio before and after,
// to prove the live piece is handed back as it was).
//
//   --throttle N  Chrome's CPU throttle (CDP Emulation.setCPUThrottlingRate) from before the page
//                 loads: a slow machine. The file must come out the same.
//   --reduced     prefers-reduced-motion: the live page then holds a still, finished panel, so
//                 the screenshots before and after the export can be compared pixel for pixel.
//   --mbps N      dev override of the video bitrate (?exportMbps=N), for bitrate measurements.
//   --qp N        dev override of the H.264 quantizer (?exportQp=N), for quality measurements.
//   --encoder X   dev override forcing a fallback path (?encoder=webm | mediarecorder).
//
// Without --base it starts its own Vite dev server on --port and stops it at the end.
// Outputs go to capture/video/ (gitignored).

import { spawn, spawnSync, execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { webkit, firefox } from 'playwright-core';
import { launch, collectConsole } from './lib/browser.mjs';
import { exportFileName } from '../src/export/plan.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'capture/video');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const preset = opt('preset', 'vertical');
const speed = +opt('speed', 1);
const sound = flag('sound');
const overlay = !flag('no-overlay');
const throttle = +opt('throttle', 0);
const reduced = flag('reduced');
const browserName = opt('browser', 'chromium');
const [vw, vh] = opt('viewport', '1280x800').split('x').map(Number);
const dpr = +opt('dpr', 1);   // device pixel ratio of the emulated screen
const PORT = +opt('port', 5193);
const tag = opt('tag', [preset, `${speed}x`, sound ? 'sound' : 'silent', overlay ? null : 'clean', throttle ? `cpu${throttle}` : null,
  opt('mbps') ? `${opt('mbps')}mbps` : null, opt('qp') ? `qp${opt('qp')}` : null, opt('encoder') ?? null, browserName !== 'chromium' ? browserName : null, reduced ? 'reduced' : null,
  dpr !== 1 ? `dpr${dpr}` : null, opt('viewport') ? opt('viewport') : null]
  .filter(Boolean).join('-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/** What the page shows of the live piece (read only). */
const liveState = page => page.evaluate(() => ({
  counter: document.getElementById('n').textContent,
  stage: document.getElementById('stage').textContent,
  canvas: `${document.getElementById('c').width}x${document.getElementById('c').height}`,
  pixelRatio: window.__pixelRatio?.(),
  hudVisible: getComputedStyle(document.querySelector('.hud')).display !== 'none',
}));

/** PSNR between two PNGs with ffmpeg ('inf' = identical pixels). */
function psnr(a, b) {
  // ffmpeg prints the filter's result on stderr
  const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  return /average:(\S+)/.exec(r.stderr)?.[1] ?? `error: ${r.stderr.split('\n').slice(-3).join(' ')}`;
}

const server = opt('base') || opt('url') ? null : await startServer();
const base = opt('base', `http://localhost:${PORT}`);
const browser = browserName === 'chromium' ? await launch()
  : await ({ firefox, webkit }[browserName]).launch({ headless: true });
const summary = { tag, preset, speed, sound, overlay, throttle, reduced, browser: browserName, started: new Date().toISOString() };

try {
  const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, acceptDownloads: true, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  const log = collectConsole(page);
  if (throttle) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  const params = new URLSearchParams();
  if (opt('mbps')) params.set('exportMbps', opt('mbps'));
  if (opt('qp')) params.set('exportQp', opt('qp'));
  if (opt('encoder')) params.set('encoder', opt('encoder'));
  const t0 = Date.now();
  // --url opens any page instead (e.g. the single-file build from file://)
  await page.goto(opt('url') ?? `${base}/${params.size ? '?' + params : ''}`);

  // The Export button is enabled once the pieces are built
  await page.locator('#export:not([disabled])').waitFor({ timeout: 120000 });
  summary.readyMs = Date.now() - t0;
  if (reduced) await sleep(500);   // a still, finished panel
  else await sleep(2500);          // a little way into the laying, so "before" has pieces down
  const beforePng = resolve(OUT, `${tag}-before.png`);
  summary.before = await liveState(page);
  await page.screenshot({ path: beforePng });

  // Open the panel and set the options with real clicks on the chips
  await page.click('#export');
  await page.locator('#xp').waitFor({ state: 'visible' });
  await page.click(`label.xp-opt:has(input[name="preset"][value="${preset}"])`);
  await page.click(`label.xp-opt:has(input[name="speed"][value="${speed}"])`);
  for (const [name, want] of [['overlay', overlay], ['sound', sound]]) {
    const box = page.locator(`input[name="${name}"]`);
    if ((await box.isChecked()) !== want) await page.click(`label.xp-opt:has(input[name="${name}"])`);
  }
  await page.locator('#xp-start:not([disabled])').waitFor({ timeout: 30000 });
  summary.encoderNote = await page.locator('#xp-note').textContent();
  await page.screenshot({ path: resolve(OUT, `${tag}-panel.png`) });

  const tStart = Date.now();
  await page.click('#xp-start');
  // A look at the export while it runs: the preview letterboxed, the progress, no HUD
  await sleep(6000);
  await page.screenshot({ path: resolve(OUT, `${tag}-during.png`) });
  summary.during = { ...(await liveState(page)), progress: await page.locator('#xp-frames').textContent(), time: await page.locator('#xp-time').textContent() };

  // Done (the Download link), or failed (the form comes back with the reason). The failure
  // watcher always resolves (null once the page is gone), so it never leaves a dangling rejection.
  const link = page.locator('#xp-download');
  const failed = page.locator('#xp-form').waitFor({ state: 'visible', timeout: 60 * 60 * 1000 })
    .then(() => page.locator('#xp-note').textContent(), () => null);
  const failure = await Promise.race([link.waitFor({ state: 'visible', timeout: 60 * 60 * 1000 }).then(() => null), failed]);
  if (failure) throw new Error(`the export did not finish: ${failure}`);
  summary.exportMs = Date.now() - tStart;
  summary.result = await page.locator('#xp-result').textContent();
  summary.downloadLabel = await link.textContent();
  summary.doneNote = (await page.locator('#xp-done-note').isVisible()) ? await page.locator('#xp-done-note').textContent() : null;
  await page.screenshot({ path: resolve(OUT, `${tag}-done.png`) });

  // The download is a real click on the panel's Download link
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const suggested = download.suggestedFilename();
  const ext = suggested.split('.').pop();
  const file = resolve(OUT, `${tag}.${ext}`);
  await download.saveAs(file);
  summary.file = file;
  summary.suggestedFilename = suggested;
  summary.expectedFilename = exportFileName(preset, speed, ext);
  summary.bytes = statSync(file).size;

  // Close, and look at the live piece again
  await page.click('#xp-finish');
  await page.locator('#xp').waitFor({ state: 'hidden' });
  await sleep(reduced ? 500 : 100);
  const afterPng = resolve(OUT, `${tag}-after.png`);
  summary.after = await liveState(page);
  await page.screenshot({ path: afterPng });
  summary.beforeAfterPsnr = psnr(beforePng, afterPng);
  summary.focusAfterClose = await page.evaluate(() => document.activeElement?.id);
  summary.console = log;

  console.log(`\n${tag}: ready ${summary.readyMs} ms, export ${(summary.exportMs / 1000).toFixed(1)} s, ${(summary.bytes / 1e6).toFixed(1)} MB → ${file}`);
  console.log(`  encoder: ${summary.encoderNote}`);
  console.log(`  panel: ${summary.result} · ${summary.downloadLabel} · file name ${suggested}${suggested === summary.expectedFilename ? '' : ` (expected ${summary.expectedFilename})`}`);
  if (summary.doneNote) console.log(`  done note: ${summary.doneNote}`);
  console.log(`  during: HUD visible ${summary.during.hudVisible}, ${summary.during.progress}, ${summary.during.time}`);
  console.log(`  live before: ${JSON.stringify(summary.before)}`);
  console.log(`  live after:  ${JSON.stringify(summary.after)}  PSNR before/after ${summary.beforeAfterPsnr}`);
  console.log(`  console: ${log.length ? log.join('\n           ') : 'clean'}`);
} finally {
  await browser.close();
  server?.kill();
}

writeFileSync(resolve(OUT, `${tag}.record.json`), JSON.stringify(summary, null, 2));

if (!flag('no-check') && summary.file) {
  const argv = [resolve(ROOT, 'scripts/check-video.mjs'), summary.file, '--preset', preset, '--speed', String(speed), '--frames'];
  if (sound) argv.push('--sound');
  try {
    execFileSync(process.execPath, argv, { stdio: 'inherit' });
  } catch {
    process.exitCode = 1;
  }
}
