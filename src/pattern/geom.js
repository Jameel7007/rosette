// Plane geometry for the pattern engine.
//
// Points are plain arrays [x, y]. Polygons are arrays of points, not closed (no repeated
// first point), and counter-clockwise (positive signed area) unless a function says
// otherwise. Pure JavaScript, no three.js: this runs in Node for tests and scripts.

const TAU = Math.PI * 2;

/**
 * @typedef {[number, number]} Point  A point or vector in the pattern plane.
 * @typedef {Point[]} Poly            A polygon: vertices in order, not closed.
 * @typedef {[Point, Point]} Segment  A line segment.
 */

// ---------------------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------------------

/** @returns {Point} a + b */
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
/** @returns {Point} a − b */
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
/** @returns {Point} a scaled by s */
export const mul = (a, s) => [a[0] * s, a[1] * s];
/** @returns {number} dot product a·b */
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
/** @returns {number} 2D cross product a×b (positive when b is counter-clockwise of a) */
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
/** @returns {number} length of vector a */
export const len = a => Math.hypot(a[0], a[1]);
/** @returns {number} distance between points a and b */
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** @returns {Point} the point a + (b − a)·t */
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** @returns {Point} a scaled to unit length ([0, 0] stays [0, 0]) */
export const normalize = a => { const l = Math.hypot(a[0], a[1]); return l > 0 ? [a[0] / l, a[1] / l] : [0, 0]; };
/** @returns {Point} a turned 90° counter-clockwise: the left-hand normal of a direction */
export const perp = a => [-a[1], a[0]];
/** @returns {Point} a rotated counter-clockwise by `ang` radians */
export const rotate = (a, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
};
/** @returns {Point} the point at radius r and angle `ang` (radians) from the origin */
export const polar = (r, ang) => [r * Math.cos(ang), r * Math.sin(ang)];

/**
 * Orientation of the triangle a, b, c: positive if counter-clockwise, negative if
 * clockwise, zero if collinear. (Twice the triangle's signed area.)
 * @returns {number}
 */
export const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

// ---------------------------------------------------------------------------------------
// Polygon measures
// ---------------------------------------------------------------------------------------

/**
 * Signed area by the shoelace formula ½Σ(xᵢyᵢ₊₁ − xᵢ₊₁yᵢ): positive for counter-clockwise.
 * @param {Poly} poly
 * @returns {number}
 */
export function area(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/**
 * Area centroid (centre of mass of the filled polygon). Falls back to the vertex mean for a
 * polygon with zero area.
 * @param {Poly} poly
 * @returns {Point}
 */
export function centroid(poly) {
  // Measure relative to the first vertex so far-from-origin polygons keep their precision.
  const [ox, oy] = poly[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const x0 = poly[i][0] - ox, y0 = poly[i][1] - oy;
    const p = poly[(i + 1) % n];
    const x1 = p[0] - ox, y1 = p[1] - oy;
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-300) {
    let mx = 0, my = 0;
    for (const q of poly) { mx += q[0]; my += q[1]; }
    return [mx / poly.length, my / poly.length];
  }
  return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

/**
 * The polygon wound counter-clockwise: returns `poly` itself if it already is, otherwise a
 * reversed copy.
 * @param {Poly} poly
 * @returns {Poly}
 */
export function ensureCCW(poly) {
  return area(poly) >= 0 ? poly : poly.slice().reverse();
}

/**
 * Axis-aligned bounding box.
 * @param {Point[]} pts
 * @returns {[number, number, number, number]} [minX, minY, maxX, maxY]
 */
export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

/**
 * Remove consecutive duplicate vertices (including a last vertex equal to the first).
 * @param {Poly} poly
 * @param {number} [tol=0] vertices closer than this count as duplicates
 * @returns {Poly} a new array
 */
export function dedupe(poly, tol = 0) {
  const out = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) > tol || Math.abs(p[1] - q[1]) > tol) out.push(p);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) > tol || Math.abs(a[1] - b[1]) > tol) break;
    out.pop();
  }
  return out;
}

/**
 * Remove vertices where the outline runs straight on (the turn there is below `tol`
 * radians). Spikes (the outline doubling back) are kept: they are a real defect to report.
 * @param {Poly} poly
 * @param {number} [tol=1e-9]
 * @returns {Poly} a new array
 */
