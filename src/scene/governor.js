// The performance guard (brief §5, P2): watches the frame rate and turns the pixel ratio down
// a step when a machine cannot hold ~60 fps, and back up when it has room to spare.
//
// Why the pixel ratio and nothing else: a frame's cost here is almost all per pixel (the 4×
// multisampled edges of ten thousand bevelled pieces). Halving the shadow map measured no
// gain; 1.5 instead of 2 device pixels per CSS pixel took a 1920×1080 frame from 15 to 11 ms.
//
// How it decides, in plain words: it keeps the last WINDOW frame intervals. If their average
// stays above SLOW_MS (under ~57 fps) for DOWN_AFTER seconds, it lowers the ratio by STEP (never
// under MIN_RATIO). If it stays under FAST_MS (over ~83 fps, only possible on a high refresh
// display) for UP_AFTER seconds, it raises it again, up to the ceiling, but not back to a
// ratio that already proved too slow (otherwise it would see-saw every few seconds); after
// FORGIVE_AFTER seconds of room to spare it forgets that and tries again (the slowness may
// have been another program). On a 60 Hz display frames cannot come faster than 16.7 ms, so
// there it only ever steps down.
//
// Cost: one add, one subtract and a comparison per frame. No three.js here: main.js passes in
// what to do when the ratio changes, and the tests drive it with made-up frame times.

export const GOVERNOR = {
  WINDOW: 30,          // frames averaged
  SLOW_MS: 17.5,       // average interval above this is "too slow" (≈ 57 fps)
  FAST_MS: 12,         // ... below this is "room to spare" (≈ 83 fps)
  DOWN_AFTER: 2,       // seconds of slow frames before stepping down
  UP_AFTER: 5,         // seconds of fast frames before stepping up
  FORGIVE_AFTER: 30,   // seconds of fast frames before a too-slow ratio may be tried again
  STEP: 0.25,          // pixel ratio step
  MIN_RATIO: 1,        // never below one device pixel per CSS pixel
  MAX_INTERVAL: 100,   // longer intervals (a hidden tab, a stall) are ignored, not averaged
};

/**
 * @param {object} o
 * @param {number} o.ceiling  the highest ratio to use (renderer.js pixelRatioCeiling)
 * @param {(ratio:number) => void} o.apply  called with the new ratio when it changes
 * @param {number} [o.min]
 */
export function createGovernor({ ceiling, apply, min = GOVERNOR.MIN_RATIO }) {
  let ratio = ceiling;
  let tooSlow = Infinity;           // lowest ratio that proved too slow (not tried again)
  const samples = new Float64Array(GOVERNOR.WINDOW);
  let count = 0, next = 0, sum = 0;
  let slowFor = 0, fastFor = 0;     // seconds

  const restart = () => { count = next = 0; sum = 0; slowFor = fastFor = 0; };
  const set = r => { ratio = r; restart(); apply(r); };

  return {
    /** Feed one frame interval (ms). */
    frame(ms) {
      if (!(ms > 0) || ms > GOVERNOR.MAX_INTERVAL) return;
      if (count === GOVERNOR.WINDOW) sum -= samples[next]; else count++;
      samples[next] = ms; sum += ms;
      next = (next + 1) % GOVERNOR.WINDOW;
      if (count < GOVERNOR.WINDOW) return;

      const mean = sum / count;
      if (mean > GOVERNOR.SLOW_MS) { slowFor += ms / 1000; fastFor = 0; }
      else if (mean < GOVERNOR.FAST_MS) { fastFor += ms / 1000; slowFor = 0; }
      else { slowFor = fastFor = 0; }

      if (slowFor >= GOVERNOR.DOWN_AFTER && ratio > min) {
        tooSlow = Math.min(tooSlow, ratio);
        set(Math.max(min, ratio - GOVERNOR.STEP));
      } else if (fastFor >= GOVERNOR.UP_AFTER) {
        if (fastFor >= GOVERNOR.FORGIVE_AFTER) tooSlow = Infinity;
        const up = Math.min(ceiling, ratio + GOVERNOR.STEP);
        if (up > ratio && up < tooSlow) set(up);
      }
    },
    /** A new ceiling (the window was resized): start over from it. */
    reset(newCeiling) {
      ceiling = newCeiling;
      tooSlow = Infinity;
      set(ceiling);
    },
    /** Do not judge the next frames (e.g. a pause for loading): start the window over. */
    restart,
    get ratio() { return ratio; },
  };
}
