// Flat previews of the "moorish" 16-fold medallion (src/pattern/rosette16/moorish.js).
//
//   node scripts/preview-rosette-moorish.mjs [--out capture/rosette] [--sinopia] [--field]
//
// Writes
//   moorish-full.png     the whole medallion (view r ≤ 31, 1600 px) inside a ring of stand-in
//                        field colour, finished tiles (grout gaps and wobble) on mortar
//   moorish-centre.png   the opening close-up, |x|, |y| ≤ 4 (1200 px)
//   moorish-sinopia.png  (with --sinopia) the construction lines over the exact pieces
// --field uses the real 8-fold field (src/pattern/hankin.js) outside the medallion instead of
// the stand-in ring, if that module is available.
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { buildRosette, cutRosette } from '../src/pattern/rosette16/moorish.js';
import { annularSector, area } from '../src/pattern/geom.js';
import { finishPieces } from '../src/pattern/cut.js';
import { PIECE } from '../src/config.js';
import { stream } from '../src/util/rand.js';
import { piecesToSVG, renderSVG } from './lib/svg.mjs';

const args = process.argv.slice(2);
const flag = k => args.includes('--' + k);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const outDir = resolve(opt('out', 'capture/rosette'));
mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const ros = buildRosette();
const res = cutRosette(ros);
const ms = performance.now() - t0;

// Outside the medallion: the field, or a stand-in ring of field ground with a black edge.
let outside = [];
if (flag('field')) {
  try {
    const { buildField } = await import('../src/pattern/hankin.js');
    const { buildArrangement } = await import('../src/pattern/graph.js');
    const { strapwork } = await import('../src/pattern/strap.js');
    const { clipPieces } = await import('../src/pattern/cut.js');
    const { circlePoly } = await import('../src/pattern/geom.js');
    const field = buildField({ bounds: { halfW: 34, halfH: 34 } });
    const arr = buildArrangement(field.segments);
    const sw = strapwork(arr, { width: field.strap, targetLen: 1.35 });
    const raw = [
      ...sw.fills.map(f => ({ poly: f.poly, ...field.classify(arr.faces[f.faceId]) })),
      ...sw.straps.map(s => ({ poly: s.poly, key: 'K' })),
    ];
    const square = [[-33, -33], [33, -33], [33, 33], [-33, 33]];
    const clipped = clipPieces(raw, { inside: square, outside: circlePoly(ros.R_F, ros.geo.G) });
    outside = finishPieces(clipped, { grout: PIECE.GROUT, wobble: PIECE.WOBBLE, rand: stream('field-preview') });
  } catch (e) {
    console.warn('field unavailable, using the stand-in ring:', e.message);
  }
}
if (!outside.length) {
  const ring = [];
  for (let k = 0; k < 32; k++) {
    const a0 = (k * 2 * Math.PI) / 32, a1 = ((k + 1) * 2 * Math.PI) / 32;
    ring.push({ poly: annularSector(ros.R_F, 33, a0, a1), key: 'W', fill: '#d9ccb2' });
  }
  outside = finishPieces(ring, { grout: PIECE.GROUT, wobble: 0, rand: stream('stand-in') });
}

const tiles = [...outside, ...res.tiles];
const full = resolve(outDir, 'moorish-full.png');
const centre = resolve(outDir, 'moorish-centre.png');
await renderSVG(piecesToSVG(tiles, { view: [-31, -31, 31, 31], px: 1600 }), full);
await renderSVG(piecesToSVG(res.tiles, { view: [-4, -4, 4, 4], px: 1200 }), centre);
if (flag('sinopia')) {
  // The underdrawing on bare mortar, with the exact pieces as faint outlines.
  const ghost = res.exact.map(p => ({ poly: p.poly, fill: '#c9c0b1' }));
  await renderSVG(piecesToSVG(ghost, { view: [-31, -31, 31, 31], px: 1600, outline: '#8a7f6e', lines: ros.sinopia, lineWidth: 1.6 }),
    resolve(outDir, 'moorish-sinopia.png'));
}

// Summary: counts and areas per kind of piece.
const kinds = {};
for (const p of res.tiles) (kinds[p.kind] ??= []).push(area(p.poly));
console.log(`moorish: ${res.tiles.length} tiles (${res.exact.length} exact pieces, ${res.dropped.length} dropped) built in ${ms.toFixed(0)} ms`);
for (const [k, v] of Object.entries(kinds)) {
  v.sort((a, b) => a - b);
  console.log(`  ${k.padEnd(8)} ${String(v.length).padStart(5)}  area min ${v[0].toFixed(3)}  median ${v[v.length >> 1].toFixed(3)}  max ${v[v.length - 1].toFixed(3)}`);
}
if (res.warnings.length) console.log('warnings:', res.warnings.map(w => `${w.code}: ${w.msg}`).join('\n  '));
console.log(`→ ${full}\n→ ${centre}`);
