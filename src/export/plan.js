// The video export's timeline and choices, as pure functions (no DOM, no three.js), so the
// tests can check frame counts and the encoder fallback without a browser.
//
// The timeline of an export, in video seconds (frame k is shown from k/60 to (k+1)/60):
//
//   0 ─── laying (T_END / speed) ───┤ 1.2 s pause ├─── light sweep, 11 s ───┤ 1.5 s hold ┤
//
// It is the live choreography: the laying runs `speed` times faster, but the pause and the
// sweep run on the wall clock in the live app (main.js `clock`), so they keep their real
// length at 2× too. The export's camera path is the live one plus a final fit (anim/camera.js).
//
// Why the frame count is computed rather than "whatever the loop produced": a file that should
// be smooth is judged against this plan (scripts/check-video.mjs asserts the exact count), so a
// dropped or doubled frame anywhere shows up as a failed check, not as a slightly odd file.

/** Frames per second of every export (Reels and TikTok both take 60). */
export const FPS = 60;

/** Output sizes in pixels (even, as H.264's 4:2:0 needs). Vertical is Reels and TikTok's 9:16. */
export const PRESETS = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};

/** Laying speeds an export offers (the sweep always runs at real speed). */
export const EXPORT_SPEEDS = [1, 2];

/** The live app's finale timings (main.js SWEEP_DELAY, anim/light.js SUN.SWEEP_SECONDS) plus the hold. */
export const TIMELINE = {
  SWEEP_DELAY: 1.2,     // seconds after the last piece lands before the sweep starts
  SWEEP_SECONDS: 11,    // one orbit of the sun
  HOLD: 1.5,            // the finished panel, still, before the file ends
};

/**
 * Video quality. Mosaic grout is high-frequency detail (a cream line about a pixel wide between
 * ten thousand pieces), and the outer field lays hundreds of pieces a second.
 *
 * Why a quantizer: given a bitrate, the hardware H.264 encoder (VideoToolbox here) spends a flat
 * ~50 kB on every frame, so the finished panel under the moving sun, where every pixel changes
 * and the detail is finest, got the worst picture. A constant quantizer (like ffmpeg's CRF)
 * spends what each frame needs. Encoders without a working quantizer mode (Safari has none;
 * Firefox accepts it and ignores it: export/record.js avcQuantizerWorks) and VP9 use a bitrate.
 *
 * Measured against the LOSSLESS encoder input (frames copied as VideoEncoder received them),
 * 1× exports in headless Chrome on an M2 Pro. RGB PSNR in dB, whole frame / centre quarter
 * (the mosaic), at the end of the laying (frame 2846) and on the last frame; size; the busiest
 * second's bitrate:
 *
 *   vertical   quantizer 26   33.4 / 29.0   33.3 / 28.9   109 MB   peak 26 Mbit/s
 *              quantizer 22   34.6 / 30.4   34.6 / 30.3   187 MB   peak 45 Mbit/s   chosen
 *              quantizer 20   34.9 / 30.8   34.9 / 30.7   232 MB   peak 57 Mbit/s
 *   square     quantizer 26   31.3 / 27.5   31.3 / 27.5   102 MB   peak 25 Mbit/s
 *              quantizer 22   32.7 / 28.9   32.6 / 28.9   170 MB   peak 42 Mbit/s   chosen
 *              quantizer 20   33.0 / 29.3   33.0 / 29.3   208 MB   peak 52 Mbit/s
 *   landscape  quantizer 26   34.0 / 28.9   33.9 / 28.9   113 MB   peak 28 Mbit/s
 *              quantizer 22   35.4 / 30.4   35.4 / 30.3   195 MB   peak 48 Mbit/s   chosen
 *              quantizer 20   35.9 / 30.8   35.8 / 30.8   242 MB   peak 62 Mbit/s
 *
 * (4:2:0 chroma alone caps the centre at about 33.4 dB, measured on the vertical end frame.) 22 gives +1.4 dB in the mosaic over 26;
 * 20 adds only +0.4 dB for a quarter more bytes, and landscape's busiest second then reaches
 * H.264 level 4.2 High's 62.5 Mbit/s. At 22 every preset stays under 200 MB at 1× (under the
 * 287 MB often quoted as TikTok's iPhone upload limit) and its peak inside level 4.2. (The first version used
 * 26 at ~215 MB: most of those bytes were the depth-buffer streaks and edge shimmer that
 * anim/camera.js NEAR_PER_DISTANCE removed, which the encoder had to code anew every frame.)
 *
 * Key frames: the picture "breathes" a little every 2 s, the P frames' small colour drift
 * resetting at each key frame (frame-to-frame change at key frames 1.35× their neighbours' at
 * 22, 1.56× at 26). A coarser quantizer for key frames was tried (+1, +2, +4): it evened their
 * PSNR with the neighbours but made the jump larger (1.49×, 1.45×, 1.54×), so key frames get the
 * same quantizer as the rest.
 */
