// The 16-fold medallion, variant "lee": A. J. Lee's rosette at the core.
//
// Everything is drawn the way a setter draws it on the bed, with a compass (circles about
// the centre) and a straightedge (lines through constructed points). No coordinate is
// placed by hand: every radius follows from R_F (the medallion's outer radius) and the
// sixteen divisions of the circle, working from the frame inward.
//
// The construction, from the centre out:
//
//   1. THE SMALL ROSETTE. Lee's construction (Kaplan, "Computer Generated Islamic Star
//      Patterns", Bridges 2000; ported from From the Point's geometry/rosette.ts): inscribe
//      a regular 16-gon (corners A) and the 16-gon of its edge midpoints (D, the petal
//      tips). The bisector of the corner angle OAB meets the midpoint chord CD at the
//      petal's shoulder E; a line through E parallel to the petal's axis OD meets the corner
//      radius OA at F, a point of the central star; the neighbouring petal's flank, carried
//      on through F, meets the petal axis at N, a notch of the star. The midpoint chords,
//      drawn tip to tip, are the rosette's crown and carry the petals' shoulders.
//      At this size the thin dart between two petals' parallel flanks is narrower than a
//      strap, so by default one strap runs down the dart's centre line (the corner radius)
//      instead of two flanks squeezed together (opts.smallDarts = 'lee' draws the flanks).
//
//   2. THE GREAT ROSETTE. The same construction, larger and turned half a division
//      (11.25°). Its star lines are carried inward past their notches, Hankin-fashion, to
//      their next crossing, and the scale is chosen so that this crossing lands exactly on
//      the small rosette's petal tips. So the great rosette's inner star IS the small
//      rosette plus sixteen triangular "shields" (its points), and long kites fill the great
//      star's points. Here the darts between the great petals are wide enough to be real
//      pieces, so the great petals keep Lee's parallel flanks.
//
//   3. THE CROWN OF KITES. The great petals' shoulder lines are carried straight on past the
//      petal tips, as a Hankin ray carries on across a tile edge. They cross in pairs over
//      every tip and meet again on the circle through their third crossings: a ring of
//      kites over the tips, with an arched panel between each pair.
//
//   4. THE STAR BAND. Between that circle and the next, 32 cells. Hankin's rays at the
//      field's own contact angle (67.5°) from the middle of every cell edge draw a band of
//      32 four-point stars, the lines crossing from cell to cell.
//
//   5. THE SAWTOOTH. A 32-tooth zigzag between the next two circles.
//
//   6. THE FRAME. Plain rings outside the strapwork disk, cut into sectors.
//
// Pure JavaScript, no three.js: this runs in Node for tests and the preview script.

import { MEDALLION } from '../../config.js';
import {
  arcSegments, circlePoint, circlePoly, pointInPolygon, polar, lineIntersect, sub, add, normalize, rotate,
} from '../geom.js';
import { buildArrangement } from '../graph.js';
import { strapwork } from '../strap.js';
import { clipPieces, splitStar, splitRun, bandPieces, finishPieces } from '../cut.js';
import { stream } from '../../util/rand.js';

const TAU = Math.PI * 2;
const N = 16;              // sixteen divisions
const STEP = TAU / N;      // one division, 22.5°
const HALF = STEP / 2;     // half a division, 11.25°: from a corner radius to a petal axis
const DEG = Math.PI / 180;

/**
 * @typedef {import('../geom.js').Point} Point
 * @typedef {import('../geom.js').Poly} Poly
 * @typedef {import('../geom.js').Segment} Segment
 */

// ---------------------------------------------------------------------------------------
// Tunables (this variant's own; config.js holds the shared ones)
// ---------------------------------------------------------------------------------------

