// The 8-fold field: Hankin's "polygons in contact" method on the 4.8.8 tiling.
//
//   1. Base tiling. 4.8.8 (the truncated square tiling): regular octagons centred on the
//      square lattice (iP, jP), with flat edges facing ±x and ±y, so each octagon shares a
//      flat edge with its four neighbours (flat-to-flat = P). The diamond-shaped gaps
//      centred on ((i + ½)P, (j + ½)P) are squares, sharing the octagons' diagonal edges.
//      Every edge has the same length a = P·tan(22.5°) = P / (1 + √2).
//   2. Hankin's rays. From the midpoint of every tile edge, launch two rays into the tile,
//      each making the contact angle θ with the edge, and stop each ray where it meets the
//      ray from the neighbouring edge. At θ = 67.5° the octagon gets an 8-point star whose
//      tips are its edge midpoints (each tip 45°), and the square a 4-point star.
//   3. One line per crossing. The two tiles either side of an edge launch their rays from
//      the same midpoint at the same angle, so a ray in one tile and a ray in the other are
//      collinear: together they make one straight line through the midpoint. Each edge
//      therefore yields exactly two straight segments that cross at its midpoint, and we
//      emit each of them once. (Emitting the two half-rays separately would also work for
//      the engine, but one segment per line is what a craftsman draws, and keeps the line
//      count honest.)
//
// The faces the lines enclose (verified by tests/hankin.test.mjs with the engine): per
// period cell, one 8-point star in the octagon (16-sided, tips 45°, inner corners 270°),
// one 4-point star in the square (8-sided, tips 45°, inner corners 225°) and four hexagons,
// one around each tiling vertex where two octagons and a square meet (corners 90° at the
// two octagon stars, 135° elsewhere). The octagon's star is the outline of the {8/3} star
// polygon: at 67.5° the ray from edge midpoint k heads straight for midpoint k + 3.
//
// The drawing has the square's full symmetry (4 rotations, 4 mirrors) about every octagon
// centre, so the panel edge x = 46 = 10P, which runs through octagon centres, is a mirror.
//
// Pure JavaScript, runs in Node.

import { FIELD, PANEL } from '../config.js';
import { add, sub, mul, normalize, rotate, lineIntersect, centroid } from './geom.js';

/**
 * @typedef {import('./geom.js').Point} Point
 * @typedef {import('./geom.js').Poly} Poly
 * @typedef {import('./geom.js').Segment} Segment
 *
 * @typedef {object} Tile  One polygon of the base tiling.
 * @property {'oct' | 'sq'} kind
 * @property {number} i         lattice index: octagon centre (iP, jP); square ((i+½)P, (j+½)P)
 * @property {number} j
 * @property {Point} centre
 * @property {Poly} poly        counter-clockwise
 *
 * @typedef {object} FieldClass  How the composition colours and labels a face.
 * @property {string} key       palette key (palette.js)
 * @property {string} stage     HUD label
 * @property {'star8' | 'star4' | 'hex'} kind
 */

/** HUD label for every piece of the field. */
export const FIELD_STAGE = 'Eight-point stars';

/** Palette keys per face kind. The octagon stars alternate lapis / turquoise like a chequerboard. */
const KEYS = { star8Even: 'B', star8Odd: 'T', star4: 'O', hex: 'W' };

/**
 * Build the 8-fold field's centre lines.
 *
 * @param {object} [opts]
 * @param {number} [opts.P=FIELD.P]           period: octagon centre to octagon centre
 * @param {number} [opts.theta=FIELD.THETA]   Hankin contact angle in DEGREES. Must be in
 *   (45°, 90°): below 45° the square's rays meet outside the square.
 * @param {{halfW: number, halfH: number}} [opts.bounds]  region to cover, centred on the
 *   origin (default the panel, |x|, |y| ≤ 46). Lines cover it plus at least one period of
 *   margin, so the outermost straps (which the engine extends past the drawing's boundary)
 *   are well outside and get clipped away.
 * @param {number} [opts.strap=FIELD.STRAP]   strap width, passed through
 * @returns {{
 *   segments: Segment[],
 *   strap: number,
 *   classify: (face: {centroid?: Point, poly?: Poly}) => FieldClass,
 *   baseTiling: { octagons: Poly[], squares: Poly[] },
 * }}
 *   `segments`: one straight segment per Hankin line, each crossing one tiling edge at that
 *   edge's midpoint (where its rays were launched); a line on the outermost edges of the
 *   generated patch is just the half inside it.
 *   `classify`: for an arrangement face (use the unclipped face: clipping moves a centroid).
 *   `baseTiling`: the octagons and squares that overlap `bounds`, for the sinopia drawing.
 */
