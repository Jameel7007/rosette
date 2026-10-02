// Landing clicks: a 50 ms burst of decaying noise through a band-pass filter at a random
// pitch, one per frame in which tiles land. Synthesised with WebAudio, so no audio files.
//
// Throttled to one click per 40 ms, and quieter as the count climbs, so the fast outer field
// becomes a soft patter instead of a roar. Off by default (browsers need a user gesture).

/** Tunables owned by this module. */
export const CLICK = {
  LENGTH: 0.05,        // seconds of noise
  DECAY_POW: 6,        // envelope (1 - t)^6: a sharp tick
  MIN_GAP: 0.04,       // seconds between clicks
  FREQ: 1800, FREQ_SPREAD: 2200, Q: 2.5,
  GAIN: 0.18, GAIN_PER_TILE: 0.04, GAIN_MAX: 0.5,
  FADE_AFTER: 60, FADE_OVER: 900,   // after 60 tiles, gain falls as 1 / (1 + (n - 60) / 900)
};

export function createClicks() {
  let actx = null, noise = null, on = false, lastClick = 0;

  function init() {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    const n = Math.floor(actx.sampleRate * CLICK.LENGTH);
    noise = actx.createBuffer(1, n, actx.sampleRate);
    const ch = noise.getChannelData(0);
    // Math.random is fine here: the sound is not part of the reproducible picture
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, CLICK.DECAY_POW);
  }

  /**
   * One click for this frame.
   * @param k      tiles that landed this frame (more tiles, a slightly louder click)
   * @param landed tiles landed so far
   */
  function tick(k, landed) {
    if (!on || !actx) return;
    const t = actx.currentTime;
    if (t - lastClick < CLICK.MIN_GAP) return;
    lastClick = t;
    const src = actx.createBufferSource();
    src.buffer = noise;
    const f = actx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = CLICK.FREQ + Math.random() * CLICK.FREQ_SPREAD;
    f.Q.value = CLICK.Q;
    const g = actx.createGain();
    g.gain.value = Math.min(CLICK.GAIN_MAX, CLICK.GAIN + CLICK.GAIN_PER_TILE * k)
      / (1 + Math.max(0, landed - CLICK.FADE_AFTER) / CLICK.FADE_OVER);
    src.connect(f); f.connect(g); g.connect(actx.destination);
    src.start(t);
  }

  return {
    tick,
    get on() { return on; },
    /** Flips sound on/off; must run inside a user gesture the first time. Returns the new state. */
    toggle() {
      on = !on;
      if (on) { init(); if (actx) actx.resume(); }
      return on;
    },
  };
}