export function removeCollinear(poly, tol = 1e-9) {
  const n = poly.length;
  if (n <= 3) return poly.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
    const u = sub(b, a), v = sub(c, b);
    const lu = len(u), lv = len(v);
    // Several straight vertices in a row can all go: they lie on one line.
    const straight = lu > 0 && lv > 0 && dot(u, v) > 0 && Math.abs(cross(u, v)) <= tol * lu * lv;
    if (!straight) out.push(b);
  }
  return out.length >= 3 ? out : poly.slice();
}

// ---------------------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------------------

/**
 * Intersection of two segments p1p2 and q1q2 as a single point.
 * @returns {{point: Point, t: number, u: number} | null} `point = p1 + t(p2 − p1) =
 *   q1 + u(q2 − q1)` with t, u in [0, 1]; null if they miss or are parallel.
 */
export function segIntersect(p1, p2, q1, q2) {
  const r = sub(p2, p1), s = sub(q2, q1);
  const den = cross(r, s);
  if (Math.abs(den) <= 1e-15 * len(r) * len(s)) return null;
  const w = sub(q1, p1);
  const t = cross(w, s) / den, u = cross(w, r) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: [p1[0] + r[0] * t, p1[1] + r[1] * t], t, u };
}

/**
 * Intersection of two infinite lines, each given by a point and a direction.
 * @returns {Point | null} null if the lines are parallel
 */
export function lineIntersect(p, dp, q, dq) {
  const den = cross(dp, dq);
  if (Math.abs(den) <= 1e-12 * len(dp) * len(dq)) return null;
  const t = cross(sub(q, p), dq) / den;
  return [p[0] + dp[0] * t, p[1] + dp[1] * t];
}

/** True if the closed segments ab and cd share at least one point (touching counts). */
export function segmentsTouch(a, b, c, d) {
  const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const within = (p, s0, s1) =>
    Math.min(s0[0], s1[0]) <= p[0] && p[0] <= Math.max(s0[0], s1[0]) &&
    Math.min(s0[1], s1[1]) <= p[1] && p[1] <= Math.max(s0[1], s1[1]);
  return (d1 === 0 && within(a, c, d)) || (d2 === 0 && within(b, c, d)) ||
         (d3 === 0 && within(c, a, b)) || (d4 === 0 && within(d, a, b));
}

/** Distance from point p to the segment ab. */
export function distToSegment(p, a, b) {
  const ab = sub(b, a), l2 = dot(ab, ab);
  let t = l2 > 0 ? dot(sub(p, a), ab) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
}

/** Distance between segments ab and cd (0 if they touch). */
export function segSegDist(a, b, c, d) {
  if (segmentsTouch(a, b, c, d)) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

// ---------------------------------------------------------------------------------------
// Polygon predicates
// ---------------------------------------------------------------------------------------

/**
 * True if the polygon is simple: at least 3 vertices, no zero-length edge, non-zero area,
 * no two non-neighbouring edges touching, and no edge folding back onto its neighbour.
 * O(n²), fine for tile-sized polygons.
 * @param {Poly} poly
 * @returns {boolean}
 */
export function isSimple(poly) {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    if (!Number.isFinite(a[0]) || !Number.isFinite(a[1])) return false;
  }
  if (area(poly) === 0) return false;
  // Neighbouring edges a→b→c fold back if c lies on the line through a, b, behind b.
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
    if (orient(a, b, c) === 0 && dot(sub(b, a), sub(c, b)) < 0) return false;
  }
  if (n === 3) return true;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ax0 = Math.min(a[0], b[0]), ax1 = Math.max(a[0], b[0]);
    const ay0 = Math.min(a[1], b[1]), ay1 = Math.max(a[1], b[1]);
    // Skip j = i + 1 (shares b) and, for i = 0, j = n − 1 (shares a).
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j], d = poly[(j + 1) % n];
      if (Math.max(c[0], d[0]) < ax0 || Math.min(c[0], d[0]) > ax1 ||
          Math.max(c[1], d[1]) < ay0 || Math.min(c[1], d[1]) > ay1) continue;
      if (segmentsTouch(a, b, c, d)) return false;
    }
  }
  return true;
}

