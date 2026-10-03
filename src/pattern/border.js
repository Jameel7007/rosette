// The panel's border, |x|,|y| from 46 to 52, as exact cut pieces (the prototype painted it
// onto square tesserae by colour). From the field outward:
//
//   46–47  black line
//   47–50  sawtooth: terracotta triangles standing on the inner line, cream triangles hanging
//          from the outer one, period 5.75 (16 teeth per side, as in the prototype); at each
//          corner a 3×3 lapis square with a gold square pin in the middle
//   50–51  black line
//   51–52  gold edge
//
// Every line runs between square corner blocks, so the four sides are the same pieces turned
// by 90°, which keeps the border's symmetry exact (a quarter turn only swaps and negates
// coordinates, so neighbouring sides meet bit for bit).
//
// How the pieces are cut, as a setter would:
//   lines     straight strips about 1.24 long, the piece counts chosen so that the joints of
//             neighbouring lines never line up (see LINE_COUNTS)
//   teeth     a tooth (area 8.6) is too big for one piece, so it is cut into rows one unit
//             high, parallel to its base: a tip, a middle strip, and a base strip cut in two on
//             the tooth's axis. Every piece stays under 3 square units.
//   corners   the lapis square is a mitred frame of four trapezoids around the gold pin, so the
//             corner keeps the panel's mirror symmetry
//
// Pure JavaScript, runs in Node.

import { area } from './geom.js';

/**
 * @typedef {import('./geom.js').Point} Point
 * @typedef {import('./geom.js').Poly} Poly
 */

/** HUD label for every border piece. */
export const BORDER_STAGE = 'Border';

/** Geometry of the border, in pattern units (the prototype's). */
export const BORDER = {
  inner: 46,            // field edge
  lineA: [46, 47],      // black line
  teeth: [47, 50],      // sawtooth band and corner blocks
  lineB: [50, 51],      // black line
  edge: [51, 52],       // gold edge
  period: 5.75,         // tooth period: 92 / 16
  phase: -46,           // a terracotta tip on the outer line at x = -46 (and every period on)
  pin: 0.6,             // half-width of the gold pin in each corner block
  maxArea: 3,           // pieces larger than this are cut
};

/**
 * Pieces per side for each line. All three pitches are close to 1.24. They were picked by a
 * search over counts with pitches 1.1–1.45 for the largest smallest gap between a joint in
 * one line and the nearest joint in the next one: 0.30 between the two black lines and 0.25
 * between the outer black line and the gold edge (they touch, so their joints must not meet).
 * Even counts put a joint on the side's centre line, odd counts a piece, so the two black
 * lines are also half a piece apart in the middle of each side.
 */
export const LINE_COUNTS = { lineA: 74, lineB: 81, edge: 82 };

// ---------------------------------------------------------------------------------------
// Small exact helpers
// ---------------------------------------------------------------------------------------

/** A quarter turn counter-clockwise, k times. Exact: it only swaps and negates. */
function turn([x, y], k) {
  switch (((k % 4) + 4) % 4) {
    case 0: return [x, y];
    case 1: return [-y, x];
    case 2: return [-x, -y];
    default: return [y, -x];
  }
}

/** Axis-aligned rectangle, counter-clockwise. */
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/**
 * The point where segment p–q crosses the line `axis = v` (axis 1: horizontal line y = v,
 * axis 0: vertical line x = v). The two endpoints are ordered first, so two pieces that share
 * the segment (and walk it in opposite directions) get the very same point.
 */
function crossAt(p, q, axis, v) {
  const [a, b] = p[axis] < q[axis] || (p[axis] === q[axis] && p[1 - axis] < q[1 - axis]) ? [p, q] : [q, p];
  const t = (v - a[axis]) / (b[axis] - a[axis]);
  const out = [0, 0];
  out[axis] = v;
  out[1 - axis] = a[1 - axis] + t * (b[1 - axis] - a[1 - axis]);
  return out;
}

/**
 * Cut a convex polygon by the line `axis = v` into the part below and the part above.
 * Returns the parts that have area (one part if the line misses the polygon).
 * @returns {Poly[]} [below?, above?]
 */
