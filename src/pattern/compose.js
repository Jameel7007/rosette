// Composition: the whole panel as one list of finished pieces, in laying order
// (docs/CONTRACTS.md §3.3). This is where the three designs meet:
//
//   1. Medallion  the moorish 16-fold rosette with its strapwork, inlays and frame bands, r ≤ R_F
//   2. Field      Hankin's 4.8.8 strapwork, clipped to the square |x|,|y| ≤ 46 outside the
//                 medallion's outer polygon (the very polygon its frame bands end on, so the
//                 two meet without a gap or an overlap)
//   3. Border     46..52 (border.js)
//
// Before grout the pieces of all three are one exact partition of the square |x|,|y| ≤ 52
// (tests/compose.test.mjs checks it). Then:
//
//   4. Clean-up   the clip leaves slivers where the circle and the square cut the field; each
//                 is merged into the neighbour it lies against (cut.js absorbPieces), as a
//                 setter cuts the next piece a little bigger instead of setting a crumb. The
//                 tiny 4-point stars of the 4.8.8 squares get their own treatment
//                 (COMPOSE.star4: by default a small gold pin).
//   5. Finish     one pass: inset by half the grout, wobble like hand-cut tiles
//   6. Order      seq, the laying order (brief §3.5): the medallion's gold khatem first, then
//                 ring by ring with an angular sweep inside each ring; then field and border
//                 together by distance from the centre with a little jitter, so the edge of
//                 the laid area reads as a growing front, not a perfect circle
//   7. Sinopia    the red underdrawing on the mortar (scene/bed.js drawSinopia)
//
// Pure JavaScript (no three.js): runs in Node for tests and scripts.

import * as moorish from './rosette16/moorish.js';
import { buildField, FIELD_STAGE } from './hankin.js';
import { buildArrangement } from './graph.js';
import { strapwork } from './strap.js';
import { clipPieces, finishPieces, absorbPieces, sharedLength } from './cut.js';
import { buildBorder } from './border.js';
import { area, centroid, ensureCCW, dedupe, removeCollinear, insetPolygon, isSimple, bbox } from './geom.js';
import { FIELD, PANEL, PIECE } from '../config.js';
import { stream, SEED } from '../util/rand.js';
import pc from 'polygon-clipping';

/**
 * @typedef {import('./geom.js').Point} Point
 * @typedef {import('./geom.js').Poly} Poly
 *
 * @typedef {object} Piece  A finished piece (CONTRACTS §3.3).
 * @property {Poly} poly      final outline: inset by GROUT/2 and wobbled, counter-clockwise
 * @property {string} key     palette key
 * @property {string} stage   HUD label
 * @property {string} kind    'star16' | 'kite' | 'petal' | ... | 'strap' | 'band' | 'star8' | 'hex' | 'border' | ...
 * @property {number} seq     laying order: 0, 1, 2, ... (sort ascending)
 * @property {number} cx      area centroid
 * @property {number} cy
 * @property {number} rc      centroid distance from the centre
 * @property {number} r       largest vertex distance from the centre (camera framing)
 * @property {number} ang     atan2(cy, cx)
 * @property {'medallion' | 'field' | 'border'} region  which design it came from
 */

const TAU = Math.PI * 2;

/** Tunables of the composition. */
export const COMPOSE = {
  // The 4-point stars in the 4.8.8 squares are specks (0.145 before grout, 0.033 after, too
  // small for a 0.07 bevel to shape). Three treatments were rendered side by side
  // (scripts/preview-panel.mjs, star4-*.png):
  //   'absorb'  each joins the four short strap pieces around it: one black knot. Clean from
  //             afar, but up close the knot is a pinwheel with grout chips at its centre.
  //   'ochre'   kept as a tiny ochre piece: a speck that reads as noise, and under the 0.05
  //             floor after grout (kept only for comparison)
  //   'pin'     a square through its four tips (0.25 before grout, 0.13 after), carved out of
  //             the straps around it: reads as a deliberate inlay at every strap knot, and in
  //             gold it echoes the khatem and the border and glints in the light sweep
  star4: 'pin',
  pinKey: 'A',          // colour of the pin ('A' gold; 'O' ochre is the quieter alternative)
  sliver: 0.15,         // clipped field pieces smaller than this are merged into a neighbour
  minFinished: 0.05,    // ... as is any piece that would come out of the grout smaller than this
  A0: -2.2,             // the prototype's start angle for the sweep around each ring (radians)
  jitter: 0.6,          // ± random offset of the distance key in the field and border
};

