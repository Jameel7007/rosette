// Strapwork: turn an arrangement of centre lines into straps (the bands that run along the
// lines) and fills (the regions between them), as one exact partition of the plane.
//
// The whole construction rests on one set of shared points, the FACE CORNERS. Shrink every
// face by half the strap width, keeping each edge parallel to its centre line; the corner
// of face F at vertex v is where the shrunk versions of F's two edges at v meet (a mitre).
// Every piece is then built only from these corners:
//
//   fill of face F            = F's corners in order (the shrunk face)
//   band along edge u–v       = the quad of the four corners of the faces either side of it
//   junction at a vertex v    = the corners of all faces around v, in angular order
//     (degree ≥ 3)
//
// Neighbouring pieces therefore share their sides exactly (same points, opposite
// directions). If every piece is a simple counter-clockwise polygon, the pieces cover the
// region exactly once: no gaps, no overlaps. The outer boundary works the same way, with the
// unbounded face's corners offset outward by half a strap width.
//
// Pieces are then merged into runs: bands continue through gentle bends (a circle drawn as
// many short segments) and, at an interlaced crossing, the strand that passes OVER takes the
// junction with it, while the strand passing UNDER stops at the junction's edge (the grout
// line there is what shows over/under in real zellige). Long runs are cut across into
// pieces of about `targetLen`.
//
// Pure JavaScript, runs in Node.

import { area, isSimple, dedupe, removeCollinear, mitreOffset, interiorPoint, dot, sub, normalize, dist } from './geom.js';

/**
 * @typedef {import('./geom.js').Point} Point
 * @typedef {import('./geom.js').Poly} Poly
 * @typedef {import('./graph.js').Arrangement} Arrangement
 * @typedef {import('./graph.js').Warning} Warning
 *
 * @typedef {object} Fill  The shrunk face: the coloured piece between the straps.
 * @property {Poly} poly     counter-clockwise
 * @property {number} faceId the arrangement face it came from (arr.faces[faceId])
 *
 * @typedef {object} Strap  One strap piece: part of a run of bands (and junctions).
 * @property {Poly} poly        counter-clockwise
 * @property {number[]} edgeIds arrangement edges whose bands (or parts of them) it contains
 * @property {number[]} vertexIds junction vertices it contains (empty for plain bands)
 * @property {boolean} over     true if it carries an interlaced crossing (it passes over)
 * @property {number} len       centre-line length it covers
 *
 * @typedef {object} Crossing  An interlaced 4-way crossing.
 * @property {number} vertex
 * @property {[number, number]} over   edge ids of the strand that passes over
 * @property {[number, number]} under  edge ids of the strand that passes under
 */

/**
 * Build strapwork from an arrangement.
 *
 * @param {Arrangement} arr  from buildArrangement
 * @param {object} opts
 * @param {number} opts.width            strap width (each side of a centre line gets width/2)
 * @param {boolean} [opts.interlace=true] over/under at 4-way crossings, alternating along
 *   every strand
 * @param {number} [opts.runTurnDeg=30]  bands continue as one run through a degree-2 vertex
 *   whose turn is below this (a polygonised circle); sharper corners end the run with a
 *   mitred joint
 * @param {number} [opts.crossTurnDeg=20] how far from straight a strand may bend through a
 *   crossing (or tee) and still count as one strand
 * @param {boolean} [opts.mergeTees=true] at a T (degree 3 with one straight pair) the
 *   straight strand runs through and the stem stops against it, instead of a separate
 *   junction piece
 * @param {number} [opts.targetLen=Infinity] cut runs into pieces of about this length
 * @param {number} [opts.maxRunLen=1.5·targetLen] only runs longer than this are cut
 * @param {number} [opts.junctionMargin=width] never cut a run closer than this to a junction
 *   it carries, so the over-strand visibly continues past the crossing
 * @returns {{ fills: Fill[], straps: Strap[], outline: Poly[], crossings: Crossing[],
 *   corners: Point[], warnings: Warning[] }}
 *   `outline`: the outer boundary of all pieces, one counter-clockwise ring per connected
 *   piece of the drawing (sum of piece areas = sum of outline areas). `corners`: the shared
 *   corner points (for debugging drawings).
 */
