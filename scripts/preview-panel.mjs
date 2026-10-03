// Flat previews of the whole composed panel (src/pattern/compose.js): finished pieces (grout
// gaps and wobble) on mortar, rendered to PNG in headless Chrome.
//
//   node scripts/preview-panel.mjs [--out capture/panel] [--w 2000] [--only name,name]
//
// Writes
//   panel-full.png          the whole panel, |x|,|y| ≤ 53
//   panel-seam-0.png        where the medallion meets the field, on the 0° axis
//   panel-seam-35.png       ... and at 35°, where the circle cuts the field obliquely
//   panel-corner.png        a border corner
//   panel-order.png         every piece coloured by its place in the laying order (blue first, red last)
//   panel-laid-NN.png       the first NN % of pieces on the sinopia (the front as it grows)
//   panel-sinopia.png       the underdrawing alone, on mortar
//   star4-<mode>.png        close-up of a 4.8.8 square for each 4-point-star treatment
//                           (absorb, ochre, pin = gold pin, pin-ochre)
//   star4-<mode>-mid.png    the same treatments at a mid zoom (20 × 20 units)
// and prints the stats.
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { composePanel, COMPOSE } from '../src/pattern/compose.js';
import { area } from '../src/pattern/geom.js';
import { piecesToSVG } from './lib/svg.mjs';
import { launch } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const outDir = resolve(opt('out', 'capture/panel'));
const PX = +opt('w', 2000);
const only = opt('only', null)?.split(',');
const want = name => !only || only.some(o => name.startsWith(o));
mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const res = composePanel();
const ms = performance.now() - t0;
const { pieces, sinopia, stats } = res;

// ---- Report -------------------------------------------------------------------------------
console.log(`panel: ${pieces.length} pieces (star4 '${COMPOSE.star4}'), built in ${ms.toFixed(0)} ms`);
console.log('  ms per step', JSON.stringify(stats.ms));
console.log('  by region', JSON.stringify(stats.byRegion));
console.log('  by kind  ', JSON.stringify(stats.byKind));
console.log('  by stage ', JSON.stringify(stats.byStage));
console.log('  by key   ', JSON.stringify(stats.byKey));
console.log(`  area min ${stats.area.min.toFixed(4)} median ${stats.area.median.toFixed(3)} max ${stats.area.max.toFixed(3)}`);
console.log('  merges   ', JSON.stringify(stats.merges));
console.log(`  drops ${stats.drops}; warnings ${stats.warnings.length}`);
for (const w of stats.warnings) console.log('   ', w);
const gold = pieces.filter(p => p.key === 'A').reduce((s, p) => s + area(p.poly), 0);
const total = pieces.reduce((s, p) => s + area(p.poly), 0);
console.log(`  gold covers ${(100 * gold / total).toFixed(2)} % of the laid area`);
console.log(`  first pieces: ${pieces.slice(0, 12).map(p => `${p.kind}${p.key}@${p.rc.toFixed(1)}`).join(' ')}`);

// ---- Pictures -------------------------------------------------------------------------------
const shots = [];
const add = (name, svg) => { if (want(name)) shots.push({ name, svg }); };

add('panel-full.png', piecesToSVG(pieces, { view: [-53, -53, 53, 53], px: PX }));
add('panel-seam-0.png', piecesToSVG(pieces, { view: [24, -6, 36, 6], px: 1600 }));
const c35 = [29.5 * Math.cos(35 * Math.PI / 180), 29.5 * Math.sin(35 * Math.PI / 180)];
add('panel-seam-35.png', piecesToSVG(pieces, { view: [c35[0] - 6, c35[1] - 6, c35[0] + 6, c35[1] + 6], px: 1600 }));
add('panel-corner.png', piecesToSVG(pieces, { view: [37, 37, 53, 53], px: 1600 }));

