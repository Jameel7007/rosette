// Video export: renders the piece frame by frame at a fixed 1/60 s step and encodes every frame.
//
// Why frame-stepped and not a screen recording: a recording captures whatever the page manages to
// draw in real time, so a slow machine (or a busy moment, like the outer field laying hundreds of
// pieces a second) drops frames into the file. Here the clock is the frame counter: frame k is
// the piece after exactly k + 1 steps of 1/60 s, whatever the wall time, and the encoder is
// handed every frame with its own timestamp (k/60, lasting 1/60). A slow machine takes longer to
// export; the frames and their timing are the same.
//
// Pipeline per frame:
//   main.js step(1/60) renders into the WebGL canvas at the export size
//   → copied onto a 2D "frame" canvas (that canvas is also the on-screen preview)
//   → the overlay is drawn over it (title and counter, export/overlay.js)
//   → mediabunny's CanvasSource snapshots it as a VideoFrame and encodes it with WebCodecs
//   → MP4 (H.264 + AAC or Opus) or WebM (VP9 + Opus), muxed into memory (BufferTarget).
// The sound is rendered offline beforehand (export/audio.js) and fed to the muxer one second
// at a time alongside the video.
//
// Backpressure: `await video.add(...)` resolves only when the encoder can take more, so at most
// a handful of frames are ever queued, never thousands; CanvasSource closes each VideoFrame
// it creates once encoded.
//
// A lost WebGL context (a phone reclaiming GPU memory, a GPU reset) blanks the canvas. A frame
// copied then would freeze the picture in the file while the counter ran on, so every frame is
// checked: on a loss the export waits for the context to come back and draws the same moment
// again (the piece is not stepped twice), or gives up with a clear message.
//
// mediabunny is loaded on demand (dynamic import of export/mediabunny.js), so the live piece's
// startup does not carry it.

import { FPS, PRESETS, AUDIO, VIDEO_QUALITY, planExport, videoBitrate, exportFileName, pickEncoding } from './plan.js';
import { renderClickTrack, audioChunks } from './audio.js';
import { createOverlay, loadOverlayFonts } from './overlay.js';
import { withAacRollGroup } from './mp4.js';

const loadMediabunny = () => import('./mediabunny.js');

const params = new URLSearchParams(location.search);
/** Dev override for scripts: ?encoder=webm or ?encoder=mediarecorder forces a fallback path. */
const FORCE = params.get('encoder');
/** Dev overrides for scripts/record.mjs --mbps / --qp (quality measurements, plan.js
 *  VIDEO_QUALITY): ?exportMbps=N encodes at N Mbit/s with no quantizer; ?exportQp=N uses quantizer
 *  N for H.264. */
const FORCE_MBPS = +params.get('exportMbps') || 0;
const FORCE_QP = +params.get('exportQp') || 0;

/** MediaRecorder types, best first (Firefox records VP8 only). */
const RECORDER_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

/** How long an export waits for a lost WebGL context to come back before giving up. */
const GPU_WAIT_MS = 15000;

/** The bitrate (bits per second) for a preset and codec: VP9's and MediaRecorder's, and H.264's where there is no quantizer. */
export function bitrateFor(preset, codec) {
  const { width, height } = PRESETS[preset];
  return FORCE_MBPS ? FORCE_MBPS * 1e6 : videoBitrate(width, height, codec);
}

let quantizerCheck = null;
/**
 * Does this browser's H.264 encoder honour a per-frame quantizer? Asking isConfigSupported is not
 * enough: Firefox 155 says yes and then ignores the value (quantizer 26 and 40 both gave 13.3
 * Mbit/s), so its exports came out at 8 Mbit/s, soft, without ever using the bitrate fallback.
 * So this encodes one small frame of fine detail at quantizer 22 and at 40. Measured on that
 * frame: Chrome 57.9 kB against 17.0 kB, Firefox 45.9 kB for both. (Quantizer 10 made Chrome's
 * VideoToolbox encoder fail outright, so the probe stays in the normal range.) Asked once per page.
 * @returns {Promise<boolean>}
 */