export function strapwork(arr, opts = {}) {
  const width = opts.width;
  if (!(width > 0)) throw new Error('strapwork: opts.width must be a positive number');
  const {
    interlace = true,
    runTurnDeg = 30,
    crossTurnDeg = 20,
    mergeTees = true,
    targetLen = Infinity,
    junctionMargin = width,
  } = opts;
  const maxRunLen = opts.maxRunLen ?? 1.5 * targetLen;
  const d = width / 2;
  const { vertices: V, halfEdges: H, out, faces, outer, edges } = arr;
  const warnings = [];
  const pts = [];                                     // every corner / cut point, by id
  const cornerOf = new Int32Array(H.length).fill(-1); // corner at the head of a half-edge, in its left face

  // ---- 1. Face corners ---------------------------------------------------------------
  const fills = [];
  const absorbed = [], badFills = [];
  for (const f of faces) {
    const res = mitreOffset(f.poly, d);
    const n = f.halfEdges.length;
    if (!res) {
      // Too small to hold the strap: the straps take its whole area. All its corners meet at
      // one inner point, so the bands around it become triangles and nothing is left over.
      const id = pts.push(fallbackPoint(f.poly)) - 1;
      for (const he of f.halfEdges) cornerOf[he] = id;
      absorbed.push(f.id);
      continue;
    }
    const base = pts.length;
    for (const p of res.pts) pts.push(p);
    // Half-edge i ends at vertex i + 1, whose corner is res.idx[i + 1].
    for (let i = 0; i < n; i++) cornerOf[f.halfEdges[i]] = base + res.idx[(i + 1) % n];
    const poly = idsToPoly(f.halfEdges.map(he => cornerOf[he]), pts);
    if (poly.length >= 3 && area(poly) > 0 && isSimple(poly)) fills.push({ poly: removeCollinear(poly), faceId: f.id });
    else badFills.push(f.id);
  }
  if (absorbed.length) warnings.push({ code: 'absorbed', msg: `${absorbed.length} face(s) too small for the strap width; their area went to the straps: ${absorbed.slice(0, 20).join(', ')}`, at: absorbed.slice(0, 20).map(i => faces[i].centroid) });
  if (badFills.length) warnings.push({ code: 'fill-invalid', msg: `${badFills.length} shrunk face(s) are not simple (the strap is too wide for their shape): ${badFills.slice(0, 20).join(', ')}`, at: badFills.slice(0, 20).map(i => faces[i].centroid) });

  // The unbounded face: offset outward (its cycles run clockwise, so "left" is outside).
  const outline = [];
  for (const cyc of outer) {
    const n = cyc.halfEdges.length;
    let res = mitreOffset(cyc.poly, d);
    if (!res) {
      warnings.push({ code: 'outline', msg: 'outer boundary offset collapsed; using plain mitres there (clip well inside it)', at: [cyc.poly[0]] });
      res = plainMitres(cyc.poly, d);
    }
    const base = pts.length;
    for (const p of res.pts) pts.push(p);
    for (let i = 0; i < n; i++) cornerOf[cyc.halfEdges[i]] = base + res.idx[(i + 1) % n];
    outline.push(idsToPoly(cyc.halfEdges.map(he => cornerOf[he]), pts).reverse());
  }

  // ---- 2. Vertex roles: crossings, tees, smooth bends ----------------------------------
  const dirOf = he => normalize(sub(V[H[he].to], V[H[he].from]));
  // How far two edges leaving one vertex are from running straight through it, in degrees.
  const bendDeg = (h1, h2) => (Math.acos(Math.max(-1, Math.min(1, -dot(dirOf(h1), dirOf(h2))))) * 180) / Math.PI;

  const isCrossing = new Uint8Array(V.length);
  const teePair = new Map(); // vertex → [he, he] of the straight pair
  for (let v = 0; v < V.length; v++) {
    const o = out[v];
    if (o.length === 4 && bendDeg(o[0], o[2]) < crossTurnDeg && bendDeg(o[1], o[3]) < crossTurnDeg) isCrossing[v] = 1;
    if (o.length === 3 && mergeTees) {
      let best = null, bestBend = crossTurnDeg;
      for (let i = 0; i < 3; i++) {
        const b = bendDeg(o[i], o[(i + 1) % 3]);
        if (b < bestBend) { bestBend = b; best = [o[i], o[(i + 1) % 3]]; }
      }
      if (best) teePair.set(v, best);
    }
  }

  // ---- 3. Over/under -----------------------------------------------------------------
  const overPair = interlace ? chooseOverUnder(arr, isCrossing, warnings) : new Map();
  const crossings = [];
  for (const [v, x] of overPair) {
    const o = out[v];
    crossings.push({ vertex: v, over: [o[x] >> 1, o[x + 2] >> 1], under: [o[x ^ 1] >> 1, o[(x ^ 1) + 2] >> 1] });
  }

  // ---- 4. Cells: bands and junctions, linked into runs ----------------------------------
  // A band cell has one link slot per end; a merged junction links its two through-bands.
  const cells = [];
  const bandCell = new Int32Array(edges.length);
  for (const e of edges) {
    const h = 2 * e.id, t = h + 1;
    bandCell[e.id] = cells.length;
    cells.push({
      ids: [cornerOf[t], cornerOf[H[t].prev], cornerOf[h], cornerOf[H[h].prev]],
      edge: e.id, vertex: -1, over: false,
      ends: [e.a, e.b], link: [-1, -1],
    });
  }
  const junctionCell = new Map();
  for (let v = 0; v < V.length; v++) {
    const o = out[v];
    if (o.length < 3) continue;
    // Sector i lies between o[i] and o[i+1]; its corner is the head corner of twin(o[i+1]).
    const ids = o.map((_, i) => cornerOf[o[(i + 1) % o.length] ^ 1]);
    junctionCell.set(v, cells.length);
    cells.push({ ids, edge: -1, vertex: v, over: overPair.has(v), through: [] });
  }
  const linkBand = (bandIdx, atVertex, other) => {
    const c = cells[bandIdx];
    c.link[c.ends[0] === atVertex ? 0 : 1] = other;
  };
  for (let v = 0; v < V.length; v++) {
    const o = out[v];
    if (o.length === 2 && bendDeg(o[0], o[1]) < runTurnDeg) {
      const b0 = bandCell[o[0] >> 1], b1 = bandCell[o[1] >> 1];
      linkBand(b0, v, b1); linkBand(b1, v, b0);
    }
    const pair = overPair.has(v) ? [o[overPair.get(v)], o[overPair.get(v) + 2]] : teePair.get(v);
    if (pair) {
      const j = junctionCell.get(v);
      for (const he of pair) { const b = bandCell[he >> 1]; linkBand(b, v, j); cells[j].through.push(b); }
    }
  }

  // ---- 5. Walk runs, cut them, merge each piece's cells -------------------------------
  const straps = [];
  const visited = new Uint8Array(cells.length);
  const runOpts = { V, edges, pts, d, width, targetLen, maxRunLen, junctionMargin };
  let unmerged = 0;
  // A band between two absorbed faces has both long sides collapsed to points: it covers
  // nothing, so it is not emitted on its own.
  const push = (poly, units) => {
    if (poly.length >= 3 && Math.abs(area(poly)) > 1e-14 * width * width) straps.push(makeStrap(poly, units, cells));
  };
  const emit = (entries, isCycle) => {
    for (const piece of cutRun(entries, isCycle, cells, runOpts)) {
      const loops = mergeCells(piece.units.map(u => u.ids), pts);
      if (loops) for (const loop of loops) push(idsToPoly(loop, pts), piece.units);
      else { unmerged++; for (const u of piece.units) push(idsToPoly(u.ids, pts), [u]); }
    }
  };
  const links = c => (cells[c].edge >= 0 ? cells[c].link : cells[c].through).filter(x => x >= 0);
  // Chains first: they start at a cell with a free end.
  for (let c = 0; c < cells.length; c++) {
    if (visited[c] || links(c).length >= 2) continue;
    emit(walkRun(c, cells, visited), false);
  }
  // Whatever is left is closed loops.
  for (let c = 0; c < cells.length; c++) {
    if (visited[c]) continue;
    emit(walkRun(c, cells, visited), true);
  }
  if (unmerged) warnings.push({ code: 'unmerged', msg: `${unmerged} run piece(s) could not be merged into one outline; left as separate cells` });

  const badStraps = straps.filter(s => !(s.poly.length >= 3 && area(s.poly) > 0 && isSimple(s.poly)));
  if (badStraps.length) warnings.push({ code: 'strap-invalid', msg: `${badStraps.length} strap piece(s) are not simple polygons`, at: badStraps.slice(0, 20).map(s => s.poly[0]) });

  return { fills, straps, outline, crossings, corners: pts, warnings };
}

