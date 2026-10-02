// The prototype's pattern, ported unchanged: a colour *function* of floor position.
//
// This is the opus tessellatum approach the zellige phase replaces. Every square tile asks
// "what colour am I?" from the point under its centre, which is why curved edges come out
// stepped. It stays here so the legacy tile system (src/legacy/tiles.js) can reproduce the
// prototype exactly while the new pattern is being built next to it.
//
// Pure JavaScript, no three.js: it runs in Node for tests.

const TAU = Math.PI * 2;

/**
 * Radius of an n-point star outline in direction `th`. The star is a polygon alternating
 * between outer points (radius Ro) and inner corners (radius Ri), so within one sector the
 * edge is the straight line from (Ro, 0) to the inner corner at half the sector angle.
 * Returns where a ray at angle th meets that line.
 */
export function starR(th, Ro, Ri, n) {
  const sec = TAU / n;
  let p = ((th % sec) + sec) % sec;   // angle within the sector, 0..sec
  if (p > sec / 2) p = sec - p;       // mirror: each sector is symmetric about its middle
  const Px = Ro, Py = 0;
  const Qx = Ri * Math.cos(sec / 2), Qy = Ri * Math.sin(sec / 2);
  const dx = Qx - Px, dy = Qy - Py;
  const c = Math.cos(p), s = Math.sin(p);
  return (Px * dy - Py * dx) / (c * dy - s * dx);  // ray-line intersection distance
}

/** The circular medallion (r < 31): rings, an 8-point star, 16 petals, a sawtooth band. */
export function rosette(r, th) {
  if (r < 0.72) return ['W', 'The center point'];
  if (r < 1.78) return ['K', 'The center point'];
  if (r < 2.92) return ['A', 'First gold ring'];
  if (r < 11) {
    const R = starR(th, 10.9, 6.3, 8);
    if (r < R - 0.85) return [r < 5 ? 'T' : 'B', 'Eight-point star'];
    if (r < R) return ['K', 'Eight-point star'];   // black outline just inside the star edge
    return ['W', 'Eight-point star'];
  }
  if (r < 12) return ['K', 'Framing rings'];
  if (r < 13) return ['A', 'Framing rings'];
  if (r < 14) return ['K', 'Framing rings'];
  if (r < 21) {
    // 16 pointed petals: half-width follows a sine over the band, so they taper at both ends
    const sec = TAU / 16;
    const ph = ((th % sec) + sec) % sec;
    const psi = Math.min(ph, sec - ph);   // angle from the nearest petal axis
    const t = (r - 14) / 7;
    const hw = (sec / 2) * 0.9 * Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.7);
    const d = psi * r, Hh = hw * r;       // arc distances from the axis and to the petal edge
    const dot = Math.hypot((sec / 2 - psi) * r, r - 17.5);
    if (dot < 1.35) return ['R', 'Sixteen petals'];   // terracotta dots between the petals
    if (d < Hh - 0.9) return [(d < 0.5 && t > 0.25 && t < 0.8) ? 'T' : 'G', 'Sixteen petals'];
    if (d < Hh) return ['K', 'Sixteen petals'];
    return ['W', 'Sixteen petals'];
  }
  if (r < 22) return ['K', 'Sawtooth band'];
  if (r < 25) {
    const u = (((th / TAU) * 32) % 1 + 1) % 1, tri = Math.abs(u * 2 - 1), v = (r - 22) / 3;
    return [v < 1 - tri ? 'B' : 'W', 'Sawtooth band'];
  }
  if (r < 26) return ['K', 'Outer rings'];
  if (r < 27) return ['A', 'Outer rings'];
  if (r < 28) return ['R', 'Outer rings'];
  if (r < 29) return ['K', 'Outer rings'];
  return ['W', 'Outer rings'];
}

/** Star-and-cross lattice spacing: 4.5 cells across the half-panel. */
export const L = 46 / 4.5;

