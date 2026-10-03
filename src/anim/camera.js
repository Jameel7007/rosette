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
  // The near clip plane, as a fraction of the camera's distance from the centre. The depth
  // buffer's precision is set by the near plane: a step of about distance² / (near · 2²⁴). With
  // the old fixed near of 0.1, at ~450 units away (a portrait screen zoomed out, or a vertical
  // video's end view) that step was ~0.12, the same size as the float rounding in the vertex
  // maths, against piece tops only ~0.3 above the bed. The bed is drawn after the pieces and
  // wins a depth tie, so on some frames it painted cream streaks over whole areas of pieces.
  // At distance/100 the step there is ~0.003. Nothing on screen is ever nearer the camera than
  // about 0.4 × its distance (the bed's near edge at the lowest view), so nothing is clipped.
  NEAR_PER_DISTANCE: 0.01,
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

// --- Video export only ---------------------------------------------------------------------
//
// The live end view crops the panel's corners (most on a phone: the framing fits a circle of
// radius F_MAX = 57 while the corners are 52·√2 ≈ 73.5 out). A video should end on the whole
// panel. So an export camera (createCameraRig with `fit`) takes the live path and, during the
// last part of the pull-back, eases into the distance at which all four corners are in frame
// for the video's aspect. The live camera never uses it.

/** Tunables of the export fit. */
export const EXPORT_FIT = {
  HALF: 52,      // the panel's half-width, border included (config.js PANEL.BORDER)
  MARGIN: 0.06,  // keep the corners this fraction of the half-frame inside the edge
  // The wooden curb around the bed: its outer top corners must be in frame too (they touched the
  // left edge and were cut off at the right of the vertical video's last frame). Outer half-width
  // PANEL.EXT/2 + BED.CURB.thickness = 57 + 2.2, top at 0.1 + 1.4/2 (scene/bed.js); just inside.
  CURB_HALF: 59.2, CURB_TOP: 0.8, CURB_MARGIN: 0.01,
  FROM: 30,      // start easing into the fit once the framed radius passes this ...
  // ... and be fully fitted at FRAMING.F_MAX. Between, the extra distance blends in along a
  // smoothstep of the framed radius, which itself eases smoothly: no jump, no kink.
  SOFT: 0.04,    // softness of "never closer than the live path" (a smooth max, see update)
};

/**
 * How far from the centre a camera looking at it from (el, az) must stand so that a square of
 * corners (±half, y, ±half) is inside the frame, `margin` from its edges. By default the whole
 * finished panel (y = 0).
 *
 * For a camera at distance d along the unit vector u, looking at the origin, a point p sits at
 * depth d − p·u, and at p·r across and p·v up (r, v: the camera's right and up vectors, the
 * ones three's lookAt builds with world up +y). It is inside the frame when its offset is under
 * depth × tan(half field of view) on both axes; solving for d gives one bound per corner.
 * @returns distance in world units
 */
export function fitDistance(el, az, fovDeg, aspect, { half = EXPORT_FIT.HALF, margin = EXPORT_FIT.MARGIN, y = 0 } = {}) {
  const tanV = Math.tan(fovDeg * Math.PI / 360) * (1 - margin), tanH = tanV * aspect;
  const ce = Math.cos(el), se = Math.sin(el), ca = Math.cos(az), sa = Math.sin(az);
  const u = [ce * sa, se, ce * ca];          // from the centre towards the camera
  const r = [ca, 0, -sa];                    // screen right
  const v = [-se * sa, ce, -se * ca];        // screen up
  let d = 0;
  for (const [x, z] of [[half, half], [half, -half], [-half, half], [-half, -half]]) {
    const pu = x * u[0] + y * u[1] + z * u[2], pr = x * r[0] + z * r[2], pv = x * v[0] + y * v[1] + z * v[2];
    d = Math.max(d, pu + Math.abs(pr) / tanH, pu + Math.abs(pv) / tanV);
  }
  return d;
}

/**
 * @param camera THREE.PerspectiveCamera
 * @param canvas the element that receives pointer and wheel input
 * @param opts.drift  false: no slow automatic turn (reduced motion: the finished panel holds still)
 * @param opts.input  false: no pointer or wheel input at all (a video export's camera)
 * @param opts.fit    true: ease into fitting the whole finished panel at the end (export only;
 *                    see EXPORT_FIT)
 */
export function createCameraRig(camera, canvas, { drift = true, input = true, fit = false } = {}) {
  let framed = FRAMING.F_MIN;      // eased framed radius ("Fs" in the prototype)
  let userAz = 0, userEl = 0, userZoom = 1;
  let driftSim = 0, lastSim = 0;   // laying time turned through so far (see DRIFT_MAX_STEP)
  let fitScale = 1;                // export fit: how much further back than the live path (1 = live)

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

  if (input) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', resetView);
  }

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

    if (fit) {
      // Export only: how much further back the whole finished panel needs to be in frame. A
      // smooth max with 1 (never closer than the live path), blended in from FROM to F_MAX.
      const need = Math.max(
        fitDistance(el, az, camera.fov, camera.aspect),
        fitDistance(el, az, camera.fov, camera.aspect, { half: EXPORT_FIT.CURB_HALF, y: EXPORT_FIT.CURB_TOP, margin: EXPORT_FIT.CURB_MARGIN }),
      ) / d;
      const atLeastLive = (need + 1 + Math.sqrt((need - 1) ** 2 + EXPORT_FIT.SOFT ** 2)) / 2;
      fitScale = 1 + smoothstep(EXPORT_FIT.FROM, FRAMING.F_MAX, framed) * (atLeastLive - 1);
      d *= fitScale;
    }

    camera.position.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
    camera.lookAt(0, 0, 0);
    // The depth range follows the distance, so the depth buffer stays fine enough to separate
    // the pieces from the bed at any zoom (see FRAMING.NEAR_PER_DISTANCE)
    const near = d * FRAMING.NEAR_PER_DISTANCE;
    if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
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
    /**
     * How much further back than the automatic path the camera stands (1 = on the path): the
     * viewer's zoom, times the export fit (always 1 for the live camera). The fog, the shadow
     * box and the sweep's aim all scale with it, so they cover what is on screen.
     */
    get zoom() { return userZoom * fitScale; },
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