/**
 * Lay out the whole panel.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed=SEED]  seeds stream('pattern'): the field's order jitter first,
 *   then the wobble of every piece (the geometry itself has no randomness)
 * @param {'absorb'|'ochre'|'pin'} [opts.star4]  treatment of the 4-point stars (COMPOSE.star4)
 * @param {string} [opts.pinKey]     palette key of the pins
 * @param {{buildRosette: Function, cutRosette: Function}} [opts.medallion]  the medallion
 *   design module (default rosette16/moorish.js, the owner's choice); any module with the same
 *   buildRosette / cutRosette contract works (a preset, or a design being worked on)
 * @param {boolean} [opts.exact=false]  also return the exact pieces (before grout, in laying
 *   order, with the design's metadata such as the medallion's `layer`), for tests
 * @returns {{ pieces: Piece[], sinopia: object, stats: object, exact?: object[] }}
 *   `pieces` sorted by seq. `sinopia` is a drawSinopia spec (scene/bed.js). `stats`: counts by
 *   kind / stage / region / key, finished area min/median/max, build time per step (ms),
 *   merges, drops, warnings.
 */
export function composePanel(opts = {}) {
  const o = { ...COMPOSE, ...opts };
  const seed = opts.seed ?? SEED;
  const ms = {};
  const warnings = [];
  let t = performance.now();
  const tStart = t;
  const lap = name => { const now = performance.now(); ms[name] = Math.round(now - t); t = now; };

  // ---- 1. Medallion ---------------------------------------------------------------------
  // cutRosette runs the design's own cuts (classify().cut), so its exact pieces already hold
  // the strapwork, the inlays and the frame bands, and partition the disk r ≤ R_F.
  const design = opts.medallion ?? moorish;
  const ros = design.buildRosette();
  const med = design.cutRosette(ros, { finish: false });   // step 5 finishes the whole panel at once
  for (const w of med.warnings) warnings.push(`medallion: ${w.code}: ${w.msg}`);
  const medallion = med.exact.map(p => ({ ...p, region: 'medallion' }));
  lap('medallion');

  // ---- 2. Field ---------------------------------------------------------------------------
  const H = PANEL.HALF;
  const field = buildField({ P: FIELD.P, theta: FIELD.THETA, bounds: { halfW: H, halfH: H }, strap: FIELD.STRAP });
  const arr = buildArrangement(field.segments);
  const sw = strapwork(arr, { width: field.strap, interlace: true });
  for (const w of [...arr.warnings, ...sw.warnings]) warnings.push(`field: ${w.code}: ${w.msg}`);
  // Classify on the unclipped face: clipping would move its centroid.
  let raw = [
    ...sw.fills.map(f => ({ poly: f.poly, ...field.classify(arr.faces[f.faceId]), region: 'field' })),
    ...sw.straps.map(s => ({ poly: s.poly, key: 'K', stage: FIELD_STAGE, kind: 'strap', over: s.over, region: 'field' })),
  ];
  lap('field');

  const star4 = treatStar4(raw, o, ros.R_F);
  raw = star4.pieces;
  warnings.push(...star4.warnings);
  lap('star4');

  // Clip to the square, outside the medallion. clipPieces passes untouched pieces through as
  // the same objects, so the ones it cut are the new objects.
  const square = [[-H, -H], [H, -H], [H, H], [-H, H]];
  const before = new Set(raw);
  const fieldPieces = clipPieces(raw, { inside: square, outside: ros.outerPoly, minArea: 0 });
  const clipCut = new Set(fieldPieces.filter(p => !before.has(p)));
  lap('clip');

  // ---- 3. Border --------------------------------------------------------------------------
  const border = buildBorder();
  const borderPieces = border.pieces.map(p => ({ ...p, region: 'border' }));
  lap('border');

  // ---- 4. Clean-up: merge slivers ----------------------------------------------------------
  // Field pieces the clip left small, and anything (in any region) that would not survive the
  // grout, go to the neighbour they lie against: preferably a field strap, else the frame band
  // sector of the medallion beside them (CONTRACTS: never a mortar hole).
  const keepSpecks = o.star4 === 'ochre';
  const tooSmall = p => {
    if (keepSpecks && p.kind === 'star4') return false;
    if (clipCut.has(p) && area(p.poly) < o.sliver) return true;
    return finishedArea(p.poly) < o.minFinished;
  };
  const rank = (small, cand) => {
    if (cand.region === small.region) return cand.kind === 'strap' ? 3 : 2;
    if (cand.region === 'medallion') return 1;
    return 0;
  };
  const all = [...medallion, ...fieldPieces, ...borderPieces];
  const absorbed = absorbPieces(all, { select: tooSmall, rank });
  const exact = absorbed.pieces;
  const mergeLog = {}, mergedAt = [];
  for (const m of absorbed.merged) {
    const k = `${m.piece.region}:${m.piece.kind} → ${m.into.region}:${m.into.kind}`;
    mergeLog[k] = (mergeLog[k] ?? 0) + 1;
    mergedAt.push(centroid(m.piece.poly));
  }
  for (const f of absorbed.failed) warnings.push(`sliver of ${f.region}:${f.kind} (area ${area(f.poly).toFixed(4)}) at ${fmtPt(centroid(f.poly))} has no neighbour to merge into`);
  lap('merge');

  // ---- 5 + 6. Order, then finish ---------------------------------------------------------
  // One random stream: the order jitter is drawn first (in construction order), then the
  // wobble (in laying order). The order is decided on the exact pieces, so it does not depend
  // on the wobble.
  const rand = stream('pattern', seed);
  const ordered = layingOrder(exact, o, rand);
  lap('order');

  const drops = [];
  const finished = finishPieces(ordered, {
    grout: PIECE.GROUT, wobble: PIECE.WOBBLE, rand,
    onDrop: (p, why) => drops.push({ region: p.region, kind: p.kind, area: area(p.poly), at: centroid(p.poly), why }),
  });
  for (const d of drops) warnings.push(`dropped by finishPieces (${d.why}): ${d.region}:${d.kind} area ${d.area.toFixed(4)} at ${fmtPt(d.at)} — a mortar hole`);
  const pieces = finished.map((p, seq) => toPiece(p, seq));
  lap('finish');

  // ---- 7. Sinopia ----------------------------------------------------------------------------
  const sinopia = sinopiaSpec(ros, field, border);
  lap('sinopia');
  ms.total = Math.round(performance.now() - tStart);

  const stats = makeStats(pieces, { ms, warnings, drops, merges: mergeLog, mergedAt, star4: star4.info, exactCount: exact.length, o });
  const out = { pieces, sinopia, stats };
  if (opts.exact) out.exact = ordered; // the exact pieces, in laying order (index = seq before drops)
  return out;
}

