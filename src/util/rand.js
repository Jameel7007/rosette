// Seeded randomness. Every random choice in the piece comes from here, so a given seed
// always lays the same panel (and a later `#seed` URL token can reshare one).

/** mulberry32: a tiny, fast 32-bit generator. Returns a function giving floats in [0, 1). */
export function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The prototype's seed. */
export const SEED = 20261002;

/** FNV-1a hash of a string, for deriving independent named streams from one seed. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * An independent stream per subsystem ('bed', 'pattern', 'pieces', ...), so changing how
 * many numbers one subsystem draws never reshuffles another.
 */
export function stream(name, seed = SEED) {
  return mulberry((seed ^ hash(name)) >>> 0);
}

/** Symmetric jitter helper: returns a function giving values in (-a, a). */
export const jitter = rand => a => (rand() * 2 - 1) * a;
