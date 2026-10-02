// The 16-fold medallion, "moorish" variant: a Nasrid / Fez rosette, constructed the way a
// setter (the ma'allem) lays one out on the floor with a cord compass and a straightedge.
//
// Everything is derived from the frame radius R_F, the strap width and the 16 divisions of
// the circle. No coordinate is typed in by hand.
//
//   Axes. 16 TIP AXES (rays at k·22.5°) and, halfway between them, 16 DENT AXES
//   (k·22.5° + 11.25°). The drawing has the 32 mirror lines of these axes (symmetry D16), so it
//   is constructed in one wedge, from the tip axis at 0° to the dent axis at 11.25°, and the
//   wedge is mirrored and turned 16 times.
//
//   1. Frame. The frame bands are measured inward from R_F; the innermost band edge is R_M, the
//      edge of the strapwork disk. Just inside it runs the frame strap (a circle).
//   2. Eight-point stars. On each tip axis an eight-point star whose outer point touches the frame
//      circle and whose side points touch its neighbours on the dent axes. That fixes their size,
//      and the CROWN circle r_c through their inner points.
//   3. Central star. On the star circle r_t a 16-point star whose sides make 22.5° with the tip
//      axes, so each point is 45°: Hankin's contact angle of 67.5°, the same as the field's.
//   4. Petal kites. Every side of the star runs straight on past its point; two neighbouring
//      sides cross on a dent axis and close a kite between two star points.
//   5. Petals. Past the kite tip each line runs parallel to the next tip axis: the flank of a
//      long petal. The crown lines (parallel to the star sides, through the crown points) cap the
//      petals, cross on the tip axes and run on as the inner sides of the eight-point stars.
//   6. Bows. Between two petals and under two stars: a narrow neck between the petal flanks that
//      opens into two lobes. A line from each star's lower diagonal point, parallel to the crown
//      line, closes the lobes on the dent axis.
//   7. Candies. Between two touching stars, one below the touching point and one above it. The
//      upper one is closed by lines from the stars' upper diagonal points to the frame circle on
//      the dent axis; what is left beside each outer star point is a small rim piece.
//
// The straps (black) run along every line; where two lines cross they interlace. Regions bigger
// than about 3 square units are cut the way a craftsman would, along the drawing's own lines:
//   central star  its 16 points cut off; the body inlaid with a gold khatem (the first piece
//                 laid), a ring of 8 and a ring of 16, so the opening close-up shows chunky pieces
//   petals, bows  an outline band in the motif's glaze (strips cut at the corners) around an
//                 inlaid inner copy in a second glaze, cut down its axis and across
//   kites, candies across their length, into equal pieces
//   8-point stars centre + points, the centre quartered on the star's own axes
// The frame bands are rings of trapezoids on one shared polygon, so they meet the disk exactly.
//
// Pure JavaScript (no three.js): runs in Node for tests and scripts.

import {
  lineIntersect, segIntersect, polar, circlePoly, area, centroid, interiorPoint, pointInPolygon,
  ensureCCW, dedupe, dist, lerp, isSimple, mitreOffset,
} from '../geom.js';
import { buildArrangement } from '../graph.js';
import { strapwork } from '../strap.js';
import { clipPieces, splitStar, splitRun, bandPieces, finishPieces } from '../cut.js';
import { FIELD, MEDALLION, PIECE } from '../../config.js';
import { stream } from '../../util/rand.js';

/**
 * @typedef {import('../geom.js').Point} Point
 * @typedef {import('../geom.js').Poly} Poly
 * @typedef {import('../geom.js').Segment} Segment
 */

const N = 16;
const DEG = Math.PI / 180;
const STEP = 360 / N;   // 22.5°: from one tip axis to the next
const HALF = STEP / 2;  // 11.25°: from a tip axis to the dent axis beside it

/** Stage labels shown in the HUD, in laying order. */
export const STAGES = {
  star: 'Central 16-point star',
  kite: 'Petal kites',
  petal: 'Petals',
  bow: 'Bows',
  star8: 'Eight-point stars',
  candy: 'Candies',
  frame: 'Framing rings',
  strap: 'Strapwork',
};

/**
 * Tunables of this design. Everything else follows from these and the construction.
 * Frame bands are listed from the inside out; their widths fix R_M = R_F − Σ widths.
 */
export const MOORISH = {
  R_F: MEDALLION.R_F_MAX,     // outer edge of the frame (≤ 29.5 so the field has room)
  strap: FIELD.STRAP,         // strap width, the same as the field's
  // Frame bands from the inside out. `per` is the number of grid steps per piece (1 or 2), so
  // gold and black rings are cut in longer pieces than the broad coloured band.
  frame: [
    { w: 0.8, key: 'A', per: 2 },   // gold ring against the frame strap
    { w: 0.5, key: 'K', per: 2 },
    { w: 1.5, key: 'R', per: 1 },   // terracotta band
    { w: 0.6, key: 'K', per: 2 },   // outermost: black, so the field's straps run into it
  ],
  starRatio: 0.30,            // r_t / r_c: star size against the crown (sets the petal length)
  // Centre inlay: the central star's body is cut into an eight-point khatem (the first piece
  // laid), a ring of 8 out to an octagon, and a ring of 16 out to the star's dents.
  // The khatem is sized for the opening close-up (the camera frames about ±3 units): 1.6 across
  // before grout. The octagon is then placed so the ring-of-8 and ring-of-16 pieces have equal area.
  khatem: 0.8,                // tip radius of the khatem
  // Cutting: regions larger than maxArea are split into pieces of about that size; strap runs
  // are cut at about targetLen.
  targetLen: 1.5,
  maxArea: 3.0,
  petalBand: 0.7,             // width of the outline band around an inlaid inner petal
  segLen: 2.4,                // outline-band pieces are cut at about this length
  bowCut: 'contour',          // 'contour' (outline band + inlaid inner bow) or 'fan'
  // Palette keys per class. A pair [even, odd] alternates with the 8-fold period (even and odd
  // tip axes, or dent axes). `…Inlay` keys colour the inner copy inside an outline band.
  keys: {
    star: 'W', khatem: 'A', ring1: 'B', ring2: 'W',
    kite: ['G', 'G'],
    petal: ['B', 'T'], petalInlay: ['T', 'B'],
    bow: ['W', 'W'], bowInlay: ['O', 'O'],
    star8: ['T', 'B'],
    candyIn: ['O', 'O'],
    candyOut: ['W', 'W'],
    rim: ['G', 'G'],
  },
};


