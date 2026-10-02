// Flat previews of the "polar" 16-fold medallion (src/pattern/rosette16/polar.js):
//
//   capture/rosette/polar-full.png    the whole medallion (view r ≤ 31, 1600 px), with a ring
//                                     of stand-in field colour outside R_F
//   capture/rosette/polar-centre.png  the opening close-up, |x|, |y| ≤ 4 (1200 px)
//
//   node scripts/preview-rosette-polar.mjs [--sinopia] [--debug] [--no-png] [--out capture/rosette]
//
// --sinopia also writes polar-sinopia.png (construction lines over the bare bed);
// --debug writes polar-debug.png with every face orbit numbered (see the printed table).
// Prints piece counts and area statistics per kind.
import { mkdirSync } from 'fs';
import { buildRosette, rosettePieces } from '../src/pattern/rosette16/polar.js';
import { area, circlePoly, arcSegments, ensureCCW } from '../src/pattern/geom.js';
import { piecesToSVG, renderSVG } from './lib/svg.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const outDir = flag('out', 'capture/rosette');
const pngs = !args.includes('--no-png');
mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const ros = buildRosette();
const t1 = performance.now();
const { pieces, dropped } = rosettePieces(ros);
const t2 = performance.now();

// ---- Statistics ----------------------------------------------------------------------
const SLIVER = 0.05;
const stat = list => {
  const a = list.map(p => area(p.poly)).sort((x, y) => x - y);
  return { n: a.length, min: a[0], median: a[a.length >> 1], max: a[a.length - 1], slivers: a.filter(x => x < SLIVER).length };
};
const kinds = {};
for (const p of pieces) (kinds[p.kind] ??= []).push(p);
console.log(`polar medallion: R_M ${ros.R_M.toFixed(3)}, R_F ${ros.R_F}, strap ${ros.strap}, ${ros.segments.length} segments`);
console.log(`built in ${(t1 - t0).toFixed(0)} ms, cut in ${(t2 - t1).toFixed(0)} ms; ${pieces.length} pieces, ${dropped.length} dropped`);
for (const [kind, list] of Object.entries(kinds).sort()) {
  const s = stat(list);
  console.log(`  ${kind.padEnd(11)} ${String(s.n).padStart(5)}  area min ${s.min.toFixed(3)}  median ${s.median.toFixed(3)}  max ${s.max.toFixed(3)}  slivers<${SLIVER}: ${s.slivers}`);
}
const all = stat(pieces);
console.log(`  ${'all'.padEnd(11)} ${String(all.n).padStart(5)}  area min ${all.min.toFixed(3)}  median ${all.median.toFixed(3)}  max ${all.max.toFixed(3)}  slivers<${SLIVER}: ${all.slivers}`);
const centre = pieces.filter(p => p.kind === 'centre');
if (centre.length) {
  const xs = centre[0].poly.map(p => p[0]);
  console.log(`  centre piece: ${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} across, area ${area(centre[0].poly).toFixed(2)}`);
}
if (ros.warnings.length) console.log('warnings:', ros.warnings.map(w => w.msg));

if (!pngs) process.exit(0);

// ---- Pictures ------------------------------------------------------------------------
// A ring of stand-in field colour outside R_F (cream ground with the field's black strap
// tone at the edge), so the frame bands are judged against what will surround them.
const halo = R => {
  const out = [], n = arcSegments(R + 3);
  const outer = circlePoly(R + 3, n), inner = circlePoly(R + 0.07, n);
  for (let k = 0; k < 16; k++) {
    const i0 = (k * n) / 16, i1 = ((k + 1) * n) / 16;
    const poly = [];
    for (let i = i0; i <= i1; i++) poly.push(outer[i % n]);
    for (let i = i1; i >= i0; i--) poly.push(inner[i % n]);
    out.push({ poly: ensureCCW(poly), fill: k % 2 ? '#d9cdb4' : '#d2c5aa' });
  }
  return out;
};

const full = piecesToSVG([...halo(ros.R_F), ...pieces], { view: [-31, -31, 31, 31], px: 1600 });
await renderSVG(full, `${outDir}/polar-full.png`);
const close = piecesToSVG(pieces, { view: [-4, -4, 4, 4], px: 1200 });
await renderSVG(close, `${outDir}/polar-centre.png`);
console.log(`wrote ${outDir}/polar-full.png, ${outDir}/polar-centre.png`);

if (args.includes('--sinopia')) {
  const s = piecesToSVG([], { view: [-31, -31, 31, 31], px: 1600, lines: ros.sinopia, lineWidth: 1 });
  await renderSVG(s, `${outDir}/polar-sinopia.png`);
  console.log(`wrote ${outDir}/polar-sinopia.png`);
}

if (args.includes('--debug')) {
  // Number each orbit at one of its faces (the one nearest 80°) and print the table.
  const { buildArrangement } = await import('../src/pattern/graph.js');
  const arr = buildArrangement(ros.segments);
  const view = (flag('view', '-31,-31,31,31')).split(',').map(Number);
  const unit = (view[2] - view[0]) / 1600;
  const labelled = new Map();
  for (const f of arr.faces) {
    const c = ros.classify(f);
    const a = Math.abs(Math.atan2(f.centroid[1], f.centroid[0]) - 1.4);
    if (!labelled.has(c.layer) || a < labelled.get(c.layer).a) labelled.set(c.layer, { a, f, c });
  }
  const text = [...labelled.values()].map(({ f, c }) =>
    `<text x="${f.centroid[0]}" y="${-f.centroid[1]}" font-size="${unit * 20}" fill="#fff" stroke="#000" stroke-width="${unit * 4}" paint-order="stroke" text-anchor="middle" dominant-baseline="middle">${c.layer}</text>`).join('');
  const svg = piecesToSVG(pieces, { view, px: 1600 }).replace('</svg>', `<g>${text}</g></svg>`);
  await renderSVG(svg, `${outDir}/polar-debug.png`);
  for (const o of [...ros.orbits].sort((a, b) => a.layer - b.layer)) {
    console.log(`  layer ${String(o.layer).padStart(2)} ${o.role.padEnd(18)} ×${String(o.count).padStart(2)}  r ${o.rc.toFixed(2)}  face ${o.area.toFixed(2)}  fill ${(o.fillArea ?? 0).toFixed(2)}`);
  }
}