// Laying order as colour: hue from blue (first) to red (last).
const N = pieces.length;
const byOrder = pieces.map(p => ({ poly: p.poly, fill: `hsl(${(240 * (1 - p.seq / (N - 1))).toFixed(1)},75%,${p.seq < 60 ? 85 : 50}%)` }));
add('panel-order.png', piecesToSVG(byOrder, { view: [-53, -53, 53, 53], px: PX }));

// The sinopia alone, and with the first part of the laying on top of it.
add('panel-sinopia.png', sinopiaUnder([], [-53, -53, 53, 53], PX));
for (const f of [0.02, 0.15, 0.4, 0.75]) {
  const n = Math.round(f * N);
  add(`panel-laid-${String(Math.round(f * 100)).padStart(2, '0')}.png`, sinopiaUnder(pieces.slice(0, n), [-53, -53, 53, 53], 1400));
}

// The 4-point-star treatments, side by side at the same spot: the 4.8.8 square at (34.5, 2.3).
const sq = [7.5 * 4.6, 0.5 * 4.6];
const variants = [['absorb', { star4: 'absorb' }], ['ochre', { star4: 'ochre' }], ['pin', { star4: 'pin', pinKey: 'A' }], ['pin-ochre', { star4: 'pin', pinKey: 'O' }]];
for (const [name, o] of variants) {
  if (!want('star4')) break;
  const alt = o.star4 === COMPOSE.star4 && (o.pinKey ?? COMPOSE.pinKey) === COMPOSE.pinKey ? res : composePanel(o);
  add(`star4-${name}.png`, piecesToSVG(alt.pieces, { view: [sq[0] - 3.5, sq[1] - 3.5, sq[0] + 3.5, sq[1] + 3.5], px: 1000 }));
  add(`star4-${name}-mid.png`, piecesToSVG(alt.pieces, { view: [25, 25, 45, 45], px: 1000 }));
}

/** Pieces drawn over the sinopia: the underdrawing first, so laid pieces cover it. */
function sinopiaUnder(laid, view, px) {
  const svg = piecesToSVG(laid, { view, px });
  // Insert the sinopia right after the mortar background (before the pieces).
  const i = svg.indexOf('<g transform="scale(1,-1)"');
  return `${svg.slice(0, i)}<g transform="scale(1,-1)">${sinopiaMarkup(sinopia)}</g>${svg.slice(i)}`;
}

/** The drawSinopia spec as SVG strokes (widths in pattern units, the spec's alphas). */
function sinopiaMarkup(s) {
  const [r, g, b] = s.color;
  const pen = it => `fill="none" stroke="rgb(${r},${g},${b})" stroke-opacity="${it.alpha}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"`;
  const f = v => (Math.round(v * 1e4) / 1e4).toString();
  const out = [];
  for (const c of s.circles ?? []) out.push(`<circle cx="0" cy="0" r="${f(c.r)}" ${pen(c)}/>`);
  for (const rc of s.rects ?? []) out.push(`<rect x="${f(rc.min[0])}" y="${f(rc.min[1])}" width="${f(rc.max[0] - rc.min[0])}" height="${f(rc.max[1] - rc.min[1])}" ${pen(rc)}/>`);
  for (const pl of s.polylines ?? []) {
    // One path per polyline, so crossings inside it do not build up (as on the canvas).
    const d = (pl.paths ?? [pl.pts]).map(pts => 'M' + pts.map(([x, y]) => `${f(x)},${f(y)}`).join('L') + (pl.closed ? 'Z' : '')).join('');
    out.push(`<path d="${d}" ${pen(pl)}/>`);
  }
  return out.join('\n');
}

const browser = await launch();
try {
  for (const s of shots) {
    const w = +(/width="(\d+)"/.exec(s.svg)[1]), h = +(/height="(\d+)"/.exec(s.svg)[1]);
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${s.svg}</body></html>`);
    await page.locator('svg').first().screenshot({ path: `${outDir}/${s.name}` });
    await page.close();
    console.log(`wrote ${outDir}/${s.name}`);
  }
} finally {
  await browser.close();
}