// ---------------------------------------------------------------------------------------
// Small construction helpers (a straightedge and a cord compass)
// ---------------------------------------------------------------------------------------

/** The line through p in direction `deg` (degrees). */
const line = (p, deg) => ({ p, d: [Math.cos(deg * DEG), Math.sin(deg * DEG)] });
/** The ray from the centre at angle `deg`: a tip axis or a dent axis. */
const axis = deg => line([0, 0], deg);
/** Where two lines meet. */
const meet = (a, b) => {
  const x = lineIntersect(a.p, a.d, b.p, b.d);
  if (!x) throw new Error('moorish: construction lines are parallel');
  return x;
};
/** p turned about the centre by `deg`. */
const turn = (p, deg) => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
};
/** p mirrored in the axis at angle `deg` through the centre. */
const reflect = (p, deg) => {
  const c = Math.cos(2 * deg * DEG), s = Math.sin(2 * deg * DEG);
  return [p[0] * c + p[1] * s, p[0] * s - p[1] * c];
};
const radius = p => Math.hypot(p[0], p[1]);

/**
 * All 32 images of a wedge drawing under D16: each segment, its mirror in the tip axis at 0°,
 * and both turned by every multiple of 22.5°. (Images that coincide are merged by the engine.)
 * @param {Segment[]} segs
 * @returns {Segment[]}
 */
export function d16(segs) {
  const out = [];
  for (const [a, b] of segs) {
    const ma = reflect(a, 0), mb = reflect(b, 0);
    for (let k = 0; k < N; k++) {
      out.push([turn(a, k * STEP), turn(b, k * STEP)]);
      out.push([turn(ma, k * STEP), turn(mb, k * STEP)]);
    }
  }
  return out;
}

/**
 * Fold a point into the construction wedge [0°, 11.25°].
 * @returns {{p: Point, tip: number, dent: number}} the folded point; the index of the nearest
 *   tip axis (0..15) and of the dent axis in its sector (0..15), for colour alternation
 */
export function fold(p) {
  let a = Math.atan2(p[1], p[0]) / DEG;
  if (a < 0) a += 360;
  const tip = Math.round(a / STEP) % N;
  const dent = Math.floor(a / STEP) % N;
  const local = Math.abs(a - Math.round(a / STEP) * STEP); // 0..11.25 from the nearest tip axis
  const r = radius(p);
  return { p: [r * Math.cos(local * DEG), r * Math.sin(local * DEG)], tip, dent };
}

// ---------------------------------------------------------------------------------------
// The construction
// ---------------------------------------------------------------------------------------

/**
 * Number of sides for the frame circles and frame bands: a multiple of 16 chosen so that every
 * band circle between R_M and R_F gets the same polygon from `arcSegments(r, maxSeg)`, which
 * makes neighbouring bands (and the disk) share their vertices exactly.
 */
function frameGrid(R_M, R_F) {
  // The largest k for which R_M and R_F round to the same number of 16-gon groups; even, so
  // bands can also be cut every second grid step.
  let k = Math.floor(R_F / (R_F - R_M) - 1e-9);
  if (k % 2) k -= 1;
  if (k < 2) throw new Error('moorish: frame too wide for a shared band grid');
  const G = N * k;
  // At R_F a chord is exactly 2πR_F/G; nudge maxSeg up so rounding never adds a group of 16.
  const maxSeg = ((2 * Math.PI * R_F) / G) * (1 + 1e-9);
  return { G, maxSeg };
}

/**
 * Construct every named point of the wedge.
 * @param {typeof MOORISH} o
 */
