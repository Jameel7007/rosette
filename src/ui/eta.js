// The export panel's "time left", as a pure function of (time, frames done), so the tests can run it.

/**
 * Time left from the encoding rate of the last few seconds. Why not elapsed / done: the elapsed
 * time includes loading the fonts, rendering the sound and loading the encoder, and the first
 * frames (a close-up of a few pieces) encode much faster than the finished panel, so that guess
 * said 1:22 left when 0:31 remained in Chrome, and 2:30 for 6:53 in Firefox. The estimate is
 * only shown once there is enough to go on.
 */
export function createEta({ windowMs = 2500, minMs = 2000, minShare = 0.03 } = {}) {
  let samples = [], firstAt = null;
  return {
    reset() { samples = []; firstAt = null; },
    /** @returns seconds left, or NaN while there is not enough to go on */
    update(now, done, total) {
      firstAt ??= now;
      samples.push({ now, done });
      while (samples.length > 2 && now - samples[0].now > windowMs) samples.shift();
      const a = samples[0], b = samples.at(-1);
      if (now - firstAt < minMs || done / total < minShare || b.now <= a.now || b.done <= a.done) return NaN;
      return (total - done) / ((b.done - a.done) / ((b.now - a.now) / 1000));
    },
  };
}
