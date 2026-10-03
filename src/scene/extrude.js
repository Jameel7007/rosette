// Turn flat piece outlines into chunky glazed slabs, written straight into big typed arrays.
//
// Why not THREE.ExtrudeGeometry? At 10,000+ unique pieces, building one geometry per piece and
// merging them costs seconds and a lot of garbage. Here every piece is planned (a few small
// arrays), the totals are summed, ONE set of typed arrays is allocated, and each piece writes
// its vertices and triangles into its slice. Nothing in this file touches the GPU, so it runs
// (and is tested) in Node.
//
// The slab, seen in cross-section at one edge (u = distance in from the outline, y = height):
//
//      y = H  ___________          top cap (flat, normal +y), inset by the bevel
//                        `-.       rounded bevel: a quarter circle in BEVEL_SEGMENTS steps
//      y = H − b            |      normals turn smoothly from up to sideways
//                           |      vertical side
//      y = 0  ______________|      bottom cap (normal −y): seen only while a piece tumbles
//
// Normals are smooth along that profile, and smooth around gentle corners (a wobbled edge or
// a polygonal arc), but split at sharp corners (turn > HARD_TURN_DEG) so star points stay crisp.
//
// Two index lists share the same vertices: the full slab, and a far-view one (level of detail)
// that leaves out the bevel's middle rings: the top cap's edge joins the bottom of the bevel
// (where the normal already faces sideways) in one band, and the side wall stays as it is.
// Seen from far away the bevel is under a pixel wide, but with 4× multisampling every thin
// band along an edge still costs its own shading pass on that edge's pixels, which made the
// bevels the biggest GPU cost of the finished view. scene/pieces.js switches lists.
// (Dropping the side wall too, one band from the cap straight to the foot, measured faster
// still but visibly flattened every piece's edge, even at half a pixel of bevel.)

import { ShapeUtils, Vector2 } from 'three';

/** Slab construction tunables. */
export const SLAB = {
  BEVEL_SEGMENTS: 2,   // steps in the quarter-round bevel
  HARD_TURN_DEG: 35,   // corners turning more than this get split (hard) normals
  MITER_LIMIT: 3,      // the top-cap inset at a sharp convex point moves at most 3 × the bevel
                       // (a 45° star tip needs 2.61, so real tips are exact; slivers are capped)
  MIN_EDGE: 0.004,     // shorter outline edges are merged away before building
};

// ---------------------------------------------------------------- small 2D helpers

/** Signed area of a polygon (positive = counter-clockwise in the math sense). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Twice the signed area of triangle abc (positive when a→b→c turns left). */
function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Do closed segments ab and cd touch or cross? */
function segmentsTouch(a, b, c, d) {
  const eps = 1e-12;
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
      ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) return true;
  // Collinear/touching cases: an endpoint lying on the other segment.
  const onSeg = (p, q, r) => Math.min(p[0], q[0]) - 1e-9 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-9 &&
                             Math.min(p[1], q[1]) - 1e-9 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  if (Math.abs(o1) <= eps && onSeg(a, b, c)) return true;
  if (Math.abs(o2) <= eps && onSeg(a, b, d)) return true;
  if (Math.abs(o3) <= eps && onSeg(c, d, a)) return true;
  if (Math.abs(o4) <= eps && onSeg(c, d, b)) return true;
  return false;
}