function construct(o) {
  const w = o.strap;
  const R_F = o.R_F;
  const R_M = R_F - o.frame.reduce((s, b) => s + b.w, 0);
  const { G, maxSeg } = frameGrid(R_M, R_F);
  // Frame strap: a G-gon whose outer strap edge (offset w/2, mitred) is exactly the disk edge.
  const R_line = R_M - w / 2 / Math.cos(Math.PI / G);

  // 2. Eight-point stars touching the frame and each other. With t = tan 11.25°, a star of
  //    radius ρ centred at c on the tip axis touches the dent axis when ρ = c·t; its outer
  //    point touches the frame when c + ρ = R_line.
  const t = Math.tan(HALF * DEG);
  const c8 = R_line / (1 + t);
  const rho = c8 * t;
  const r_c = c8 - rho;                       // crown circle: the stars' inner points
  const O8 = [c8, 0];
  // A star with 45° points: its dents sit at ρ·cos67.5°/cos45° (the {8/3} star).
  const rhoD = (rho * Math.cos(67.5 * DEG)) / Math.cos(45 * DEG);
  const star8Tip = j => [c8 + rho * Math.cos(j * 45 * DEG), rho * Math.sin(j * 45 * DEG)];
  const star8Dent = j => [c8 + rhoD * Math.cos((j * 45 + 22.5) * DEG), rhoD * Math.sin((j * 45 + 22.5) * DEG)];

  // 3. Central star on the star circle r_t: sides at 22.5° to the tip axis.
  const r_t = o.starRatio * r_c;
  const T = [r_t, 0];
  const sideIn = line(T, 180 - 22.5);         // from the point back to the dent at +11.25°
  const D = meet(sideIn, axis(HALF));         // dent of the star
  // 4. The mirror side, run on past the point, crosses the dent axis at the kite tip P.
  const sideOut = line(T, 22.5);
  const P = meet(sideOut, axis(HALF));
  const Dm = reflect(D, 0);                   // the dent at −11.25°, where sideOut starts

  // 5. Petal flank (upper side of the petal on the 0° axis): the neighbouring star point's
  //    side, running parallel to this tip axis. Crown line through C, parallel to the star side.
  const T1 = turn(T, STEP);
  const flank = line(T1, 0);
  const C = [r_c, 0];
  const crown = line(C, 180 - 22.5);
  const S = meet(crown, flank);               // petal shoulder
  const S1 = reflect(S, HALF);                // the next petal's lower shoulder

  // 6. Bow lobes: from the star's lower diagonal point, parallel to the crown line.
  const t135 = star8Tip(3);
  const Y = meet(line(t135, 180 - 22.5), axis(HALF));

  // 7. Upper candy: from the star's upper diagonal point to the frame circle on the dent axis.
  const ring = circlePoly(R_line, G);
  let W = null;
  for (let i = 0; i < G && !W; i++) {
    const hit = segIntersect(ring[i], ring[(i + 1) % G], [0, 0], polar(2 * R_line, HALF * DEG));
    if (hit) W = hit.point;
  }
  const t45 = star8Tip(1);

  return {
    R_F, R_M, R_line, G, maxSeg, w,
    r_t, r_c, c8, rho, rhoD, O8,
    T, T1, D, Dm, P, S, S1, C, Y, W, t45, t135,
    star8Tip, star8Dent, ring,
  };
}

/** The wedge's centre lines (before the D16 copies). */
function wedgeSegments(g) {
  const segs = [];
  // Star side → kite side → petal flank: one straight line from the dent at −11.25° through the
  // star point and the kite tip to the next petal's shoulder.
  segs.push([g.Dm, g.S1]);
  // Crown line: petal cap from the shoulder to the crown point (it runs on as a star side).
  segs.push([g.S, g.C]);
  // Eight-point star outline.
  for (let j = 0; j < 8; j++) {
    segs.push([g.star8Tip(j), g.star8Dent(j)]);
    segs.push([g.star8Dent(j), g.star8Tip(j + 1)]);
  }
  // Bow lobes and the upper candy.
  segs.push([g.t135, g.Y]);
  segs.push([g.t45, g.W]);
  return segs;
}

/**
 * Template outline of every kind of face, for the copy on the 0° tip axis or the 11.25° dent
 * axis. A face is classified by folding a point inside it into the wedge and asking which
 * template holds it. (Templates are the faces themselves, from the named points.)
 */
function templates(g) {
  const onDent = p => reflect(p, HALF);       // mirror across the dent axis
  const onTip = p => reflect(p, 0);           // mirror across the tip axis
  const star16 = [];
  for (let k = 0; k < N; k++) { star16.push(turn(g.T, k * STEP), turn(g.D, k * STEP)); }
  const star8 = [];
  for (let j = 0; j < 8; j++) star8.push(g.star8Tip(j), g.star8Dent(j));
  const tip = g.star8Tip, dent = g.star8Dent;
  const half = (pts, m) => pts.concat(pts.slice(1, -1).reverse().map(m)); // close a symmetric outline
  return [
    { cls: 'star', poly: star16 },
    { cls: 'kite', poly: [g.D, g.T, g.P, g.T1] },
    { cls: 'petal', poly: [g.T, onTip(g.P), onTip(g.S), g.C, g.S, g.P] },
    { cls: 'star8', poly: star8 },
    { cls: 'bow', poly: ensureCCW(half([g.P, g.S, g.C, dent(3), tip(3), g.Y], onDent)) },
    { cls: 'candyIn', poly: ensureCCW(half([g.Y, tip(3), dent(2), tip(2)], onDent)) },
    { cls: 'candyOut', poly: ensureCCW(half([tip(2), dent(1), tip(1), g.W], onDent)) },
    { cls: 'rim', poly: ensureCCW([tip(1), dent(0), tip(0), [g.R_M, 0], polar(g.R_M, HALF * DEG), g.W]) },
  ];
}

// ---------------------------------------------------------------------------------------
// The design: buildRosette (docs/CONTRACTS.md §3.2)
// ---------------------------------------------------------------------------------------