function cutConvex(poly, axis, v) {
  const lo = [], hi = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const sp = p[axis] - v, sq = q[axis] - v;
    if (sp <= 0) lo.push(p);
    if (sp >= 0) hi.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const x = crossAt(p, q, axis, v);
      lo.push(x); hi.push(x);
    }
  }
  return [lo, hi].filter(q => q.length >= 3 && area(q) > 1e-12);
}

// ---------------------------------------------------------------------------------------
// The border
// ---------------------------------------------------------------------------------------

/**
 * One line of the border (a ring of width e1 − e0) on the top side: `count` strips between
 * x = −e0 and e0, plus the corner square at the top right. The other sides are quarter turns.
 */
function lineTop(e0, e1, count, key, sub) {
  const xs = [];
  for (let k = 0; k <= count; k++) xs.push(-e0 + (2 * e0 * k) / count);
  xs[count] = e0; // exact end, so the strip meets the corner square bit for bit
  const out = [];
  for (let k = 0; k < count; k++) out.push({ poly: rect(xs[k], e0, xs[k + 1], e1), key, sub });
  out.push({ poly: rect(e0, e0, e1, e1), key, sub: sub + '-corner' });
  return out;
}

/**
 * The sawtooth on the top side (47 ≤ y ≤ 50, |x| ≤ 47). The zigzag between the colours runs
 * from the outer line (terracotta tips, at x = phase + k·period) to the inner line (cream
 * tips, half a period on). At |x| = 47 it is cut off where it meets the corner blocks.
 */
function teethTop(o) {
  const [y0, y1] = o.teeth;
  const X = y0;                         // the band runs between the corner blocks: |x| ≤ 47
  const P = o.period, half = P / 2;
  // Tips: terracotta on the outer line, cream on the inner line. All are short binary
  // fractions (5.75 = 23/4), so they are exact.
  const kMax = Math.round((X - o.phase) / P - 0.5);   // last terracotta tip inside |x| ≤ X
  const tipR = [], tipW = [];
  for (let k = 0; k <= kMax; k++) tipR.push([o.phase + k * P, y1]);
  for (let k = -1; k <= kMax; k++) tipW.push([o.phase + half + k * P, y0]);
  // Where the zigzag meets the corner blocks: on the line from the cream tip outside the band
  // to the first (last) terracotta tip.
  const endL = crossAt(tipW[0], tipR[0], 0, -X);
  const endR = crossAt(tipR[kMax], tipW[kMax + 1], 0, X);

  const teeth = [];
  // Terracotta teeth stand on the inner line between two cream tips, their tip on the outer
  // line; the first and last are cut off where the band meets the corner blocks.
  for (let k = 0; k <= kMax; k++) {
    const left = k === 0 ? [[-X, y0]] : [tipW[k]];                 // bottom left
    const right = k === kMax ? [[X, y0], endR] : [tipW[k + 1]];    // bottom right (and up the cut)
    const top = k === 0 ? [tipR[k], endL] : [tipR[k]];             // the tip (and down the cut)
    teeth.push({ poly: [...left, ...right, ...top], key: 'R', axis: tipR[k][0] });
  }
  // Cream teeth hang from the outer line between two terracotta tips, plus a small corner piece
  // at each end.
  for (let k = 0; k < kMax; k++) teeth.push({ poly: [tipW[k + 1], tipR[k + 1], tipR[k]], key: 'W', axis: tipW[k + 1][0] });
  teeth.push({ poly: [endL, tipR[0], [-X, y1]], key: 'W', axis: null });
  teeth.push({ poly: [endR, [X, y1], tipR[kMax]], key: 'W', axis: null });

  // Cut each big tooth into rows one unit high, parallel to its base, and a base row that is
  // still too big in two on the tooth's axis.
  const out = [];
  for (const t of teeth) {
    if (area(t.poly) <= o.maxArea) { out.push({ poly: t.poly, key: t.key, sub: 'tooth' }); continue; }
    let rows = [t.poly];
    for (let y = y0 + 1; y < y1 - 1e-9; y += 1) rows = rows.flatMap(r => cutConvex(r, 1, y));
    for (const r of rows) {
      const parts = area(r) > o.maxArea && t.axis !== null ? cutConvex(r, 0, t.axis) : [r];
      for (const p of parts) out.push({ poly: p, key: t.key, sub: 'tooth' });
    }
  }
  return out;
}