export function avcQuantizerWorks() {
  quantizerCheck ??= probeQuantizer().catch(() => false);   // no quantizer mode at all (Safari): the bitrate it is
  return quantizerCheck;
}

async function probeQuantizer() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return false;
  const size = 256;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  // A fixed pseudo-random pattern: grain-like detail that a coarse quantizer visibly throws away
  for (let i = 0, s = 1; i < img.data.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    img.data[i] = i % 4 === 3 ? 255 : s >>> 24;
  }
  g.putImageData(img, 0, 0);
  const encodedBytes = async quantizer => {
    let bytes = 0, failed = null;
    const encoder = new VideoEncoder({ output: chunk => { bytes += chunk.byteLength; }, error: e => { failed = e; } });
    try {
      encoder.configure({ codec: 'avc1.64001f', width: size, height: size, bitrateMode: 'quantizer', framerate: FPS });
      const frame = new VideoFrame(canvas, { timestamp: 0 });
      encoder.encode(frame, { keyFrame: true, avc: { quantizer } });
      frame.close();
      await encoder.flush();
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }
    if (failed) throw failed;
    return bytes;
  };
  const fine = await encodedBytes(22), coarse = await encodedBytes(40);
  return fine > 1.5 * coarse;
}

/**
 * The mediabunny Quality for an export: H.264 at a constant quantizer where the encoder honours
 * one (plan.js VIDEO_QUALITY says why), otherwise, and for VP9, the bitrate.
 */
function videoQuality(mb, encoding, bitrate) {
  return encoding.quantizer ? new mb.Quality({ quantizer: encoding.quantizer, bitrate }) : new mb.Quality({ bitrate });
}

/**
 * What this browser can encode, as export/plan.js pickEncoding wants it, plus the H.264 details:
 * the quantizer this preset gets (null: bitrate) and the codec string the encoder accepted.
 * @returns {Promise<{ webcodecs, avc, aac, vp9, opus, recorderMime, quantizer, avcCodec }>}
 */
export async function probeCapabilities(preset) {
  const { width, height } = PRESETS[preset];
  const recorderMime = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    ? RECORDER_TYPES.find(t => MediaRecorder.isTypeSupported(t)) ?? null : null;
  const webcodecs = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  const caps = { webcodecs, avc: false, aac: false, vp9: false, opus: false, recorderMime, quantizer: null, avcCodec: null };
  if (webcodecs && FORCE !== 'mediarecorder') {
    const mb = await loadMediabunny();
    const quantizerOk = !FORCE_MBPS && await avcQuantizerWorks();
    caps.quantizer = quantizerOk ? FORCE_QP || VIDEO_QUALITY.AVC_QUANTIZER : null;
    // Asked with the exact settings the export will use (the quantizer, or else the bitrate)
    const video = codec => ({
      width, height, frameRate: FPS,
      quality: videoQuality(mb, { quantizer: codec === 'avc' ? caps.quantizer : null }, bitrateFor(preset, codec)),
    });
    const audio = { numberOfChannels: AUDIO.CHANNELS, sampleRate: AUDIO.SAMPLE_RATE, quality: new mb.Quality({ bitrate: AUDIO.BITRATE }) };
    const hasAudioEncoder = typeof AudioEncoder !== 'undefined';
    const avcWith = codecString => mb.canEncodeVideo('avc', { ...video('avc'), fullCodecString: codecString });
    let avcAuto;
    [caps.avcCodec, avcAuto, caps.vp9, caps.aac, caps.opus] = await Promise.all([
      FORCE === 'webm' ? null : avcWith(VIDEO_QUALITY.AVC_CODEC).then(ok => (ok ? VIDEO_QUALITY.AVC_CODEC : null), () => null),
      FORCE === 'webm' ? false : mb.canEncodeVideo('avc', video('avc')),
      mb.canEncodeVideo('vp9', video('vp9')),
      hasAudioEncoder && FORCE !== 'webm' ? mb.canEncodeAudio('aac', audio) : false,
      hasAudioEncoder ? mb.canEncodeAudio('opus', audio) : false,
    ]);
    // An encoder that refuses the explicit level still gets H.264 with mediabunny's own string
    caps.avc = !!caps.avcCodec || avcAuto;
  } else {
    caps.webcodecs = false;
  }
  return caps;
}