/**
 * Build the moorish medallion.
 *
 * classify(face) follows the contract ({key, stage, kind, layer, split}) and adds two fields:
 *   cut(fillPoly)  this design's own cut for the face's fill (its strap-shrunk polygon). It
 *                  returns polygons, or {poly, key?, sub?, layer?, inlay?} objects for pieces that
 *                  differ from the face (the centre inlay's khatem and rings; `inlay: true` marks
 *                  the inner copy of a petal or bow, coloured `inlayKey`). `split` is the nearest
 *                  standard mode, for a composer that does not call `cut`.
 *   inlayKey       palette key of the inlaid inner copy (petals and bows)
 * cutRosette() below runs the whole pipeline with these.
 *
 * @param {Partial<typeof MOORISH>} [opts] overrides of MOORISH (keys are merged, not replaced)
 * @returns {{
 *   variant: 'moorish', segments: Segment[], strap: number, strapStage: string,
 *   classify: (face: {poly: Poly}) => {key: string, stage: string, kind: string, layer: number, split: string, cut?: Function, inlayKey?: string},
 *   R_M: number, R_F: number, bands: {r0: number, r1: number, key: string, stage: string, count: number, layer: number, maxSeg: number, a0: number}[],
 *   diskPoly: Poly, outerPoly: Poly, sinopia: {circles: number[], lines: Segment[]}, geo: object, opts: typeof MOORISH,
 * }}
 */
export function buildRosette(opts = {}) {
  const o = { ...MOORISH, ...opts, keys: { ...MOORISH.keys, ...opts.keys } };
  const KEYS = o.keys;
  const g = construct(o);

  // Centre lines: the wedge's lines in all 32 images, plus the frame circle.
  const segments = d16(wedgeSegments(g));
  for (let i = 0; i < g.G; i++) segments.push([g.ring[i], g.ring[(i + 1) % g.G]]);

  const temps = templates(g);
  const cutters = makeCutters(g, o);

  /** Classify an arrangement face: palette key, HUD stage, kind, laying layer, how to cut it. */
  function classify(face) {
    const inside = interiorPoint(face.poly);
    const f = fold(inside);
    const hit = temps.find(t => pointInPolygon(f.p, t.poly));
    const cls = hit ? hit.cls : 'unknown';
    const alt = cls === 'star8' || cls === 'petal' ? f.tip % 2 : f.dent % 2;
    const pick = k => (Array.isArray(k) ? k[alt] : k);
    switch (cls) {
      case 'star': return { key: KEYS.star, stage: STAGES.star, kind: 'star16', layer: 0, split: 'centre+points', cut: cutters.star };
      case 'kite': return { key: pick(KEYS.kite), stage: STAGES.kite, kind: 'kite', layer: 4, split: 'run', cut: cutters.kite };
      case 'petal': return { key: pick(KEYS.petal), inlayKey: pick(KEYS.petalInlay), stage: STAGES.petal, kind: 'petal', layer: 5, split: 'run', cut: cutters.petal };
      case 'bow': return { key: pick(KEYS.bow), inlayKey: pick(KEYS.bowInlay), stage: STAGES.bow, kind: 'bow', layer: 6, split: 'run', cut: cutters.bow };
      case 'star8': return { key: pick(KEYS.star8), stage: STAGES.star8, kind: 'star8', layer: 7, split: 'centre+points', cut: cutters.star8 };
      case 'candyIn': return { key: pick(KEYS.candyIn), stage: STAGES.candy, kind: 'candy', layer: 9, split: 'run', cut: cutters.candy };
      case 'candyOut': return { key: pick(KEYS.candyOut), stage: STAGES.candy, kind: 'candy', layer: 9, split: 'run', cut: cutters.candy };
      case 'rim': return { key: pick(KEYS.rim), stage: STAGES.candy, kind: 'rim', layer: 9, split: 'run', cut: cutters.run };
      default: return { key: 'W', stage: STAGES.frame, kind: 'unknown', layer: 9, split: 'none' };
    }
  }

  // Frame bands, from the disk edge outward, cut into G/per sectors on the shared grid. `maxSeg`
  // makes bandPieces use that grid (bands and disk then share every vertex exactly).
  const bands = [];
  let r0 = g.R_M;
  o.frame.forEach((b, i) => {
    const r1 = i === o.frame.length - 1 ? g.R_F : r0 + b.w;
    bands.push({ r0, r1, key: b.key, stage: STAGES.frame, count: g.G / (b.per ?? 1), layer: 10 + i, maxSeg: g.maxSeg, a0: 0 });
    r0 = r1;
  });

  return {
    variant: 'moorish',
    segments,
    strap: g.w,
    strapStage: STAGES.strap,
    classify,
    R_M: g.R_M,
    R_F: g.R_F,
    bands,
    // The disk the strapwork is clipped to, and the medallion's outer edge (clip the field
    // outside it): the same polygons the bands use, so everything meets without slivers.
    diskPoly: circlePoly(g.R_M, g.G),
    outerPoly: circlePoly(g.R_F, g.G),
    sinopia: sinopia(g, bands),
    geo: g,
    opts: o,
  };
}

/** The setter's red underdrawing: the 32 axes, the construction circles and the long lines. */
function sinopia(g, bands) {
  const circles = [g.r_t, radius(g.D), radius(g.P), g.r_c, g.c8, g.R_line, g.R_M, ...bands.map(b => b.r1)];
  const lines = [];
  for (let k = 0; k < 2 * N; k++) lines.push([[0, 0], polar(g.R_F, k * HALF * DEG)]);
  // The star sides and crown lines drawn full length, as a setter snaps a chalk line.
  const long = (p, deg, len) => [p, [p[0] + len * Math.cos(deg * DEG), p[1] + len * Math.sin(deg * DEG)]];
  lines.push(...d16([[g.Dm, g.S1], long(g.C, 157.5, dist(g.C, g.S) * 1.15), [g.C, g.star8Dent(4)]]));
  // Each eight-point star chalked as its 8 long lines, every point joined to the third one on.
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < 8; j++) lines.push([turn(g.star8Tip(j), k * STEP), turn(g.star8Tip(j + 3), k * STEP)]);
  }
  return { circles, lines };
}

