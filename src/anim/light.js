// The sun: where it sits, the light sweep that makes the gold glint, and the size of its
// shadow box.
//
// Shadow depth, in one paragraph. A shadow map stores, for each texel, how far the nearest
// thing is from the sun; a point is in shadow when it is farther than that. `shadow.bias`
// nudges the comparison so a surface does not shadow itself ("acne"), and three.js measures it
// in the shadow camera's normalised depth (0 at near, 1 at far). So the same bias number means
// more world distance the deeper the box is. The prototype's -0.0006 over near 1 / far 320 was
// ~0.19 world units: half a piece's height, enough to detach every piece's shadow from its base
// (capture/pieces/shadow-bias-proto-vs-tight.png). Here near/far hug the area on screen and the
// bias is set in WORLD units, so it means the same thing at every framing.
//
// At rest the sun hangs high in one direction. A sweep orbits it once around the panel over
// 11 seconds (eased in and out). Its height follows a tilted circle aimed at the viewer: the
// prototype's 27° dip while it passes the viewer's side (raking light, long shadows), and an
// aimed height while it passes behind the panel, where its reflection can reach the camera.
//
// Why aim it: a flat polished top shows the sun only when the sun sits where the viewer's line
// of sight would bounce to: opposite the viewer, at the viewer's elevation. Each point on screen
// has its own such mirror height: lowest at the far edge (it sees the camera at the flattest
// angle), highest at the near edge.
//
// Why NOT at the mirror: the glaze is satin (roughness up to 0.35), so its sun reflection is a
// broad lobe, ~20° each way. Wherever the sun comes that close to a point's mirror direction,
// the glaze there turns pastel, as much as the gold. So behind the panel the sun keeps
// GLAZE_CLEARANCE (≈29°) away from the whole band of mirror heights on screen:
//   - below it (far edge's mirror height − clearance), raking light. At the finished framing
//     that is under the 27° dip, so the sun passes at the dip itself: the prototype's own sweep
//     there. Overhead it can pass higher (~41°), nearer the gold's mirror;
//   - above it (near edge's mirror height + clearance) when below would mean sinking under the
//     dip: a low view (the opening close-up, a low drag), passing at ~60-70°;
//   - with the camera between ~45° and ~58° neither fits between the dip and HIGH_MAX (83°):
//     the sun takes the side with more room (in practice the dip) and some glaze there washes
//     (measured below). The dip and HIGH_MAX are hard limits: under the dip the sun heads for the
//     horizon and darkens the scene.
// "On screen" reaches past `reach` (the framed radius × zoom that main.js passes): a tilted view
// sees ground farther out at the top of the screen, and a landscape screen more to the sides.
// Zoomed in at 1280×800 the top corners of the screen see ~1.9× `reach` out; at the finished
// framing the panel's own far corner is on screen; a low view shows the whole panel, its near
// corner ~1.25× out. SCREEN_FAR and SCREEN_NEAR stretch `reach` by that, capped at the panel's
// corners. It is an estimate from the camera's position alone: a low or portrait view zoomed
// right in sees farther still, so it keeps less than the full clearance (tests/light-aim.test.mjs
// measures what each view keeps, angle by angle, over the glaze on screen).
//
// Re-aimed every frame, from where the camera is NOW. The aim used to be chosen once, when the
// sweep started. After a click on Finish the automatic sweep starts while the camera is still
// flying out of the low close-up, so it chose "above"; once the camera settled at 65° the sun
// passed behind at 83°, 2-3° from the near edge's mirror height, and for ~2 s the near third of
// the panel turned pastel (50,284 glaze px washed, capture/review/DEFECT-finish-path-wash.png).
// A drag across a low/high view mid-sweep kept the wrong side the same way (and its height,
// re-read every frame without smoothing, could jump 3-8° in a frame). The aim now follows its
// target through a critically damped spring (AIM_SMOOTH), so when the side changes the sun
// glides there (a full change in ~0.7 s, at most ~2° per frame, about the sweep's own speed).
//
// The gold still flashes because its pieces are faceted (scene/pieces.js FACET_GOLD): each gold
// top face points up to ~25° away from flat, so as the sun moves, piece after piece swings
// through its own mirror angle and flashes, even 30-50° from the flat mirror, while the flat
// glaze stays saturated.
//
// Measured with real input and normal motion at 1280×800 unless noted, with the probe of
// scripts/verify-app.mjs glint-motion (which runs the Finish rows; capture/glint-motion/
// measure-paths.mjs.txt runs them all): gold and glaze told apart by a mask render, each frame
// compared with the same frame drawn with the sun at rest, "flash" = gold pixels ≥40 luma
// brighter, "wash" = glaze pixels that lost ≥0.15 saturation. Peak flash px / worst wash px:
//                                         aim chosen once        re-aimed (this; 2-3 runs)
//   Finish click → automatic sweep        1,263 / 50,284         ~1,900-2,000 / ~2,500-2,900
//   natural ending at 1× (automatic)      1,987 / 4,822          ~1,900 / ~2,400
//   Sweep light, finished view            1,978 / 5,343          ~1,900 / ~2,850-2,950
//   Sweep light, dragged overhead         1,519 / 1,100          ~1,340 / ~310
//   Sweep light, dragged low (31°)          832 / 9,123            ~720 / ~1,400-1,450
//   Sweep light, zoomed in (wheel)        3,681 / 15,830         ~3,500 / ~9,200-10,550
//   ... zoomed right in (wheel limit)     3,738 / 34,034         ~3,100 / ~22,600 (held at the dip)
//   phone 390×844 (×2), Finish tap        2,094 / 9,592          ~2,000 / ~1,550-1,650
//   Sweep light, camera at 52° (the gap)    944 / 24,354         ~2,360 / ~21,400
//   drag to the low view mid-sweep        2,656 / 33,847         ~1,200 / ~13,700-16,900 (while dragging)
//   drag to overhead mid-sweep            1,239 / 45,149         ~1,360 / ~4,800 (while dragging)
// (The last three rows' left column: the old rule run through a temporary test hook. Zoomed
// right in, the far glaze on screen mirrors at ~44°, so even the dip keeps only ~18° from it.) Also
// measured: the prototype's sweep (27° all round, ignoring the viewer) washes a low view (34,584)
// and flashes less overhead (1,111); choosing the side once, from where the camera will settle
// rather than where it is, fixes Finish (2,050 / 5,246) but not a drag mid-sweep.