// ---------------------------------------------------------------------------------------
// Over/under
// ---------------------------------------------------------------------------------------

/**
 * Decide which strand passes over at each crossing so that every strand alternates.
 *
 * Each crossing is one yes/no choice: which of its two strands (pair 0 = out[0], out[2];
 * pair 1 = out[1], out[3]) goes over. Walking along a strand from one crossing to the next
 * (through any degree-2 bends) gives a constraint "the strand is over at one, under at the
 * other", i.e. an XOR between the two choices. A breadth-first search assigns choices and
 * checks every constraint. This is the same as checkerboard-colouring the faces (possible
 * whenever every vertex has even degree; then nothing ever conflicts). Where a contradiction
 * shows up (an odd loop, e.g. around an odd-degree junction), that one crossing falls back to
 * a separate junction piece, which cuts both strands, so no strand ever fails to alternate.
 *
 * @returns {Map<number, 0|1>} crossing vertex → which pair goes over
 */
function chooseOverUnder(arr, isCrossing, warnings) {
  const { vertices: V, halfEdges: H, out } = arr;
  // Follow a strand from half-edge he through degree-2 vertices; return the half-edge that
  // arrives at the next vertex of another degree.
  const memo = new Map();
  const walk = he => {
    if (memo.has(he)) return memo.get(he);
    let cur = he;
    for (let guard = 0; out[H[cur].to].length === 2 && guard < H.length; guard++) {
      const o = out[H[cur].to];
      cur = o[0] === (cur ^ 1) ? o[1] : o[0];
    }
    memo.set(he, cur);
    return cur;
  };
  const pos = new Map();
  for (let v = 0; v < V.length; v++) if (isCrossing[v]) out[v].forEach((he, k) => pos.set(he, k));

  // Visit crossings from the middle of the drawing outward, so the result is deterministic.
  let cx = 0, cy = 0;
  for (const p of V) { cx += p[0]; cy += p[1]; }
  cx /= V.length; cy /= V.length;
  const order = [];
  for (let v = 0; v < V.length; v++) if (isCrossing[v]) order.push(v);
  order.sort((a, b) => Math.hypot(V[a][0] - cx, V[a][1] - cy) - Math.hypot(V[b][0] - cx, V[b][1] - cy) || a - b);

  const choice = new Int8Array(V.length).fill(-1);
  const excluded = new Uint8Array(V.length);
  let conflicts = 0;
  for (const root of order) {
    if (choice[root] >= 0) continue;
    choice[root] = 0;
    const queue = [root];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      if (excluded[u]) continue;
      for (let k = 0; k < 4; k++) {
        const arrive = walk(out[u][k]);
        const w = H[arrive].to;
        if (!isCrossing[w] || excluded[w]) continue;
        const kw = pos.get(arrive ^ 1);
        // Over at u iff choice[u] == k%2; the same strand must be under at w.
        const want = choice[u] ^ (k & 1) ^ (kw & 1) ^ 1;
        if (choice[w] < 0) { choice[w] = want; queue.push(w); }
        else if (choice[w] !== want) { excluded[w] = 1; conflicts++; if (w === u) break; }
      }
    }
  }
  if (conflicts) warnings.push({ code: 'interlace-fallback', msg: `${conflicts} crossing(s) cannot alternate (odd loop); they get a separate junction piece instead`, at: order.filter(v => excluded[v]).slice(0, 20).map(v => V[v]) });
  const result = new Map();
  for (const v of order) if (!excluded[v]) result.set(v, choice[v]);
  return result;
}