// ---------------------------------------------------------------------------------------
// Cutting: how a craftsman would split the big regions
// ---------------------------------------------------------------------------------------

/**
 * Split a simple polygon by the infinite line through `a` with direction `d`, when the line
 * crosses its outline exactly twice (true for every symmetric piece cut down its axis).
 * Returns [left part, right part]; the two share the cut exactly. Returns [poly] otherwise.
 */
export function splitByLine(poly, a, d) {
  const n = poly.length;
  const scale = Math.max(...poly.map(p => Math.abs(p[0]) + Math.abs(p[1])), 1);
  const side = poly.map(p => {
    const s = d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0]);
    return Math.abs(s) < 1e-12 * scale ? 0 : s;
  });
  // Crossings: vertices on the line, or points where an edge passes from one side to the other.
  const cross = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (side[i] === 0) cross.push({ at: i, p: poly[i], vertex: true });
    else if (side[i] * side[j] < 0) {
      const t = side[i] / (side[i] - side[j]);
      cross.push({ at: i, p: [poly[i][0] + t * (poly[j][0] - poly[i][0]), poly[i][1] + t * (poly[j][1] - poly[i][1])], vertex: false });
    }
  }
  if (cross.length !== 2) return [poly];
  // Walk the outline from one crossing to the other, then back along the cut.
  const chain = (from, to) => {
    const pts = [from.p];
    for (let i = (from.at + 1) % n; ; i = (i + 1) % n) {
      if (to.vertex && i === to.at) break;
      pts.push(poly[i]);
      if (!to.vertex && i === to.at) break;
    }
    pts.push(to.p);
    return dedupe(pts);
  };
  const parts = [chain(cross[0], cross[1]), chain(cross[1], cross[0])].filter(q => q.length >= 3 && area(q) > 0);
  return parts.length === 2 ? parts : [poly];
}

/**
 * The outline `poly` with point `p` (which lies on one of its sides) inserted as a vertex and
 * moved to the front, so a fan from p covers the polygon with no sliver at p.
 */
function rotateTo(poly, p) {
  const n = poly.length;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ab = [b[0] - a[0], b[1] - a[1]], l2 = ab[0] ** 2 + ab[1] ** 2;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
    const d = Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  const out = [];
  for (let k = 1; k <= n; k++) out.push(poly[(best + k) % n]);
  return [p, ...out];
}

/** Unit direction of the tip axis (offset 0) or dent axis (offset 11.25°) nearest to point c. */
function axisDir(c, offset) {
  const a = Math.atan2(c[1], c[0]) / DEG - offset;
  const snapped = Math.round(a / STEP) * STEP + offset;
  return [Math.cos(snapped * DEG), Math.sin(snapped * DEG)];
}

/** Where the ray from the centre at angle `deg` leaves a star-shaped polygon around the centre. */
function rayExit(poly, deg) {
  const far = polar(1e4, deg * DEG);
  for (let i = 0; i < poly.length; i++) {
    const hit = segIntersect(poly[i], poly[(i + 1) % poly.length], [0, 0], far);
    if (hit) return hit.point;
  }
  throw new Error('moorish: ray misses the polygon');
}

/** Run a cut that may fail on a degenerate shape; keep the piece whole if it does. */
function tryCut(fn, poly) {
  try {
    const parts = fn(poly);
    return parts.length ? parts : [poly];
  } catch {
    return [poly];
  }
}

/**
 * Cut a polygon across an axis (direction u through point o) at the given axis positions, in
 * order. Cuts that would not split the piece cleanly in two are skipped.
 * @returns {Poly[]} slabs from low to high axis position
 */
function sliceAcross(poly, o, u, cuts) {
  const proj = p => (p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1];
  const n = [-u[1], u[0]];
  const out = [];
  let rest = poly;
  for (const c of cuts) {
    const parts = splitByLine(rest, [o[0] + u[0] * c, o[1] + u[1] * c], n);
    if (parts.length !== 2) continue;
    const [lo, hi] = proj(centroid(parts[0])) < proj(centroid(parts[1])) ? parts : [parts[1], parts[0]];
    out.push(lo);
    rest = hi;
  }
  out.push(rest);
  return out;
}

/**
 * The ma'allem's cut for a long symmetric piece: down its axis (the midrib), then each half
 * across the axis into as few pieces as keep every piece under maxArea, of equal area. A cut is
 * moved onto a nearby corner of the outline when there is one, so the grout lines line up with
 * the drawing instead of looking like a grid laid over it.
 * @param {Poly} poly
 * @param {Point} u  unit direction of the axis (through the centre of the medallion)
 * @param {number} maxArea
 * @param {boolean} [midrib=true] cut down the axis first
 */