export const VIDEO_QUALITY = {
  AVC_QUANTIZER: 22,
  KEY_SECONDS: 2,
  // H.264 High profile, level 4.2: 1080 lines at 60 fps is 489,600 macroblocks a second, over
  // level 4.1's 245,760. mediabunny's automatic codec string counts macroblocks per frame only,
  // so it asked the encoder for 4.1 ('avc1.640029') while VideoToolbox wrote 4.2 into the file.
  AVC_CODEC: 'avc1.64002a',
  // The bitrate where there is no quantizer, in bits per pixel per frame. H.264 0.3 (37.3 Mbit/s
  // at 1080×1920@60): Safari's encoder delivers under the bitrate it is asked for (9.5 of 14
  // Mbit/s for 1080×1080 at 0.2, with a smeared field). VP9 is the more efficient codec: at 0.2
  // its field stayed crisp. MediaRecorder (VP9 or VP8) uses the VP9 rate.
  BITS_PER_PIXEL: { avc: 0.3, vp9: 0.2 },
};

/** Video bitrate (bits per second) for a w × h export at FPS (the fallback when no quantizer). */
export function videoBitrate(width, height, codec = 'avc') {
  const bpp = VIDEO_QUALITY.BITS_PER_PIXEL[codec] ?? VIDEO_QUALITY.BITS_PER_PIXEL.vp9;
  return Math.round(width * height * FPS * bpp / 1e5) * 1e5;
}

/**
 * Audio: 48 kHz stereo, the rate both AAC and Opus encoders expect.
 *
 * AAC_PRIMING: an AAC encoder starts its output with "priming" (encoder delay) before the first
 * real sample, and WebCodecs does not say how much. Apple's encoder, which Chrome and Safari use
 * on macOS and iOS, adds 2112 samples, the usual AAC-LC delay. Uncorrected, every click in the file
 * was 44 ms late (the first click decoded at 1.4774 s instead of 1.4333 s). So the audio is handed
 * to the encoder starting 2112 samples before zero; the muxer writes an edit list that trims the
 * negative part, and players start at the first real sample. Apple's AVFoundation trimmed the
 * priming a second time (44 ms early) until the file also carried the AAC 'roll' sample group
 * (export/mp4.js adds it).
 *
 * OPUS_PRE_SKIP: Opus has a delay too (its "pre-skip", 312 samples from libopus, which Chrome and
 * Firefox use). In WebM it is declared in the codec header and players skip it. In MP4 ffmpeg read
 * it from the header, but AVFoundation did not: Firefox's MP4 with Opus played 6.5 ms (312
 * samples) late there. Starting the audio 312 samples early makes the muxer write an edit list,
 * as ffmpeg's own Opus MP4s have, and then both read it in sync (0.02 ms).
 *
 * Both are measured by scripts/check-video.mjs, with ffmpeg and with AVFoundation on macOS: an
 * encoder with another delay would show there.
 */
export const AUDIO = { SAMPLE_RATE: 48000, CHANNELS: 2, BITRATE: 192000, AAC_PRIMING: 2112, OPUS_PRE_SKIP: 312 };

/**
 * The frame-by-frame plan of one export.
 *
 * Each encoded frame advances the piece by exactly one step of 1/FPS: frame k shows the piece
 * after k + 1 steps, i.e. laying time (k + 1)·speed/FPS and wall-clock time (k + 1)/FPS. The
 * last piece lands (main.js: landed ≥ count) on the first frame whose laying time reaches T_END;
 * the sweep starts SWEEP_DELAY later on the wall clock, as the live loop schedules it. (The live
 * loop sums 1/60 per step in floating point, so the sum reaches sweepStart one frame late, on
 * frame round(sweepStart·60) rather than the one before: invisible, since the eased sweep is
 * still at 0 there, and frame counts and timestamps do not depend on it.)
 *
 * @param {object} o
 * @param {number} o.T_END  laying time at which the last piece has landed (tiles.T_END)
 * @param {number} [o.speed=1]
 * @param {number} [o.fps=FPS]
 * @returns {{ fps, speed, frames, duration, layEndFrame, layEnd, sweepStart, sweepEnd,
 *   simAt(k), clockAt(k) }}  times in video seconds; layEndFrame is the first frame showing
 *   every piece landed
 */