// ---------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------

/**
 * Walk one run of linked cells starting at `start`, marking them visited.
 * @returns {{cell: number, enter: number}[]} cells in order; for bands, `enter` is the
 *   vertex the run enters it by (so it is traversed from `enter` to its other end)
 */
function walkRun(start, cells, visited) {
  const entries = [];
  let cur = start, enter;
  const c0 = cells[start];
  if (c0.edge >= 0) {
    // Enter by a free end if there is one (then the run continues through the other end).
    enter = c0.link[0] < 0 ? c0.ends[0] : c0.link[1] < 0 ? c0.ends[1] : c0.ends[0];
  } else {
    enter = c0.vertex;
  }
  let cameFrom = -1;
  for (let guard = 0; guard <= cells.length; guard++) {
    visited[cur] = 1;
    entries.push({ cell: cur, enter });
    const c = cells[cur];
    let nxt, at;
    if (c.edge >= 0) {
      const exitSide = c.ends[0] === enter ? 1 : 0;
      at = c.ends[exitSide];
      nxt = c.link[exitSide];
    } else {
      at = c.vertex;
      nxt = c.through.find(b => b !== cameFrom) ?? -1;
      if (cameFrom < 0) nxt = c.through[0] ?? -1;
    }
    if (nxt < 0 || nxt === start || visited[nxt]) break;
    cameFrom = cur;
    cur = nxt;
    enter = at;
  }
  return entries;
}

