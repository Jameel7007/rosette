// The export's sound: the live landing clicks (audio/clicks.js), rendered offline into one
// AudioBuffer that becomes the file's audio track.
//
// Why not record the live clicks: they are played as the frames are drawn, and an export draws
// frames as fast as the encoder takes them (faster or slower than real time), so the sound would
// drift off the picture. Here every click is placed at the exact video time its piece is seen to
// land, from the schedule alone, and an OfflineAudioContext renders the mix as fast as it can.
//
// The sound is the live one: a 50 ms burst of decaying noise through a band-pass at a random
// pitch; at most one click per frame (more pieces landing in that frame, a louder click);
// throttled to one per 40 ms; quieter as the count climbs. The only change is where randomness
// comes from: the live clicks use Math.random, the export uses the seeded stream('audio')
// (util/rand.js), so the same export always has the same sound.
//
// clickEvents is pure (Node tests run it); renderClickTrack needs a browser.

import { CLICK } from '../audio/clicks.js';
import { stream } from '../util/rand.js';
import { AUDIO } from './plan.js';

/**
 * The video frame on which each piece is first seen landed.
 *
 * Frame k shows laying time (k + 1)·speed/fps (export/plan.js), and a piece has landed once
 * t0 + D ≤ laying time, so piece i is landed from frame ceil((t0 + D)·fps/speed) − 1 on.
 * @param {ArrayLike<number>} t0  start times, ascending (schedule.t0)
 * @param {number} D              drop duration (schedule.D)
 * @returns {Int32Array} the frame of each landing, ascending
 */
export function landingFrames(t0, D, speed, fps) {
  const out = new Int32Array(t0.length);
  for (let i = 0; i < t0.length; i++) out[i] = Math.max(0, Math.ceil((t0[i] + D) * fps / speed - 1e-9) - 1);
  return out;
}

/**
 * The click track as a list of events, following audio/clicks.js tick() rule for rule:
 * one candidate click per frame in which pieces land, skipped if under MIN_GAP after the last
 * click; its gain grows with the pieces landing in that frame and fades with the total landed.
 *
 * @param {Int32Array} frames  landingFrames(...)
 * @param {object} o
 * @param {number} o.fps
 * @param {() => number} o.rand  draws one number per click (its band-pass pitch)
 * @returns {{ t: number, k: number, landed: number, gain: number, freq: number }[]}
 *   t = video time (frame k starts at k / fps)
 */
export function clickEvents(frames, { fps, rand, click = CLICK }) {
  const events = [];
  let lastClick = -Infinity, landed = 0;
  for (let i = 0; i < frames.length;) {
    // Every piece landing on this frame: one candidate click, like one live frame's tick()
    const f = frames[i];
    let k = 0;
    while (i < frames.length && frames[i] === f) { k++; i++; }
    landed += k;
    const t = f / fps;
    if (t - lastClick < click.MIN_GAP) continue;
    lastClick = t;
    const gain = Math.min(click.GAIN_MAX, click.GAIN + click.GAIN_PER_TILE * k)
      / (1 + Math.max(0, landed - click.FADE_AFTER) / click.FADE_OVER);
    events.push({ t, k, landed, gain, freq: click.FREQ + rand() * click.FREQ_SPREAD });
  }
  return events;
}

/** Seconds between the offline render's pauses (renderClickTrack). */
const TRACK_WINDOW = 1;

/**
 * The whole click track for one export, rendered offline.
 * @param {object} o
 * @param {{ t0: ArrayLike<number>, D: number }} o.schedule
 * @param {number} o.speed
 * @param {number} o.fps
 * @param {number} o.duration  seconds (the video's length; the track is exactly as long)
 * @returns {Promise<{ buffer: AudioBuffer, events: object[] }>}
 */
export async function renderClickTrack({ schedule, speed, fps, duration, seed }) {
  const rate = AUDIO.SAMPLE_RATE;
  const ctx = new OfflineAudioContext(AUDIO.CHANNELS, Math.round(duration * rate), rate);
  const rand = stream('audio', seed);

  // The noise burst first (a fixed number of draws), then one pitch per click
  const n = Math.floor(rate * CLICK.LENGTH);
  const noise = ctx.createBuffer(1, n, rate);
  const ch = noise.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = (rand() * 2 - 1) * Math.pow(1 - i / n, CLICK.DECAY_POW);

  const events = clickEvents(landingFrames(schedule.t0, schedule.D, speed, fps), { fps, rand });

  /** One click: the live node chain, noise → band-pass → gain → out. */
  const addClick = e => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = e.freq;
    f.Q.value = CLICK.Q;
    const g = ctx.createGain();
    g.gain.value = e.gain;
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start(e.t);
  };

  // Clicks are added just in time: the render pauses every second and adds the clicks of the
  // second after next. With all ~860 chains created up front the renderer carried every one of
  // them through the whole minute: 7.7 s to render, against 0.65 s this way, and the samples are
  // identical (measured in headless Chrome). Firefox's OfflineAudioContext cannot pause
  // (no suspend()), so there every click is added up front: slower, same sound.
  let next = 0;
  const addUntil = t => { for (; next < events.length && events[next].t < t; next++) addClick(events[next]); };
  if (typeof ctx.suspend === 'function') {
    addUntil(2 * TRACK_WINDOW);
    for (let t = TRACK_WINDOW; t < duration; t += TRACK_WINDOW) {
      ctx.suspend(t).then(() => { addUntil(t + 2 * TRACK_WINDOW); ctx.resume(); });
    }
  } else {
    addUntil(Infinity);
  }
  return { buffer: await ctx.startRendering(), events };
}

/**
 * Cuts an AudioBuffer into consecutive one-second pieces, so the audio can be fed to the muxer
 * alongside the video instead of all at once (mediabunny interleaves tracks by time; handing it
 * a whole minute of audio before the first frame would make it hold that back anyway).
 */
export function* audioChunks(buffer, seconds = 1) {
  const step = Math.round(buffer.sampleRate * seconds);
  for (let start = 0; start < buffer.length; start += step) {
    const length = Math.min(step, buffer.length - start);
    const piece = new AudioBuffer({ length, sampleRate: buffer.sampleRate, numberOfChannels: buffer.numberOfChannels });
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      piece.copyToChannel(buffer.getChannelData(c).subarray(start, start + length), c);
    }
    yield { start: start / buffer.sampleRate, buffer: piece };
  }
}
