// Cutting: from exact pattern regions to the pieces a craftsman would cut.
//
//   clipPieces     keep the part of each piece inside a region (and outside holes)
//   splitStar      cut a large star radially (centre + points, or n wedges)
//   splitRun       cut a long piece across its length
//   bandPieces     a ring of annular sectors (frame bands)
//   finishPieces   inset by half the grout, then wobble the outline like a hand-cut tile
//   checkPartition test helper: do the pieces cover a region exactly once?
//
// Boolean operations use polygon-clipping (robust, handles shared edges). Pure JavaScript,
// runs in Node.

import pc from 'polygon-clipping';
import {
  area, bbox, ensureCCW, dedupe, removeCollinear, isSimple, pointInPolygon, distToBoundary,
  distToSegment, interiorPoint, insetPolygon, wobble as wobblePoly, annularSector, orient, dist, polar,
} from './geom.js';
import { stream } from '../util/rand.js';

/**
 * @typedef {import('./geom.js').Point} Point
 * @typedef {import('./geom.js').Poly} Poly
 * @typedef {{poly: Poly} & Record<string, any>} PieceLike  any object with a `poly`; other
 *   fields (key, stage, kind, faceId, ...) are carried through unchanged
 */

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------------------

/**
 * Clip pieces to a region: keep the part of each piece inside `inside` (the union of its
 * polygons) and outside every `outside` polygon (holes). One piece can come out as several
 * (each keeps the original's metadata) or vanish. Pieces entirely inside and clear of all
 * holes are passed through untouched, which keeps this fast for big fields.
 *
 * @param {PieceLike[]} pieces
 * @param {object} [opts]
 * @param {Poly | Poly[] | null} [opts.inside]   region(s) to keep; null keeps everything
 * @param {Poly | Poly[]} [opts.outside]         hole(s) to remove
 * @param {number} [opts.minArea=1e-6]           drop slivers smaller than this
 * @param {(piece: PieceLike, reason: string) => void} [opts.onDrop]  told about drops
 * @returns {PieceLike[]}
 */
export function clipPieces(pieces, { inside = null, outside = [], minArea = 1e-6, onDrop } = {}) {
  const ins = asPolys(inside).map(indexRegion);
  const outs = asPolys(outside).map(indexRegion);
  const insMulti = ins.map(r => [r.poly]);
  const result = [];
  for (const piece of pieces) {
    const poly = piece.poly;
    const box = bbox(poly);
    // Fast paths first: polygon-clipping is only needed where a piece meets a boundary.
    let needClip = false;
    if (ins.length) {
      const near = ins.filter(r => boxesOverlap(r.box, box));
      if (!near.some(r => !regionDisjoint(r, poly, box))) { onDrop?.(piece, 'outside region'); continue; }
      if (!near.some(r => regionContains(r, poly, box))) needClip = true;
    }
    const holes = outs.filter(r => boxesOverlap(r.box, box));
    if (holes.some(h => regionContains(h, poly, box))) { onDrop?.(piece, 'inside hole'); continue; }
    if (!needClip && holes.some(h => !regionDisjoint(h, poly, box))) needClip = true;
    if (!needClip) { result.push(piece); continue; }

    let geom = [[poly]];
    if (ins.length) geom = pc.intersection(geom, insMulti);
    if (holes.length && geom.length) geom = pc.difference(geom, holes.map(h => [h.poly]));
    const parts = flattenHoles(geom);
    if (!parts.length) { onDrop?.(piece, 'outside region'); continue; }
    for (const p of parts) {
      if (area(p) < minArea) { onDrop?.({ ...piece, poly: p }, 'sliver'); continue; }
      result.push({ ...piece, poly: p });
    }
  }
  return result;
}

/** Accept one polygon or a list of polygons; return a list. */
function asPolys(x) {
  if (!x || !x.length) return [];
  return typeof x[0][0] === 'number' ? [x] : x;
}