export function planExport({ T_END, speed = 1, fps = FPS, timeline = TIMELINE }) {
  if (!(T_END > 0)) throw new Error('planExport: T_END must be positive');
  if (!(speed > 0)) throw new Error('planExport: speed must be positive');
  // First k with (k + 1)·speed/fps ≥ T_END. The tiny epsilon keeps an exact multiple (only
  // possible in a test) on the frame the live loop's float sum would also land on.
  const layEndFrame = Math.max(0, Math.ceil(T_END * fps / speed - 1e-9) - 1);
  const stepsToLand = layEndFrame + 1;                 // steps taken when the last piece lands
  const sweepStart = stepsToLand / fps + timeline.SWEEP_DELAY;   // wall-clock (= video) time
  const sweepEnd = sweepStart + timeline.SWEEP_SECONDS;
  // Frame k shows wall-clock time (k + 1)/fps; the last frame shows the end of the hold.
  const frames = stepsToLand + Math.round((timeline.SWEEP_DELAY + timeline.SWEEP_SECONDS + timeline.HOLD) * fps);
  return {
    fps, speed, frames,
    duration: frames / fps,
    layEndFrame,
    layEnd: stepsToLand / fps,
    sweepStart, sweepEnd,
    simAt: k => (k + 1) * speed / fps,
    clockAt: k => (k + 1) / fps,
  };
}

/** "rosette-1080x1920-1x.mp4" */
export function exportFileName(preset, speed, ext) {
  const { width, height } = PRESETS[preset];
  return `rosette-${width}x${height}-${speed}x.${ext}`;
}

/**
 * Which encoder to use, from what the browser says it can do.
 *
 *   1. MP4, H.264 (+ AAC): what Instagram Reels and TikTok want;
 *   2. MP4, H.264 + Opus: with sound where there is no AAC encoder (Firefox). Before this, Firefox
 *      fell back to WebM/VP9 whenever Sound was on: its VP9 is a software encoder, measured ~7×
 *      slower than its hardware H.264 (418 s against 57 s for square 2×), and Instagram does not
 *      take WebM. Opus in MP4 keeps the fast encoder and the container; it plays in current
 *      browsers, ffmpeg and Apple's AVFoundation (checked on macOS). The panel says the sound is
 *      Opus, since some apps still expect AAC;
 *   3. WebM, VP9 (+ Opus): when H.264 cannot be encoded;
 *   4. MediaRecorder on canvas.captureStream (WebM): when WebCodecs is missing entirely. Still
 *      stepped frame by frame, but recorded in real time, so frames can be dropped.
 *
 * @param caps { webcodecs, avc, aac, vp9, opus, recorderMime }  recorderMime: a MediaRecorder
 *   type the browser supports, or null
 * @param {boolean} sound  an audio track is wanted
 * @returns {{ kind: 'webcodecs'|'mediarecorder', container: 'mp4'|'webm', video, audio, ext,
 *   realtime: boolean, label, caution } | null}  caution: a sentence for the panel, or ''
 */
export function pickEncoding(caps, sound) {
  if (caps.webcodecs) {
    if (caps.avc && (!sound || caps.aac)) {
      return { kind: 'webcodecs', container: 'mp4', video: 'avc', audio: sound ? 'aac' : null, ext: 'mp4', realtime: false,
        label: sound ? 'MP4 · H.264 + AAC' : 'MP4 · H.264', caution: '' };
    }
    if (caps.avc && sound && caps.opus) {
      return { kind: 'webcodecs', container: 'mp4', video: 'avc', audio: 'opus', ext: 'mp4', realtime: false,
        label: 'MP4 · H.264 + Opus',
        caution: 'This browser has no AAC encoder, so the sound is Opus. If an app will not take it, turn Sound off or export from Chrome or Safari.' };
    }
    if (caps.vp9 && (!sound || caps.opus)) {
      return { kind: 'webcodecs', container: 'webm', video: 'vp9', audio: sound ? 'opus' : null, ext: 'webm', realtime: false,
        label: sound ? 'WebM · VP9 + Opus' : 'WebM · VP9',
        caution: 'WebM: Instagram needs MP4. VP9 encoding can take several minutes.' };
    }
  }
  if (caps.recorderMime) {
    return { kind: 'mediarecorder', container: 'webm', video: null, audio: sound ? 'opus' : null, ext: 'webm', realtime: true,
      mime: caps.recorderMime, label: 'WebM · recorded in real time',
      caution: 'This browser has no WebCodecs, so frames may be dropped. Keep this tab in front.' };
  }
  return null;
}