/**
 * Point-in-polygon by ray casting (even-odd rule). Points exactly on the boundary may go
 * either way; use `distToBoundary` when that matters.
 * @param {Point} p
 * @param {Poly} poly
 * @returns {boolean}
 */
export function pointInPolygon(p, poly) {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from p to the nearest point of the polygon's outline. */
export function distToBoundary(p, poly) {
  let m = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) m = Math.min(m, distToSegment(p, poly[i], poly[(i + 1) % n]));
  return m;
}

/**
 * A point guaranteed to lie strictly inside a simple polygon (the area centroid can fall
 * outside a concave one). Uses the centroid when it is safely inside, otherwise the middle of
 * the widest interior span along a horizontal line that avoids every vertex.
 * @param {Poly} poly
 * @returns {Point}
 */
export function interiorPoint(poly) {
  const c = centroid(poly);
  const [x0, y0, x1, y1] = bbox(poly);
  const size = Math.max(x1 - x0, y1 - y0);
  if (pointInPolygon(c, poly) && distToBoundary(c, poly) > 1e-6 * size) return c;
  const ys = [...new Set(poly.map(p => p[1]))].sort((a, b) => a - b);
  let best = null, bestW = -1;
  // Try scanlines halfway between consecutive distinct vertex heights (never through a vertex).
  for (let k = 0; k + 1 < ys.length; k++) {
    const y = (ys[k] + ys[k + 1]) / 2;
    const xs = [];
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (w > bestW) { bestW = w; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    }
  }
  return best ?? c;
}

// ---------------------------------------------------------------------------------------
// Offsetting: mitred inset / outset with straight-skeleton edge collapse
// ---------------------------------------------------------------------------------------

/**
 * Offset every edge of a closed polygon to its LEFT by `d` and rebuild each corner as a
 * mitre: the intersection of the two neighbouring offset lines, so offset edges stay
 * parallel to the originals. For a counter-clockwise polygon this is an inset; for a
 * clockwise ring (an outer boundary) it grows outward.
 *
 * When an edge is too short for its two mitred corners, its offset would turn inside out.
 * Such an edge is collapsed (dropped), and its neighbours are extended to meet; this is the
 * "edge event" of a straight skeleton, handled earliest-first.
 *
 * Several original vertices can share one corner after a collapse, so the result maps each
 * original vertex to a corner index rather than returning one corner per vertex.
 *
 * @param {Poly} poly  vertices in order; no repeated consecutive points
 * @param {number} d   offset distance, ≥ 0
 * @returns {{pts: Point[], idx: number[], collapsed: number} | null}
 *   `pts` are the distinct corners in order (the offset polygon), `idx[i]` is the corner of
 *   original vertex i, `collapsed` counts dropped edges. null if fewer than three edges
 *   survive (the polygon is too small for the offset) or two neighbouring edges fold back.
 */