/** The encoder an export with these options will use (plan.js pickEncoding plus the H.264 details), or null. */
export async function chooseEncoding(preset, sound) {
  const caps = await probeCapabilities(preset);
  const encoding = pickEncoding(caps, sound);
  if (!encoding) return null;
  const avc = encoding.video === 'avc';
  return { ...encoding, quantizer: avc ? caps.quantizer : null, avcCodec: avc ? caps.avcCodec : null };
}

/** Lets the page breathe between frames: paint the preview, update the progress, take a click on Cancel. */
function yieldToPage() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  return new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

const abortError = () => new DOMException('The export was cancelled', 'AbortError');

/**
 * Waits for a lost WebGL context to be restored ('webglcontextrestored' on the canvas; three
 * and scene/renderer.js have re-uploaded and re-baked everything by the time our listener runs,
 * since theirs were registered first). Rejects on Cancel or after GPU_WAIT_MS.
 */
function contextRestored(canvas, signal) {
  return new Promise((resolve, reject) => {
    const finish = err => {
      clearTimeout(timer);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve();
    };
    const onRestored = () => finish();
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error('the graphics card was reset and did not come back. Reload the page and export again')), GPU_WAIT_MS);
    canvas.addEventListener('webglcontextrestored', onRestored);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Records one video.
 *
 * @param {object} o
 * @param o.host       what main.js lends the exporter: { T_END, count, schedule: { t0, D },
 *                     canvas, begin({ width, height, speed }), step(dt) → { landed },
 *                     redraw(), contextLost() → boolean, end() }
 * @param o.preset     'vertical' | 'square' | 'landscape' (plan.js PRESETS)
 * @param o.speed      1 | 2
 * @param o.overlay    burn in the title and counter
 * @param o.sound      add the click track
 * @param o.encoding   chooseEncoding(...) result
 * @param o.frameCanvas the canvas each finished frame is drawn on (also the on-screen preview)
 * @param o.signal     AbortSignal (Cancel)
 * @param o.onProgress ({ phase, done, total, elapsedMs }) → void
 * @returns {Promise<{ blob, fileName, bytes, frames, ms, encoding, lateFrames, webFonts, gpuResets }>}
 */
export async function recordVideo({ host, preset, speed, overlay, sound, encoding, frameCanvas, signal, onProgress = () => {} }) {
  const { width, height } = PRESETS[preset];
  const plan = planExport({ T_END: host.T_END, speed });
  const bitrate = bitrateFor(preset, encoding.video ?? 'vp9');   // MediaRecorder: the VP9 rate
  const started = performance.now();
  let done = 0;
  const progress = (phase, frames = done) => { done = frames; onProgress({ phase, done, total: plan.frames, elapsedMs: performance.now() - started }); };

  // Everything that can be prepared before the piece is taken over
  progress('prepare');
  // false: the web fonts were not ready in time, and the whole video uses the fallback fonts
  const webFonts = overlay ? await loadOverlayFonts() : true;
  let track = null;
  if (encoding.audio) {
    progress('sound');
    track = await renderClickTrack({ schedule: host.schedule, speed, fps: FPS, duration: plan.duration });
  }
  if (signal?.aborted) throw abortError();

  frameCanvas.width = width;
  frameCanvas.height = height;
  const ctx = frameCanvas.getContext('2d', { alpha: false });
  const painter = overlay ? createOverlay(ctx, { width, height, total: host.count, webFonts }) : null;

  let gpuResets = 0;
  /** One frame: step the piece, copy it onto the frame canvas, draw the overlay. */
  const drawFrame = async () => {
    let { landed } = host.step(1 / FPS);
    for (;;) {
      if (!host.contextLost()) {
        ctx.drawImage(host.canvas, 0, 0, width, height);
        if (!host.contextLost()) break;   // still there after the copy: the frame is good
      }
      // Lost: what is on the canvas is blank. Wait for the context, then draw the same moment
      gpuResets++;
      progress('gpu');
      await contextRestored(host.canvas, signal);
      ({ landed } = host.redraw());
      progress('encode');
    }
    painter?.draw(host.canvas, landed);
  };

  try {
    // Inside the try: if switching into export mode fails half way, end() still puts the page back
    host.begin({ width, height, speed });
    const run = encoding.kind === 'webcodecs' ? encodeWebCodecs : recordRealtime;
    const result = await run({ plan, encoding, bitrate, track, frameCanvas, drawFrame, signal, progress });
    return {
      ...result,
      fileName: exportFileName(preset, speed, encoding.ext),
      bytes: result.blob.size,
      frames: plan.frames,
      ms: Math.round(performance.now() - started),
      encoding, webFonts, gpuResets,
    };
  } finally {
    host.end();   // the live piece comes back exactly as it was, whether done, cancelled or failed
  }
}

/** WebCodecs through mediabunny: every frame encoded, none dropped, as fast as the machine allows. */
async function encodeWebCodecs({ plan, encoding, bitrate, track, frameCanvas, drawFrame, signal, progress }) {
  const mb = await loadMediabunny();
  const output = new mb.Output({
    // MP4 with its index at the front ("fast start"), so it plays while it downloads
    format: encoding.container === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat(),
    target: new mb.BufferTarget(),
  });
  const video = new mb.CanvasSource(frameCanvas, {
    codec: encoding.video,             // 'avc' is H.264 High profile in mediabunny
    quality: videoQuality(mb, encoding, bitrate),   // a constant quantizer for H.264 (plan.js VIDEO_QUALITY)
    keyFrameInterval: VIDEO_QUALITY.KEY_SECONDS,
    latencyMode: 'quality',            // the encoder may not drop frames to keep up
    ...(encoding.avcCodec ? { fullCodecString: encoding.avcCodec } : {}),   // High@4.2 (plan.js AVC_CODEC)
  });
  // frameRate: timestamps are snapped to a 1/60 s grid, so the file's frame times are exact
  output.addVideoTrack(video, { frameRate: plan.fps });
  let audio = null;
  if (track) {
    // The encoder's delay starts before zero, so the MP4 edit list trims it: AAC's priming, and in
    // MP4 Opus's pre-skip too (plan.js AUDIO says why). WebM carries the pre-skip in its header.
    const delay = encoding.audio === 'aac' ? AUDIO.AAC_PRIMING : encoding.container === 'mp4' ? AUDIO.OPUS_PRE_SKIP : 0;
    const startTimestamp = -delay / AUDIO.SAMPLE_RATE;
    audio = new mb.AudioBufferSource({ codec: encoding.audio, quality: new mb.Quality({ bitrate: AUDIO.BITRATE }) }, { startTimestamp });
    output.addAudioTrack(audio);
  }
  await output.start();

  const chunks = track ? audioChunks(track.buffer) : null;
  let next = chunks?.next();
  /** Audio up to `until` seconds of video time (fed alongside the frames, a second ahead). */
  const feedAudio = async until => {
    while (next && !next.done && next.value.start <= until) {
      await audio.add(next.value.buffer);
      next = chunks.next();
    }
  };

  try {
    let lastReport = 0;
    for (let k = 0; k < plan.frames; k++) {
      if (signal?.aborted) throw abortError();
      await drawFrame();
      await feedAudio(k / plan.fps + 1);
      // Frame k: shown from k/60 for exactly 1/60 s, whatever the wall clock did
      await video.add(k / plan.fps, 1 / plan.fps);
      const now = performance.now();
      if (now - lastReport > 100 || k === plan.frames - 1) { lastReport = now; progress('encode', k + 1); }
      await yieldToPage();
    }
    await feedAudio(Infinity);
    progress('finish', plan.frames);
    await output.finalize();
  } catch (err) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    throw err;
  }
  // The Blob holds its own copy of the bytes; the AAC fix-up (export/mp4.js) copies only the
  // small moov box and passes the media data through as a view. Dropping the target's reference
  // at once lets the in-memory file be freed as soon as the copy exists.
  const bytes = new Uint8Array(output.target.buffer);
  output.target.buffer = null;
  const parts = encoding.container === 'mp4' && encoding.audio === 'aac' ? withAacRollGroup(bytes) : [bytes];
  return { blob: new Blob(parts, { type: output.format.mimeType }), lateFrames: 0 };
}