/** Proportions of the medallion. No radius is listed: they all follow from R_F. */
export const LEE = {
  STRAP: 0.44,            // strapwork width (the field's is 0.46; a hair finer suits the small core)
  NEST: 'beta',           // how the great rosette holds the small one ('alpha' | 'beta', see step 2)
  SMALL_DARTS: 'radial',  // 'radial': one strap down each small dart; 'lee': Lee's two flanks
  CENTRE_CUT: 'centre+points', // the central star: a 16-gon centre and 16 points, or 'none'
  CELLS: 32,              // cells in a star band, teeth in the sawtooth
  STAR_BANDS: [67.5],     // star bands from the inside out, by Hankin contact angle (degrees)
  TOOTH_APEX: 78.75,      // apex angle of a sawtooth tooth, degrees (seven half-divisions)
  // The frame, inside out. Widths are in strap widths, so the frame keeps its proportion to
  // the line work.
  BANDS: [
    { key: 'A', w: 1.5 },   // gold fillet against the sawtooth's black circle
    { key: 'K', w: 1.1 },
    { key: 'R', w: 2.6 },   // the terracotta ring
    { key: 'K', w: 1.1 },
    { key: 'A', w: 1.3 },
    { key: 'K', w: 1.4 },   // the outer black line the field is cut against
  ],
  BAND_PIECE: 1.5,        // about this long, one frame piece along its ring
  CLIP_OVERLAP: 0.03,     // the outermost strap circle reaches this far past R_M, so clipping trims it
};

/** Laying order: 0 is the centre piece, increasing outward. */
export const LAYERS = {
  centre: 0, petals: 1, shields: 2, greatStar: 3, greatPetals: 4, greatDarts: 5,
  kites: 6, arches: 7, starBand: 8, sawtooth: 9, bands: 10,
};

// ---------------------------------------------------------------------------------------
// Lee's construction
// ---------------------------------------------------------------------------------------

/**
 * Lee's n-fold rosette (a port of From the Point's `rosette()`), built in one sector at unit
 * circumradius, then scaled so the petal tips D lie on `tipRadius` and turned so tip 0
 * points along `tipAngle`.
 *
 * Per petal i:
 *   D[i]  the tip, on the petal axis at tipAngle + i·step
 *   E[i]  the shoulder on the smaller-angle side; E2[i] is its mirror image in the axis
 *   F[i]  the star point on the corner radius just before the axis (F[i + 1] is just after)
 *   N[i]  the star's notch, on the petal axis
 *   A[i]  the corner of the circumscribed n-gon, on F[i]'s radius
 * so petal i is the hexagon D[i], E[i], F[i], N[i], F[i + 1], E2[i].
 *
 * @param {number} tipRadius
 * @param {number} tipAngle  radians
 * @param {number} [n=16]
 */