export function buildField(opts = {}) {
  const P = opts.P ?? FIELD.P;
  const thetaDeg = opts.theta ?? FIELD.THETA;
  const bounds = opts.bounds ?? { halfW: PANEL.HALF, halfH: PANEL.HALF };
  const strap = opts.strap ?? FIELD.STRAP;
  if (!(P > 0)) throw new Error('buildField: P must be a positive number');
  if (!(thetaDeg > 45 && thetaDeg < 90)) {
    throw new Error(`buildField: theta is the contact angle in degrees and must be in (45, 90); got ${thetaDeg}`);
  }
  const theta = (thetaDeg * Math.PI) / 180;

  // Tiles covering the bounds plus a margin: ceil(half/P) reaches the bounds, +1 adds a
  // period, and each octagon reaches another P/2 beyond its centre.
  const nx = Math.ceil(bounds.halfW / P) + 1;
  const ny = Math.ceil(bounds.halfH / P) + 1;
  const tiles = tiling488(P, nx, ny);

  const segments = hankinSegments(tiles, theta, P);

  // The sinopia only needs the tiles that show inside the bounds (bounding-box overlap; a
  // tile that only touches the bounds' edge is left out).
  const overlaps = ({ poly }) => {
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    return Math.min(...xs) < bounds.halfW && Math.max(...xs) > -bounds.halfW &&
      Math.min(...ys) < bounds.halfH && Math.max(...ys) > -bounds.halfH;
  };
  const baseTiling = {
    octagons: tiles.filter(t => t.kind === 'oct' && overlaps(t)).map(t => t.poly),
    squares: tiles.filter(t => t.kind === 'sq' && overlaps(t)).map(t => t.poly),
  };

  return { segments, strap, classify: makeClassifier(P), baseTiling };
}

// ---------------------------------------------------------------------------------------
// 1. The 4.8.8 tiling
// ---------------------------------------------------------------------------------------

/**
 * The octagons (iP, jP) for |i| ≤ nx, |j| ≤ ny, and every square between four of them.
 * Vertices come straight from the construction: an octagon of apothem P/2 has its corners
 * at (±P/2, ±a/2) and (±a/2, ±P/2) where a = P·tan(22.5°) is the edge; a square's corners
 * are the octagon corners around it, at distance P/2 − a/2 from its centre along the axes.
 * @returns {Tile[]}
 */
