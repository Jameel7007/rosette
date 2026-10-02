// Planar arrangement: turn a soup of centre-line segments into a clean planar graph and its
// faces (the regions the lines enclose).
//
//   1. Find every crossing with a uniform grid (only segments sharing a cell are tested),
//      including T-touches and collinear overlaps, and split segments there.
//   2. Snap points closer than `eps` to one vertex; merge duplicate edges.
//   3. Prune dangling ends (a line that stops without meeting anything encloses nothing).
//   4. Build a half-edge structure: at every vertex, sort outgoing edges by angle; the face
//      on the left of edge u→v continues with the edge just clockwise of v→u at v.
//   5. Walk the face cycles: counter-clockwise cycles (positive area) are bounded faces,
//      clockwise ones are the outer boundary of a connected piece of the drawing.
//
// Pure JavaScript, runs in Node.

import { area, centroid, pointInPolygon, bbox } from './geom.js';

/**
 * @typedef {import('./geom.js').Point} Point
 * @typedef {import('./geom.js').Poly} Poly
 * @typedef {import('./geom.js').Segment} Segment
 *
 * @typedef {object} Face  A bounded face (a region enclosed by centre lines).
 * @property {number} id
 * @property {Poly} poly        outline, counter-clockwise; poly[i] = vertices[verts[i]]
 * @property {number[]} verts   vertex ids in order
 * @property {number[]} halfEdges  halfEdges[i] runs from verts[i] to verts[i + 1]
 * @property {number} area      positive
 * @property {Point} centroid   area centroid
 *
 * @typedef {object} Edge  An undirected edge between two vertices.
 * @property {number} id
 * @property {number} a          vertex id
 * @property {number} b          vertex id
 * @property {number} left       bounded face on the left of a→b, or -1 for the outside
 * @property {number} right      bounded face on the right of a→b, or -1 for the outside
 *
 * @typedef {object} HalfEdge  One direction of an edge. Half-edge 2e runs a→b of edge e and
 *   2e + 1 runs b→a, so twin(h) = h ^ 1 and edge(h) = h >> 1.
 * @property {number} from
 * @property {number} to
 * @property {number} next   the following half-edge around the same face
 * @property {number} prev   the preceding half-edge around the same face
 * @property {number} face   bounded face on its left, or -1
 * @property {number} outer  outer-boundary cycle on its left (index into `outer`), or -1
 *
 * @typedef {object} OuterCycle  The clockwise boundary of one connected piece of the drawing,
 *   seen from outside. Its "left" is the unbounded region.
 * @property {number[]} verts
 * @property {number[]} halfEdges
 * @property {Poly} poly   clockwise
 * @property {number} area negative (or zero)
 *
 * @typedef {object} Warning
 * @property {string} code  machine-readable kind, e.g. 'dangling'
 * @property {string} msg   human-readable explanation
 * @property {Point[]} [at] where (a sample of positions)
 *
 * @typedef {object} Arrangement
 * @property {Point[]} vertices
 * @property {Edge[]} edges
 * @property {Face[]} faces       bounded faces only
 * @property {OuterCycle[]} outer outer boundaries (one per connected component)
 * @property {HalfEdge[]} halfEdges
 * @property {number[][]} out     per vertex: outgoing half-edge ids, counter-clockwise by angle
 * @property {number} eps         the snapping distance used
 * @property {Warning[]} warnings
 */

/**
 * Build the planar arrangement of a set of segments.
 *
 * @param {Segment[]} segments  centre lines; duplicates, overlaps, T-touches and crossings
 *   are all fine
 * @param {object} [opts]
 * @param {number} [opts.eps]  snapping distance: points closer than this become one vertex.
 *   Default 1e-7 × the drawing's extent (scale-aware: tiny next to any real feature, large
 *   next to floating-point noise from constructions).
 * @returns {Arrangement}
 */