export function leeRosette(tipRadius, tipAngle, n = N) {
  const step = TAU / n;
  // Unit-circumradius construction with corner A on the +x axis.
  const O = [0, 0];
  const A = [1, 0], B = polar(1, step), Z = polar(1, -step);
  const D = mid(A, B), C = mid(Z, A);
  // Shoulder E: the bisector of angle OAB cut with the midpoint chord CD.
  const bisector = normalize(add(normalize(sub(O, A)), normalize(sub(B, A))));
  const E = lineIntersect(C, sub(D, C), A, bisector);
  // Flank F: on OA, through E parallel to the petal axis OD.
  const F = lineIntersect(O, A, E, D);
  // Notch N: the neighbouring petal's flank (through the mirror image of E in OA), carried
  // on through F, meets the petal axis.
  const Eprev = [E[0], -E[1]];
  const Nn = lineIntersect(Eprev, sub(F, Eprev), O, D);
  const axis = step / 2;
  const E2 = reflect(E, axis);

  const scale = tipRadius / Math.hypot(D[0], D[1]);
  const spin = tipAngle - axis;
  const place = (p, i) => rotate([p[0] * scale, p[1] * scale], spin + i * step);
  const out = { D: [], E: [], E2: [], F: [], N: [], A: [], n, tipRadius, tipAngle };
  for (let i = 0; i < n; i++) {
    out.D.push(place(D, i)); out.E.push(place(E, i)); out.E2.push(place(E2, i));
    out.F.push(place(F, i)); out.N.push(place(Nn, i)); out.A.push(place(A, i));
  }
  const rad = p => Math.hypot(p[0], p[1]) * scale;
  out.radii = {
    D: tipRadius, E: rad(E), F: rad(F), N: rad(Nn), A: scale,
    // The n star lines (flanks carried through F) all touch one circle, of this radius...
    starTangent: rad(Nn) * Math.cos((6 * Math.PI) / n),
    // ...and the n crown chords (which carry the shoulders) touch this one.
    crownTangent: tipRadius * Math.cos(Math.PI / n),
  };
  return out;
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** Mirror image of p in the line through the origin at angle `ang`. */
function reflect(p, ang) {
  const c = Math.cos(2 * ang), s = Math.sin(2 * ang);
  return [p[0] * c + p[1] * s, p[0] * s - p[1] * c];
}

/**
 * Sixteen lines touching a circle of radius t, one division apart, cross in rings: two
 * lines k divisions apart meet at radius t / cos(k · 11.25°), on the radius half way between
 * their touching points. k = 1 gives the corners of the 16-gon they bound.
 */
export const crossingRadius = (t, k) => t / Math.cos(k * HALF);

// ---------------------------------------------------------------------------------------
// The medallion
// ---------------------------------------------------------------------------------------

/**
 * Build the "lee" medallion: centre lines, how to colour and cut each face, the frame and
 * the sinopia (docs/CONTRACTS.md §3.2).
 * @param {object} [opts]
 * @param {number} [opts.R_F=MEDALLION.R_F_MAX]  outer radius of the frame
 * @param {number} [opts.strap=LEE.STRAP]        strapwork width
 * @param {'alpha'|'beta'} [opts.nest=LEE.NEST]  'beta': the small rosette is the centre of
 *   the great rosette's inner star; 'alpha': the great petals stand on the small petal tips
 * @param {'radial'|'lee'} [opts.smallDarts=LEE.SMALL_DARTS]
 * @param {'centre+points'|'none'} [opts.centreCut=LEE.CENTRE_CUT]
 * @param {number[]} [opts.starBands=LEE.STAR_BANDS]  one contact angle per star band
 */
export function buildRosette(opts = {}) {
  const R_F = opts.R_F ?? MEDALLION.R_F_MAX;
  const strap = opts.strap ?? LEE.STRAP;
  const nest = opts.nest ?? LEE.NEST;
  const smallDarts = opts.smallDarts ?? LEE.SMALL_DARTS;
  const centreCut = opts.centreCut ?? LEE.CENTRE_CUT;
  const starBands = opts.starBands ?? LEE.STAR_BANDS;
  if (!(R_F > 0) || !(strap > 0)) throw new Error('buildRosette: R_F and strap must be positive');

  // ---- Radii, from the frame inward ----------------------------------------------------
  const bandWidths = LEE.BANDS.map(b => b.w * strap);
  const R_M = R_F - bandWidths.reduce((s, w) => s + w, 0);
  const cellHalf = Math.PI / LEE.CELLS;                 // half a cell or tooth: 5.625°
  // Sawtooth outer circle: its strap's outer edge reaches just past R_M, so clipping to R_M
  // trims it cleanly and the first ring of the frame sits tight against it.
  const C5 = (R_M - strap / 2 + LEE.CLIP_OVERLAP) / Math.cos(Math.PI / circleSides(R_M));
  // Sawtooth inner circle: a tooth's half base is C4·sin(cellHalf) and its depth C5 − C4 is
  // that over tan(apex / 2).
  const C4 = C5 / (1 + Math.sin(cellHalf) / Math.tan((LEE.TOOTH_APEX * DEG) / 2));
  // Star bands: square cells, so a band's depth equals its cell width at mid radius, which
  // multiplies the radius by (1 + s) / (1 − s), s = sin(cellHalf).
  const s = Math.sin(cellHalf);
  const bandRadii = [C4];
  for (let b = 0; b < starBands.length; b++) bandRadii.unshift((bandRadii[0] * (1 - s)) / (1 + s));
  const C3 = bandRadii[0];
  // C3 runs through the third crossings of the great petals' shoulder lines.
  const crown2 = C3 * Math.cos(3 * HALF);   // the circle those lines touch
  const R2 = crown2 / Math.cos(HALF);       // great petal tip radius
  // The small rosette's tips sit where the great star lines, carried inward, land: on the
  // great notches ('alpha'), or on the next crossing in ('beta').
  const unit = leeRosette(1, 0);
  const R1 = R2 * (nest === 'alpha' ? unit.radii.N : crossingRadius(unit.radii.starTangent, 5));

  // Orientation: the small star's points lie on the x axis (corner radii at 22.5°·i, petal
  // axes half way between). In 'beta' the great rosette is turned half a division, so its
  // petals lie on the small corner radii.
  const small = leeRosette(R1, HALF);
  const great = leeRosette(R2, nest === 'alpha' ? HALF : 0);

  const segments = [];
  const line = (a, b) => segments.push([a, b]);

  // ---- 1. The small rosette ------------------------------------------------------------
  for (let i = 0; i < N; i++) {
    const j = (i + N - 1) % N;
    // The star's two edges into point F[i].
    line(small.F[i], small.N[i]); line(small.F[i], small.N[j]);
    if (smallDarts === 'lee') {
      // Lee's parallel flanks: each star edge carried straight on through F as the
      // neighbouring petal's flank, up to its shoulder.
      line(small.F[i], small.E[i]); line(small.F[i], small.E2[j]);
    } else {
      // One strap down the dart's centre line, from the star point to the crown.
      line(small.F[i], polar(small.radii.crownTangent, i * STEP));
    }
    // The crown: the midpoint chord from tip to tip (it carries both shoulders).
    line(small.D[i], small.D[(i + 1) % N]);
  }

  // ---- 2. The great rosette ------------------------------------------------------------
  // Each great star line runs from a great shoulder, through a great star point, past the
  // great notch, on to a small petal tip.
  for (let i = 0; i < N; i++) {
    const j = (i + N - 1) % N;
    line(great.E2[j], landing(great.E2[j], great.F[i], small.D));
    line(great.E[i], landing(great.E[i], great.F[i], small.D));
  }

  // ---- 3. The great shoulders carried on ------------------------------------------------
  // Great petal i's two shoulders lie on the crown chords either side of its tip. Each chord
  // is carried from the shoulder through the tip and out to its third crossing, on C3.
  for (let i = 0; i < N; i++) {
    const tip = great.tipAngle + i * STEP;
    line(great.E[i], polar(C3, tip - HALF + 3 * HALF));
    line(great.E2[i], polar(C3, tip + HALF - 3 * HALF));
  }

  // ---- 4. The star bands ---------------------------------------------------------------
  starBands.forEach((theta, b) => {
    for (const sg of starBand(bandRadii[b], bandRadii[b + 1], LEE.CELLS, theta * DEG)) segments.push(sg);
  });

  // ---- 5. Circles and the sawtooth -----------------------------------------------------
  for (const r of [...bandRadii, C5]) pushCircle(segments, r);
  // Inner corners on C4 above the band's cell edges; apexes on C5 over the band's stars.
  for (let t = 0; t < LEE.CELLS; t++) {
    const a = (t * TAU) / LEE.CELLS;
    const apex = polar(C5, a + cellHalf);
    line(polar(C4, a), apex);
    line(apex, polar(C4, a + 2 * cellHalf));
  }

  // ---- Classification ------------------------------------------------------------------
  const radii = {
    R1, R2, C3, C4, C5, R_M, R_F, bandRadii,
    smallN: small.radii.N, smallF: small.radii.F, smallCrown: small.radii.crownTangent,
    greatN: great.radii.N, greatF: great.radii.F, greatCrown: crown2,
    X: crossingRadius(crown2, 2), Y: C3,
  };
  const classify = makeClassifier(radii, { nest, smallDarts, centreCut });

  // ---- 6. The frame --------------------------------------------------------------------
  // Every ring is cut into the same number of pieces, so neighbouring rings share their
  // joints exactly, and that number divides the sides of the R_M circle polygon, so the
  // first ring meets the clipped strapwork exactly too.
  const count = bandCount(R_M, (R_M + R_F) / 2);
  const bands = [];
  let r0 = R_M;
  LEE.BANDS.forEach((b, k) => {
    const r1 = r0 + bandWidths[k];
    bands.push({ r0, r1, key: b.key, stage: 'Framing rings', count, layer: LAYERS.bands + k });
    r0 = r1;
  });

  // ---- Sinopia: the setter's red underdrawing ------------------------------------------
  const sinopia = { circles: [small.radii.A, great.radii.A, ...bandRadii, C5, R_M, R_F], lines: [] };
  for (let i = 0; i < N; i++) {
    const k = (i + 1) % N;
    // The 16 corner radii and the 16 petal axes, out to the frame.
    sinopia.lines.push([[0, 0], polar(R_F, i * STEP)], [[0, 0], polar(R_F, i * STEP + HALF)]);
    // Lee's construction for each rosette: the two inscribed 16-gons (corners A and edge
    // midpoints D) and the corner bisectors that locate the shoulders.
    for (const L of [small, great]) sinopia.lines.push([L.A[i], L.A[k]], [L.D[i], L.D[k]], [L.A[i], L.E[i]]);
  }

  return { segments, strap, classify, R_M, bands, R_F, sinopia, radii, lee: { small, great }, nest };
}

/**
 * The first of `targets` that the line from p through q meets, carried on beyond q. (A line
 * can pass through two targets, one each side of the centre: take the nearer.)
 */
function landing(p, q, targets) {
  const d = normalize(sub(q, p));
  const tol = 1e-9 * Math.hypot(q[0], q[1]);
  let best = null, bestAlong = Infinity;
  for (const t of targets) {
    const v = sub(t, q);
    const along = v[0] * d[0] + v[1] * d[1];
    const off = Math.abs(v[0] * d[1] - v[1] * d[0]); // distance from the line
    if (along > 0 && off < tol && along < bestAlong) { bestAlong = along; best = t; }
  }
  if (!best) throw new Error('buildRosette: a great star line misses the small petal tips');
  return best;
}

/**
 * Hankin's method on a ring of `cells` cells between circles r0 and r1 (each cell bounded
 * by two arcs and two radii; cell j spans angles j·cell .. (j + 1)·cell, so the radii
 * between cells lie on mirror lines). From the middle of every cell edge two rays lean into
 * the cell at contact angle theta; each stops where it meets the ray from the next edge.
 * That draws a four-point star per cell whose tips touch both circles. The rays either side
 * of a shared radius are collinear, so each pair is emitted as one line crossing it.
 * @returns {Segment[]}
 */
function starBand(r0, r1, cells, theta) {
  const cell = TAU / cells, c = cell / 2, rm = (r0 + r1) / 2;
  // Cell 0's edges, counter-clockwise (inside on the left): the left radius going out, the
  // outer arc, the right radius coming in, the inner arc. Their midpoints and directions
  // (an arc's direction is its tangent at the midpoint):
  const mids = [polar(rm, 0), polar(r1, c), polar(rm, 2 * c), polar(r0, c)];
  const dirs = [polar(1, 0), polar(1, c + Math.PI / 2), polar(1, 2 * c + Math.PI), polar(1, c - Math.PI / 2)];
  const fwd = dirs.map(d => rotate(d, theta));                  // leans into the cell
  const back = dirs.map(d => rotate([-d[0], -d[1]], -theta));
  // Star corner k: where edge k's forward ray meets edge k+1's backward ray (X[0] is near
  // the cell's outer-left corner, X[1] outer-right, X[2] inner-right, X[3] inner-left).
  const X = [];
  for (let k = 0; k < 4; k++) X.push(lineIntersect(mids[k], fwd[k], mids[(k + 1) % 4], back[(k + 1) % 4]));
  const segments = [];
  for (let j = 0; j < cells; j++) {
    const here = p => rotate(p, j * cell), next = p => rotate(p, (j + 1) * cell);
    // The star's tips on the two circles, each with its two rays.
    segments.push([here(mids[3]), here(X[3])], [here(mids[3]), here(X[2])]);
    segments.push([here(mids[1]), here(X[1])], [here(mids[1]), here(X[0])]);
    // Across the right radius: this cell's ray and the next cell's are one straight line.
    segments.push([here(X[2]), next(X[0])], [here(X[1]), next(X[3])]);
  }
  return segments;
}

/** Sides of a circle polygon: a multiple of 64, so every 5.625° grid angle is a corner. */
function circleSides(r) { return arcSegments(r, 0.5, 64); }
function pushCircle(segments, r) {
  const n = circleSides(r);
  for (let k = 0; k < n; k++) segments.push([circlePoint(r, k, n), circlePoint(r, (k + 1) % n, n)]);
}

/**
 * How many pieces each frame ring is cut into: a multiple of 16 that divides the sides of
 * the R_M circle polygon (the engine's arcSegments(R_M), which the strapwork disk is clipped
 * to), so ring joints land on its corners; as close as possible, as a ratio, to pieces of
 * LEE.BAND_PIECE at radius r.
 */
function bandCount(R_M, r) {
  const sides = arcSegments(R_M);
  const want = (TAU * r) / LEE.BAND_PIECE;
  const off = c => Math.abs(Math.log(c / want));
  let best = 16;
  for (let c = 16; c <= sides; c += 16) if (sides % c === 0 && off(c) < off(best)) best = c;
  return best;
}

// ---------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------

/**
 * Fold a polygon into the fundamental sector of the 16-fold symmetry (angles 0..11.25°) by
 * the rotation, and reflection if needed, that takes the point c (its centroid) there.
 * @returns {{poly: Poly}}
 */
export function foldPoly(poly, c) {
  const a = ((Math.atan2(c[1], c[0]) % TAU) + TAU) % TAU;
  const k = Math.floor(a / STEP);
  let out = poly.map(p => rotate(p, -k * STEP));
  if (a - k * STEP > HALF) out = out.map(p => reflect(p, HALF));
  return { poly: out };
}

/** The mirror line (a multiple of 11.25°) nearest a face centroid's angle, in degrees. */
function axisDegrees(c) {
  const h = HALF / DEG;
  const a = Math.round(Math.atan2(c[1], c[0]) / DEG / h) * h;
  return +(((a % 360) + 360) % 360).toFixed(6);
}

/**
 * Every region of the construction, with a seed point inside it (in the fundamental sector)
 * and how its pieces are coloured, labelled, laid and cut. A face belongs to the region
 * whose seed it holds once folded into the sector.
 *
 * Cuts (contract `split`): 'none' (one piece); 'centre+points' (the central star);
 * 'run' (cut across into pieces along its length); 'across', written out per face as
 * 'wedges:2:<deg>' (one straight cut through the centroid, square to the face's mirror
 * line: the face's inner and outer halves).
 */
function regions(R, { nest, smallDarts, centreCut }) {
  const at = (r, deg) => polar(r, deg * DEG);
  const H = HALF / DEG, Q = H / 2;
  // The great rosette's mirror lines in the sector: its petal axes (gA) and corners (gV).
  const gA = nest === 'alpha' ? H : 0, gV = H - gA;
  // Colours that alternate from one copy to the next round the ring (an 8-fold period for
  // a 16-fold region). Copies sit at offset + k·period degrees; even k takes a, odd k b.
  const alt = (a, b, offset, period) => angle => {
    const k = Math.round((angle - offset) / period);
    return ((k % 2) + 2) % 2 ? b : a;
  };
  const regs = [
    { name: 'centre', seed: at(R.smallN * 0.3, 1), key: 'G', stage: 'Central 16-point star', kind: 'star16', layer: LAYERS.centre, split: centreCut },
    { name: 'petal', seed: at((R.smallN + R.R1) / 2, H), key: 'W', stage: 'Petal kites', kind: 'petal', layer: LAYERS.petals, split: 'none' },
  ];
  // Lee's thin darts between the small petals (absorbed by the strap; with radial darts
  // they are strap, not faces).
  if (smallDarts === 'lee') regs.push({ name: 'dart', seed: at((R.smallF + R.smallCrown) / 2, 0), key: 'K', stage: 'Petal kites', kind: 'dart', layer: LAYERS.petals, split: 'none' });
  if (nest === 'alpha') {
    regs.push({ name: 'greatPoint', seed: at((R.smallCrown + R.greatF) / 2, 0), key: 'R', stage: 'Great star', kind: 'point', layer: LAYERS.greatStar, split: 'across' });
  } else {
    regs.push({ name: 'shield', seed: at((R.smallCrown + R.greatN) / 2, 0), key: 'R', stage: 'Shields', kind: 'shield', layer: LAYERS.shields, split: 'none' });
    regs.push({ name: 'greatKite', seed: at((R.R1 + R.greatF) / 2, H), key: alt('B', 'T', H, 2 * H), stage: 'Great star', kind: 'kite', layer: LAYERS.greatStar, split: 'across' });
  }
  regs.push(
    { name: 'greatPetal', seed: at((R.greatN + R.R2) / 2, gA), key: 'W', stage: 'Great petals', kind: 'petal', layer: LAYERS.greatPetals, split: 'run' },
    { name: 'greatDart', seed: at((R.greatCrown + R.X) / 2, gV), key: 'A', stage: 'Great petals', kind: 'dart', layer: LAYERS.greatDarts, split: 'none' },
    { name: 'kite', seed: at((R.R2 + R.Y) / 2, gA), key: 'O', stage: 'Crown of kites', kind: 'kite', layer: LAYERS.kites, split: 'across' },
    { name: 'arch', seed: at((R.X + R.C3) / 2, gV), key: 'G', stage: 'Crown of kites', kind: 'arch', layer: LAYERS.arches, split: 'none' },
  );
  R.bandRadii.slice(0, -1).forEach((r0, b) => {
    const r1 = R.bandRadii[b + 1], rm = (r0 + r1) / 2, layer = LAYERS.starBand + b * 0.5;
    regs.push({ name: 'bandStar', seed: at(rm, Q), key: b % 2 ? alt('T', 'B', Q, H) : alt('B', 'T', Q, H), stage: 'Star band', kind: 'star4', layer, split: 'none' });
    // The cream pieces round each star, against the inner and outer circles, on both
    // mirror lines of the sector.
    for (const a of [0, H]) {
      regs.push({ name: 'bandInner', seed: at((r0 + rm) / 2, a), key: 'W', stage: 'Star band', kind: 'hex', layer, split: 'none' });
      regs.push({ name: 'bandOuter', seed: at((rm + r1) / 2, a), key: 'W', stage: 'Star band', kind: 'hex', layer, split: 'none' });
    }
  });
  regs.push({ name: 'tooth', seed: at(R.C4 + 0.25 * (R.C5 - R.C4), Q), key: 'B', stage: 'Sawtooth band', kind: 'tooth', layer: LAYERS.sawtooth, split: 'none' });
  for (const a of [0, H]) regs.push({ name: 'toothGround', seed: at(R.C5 - 0.25 * (R.C5 - R.C4), a), key: 'W', stage: 'Sawtooth band', kind: 'ground', layer: LAYERS.sawtooth, split: 'across' });
  return regs;
}

function makeClassifier(R, opts) {
  const regs = regions(R, opts);
  /**
   * @param {{poly: Poly, centroid: Point}} face  an arrangement face (unclipped)
   * @returns {{key: string, stage: string, kind: string, layer: number, split: string, region: string}}
   */
  return function classify(face) {
    const { poly } = foldPoly(face.poly, face.centroid);
    const angle = Math.atan2(face.centroid[1], face.centroid[0]) / DEG;
    for (const reg of regs) {
      if (!pointInPolygon(reg.seed, poly)) continue;
      const key = typeof reg.key === 'function' ? reg.key(angle) : reg.key;
      // 'across': one cut through the centroid, square to the face's mirror line. (A cut
      // ALONG the mirror line would run exactly through the face's tips, which
      // polygon-clipping does not handle reliably.)
      const split = reg.split === 'across' ? `wedges:2:${axisDegrees(face.centroid) + 90}` : reg.split;
      return { key, stage: reg.stage, kind: reg.kind, layer: reg.layer, split, region: reg.name };
    }
    return { key: 'W', stage: 'Strapwork', kind: 'unknown', layer: LAYERS.bands, split: 'none', region: 'unknown' };
  };
}

// ---------------------------------------------------------------------------------------
// Reference cutting (what compose.js does with a design), for the preview script and tests
// ---------------------------------------------------------------------------------------

/**
 * Lay the medallion out the way the composition does: faces → strapwork → classify → cut
 * (split centre = the face's centroid) → clip to R_M → frame rings → grout and wobble.
 * @param {ReturnType<typeof buildRosette>} ros
 * @param {{targetLen?: number, grout?: number, wobble?: number}} [opts]
 * @returns {{arr: object, sw: object, exact: object[], tiles: object[], warnings: object[]}}
 *   `exact`: the pieces before grout (they partition the medallion disk exactly);
 *   `tiles`: the finished pieces
 */
export function cutRosette(ros, { targetLen = 1.2, grout = 0.14, wobble = 0.03 } = {}) {
  const arr = buildArrangement(ros.segments);
  const sw = strapwork(arr, { width: ros.strap, targetLen });
  const pieces = [];
  let fallbacks = 0;
  for (const f of sw.fills) {
    const face = arr.faces[f.faceId];
    const cls = ros.classify(face);
    let parts;
    try {
      parts = cls.split === 'run' ? splitRun(f.poly, targetLen)
        : cls.split !== 'none' ? splitStar(f.poly, face.centroid, cls.split)
        : [f.poly];
    } catch {
      // polygon-clipping occasionally fails on these cuts (reported to the engine's owner).
      // Every face this design cuts is convex, so cut it directly instead.
      fallbacks++;
      parts = convexSplit(f.poly, face.centroid, cls.split, targetLen);
    }
    for (const poly of parts) pieces.push({ poly, ...cls, faceId: f.faceId });
  }
  for (const st of sw.straps) pieces.push({ poly: st.poly, key: 'K', stage: 'Strapwork', kind: 'strap', over: st.over });
  const exact = clipPieces(pieces, { inside: circlePoly(ros.R_M, arcSegments(ros.R_M)), minArea: 0 });
  for (const b of ros.bands) {
    for (const poly of bandPieces({ r0: b.r0, r1: b.r1, count: b.count })) {
      exact.push({ poly, key: b.key, stage: b.stage, kind: 'band', layer: b.layer });
    }
  }
  const tiles = finishPieces(exact, { grout, wobble, rand: stream('pieces') });
  return { arr, sw, exact, tiles, fallbacks, warnings: [...arr.warnings, ...sw.warnings] };
}

/**
 * Cut a convex polygon with straight lines, without polygon-clipping: 'wedges:2:<deg>' is
 * one line through c at that angle; 'run' is cuts square to the face's mirror line (the
 * radius through c), spaced about targetLen apart. Shared cut points are computed once, so
 * the pieces tile the polygon exactly.
 */
function convexSplit(poly, c, split, targetLen) {
  const m = /^wedges:2:(-?[\d.]+)$/.exec(split);
  if (m) { const a = +m[1] * DEG; return halves(poly, c, [Math.cos(a), Math.sin(a)]); }
  if (split !== 'run') return [poly];
  const u = normalize(c);                            // along the mirror line
  const along = poly.map(p => p[0] * u[0] + p[1] * u[1]);
  const lo = Math.min(...along), hi = Math.max(...along);
  const n = Math.max(1, Math.round((hi - lo) / targetLen));
  const out = [];
  let rest = poly;
  for (let k = 1; k < n && rest; k++) {
    const at = lo + ((hi - lo) * k) / n;
    const [inner, outer] = halves(rest, [u[0] * at, u[1] * at], [-u[1], u[0]]);
    if (inner) out.push(inner);
    rest = outer;
  }
  if (rest) out.push(rest);
  return out;
}

/** Split a convex polygon by the line through p with direction d: [right side, left side]. */
function halves(poly, p, d) {
  const side = q => (q[0] - p[0]) * d[1] - (q[1] - p[1]) * d[0]; // > 0: right of the line
  const right = [], left = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) right.push(a);
    if (sa <= 0) left.push(a);
    if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
      const t = sa / (sa - sb);
      const x = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      right.push(x); left.push(x);
    }
  }
  return [right.length >= 3 ? right : null, left.length >= 3 ? left : null];
}
