// The sun: where it sits, the light sweep that makes the gold glint, and the size of its
// shadow box.
//
// At rest the sun hangs high in one direction. A sweep orbits it once around the panel over
// 11 seconds (eased in and out) while dipping lower in the middle, so light rakes across the
// gold at a shallow angle and each piece flashes as the reflection passes it.

const TAU = Math.PI * 2;

/** Tunables owned by this module. */
export const SUN = {
  REST_ANGLE: -0.75,    // azimuth at rest (radians)
  REST_SLOPE: 1.25,     // height/run at rest (atan 1.25 ≈ 51°)
  SWEEP_DIP: 0.75,      // how much the slope drops mid-sweep (to 0.5, ≈ 27°)
  SWEEP_SECONDS: 11,
  DISTANCE: 100,
  SHADOW_PER_F: 1.5, SHADOW_PAD: 3, SHADOW_MAX: 70,   // shadow box half-size from the framing
};

/**
 * @param sun THREE.DirectionalLight (its target must be in the scene)
 */
export function createLightRig(sun) {
  let sweepStart = -1;   // clock time the current sweep starts; -1 = none

  /** Places the sun for wall-clock time `now` (seconds). */
  function update(now) {
    let angle = SUN.REST_ANGLE, slope = SUN.REST_SLOPE;
    if (sweepStart >= 0 && now >= sweepStart) {
      const p = (now - sweepStart) / SUN.SWEEP_SECONDS;
      if (p >= 1) sweepStart = -1;
      else {
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;   // ease in-out quad
        angle += e * TAU;
        slope = SUN.REST_SLOPE - SUN.SWEEP_DIP * Math.sin(Math.PI * p);
      }
    }
    const R = SUN.DISTANCE, elev = Math.atan(slope);
    sun.position.set(Math.cos(angle) * R * Math.cos(elev), Math.sin(elev) * R, Math.sin(angle) * R * Math.cos(elev));
    sun.target.position.set(0, 0, 0);
  }

  /**
   * Fits the shadow camera to what is on screen: tight at the close-up so shadows stay
   * sharp, wide when the whole panel is in view.
   */
  function fitShadow(framed, zoom) {
    const sc = sun.shadow.camera;
    const S = Math.min(SUN.SHADOW_MAX, framed * SUN.SHADOW_PER_F + SUN.SHADOW_PAD) * Math.max(1, zoom);
    if (Math.abs(sc.right - S) > 0.05) {   // only rebuild the projection when it moved noticeably
      sc.left = -S; sc.right = S; sc.top = S; sc.bottom = -S;
      sc.updateProjectionMatrix();
    }
  }

  return {
    update,
    fitShadow,
    /** Starts a sweep at clock time `at` (now, or a little later). */
    sweep(at) { sweepStart = at; },
    cancel() { sweepStart = -1; },
    get sweeping() { return sweepStart >= 0; },
  };
}