// ---------------------------------------------------------------------------------------
// The 4-point stars
// ---------------------------------------------------------------------------------------

/**
 * Treat the 4-point stars of the field (on the unclipped pieces, where neighbours share their
 * sides exactly). Around each star the strapwork has four long straps that pass over at the
 * star's tips, and four short "under" straps that end against the star.
 *   absorb  the star and its four short straps become one black knot
 *   ochre   left alone
 *   pin     a square through the star's four tips (its convex hull), carved out of the straps
 *           around it, in o.pinKey
 */
function treatStar4(pieces, o, R_F) {
  // Only the stars that can survive the clip (the others are about to be cut away).
  const H = PANEL.HALF + FIELD.P / 2;
  const stars = pieces.filter(p => {
    if (p.kind !== 'star4') return false;
    const [x, y] = centroid(p.poly);
    return Math.abs(x) < H && Math.abs(y) < H && Math.hypot(x, y) > R_F - FIELD.P / 2;
  });
  const info = { mode: o.star4, stars: stars.length };
  if (o.star4 === 'ochre' || !stars.length) return { pieces, warnings: [], info };

  // Index the straps by the cells their bounding boxes touch, to find each star's neighbours.
  const straps = pieces.filter(p => p.kind === 'strap');
  const cell = FIELD.P / 2, grid = new Map();
  const keysOf = b => {
    const out = [];
    for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++) for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) out.push(`${x},${y}`);
    return out;
  };
  const sbox = straps.map(s => bbox(s.poly));
  straps.forEach((s, i) => { for (const k of keysOf(sbox[i])) (grid.get(k) ?? grid.set(k, []).get(k)).push(i); });
  const near = b => {
    const set = new Set();
    for (const k of keysOf(b)) for (const i of grid.get(k) ?? []) {
      const s = sbox[i];
      if (s[0] <= b[2] && b[0] <= s[2] && s[1] <= b[3] && b[1] <= s[3]) set.add(i);
    }
    return [...set];
  };

  const gone = new Set();          // pieces replaced
  const replaced = new Map();      // strap index → its new outline(s) (pin mode)
  const added = [];
  let odd = 0;
  for (const star of stars) {
    const b = bbox(star.poly);
    if (o.star4 === 'absorb') {
      // The short straps share a whole side with the star; the long ones pass over.
      const stubs = near(b).filter(i => !straps[i].over && sharedLength(star.poly, straps[i].poly) > 1e-6);
      if (stubs.length !== 4) odd++;
      let geom = [[star.poly]];
      for (const i of stubs) geom = pc.union(geom, [[straps[i].poly]]);
      if (geom.length !== 1 || geom[0].length !== 1) { odd++; continue; }
      const knot = ensureCCW(dedupe(geom[0][0].slice(0, -1)));
      gone.add(star);
      for (const i of stubs) gone.add(straps[i]);
      added.push({ poly: knot, key: 'K', stage: FIELD_STAGE, kind: 'knot', region: 'field' });
    } else if (o.star4 === 'pin') {
      // The star's tips are its vertices farthest from its centre; their hull is the pin.
      const c = centroid(star.poly);
      const d = star.poly.map(p => Math.hypot(p[0] - c[0], p[1] - c[1]));
      const far = Math.max(...d);
      const pin = ensureCCW(star.poly.filter((p, i) => d[i] > far * (1 - 1e-6)));
      if (pin.length !== 4) { odd++; continue; }
      // Carve the pin out of every strap it overlaps (it bites a small triangle out of each of
      // the eight straps around the star). If a strap ever came out in several parts, all of
      // them are kept, so the partition stays exact either way.
      for (const i of near(bbox(pin))) {
        const cur = replaced.get(i) ?? [straps[i].poly];
        const parts = cur.flatMap(poly => pc.difference([poly], [pin]).map(P => ensureCCW(dedupe(P[0].slice(0, -1)))));
        const before = cur.reduce((sum, q) => sum + area(q), 0), after = parts.reduce((sum, q) => sum + area(q), 0);
        if (Math.abs(after - before) > 1e-12) replaced.set(i, parts);
        if (parts.length !== cur.length) odd++;
      }
      gone.add(star);
      added.push({ poly: pin, key: o.pinKey, stage: FIELD_STAGE, kind: 'pin', region: 'field' });
    }
  }
  const warnings = !odd ? [] : [o.star4 === 'absorb'
    ? `star4 'absorb': ${odd} star(s) without the usual four short straps around them`
    : `star4 'pin': ${odd} pin(s) that split a strap in two or did not have four tips`];
  const strapIndex = new Map(straps.map((s, i) => [s, i]));
  const out = [];
  for (const p of pieces) {
    if (gone.has(p)) continue;
    const i = strapIndex.get(p) ?? -1;
    if (i >= 0 && replaced.has(i)) for (const poly of replaced.get(i)) out.push({ ...p, poly });
    else out.push(p);
  }
  info.replacedStraps = replaced.size;
  return { pieces: [...out, ...added], warnings, info };
}