/** Is the polygon simple (no two non-adjacent edges touch)? O(n²), fine for piece-sized n. */
export function isSimplePolygon(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;           // edges n−1 and 0 share a vertex
      if (segmentsTouch(a, b, pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Even-odd point-in-polygon test. */
function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Copy a polygon, make it counter-clockwise, and drop vertices that would make degenerate
 * geometry: near-duplicates (closer than minEdge), points on a straight line, and spikes.
 * Returns null if fewer than 3 points survive.
 */
export function cleanPolygon(poly, minEdge = SLAB.MIN_EDGE) {
  let pts = poly.map(p => [p[0], p[1]]);
  if (signedArea(pts) < 0) pts.reverse();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length >= 3; i++) {
      const n = pts.length;
      const a = pts[(i + n - 1) % n], p = pts[i], c = pts[(i + 1) % n];
      const e1x = p[0] - a[0], e1y = p[1] - a[1], e2x = c[0] - p[0], e2y = c[1] - p[1];
      const l1 = Math.hypot(e1x, e1y), l2 = Math.hypot(e2x, e2y);
      const sinTurn = l1 && l2 ? (e1x * e2y - e1y * e2x) / (l1 * l2) : 0;
      // Remove p if it nearly repeats its predecessor, or sits on a straight line / spike.
      if (l1 < minEdge || Math.abs(sinTurn) < 1e-5) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  if (pts.length < 3 || signedArea(pts) <= 0) return null;
  return pts;
}

// ---------------------------------------------------------------- planning one slab

/**
 * Work out everything about one piece's slab except writing it: cleaned outline, which
 * corners are hard, the inset directions, how much bevel fits, and both cap triangulations.
 */
export function planSlab(poly, { bevel, segments = SLAB.BEVEL_SEGMENTS, hardTurnDeg = SLAB.HARD_TURN_DEG,
  miterLimit = SLAB.MITER_LIMIT, minEdge = SLAB.MIN_EDGE } = {}) {
  const pts = cleanPolygon(poly, minEdge);
  if (!pts) return null;
  const n = pts.length;

  // Edge i runs from pts[i] to pts[i+1]: unit direction (dx, dy). For a CCW polygon the
  // interior is on the left, so the inward normal is (−dy, dx) and the outward one (dy, −dx).
  const dx = new Float64Array(n), dy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    dx[i] = (q[0] - p[0]) / len;
    dy[i] = (q[1] - p[1]) / len;
  }

  const hardCos = Math.cos(hardTurnDeg * Math.PI / 180);
  const hard = new Uint8Array(n);
  let hardCount = 0, convex = true;
  const mx = new Float64Array(n), my = new Float64Array(n);   // inward offset per unit of inset
  const sx = new Float64Array(n), sy = new Float64Array(n);   // smooth outward normal (gentle corners)
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;                       // edge before vertex i
    const cosTurn = dx[j] * dx[i] + dy[j] * dy[i];
    const sinTurn = dx[j] * dy[i] - dy[j] * dx[i];   // > 0: left turn = convex corner
    if (sinTurn <= 0) convex = false;
    if (cosTurn < hardCos) { hard[i] = 1; hardCount++; }

    // Mitre: moving the vertex by d·m moves BOTH neighbouring edges inward by exactly d.
    // m = (n_prev + n_next) / (1 + n_prev·n_next), length 1/cos(turn/2).
    const nx = -dy[j] - dy[i], ny = dx[j] + dx[i];
    const denom = Math.max(1 + cosTurn, 1e-6);
    let ox = nx / denom, oy = ny / denom;
    const len = Math.hypot(ox, oy);
    // Sharp convex points: cap the mitre so the inset tip does not run away down the point.
    // The bevel just narrows near the tip there, which is what a real chipped tile does.
    if (sinTurn > 0 && len > miterLimit) { ox *= miterLimit / len; oy *= miterLimit / len; }
    mx[i] = ox; my[i] = oy;

    // Averaged outward normal for smooth corners.
    const ax = dy[j] + dy[i], ay = -dx[j] - dx[i];
    const al = Math.hypot(ax, ay) || 1;
    sx[i] = ax / al; sy[i] = ay / al;
  }

  // How much bevel fits? Try the full bevel, then smaller ones, until the inset outline of
  // the top cap is still a proper polygon inside the piece (thin slivers get a thin bevel).
  let scale = 0, top = null;
  for (const s of [1, 0.75, 0.5, 0.3, 0.15, 0.05]) {
    const d = bevel * s;
    const q = pts.map((p, i) => [p[0] + d * mx[i], p[1] + d * my[i]]);
    if (insetIsValid(pts, q, dx, dy)) { scale = s; top = q; break; }
  }
  if (!top) top = pts.map(p => [p[0], p[1]]);        // no room at all: square edge

  const topTris = triangulate(top, convex && isConvex(top));
  const bottomTris = triangulate(pts, convex);

  const ringSize = n + hardCount;                    // rings with split normals at hard corners
  const vertexCount = 2 * n + (segments + 1) * ringSize;
  const indexCount = 3 * (topTris.length / 3 + bottomTris.length / 3 + 2 * (segments + 1) * n);
  const lodIndexCount = 3 * (topTris.length / 3 + bottomTris.length / 3 + 2 * 2 * n);   // two bands, not segments + 1

  return { pts, top, n, hard, hardCount, mx, my, dx, dy, sx, sy, bevel, scale, convex,
    topTris, bottomTris, vertexCount, indexCount, lodIndexCount };
}

/** The inset outline q is usable if no edge flipped, it is simple, and it lies inside pts. */
function insetIsValid(pts, q, dx, dy) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = q[i], b = q[(i + 1) % n];
    if ((b[0] - a[0]) * dx[i] + (b[1] - a[1]) * dy[i] <= 1e-7) return false;   // edge reversed
  }
  if (signedArea(q) <= 0) return false;
  for (const p of q) if (!pointInPolygon(p, pts)) return false;
  return isSimplePolygon(q);
}

function isConvex(pts) {
  for (let i = 0, n = pts.length; i < n; i++) {
    if (orient(pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]) <= 0) return false;
  }
  return true;
}

