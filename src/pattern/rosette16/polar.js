// The 16-fold medallion, variant "polar": Hankin's "polygons in contact" method applied to a
// polar (radial) tiling, the way Kaplan and Bonner embed rosettes in patterns. Nothing is
// drawn by hand: the strap lines are what Hankin's rays make of the tiling, so they flow from
// the centre to the frame and form the star, petals and bows by themselves.
//
// A setter would build it like this, from the medallion's outer radius R_F, the sixteen
// divisions of the circle and the field's contact angle (67.5°):
//
//   1. Divide the circle into 16 sectors (32 half-sectors of 11.25°). The odd half-sector
//      radii are the axes of the big stars; the even ones carry the sides they share.
//   2. Ring 1: sixteen octagons centred on the odd radii, each as regular as its sector
//      allows (its width is the sector's width at its centre). Neighbours share the flat
//      sides that lie on the even radii; the gaps above and below are rhombi.
//   3. The centre: a 16-gon whose side equals the octagon side (its radius is the ring's
//      radius ÷ (1 + √2)), joined to ring 1 by sixteen hexagons.
//   4. Ring 2: thirty-two smaller octagons on the half-odd radii, placed so their inner gap on
//      each even radius starts exactly at the tip of ring 1's outer rhombus. "Houses" over
//      ring 1's octagons and quadrilaterals under ring 2 fill between the rings; rhombi sit
//      between ring 2's octagons.
//   5. The frame: a circle through the midpoints of ring 2's top edges, which is where the
//      outer stars' tips will touch it. The tiling is drawn at a reference size and scaled
//      so this circle lands half a strap inside R_M.
//   6. Hankin's rays: from the midpoint of every tiling edge, two rays at 67.5° into each
//      tile, stopped where they meet the ray from the neighbouring edge. A line crosses each
//      shared edge straight, so strands run unbroken from tile to tile.
//   7. Welding: polar distortion leaves a few near misses (a ray's corner passing within 0.4
//      of another corner or line). The setter closes them: corners merge, or the corner moves
//      onto the line, so no sliver is left for the strap to swallow.
//   8. The hub: the central 16-point star is too big to be one tile, so a small circle
//      (radius 1) is drawn at the centre and joined to the star's inner corners by sixteen
//      spokes on the even radii. The star becomes sixteen kites around a small round centre
//      piece: the chunky first pieces of the opening shot.
//   9. Lines stop at the frame circle, which is a strap too. Frame bands (gold, lapis, black,
//      terracotta, gold) run from R_M out to R_F.
//
// Faces are named by what they contain (a tiling vertex, or the centroid's tile), which sets
// their colour, HUD stage, laying layer and how a ma'allem would cut them.
//
// Composition: rosettePieces(buildRosette()) returns the finished medallion, already cut
// (large fills split, the hub ring cut evenly, slivers joined to neighbours, bands added).
// A composer running its own pipeline needs no clipping: the strapwork ends at `disk`, a hair
// inside R_M (so clipping to circlePoly(R_M, arcSegments(R_M)) is a harmless no-op). Never
// clip it against `disk` itself (coincident edges trip polygon-clipping). `wedges:2:deg`
// splits cut through the arrangement face's centroid.
//
// Pure JavaScript, no three.js: runs in Node for tests and scripts.

import { FIELD, MEDALLION, PIECE } from '../../config.js';
import {
  add, sub, mul, dot, dist, lerp, normalize, rotate, polar, lineIntersect, segIntersect,
  area, centroid, ensureCCW, pointInPolygon, distToBoundary, insetPolygon, circlePoly, arcSegments,
} from '../geom.js';
import { buildArrangement } from '../graph.js';
import { strapwork } from '../strap.js';
import { splitStar, splitRun, bandPieces, finishPieces } from '../cut.js';
import pc from 'polygon-clipping';
import { stream } from '../../util/rand.js';

/**
 * @typedef {import('../geom.js').Point} Point
 * @typedef {import('../geom.js').Poly} Poly
 * @typedef {import('../geom.js').Segment} Segment
 */

/** Half of one sixteenth of a turn (11.25°): every angle in the construction is a multiple of U/2. */
const U = Math.PI / 16;
/** Point at radius r on the radial a·U (a counts half-sectors, so odd a = star axes). */
const at = (r, a) => polar(r, a * U);
/** Rotate a point by a·U. */
const turn = (p, a) => rotate(p, a * U);
/** Mirror a point across the radial a·U. */
const mirror = (p, a) => rotate([p[0], -p[1]], 2 * a * U);
/** Angle of a point in units of U, in [0, 32). */
const angleU = p => { const a = Math.atan2(p[1], p[0]) / U; return a < 0 ? a + 32 : a; };

/** Tunables for this variant (config.js holds the shared ones). */
export const POLAR = {
  THETA: FIELD.THETA,   // contact angle, degrees: the field's, so the stars match
  STRAP: FIELD.STRAP,   // strap width
  HUB_R: 1.0,           // hub circle: the centre piece is 2·(HUB_R − STRAP/2) ≈ 1.5 across
  WELD: 0.4,            // close near misses smaller than this (a little under the strap width)
  TARGET_LEN: 1.25,     // strap runs are cut into pieces of about this length
  SPLIT_AREA: 3,        // fills larger than this (square units) are cut into several pieces
  MIN_PIECE: 0.05,      // pieces that could end up smaller than this once grouted and wobbled
                        // (slivers where lines nearly meet) join a neighbour
  RUN_LEN: 1.8,         // long fills split 'run' are cut across into pieces about this long
  DISK_GAP: 0.002,      // the strapwork ends this far inside R_M (far below the grout width)
  // Frame bands outside the strapwork disk, from the inside out: [width, key, stage, count].
  BANDS: [
    [0.45, 'A', 'Framing rings', 96],
    [1.15, 'B', 'Framing rings', 96],
    [0.4, 'K', 'Framing rings', 96],
    [0.85, 'R', 'Framing rings', 96],
    [0.45, 'A', 'Framing rings', 112],
  ],
};