/**
 * Last resort, when WebCodecs is missing: canvas.captureStream + MediaRecorder. MediaRecorder
 * stamps frames with the wall clock, so the piece is still stepped exactly 1/60 s per frame but
 * each frame has to be drawn on time; a frame drawn late is dropped or stretched, and the
 * recorder can drop frames on its own too. The UI says so, before and after.
 */
async function recordRealtime({ plan, encoding, bitrate, track, frameCanvas, drawFrame, signal, progress }) {
  // captureStream(0) + requestFrame(): one captured frame per drawn frame. captureStream(60)
  // samples the canvas on its own 60 Hz clock and discards a frame drawn a hair early: measured
  // 23 of 2,246 frames lost that way on a fast machine.
  let stream = frameCanvas.captureStream(0);
  let videoTrack = stream.getVideoTracks()[0];
  if (typeof videoTrack.requestFrame !== 'function') {
    stream.getTracks().forEach(t => t.stop());
    stream = frameCanvas.captureStream(plan.fps);
    videoTrack = null;
  }
  const capture = () => videoTrack?.requestFrame();
  let actx = null, player = null;
  if (track) {
    // The offline click track, played into the recording as it runs
    actx = new AudioContext({ sampleRate: AUDIO.SAMPLE_RATE });
    const dest = actx.createMediaStreamDestination();
    player = actx.createBufferSource();
    player.buffer = track.buffer;
    player.connect(dest);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
  }
  const recorder = new MediaRecorder(stream, { mimeType: encoding.mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: AUDIO.BITRATE });
  const parts = [];
  recorder.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise(resolve => { recorder.onstop = resolve; });

  let lateFrames = 0;
  try {
    await drawFrame();               // frame 0 is on the canvas before recording starts
    recorder.start(1000);
    capture();
    player?.start();
    const t0 = performance.now();
    let lastReport = 0;
    for (let k = 1; k < plan.frames; k++) {
      if (signal?.aborted) throw abortError();
      const due = t0 + k * 1000 / plan.fps;
      const wait = due - performance.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      else if (wait < -1000 / plan.fps) lateFrames++;   // more than a frame late: likely dropped
      await drawFrame();
      capture();
      const now = performance.now();
      if (now - lastReport > 100) { lastReport = now; progress('encode', k + 1); }
    }
    await new Promise(r => setTimeout(r, 1000 / plan.fps));   // let the last frame be captured
    progress('finish', plan.frames);
  } finally {
    if (recorder.state !== 'inactive') { recorder.stop(); await stopped; }
    stream.getTracks().forEach(t => t.stop());
    if (actx) await actx.close();
  }
  if (signal?.aborted) throw abortError();
  return { blob: new Blob(parts, { type: encoding.mime.split(';')[0] }), lateFrames };
}