import { PANEL } from '../config.js';

const TAU = Math.PI * 2;

/** Tunables owned by this module. */
export const SUN = {
  REST_ANGLE: -0.75,    // azimuth at rest (radians)
  REST_SLOPE: 1.25,     // height/run at rest (atan 1.25 ≈ 51°)
  SWEEP_DIP: 0.75,      // the prototype's sweep: the slope drops by this mid-sweep (to 0.5, ≈ 27°)
  GLAZE_CLEARANCE: 0.5, // behind the panel the sun keeps this far (radians, ≈29°) from the glaze's mirror band
  HIGH_MAX: 1.45,       // ... and no higher than this when it passes above the band (≈83°)
  SCREEN_FAR: 1.9,      // the glaze on screen reaches up to this many times `reach` out on the far side ...
  SCREEN_NEAR: 1.25,    // ... and on the near side (both capped at the panel's corners; see the note at the top)
  AIM_SMOOTH: 0.35,     // seconds: how quickly the sweep's height follows a view that moves mid-sweep
  SWEEP_SECONDS: 11,
  DISTANCE: 100,
  SHADOW_PER_F: 1.5, SHADOW_PAD: 3, SHADOW_MAX: 70,   // shadow box half-size from the framing
  SHADOW_MIN_SIN: 0.15,   // depth fit: never assume the sun lower than ~8.6° (keeps the box finite)
  SHADOW_DEPTH_PAD: 10,   // + room above the bed for falling pieces and the curb
  SHADOW_BIAS_WORLD: 0.01, // depth bias in world units (a hundredth of a tessera)
};

/** The prototype's dip (≈ 26.6°): a sweep never takes the sun lower than this. */
export const SWEEP_FLOOR = Math.atan(SUN.REST_SLOPE - SUN.SWEEP_DIP);