export function tiling488(P, nx, ny) {
  const a = P * Math.tan(Math.PI / 8);   // edge length, = P / (1 + √2)
  const h = P / 2, e = a / 2;            // octagon apothem, half edge
  const s = h - e;                       // square: centre to corner
  // Counter-clockwise, starting at the corner at 22.5°.
  const octCorners = [[h, e], [e, h], [-e, h], [-h, e], [-h, -e], [-e, -h], [e, -h], [h, -e]];
  const sqCorners = [[0, -s], [s, 0], [0, s], [-s, 0]];
  const tiles = [];
  for (let i = -nx; i <= nx; i++) {
    for (let j = -ny; j <= ny; j++) {
      const c = [i * P, j * P];
      tiles.push({ kind: 'oct', i, j, centre: c, poly: octCorners.map(p => add(c, p)) });
    }
  }
  for (let i = -nx; i < nx; i++) {
    for (let j = -ny; j < ny; j++) {
      const c = [(i + 0.5) * P, (j + 0.5) * P];
      tiles.push({ kind: 'sq', i, j, centre: c, poly: sqCorners.map(p => add(c, p)) });
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------------------
// 2–3. Hankin's rays, joined into one line across each shared edge
// ---------------------------------------------------------------------------------------

/**
 * Hankin's rays for every tile, joined across shared edges.
 * @param {Tile[]} tiles
 * @param {number} theta  contact angle, radians
 * @param {number} P      period (sets the tolerance for matching shared edges)
 * @returns {Segment[]}
 */
function hankinSegments(tiles, theta, P) {
  // Index the edges by midpoint so the two tiles sharing an edge find each other, and both
  // launch their rays from the same (first computed) midpoint.
  const q = P * 1e-6;
  const keyOf = ([x, y]) => `${Math.round(x / q)},${Math.round(y / q)}`;
  const edges = new Map(); // key → { mid, sides: [{ fwd, back }] }

  for (const t of tiles) {
    const n = t.poly.length;
    const mids = [], fwd = [], back = [];
    for (let k = 0; k < n; k++) {
      const p0 = t.poly[k], p1 = t.poly[(k + 1) % n];
      const m = mul(add(p0, p1), 0.5);
      const key = keyOf(m);
      if (!edges.has(key)) edges.set(key, { mid: m, sides: [] });
      mids.push(edges.get(key).mid);
      const d = normalize(sub(p1, p0));
      // The tile is counter-clockwise, so its inside is to the LEFT of each edge: turning
      // the edge direction counter-clockwise by θ leans the forward ray into the tile, and
      // the backward ray is its mirror image about the edge's perpendicular bisector.
      fwd.push(rotate(d, theta));
      back.push(rotate(mul(d, -1), -theta));
    }
    // Where edge k's forward ray meets edge k+1's backward ray: the star's inner corner
    // that points at tile vertex k+1.
    const X = [];
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const p = lineIntersect(mids[k], fwd[k], mids[k1], back[k1]);
      if (!p) throw new Error('buildField: Hankin rays are parallel (contact angle out of range)');
      X.push(p);
    }
    // Edge k's forward ray ends at X[k]; its backward ray ends at X[k − 1].
    for (let k = 0; k < n; k++) {
      edges.get(keyOf(mids[k])).sides.push({ fwd: X[k], back: X[(k - 1 + n) % n] });
    }
  }

  // Tile A's forward ray and tile B's forward ray from a shared midpoint point in opposite
  // directions along one line (B walks the edge the other way round), and likewise the two
  // backward rays. So each shared edge gives two straight segments, end to end through M.
  const segments = [];
  for (const { mid, sides } of edges.values()) {
    if (sides.length === 2) {
      const [A, B] = sides;
      segments.push([A.fwd, B.fwd], [A.back, B.back]);
    } else if (sides.length === 1) {
      // Outermost edge of the patch: only the half inside the patch exists.
      segments.push([mid, sides[0].fwd], [mid, sides[0].back]);
    } else {
      throw new Error(`buildField: tiling edge at ${mid} is shared by ${sides.length} tiles`);
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------

/**
 * Classify a face by where its centroid sits in the lattice. The two stars are centred
 * exactly on their tile's centre (octagon (iP, jP), square ((i+½)P, (j+½)P)); everything
 * else is a hexagon around a tiling vertex. The tolerance (P/8) is far below the gap
 * between site types: a hexagon's centroid sits 0.30P from the nearest square centre and
 * 0.54P from the nearest octagon centre (measured in tests/hankin.test.mjs).
 */
function makeClassifier(P) {
  const tol = P / 8;
  return function classify(face) {
    const [x, y] = face.centroid ?? centroid(face.poly);
    const i = Math.round(x / P), j = Math.round(y / P);
    if (Math.hypot(x - i * P, y - j * P) < tol) {
      // Chequerboard: the octagon at the origin (i + j even) is lapis.
      const odd = ((i + j) % 2 + 2) % 2 === 1;
      return { key: odd ? KEYS.star8Odd : KEYS.star8Even, stage: FIELD_STAGE, kind: 'star8' };
    }
    const si = Math.floor(x / P) + 0.5, sj = Math.floor(y / P) + 0.5;
    if (Math.hypot(x - si * P, y - sj * P) < tol) return { key: KEYS.star4, stage: FIELD_STAGE, kind: 'star4' };
    return { key: KEYS.hex, stage: FIELD_STAGE, kind: 'hex' };
  };
}