function boxesOverlap(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * A clip region with its edges bucketed into horizontal slabs, so testing a point (or a
 * small piece) only looks at the few edges at that height, not all of a 400-gon circle.
 */
function indexRegion(p) {
  const poly = ensureCCW(dedupe(p));
  const box = bbox(poly), n = poly.length;
  const count = Math.max(1, Math.min(512, n >> 1));
  const h = (box[3] - box[1]) / count || 1;
  const slabs = Array.from({ length: count }, () => []);
  const slabOf = y => Math.min(count - 1, Math.max(0, Math.floor((y - box[1]) / h)));
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let k = slabOf(Math.min(a[1], b[1])); k <= slabOf(Math.max(a[1], b[1])); k++) slabs[k].push(i);
  }
  let convex = true;
  for (let i = 0; i < n && convex; i++) if (orient(poly[i], poly[(i + 1) % n], poly[(i + 2) % n]) < 0) convex = false;
  const tol = 1e-12 * Math.max(box[2] - box[0], box[3] - box[1], 1);
  return { poly, box, slabs, slabOf, convex, tol };
}

/** Region edge ids whose slabs overlap the y-range [y0, y1] (may repeat). */
function regionEdges(r, y0, y1) {
  const out = [];
  for (let k = r.slabOf(y0); k <= r.slabOf(y1); k++) out.push(...r.slabs[k]);
  return out;
}