/**
 * Decide where to cut a run and split it into pieces.
 * Cuts go at degree-2 vertices between bands, or straight across a band (perpendicular to its
 * centre line) where the cut fits between the band's mitred ends, and never into or right
 * next to a junction the run carries. A closed loop is always cut at least twice (one piece
 * cannot be a ring).
 * @returns {{units: {ids: number[], cell: number, len: number}[]}[]}
 */
function cutRun(entries, isCycle, cells, o) {
  const { V, edges, pts, d, width, targetLen, maxRunLen, junctionMargin } = o;

  // Arc-length layout of the run, and where cuts are allowed.
  const layout = [];
  let s = 0;
  for (let i = 0; i < entries.length; i++) {
    const { cell, enter } = entries[i];
    const c = cells[cell];
    if (c.edge < 0) { layout.push({ s0: s, s1: s, band: false }); continue; }
    const e = edges[c.edge];
    const a = V[e.a], b = V[e.b];
    const L = dist(a, b);
    const t = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const pr = id => dot(sub(pts[id], a), t); // position along a→b
    const [Ra, Rb, Lb, La] = c.ids;
    // A perpendicular cut must land on both long sides, which run between the corners.
    let lo = Math.max(pr(Ra), pr(La)), hi = Math.min(pr(Rb), pr(Lb));
    // Keep clear of the mitred ends, and well clear of a carried junction.
    const nearJunction = side => { const l = c.link[side]; return l >= 0 && cells[l].edge < 0; };
    lo += nearJunction(0) ? junctionMargin : 0.5 * width;
    hi -= nearJunction(1) ? junctionMargin : 0.5 * width;
    const forward = enter === e.a;
    const x0 = forward ? lo : L - hi, x1 = forward ? hi : L - lo; // in run direction
    // Where the band is actually visible: from the middle of its start cut to the middle of
    // its end cut (a junction or a mitre covers the rest of the centre line).
    const va = (pr(Ra) + pr(La)) / 2, vb = (pr(Rb) + pr(Lb)) / 2;
    const v0 = forward ? va : L - vb, v1 = forward ? vb : L - va;
    layout.push({ s0: s, s1: s + L, band: true, L, forward, x0, x1, v0: s + v0, v1: s + v1 });
    s += L;
  }
  const S = s;
  // Spread cuts over the visible length, so no stub is left beside an end junction.
  const first = layout[0], last = layout[layout.length - 1];
  const sStart = isCycle || !first.band ? 0 : first.v0;
  const sEnd = isCycle || !last.band ? S : last.v1;
  const visible = sEnd - sStart;

  // Allowed cut positions: boundaries between two bands (a degree-2 vertex) and intervals
  // inside bands.
  const bounds = [];
  for (let i = 0; i + 1 < layout.length; i++) if (layout[i].band && layout[i + 1].band) bounds.push({ pos: layout[i].s1, after: i });
  if (isCycle && layout.length > 1 && layout[0].band && layout[layout.length - 1].band) bounds.push({ pos: S, after: layout.length - 1 });

  const finite = Number.isFinite(targetLen) && targetLen > 0;
  let count;
  if (isCycle) count = Math.max(2, finite ? Math.round(S / targetLen) : 2);
  else count = finite && visible > maxRunLen ? Math.max(2, Math.round(visible / targetLen)) : 1;

  const cuts = []; // {pos, after} boundary cut, or {pos, entry, x} interior cut
  if (count > 1 && visible > 0) {
    const step = visible / count;
    const snap = 0.25 * step;
    const gap = (p, q) => { const g = Math.abs(p - q); return isCycle ? Math.min(g, S - g) : g; };
    for (let k = isCycle ? 0 : 1; k < count; k++) {
      const want = sStart + k * step;
      let best = null, bestScore = Infinity;
      for (const b of bounds) {
        const score = gap(b.pos, want) - snap; // prefer a vertex when one is close
        if (score < bestScore) { bestScore = score; best = { pos: b.pos, after: b.after }; }
      }
      layout.forEach((l, i) => {
        if (!l.band || !(l.x1 - l.x0 > 1e-9)) return;
        for (const w of isCycle ? [want, want - S, want + S] : [want]) {
          const x = Math.min(Math.max(w - l.s0, l.x0), l.x1);
          const score = gap(l.s0 + x, want);
          if (score < bestScore) { bestScore = score; best = { pos: l.s0 + x, entry: i, x }; }
        }
      });
      if (best) cuts.push(best);
    }
    // Drop cuts that would leave a stub.
    cuts.sort((p, q) => p.pos - q.pos);
    const minGap = 0.3 * step;
    const kept = [];
    for (const c of cuts) {
      const prevPos = kept.length ? kept[kept.length - 1].pos : (isCycle ? -Infinity : sStart);
      if (c.pos - prevPos < minGap) continue;
      if (!isCycle && sEnd - c.pos < minGap) continue;
      kept.push(c);
    }
    if (isCycle && kept.length > 1 && S - kept[kept.length - 1].pos + kept[0].pos < minGap) kept.pop();
    cuts.length = 0;
    cuts.push(...kept);
  }
  if (isCycle && cuts.length < 2) {
    // A ring can't be one piece and no cut fits: emit its cells separately.
    return entries.map(({ cell }, i) => ({ units: [{ ids: cells[cell].ids, cell, len: layout[i].band ? layout[i].L : 0 }] }));
  }

  // Build units (whole cells, or slices of cut bands) with a cut flag after some of them.
  const interior = new Map(); // entry index → local positions
  const cutAfterEntry = new Set();
  for (const c of cuts) {
    if (c.entry !== undefined) { if (!interior.has(c.entry)) interior.set(c.entry, []); interior.get(c.entry).push(c.x); }
    else cutAfterEntry.add(c.after);
  }
  const units = [], cutAfterUnit = [];
  entries.forEach(({ cell }, i) => {
    const c = cells[cell], l = layout[i];
    const xs = interior.get(i);
    if (!xs) {
      units.push({ ids: c.ids, cell, len: l.band ? l.L : 0 });
      cutAfterUnit.push(cutAfterEntry.has(i));
      return;
    }
    // Slice the band at each cut, perpendicular to its centre line.
    const e = edges[c.edge];
    const a = V[e.a], b = V[e.b];
    const t = [(b[0] - a[0]) / l.L, (b[1] - a[1]) / l.L], nrm = [-t[1], t[0]];
    const along = xs.map(x => (l.forward ? x : l.L - x)).sort((p, q) => p - q); // from a
    const [Ra, Rb, Lb, La] = c.ids;
    let r = Ra, lft = La, prevAt = 0;
    const slices = [];
    for (const at of along) {
      const m = [a[0] + t[0] * at, a[1] + t[1] * at];
      const pr = pts.push([m[0] - nrm[0] * d, m[1] - nrm[1] * d]) - 1;
      const pl = pts.push([m[0] + nrm[0] * d, m[1] + nrm[1] * d]) - 1;
      slices.push({ ids: [r, pr, pl, lft], cell, len: at - prevAt });
      r = pr; lft = pl; prevAt = at;
    }
    slices.push({ ids: [r, Rb, Lb, lft], cell, len: l.L - prevAt });
    if (!l.forward) slices.reverse();
    slices.forEach((u, k) => { units.push(u); cutAfterUnit.push(k < slices.length - 1 || cutAfterEntry.has(i)); });
  });

  // Group units between cuts. In a loop, the stretch after the last cut joins the first.
  const pieces = [];
  let cur = [];
  units.forEach((u, k) => {
    cur.push(u);
    if (cutAfterUnit[k]) { pieces.push({ units: cur }); cur = []; }
  });
  if (cur.length) {
    if (isCycle && pieces.length) pieces[0].units = cur.concat(pieces[0].units);
    else pieces.push({ units: cur });
  }
  return pieces;
}