// ---------------------------------------------------------------------------------------
// 1–5. The polar tiling (reference size: ring 1's octagons are centred at radius 1)
// ---------------------------------------------------------------------------------------

/**
 * A near-regular octagon centred on the radial aC (units of U) at radius ro, whose two flat
 * sides lie on the radials aC ± half, so it shares them with its neighbours in the ring.
 * Built in the octagon's own frame (x along the circle, y outward) as a regular octagon whose
 * half-width is the distance from its centre to those radials; the side corners are then
 * dropped onto the radials so neighbours share them exactly.
 * @returns {{ c1: Point, c2: Point, t0: Point, u0: Point, t2: Point, u2: Point, v2: Point,
 *   v1: Point, side: number, poly: Poly }}
 *   c1, c2: bottom corners (c1 at the smaller angle); t0/u0 and t2/u2: lower/upper ends of the
 *   flat sides on the radials aC − half and aC + half; v2, v1: top corners (v2 at the larger
 *   angle).
 */
function octagon(ro, half, aC) {
  const halfWidth = ro * Math.sin(half * U);
  const side = (2 * halfWidth) / (1 + Math.SQRT2);
  const centre = at(ro, aC);
  const out = at(1, aC), along = [-out[1], out[0]];
  const local = (x, y) => add(centre, add(mul(along, x), mul(out, y)));
  const onRadial = (p, a) => { const d = at(1, a); return mul(d, dot(p, d)); };
  const o = {
    c1: local(-side / 2, -halfWidth), c2: local(side / 2, -halfWidth),
    t2: onRadial(local(halfWidth, -side / 2), aC + half), u2: onRadial(local(halfWidth, side / 2), aC + half),
    v2: local(side / 2, halfWidth), v1: local(-side / 2, halfWidth),
    u0: onRadial(local(-halfWidth, side / 2), aC - half), t0: onRadial(local(-halfWidth, -side / 2), aC - half),
    side,
  };
  o.poly = [o.c1, o.c2, o.t2, o.u2, o.v2, o.v1, o.u0, o.t0];
  return o;
}

/** The point on the radial a at distance len from p: the inner or outer solution. */
function onRadialAt(p, a, len, which) {
  const d = at(1, a), b = dot(p, d), c = dot(p, p) - len * len;
  const root = Math.sqrt(Math.max(0, b * b - c));
  return mul(d, which === 'inner' ? b - root : b + root);
}

/**
 * Construct the polar tiling at reference size. Returns the tiles of one sector (the sector
 * centred on radial 1, spanning radials 0..2) by name, the central 16-gon, and the radii a
 * setter would scribe as circles.
 */
export function polarTiling() {
  // Ring 1: octagons on the odd radials; o3 is the next one round.
  const o1 = octagon(1, 1, 1), o3 = octagon(1, 1, 3);
  const B2 = onRadialAt(o1.c2, 2, dist(o1.t2, o1.c2), 'inner');  // inner rhombus, lower tip
  const W2 = onRadialAt(o1.v2, 2, dist(o1.u2, o1.v2), 'outer');  // outer rhombus, upper tip

  // The 16-gon has the octagons' side length: radius = side / (2 sin U) = 1 / (1 + √2).
  const rA = o1.side / (2 * Math.sin(U));
  const A0 = at(rA, 0), A2 = at(rA, 2);

  // Ring 2: 32 octagons on the half-odd radials. Its radius is found by bisection so that the
  // gap on radial 2 starts exactly at W2 (ring 1's outer rhombus tip).
  const ring2 = ro => {
    const q = octagon(ro, 0.5, 1.5);
    return { q, tip: onRadialAt(q.c2, 2, dist(q.t2, q.c2), 'inner') };
  };
  let lo = 1, hi = 3;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (Math.hypot(...ring2(mid).tip) < Math.hypot(...W2)) lo = mid; else hi = mid;
  }
  const ro2 = (lo + hi) / 2;
  const q15 = ring2(ro2).q;                       // octagon on radial 1.5 (sides on radials 1, 2)
  const q05 = octagon(ro2, 0.5, 0.5), q25 = octagon(ro2, 0.5, 2.5);
  const W1top = onRadialAt(q05.v2, 1, dist(q05.u2, q05.v2), 'outer');   // outer rhombus tips
  const W2top = onRadialAt(q15.v2, 2, dist(q15.u2, q15.v2), 'outer');

  const tiles = {
    hexagon: [A0, A2, B2, o1.c2, o1.c1, mirror(B2, 1)],
    innerRhombus: [B2, o3.c1, o1.t2, o1.c2],
    octagon: o1.poly,
    outerRhombus: [o1.u2, o1.v2, W2, o3.v1],
    house: [o1.v1, o1.v2, q15.c1, q15.t0, q05.c2],            // over a ring-1 octagon
    quadRight: [o1.v2, W2, q15.c2, q15.c1],                    // under ring-2 octagon 1.5
    quadLeft: [mirror(W2, 1), o1.v1, q05.c2, q05.c1],          // under ring-2 octagon 0.5
    gap2: [W2, q25.c1, q15.t2, q15.c2],                        // ring 2's inner rhombus on radial 2
    octagon2a: q15.poly,
    octagon2b: q05.poly,
    outerRhombus2even: [q15.u2, q15.v2, W2top, q25.v1],
    outerRhombus2odd: [q05.u2, q05.v2, W1top, q15.v1],
  };
  const gon16 = Array.from({ length: 16 }, (_, k) => at(rA, 2 * k));
  // The frame circle passes through ring 2's top-edge midpoints: the outer stars' tips.
  const Rframe = Math.hypot(...lerp(q15.v1, q15.v2, 0.5));
  return {
    tiles, gon16, Rframe, rA, ro1: 1, ro2,
    // Tiling vertices (one sector): Hankin's lines never pass through a vertex, so each lies
    // inside exactly one face, the "rosette" of lines around that vertex. It names that face.
    vertices: {
      A2, B2, C2: o1.c2, T2: o1.t2, U2: o1.u2, V2: o1.v2, W2,
      Q15c1: q15.c1, Q15c2: q15.c2, Q15t0: q15.t0, Q15t2: q15.t2, Q15u2: q15.u2,
    },
  };
}