// ---------------------------------------------------------------------------------------
// Laying order
// ---------------------------------------------------------------------------------------

/**
 * Put the exact pieces in laying order (brief §3.5).
 *  - Medallion: by layer (the design's rings, centre first), and within a layer by the angle
 *    swept from A0 in one direction, like a craftsman's hand going round. A design may give
 *    the pieces of one region fractional layers, from its inside out (the new moorish does);
 *    then each of those sub-rings is swept in turn, all its symmetric copies together. The
 *    khatem is the only piece in layer 0, so it is laid first.
 *  - Field and border together: by centroid distance plus a jitter of ±o.jitter, so the
 *    front of laid pieces is ragged, as a growing front, rather than a perfect circle.
 * @returns {object[]} the same piece objects, sorted
 */
function layingOrder(pieces, o, rand) {
  const sweep = ang => (((ang - o.A0) % TAU) + TAU) % TAU;
  const med = [], rest = [];
  for (const p of pieces) {
    const [x, y] = centroid(p.poly);
    if (p.region === 'medallion') med.push({ p, layer: p.layer ?? 0, a: sweep(Math.atan2(y, x)), rc: Math.hypot(x, y) });
    else rest.push({ p, k: Math.hypot(x, y) + (rand() * 2 - 1) * o.jitter });
  }
  med.sort((a, b) => a.layer - b.layer || a.a - b.a || a.rc - b.rc);
  rest.sort((a, b) => a.k - b.k);
  return [...med.map(m => m.p), ...rest.map(r => r.p)];
}