/**
 * Merge cells that share sides into one outline: every side shared by two cells (same two
 * points, opposite directions) cancels, and what is left is chained into loops.
 * Usually that is one loop. Next to a face swallowed by the strap, the outline can touch
 * itself at a single point; it is then split there into lobes (at a shared point, take the
 * side that turns most sharply right, as the face walk does), each a simple polygon.
 * @param {number[][]} cellIds  each a polygon as point ids
 * @param {Point[]} pts
 * @returns {number[][] | null} the merged outline(s), or null if they enclose a hole (the
 *   cells form a ring) or cannot be chained
 */
function mergeCells(cellIds, pts) {
  if (cellIds.length === 1) return [dedupeIds(cellIds[0])];
  // Directed sides as a multiset: a side a→b cancels one b→a. (A band squeezed to zero
  // width between two swallowed faces has both a→b and b→a; counting keeps that exact.)
  const K = 67108864;
  const count = new Map();
  for (const ids of cellIds) {
    for (let k = 0; k < ids.length; k++) {
      const a = ids[k], b = ids[(k + 1) % ids.length];
      if (a === b) continue;
      const rev = b * K + a;
      if (count.get(rev) > 0) count.set(rev, count.get(rev) - 1);
      else count.set(a * K + b, (count.get(a * K + b) ?? 0) + 1);
    }
  }
  const sides = [];
  for (const [key, n] of count) for (let i = 0; i < n; i++) sides.push([Math.floor(key / K), key % K]);
  if (sides.length < 3) return null;
  const outOf = new Map(); // point id → ids it has a side to
  for (const [a, b] of sides) {
    if (outOf.has(a)) outOf.get(a).push(b); else outOf.set(a, [b]);
  }
  const angle = (from, to) => Math.atan2(pts[to][1] - pts[from][1], pts[to][0] - pts[from][0]);
  const loops = [];
  let used = 0;
  for (const [a0, b0] of sides) {
    if (!outOf.get(a0).includes(b0)) continue; // already used
    const loop = [];
    let a = a0, b = b0;
    for (let guard = 0; guard <= sides.length; guard++) {
      loop.push(a);
      const list = outOf.get(a);
      list.splice(list.indexOf(b), 1);
      used++;
      if (b === a0) break;
      const choices = outOf.get(b);
      if (!choices || !choices.length) return null;
      let next = choices[0];
      if (choices.length > 1) {
        // First side clockwise from the way back: keeps each lobe separate and simple.
        const back = angle(b, a);
        const cw = c => { let t = back - angle(b, c); while (t <= 0) t += 2 * Math.PI; return t; };
        next = choices.reduce((best, c) => (cw(c) < cw(best) ? c : best));
      }
      a = b; b = next;
    }
    if (loop.length < 3) return null;
    loops.push(loop);
  }
  if (used !== sides.length) return null;
  // A clockwise loop is a hole: the cells formed a ring, which one piece cannot be.
  for (const loop of loops) if (!(area(loop.map(i => pts[i])) > 0)) return null;
  return loops;
}