// ---------------------------------------------------------------------------------------
// 6–7. Hankin's rays, and welding the near misses
// ---------------------------------------------------------------------------------------

/**
 * Hankin's method on each tile: from every edge midpoint launch two rays making `theta`
 * with the edge, into the tile; the ray leaning towards the next edge meets that edge's
 * backward ray. Each tile contributes the zigzag midpoint → meeting point → next midpoint.
 * @param {Poly[]} tiles  counter-clockwise
 * @param {number} theta  radians
 * @returns {Segment[]}
 */
export function hankinSegments(tiles, theta) {
  const segs = [];
  for (const tile of tiles) {
    const n = tile.length, mids = [], fwd = [], back = [];
    for (let i = 0; i < n; i++) {
      const a = tile[i], b = tile[(i + 1) % n];
      const d = normalize(sub(b, a));
      mids.push(lerp(a, b, 0.5));
      fwd.push(rotate(d, theta));                     // leans into the tile, towards b
      back.push(rotate([-d[0], -d[1]], -theta));      // leans into the tile, towards a
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const X = lineIntersect(mids[i], fwd[i], mids[j], back[j]);
      if (X) segs.push([mids[i], X], [X, mids[j]]);
    }
  }
  return segs;
}

/**
 * Close near misses the way a setter would. A "corner" is a point where exactly two segments
 * meet (a Hankin meeting point). Corners closer than `delta` to each other merge at their
 * mean; a corner closer than `delta` to another segment moves onto it. All moves are decided
 * from the same geometry and applied together, so the result keeps the pattern's symmetry.
 * @param {Segment[]} segs
 * @param {number} delta
 * @returns {Segment[]}
 */
export function weldNearMisses(segs, delta, iterations = 2) {
  const keyOf = p => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
  for (let it = 0; it < iterations; it++) {
    const keys = segs.map(s => [keyOf(s[0]), keyOf(s[1])]);
    const uses = new Map();
    keys.forEach((ks, i) => ks.forEach((k, e) => { const u = uses.get(k); if (u) u.n++; else uses.set(k, { p: segs[i][e], n: 1 }); }));
    const corners = [...uses].filter(([, u]) => u.n === 2).map(([k, u]) => ({ k, p: u.p }));
    const moves = new Map();

    // Corner meets corner: cluster with union-find, merge each cluster at its mean.
    const parent = corners.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < corners.length; i++) {
      for (let j = i + 1; j < corners.length; j++) if (dist(corners[i].p, corners[j].p) < delta) parent[find(i)] = find(j);
    }
    const clusters = new Map();
    corners.forEach((c, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(c); });
    for (const group of clusters.values()) {
      if (group.length < 2) continue;
      const mean = mul(group.reduce((sum, c) => add(sum, c.p), [0, 0]), 1 / group.length);
      for (const c of group) moves.set(c.k, mean);
    }

    // Corner meets line: move onto the nearest segment interior. A corner exactly between two
    // lines (a symmetric tie) stays put, so the pattern keeps its mirror symmetry.
    for (const c of corners) {
      if (moves.has(c.k)) continue;
      let best = null, bestD = Infinity, secondD = Infinity;
      for (let i = 0; i < segs.length; i++) {
        if (keys[i][0] === c.k || keys[i][1] === c.k) continue;
        const [a, b] = segs[i];
        if (Math.min(a[0], b[0]) > c.p[0] + delta || Math.max(a[0], b[0]) < c.p[0] - delta ||
            Math.min(a[1], b[1]) > c.p[1] + delta || Math.max(a[1], b[1]) < c.p[1] - delta) continue;
        const ab = sub(b, a), t = dot(sub(c.p, a), ab) / dot(ab, ab);
        if (!(t > 0.02 && t < 0.98)) continue;
        const foot = add(a, mul(ab, t)), d = dist(c.p, foot);
        if (d < 1e-9 || d >= delta) continue;
        if (d < bestD) { secondD = bestD; bestD = d; best = foot; } else if (d < secondD) secondD = d;
      }
      if (best && secondD - bestD > 1e-7) moves.set(c.k, best);
    }
    if (!moves.size) break;
    segs = segs.map((s, i) => [moves.get(keys[i][0]) ?? s[0], moves.get(keys[i][1]) ?? s[1]]);
  }
  return segs;
}

