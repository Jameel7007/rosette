// Flat preview of the 8-fold field on its own: Hankin lines → arrangement → strapwork →
// clipped to the panel square with a round hole standing in for the medallion → grout +
// wobble. Writes PNGs to capture/field/ and prints piece statistics, including the slivers
// each clip boundary creates.
//
//   node scripts/preview-field.mjs [--w 2000] [--hole 29] [--targetLen 0] [--out capture/field]
//                                  [--sweep 28,29.5,0.1] [--no-png]
//
// --targetLen > 0 also cuts long strap runs (strapwork's own option); 0 leaves runs whole.
// --sweep r0,r1,step also counts the circle's slivers for each hole radius in that range
// (to pick a medallion radius that cuts the field cleanly).
import { mkdirSync } from 'fs';
import { buildField } from '../src/pattern/hankin.js';
import { buildArrangement } from '../src/pattern/graph.js';
import { strapwork } from '../src/pattern/strap.js';
import { clipPieces, finishPieces } from '../src/pattern/cut.js';
import { area, ensureCCW, circlePoly, arcSegments } from '../src/pattern/geom.js';
import { FIELD, PANEL, PIECE } from '../src/config.js';
import { stream } from '../src/util/rand.js';
import { piecesToSVG, renderSVG } from './lib/svg.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const px = +flag('w', 2000);
const HOLE_R = +flag('hole', 29);          // stand-in for the medallion's outer radius
const targetLen = +flag('targetLen', 0) || Infinity;
const outDir = flag('out', 'capture/field');
const SLIVER = 0.05;                       // clipped pieces smaller than this count as slivers
const sweep = flag('sweep', null);
const pngs = !args.includes('--no-png');
mkdirSync(outDir, { recursive: true });

// ---- Build ------------------------------------------------------------------------------
const t0 = performance.now();
const field = buildField({ P: FIELD.P, theta: FIELD.THETA, bounds: { halfW: PANEL.HALF, halfH: PANEL.HALF }, strap: FIELD.STRAP });
const arr = buildArrangement(field.segments);
const sw = strapwork(arr, { width: field.strap, interlace: true, targetLen });
const t1 = performance.now();
const raw = [
  ...sw.fills.map(f => ({ poly: f.poly, ...field.classify(arr.faces[f.faceId]) })),
  ...sw.straps.map(s => ({ poly: s.poly, key: 'K', stage: 'Eight-point stars', kind: 'strap', over: s.over })),
];

// ---- Clip, one boundary at a time so each one's slivers can be counted -------------------
const H = PANEL.HALF;
const square = [[-H, -H], [H, -H], [H, H], [-H, H]];
// The medallion's circles are drawn on the engine's shared angular grid; use the same one.
const hole = ensureCCW(circlePoly(HOLE_R, arcSegments(HOLE_R)));

/** Pieces the clip actually cut (clipPieces returns untouched pieces as the same object). */
function cutBy(before, after) {
  const untouched = new Set(before);
  return after.filter(p => !untouched.has(p));
}
const inSquare = clipPieces(raw, { inside: square, minArea: 0 });
const squareCut = cutBy(raw, inSquare);
const clipped = clipPieces(inSquare, { outside: hole, minArea: 0 });
const circleCut = cutBy(inSquare, clipped);
const t2 = performance.now();

const dropped = [];
const pieces = finishPieces(clipped, {
  grout: PIECE.GROUT, wobble: PIECE.WOBBLE, rand: stream('pieces'),
  onDrop: (p, reason) => dropped.push({ kind: p.kind, area: area(p.poly), reason }),
});
const t3 = performance.now();

// ---- Report -----------------------------------------------------------------------------
const kinds = ['star8', 'star4', 'hex', 'strap'];
const fmt = v => v.toFixed(3);
function stats(list, label) {
  console.log(`\n${label}: ${list.length} pieces`);
  for (const k of kinds) {
    const a = list.filter(p => p.kind === k).map(p => area(p.poly)).sort((x, y) => x - y);
    if (!a.length) continue;
    console.log(`  ${k.padEnd(6)} n=${String(a.length).padStart(5)}  min ${fmt(a[0])}  median ${fmt(a[a.length >> 1])}  max ${fmt(a[a.length - 1])}`);
  }
}
function slivers(list, label) {
  const s = list.filter(p => area(p.poly) < SLIVER);
  const byKind = Object.fromEntries(kinds.map(k => [k, s.filter(p => p.kind === k).length]).filter(([, n]) => n));
  const tiny = s.filter(p => area(p.poly) < 0.005).length;
  const min = list.length ? Math.min(...list.map(p => area(p.poly))) : NaN;
  console.log(`  ${label}: cut ${list.length} pieces (smallest ${fmt(min)}); ${s.length} slivers < ${SLIVER} ` +
    `(${tiny} < 0.005) ${JSON.stringify(byKind)}`);
}