/** Package a merged run piece with its metadata. */
function makeStrap(poly, units, cells) {
  const edgeIds = [], vertexIds = [];
  let over = false, len = 0;
  for (const u of units) {
    const c = cells[u.cell];
    if (c.edge >= 0 && !edgeIds.includes(c.edge)) edgeIds.push(c.edge);
    if (c.vertex >= 0 && !vertexIds.includes(c.vertex)) vertexIds.push(c.vertex);
    if (c.over) over = true;
    len += u.len;
  }
  return { poly: removeCollinear(poly), edgeIds, vertexIds, over, len };
}

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

/** Drop consecutive repeated ids (cyclically). */
function dedupeIds(ids) {
  const out = [];
  for (const i of ids) if (out[out.length - 1] !== i) out.push(i);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

/** Point ids → polygon, dropping repeated points. */
function idsToPoly(ids, pts) {
  return dedupe(dedupeIds(ids).map(i => pts[i]));
}

/**
 * Where a face's corners meet when the face is swallowed by the strap: the incentre for a
 * triangle (where its inset really vanishes), otherwise a point safely inside.
 */
function fallbackPoint(poly) {
  if (poly.length === 3) {
    const [A, B, C] = poly;
    const a = dist(B, C), b = dist(C, A), c = dist(A, B), s = a + b + c;
    if (s > 0) return [(a * A[0] + b * B[0] + c * C[0]) / s, (a * A[1] + b * B[1] + c * C[1]) / s];
  }
  return interiorPoint(poly);
}

/** Mitred offset without collapsing anything (last resort for a degenerate outer ring). */
function plainMitres(poly, d) {
  const n = poly.length;
  const pts = poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n], c = poly[(i + 1) % n];
    const t1 = normalize(sub(p, a)), t2 = normalize(sub(c, p));
    const k = 1 + dot(t1, t2);
    const s = k > 0.05 ? d / k : d / 0.05;
    return [p[0] + s * (-t1[1] - t2[1]), p[1] + s * (t1[0] + t2[0])];
  });
  return { pts, idx: pts.map((_, i) => i) };
}