/** The prototype's fixed shadow depth, kept for the ?legacy=1 reference build only. */
const PROTOTYPE_SHADOW = { near: 1, far: 320, bias: -0.0006 };

const CORNER = PANEL.BORDER * Math.SQRT2;   // the panel's corners, from its centre

/**
 * Where a sweep passes behind the panel, for one view: the sun's height (radians) at the
 * moment it faces the viewer from the far side. Pure; light.update() calls it every frame.
 * @param view   the camera's position (it looks at the panel's centre)
 * @param reach  the framed radius × the viewer's zoom (main.js); the glaze on screen reaches
 *               SCREEN_FAR / SCREEN_NEAR times that out, capped at the panel's corners
 * @returns { height, side: 'below' | 'above', clearance, far, near }: `far` / `near` are the
 *   mirror heights of the far and near edge of the glaze on screen, `clearance` how far
 *   `height` stays outside that band (GLAZE_CLEARANCE whenever either side has room for it)
 */
export function sweepAim(view, reach) {
  const horiz = Math.hypot(view.x, view.z);
  const rFar = Math.min(reach * SUN.SCREEN_FAR, CORNER), rNear = Math.min(reach * SUN.SCREEN_NEAR, CORNER);
  // When the camera stands over the panel the near edge is behind its foot: that mirror height
  // is past the zenith (> 90°), and the sun cannot pass above the band at all
  const far = Math.atan2(view.y, horiz + rFar), near = Math.atan2(view.y, horiz - rNear);
  const C = SUN.GLAZE_CLEARANCE;
  if (far - C >= SWEEP_FLOOR) return { height: far - C, side: 'below', clearance: C, far, near };
  if (near + C <= SUN.HIGH_MAX) return { height: near + C, side: 'above', clearance: C, far, near };
  // Neither side has the full clearance within the floor and HIGH_MAX: take the side with more
  const below = far - SWEEP_FLOOR, above = SUN.HIGH_MAX - near;
  return below >= above
    ? { height: SWEEP_FLOOR, side: 'below', clearance: below, far, near }
    : { height: SUN.HIGH_MAX, side: 'above', clearance: above, far, near };
}

/**
 * One step of a critically damped spring: moves `x` (moving at `v`) toward `target`, getting
 * there in about `smooth` seconds without overshooting it. Stable for any step `dt`.
 * @returns [x, v] after the step
 */
function smoothDamp(x, v, target, smooth, dt) {
  const w = 2 / smooth, k = w * dt, decay = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
  const off = x - target, pull = (v + w * off) * dt;
  return [target + (off + pull) * decay, (v - w * pull) * decay];
}

/**
 * @param sun THREE.DirectionalLight (its target must be in the scene)
 * @param opts.prototypeShadow  true: keep the prototype's fixed near/far/bias (the legacy
 *   build, so it stays a faithful reference of the prototype's picture)
 */