/** The square field outside the medallion: alternating lapis/turquoise 8-point stars, ochre crosses. */
export function field(x, z) {
  const ix = Math.round(x / L), iz = Math.round(z / L);
  const lx = Math.abs(x - ix * L), lz = Math.abs(z - iz * L);
  // max(|x|,|z|) is a square, (|x|+|z|)/√2 a diamond: their min is an 8-point star
  const m = Math.min(Math.max(lx, lz), (lx + lz) / Math.SQRT2), a = L / (2 * Math.SQRT2);
  const cx = Math.abs(x - L * (Math.floor(x / L) + 0.5)), cz = Math.abs(z - L * (Math.floor(z / L) + 0.5));
  if (cx < 1.05 && cz < 1.05) return ['O', 'Star-and-cross field'];
  if (m < a - 0.9) return [((ix + iz) & 1) ? 'T' : 'B', 'Star-and-cross field'];
  if (m < a) return ['K', 'Star-and-cross field'];
  return ['W', 'Star-and-cross field'];
}

/** The frame from 46 to 52: black lines, a terracotta/white triangle band, a gold edge, corner squares. */
export function border(x, z, ax, az, e) {
  const st = 'Border';
  if (ax >= 47 && az >= 47 && e < 50) {
    return [(Math.abs(ax - 48.5) < 0.6 && Math.abs(az - 48.5) < 0.6) ? 'A' : 'B', st];
  }
  if ((ax < 47 && az >= 47 && az < 50) || (az < 47 && ax >= 47 && ax < 50)) return ['K', st];
  if (e < 47) return ['K', st];
  if (e < 50) {
    const s = az >= ax ? x : z, u = (((s + 46) / 5.75) % 1 + 1) % 1, tri = Math.abs(u * 2 - 1), v = (e - 47) / 3;
    return [v < tri ? 'R' : 'W', st];
  }
  if (e < 51) return ['K', st];
  return ['A', st];
}

/** Colour key and stage label for the floor point (x, z). */
export function colorAt(x, z) {
  const ax = Math.abs(x), az = Math.abs(z), e = Math.max(ax, az);
  if (e >= 46) return border(x, z, ax, az, e);
  const r = Math.hypot(x, z);
  if (r < 31.05) return rosette(r, Math.atan2(z, x));
  return field(x, z);
}

/**
 * The prototype's sinopia (the setter's red underdrawing), as a drawing spec in pattern
 * units for scene/bed.js `drawSinopia`: guide circles at the ring boundaries, the panel and
 * border squares, the 8-point star outline, 8 radial spokes and the field lattice.
 */
export function legacySinopia() {
  const strong = { width: 0.2, alpha: 0.72 };
  const faint = { width: 0.09, alpha: 0.38 };

  const circles = [3, 11, 14, 22, 25, 29, 31].map(r => ({ r, ...strong }));
  const rects = [46, 52].map(s => ({ min: [-s, -s], max: [s, s], ...strong }));

  // Star outline: 721 samples, the last repeating the first (the prototype's exact path)
  const star = [];
  for (let i = 0; i <= 720; i++) {
    const th = i / 720 * TAU, R = starR(th, 10.9, 6.3, 8);
    star.push([R * Math.cos(th), R * Math.sin(th)]);
  }

  // Spokes from r = 3 out to the 52-square, one per 45°
  const spokes = [];
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * TAU, c = Math.cos(a), s = Math.sin(a), toSquare = 52 / Math.max(Math.abs(c), Math.abs(s));
    spokes.push({ pts: [[c * 3, s * 3], [c * toSquare, s * toSquare]], ...faint });
  }

  // Lattice lines: one stroke per k holds both the vertical and the horizontal line, so
  // where those two cross the alpha does not double up (as in the prototype's canvas path)
  const lattice = [];
  for (let k = -4; k <= 4; k++) {
    const v = k * L;
    lattice.push({ paths: [[[v, -46], [v, 46]], [[-46, v], [46, v]]], ...faint });
  }

  return {
    color: [160, 62, 40],
    circles,
    rects,
    polylines: [{ pts: star, ...strong }, ...spokes, ...lattice],
  };
}