/**
 * Triangulate a simple CCW polygon. Convex ones fan from vertex 0 (fast, no allocation per
 * triangle); concave ones go through earcut (THREE.ShapeUtils). Every output triangle is
 * counter-clockwise in the plane. Returns a flat array of vertex indices.
 */
function triangulate(pts, convex) {
  const out = [];
  if (convex) {
    for (let i = 1; i < pts.length - 1; i++) out.push(0, i, i + 1);
    return out;
  }
  const faces = ShapeUtils.triangulateShape(pts.map(p => new Vector2(p[0], p[1])), []);
  for (const [a, b, c] of faces) {
    if (orient(pts[a], pts[b], pts[c]) >= 0) out.push(a, b, c); else out.push(a, c, b);
  }
  return out;
}

// ---------------------------------------------------------------- writing one slab

/**
 * Write a planned slab into the shared buffers at out.v (vertex cursor) / out.i (index cursor).
 * Plane point (x, y) becomes world (x, height, y).
 */
export function writeSlab(plan, out, pieceId, { height, segments = SLAB.BEVEL_SEGMENTS }) {
  const { pts, top, n, hard, mx, my, dy, dx, sx, sy } = plan;
  const b = plan.bevel * plan.scale;                 // the bevel this piece actually gets
  const P = out.position, N = out.normal, ID = out.pieceId, I = out.index;
  const base = out.v;
  let v = out.v, k = out.i;

  const put = (x, y, z, nx, ny, nz) => {
    P[3 * v] = x; P[3 * v + 1] = y; P[3 * v + 2] = z;
    N[3 * v] = nx; N[3 * v + 1] = ny; N[3 * v + 2] = nz;
    ID[v] = pieceId;
    return v++;
  };

  // Ring 0: the top cap's outline, also the top edge of the bevel. Normal straight up, so
  // the cap and the bevel can share these vertices even at hard corners.
  const ring0 = v;
  for (let i = 0; i < n; i++) put(top[i][0], height, top[i][1], 0, 1, 0);

  // Rings 1..segments down the quarter-round, then one more at the foot of the side wall.
  // At hard corners each ring has two vertices: copy A carries the normal of the edge
  // before the corner, copy B the edge after. Smooth corners have one averaged vertex.
  const ringStarts = [];
  const writeRing = (inset, y, sinT, cosT) => {
    const start = v;
    for (let i = 0; i < n; i++) {
      const x = pts[i][0] + inset * mx[i], z = pts[i][1] + inset * my[i];
      if (hard[i]) {
        const j = (i + n - 1) % n;
        put(x, y, z, dy[j] * sinT, cosT, -dx[j] * sinT);   // copy A: outward normal of edge j
        put(x, y, z, dy[i] * sinT, cosT, -dx[i] * sinT);   // copy B: outward normal of edge i
      } else {
        put(x, y, z, sx[i] * sinT, cosT, sy[i] * sinT);
      }
    }
    ringStarts.push(start);
  };
  for (let s = 1; s <= segments; s++) {
    const theta = (s / segments) * Math.PI / 2;          // 0 = facing up, 90° = facing out
    writeRing(b * (1 - Math.sin(theta)), height - b * (1 - Math.cos(theta)), Math.sin(theta), Math.cos(theta));
  }
  writeRing(0, 0, 1, 0);                                  // foot of the side wall

  // Bottom cap ring: the outline at y = 0, facing down.
  const ringBottom = v;
  for (let i = 0; i < n; i++) put(pts[i][0], 0, pts[i][1], 0, -1, 0);

  // Where vertex i sits inside a split ring: off[i] = i + (hard corners before i).
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + 1 + hard[i];
  // For edge i (vertex i → i+1): its own copy at vertex i is B (if split), at vertex i+1 is A.
  const edgeStart = (ring, i) => ring + off[i] + hard[i];
  const edgeEnd = (ring, i) => ring + (i + 1 < n ? off[i + 1] : 0);

  // Index writers for one list: `dst` is the array, the cursor is kept in `c.k`.
  const caps = (dst, c) => {
    // Top cap: CCW in the (x, z) plane faces −y, so flip each triangle to face up.
    const tt = plan.topTris;
    for (let t = 0; t < tt.length; t += 3) {
      dst[c.k++] = ring0 + tt[t]; dst[c.k++] = ring0 + tt[t + 2]; dst[c.k++] = ring0 + tt[t + 1];
    }
    // Bottom cap: CCW in the plane already faces −y.
    const bt = plan.bottomTris;
    for (let t = 0; t < bt.length; t += 3) {
      dst[c.k++] = ringBottom + bt[t]; dst[c.k++] = ringBottom + bt[t + 1]; dst[c.k++] = ringBottom + bt[t + 2];
    }
  };
  // Upper (U) and lower (L) vertices of edge i; the two triangles (L_i, U_i+1, L_i+1) and
  // (L_i, U_i, U_i+1) face out.
  const quad = (dst, c, Ui, Ui1, Li, Li1) => {
    dst[c.k++] = Li; dst[c.k++] = Ui1; dst[c.k++] = Li1;
    dst[c.k++] = Li; dst[c.k++] = Ui; dst[c.k++] = Ui1;
  };

  // Full slab: bands of quads down the profile, ring0 → ring1 → … → foot.
  const full = { k };
  caps(I, full);
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    quad(I, full, ring0 + i, ring0 + i1, edgeStart(ringStarts[0], i), edgeEnd(ringStarts[0], i));
    for (let r = 0; r + 1 < ringStarts.length; r++) {
      quad(I, full, edgeStart(ringStarts[r], i), edgeEnd(ringStarts[r], i),
           edgeStart(ringStarts[r + 1], i), edgeEnd(ringStarts[r + 1], i));
    }
  }
  k = full.k;

  // Far view: the caps, one band from the top cap's edge to the bevel's last ring (facing
  // sideways), and the side wall from there to the foot.
  if (out.lod) {
    const lod = { k: out.li };
    const side = ringStarts[segments - 1], foot = ringStarts[segments];
    caps(out.lod, lod);
    for (let i = 0; i < n; i++) {
      quad(out.lod, lod, ring0 + i, ring0 + (i + 1) % n, edgeStart(side, i), edgeEnd(side, i));
      quad(out.lod, lod, edgeStart(side, i), edgeEnd(side, i), edgeStart(foot, i), edgeEnd(foot, i));
    }
    if (lod.k - out.li !== plan.lodIndexCount) throw new Error(`slab LOD size mismatch: ${lod.k - out.li}/${plan.lodIndexCount}`);
    out.li = lod.k;
  }

  if (v - base !== plan.vertexCount || k - out.i !== plan.indexCount) {
    throw new Error(`slab size mismatch: ${v - base}/${plan.vertexCount} vertices, ${k - out.i}/${plan.indexCount} indices`);
  }
  out.v = v;
  out.i = k;
}

