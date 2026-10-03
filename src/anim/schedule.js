// The laying schedule: when each piece starts to fall, and fast answers to "how far along
// are we?" for the HUD and camera.
//
// The prototype walked a pointer through the tile list every frame. Here every question is
// a binary search or a table lookup, so asking it costs O(log N) no matter how many pieces
// there are, and nothing loops over the pieces per frame.

/**
 * Build the schedule for a list of pieces.
 *
 * @param {Array<{seq:number, r:number, stage:string}>} pieces  any order; sorted here by `seq`
 * @param {{T_START:number, T_SPAN:number, P_EXP:number, D:number}} timing
 *   piece i (in laying order) starts at T_START + T_SPAN·(i/N)^P_EXP and lands D seconds later.
 */
export function makeSchedule(pieces, { T_START, T_SPAN, P_EXP, D }) {
  // Stable sort: pieces with equal seq keep their input order (Array.prototype.sort is
  // stable in every current engine; the index tie-break makes that explicit).
  const sorted = pieces
    .map((piece, index) => ({ piece, index }))
    .sort((a, b) => (a.piece.seq - b.piece.seq) || (a.index - b.index))
    .map(entry => entry.piece);

  const N = sorted.length;

  // Start times. The power curve (P_EXP < 1) makes the first pieces slow and deliberate
  // and the outer field fast. Stored as float32: these exact values also go to the GPU, so
  // the CPU counts below and the shader agree on which pieces have started.
  const t0 = new Float32Array(N);
  for (let i = 0; i < N; i++) t0[i] = T_START + T_SPAN * Math.pow(i / N, P_EXP);

  const T_END = N ? t0[N - 1] + D : T_START;

  // Prefix maximum of r: rMaxUpTo[i] = max(r of pieces 0..i). The camera frames the laid
  // radius, and pieces are laid roughly (not strictly) outward, so this must be a max.
  const rMaxUpTo = new Float64Array(N);
  let running = 0;
  for (let i = 0; i < N; i++) {
    running = Math.max(running, sorted[i].r ?? 0);
    rMaxUpTo[i] = running;
  }

  // Suffix minimum of each piece's inner radius (its closest point to the centre):
  // rInFrom[i] = min over pieces i..N-1. Once the first k pieces have landed, everything
  // closer to the centre than rInFrom[k] is covered (the bed uses it to hide its underdrawing
  // under laid pieces).
  const rInFrom = new Float64Array(N + 1);
  rInFrom[N] = Infinity;
  for (let i = N - 1; i >= 0; i--) rInFrom[i] = Math.min(rInFrom[i + 1], innerRadius(sorted[i]));

  /**
   * Count of indices i with predicate(i) true, for a predicate that is true on a prefix
   * (true, true, ..., false, false). Classic upper-bound binary search: O(log N).
   */
  function countPrefix(isTrue) {
    let lo = 0, hi = N;               // answer is in [lo, hi]
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (isTrue(mid)) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Number of pieces that have started falling: t0 ≤ sim. */
  const startedAt = sim => countPrefix(i => t0[i] <= sim);

  /** Number of pieces that have landed: t0 + D ≤ sim. (t0 is sorted, so this is a prefix too.) */
  const landedAt = sim => countPrefix(i => t0[i] + D <= sim);

  /** Stage label of the most recently started piece (the prototype's HUD rule), or null. */
  const stageAt = sim => {
    const n = startedAt(sim);
    return n ? sorted[n - 1].stage ?? null : null;
  };

  /** Largest piece radius among the started pieces (0 before the first). */
  const rLaidAt = sim => {
    const n = startedAt(sim);
    return n ? rMaxUpTo[n - 1] : 0;
  };

  /** Radius inside which every piece has landed: 0 before the first, Infinity after the last. */
  const rCoveredAt = sim => rInFrom[landedAt(sim)];

  return { pieces: sorted, t0, N, D, T_END, startedAt, landedAt, stageAt, rLaidAt, rCoveredAt };
}

/**
 * Distance from the centre to the nearest point of a piece: 0 if the piece covers the centre,
 * else the shortest distance to one of its edges. Pieces without an outline use `rc`.
 */
function innerRadius(piece) {
  const poly = piece.poly;
  if (!poly || poly.length < 3) return piece.rc ?? 0;
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[j];
    if ((ay > 0) !== (by > 0) && 0 < (bx - ax) * (0 - ay) / (by - ay) + ax) inside = !inside;
    // distance from the origin to segment a-b
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return inside ? 0 : best;
}

/**
 * The prototype's drop curve, as a function of progress p = (sim − t0) / D.
 * Returns the height above rest `y` and the tumble fraction `f` (1 = full tumble, 0 = flat).
 * `visible` is false before the piece starts. The vertex shader (scene/shaders/drop.js)
 * implements exactly this; this JS copy is the reference the tests and the dev harness
 * compare the GPU against.
 *
 *   p < 0        not started: hidden
 *   0 ≤ p < 0.8  falling: q = p/0.8, y = DROP·(1 − q²) (gravity easing), f = 1 − q
 *   0.8 ≤ p < 1  settling: q = (p − 0.8)/0.2, y = 0.06·sin(πq) (a tiny bounce), f = 0
 *   p ≥ 1        landed: y = 0, f = 0
 */
export function dropPhase(p, DROP) {
  if (p < 0) return { visible: false, y: 0, f: 0 };
  if (p >= 1) return { visible: true, y: 0, f: 0 };
  if (p < 0.8) {
    const q = p / 0.8;
    return { visible: true, y: DROP * (1 - q * q), f: 1 - q };
  }
  const q = (p - 0.8) / 0.2;
  return { visible: true, y: 0.06 * Math.sin(Math.PI * q), f: 0 };
}