function cutAlongAxis(poly, u, maxArea, midrib = true) {
  if (area(poly) <= maxArea) return [poly];
  const halves = midrib ? splitByLine(poly, [0, 0], u) : [poly];
  const out = [];
  for (const h of halves) {
    const A = area(h);
    const m = Math.ceil(A / maxArea - 1e-9);
    if (m <= 1) { out.push(h); continue; }
    const proj = h.map(p => p[0] * u[0] + p[1] * u[1]);
    const lo = Math.min(...proj), hi = Math.max(...proj);
    const below = x => { const parts = sliceAcross(h, [0, 0], u, [x]); return parts.length === 2 ? area(parts[0]) : (x <= lo ? 0 : A); };
    const cuts = [];
    for (let k = 1; k < m; k++) {
      // Bisection for the position with k/m of the area below it.
      let a = lo, b = hi;
      for (let it = 0; it < 50; it++) { const mid = (a + b) / 2; if (below(mid) < (A * k) / m) a = mid; else b = mid; }
      let x = (a + b) / 2;
      const snap = proj.filter(v => v > lo + 1e-6 && v < hi - 1e-6).sort((p, q) => Math.abs(p - x) - Math.abs(q - x))[0];
      if (snap !== undefined && Math.abs(snap - x) < 0.2 * (hi - lo) / m) x = snap;
      if (!cuts.length || x > cuts[cuts.length - 1] + 1e-6) cuts.push(x);
    }
    out.push(...sliceAcross(h, [0, 0], u, cuts));
  }
  return out;
}

/**
 * Contour cut ("andamento"): a band of width `band` along the outline around an inner copy of
 * the shape (the outline inset by `band`, sides kept parallel). The band is cut on the mitre
 * line at corners and into strips of about segLen along each side; strips much shorter than
 * that (short sides, corners) are joined to their neighbours, so band pieces are strips of
 * about segLen, bent where the outline bends. The inner copy is returned separately, so a caller
 * can give it a second glaze and cut it further.
 *
 * For a piece symmetric about the axis u (through the centre of the medallion), the band is also
 * cut where it crosses the axis, and the two halves are joined walking outward from the same
 * axis point, so the cuts are mirror images of each other.
 *
 * Returns null when the shape is too narrow for the band (its inset is not a simple polygon).
 * @param {Poly} poly
 * @param {number} band
 * @param {number} segLen
 * @param {Point} [u]  unit direction of the piece's mirror axis
 * @returns {{ring: Poly[], core: Poly} | null}
 */
function contourCut(poly, band, segLen, u) {
  // Put a vertex wherever the outline crosses the axis, so the band is cut there too.
  const side = p => (u ? u[0] * p[1] - u[1] * p[0] : 1);
  const tolSide = 1e-9 * Math.max(...poly.map(p => Math.abs(p[0]) + Math.abs(p[1])));
  const outline = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    outline.push(a);
    const sa = side(a), sb = side(b);
    if (Math.abs(sa) > tolSide && Math.abs(sb) > tolSide && sa * sb < 0) outline.push(lerp(a, b, sa / (sa - sb)));
  });
  const res = mitreOffset(outline, band);
  if (!res) return null;
  const core = res.pts;
  if (core.length < 3 || !(area(core) > 0) || !isSimple(core)) return null;
  const n = outline.length;
  // Strips as (outer edge, inner edge) pairs, in order around the outline.
  const strips = [];
  const onAxis = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = outline[i], b = outline[j], ia = core[res.idx[i]], ib = core[res.idx[j]];
    const m = Math.max(1, Math.round(dist(a, b) / segLen));
    if (u && Math.abs(side(a)) <= tolSide) onAxis.push(strips.length);
    for (let s = 0; s < m; s++) {
      strips.push({ o0: lerp(a, b, s / m), o1: lerp(a, b, (s + 1) / m), i0: lerp(ia, ib, s / m), i1: lerp(ia, ib, (s + 1) / m), len: dist(a, b) / m });
    }
  }
  // Chains of strips to join: the two halves between the axis points, or the whole ring.
  let chains;
  if (onAxis.length === 2) {
    const [k0, k1] = onAxis;
    const half1 = strips.slice(k0, k1), half2 = strips.slice(k1).concat(strips.slice(0, k0));
    // Walk both halves away from the same axis point (the one nearer the centre).
    const startAtK0 = radius(strips[k0].o0) <= radius(strips[k1].o0);
    const flip = list => list.slice().reverse().map(st => ({ o0: st.o1, o1: st.o0, i0: st.i1, i1: st.i0, len: st.len }));
    chains = startAtK0 ? [half1, flip(half2)] : [flip(half1), half2];
  } else {
    let start = strips.findIndex(st => st.len >= 0.75 * segLen);
    if (start < 0) start = 0;
    chains = [strips.slice(start).concat(strips.slice(0, start))];
  }
  const ring = [];
  for (const chain of chains) {
    const groups = [];
    let cur = null;
    for (const st of chain) {
      if (cur && cur.len + st.len <= 1.25 * segLen) { cur.list.push(st); cur.len += st.len; }
      else { cur = { list: [st], len: st.len }; groups.push(cur); }
    }
    for (const g of groups) {
      const outer = [g.list[0].o0, ...g.list.map(st => st.o1)];
      const inner = [g.list[0].i0, ...g.list.map(st => st.i1)];
      const q = ensureCCW(dedupe([...outer, ...inner.reverse()]));
      if (q.length >= 3 && area(q) > 1e-12) ring.push(q);
    }
  }
  return { ring, core };
}

/**
 * Fan cut: triangles from one point inside the shape (which must see the whole outline) to each
 * side, merged in neighbouring runs while they stay under maxArea. Reads like the ribs of a shell.
 */
