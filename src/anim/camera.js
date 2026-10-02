// The camera path: an automatic framing that follows how far out the panel has been laid,
// plus the viewer's own orbit (drag to turn, wheel to zoom, double-click to reset) layered on
// top of it.
//
// The path in one sentence: it frames a circle of radius F around the centre, where F eases
// toward the laid radius; as F grows from 3.2 to 57 the view rises from a low 24° close-up to
// about 64° overhead and swings a little around, while turning very slowly with time.

/** Tunables owned by this module. */
export const FRAMING = {
  F_MIN: 3.2,        // framed radius at the opening close-up
  F_MAX: 57,         // framed radius when the whole bed is in view
  F_PER_R: 1.12,     // framed radius per unit of laid radius ...
  F_PAD: 2.4,        // ... plus this margin
  EASE: 1.1,         // per second: how quickly the framing catches up
  EL0: 0.42, EL_GAIN: 0.72, EL_MIN: 0.2, EL_MAX: 1.45,  // elevation (radians) from close to wide
  AZ0: 0.55, AZ_GAIN: 0.35, AZ_DRIFT: 0.004,           // azimuth, and its slow turn per sim second
  MARGIN: 1.05,      // fit the framed radius with 5% to spare
  PORTRAIT_MIN_ASPECT: 0.45,  // on tall screens back off by 1/aspect (capped) so the width fits
};

/** The viewer's orbit limits. */
export const ORBIT = {
  AZ_PER_PX: 0.005, EL_PER_PX: 0.004,
  EL_MIN: -0.6, EL_MAX: 0.9,
  ZOOM_PER_WHEEL: 0.001, ZOOM_MIN: 0.3, ZOOM_MAX: 2.2,
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * How much further back the camera stands on a portrait screen: the framing fits a circle
 * to the screen height, so on a tall screen it backs off by 1/aspect (capped) to fit the
 * width instead. 1 on landscape screens.
 */
export function portraitFactor(aspect) {
  return aspect < 1 ? 1 / Math.max(aspect, FRAMING.PORTRAIT_MIN_ASPECT) : 1;
}
/** Hermite smoothstep: 0 below a, 1 above b, an S-curve between. */
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * @param camera THREE.PerspectiveCamera
 * @param canvas the element that receives pointer and wheel input
 */
export function createCameraRig(camera, canvas) {
  let framed = FRAMING.F_MIN;      // eased framed radius ("Fs" in the prototype)
  let userAz = 0, userEl = 0, userZoom = 1;

  // --- viewer input ---
  let drag = null;
  const onDown = e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); };
  const onMove = e => {
    if (!drag) return;
    userAz -= (e.clientX - drag.x) * ORBIT.AZ_PER_PX;
    userEl = clamp(userEl + (e.clientY - drag.y) * ORBIT.EL_PER_PX, ORBIT.EL_MIN, ORBIT.EL_MAX);
    drag = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => { drag = null; };
  const onWheel = e => {
    e.preventDefault();  // keep the page itself from scrolling
    userZoom = clamp(userZoom * Math.exp(e.deltaY * ORBIT.ZOOM_PER_WHEEL), ORBIT.ZOOM_MIN, ORBIT.ZOOM_MAX);
  };
  const resetView = () => { userAz = userEl = 0; userZoom = 1; };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', resetView);

  /**
   * Moves the camera for this frame.
   * @param dt    seconds since the last frame (wall clock, capped)
   * @param rLaid radius of the furthest tile laid so far
   * @param sim   simulation time, for the slow turn
   */
  function update(dt, rLaid, sim) {
    const F = clamp(rLaid * FRAMING.F_PER_R + FRAMING.F_PAD, FRAMING.F_MIN, FRAMING.F_MAX);
    framed += (F - framed) * Math.min(1, dt * FRAMING.EASE);
    const k = smoothstep(FRAMING.F_MIN, FRAMING.F_MAX, framed);   // 0 at the close-up, 1 when wide

    const el = clamp(FRAMING.EL0 + FRAMING.EL_GAIN * k + userEl, FRAMING.EL_MIN, FRAMING.EL_MAX);
    const az = FRAMING.AZ0 + FRAMING.AZ_GAIN * k + userAz + sim * FRAMING.AZ_DRIFT;

    // Distance at which a circle of radius `framed` fits the vertical field of view
    let d = framed / Math.tan(camera.fov * Math.PI / 360) * FRAMING.MARGIN;
    d *= portraitFactor(camera.aspect);
    d *= userZoom * (1.25 - 0.25 * Math.sin(el));   // low views stand back a little further

    camera.position.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
    camera.lookAt(0, 0, 0);
  }

  return {
    update,
    resetView,
    /** The eased framed radius (the light uses it to size the shadow box). */
    get framing() { return framed; },
    /** The viewer's zoom factor (1 = the automatic path). */
    get zoom() { return userZoom; },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', resetView);
    },
  };
}
