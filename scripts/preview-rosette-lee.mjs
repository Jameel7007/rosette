// Flat previews of the "lee" 16-fold medallion (src/pattern/rosette16/lee.js).
//
//   node scripts/preview-rosette-lee.mjs [--name lee] [--nest alpha|beta] [--darts radial|lee]
//                                        [--centre centre+points|none] [--bands 67.5,67.5] [--lines]
//
// Writes, under capture/rosette/:
//   <name>-full.png     the whole medallion (r <= 31), with a ring of stand-in field colour
//                       outside R_F
//   <name>-centre.png   |x|, |y| <= 4: what the opening close-up sees
//   <name>-sinopia.png  the setter's construction lines alone, on mortar
// --lines also overlays the sinopia on the first two. Prints the radii, piece counts and
// piece area statistics per kind.
import { mkdirSync } from 'fs';
import { buildRosette, cutRosette } from '../src/pattern/rosette16/lee.js';
import { bandPieces } from '../src/pattern/cut.js';
import { area, pointInPolygon } from '../src/pattern/geom.js';
import { piecesToSVG, renderSVG } from './lib/svg.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = opt('name', 'lee');
const outDir = 'capture/rosette';
mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const ros = buildRosette({
  nest: opt('nest'), smallDarts: opt('darts'), centreCut: opt('centre'),
  starBands: opt('bands')?.split(',').map(Number),
});
const { arr, tiles, warnings, fallbacks } = cutRosette(ros);
const ms = performance.now() - t0;

const r = ros.radii, f = v => v.toFixed(2);
console.log(`radii: small tips ${f(r.R1)}, great tips ${f(r.R2)}, star band ${f(r.C3)}..${f(r.C4)}, sawtooth ..${f(r.C5)}, R_M ${f(r.R_M)}, R_F ${f(r.R_F)}; frame rings of ${ros.bands[0].count} pieces`);
const unknown = arr.faces.filter(face => ros.classify(face).region === 'unknown').length;
console.log(`${arr.faces.length} faces (${unknown} unclassified), ${tiles.length} tiles, built in ${ms.toFixed(0)} ms; ` +
  `engine warnings: ${warnings.map(w => w.code).join(', ') || 'none'}; cuts done by the fallback: ${fallbacks}`);
const centre = tiles.find(t => t.layer === 0 && pointInPolygon([0, 0], t.poly));
let across = 0;
for (const p of centre.poly) for (const q of centre.poly) across = Math.max(across, Math.hypot(p[0] - q[0], p[1] - q[1]));
console.log(`centre piece: ${across.toFixed(2)} across, area ${area(centre.poly).toFixed(2)}`);
const byKind = {};
for (const t of tiles) (byKind[t.kind] ??= []).push(area(t.poly));
for (const [k, a] of Object.entries(byKind)) {
  a.sort((x, y) => x - y);
  console.log(`  ${k.padEnd(8)} n=${String(a.length).padStart(4)}  min ${a[0].toFixed(3)}  median ${a[a.length >> 1].toFixed(3)}  max ${a[a.length - 1].toFixed(3)}`);
}
console.log(`  slivers under 0.05: ${tiles.filter(t => area(t.poly) < 0.05).length}`);

// Stand-in field colour outside R_F: cream ground with lapis, as the field's stars are.
const halo = bandPieces({ r0: ros.R_F, r1: 32, count: 64 }).map((poly, i) => ({ poly, key: i % 4 === 0 ? 'B' : 'W' }));
const lines = args.includes('--lines') ? ros.sinopia : null;
await renderSVG(piecesToSVG([...halo, ...tiles], { view: [-31, -31, 31, 31], px: 1600, lines }), `${outDir}/${name}-full.png`);
await renderSVG(piecesToSVG(tiles, { view: [-4, -4, 4, 4], px: 1200, lines }), `${outDir}/${name}-centre.png`);
await renderSVG(piecesToSVG([], { view: [-31, -31, 31, 31], px: 1200, lines: ros.sinopia, lineWidth: 1.4 }), `${outDir}/${name}-sinopia.png`);
console.log(`wrote ${outDir}/${name}-full.png, -centre.png, -sinopia.png`);