// ---------------------------------------------------------------- many slabs at once

/**
 * Build slabs for many pieces into one set of buffers.
 *
 * @param {Array<{poly:number[][], id:number, pivot?:number[], bevel?:number}>} items  id → `pieceId`
 *   attribute; `bevel` overrides opts.bevel for that piece
 * @param {{height:number, bevel:number, segments?:number}} opts
 * @returns {{ position: Float32Array, normal: Float32Array, pieceId: Float32Array, index: Uint32Array,
 *   lodIndex: Uint32Array, vertices:number, triangles:number, lodTriangles:number, pieces:number,
 *   skipped:number[], reducedBevel:number, maxReach:number }}
 *   lodIndex: the far-view triangles (no bevel rings) over the same vertices.
 *   maxReach: largest distance from a piece's pivot (x, 0, y) to any of its vertices, for bounds.
 */
export function buildSlabs(items, opts) {
  const plans = new Array(items.length);
  let vertices = 0, indices = 0, lodIndices = 0, reducedBevel = 0;
  const skipped = [];
  for (let p = 0; p < items.length; p++) {
    // An item may ask for its own bevel (e.g. the thin black straps get a smaller one)
    const plan = planSlab(items[p].poly, items[p].bevel ? { ...opts, bevel: items[p].bevel } : opts);
    plans[p] = plan;
    if (!plan) { skipped.push(items[p].id); continue; }
    vertices += plan.vertexCount;
    indices += plan.indexCount;
    lodIndices += plan.lodIndexCount;
    if (plan.scale < 1) reducedBevel++;
  }

  const out = {
    position: new Float32Array(vertices * 3),
    normal: new Float32Array(vertices * 3),
    pieceId: new Float32Array(vertices),
    index: new Uint32Array(indices),
    lod: new Uint32Array(lodIndices),   // the far-view index list (see the top of this file)
    v: 0, i: 0, li: 0,
  };
  let maxReach = 0;
  for (let p = 0; p < items.length; p++) {
    const plan = plans[p];
    if (!plan) continue;
    writeSlab(plan, out, items[p].id, opts);
    const [px, py] = items[p].pivot ?? [0, 0];
    for (const q of plan.pts) maxReach = Math.max(maxReach, Math.hypot(q[0] - px, q[1] - py, opts.height));
  }

  return {
    position: out.position, normal: out.normal, pieceId: out.pieceId, index: out.index, lodIndex: out.lod,
    vertices, triangles: indices / 3, lodTriangles: lodIndices / 3,
    pieces: items.length - skipped.length, skipped, reducedBevel, maxReach,
  };
}
