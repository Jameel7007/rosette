// Render a pattern module's pieces to a flat PNG preview.
//
//   node scripts/render-svg.mjs <module.mjs> <out.png> [--w 1600] [--view x0,y0,x1,y1]
//                               [--svg out.svg] [--outline #000] [--no-lines] [--any-flag value]
//
// The module's default export is either an object or a (possibly async) function returning
// { pieces, view?, lines? }. Functions receive the parsed CLI flags (e.g. { w: '1600' }), so a
// demo module can take its own options. --view overrides the module's view (to zoom in).
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { piecesToSVG, renderSVG } from './lib/svg.mjs';

const args = process.argv.slice(2);
const [modPath, out] = args;
if (!modPath || !out) {
  console.error('usage: node scripts/render-svg.mjs <module.mjs> <out.png> [--w 1600] [--view x0,y0,x1,y1] [--svg out.svg]');
  process.exit(1);
}
const flags = {};
for (let i = 2; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const k = args[i].slice(2), v = args[i + 1];
  if (v === undefined || v.startsWith('--')) flags[k] = true; else { flags[k] = v; i++; }
}

const mod = await import(pathToFileURL(resolve(modPath)).href);
const t0 = performance.now();
const scene = typeof mod.default === 'function' ? await mod.default(flags) : mod.default;
const tBuild = performance.now() - t0;
const view = flags.view ? flags.view.split(',').map(Number) : scene.view;
const px = +(flags.w ?? 1600);
const svg = piecesToSVG(scene.pieces, {
  view, px,
  lines: flags['no-lines'] ? null : scene.lines,
  outline: flags.outline,
  dots: scene.dots,
});
await renderSVG(svg, out, { svgOut: flags.svg });
console.log(`${scene.pieces.length} pieces (built in ${tBuild.toFixed(0)} ms) → ${out}`);
