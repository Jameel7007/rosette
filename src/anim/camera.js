// The camera path: an automatic framing that follows how far out the panel has been laid,
// plus the viewer's own orbit (drag to turn, wheel to zoom, double-click to reset) layered on
// top of it.
//
// The path in one sentence: it frames a circle of radius F around the centre, where F eases
// toward the laid radius; as F grows from 3.2 to 57 the view rises from a low 24° close-up to
// about 64° overhead and swings a little around, while turning very slowly with time.
//
// Input: one pointer (mouse or finger) turns the view; two fingers pinch to zoom; the wheel
// zooms; a double-click (or double-tap) puts the view back on the automatic path.

/** Tunables owned by this module. */
export const FRAMING = {
  F_MIN: 3.2,        // framed radius at the opening close-up
  F_MAX: 57,         // framed radius when the whole bed is in view
  F_PER_R: 1.12,     // framed radius per unit of laid radius ...
  F_PAD: 2.4,        // ... plus this margin
  EASE: 1.1,         // per second: how quickly the framing catches up
  EL0: 0.42, EL_GAIN: 0.72, EL_MIN: 0.2,               // elevation (radians) from close to wide
  // Highest the viewer can drag to: 89.4°, i.e. straight overhead (the brief judges the
  // finished panel from straight above). The prototype stopped at 1.45 rad (83°). Not exactly
  // 90°: lookAt needs the camera a hair off the vertical to know which way is up on screen.
  EL_MAX: 1.56,
  AZ0: 0.55, AZ_GAIN: 0.35, AZ_DRIFT: 0.004,           // azimuth, and its slow turn per sim second
  // The slow turn follows the laying clock step by step; a step bigger than this (Finish jumps
  // ~40 s ahead, Replay jumps back) is not turned through, so the view does not snap round.
  // Normal play steps at most 0.05 s × 8 (the top speed) = 0.4 s per frame.
  DRIFT_MAX_STEP: 0.5,
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
 * @param opts.drift  false: no slow automatic turn (reduced motion: the finished panel holds still)
 */
export function createCameraRig(camera, canvas, { drift = true } = {}) {
  let framed = FRAMING.F_MIN;      // eased framed radius ("Fs" in the prototype)
  let userAz = 0, userEl = 0, userZoom = 1;
  let driftSim = 0, lastSim = 0;   // laying time turned through so far (see DRIFT_MAX_STEP)

  // --- viewer input ---
  // Every pointer that is down (mouse, pen or finger), by id. One pointer turns the view; two
  // fingers pinch: the zoom follows the ratio of their spread to the spread when the second
  // finger landed. (Before this, both fingers fed one drag, so a pinch turned the view instead.)
  const pointers = new Map();
  let pinch = null;   // { spread, zoom } while two pointers are down
  const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const onDown = e => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    pinch = pointers.size === 2 ? { spread: spread(), zoom: userZoom } : null;
  };
  const onMove = e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1) {
      userAz -= dx * ORBIT.AZ_PER_PX;
      userEl = clamp(userEl + dy * ORBIT.EL_PER_PX, ORBIT.EL_MIN, ORBIT.EL_MAX);
    } else if (pinch && pointers.size === 2) {
      // Fingers apart → closer (smaller zoom factor), together → further
      userZoom = clamp(pinch.zoom * pinch.spread / Math.max(1, spread()), ORBIT.ZOOM_MIN, ORBIT.ZOOM_MAX);
    }
  };
  // A lifted finger leaves the other one turning the view from where it is: no jump
  const onUp = e => { pointers.delete(e.pointerId); pinch = null; };
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

  /** The framed radius a laid radius asks for (before easing). */
  const targetFraming = rLaid => clamp(rLaid * FRAMING.F_PER_R + FRAMING.F_PAD, FRAMING.F_MIN, FRAMING.F_MAX);

  /**
   * Moves the camera for this frame.
   * @param dt    seconds since the last frame (wall clock, capped)
   * @param rLaid radius of the furthest tile laid so far
   * @param sim   simulation time, for the slow turn
   */
  function update(dt, rLaid, sim) {
    const F = targetFraming(rLaid);
    framed += (F - framed) * Math.min(1, dt * FRAMING.EASE);
    const k = smoothstep(FRAMING.F_MIN, FRAMING.F_MAX, framed);   // 0 at the close-up, 1 when wide

    // The slow turn: the prototype used sim × AZ_DRIFT, which snapped the view round by ~9° on
    // Finish and ~13° on Replay. Summing normal steps only gives the same turn in normal play.
    const step = sim - lastSim;
    lastSim = sim;
    if (step > 0 && step <= FRAMING.DRIFT_MAX_STEP) driftSim += step;
    const turn = drift ? driftSim * FRAMING.AZ_DRIFT : 0;

    const el = clamp(FRAMING.EL0 + FRAMING.EL_GAIN * k + userEl, FRAMING.EL_MIN, FRAMING.EL_MAX);
    const az = FRAMING.AZ0 + FRAMING.AZ_GAIN * k + userAz + turn;

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
    /**
     * Jumps the framing to what `rLaid` asks for, with no easing. For reduced motion: the
     * finished panel is shown at once, so the camera should not fly out to it either.
     */
    snap(rLaid) { framed = targetFraming(rLaid); },
    /**
     * Sets the slow turn as if the laying had played normally up to `sim` (the prototype's
     * sim × AZ_DRIFT). Only for the window.__seek dev aid, so scripts/compare-port.mjs, which
     * seeks both pages, still sees the prototype's camera.
     */
    syncDrift(sim) { driftSim = lastSim = sim; },
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