/** Ray casting against only the edges in the point's slab. */
function regionHas(r, p) {
  const [x, y] = p, P = r.poly, n = P.length;
  if (x < r.box[0] || x > r.box[2] || y < r.box[1] || y > r.box[3]) return false;
  let inside = false;
  for (const i of r.slabs[r.slabOf(y)]) {
    const [xi, yi] = P[i], [xj, yj] = P[(i + 1) % n];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Does any region edge touch any edge of the polygon (with bounding box `box`)? */
function regionTouches(r, poly, box) {
  const P = r.poly, n = P.length;
  const seen = new Set();
  for (const i of regionEdges(r, box[1], box[3])) {
    if (seen.has(i)) continue;
    seen.add(i);
    const a = P[i], b = P[(i + 1) % n];
    if (Math.max(a[0], b[0]) < box[0] || Math.min(a[0], b[0]) > box[2]) continue;
    for (let j = 0, m = poly.length; j < m; j++) if (segTouch(a, b, poly[j], poly[(j + 1) % m])) return true;
  }
  return false;
}

/** Is the polygon strictly inside the region (every vertex inside, clear of its outline)? */
function regionContains(r, poly, box) {
  for (const p of poly) {
    if (!regionHas(r, p)) return false;
    for (const i of regionEdges(r, p[1] - r.tol, p[1] + r.tol)) {
      if (distToSegment(p, r.poly[i], r.poly[(i + 1) % r.poly.length]) <= r.tol) return false;
    }
  }
  return r.convex || !regionTouches(r, poly, box); // convex: containing the vertices is enough
}

/** True if the polygon and the region share no point (no touching, neither inside the other). */
function regionDisjoint(r, poly, box) {
  if (regionTouches(r, poly, box)) return false;
  return !regionHas(r, poly[0]) && !pointInPolygon(r.poly[0], poly);
}

function segTouch(a, b, c, d) {
  const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const within = (p, s0, s1) => Math.min(s0[0], s1[0]) <= p[0] && p[0] <= Math.max(s0[0], s1[0]) && Math.min(s0[1], s1[1]) <= p[1] && p[1] <= Math.max(s0[1], s1[1]);
  return (d1 === 0 && within(a, c, d)) || (d2 === 0 && within(b, c, d)) || (d3 === 0 && within(c, a, b)) || (d4 === 0 && within(d, a, b));
}

/**
 * polygon-clipping MultiPolygon → simple polygons. A polygon with holes is cut in two by a
 * vertical line through its first hole, repeatedly, until no holes remain (pieces must be
 * simple outlines for extrusion).
 * @returns {Poly[]} counter-clockwise, not closed
 */
function flattenHoles(multi) {
  const out = [];
  const stack = [...multi];
  for (let guard = 0; stack.length && guard < 10000; guard++) {
    const poly = stack.pop();
    const outer = ensureCCW(dedupe(poly[0].slice(0, -1)));
    if (poly.length === 1) { if (outer.length >= 3) out.push(outer); continue; }
    const hole = dedupe(poly[1].slice(0, -1));
    const x = interiorPoint(ensureCCW(hole))[0];
    const [x0, y0, x1, y1] = bbox(outer);
    const left = [[[x0 - 1, y0 - 1], [x, y0 - 1], [x, y1 + 1], [x0 - 1, y1 + 1]]];
    const right = [[[x, y0 - 1], [x1 + 1, y0 - 1], [x1 + 1, y1 + 1], [x, y1 + 1]]];
    stack.push(...pc.intersection([poly], left), ...pc.intersection([poly], right));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------------------

/**
 * Split a star-shaped piece radially.
 *  - 'centre+points': the polygon through the dents (vertices nearest the centre) becomes
 *    the centre piece, and each point (dent → tip → next dent) its own piece. Falls back to
 *    wedges if the shape is not a clean star.
 *  - 'wedges:n' (or 'wedges:n:deg'): n equal wedges about `centre`; the first cut runs
 *    through the vertex nearest the centre (a dent, so every wedge keeps one whole point),
 *    or at the given angle in degrees.
 *  - 'none': unchanged.
 * @param {Poly} poly
 * @param {Point} centre
 * @param {string} mode
 * @returns {Poly[]} counter-clockwise pieces whose areas sum to the input's
 */
export function splitStar(poly, centre, mode) {
  poly = ensureCCW(dedupe(poly));
  if (!mode || mode === 'none') return [poly];
  const r = poly.map(p => dist(p, centre));
  const n = poly.length;
  if (mode === 'centre+points') {
    const dents = [];
    for (let i = 0; i < n; i++) if (r[i] < r[(i - 1 + n) % n] && r[i] <= r[(i + 1) % n]) dents.push(i);
    if (dents.length >= 3) {
      const core = dents.map(i => poly[i]);
      const parts = [core];
      for (let k = 0; k < dents.length; k++) {
        const pt = [];
        for (let i = dents[k]; ; i = (i + 1) % n) { pt.push(poly[i]); if (i === dents[(k + 1) % dents.length]) break; }
        parts.push(pt);
      }
      const total = parts.reduce((s, p) => s + area(p), 0);
      const ok = parts.every(p => p.length >= 3 && area(p) > 0 && isSimple(p)) && Math.abs(total - area(poly)) <= 1e-9 * Math.max(1, area(poly));
      if (ok) return parts;
    }
    return splitStar(poly, centre, `wedges:${Math.max(3, dents.length)}`);
  }
  const m = /^wedges:(\d+)(?::(-?[\d.]+))?$/.exec(mode);
  if (!m) throw new Error(`splitStar: unknown mode '${mode}'`);
  const count = +m[1];
  if (count <= 1) return [poly];
  let a0;
  if (m[2] !== undefined) a0 = (+m[2] * Math.PI) / 180;
  else {
    let best = 0;
    for (let i = 1; i < n; i++) if (r[i] < r[best] - 1e-12) best = i;
    a0 = Math.atan2(poly[best][1] - centre[1], poly[best][0] - centre[0]);
  }
  const R = 2 * Math.max(...r) + 1;
  // Ray end points computed once, so neighbouring wedges share them exactly.
  const ray = [];
  for (let k = 0; k <= count; k++) ray.push(k === count ? ray[0] : add2(centre, polar(R, a0 + (TAU * k) / count)));
  const out = [];
  for (let k = 0; k < count; k++) {
    // A wedge wider than 90° gets extra outer points so it still covers the polygon.
    const span = TAU / count, steps = Math.ceil(span / (Math.PI / 2));
    const wedge = [centre, ray[k]];
    for (let s = 1; s < steps; s++) wedge.push(add2(centre, polar(R, a0 + (TAU * k) / count + (span * s) / steps)));
    wedge.push(ray[k + 1]);
    out.push(...flattenHoles(pc.intersection([[poly]], [[wedge]])));
  }
  return out.filter(p => area(p) > 0);
}

const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];

/**
 * Cut a long, roughly straight piece across its length into pieces of about `targetLen`.
 * The length axis is the long side of the piece's minimum-area bounding rectangle; cuts are
 * perpendicular to it at equal spacing. (Curved runs are cut along their centre line by
 * strapwork's `targetLen` option instead.)
 * @param {Poly} poly
 * @param {number} targetLen
 * @returns {Poly[]}
 */
export function splitRun(poly, targetLen) {
  poly = ensureCCW(dedupe(poly));
  const { u, s0, s1, t0, t1 } = minAreaRect(poly);
  const count = Math.round((s1 - s0) / targetLen);
  if (!(count > 1)) return [poly];
  const v = [-u[1], u[0]];
  const at = (s, t) => [u[0] * s + v[0] * t, u[1] * s + v[1] * t];
  const cutS = [];
  for (let k = 0; k <= count; k++) cutS.push(s0 + ((s1 - s0) * k) / count);
  cutS[0] -= 1; cutS[count] += 1;
  const out = [];
  for (let k = 0; k < count; k++) {
    const slab = [at(cutS[k], t0 - 1), at(cutS[k + 1], t0 - 1), at(cutS[k + 1], t1 + 1), at(cutS[k], t1 + 1)];
    out.push(...flattenHoles(pc.intersection([[poly]], [[ensureCCW(slab)]])));
  }
  return out;
}

/** Minimum-area bounding rectangle via the convex hull (rotating the frame to each hull edge). */
function minAreaRect(poly) {
  const hull = convexHull(poly);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const l = dist(a, b);
    if (!(l > 0)) continue;
    const u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], v = [-u[1], u[0]];
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const p of hull) {
      const s = p[0] * u[0] + p[1] * u[1], t = p[0] * v[0] + p[1] * v[1];
      s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    const ar = (s1 - s0) * (t1 - t0);
    if (!best || ar < best.ar) best = { ar, u, s0, s1, t0, t1 };
  }
  // Make u the long axis.
  if (best.t1 - best.t0 > best.s1 - best.s0) {
    const { u, s0, s1, t0, t1 } = best;
    return { u: [-u[1], u[0]], s0: t0, s1: t1, t0: -s1, t1: -s0 };
  }
  return best;
}

/** Andrew's monotone chain convex hull, counter-clockwise. */
function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && orient(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && orient(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * A ring of `count` annular sectors between radii r0 and r1, the first starting at angle a0
 * (radians), centred on the origin. Arcs follow the shared angular grid of
 * `annularSector`, so rings sharing a radius tile without slivers, and the seam where the
 * last sector meets the first uses identical points.
 * @param {{r0: number, r1: number, count: number, a0?: number, maxSeg?: number}} opts
 * @returns {Poly[]}
 */
export function bandPieces({ r0, r1, count, a0 = 0, maxSeg = 0.5 }) {
  const step = TAU / count;
  const out = [];
  for (let k = 0; k < count; k++) out.push(annularSector(r0, r1, a0 + k * step, a0 + (k + 1) * step, maxSeg));
  // The last sector ends at a0 + 2π, which rounds differently from a0: reuse the first
  // sector's start points so the seam closes exactly.
  if (count > 1) {
    const first = out[0], last = out[count - 1];
    const end = polar(r1, a0 + count * step); // computed exactly as annularSector did
    const i = last.findIndex(p => p[0] === end[0] && p[1] === end[1]);
    if (i > 0) {
      last[i] = first[0];
      if (r0 > 0) last[i + 1] = first[first.length - 1];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------------------

/**
 * Turn exact pattern pieces into tiles: inset each by half the grout (mitred, so the gap is
 * the same width everywhere), then wobble the vertices like hand-chipped edges, without ever
 * letting a piece self-intersect or flip. Pieces that are too small for the grout are dropped.
 * @param {PieceLike[]} pieces
 * @param {object} [opts]
 * @param {number} [opts.grout=0.14]   full grout width between neighbours
 * @param {number} [opts.wobble=0.03]  maximum vertex jitter
 * @param {() => number} [opts.rand]   random stream; default stream('pieces')
 * @param {number} [opts.minArea=1e-4] drop finished pieces smaller than this
 * @param {(piece: PieceLike, reason: string) => void} [opts.onDrop]
 * @returns {PieceLike[]} new piece objects (metadata copied) with finished `poly`
 */
export function finishPieces(pieces, { grout = 0.14, wobble = 0.03, rand, minArea = 1e-4, onDrop } = {}) {
  rand = rand ?? stream('pieces');
  const out = [];
  for (const piece of pieces) {
    const clean = removeCollinear(ensureCCW(dedupe(piece.poly)));
    const inset = clean.length >= 3 ? insetPolygon(clean, grout / 2) : null;
    if (!inset) { onDrop?.(piece, 'too small for the grout'); continue; }
    if (area(inset) < minArea) { onDrop?.(piece, 'below minArea'); continue; }
    out.push({ ...piece, poly: wobblePoly(inset, rand, wobble) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

/**
 * Check that pieces partition a region: every piece simple and counter-clockwise, their
 * areas summing to the region's, and no two overlapping. Candidate pairs come from a spatial
 * hash of bounding boxes; a pair overlaps if two edges properly cross, or a vertex (or an
 * interior point) of one lies strictly inside the other. Overlap areas are measured with
 * polygon-clipping. For tests and scripts.
 * @param {(PieceLike | Poly)[]} pieces
 * @param {number | Poly | Poly[]} region  its area, or its polygon(s)
 * @param {{tol?: number}} [opts]  relative area tolerance (default 1e-9)
 * @returns {{ ok: boolean, areaSum: number, regionArea: number, areaError: number,
 *   relError: number, overlaps: {i: number, j: number, area: number}[], overlapArea: number,
 *   invalid: number[] }}
 */
export function checkPartition(pieces, region, { tol = 1e-9 } = {}) {
  const polys = pieces.map(p => (Array.isArray(p) ? p : p.poly));
  const regionArea = typeof region === 'number' ? region : asPolys(region).reduce((s, p) => s + Math.abs(area(p)), 0);
  let areaSum = 0;
  const invalid = [];
  polys.forEach((p, i) => {
    const a = area(p);
    areaSum += a;
    if (!(a > 0) || !isSimple(p)) invalid.push(i);
  });

  // Spatial hash on bounding boxes.
  const boxes = polys.map(bbox);
  const all = bbox(boxes.flatMap(b => [[b[0], b[1]], [b[2], b[3]]]));
  const scale = Math.max(all[2] - all[0], all[3] - all[1], 1);
  const eps = 1e-9 * scale;
  const sizes = boxes.map(b => Math.max(b[2] - b[0], b[3] - b[1])).sort((a, b) => a - b);
  const cell = Math.max(sizes[sizes.length >> 1] || 1, scale / 2000);
  const grid = new Map();
  boxes.forEach((b, i) => {
    for (let cx = Math.floor(b[0] / cell); cx <= Math.floor(b[2] / cell); cx++) {
      for (let cy = Math.floor(b[1] / cell); cy <= Math.floor(b[3] / cell); cy++) {
        const k = cx * 1e6 + cy;
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
      }
    }
  });
  const overlaps = [];
  const tested = new Set();
  for (const list of grid.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = Math.min(list[x], list[y]), j = Math.max(list[x], list[y]);
        const key = i * 1e7 + j;
        if (tested.has(key)) continue;
        tested.add(key);
        const a = boxes[i], b = boxes[j];
        if (a[0] >= b[2] - eps || b[0] >= a[2] - eps || a[1] >= b[3] - eps || b[1] >= a[3] - eps) continue;
        if (!interiorsOverlap(polys[i], polys[j], eps)) continue;
        let ov = 0;
        try { ov = pc.intersection([polys[i]], [polys[j]]).reduce((s, P) => s + Math.abs(area(P[0].slice(0, -1))) - P.slice(1).reduce((h, H) => h + Math.abs(area(H.slice(0, -1))), 0), 0); } catch { ov = NaN; }
        overlaps.push({ i, j, area: ov });
      }
    }
  }
  const overlapArea = overlaps.reduce((s, o) => s + (o.area || 0), 0);
  const areaError = areaSum - regionArea;
  const relError = Math.abs(areaError) / Math.max(regionArea, 1e-300);
  return { ok: relError <= tol && !overlaps.length && !invalid.length, areaSum, regionArea, areaError, relError, overlaps, overlapArea, invalid };
}

/** Do the interiors of two simple polygons overlap (beyond touching within eps)? */
function interiorsOverlap(A, B, eps) {
  // 1. Two edges cross properly: each one's ends lie clearly on opposite sides of the other.
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length];
    const lab = dist(a, b);
    for (let j = 0; j < B.length; j++) {
      const c = B[j], d = B[(j + 1) % B.length];
      const lcd = dist(c, d);
      const d1 = orient(c, d, a) / lcd, d2 = orient(c, d, b) / lcd;
      if (!((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps))) continue;
      const d3 = orient(a, b, c) / lab, d4 = orient(a, b, d) / lab;
      if ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps)) return true;
    }
  }
  // 2. A vertex of one strictly inside the other.
  const strictlyIn = (p, P) => pointInPolygon(p, P) && distToBoundary(p, P) > eps;
  if (A.some(p => strictlyIn(p, B)) || B.some(p => strictlyIn(p, A))) return true;
  // 3. Nested or identical shapes: an interior point of one inside the other.
  return strictlyIn(interiorPoint(A), B) || strictlyIn(interiorPoint(B), A);
}