/**
 * The corner block at the top right (47..50 square): a gold pin in the middle and a mitred
 * lapis frame of four trapezoids around it.
 */
function cornerBlock(o) {
  const [a, b] = o.teeth;
  const c = (a + b) / 2, g0 = c - o.pin, g1 = c + o.pin;
  return [
    { poly: rect(g0, g0, g1, g1), key: 'A', sub: 'pin' },
    { poly: [[a, a], [b, a], [g1, g0], [g0, g0]], key: 'B', sub: 'frame' },   // bottom
    { poly: [[b, a], [b, b], [g1, g1], [g1, g0]], key: 'B', sub: 'frame' },   // right
    { poly: [[b, b], [a, b], [g0, g1], [g1, g1]], key: 'B', sub: 'frame' },   // top
    { poly: [[a, b], [a, a], [g0, g0], [g0, g1]], key: 'B', sub: 'frame' },   // left
  ];
}

/**
 * Build the border.
 * @param {Partial<typeof BORDER>} [opts]
 * @returns {{
 *   pieces: {poly: Poly, key: string, stage: string, kind: 'border', sub: string}[],
 *   sinopia: {rects: {min: Point, max: Point, main: boolean}[], lines: [Point, Point][], zigzags: Point[][]},
 *   inner: number, outer: number,
 * }}
 *   Pieces partition the square ring inner ≤ max(|x|, |y|) ≤ outer exactly. `sub` says which
 *   part a piece belongs to: line, line-corner, tooth, frame, pin, edge, edge-corner.
 *   `sinopia` lists the lines a setter chalks before laying it (main: the panel and border edges).
 */
export function buildBorder(opts = {}) {
  const o = { ...BORDER, ...opts };
  const top = [
    ...lineTop(o.lineA[0], o.lineA[1], LINE_COUNTS.lineA, 'K', 'line'),
    ...teethTop(o),
    ...cornerBlock(o),
    ...lineTop(o.lineB[0], o.lineB[1], LINE_COUNTS.lineB, 'K', 'line'),
    ...lineTop(o.edge[0], o.edge[1], LINE_COUNTS.edge, 'A', 'edge'),
  ];
  const pieces = [];
  for (let k = 0; k < 4; k++) {
    for (const p of top) pieces.push({ poly: p.poly.map(q => turn(q, k)), key: p.key, stage: BORDER_STAGE, kind: 'border', sub: p.sub });
  }

  // The setter's chalk lines: every line edge as a square, the corner blocks' sides, and the
  // zigzag of the teeth (one polyline per side).
  const rects = [o.lineA[0], o.lineA[1], o.lineB[0], o.lineB[1], o.edge[1]].map(s => ({
    min: [-s, -s], max: [s, s], main: s === o.inner || s === o.edge[1],
  }));
  const [a, b] = o.teeth;
  const lines = [];
  for (let k = 0; k < 4; k++) lines.push([turn([a, a], k), turn([a, b], k)], [turn([a, a], k), turn([b, a], k)]);
  const zig = [];
  {
    const P = o.period, half = P / 2;
    const kMax = Math.round((a - o.phase) / P - 0.5);
    const pts = [crossAt([o.phase - half, a], [o.phase, b], 0, -a)];
    for (let k = 0; k <= kMax; k++) {
      pts.push([o.phase + k * P, b]);
      if (k < kMax) pts.push([o.phase + half + k * P, a]);
    }
    pts.push(crossAt([o.phase + kMax * P, b], [o.phase + half + kMax * P, a], 0, a));
    for (let k = 0; k < 4; k++) zig.push(pts.map(q => turn(q, k)));
  }
  return { pieces, sinopia: { rects, lines, zigzags: zig }, inner: o.lineA[0], outer: o.edge[1] };
}