console.log(`field: ${field.segments.length} segments → ${arr.faces.length} faces; strapwork ${sw.fills.length} fills + ` +
  `${sw.straps.length} straps (${sw.crossings.length} interlaced crossings); warnings: ` +
  `${JSON.stringify([...arr.warnings, ...sw.warnings].map(w => w.code))}`);
console.log(`time: lines+arrangement+strapwork ${(t1 - t0).toFixed(0)} ms, clip ${(t2 - t1).toFixed(0)} ms, finish ${(t3 - t2).toFixed(0)} ms`);
stats(clipped, 'clipped field (before grout)');
const whole = clipped.filter(p => !squareCut.includes(p) && !circleCut.includes(p));
stats(whole, 'of which uncut by either boundary');
console.log('\nslivers made by the clip boundaries:');
slivers(squareCut, `square |x|,|y| ≤ ${H}`);
slivers(circleCut, `circle r = ${HOLE_R}`);
stats(pieces, 'finished field (grout + wobble)');
const dropKinds = {};
for (const d of dropped) dropKinds[d.kind] = (dropKinds[d.kind] ?? 0) + 1;
console.log(`  dropped by finishPieces (too small for the grout): ${dropped.length} ${JSON.stringify(dropKinds)}` +
  (dropped.length ? `, largest ${fmt(Math.max(...dropped.map(d => d.area)))}` : ''));
const regionArea = area(square) - area(hole);
console.log(`  area: region ${fmt(regionArea)}, clipped pieces ${fmt(clipped.reduce((s, p) => s + area(p.poly), 0))}, ` +
  `finished ${fmt(pieces.reduce((s, p) => s + area(p.poly), 0))}`);

// ---- Optional: slivers against the hole radius ---------------------------------------------
if (sweep) {
  const [r0, r1, step] = sweep.split(',').map(Number);
  // Only pieces near the circle can be cut by it.
  const near = inSquare.filter(p => p.poly.some(([x, y]) => Math.abs(Math.hypot(x, y) - (r0 + r1) / 2) < (r1 - r0) / 2 + 3));
  console.log(`\nslivers < ${SLIVER} against hole radius:`);
  for (let r = r0; r <= r1 + 1e-9; r += step) {
    const h = ensureCCW(circlePoly(r, arcSegments(r)));
    const cut = cutBy(near, clipPieces(near, { outside: h, minArea: 0 }));
    const n = cut.filter(p => area(p.poly) < SLIVER).length;
    const n2 = cut.filter(p => area(p.poly) < 0.2).length;
    console.log(`  r = ${r.toFixed(2)}: ${String(n).padStart(3)} slivers < ${SLIVER}, ${String(n2).padStart(3)} pieces < 0.2 (of ${cut.length} cut)`);
  }
}

// ---- Pictures ---------------------------------------------------------------------------
const construction = [
  ...field.baseTiling.octagons, ...field.baseTiling.squares,
].flatMap(t => t.map((p, i) => [p, t[(i + 1) % t.length]]));
const shots = [
  { name: 'field-full.png', view: [-H - 1, -H - 1, H + 1, H + 1] },
  { name: 'field-close-20-20.png', view: [14, 14, 26, 26] },
  { name: 'field-close-lines.png', view: [14, 14, 26, 26], lines: { lines: [...construction, ...field.segments], circles: [HOLE_R] } },
  { name: 'field-edge-46.png', view: [38, -6, 50, 6] },
  { name: 'field-circle-0deg.png', view: [24, -6, 36, 6] },
  { name: 'field-corner.png', view: [38, 38, 47, 47] },
];
for (const s of pngs ? shots : []) {
  const svg = piecesToSVG(pieces, { view: s.view, px, lines: s.lines ?? null, lineWidth: 1.5 });
  await renderSVG(svg, `${outDir}/${s.name}`);
  console.log(`wrote ${outDir}/${s.name}`);
}
