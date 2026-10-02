// Glaze palette. Keys are shared by the pattern (which piece is which colour) and the
// renderer (what that colour looks like). Values are sRGB hex, as a potter would name them.
export const PAL = {
  W: '#e4d9c2', // cream / white glaze
  K: '#1f1a19', // manganese black
  B: '#1a3473', // lapis blue
  T: '#1b716e', // turquoise
  G: '#29583f', // green
  O: '#b98128', // ochre
  R: '#8e3f2b', // terracotta
  A: '#d3a64e', // gold (rendered metallic)
};

/** Keys rendered with the metallic material. */
export const METAL = new Set(['A']);

/**
 * Per-piece glaze variation, in sRGB HSL units. Real zellige varies strongly tile to tile,
 * most of all in the greens and blues; a few "kiln" pieces come out notably darker or lighter.
 */
export const VARIATION = {
  hue: 0.008,
  sat: 0.06,
  light: { K: 0.035, W: 0.045, default: 0.08 },
  kiln: { chance: 0.02, light: 0.14 },
};