function fanCut(poly, apex, maxArea) {
  // One triangle per side; a side whose triangle is too big is divided evenly.
  const tris = [];
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length];
    const m = Math.ceil(Math.abs(area([apex, p, q])) / maxArea - 1e-9);
    for (let s = 0; s < m; s++) tris.push([apex, lerp(p, q, s / m), lerp(p, q, (s + 1) / m)]);
  });
  return mergeFan(tris.filter(t => area(t) > 1e-12), maxArea);
}

/** Merge consecutive fan triangles (sharing the apex) while the merged piece stays small. */
function mergeFan(tris, maxArea) {
  const out = [];
  let cur = null;
  for (const t of tris) {
    if (cur && area(cur) + area(t) <= maxArea) cur = [...cur, t[2]];
    else { if (cur) out.push(cur); cur = t; }
  }
  if (cur) out.push(cur);
  return out;
}

function makeCutters(g, o) {
  const maxArea = o.maxArea, KEYS = o.keys;
  /** Pieces that are not symmetric about an axis: cut across their length if too big. */
  const run = poly => (area(poly) <= maxArea ? [poly] : tryCut(q => splitRun(q, Math.sqrt(maxArea)), poly));

  return {
    run,
    /**
     * Central star: the 16-gon through its dents is the body and the 16 points are cut off it.
     * The body is inlaid like a small rosette: an eight-point khatem (two squares; the first
     * piece laid), a ring of 8 out to an octagon, then a ring of 16 out to the star's dents, cut
     * on the dent axes so each piece sits under one star point.
     */
    star(poly) {
      const [body, ...points] = splitStar(poly, [0, 0], 'centre+points');
      const k = o.khatem, kd = (k * Math.cos(45 * DEG)) / Math.cos(22.5 * DEG);
      const kTip = i => polar(k, 45 * i * DEG);
      const kDent = i => polar(kd, (45 * i + 22.5) * DEG);
      const khatem = [];
      for (let i = 0; i < 8; i++) khatem.push(kTip(i), kDent(i));
      // Equal-area rings: (A_oct − A_khatem)/8 = (A_body − A_oct)/16, and an octagon of
      // circumradius R has area 2√2·R².
      const aOct = (area(body) + 2 * area(khatem)) / 3;
      const rOct = Math.sqrt(aOct / (2 * Math.SQRT2));
      const oct = [];
      for (let i = 0; i < 8; i++) oct.push(polar(rOct, 45 * i * DEG));
      const octAt = deg => rayExit(oct, deg);
      const bodyAt = deg => rayExit(body, deg);
      // Ring of 8: between khatem tips i and i+1, out to the octagon's corners at the same angles.
      const ring1 = [];
      for (let i = 0; i < 8; i++) ring1.push([oct[i], oct[(i + 1) % 8], kTip(i + 1), kDent(i), kTip(i)]);
      // Ring of 16: between dent axes, from the octagon out to the body.
      const ring2 = [];
      for (let j = 0; j < N; j++) {
        const a0 = j * STEP - HALF, a1 = j * STEP + HALF;
        const inner = [octAt(a0)];
        if (j % 2 === 0) inner.push(oct[j / 2]);   // the octagon has a corner on even tip axes
        inner.push(octAt(a1));
        ring2.push([bodyAt(a0), bodyAt(a1), ...inner.reverse()]);
      }
      return [
        { poly: khatem, key: KEYS.khatem, sub: 'khatem', layer: 0 },
        ...ring1.map(p => ({ poly: p, key: KEYS.ring1, sub: 'ring', layer: 1 })),
        ...ring2.map(p => ({ poly: p, key: KEYS.ring2, sub: 'ring', layer: 2 })),
        ...points.map(p => ({ poly: p, sub: 'point', layer: 3 })),
      ];
    },
    /**
     * Petal: an outline band in its own glaze around an inlaid inner petal (a second glaze),
     * which is cut across where its outline turns.
     */
    petal(poly) {
      const u = axisDir(centroid(poly), 0);
      const c = contourCut(poly, o.petalBand, o.segLen, u);
      if (!c) return cutAlongAxis(poly, u, maxArea);
      return [...c.ring, ...cutAlongAxis(c.core, u, maxArea, false).map(p => ({ poly: p, inlay: true }))];
    },
    /** Kite: across its length only (it is narrow). */
    kite: poly => cutAlongAxis(poly, axisDir(centroid(poly), HALF), maxArea, false),
    /**
     * Bow: the narrow neck between the petals is cut off at the waist (the line through the two
     * shoulders); the two lobes above are cut as a fan from the waist, like the ribs of a shell.
     */
    bow(poly) {
      const u = axisDir(centroid(poly), HALF);
      const proj = p => p[0] * u[0] + p[1] * u[1];
      // The waist: the shoulders are the reflex corners nearest the inner end.
      const reflex = poly.filter((p, i) => {
        const a = poly[(i - 1 + poly.length) % poly.length], b = poly[(i + 1) % poly.length];
        return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) < 0;
      }).sort((p, q) => proj(p) - proj(q));
      if (!reflex.length) return cutAlongAxis(poly, u, maxArea);
      const waist = proj(reflex[0]);
      const [neck, heart] = sliceAcross(poly, [0, 0], u, [waist]);
      if (!heart) return cutAlongAxis(poly, u, maxArea);
      const neckParts = cutAlongAxis(neck, u, maxArea, false);
      if (o.bowCut === 'fan') {
        const apex = [u[0] * waist, u[1] * waist];
        return [...neckParts, ...fanCut(dedupe(rotateTo(heart, apex)), apex, maxArea)];
      }
      // Contour: an outline band around an inlaid inner bow, which is cut down its axis.
      const c = contourCut(heart, o.petalBand, o.segLen, u);
      if (!c) return [...neckParts, ...cutAlongAxis(heart, u, maxArea)];
      return [...neckParts, ...c.ring, ...cutAlongAxis(c.core, u, maxArea).map(p => ({ poly: p, inlay: true }))];
    },
    /** Candy (on a dent axis): across, then down the axis if still too big. */
    candy: poly => cutAlongAxis(poly, axisDir(centroid(poly), HALF), maxArea, area(poly) > 2 * maxArea),
    /**
     * Eight-point star: centre + points. A big centre is cut in four by a cross on the star's own
     * axes (through the middles of its sides), which keeps the star's mirror symmetry.
     */
    star8(poly) {
      const c = centroid(poly);
      const [core, ...pts] = splitStar(poly, c, 'centre+points');
      if (area(core) <= maxArea) return [core, ...pts];
      const a0 = Math.round(Math.atan2(c[1], c[0]) / DEG / STEP) * STEP; // the star's tip axis
      const rel = core.map(p => [p[0] - c[0], p[1] - c[1]]);
      const angleOf = p => { let a = Math.atan2(p[1], p[0]) / DEG - a0; a = ((a % 360) + 360) % 360; return a; };
      const quarters = [];
      for (let q = 0; q < 4; q++) {
        const lo = 90 * q, hi = 90 * (q + 1);
        const corners = rel.filter(p => { const a = angleOf(p); return a > lo + 1e-9 && a < hi - 1e-9; }).sort((p, r) => angleOf(p) - angleOf(r));
        const exitAt = deg => { const e = rayExit(rel, deg + a0); return e; };
        const piece = [[0, 0], exitAt(lo), ...corners, exitAt(hi)].map(p => [p[0] + c[0], p[1] + c[1]]);
        quarters.push(dedupe(piece));
      }
      return [...quarters, ...pts];
    },
  };
}

