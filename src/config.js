// Every tunable number for the piece, in one place. Units are prototype tesserae.

export const PANEL = { HALF: 46, BORDER: 52, EXT: 114 };

export const PIECE = {
  GROUT: 0.14,   // gap between neighbouring pieces (each inset by GROUT/2)
  BEVEL: 0.07,   // rounded bevel on the top edge
  HEIGHT: 0.38,  // slab thickness before per-piece scale
  WOBBLE: 0.03,  // max vertex jitter: hand-chipped, not laser-cut
};

const P = 92 / 20;
export const FIELD = {
  P,                 // 4.8.8 period; 46 = 10·P so the panel edge is a mirror line through octagon centres
  THETA: 67.5,       // Hankin contact angle, degrees
  STRAP: 0.1 * P,    // strapwork band width
};

export const MEDALLION = { R_F_MAX: 29.5 };

// The prototype's schedule: patient at the centre, quickening outward.
export const TIMING = { T_START: 0.9, T_SPAN: 46, P_EXP: 0.42, D: 0.55, DROP: 2.6 };
