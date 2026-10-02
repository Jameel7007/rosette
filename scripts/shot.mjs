// Screenshot a page in headless Chrome on the GPU.
//   node scripts/shot.mjs <url> <out.png> [--w 1280] [--h 800] [--wait 2000] [--eval "js"] [--evalWait 0]
// --eval runs in the page after the first wait, then waits --evalWait ms before the shot.
// Prints console errors/warnings and the page's fps estimate if window.__fps exists.
import { launch, collectConsole } from './lib/browser.mjs';

const args = process.argv.slice(2);
const [url, out] = args;
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1280), H = +opt('h', 800), wait = +opt('wait', 2000), js = opt('eval'), evalWait = +opt('evalWait', 0);

const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: +opt('dpr', 1) });
const log = collectConsole(page);
await page.goto(url);
await page.waitForTimeout(wait);
if (js) { const r = await page.evaluate(js); if (r !== undefined) console.log('eval:', JSON.stringify(r)); await page.waitForTimeout(evalWait); }
await page.screenshot({ path: out });
const fps = await page.evaluate(() => window.__fps ?? null).catch(() => null);
if (fps !== null) console.log('fps:', fps);
console.log(log.length ? log.join('\n') : 'console: clean');
await browser.close();