/**
 * Lay the medallion out: run the engine on the centre lines, classify and cut every fill, add
 * the straps and the frame bands. Returns the exact pieces (they partition the disk of radius
 * R_F) and the finished tiles (inset by half the grout and wobbled).
 *
 * @param {ReturnType<typeof buildRosette>} ros
 * @param {{targetLen?: number, grout?: number, wobble?: number, rand?: () => number}} [opts]
 */
export function cutRosette(ros, opts = {}) {
  const { targetLen = ros.opts.targetLen, grout = PIECE.GROUT, wobble = PIECE.WOBBLE } = opts;
  const arr = buildArrangement(ros.segments);
  const sw = strapwork(arr, { width: ros.strap, targetLen });
  const g = ros.geo;
  const disk = circlePoly(g.R_M, g.G);
  const exact = [];
  for (const f of sw.fills) {
    const face = arr.faces[f.faceId];
    const { cut, ...cls } = ros.classify(face);
    const parts = cut ? tryCut(cut, f.poly) : [f.poly];
    for (const part of parts) {
      const piece = Array.isArray(part) ? { poly: part } : part;
      if (piece.inlay) piece.key = cls.inlayKey ?? cls.key;
      exact.push({ ...cls, ...piece, faceId: f.faceId });
    }
  }
  // A strap is laid with the later of the regions it separates (the frame strap with the rim).
  const faceLayer = arr.faces.map(f => { const c = ros.classify(f); return c.kind === 'star16' ? 3 : c.layer; });
  for (const s of sw.straps) {
    let layer = 0;
    const faces = s.edgeIds.flatMap(e => [arr.edges[e].left, arr.edges[e].right]);
    for (const v of s.vertexIds) for (const he of arr.out[v]) faces.push(arr.halfEdges[he].face);  // junctions
    for (const f of faces) if (f >= 0) layer = Math.max(layer, faceLayer[f]);
    exact.push({ poly: s.poly, key: 'K', stage: STAGES.strap, kind: 'strap', layer, over: s.over });
  }
  // The frame strap's outer edge IS the disk edge (R_line was chosen for that), so nothing should
  // stick out. Only a piece that does (by more than rounding) is clipped; clipping pieces whose
  // edges lie exactly on the disk edge would only add rounding noise.
  const tol = 1e-9 * g.R_M;
  const clipped = [];
  for (const p of exact) {
    if (p.poly.every(q => Math.hypot(q[0], q[1]) <= g.R_M + tol)) clipped.push(p);
    else clipped.push(...tryCut(() => clipPieces([p], { inside: disk, minArea: 0 }), p.poly).map(x => (Array.isArray(x) ? { ...p, poly: x } : x)));
  }
  for (const b of ros.bands) {
    for (const poly of bandPieces({ r0: b.r0, r1: b.r1, count: b.count, a0: b.a0, maxSeg: b.maxSeg })) {
      clipped.push({ poly, key: b.key, stage: b.stage, kind: 'band', layer: b.layer });
    }
  }
  const dropped = [];
  const tiles = finishPieces(clipped, { grout, wobble, rand: opts.rand ?? stream('pieces'), onDrop: (p, why) => dropped.push({ p, why }) });
  return { arr, sw, exact: clipped, tiles, dropped, warnings: [...arr.warnings, ...sw.warnings] };
}