export function mitreOffset(poly, d) {
  const n = poly.length;
  if (n < 3) return null;
  const dir = [], nrm = [];
  for (let i = 0; i < n; i++) {
    const t = normalize(sub(poly[(i + 1) % n], poly[i]));
    if (t[0] === 0 && t[1] === 0) return null; // zero-length edge: dedupe first
    dir.push(t); nrm.push(perp(t));
  }
  // Active edges form a cyclic linked list; collapsing an edge unlinks it.
  const prev = [], next = [], removed = new Uint8Array(n);
  for (let i = 0; i < n; i++) { prev[i] = (i - 1 + n) % n; next[i] = (i + 1) % n; }
  let active = n;

  // Corner where edge i's offset line meets that of the next active edge j, at offset s.
  const corner = (i, j, s) => {
    if (j === (i + 1) % n) {
      // Neighbours share vertex poly[j]. The mitre vector is s(nᵢ + nⱼ)/(1 + tᵢ·tⱼ): it has
      // component s along both normals, and stays exact when the edges are collinear.
      const c = 1 + dot(dir[i], dir[j]);
      if (c < 1e-12) return null; // the outline doubles back on itself (a spike)
      const k = s / c;
      return [poly[j][0] + k * (nrm[i][0] + nrm[j][0]), poly[j][1] + k * (nrm[i][1] + nrm[j][1])];
    }
    // Non-neighbours (after a collapse): intersect the two offset lines directly.
    const pi = [poly[i][0] + s * nrm[i][0], poly[i][1] + s * nrm[i][1]];
    const pj = [poly[j][0] + s * nrm[j][0], poly[j][1] + s * nrm[j][1]];
    const den = cross(dir[i], dir[j]);
    if (Math.abs(den) < 1e-9) {
      // Parallel. If both run the same way along one line, meet halfway across the gap.
      if (dot(dir[i], dir[j]) > 0 && Math.abs(cross(sub(pj, pi), dir[i])) < 1e-9 * (1 + Math.abs(s))) {
        const ei = poly[(i + 1) % n];
        return [(ei[0] + poly[j][0]) / 2 + s * nrm[i][0], (ei[1] + poly[j][1]) / 2 + s * nrm[i][1]];
      }
      return null; // a strip narrower than the offset: nothing left
    }
    const lam = cross(sub(pj, pi), dir[j]) / den;
    return [pi[0] + dir[i][0] * lam, pi[1] + dir[i][1] * lam];
  };

  const tol = 1e-9 * Math.max(1, d);
  const K = new Array(n);
  for (let guard = 0; guard <= n; guard++) {
    if (active < 3) return null;
    for (let i = 0; i < n; i++) {
      if (removed[i]) continue;
      K[i] = corner(i, next[i], d);
      if (!K[i]) return null;
    }
    // Find the edge whose offset side flips first (smallest collapse distance).
    let worst = -1, worstAt = Infinity;
    for (let i = 0; i < n; i++) {
      if (removed[i]) continue;
      const sideD = dot(sub(K[i], K[prev[i]]), dir[i]); // side length at offset d
      if (sideD >= tol) continue;
      const a0 = corner(prev[i], i, 0), b0 = corner(i, next[i], 0);
      const side0 = a0 && b0 ? dot(sub(b0, a0), dir[i]) : 0; // side length at offset 0
      // The side shrinks linearly with the offset; it reaches zero at this distance.
      const at = side0 <= 0 ? 0 : (d * side0) / (side0 - sideD);
      if (at < worstAt) { worstAt = at; worst = i; }
    }
    if (worst < 0) {
      const pts = [], slot = new Array(n);
      for (let i = 0; i < n; i++) if (!removed[i]) { slot[i] = pts.length; pts.push(K[i]); }
      // Vertex v sits at the end of edge v − 1: its corner belongs to the nearest active
      // edge at or before v − 1.
      const idx = new Array(n);
      for (let v = 0; v < n; v++) {
        let p = (v - 1 + n) % n;
        while (removed[p]) p = (p - 1 + n) % n;
        idx[v] = slot[p];
      }
      return { pts, idx, collapsed: n - active };
    }
    removed[worst] = 1;
    next[prev[worst]] = next[worst];
    prev[next[worst]] = prev[worst];
    active--;
  }
  return null;
}

/**
 * Mitred inward offset: every edge moves inward by `d` and stays parallel to itself, so the
 * gap between two neighbouring pieces inset this way is exactly 2d everywhere (sharp tips
 * get cut back, as on a real hand-cut tile). Short edges that would flip are collapsed.
 * @param {Poly} poly  any winding; the result is counter-clockwise
 * @param {number} d   inset distance (e.g. GROUT / 2)
 * @returns {Poly | null} null if the polygon is too small or the result would not be simple
 */
export function insetPolygon(poly, d) {
  const p = dedupe(ensureCCW(poly));
  if (p.length < 3) return null;
  if (!(d > 0)) return p.map(q => [q[0], q[1]]);
  const res = mitreOffset(p, d);
  if (!res) return null;
  const out = dedupe(res.pts);
  if (out.length < 3 || !(area(out) > 0) || !isSimple(out)) return null;
  return out;
}

// ---------------------------------------------------------------------------------------
// Hand-cut wobble
// ---------------------------------------------------------------------------------------

/**
 * Jitter every vertex by at most `amp` (uniform over a disc) so edges look hand-chipped.
 * Each vertex gets a private budget: under half the clearance between any two edges it
 * touches and any other edge (for neighbouring edges, the distance from each one's far end to
 * the other edge). Since every point of an edge then moves less than half of every
 * clearance, no two edges can meet: the result stays simple and keeps its winding. The
 * result is still validated, and the input is returned unchanged if anything is off.
 * Always draws exactly two random numbers per vertex, so streams stay in step.
 * @param {Poly} poly  a simple polygon
 * @param {() => number} rand  a generator from util/rand.js
 * @param {number} amp  maximum displacement
 * @returns {Poly} a new array
 */