export function createLightRig(sun, { prototypeShadow = false } = {}) {
  let sweepStart = -1;   // clock time the current sweep starts; -1 = none
  let aim = null;        // the sweep's height behind the panel (radians), smoothed; null = not aimed yet
  let aimRate = 0;       // ... and how fast it is changing (radians per second)
  let last = 0;          // clock time of the previous update
  let elev = Math.atan(SUN.REST_SLOPE);   // the sun's current elevation (radians)

  /**
   * Places the sun for wall-clock time `now` (seconds).
   * @param view   the camera's position: the sweep's height behind the panel is aimed from the
   *               view of THIS frame (see the note at the top). Without it the sweep is the
   *               prototype's (dipping to ≈27° all round), as the ?legacy=1 build uses.
   * @param reach  how far from the centre the panel on screen reaches (world units: the framed
   *               radius × the viewer's zoom); see sweepAim
   */
  function update(now, view = null, reach = 0) {
    const dt = Math.max(0, now - last);
    last = now;
    let angle = SUN.REST_ANGLE;
    elev = Math.atan(SUN.REST_SLOPE);
    if (sweepStart >= 0 && now >= sweepStart) {
      const p = (now - sweepStart) / SUN.SWEEP_SECONDS;
      if (p >= 1) sweepStart = -1;
      else {
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;   // ease in-out quad
        angle += e * TAU;
        if (view) {
          // Aimed from this frame's view, so a camera still flying out (after Finish) or turned
          // mid-sweep is followed; the aim glides to a new target, so a change of side never jumps
          const target = sweepAim(view, reach).height;
          if (aim === null) { aim = target; aimRate = 0; }
          else {
            [aim, aimRate] = smoothDamp(aim, aimRate, target, SUN.AIM_SMOOTH, dt);
            if (aim < SWEEP_FLOOR || aim > SUN.HIGH_MAX) { aim = Math.min(SUN.HIGH_MAX, Math.max(SWEEP_FLOOR, aim)); aimRate = 0; }
          }
          // Tilted circle: the floor while the sun is on the viewer's side, `aim` when it faces
          // the viewer from behind the panel (azimuths half a turn apart)
          const facing = (1 - Math.cos(angle - Math.atan2(view.z, view.x))) / 2;
          const orbit = SWEEP_FLOOR + (aim - SWEEP_FLOOR) * facing;
          // Leave rest and come back to it smoothly
          elev += (orbit - elev) * Math.sin(Math.PI * p);
        } else {
          elev = Math.atan(SUN.REST_SLOPE - SUN.SWEEP_DIP * Math.sin(Math.PI * p));   // the prototype's dip
        }
      }
    }
    const R = SUN.DISTANCE;
    sun.position.set(Math.cos(angle) * R * Math.cos(elev), Math.sin(elev) * R, Math.sin(angle) * R * Math.cos(elev));
    sun.target.position.set(0, 0, 0);
  }

  /**
   * Fits the shadow camera to what is on screen: tight at the close-up so shadows stay
   * sharp, wide when the whole panel is in view. Call after update(), which sets the
   * elevation the depth range depends on.
   *
   * Across: a square ±S around the centre, from the camera's framing.
   * Along the light: the flat bed seen from a sun at elevation e stretches out in depth: a
   * box ±S across holds bed up to S / sin(e) away along the light, plus room for what stands
   * above the bed. near/far bracket exactly that around the sun's distance.
   * @returns true when the box changed (the shadow map must be redrawn)
   */
  function fitShadow(framed, zoom) {
    const sc = sun.shadow.camera;
    const S = Math.min(SUN.SHADOW_MAX, framed * SUN.SHADOW_PER_F + SUN.SHADOW_PAD) * Math.max(1, zoom);
    let near, far;
    if (prototypeShadow) {
      ({ near, far } = PROTOTYPE_SHADOW);
      sun.shadow.bias = PROTOTYPE_SHADOW.bias;
    } else {
      const depth = S / Math.max(Math.sin(elev), SUN.SHADOW_MIN_SIN) + SUN.SHADOW_DEPTH_PAD;
      near = SUN.DISTANCE - depth; far = SUN.DISTANCE + depth;      // near may be < 0: fine for an orthographic camera
      sun.shadow.bias = -SUN.SHADOW_BIAS_WORLD / (far - near);     // world units → normalised depth
    }
    // Only rebuild the projection when the box moved noticeably
    if (Math.abs(sc.right - S) > 0.05 || Math.abs(sc.far - far) > 0.05) {
      sc.left = -S; sc.right = S; sc.top = S; sc.bottom = -S;
      sc.near = near; sc.far = far;
      sc.updateProjectionMatrix();
      return true;
    }
    return false;
  }

  return {
    update,
    fitShadow,
    /**
     * Starts a sweep at clock time `at` (now, or a little later). One already under way is left
     * to finish: starting over would snap the sun back to rest mid-sweep (Sweep light pressed
     * twice, or the automatic sweep after Finish arriving during one).
     */
    sweep(at) {
      if (sweepStart >= 0 && last >= sweepStart) return;
      sweepStart = at; aim = null; aimRate = 0;
    },
    cancel() { sweepStart = -1; },
    get sweeping() { return sweepStart >= 0; },
  };
}