export function buildArrangement(segments, opts = {}) {
  const warnings = [];

  // ---- 0. Clean input ----------------------------------------------------------------
  const segs = []; // [x1, y1, x2, y2]
  let bad = 0;
  for (const s of segments) {
    const x1 = +s[0][0], y1 = +s[0][1], x2 = +s[1][0], y2 = +s[1][1];
    if (![x1, y1, x2, y2].every(Number.isFinite)) { bad++; continue; }
    if (x1 === x2 && y1 === y2) continue;
    segs.push([x1, y1, x2, y2]);
  }
  if (bad) warnings.push({ code: 'non-finite', msg: `ignored ${bad} segments with non-finite coordinates` });
  const empty = { vertices: [], edges: [], faces: [], outer: [], halfEdges: [], out: [], eps: opts.eps ?? 0, warnings };
  if (!segs.length) return empty;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, totalLen = 0;
  for (const [x1, y1, x2, y2] of segs) {
    minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
    minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
    totalLen += Math.hypot(x2 - x1, y2 - y1);
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1e-12);
  // The snapping grid packs two cell indices into one number, so eps can't be absurdly small.
  const eps = Math.max(opts.eps ?? 1e-7 * Math.max(1, extent), extent / 6e7);
  // Crossings within eps/2 of a segment end count as touching that end, so two such points
  // are at most eps apart and the snapping below merges them.
  const touch = eps / 2;

  // ---- 1. Split points: every segment collects the points where it must be cut ----------
  const n = segs.length;
  const splits = segs.map(([x1, y1, x2, y2]) => [[x1, y1], [x2, y2]]);

  // Uniform grid: cell size about one average segment, capped at ~1M cells.
  const h = Math.max(totalLen / n, extent / 1000);
  const cols = Math.floor((maxX - minX) / h) + 1;
  const grid = new Map();
  const cellsOf = new Array(n);
  for (let i = 0; i < n; i++) cellsOf[i] = rasterize(segs[i], minX, minY, h, eps, cols, grid, i);

  const lastTested = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (const key of cellsOf[i]) {
      for (const j of grid.get(key)) {
        if (j <= i || lastTested[j] === i) continue;
        lastTested[j] = i;
        intersectPair(segs[i], segs[j], splits[i], splits[j], touch, eps);
      }
    }
  }

  // ---- 2. Snap points to vertices, cut segments into edges, merge duplicates -----------
  const vertices = [];
  const snapCells = new Map();
  const cs = eps; // snapping cell size: a 3×3 block of cells covers radius eps
  const vertexAt = (p) => {
    const cx = Math.floor((p[0] - minX) / cs) + 1, cy = Math.floor((p[1] - minY) / cs) + 1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = snapCells.get((cx + dx) * 134217728 + (cy + dy));
        if (!list) continue;
        for (const v of list) {
          const q = vertices[v];
          if (Math.abs(q[0] - p[0]) <= eps && Math.abs(q[1] - p[1]) <= eps && Math.hypot(q[0] - p[0], q[1] - p[1]) <= eps) return v;
        }
      }
    }
    const id = vertices.length;
    vertices.push([p[0], p[1]]);
    const key = cx * 134217728 + cy;
    const list = snapCells.get(key);
    if (list) list.push(id); else snapCells.set(key, [id]);
    return id;
  };

  const edgeKey = new Map();
  let ea = [], eb = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1, x2, y2] = segs[i];
    const dx = x2 - x1, dy = y2 - y1;
    // Order the cut points along the segment, then join consecutive distinct vertices.
    const ordered = splits[i]
      .map(p => ({ p, t: (p[0] - x1) * dx + (p[1] - y1) * dy }))
      .sort((a, b) => a.t - b.t);
    let prevV = -1;
    for (const { p } of ordered) {
      const v = vertexAt(p);
      if (prevV >= 0 && v !== prevV) {
        const lo = Math.min(v, prevV), hi = Math.max(v, prevV);
        const key = lo * 67108864 + hi;
        if (!edgeKey.has(key)) { edgeKey.set(key, ea.length); ea.push(prevV); eb.push(v); }
      }
      prevV = v;
    }
  }

  // ---- 3. Prune dangling edges (repeatedly remove vertices of degree 1) -----------------
  const V0 = vertices.length;
  const deg = new Int32Array(V0);
  const inc = Array.from({ length: V0 }, () => []);
  for (let e = 0; e < ea.length; e++) { deg[ea[e]]++; deg[eb[e]]++; inc[ea[e]].push(e); inc[eb[e]].push(e); }
  const dead = new Uint8Array(ea.length);
  const stack = [];
  for (let v = 0; v < V0; v++) if (deg[v] === 1) stack.push(v);
  let pruned = 0;
  const danglingAt = [];
  while (stack.length) {
    const v = stack.pop();
    if (deg[v] !== 1) continue;
    for (const e of inc[v]) {
      if (dead[e]) continue;
      dead[e] = 1; pruned++;
      deg[ea[e]]--; deg[eb[e]]--;
      const w = ea[e] === v ? eb[e] : ea[e];
      if (danglingAt.length < 20) danglingAt.push(vertices[v]);
      if (deg[w] === 1) stack.push(w);
      break;
    }
  }
  if (pruned) warnings.push({ code: 'dangling', msg: `pruned ${pruned} dangling edge(s): lines that end without enclosing anything`, at: danglingAt });

  // Re-index: keep vertices that still have edges, and live edges.
  const remap = new Int32Array(V0).fill(-1);
  const verts = [];
  for (let v = 0; v < V0; v++) if (deg[v] > 0) { remap[v] = verts.length; verts.push(vertices[v]); }
  const A = [], B = [];
  for (let e = 0; e < ea.length; e++) if (!dead[e]) { A.push(remap[ea[e]]); B.push(remap[eb[e]]); }
  ea = A; eb = B;
  const V = verts.length, E = ea.length;
  if (!E) return { ...empty, eps };

  // ---- 4. Half-edges, sorted around each vertex ----------------------------------------
  const from = new Int32Array(2 * E), to = new Int32Array(2 * E);
  const out = Array.from({ length: V }, () => []);
  for (let e = 0; e < E; e++) {
    from[2 * e] = ea[e]; to[2 * e] = eb[e];
    from[2 * e + 1] = eb[e]; to[2 * e + 1] = ea[e];
    out[ea[e]].push(2 * e); out[eb[e]].push(2 * e + 1);
  }
  const angleOf = new Float64Array(2 * E);
  for (let he = 0; he < 2 * E; he++) {
    const p = verts[from[he]], q = verts[to[he]];
    angleOf[he] = Math.atan2(q[1] - p[1], q[0] - p[0]);
  }
  const pos = new Int32Array(2 * E);
  for (let v = 0; v < V; v++) {
    out[v].sort((x, y) => angleOf[x] - angleOf[y]);
    out[v].forEach((he, k) => { pos[he] = k; });
  }
  // The face on the left of u→v continues at v along the edge just clockwise of v→u.
  const next = new Int32Array(2 * E), prev = new Int32Array(2 * E);
  for (let he = 0; he < 2 * E; he++) {
    const o = out[to[he]], tw = he ^ 1;
    const nx = o[(pos[tw] - 1 + o.length) % o.length];
    next[he] = nx; prev[nx] = he;
  }

  // ---- 5. Walk the face cycles ---------------------------------------------------------
  const faceOf = new Int32Array(2 * E).fill(-1), outerOf = new Int32Array(2 * E).fill(-1);
  const seen = new Uint8Array(2 * E);
  const faces = [], outer = [];
  for (let start = 0; start < 2 * E; start++) {
    if (seen[start]) continue;
    const hes = [], vs = [];
    let he = start;
    do { seen[he] = 1; hes.push(he); vs.push(from[he]); he = next[he]; } while (he !== start && hes.length <= 2 * E);
    const poly = vs.map(v => verts[v]);
    const a = area(poly);
    if (a > 0) {
      const id = faces.length;
      faces.push({ id, poly, verts: vs, halfEdges: hes, area: a, centroid: centroid(poly) });
      for (const x of hes) faceOf[x] = id;
    } else {
      const id = outer.length;
      outer.push({ verts: vs, halfEdges: hes, poly, area: a });
      for (const x of hes) outerOf[x] = id;
    }
  }

  const halfEdges = [];
  for (let he = 0; he < 2 * E; he++) {
    halfEdges.push({ from: from[he], to: to[he], next: next[he], prev: prev[he], face: faceOf[he], outer: outerOf[he] });
  }
  const edges = [];
  for (let e = 0; e < E; e++) edges.push({ id: e, a: ea[e], b: eb[e], left: faceOf[2 * e], right: faceOf[2 * e + 1] });

  if (outer.length > 1) checkNesting(outer, faces, warnings);

  return { vertices: verts, edges, faces, outer, halfEdges, out, eps, warnings };
}