export function wobble(poly, rand, amp) {
  const n = poly.length;
  const budget = new Array(n).fill(Math.max(0, amp));
  if (n >= 3 && amp > 0) {
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      for (let j = i + 1; j < n; j++) {
        const c = poly[j], d = poly[(j + 1) % n];
        let clear;
        if (j === i + 1) clear = Math.min(distToSegment(a, c, d), distToSegment(d, a, b)); // share b = c
        else if (i === 0 && j === n - 1) clear = Math.min(distToSegment(b, c, d), distToSegment(c, a, b)); // share a = d
        else clear = segSegDist(a, b, c, d);
        const lim = 0.45 * clear;
        for (const v of [i, (i + 1) % n, j, (j + 1) % n]) if (budget[v] > lim) budget[v] = lim;
      }
    }
  }
  const out = poly.map((p, k) => {
    const r = budget[k] * Math.sqrt(rand()), a = TAU * rand();
    return [p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)];
  });
  if (n < 3 || amp <= 0) return poly.map(p => [p[0], p[1]]);
  const ok = isSimple(out) && Math.sign(area(out)) === Math.sign(area(poly));
  return ok ? out : poly.map(p => [p[0], p[1]]);
}

// ---------------------------------------------------------------------------------------
// Circles and annular sectors on a shared angular grid
// ---------------------------------------------------------------------------------------

/**
 * Point k of a regular n-gon of radius r centred on the origin (vertex 0 on the +x axis).
 * Every circle-based shape here uses this one expression, so shapes that share a circle
 * share its vertices bit for bit and tile without slivers.
 * @returns {Point}
 */
export function circlePoint(r, k, n) {
  const a = (TAU * k) / n;
  return [r * Math.cos(a), r * Math.sin(a)];
}

/**
 * Regular n-gon approximating a circle, counter-clockwise, centred on the origin.
 * @param {number} r radius (vertices lie on the circle)
 * @param {number} n vertex count
 * @param {number} [a0=0] angle of vertex 0 in radians (0 matches `annularSector`'s grid)
 * @returns {Poly}
 */
export function circlePoly(r, n, a0 = 0) {
  const out = [];
  for (let k = 0; k < n; k++) out.push(a0 === 0 ? circlePoint(r, k, n) : polar(r, a0 + (TAU * k) / n));
  return out;
}

/**
 * How many segments to draw a full circle of radius r with chords no longer than `maxSeg`,
 * rounded up to a multiple of `multiple` (16, so the grid keeps the rosette's symmetry).
 * Depends only on r and maxSeg, so independent callers agree on the vertices of a circle.
 * @returns {number}
 */
export function arcSegments(r, maxSeg = 0.5, multiple = 16) {
  if (!(r > 0)) return multiple;
  return multiple * Math.max(1, Math.ceil((TAU * r) / (maxSeg * multiple)));
}

/**
 * Annular sector between radii r0 < r1 and angles a0 < a1 (radians), counter-clockwise,
 * centred on the origin. Arc vertices are the two end angles plus every grid angle of
 * `arcSegments(r, maxSeg)` strictly between them, so neighbouring sectors, rings and
 * `circlePoly(r, arcSegments(r, maxSeg))` all share vertices exactly. r0 = 0 gives a pie slice.
 * @returns {Poly}
 */
export function annularSector(r0, r1, a0, a1, maxSeg = 0.5) {
  const arc = (r, from, to) => {
    const n = arcSegments(r, maxSeg);
    const pts = [polar(r, from)];
    const k0 = Math.floor((from * n) / TAU + 1e-9) + 1, k1 = Math.ceil((to * n) / TAU - 1e-9) - 1;
    for (let k = k0; k <= k1; k++) pts.push(circlePoint(r, ((k % n) + n) % n, n));
    pts.push(polar(r, to));
    return pts;
  };
  const outer = arc(r1, a0, a1);
  const inner = r0 > 0 ? arc(r0, a0, a1).reverse() : [[0, 0]];
  return outer.concat(inner);
}