/** A finished piece in the contract's shape. */
function toPiece(p, seq) {
  const [cx, cy] = centroid(p.poly);
  let r = 0;
  for (const q of p.poly) r = Math.max(r, Math.hypot(q[0], q[1]));
  return { poly: p.poly, key: p.key, stage: p.stage, kind: p.kind, seq, cx, cy, rc: Math.hypot(cx, cy), r, ang: Math.atan2(cy, cx), region: p.region };
}

/**
 * Area the piece keeps after finishing (0 if it would vanish): the grout inset plus a third of
 * the wobble. With the inset alone, a piece just over the floor could come out of the wobble
 * just under it (it happened once the grout was narrowed to 0.12). Random vertex jitter rarely
 * moves a whole edge inward, so a third covers it in practice; tests/compose.test.mjs checks
 * every finished piece against the floor.
 */
function finishedArea(poly) {
  const clean = removeCollinear(ensureCCW(dedupe(poly)));
  if (clean.length < 3) return 0;
  const inset = insetPolygon(clean, PIECE.GROUT / 2 + PIECE.WOBBLE / 3);
  return inset ? area(inset) : 0;
}

const fmtPt = p => `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})`;

// ---------------------------------------------------------------------------------------
// Sinopia: what the setter draws on the mortar before laying
// ---------------------------------------------------------------------------------------

/** The prototype's two pens: main guide lines and faint construction lines. */
const MAIN = { width: 0.2, alpha: 0.72 };
const FAINT = { width: 0.09, alpha: 0.38 };

/**
 * The underdrawing, as a drawSinopia spec (pattern units): the medallion's construction
 * circles and lines, the field's 4.8.8 tiling outside the medallion, and the border's lines.
 * The guide circles of the medallion (central star, crown, disk edge, outer edge) and the
 * panel's outer squares use the main pen; everything else the faint one. Each group of faint
 * lines is one path, so where its lines cross the red does not build up.
 */