/**
 * Register segment i in every grid cell it passes through (a conservative rasterisation:
 * column by column, the y-range the segment covers there, padded by eps).
 * @returns {number[]} the cell keys
 */
function rasterize([x1, y1, x2, y2], minX, minY, h, eps, cols, grid, i) {
  const keys = [];
  const c0 = Math.floor((Math.min(x1, x2) - eps - minX) / h), c1 = Math.floor((Math.max(x1, x2) + eps - minX) / h);
  for (let c = c0; c <= c1; c++) {
    // The part of the segment inside this column.
    let ya, yb;
    if (x1 === x2) { ya = Math.min(y1, y2); yb = Math.max(y1, y2); }
    else {
      const xa = Math.max(Math.min(x1, x2), minX + c * h), xb = Math.min(Math.max(x1, x2), minX + (c + 1) * h);
      const ta = (xa - x1) / (x2 - x1), tb = (xb - x1) / (x2 - x1);
      const p = y1 + (y2 - y1) * Math.min(Math.max(ta, 0), 1), q = y1 + (y2 - y1) * Math.min(Math.max(tb, 0), 1);
      ya = Math.min(p, q); yb = Math.max(p, q);
    }
    const r0 = Math.floor((ya - eps - minY) / h), r1 = Math.floor((yb + eps - minY) / h);
    for (let r = r0; r <= r1; r++) {
      const key = (c + 1) * 1048576 + (r + 1); // (+1: the eps padding can reach cell −1)
      const list = grid.get(key);
      if (list) list.push(i); else grid.set(key, [i]);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Test two segments and record where each must be split: a proper crossing, a T-touch
 * (one segment's end on the other) or, for collinear overlapping segments, each one's
 * endpoints that fall inside the other.
 */
function intersectPair(s, q, splitsS, splitsQ, touch, eps) {
  const [ax, ay, bx, by] = s, [cx, cy, dx, dy] = q;
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const rl = Math.hypot(rx, ry), sl = Math.hypot(sx, sy);
  const den = rx * sy - ry * sx;
  const wx = cx - ax, wy = cy - ay;
  if (Math.abs(den) > 1e-10 * rl * sl) {
    const t = (wx * sy - wy * sx) / den, u = (wx * ry - wy * rx) / den;
    const tt = touch / rl, tu = touch / sl;
    if (t < -tt || t > 1 + tt || u < -tu || u > 1 + tu) return;
    // Near an end, use the end itself so no near-duplicate point is created.
    let p;
    if (t <= tt) p = [ax, ay];
    else if (t >= 1 - tt) p = [bx, by];
    else if (u <= tu) p = [cx, cy];
    else if (u >= 1 - tu) p = [dx, dy];
    else p = [ax + rx * t, ay + ry * t];
    splitsS.push(p); splitsQ.push(p);
    return;
  }
  // Parallel. Only collinear segments (q within eps of s's line) can share points.
  if (Math.abs(wx * ry - wy * rx) / rl > eps) return;
  const tt = touch / rl, tu = touch / sl;
  for (const [px, py] of [[cx, cy], [dx, dy]]) {
    const t = ((px - ax) * rx + (py - ay) * ry) / (rl * rl);
    if (t > tt && t < 1 - tt) splitsS.push([px, py]);
  }
  for (const [px, py] of [[ax, ay], [bx, by]]) {
    const u = ((px - cx) * sx + (py - cy) * sy) / (sl * sl);
    if (u > tu && u < 1 - tu) splitsQ.push([px, py]);
  }
}

/**
 * A connected piece of the drawing lying inside a face of another piece makes that face a
 * ring (a face with a hole), which the faces here cannot represent. Detect and report it.
 */
function checkNesting(outer, faces, warnings) {
  const boxes = faces.map(f => bbox(f.poly));
  const hits = [];
  for (const cyc of outer) {
    const p = cyc.poly[0];
    const own = new Set(cyc.verts);
    for (let f = 0; f < faces.length; f++) {
      const b = boxes[f];
      if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
      if (faces[f].verts.some(v => own.has(v))) continue;
      if (pointInPolygon(p, faces[f].poly)) { hits.push({ face: f, at: p }); break; }
    }
  }
  if (hits.length) {
    warnings.push({
      code: 'nested',
      msg: `${hits.length} separate piece(s) of the drawing sit inside face(s) ${hits.map(h => h.face).join(', ')}; those faces are treated as if they had no hole`,
      at: hits.map(h => h.at),
    });
  }
}