/**
 * Keep the part of each segment inside the frame polygon. Points on the frame count as
 * inside: the outer stars' tips sit exactly on it, and rounding must not decide their fate.
 */
function clipToFrame(segs, frame, tol) {
  const inside = p => pointInPolygon(p, frame) || distToBoundary(p, frame) < tol;
  const out = [];
  for (const [a, b] of segs) {
    const ia = inside(a), ib = inside(b);
    if (ia && ib) { out.push([a, b]); continue; }
    if (!ia && !ib) continue;
    const [p, q] = ia ? [a, b] : [b, a];
    let hit = null, tBest = Infinity;
    for (let i = 0; i < frame.length; i++) {
      const x = segIntersect(p, q, frame[i], frame[(i + 1) % frame.length]);
      if (x && x.t < tBest) { tBest = x.t; hit = x.point; }
    }
    if (hit && dist(hit, p) > 1e-9) out.push([p, hit]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Faces: names, colours and cuts
// ---------------------------------------------------------------------------------------

/**
 * Every role a face can play, from the centre outward. `key` is the palette key (`alt`, if
 * given, is used on every other sector: an 8-fold colour period). `cut` is how a ma'allem
 * cuts the piece once it is larger than SPLIT_AREA: 'star' (a centre plus one piece per
 * point), 'run' (across its length, into pieces about RUN_LEN long) or 'none'; `always` cuts
 * it whatever its size. (Halving along a mirror axis would be natural for petals, but the
 * cutting line then runs exactly through vertices on the axis, which polygon-clipping cannot
 * always resolve; cuts across the length are robust and stay symmetric.)
 */
const ROLES = {
  hub: { key: 'A', stage: 'Central 16-point star', kind: 'centre', cut: 'none' },
  starKite: { key: 'B', stage: 'Central 16-point star', kind: 'star-point', cut: 'run', always: true },
  petal: { key: 'G', stage: 'Petal kites', kind: 'petal', cut: 'run' },
  hexagonStar: { key: 'O', stage: 'Petal kites', kind: 'star5', cut: 'star' },
  bowB: { key: 'W', stage: 'Bows', kind: 'bow', cut: 'run' },
  bowC: { key: 'W', stage: 'Bows', kind: 'bow', cut: 'run' },
  innerRhombusStar: { key: 'R', stage: 'Bows', kind: 'star4', cut: 'none' },
  octagonStar: { key: 'T', alt: 'B', stage: 'Eight-point stars', kind: 'star8', cut: 'star' },
  kiteT: { key: 'W', stage: 'Eight-point stars', kind: 'kite', cut: 'run' },
  kiteU: { key: 'W', stage: 'Eight-point stars', kind: 'kite', cut: 'run' },
  outerRhombusStar: { key: 'R', stage: 'Eight-point stars', kind: 'star4', cut: 'none' },
  bowV: { key: 'W', stage: 'Bows', kind: 'bow', cut: 'run' },
  bowW: { key: 'T', stage: 'Bows', kind: 'bow', cut: 'run' },
  houseStar: { key: 'O', stage: 'Bows', kind: 'star5', cut: 'star' },
  quadStar: { key: 'W', stage: 'Bows', kind: 'star4', cut: 'run' },
  gap2Star: { key: 'O', stage: 'Bows', kind: 'star4', cut: 'run' },
  ring2Joint: { key: 'W', stage: 'Outer stars', kind: 'kite', cut: 'run' },
  ring2Upper: { key: 'G', stage: 'Outer stars', kind: 'kite', cut: 'run' },
  octagon2Star: { key: 'R', stage: 'Outer stars', kind: 'star8', cut: 'star' },
  rim: { key: 'W', stage: 'Outer stars', kind: 'rim', cut: 'run' },
  minor: { key: 'W', stage: 'Bows', kind: 'filler', cut: 'none' },
};

/** The face around each tiling vertex takes the vertex's role. */
const VERTEX_ROLES = {
  A2: 'petal', B2: 'bowB', C2: 'bowC', T2: 'kiteT', U2: 'kiteU', V2: 'bowV', W2: 'bowW',
  Q15c1: 'ring2Joint', Q15c2: 'ring2Joint', Q15t0: 'ring2Joint', Q15t2: 'ring2Joint', Q15u2: 'ring2Upper',
};
/** Any other face is named after the tile its centroid lies in (folded into sector 0). */
const TILE_ROLES = {
  hexagon: 'hexagonStar', innerRhombus: 'innerRhombusStar', octagon: 'octagonStar', outerRhombus: 'outerRhombusStar',
  house: 'houseStar', quadRight: 'quadStar', quadLeft: 'quadStar', gap2: 'gap2Star', octagon2a: 'octagon2Star',
  octagon2b: 'octagon2Star', outerRhombus2even: 'rim', outerRhombus2odd: 'rim',
};
/** Fills smaller than this (after the strap) are slivers between near-coincident lines. */
const MINOR_FILL = 0.3;

/**
 * Choose how to cut one orbit's fills, and check the cut works on a sample fill (polygon
 * clipping fails when a cut line runs exactly through vertices, so a mode that throws or
 * loses area falls back to the next one).
 *   - small fills stay whole (unless the role says `always`);
 *   - stars: a centre plus one piece per point;
 *   - long fills: across their length (`run`);
 *   - round fills that a run would leave whole: in two, across their mirror axis
 *     (`wedges:2:deg`, the cut line through the face's centroid at deg).
 * @returns {string} split mode for the orbit's first face; classify turns wedge angles to
 *   each copy of the face.
 */
function chooseSplit(o, face, fill) {
  const role = ROLES[o.role];
  if (!fill || role.cut === 'none' || !(role.always || (o.fillArea ?? 0) > POLAR.SPLIT_AREA)) return 'none';
  const axisDeg = Math.round(angleU(face.centroid)) * 11.25;
  const modes = role.cut === 'star' ? ['centre+points'] : [];
  if (splitRun(fill, POLAR.RUN_LEN).length > 1) modes.push('run');
  modes.push(`wedges:2:${(axisDeg + 90) % 360}`, `wedges:2:${(axisDeg + 45) % 360}`);
  for (const mode of modes) {
    if (mode === 'run') return mode;
    try {
      const parts = splitStar(fill, face.centroid, mode);
      const sum = parts.reduce((t, p) => t + area(p), 0);
      if (parts.length > 1 && Math.abs(sum - area(fill)) < 1e-9 * area(fill) + 1e-12) return mode;
    } catch { /* try the next mode */ }
  }
  return 'none';
}

/** A face's symmetry class: faces related by the 16-fold symmetry share radius and area. */
const orbitKey = (rc, a) => `${Math.round(rc * 1e3)}|${Math.round(a * 1e3)}`;

// ---------------------------------------------------------------------------------------
// The design module
// ---------------------------------------------------------------------------------------

/**
 * Build the polar medallion: centre lines, how to colour and cut each face, and the frame.
 *
 * @param {object} [opts]
 * @param {number} [opts.R_F=MEDALLION.R_F_MAX]  outer radius of the last frame band
 * @param {number} [opts.strap=POLAR.STRAP]      strap width
 * @param {number} [opts.theta=POLAR.THETA]      Hankin contact angle, degrees
 * @param {Array}  [opts.bands=POLAR.BANDS]      frame bands [width, key, stage, count], inside out
 * @param {object} [opts.keys]  colour overrides by role, { role: key } or { role: [key, alt] }
 *   (roles: see ROLES; `alt` colours every other sector)
 * @returns {{
 *   segments: Segment[], strap: number,
 *   classify: (face: {centroid: Point, area: number, poly?: Poly}) =>
 *     { key: string, stage: string, kind: string, layer: number, split: string, role: string },
 *   R_M: number, bands: {r0: number, r1: number, key: string, stage: string, count: number}[],
 *   R_F: number, sinopia: { circles: number[], lines: Segment[] },
 *   tiling: { tiles: Poly[], scale: number }, orbits: object[], warnings: object[],
 * }}
 */
export function buildRosette(opts = {}) {
  const R_F = opts.R_F ?? MEDALLION.R_F_MAX;
  const strap = opts.strap ?? POLAR.STRAP;
  const theta = ((opts.theta ?? POLAR.THETA) * Math.PI) / 180;
  const bandSpec = opts.bands ?? POLAR.BANDS;
  // Colours per role: ROLES' defaults, overridable as { role: key } or { role: [key, alt] }.
  const keyFor = r => {
    const k = opts.keys?.[r];
    if (k === undefined) return [ROLES[r].key, ROLES[r].alt];
    return Array.isArray(k) ? k : [k, undefined];
  };

  // Frame bands from R_F inward fix the strapwork disk R_M; the frame line runs half a strap
  // inside it, so the frame strap's outer edge is R_M.
  const bandWidth = bandSpec.reduce((s, b) => s + b[0], 0);
  const R_M = R_F - bandWidth;
  const bands = [];
  let r = R_M;
  for (const [w, key, stage, count] of bandSpec) { bands.push({ r0: r, r1: r + w, key, stage, count }); r += w; }

  // The frame is a regular polygon with a vertex every 1/64 turn or finer (so the outer stars'
  // tips, on the half-odd radials, are vertices), half a strap inside the disk: its strap's
  // outer edge is then exactly `disk`, the strapwork's outline. That outline sits a hair
  // (DISK_GAP) inside R_M, inside even the chords of circlePoly(R_M, arcSegments(R_M)), so a
  // composer clipping to the usual disk finds every piece strictly inside and never hands
  // polygon-clipping the coincident edges it cannot resolve.
  const nFrame = 64 * Math.ceil(arcSegments(R_M) / 64);
  const R_disk = R_M - POLAR.DISK_GAP;
  const Rframe = R_disk - strap / 2 / Math.cos(Math.PI / nFrame);
  const frame = circlePoly(Rframe, nFrame);
  const disk = circlePoly(R_disk, nFrame);

  // The tiling, scaled so the outer stars' tips land on the frame.
  const ref = polarTiling();
  const scale = Rframe / ref.Rframe;
  const S = p => mul(p, scale);
  const sectorTiles = Object.values(ref.tiles).map(t => ensureCCW(t.map(S)));
  const tiles = [ensureCCW(ref.gon16.map(S))];
  for (let k = 0; k < 16; k++) for (const t of sectorTiles) tiles.push(t.map(p => turn(p, 2 * k)));

  // Hankin's rays, welded.
  let segments = weldNearMisses(hankinSegments(tiles, theta), POLAR.WELD);

  // The hub: a small circle at the centre and 16 spokes to the central star's inner corners
  // (they lie on the even radii; the star's motif is the first 32 segments).
  const hubN = 64;
  const hub = circlePoly(POLAR.HUB_R, hubN);
  const dents = [];
  for (let i = 0; i < 32; i += 2) dents.push(segments[i][1]);
  for (let i = 0; i < hubN; i++) segments.push([hub[i], hub[(i + 1) % hubN]]);
  for (const d of dents) segments.push([at(POLAR.HUB_R, Math.round(angleU(d))), d]);

  // Lines stop at the frame, which is drawn as a strap itself.
  segments = clipToFrame(segments, frame, 1e-7 * Rframe);
  for (let i = 0; i < frame.length; i++) segments.push([frame[i], frame[(i + 1) % frame.length]]);

  // ---- Classification: one arrangement here, faces grouped into symmetry orbits ----------
  const arr = buildArrangement(segments);
  const orbitOf = new Map();       // orbit key → orbit
  const orbits = [];
  const orbitOfFace = f => orbitOf.get(orbitKey(Math.hypot(...f.centroid), f.area));
  for (const f of arr.faces) {
    const rc = Math.hypot(...f.centroid), k = orbitKey(rc, f.area);
    let o = orbitOf.get(k);
    if (!o) { o = { key: k, rc, area: f.area, nv: f.verts.length, faces: [], role: null, inner: Infinity }; orbitOf.set(k, o); orbits.push(o); }
    o.faces.push(f.id);
    // Innermost radius, for the laying order (0 if the face surrounds the centre).
    o.inner = pointInPolygon([0, 0], f.poly) ? 0 : Math.min(o.inner, ...f.poly.map(p => Math.hypot(...p)));
  }
  // Each orbit's fill (the face shrunk by the strap) decides its cut, and flags slivers.
  const sw = strapwork(arr, { width: strap, interlace: false });
  for (const f of sw.fills) { const o = orbitOfFace(arr.faces[f.faceId]); if (o) o.fillArea = Math.abs(area(f.poly)); }

  // Name the orbits: first the faces around tiling vertices, then by the tile holding the
  // centroid; the central 16-gon holds the hub and the star's kites.
  for (const [name, p] of Object.entries(ref.vertices)) {
    const f = arr.faces.find(fc => pointInPolygon(S(p), fc.poly));
    const o = f && orbitOfFace(f);
    if (o && !o.role) o.role = VERTEX_ROLES[name];
  }
  const namedTiles = Object.entries(ref.tiles).map(([name, t]) => [name, ensureCCW(t.map(S))]);
  const gon = ensureCCW(ref.gon16.map(S));
  for (const o of orbits) {
    const f = arr.faces[o.faces[0]];
    if (!o.role && !((o.fillArea ?? 0) > MINOR_FILL)) o.role = 'minor';
    if (o.role) continue;
    if (pointInPolygon([0, 0], f.poly)) { o.role = 'hub'; continue; }
    // Fold the centroid into sector 0 (radials 0..2).
    const c = turn(f.centroid, -2 * Math.floor(angleU(f.centroid) / 2));
    if (pointInPolygon(c, gon)) { o.role = 'starKite'; continue; }
    const hit = namedTiles.find(([, t]) => pointInPolygon(c, t));
    const role = hit ? TILE_ROLES[hit[0]] : 'minor';
    // Faces against the frame (other than the outer stars, whose tips touch it) are rim
    // pieces. On the frame polygon every point is at least Rframe·cos(π/n) from the centre.
    const onFrame = f.poly.some(p => Math.hypot(...p) > Rframe * Math.cos(Math.PI / nFrame) - 1e-6);
    const k = Math.floor(angleU(f.centroid) / 2);
    const holdsStarCentre = [0.5, 1.5].some(a => pointInPolygon(turn(at(ref.ro2 * scale, a), 2 * k), f.poly));
    o.role = onFrame && !holdsStarCentre ? 'rim' : role;
  }
  // How each orbit is cut, tried here on one of its fills so the mode is known to work.
  const fillOf = new Map(sw.fills.map(f => [f.faceId, f.poly]));
  for (const o of orbits) o.split = chooseSplit(o, arr.faces[o.faces[0]], fillOf.get(o.faces[0]));

  // Laying order: rank of each orbit's innermost point, so rings are laid from the centre out.
  const byInner = [...orbits].sort((a, b) => a.inner - b.inner);
  byInner.forEach((o, i) => { o.layer = i; });
  // An orbit's axis: the angle (mod 2U) of its first face, used for the 8-fold colour period.
  for (const o of orbits) o.axis = angleU(arr.faces[o.faces[0]].centroid) % 2;

  // A face from a slightly different arrangement still finds its nearest orbit.
  const fallback = (rc, a) => byInner.reduce((best, o) => (Math.abs(o.rc - rc) + Math.abs(o.area - a) < Math.abs(best.rc - rc) + Math.abs(best.area - a) ? o : best), byInner[0]);
  /** Classify an arrangement face (built from these segments, unclipped). */
  function classify(face) {
    const c = face.centroid ?? centroid(face.poly);
    const a = face.area ?? Math.abs(area(face.poly));
    const rc = Math.hypot(...c);
    const o = orbitOf.get(orbitKey(rc, a)) ?? fallback(rc, a);
    const role = ROLES[o.role];
    // 8-fold colour period: every other sector (counted about the orbit's own axis).
    const sector = ((Math.round((angleU(c) - o.axis) / 2) % 16) + 16) % 16;
    const [main, alt] = keyFor(o.role);
    const key = alt && sector % 2 ? alt : main;
    // A halving cut's angle depends on where this copy of the face sits: turn it with the face.
    let split = o.split;
    const m = /^wedges:2:(-?[\d.]+)$/.exec(split);
    if (m) {
      const turnDeg = (Math.round((angleU(c) - o.axis) / 2) * 2 * 180) / 16;
      split = `wedges:2:${(((+m[1] + turnDeg) % 360) + 360) % 360}`;
    }
    return { key, stage: role.stage, kind: role.kind, layer: o.layer, split, role: o.role };
  }

  // ---- Sinopia: what the setter draws on the bed ------------------------------------------
  const circles = [POLAR.HUB_R, ref.rA * scale, ref.ro1 * scale, ref.ro2 * scale, Rframe, ...bands.map(b => b.r1)];
  const tileEdges = new Map();
  for (const t of tiles) {
    for (let i = 0; i < t.length; i++) {
      const a = t[i], b = t[(i + 1) % t.length];
      const k = [a, b].map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).sort().join('|');
      if (!tileEdges.has(k)) tileEdges.set(k, [a, b]);
    }
  }
  const radii = [];
  for (let k = 0; k < 32; k++) radii.push([at(POLAR.HUB_R, k), at(Rframe, k)]);

  return {
    segments, strap, classify, R_M, bands, R_F, disk,
    sinopia: { circles, lines: [...radii, ...tileEdges.values()] },
    tiling: { tiles, scale, frame },
    orbits: orbits.map(({ faces, ...o }) => ({ ...o, count: faces.length })),
    warnings: arr.warnings,
  };
}

// ---------------------------------------------------------------------------------------
// Pieces: the whole cutting pipeline for this medallion (previews, tests, composition)
// ---------------------------------------------------------------------------------------

/**
 * Cut the medallion into finished pieces: arrangement → strapwork → classify → split large
 * fills the way a ma'allem would → cut the hub ring evenly → frame bands → join slivers to
 * their neighbours → grout + wobble.
 *
 * @param {ReturnType<typeof buildRosette>} ros
 * @param {object} [opts]
 * @param {number} [opts.targetLen=POLAR.TARGET_LEN]  strap piece length
 * @param {number} [opts.grout=PIECE.GROUT]
 * @param {number} [opts.wobble=PIECE.WOBBLE]
 * @param {() => number} [opts.rand]  default stream('pieces')
 * @param {boolean} [opts.finish=true]  false returns the exact (un-grouted) pieces
 * @returns {{ pieces: object[], raw: object[], exact: object[], arr: object, sw: object,
 *   dropped: object[] }}  `pieces` finished; `raw` exact pieces after slivers were joined;
 *   `exact` the exact partition before that; `dropped` what was lost, and why
 */
export function rosettePieces(ros, opts = {}) {
  const { targetLen = POLAR.TARGET_LEN, grout = PIECE.GROUT, wobble = PIECE.WOBBLE, finish = true } = opts;
  // Every piece carries: poly, key, stage, kind, layer (fractional within a face: inside out),
  // plus role/faceId/split for fills and `over` for straps.
  const arr = buildArrangement(ros.segments);
  const sw = strapwork(arr, { width: ros.strap, interlace: true, targetLen });

  const raw = [];
  for (const f of sw.fills) {
    const face = arr.faces[f.faceId];
    const c = ros.classify(face);
    const meta = { key: c.key, stage: c.stage, kind: c.kind, layer: c.layer, role: c.role, faceId: f.faceId };
    let parts;
    if (c.split === 'centre+points' || c.split.startsWith('wedges')) parts = splitStar(f.poly, face.centroid, c.split);
    else if (c.split === 'run') parts = splitRun(f.poly, POLAR.RUN_LEN);
    else parts = [f.poly];
    // Pieces cut from one face are laid from the inside out: a fractional layer by radius.
    const radii = parts.map(p => Math.hypot(...centroid(p)));
    const r0 = Math.min(...radii), span = Math.max(...radii) - r0 || 1;
    parts.forEach((p, i) => raw.push({ poly: p, ...meta, layer: c.layer + (0.9 * (radii[i] - r0)) / span, split: c.split }));
  }
  // A strap is laid with the ring of faces it bounds: the last orbit starting inside it.
  const byInner = [...ros.orbits].sort((a, b) => a.inner - b.inner);
  const layerAt = poly => {
    const rMin = Math.min(...poly.map(p => Math.hypot(...p)));
    let layer = 0;
    for (const o of byInner) if (o.inner <= rMin + ros.strap) layer = o.layer;
    return layer;
  };
  // The hub ring is one closed run, which the engine cuts at uneven places. A setter cuts it
  // into equal pieces, so gather it and cut it on the odd radii (see recutHubRing).
  const hubOuter = POLAR.HUB_R + ros.strap / 2 + 0.1;
  const isHub = s => s.poly.every(p => Math.hypot(...p) < hubOuter);
  for (const s of sw.straps) {
    if (isHub(s)) continue;
    raw.push({ poly: s.poly, key: 'K', stage: 'Strapwork', kind: 'strap', layer: layerAt(s.poly), over: s.over });
  }
  // The hub ring goes down right after the centre piece.
  for (const poly of recutHubRing(sw.straps.filter(isHub).map(s => s.poly))) {
    raw.push({ poly, key: 'K', stage: 'Central 16-point star', kind: 'strap', layer: 0.5, over: false });
  }

  // No clipping is needed: the lines stop at the frame, so the strapwork's outline is the frame
  // strap's outer edge, which is exactly ros.disk, a hair inside R_M where the bands begin.
  const dropped = [];
  const clipped = raw.slice();
  let layer = Math.max(...ros.orbits.map(o => o.layer)) + 1;
  for (const b of ros.bands) {
    for (const poly of bandPieces({ r0: b.r0, r1: b.r1, count: b.count })) {
      clipped.push({ poly, key: b.key, stage: b.stage, kind: 'band', layer });
    }
    layer++;
  }
  const merged = absorbSlivers(clipped, POLAR.MIN_PIECE, dropped, grout / 2, wobble);
  const pieces = finish
    ? finishPieces(merged, { grout, wobble, rand: opts.rand ?? stream('pieces'), onDrop: (p, why) => dropped.push({ p, why }) })
    : merged;
  return { pieces, raw: merged, exact: clipped, arr, sw, dropped };
}

/**
 * Re-cut the hub ring (the union of its strap pieces, an annulus) into 8 equal sectors, each
 * holding two spokes, split along every other odd radius (sixteen would be slivers at this
 * small radius; eight keeps the cuts symmetric with an 8-fold period).
 * @param {Poly[]} polys
 * @returns {Poly[]}
 */
function recutHubRing(polys) {
  if (!polys.length) return [];
  // The hub polygon has vertices exactly on the odd radii, where the cuts run, and
  // polygon-clipping cannot resolve a cut through a vertex. Turning the ring by a hair
  // (1e-7 rad) before cutting, and back afterwards, moves them off the cut lines.
  const eps = 1e-7;
  const ring = pc.union(...polys.map(p => [[...p, p[0]].map(q => rotate(q, eps))]));
  const R = 4 * POLAR.HUB_R;
  const out = [];
  for (let k = 0; k < 8; k++) {
    const wedge = [[0, 0], at(R, 4 * k - 1), at(R, 4 * k), at(R, 4 * k + 1), at(R, 4 * k + 2), at(R, 4 * k + 3), [0, 0]];
    for (const part of pc.intersection(ring, [wedge])) {
      const outer = ensureCCW(part[0].slice(0, -1).map(q => rotate(q, -eps)));
      if (outer.length >= 3 && area(outer) > 1e-9) out.push(outer);
    }
  }
  return out;
}

/**
 * Join every piece that could end up smaller than `minArea` once grouted (inset by `inset`,
 * then wobbled by up to `wobble`) to the neighbour it shares the longest edge with,
 * preferring a strap (a sliver between straps is strap, to the eye and to the setter). Pieces
 * of an exact partition share their edges' end points, so neighbours are found by edge keys.
 * A sliver with no edge neighbour, or whose union would not be one simple piece, is dropped.
 * @param {object[]} pieces  {poly, ...}
 * @param {number} minArea
 * @param {object[]} [dropped]  receives {p, why} for dropped slivers
 * @returns {object[]}
 */
export function absorbSlivers(pieces, minArea, dropped = [], inset = 0, wobble = 0) {
  // Judge each piece by the smallest area it can have once grouted: inset for the grout, then
  // every vertex moved inward by the wobble (at worst the area shrinks by wobble × perimeter).
  const perimeter = q => q.reduce((t, p, i) => t + dist(p, q[(i + 1) % q.length]), 0);
  const finalArea = poly => {
    const q = inset > 0 ? insetPolygon(poly, inset) : poly;
    return q ? Math.abs(area(q)) - wobble * perimeter(q) : 0;
  };
  const k = p => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const ek = (a, b) => { const x = k(a), y = k(b); return x < y ? `${x}|${y}` : `${y}|${x}`; };
  const out = pieces.map(p => ({ ...p }));
  const byEdge = new Map();
  out.forEach((p, i) => p.poly.forEach((a, j) => {
    const key = ek(a, p.poly[(j + 1) % p.poly.length]);
    if (!byEdge.has(key)) byEdge.set(key, []);
    byEdge.get(key).push(i);
  }));
  const gone = new Set();
  const order = out.map((p, i) => i).filter(i => finalArea(out[i].poly) < minArea);
  for (const i of order) {
    const sl = out[i];
    const shared = new Map();   // neighbour index → shared edge length
    sl.poly.forEach((a, j) => {
      const b = sl.poly[(j + 1) % sl.poly.length];
      for (const n of byEdge.get(ek(a, b)) ?? []) if (n !== i && !gone.has(n)) shared.set(n, (shared.get(n) ?? 0) + dist(a, b));
    });
    const candidates = [...shared].sort((x, y) => (out[y[0]].kind === 'strap') - (out[x[0]].kind === 'strap') || y[1] - x[1]);
    let done = false;
    for (const [n] of candidates) {
      let u;
      try { u = pc.union([[...out[n].poly, out[n].poly[0]]], [[...sl.poly, sl.poly[0]]]); } catch { continue; }
      if (u.length !== 1 || u[0].length !== 1) continue;
      const poly = ensureCCW(u[0][0].slice(0, -1));
      // The joined piece must still take its grout inset (a pinched join would not).
      if (inset > 0 && !insetPolygon(poly, inset)) continue;
      out[n] = { ...out[n], poly };
      // The neighbour's outline changed: index its new edges.
      poly.forEach((a, j) => {
        const key = ek(a, poly[(j + 1) % poly.length]);
        if (!byEdge.has(key)) byEdge.set(key, []);
        byEdge.get(key).push(n);
      });
      done = true;
      break;
    }
    gone.add(i);
    if (!done) dropped.push({ p: sl, why: 'sliver with no neighbour to join' });
  }
  return out.filter((p, i) => !gone.has(i));
}