function sinopiaSpec(ros, field, border) {
  const g = ros.geo;
  const guide = new Set([g.r_t, g.r_c, ros.R_M, ros.R_F]);
  const circles = [...new Set([...ros.sinopia.circles, ros.R_F])].map(r => ({ r, ...(guide.has(r) ? MAIN : FAINT) }));

  // The 4.8.8 tiling: each edge once (octagons and squares share them), outside the
  // medallion's outer circle and inside the panel square.
  const H = PANEL.HALF, R = ros.R_F;
  const seen = new Set(), tiling = [];
  const q = v => Math.round(v * 1e6);
  for (const poly of [...field.baseTiling.octagons, ...field.baseTiling.squares]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const k = [q(a[0]), q(a[1]), q(b[0]), q(b[1])];
      const key = k[0] < k[2] || (k[0] === k[2] && k[1] < k[3]) ? k.join() : [k[2], k[3], k[0], k[1]].join();
      if (seen.has(key)) continue;
      seen.add(key);
      for (const s of clipSegment(a, b, H, R)) tiling.push(s);
    }
  }

  // The 16-fold division lines all start at the centre: 32 of them, each 0.09 wide, cover the
  // mortar solid inside r ≈ 1.5 and made a pink blob under the khatem in the opening close-up.
  // They start at the innermost construction circle instead, like the rays of a compass rose.
  const r0 = Math.min(...ros.sinopia.circles);
  const atCentre = p => Math.hypot(p[0], p[1]) < 1e-9;
  const lines = ros.sinopia.lines.map(([a, b]) => {
    if (!atCentre(a) && !atCentre(b)) return [a, b];
    const [o, q] = atCentre(a) ? [a, b] : [b, a], len = Math.hypot(q[0] - o[0], q[1] - o[1]);
    return len > r0 ? [[q[0] * r0 / len, q[1] * r0 / len], q] : null;
  }).filter(Boolean);

  return {
    color: [160, 62, 40],
    circles,
    rects: border.sinopia.rects.map(r => ({ min: r.min, max: r.max, ...(r.main ? MAIN : FAINT) })),
    polylines: [
      { paths: lines, ...FAINT },
      { paths: tiling, ...FAINT },
      { paths: [...border.sinopia.lines, ...border.sinopia.zigzags], ...FAINT },
    ],
  };
}

/** The parts of segment a–b inside the square |x|,|y| ≤ H and outside the circle of radius R. */
function clipSegment(a, b, H, R) {
  // Liang–Barsky against the square.
  const d = [b[0] - a[0], b[1] - a[1]];
  let t0 = 0, t1 = 1;
  for (const [p, qq] of [[-d[0], a[0] + H], [d[0], H - a[0]], [-d[1], a[1] + H], [d[1], H - a[1]]]) {
    if (p === 0) { if (qq < 0) return []; continue; }
    const r = qq / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
  }
  if (t0 >= t1) return [];
  // Remove the part inside the circle: |a + t·d|² < R².
  const A = d[0] * d[0] + d[1] * d[1], B = 2 * (a[0] * d[0] + a[1] * d[1]), C = a[0] * a[0] + a[1] * a[1] - R * R;
  const disc = B * B - 4 * A * C;
  const at = t => [a[0] + t * d[0], a[1] + t * d[1]];
  if (disc <= 0) return [[at(t0), at(t1)]];
  const s0 = (-B - Math.sqrt(disc)) / (2 * A), s1 = (-B + Math.sqrt(disc)) / (2 * A);
  const out = [];
  if (Math.min(t1, s0) > t0) out.push([at(t0), at(Math.min(t1, s0))]);
  if (t1 > Math.max(t0, s1)) out.push([at(Math.max(t0, s1)), at(t1)]);
  return out;
}

// ---------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------

function makeStats(pieces, { ms, warnings, drops, merges, mergedAt, star4, exactCount, o }) {
  const count = f => { const m = {}; for (const p of pieces) m[f(p)] = (m[f(p)] ?? 0) + 1; return m; };
  const areas = pieces.map(p => area(p.poly)).sort((a, b) => a - b);
  const invalid = pieces.filter(p => !(p.poly.length >= 3 && area(p.poly) > 0 && isSimple(p.poly))).length;
  const under = areas.filter(a => a < o.minFinished).length;
  if (invalid) warnings.push(`${invalid} finished piece(s) are not simple counter-clockwise polygons`);
  if (under && o.star4 !== 'ochre') warnings.push(`${under} finished piece(s) under ${o.minFinished}`);
  return {
    pieces: pieces.length,
    exactPieces: exactCount,
    byKind: count(p => p.kind),
    byStage: count(p => p.stage),
    byRegion: count(p => p.region),
    byKey: count(p => p.key),
    area: { min: areas[0], median: areas[areas.length >> 1], max: areas[areas.length - 1] },
    under: { [o.minFinished]: under },
    ms,
    merges,
    mergedAt,             // where each merged sliver was (for previews)
    drops: drops.length,
    star4,
    warnings,
  };
}
