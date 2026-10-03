// Checks an exported video file against the export's timeline plan, with ffprobe and ffmpeg.
//
//   node scripts/check-video.mjs <file> --preset vertical --speed 1 [--sound] [--frames]
//
// The expected numbers come from the same code the app uses, run here in Node: the panel is
// composed (src/pattern/compose.js), scheduled (src/anim/schedule.js) and planned
// (src/export/plan.js). Then the FILE is measured, never the app's own report:
//
//   video   codec (h264 High, or vp9 for WebM), pix_fmt yuv420p, exact width × height,
//           avg_frame_rate 60/1, frame count == the plan's
//   timing  every frame's presentation time is k/60 (in the stream's time base): no gaps, no
//           duplicates, no reordering; for MP4 every step is exactly 1/60 s
//   frames  every frame is decoded (framemd5) with the overlay's rectangle blanked first
//           (export/overlay.js overlayMask: the counter changes every frame and would hide a
//           frozen picture); exact duplicates of the previous frame are counted, and while
//           pieces are in the air there must be none (a repeated frame there would be a dropped
//           animation step, or a picture frozen by a lost WebGL context)
//   flicker no frame may jump away from both neighbours while they agree with each other: per
//           tile of a quarter-size grey copy, min(|f(k) − f(k−1)|, |f(k) − f(k+1)|) − |f(k+1) −
//           f(k−1)| (mean levels). Smooth motion scores ≤ 0, a piece appearing scores ~0, a
//           one-frame glitch scores high. Fails above 10: the vertical video's depth-buffer
//           streaks scored up to 23 (27 frames over 10 in the review's vertical 1× file, 16 in
//           a vertical 2× one); the largest in clean files is 7.7, a one-frame shadow fade in
//           the 2× opening (frame 213, every preset).
//   audio   a stream iff --sound (aac or opus in MP4, opus in WebM), 48 kHz, as long as the
//           video, and in sync over the whole file: every isolated click (none in the 120 ms
//           before it) starts on the frame its pieces land, and every 4 s stretch of clicks
//           lines up best at 0 ms. On macOS the same onsets are also measured as Apple's
//           AVFoundation (Safari, QuickTime, iOS) decodes the file, which reads MP4 audio
//           timing differently from ffmpeg (a Swift helper, compiled on first use)
//   length  the container's duration matches the plan
//
// --frames also extracts stills at 0.5 s, 3 s, 20 s, the end of the laying, mid-sweep and the
// last frame into capture/video/frames/ (look at them).
//
// Exit code 1 if any check fails. A JSON report is written next to the file.

import { execFileSync, spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { composePanel } from '../src/pattern/compose.js';
import { makeSchedule } from '../src/anim/schedule.js';
import { TIMING } from '../src/config.js';
import { planExport, PRESETS, FPS } from '../src/export/plan.js';
import { landingFrames, clickEvents } from '../src/export/audio.js';
import { overlayMask } from '../src/export/overlay.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFPROBE = process.env.FFPROBE || '/opt/homebrew/bin/ffprobe';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';

const args = process.argv.slice(2);
const VALUED = ['preset', 'speed'];   // options followed by a value; everything else is a flag
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(args[i - 1].slice(2))));
if (!file) {
  console.error('usage: node scripts/check-video.mjs <file> --preset vertical|square|landscape --speed 1|2 [--sound] [--frames]');
  process.exit(2);
}
const preset = opt('preset', 'vertical');
const speed = +opt('speed', 1);
const sound = flag('sound');
const { width, height } = PRESETS[preset];
const container = extname(file).slice(1).toLowerCase();   // 'mp4' | 'webm'

// --------------------------------------------------------------- the expectation

const schedule = makeSchedule(composePanel().pieces, TIMING);
const plan = planExport({ T_END: schedule.T_END, speed });
/** Frame k shows laying time (k + 1)·speed/60: is any piece still falling or settling? */
const moving = k => {
  const sim = plan.simAt(k);
  return schedule.startedAt(sim) > schedule.landedAt(sim);
};

// --------------------------------------------------------------- sync helpers

/**
 * Onsets of the clicks with nothing in the 120 ms before them (the previous click, 50 ms of
 * noise and its filter's ring, is over): the first sample at a tenth of the click's own peak. `start` is the time of sample 0
 * in video time. @returns [{ t, ms }] offsets from each click's frame
 */
function isolatedOnsets(samples, start, events, rate = 48000) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const t = events[i].t;
    if (i > 0 && t - events[i - 1].t < 0.12) continue;
    const at = s => Math.round((s - start) * rate);
    // From 60 ms before (quiet by then; wide enough to see a click that plays early, like the
    // 44 ms AVFoundation once showed) to 35 ms after (before the next click, ≥ 40 ms later)
    const i0 = at(t - 0.06), i1 = at(t + 0.035);
    if (i0 < 0 || i1 >= samples.length) continue;
    let peak = 0;
    for (let j = i0; j < i1; j++) peak = Math.max(peak, Math.abs(samples[j]));
    if (peak < 1e-4) continue;
    let j = i0;
    while (j < i1 && Math.abs(samples[j]) < peak / 10) j++;
    out.push({ t, ms: (j / rate + start - t) * 1000 });
  }
  return out;
}

/**
 * For every 4 s stretch of clicks (dense ones too), the shift in 0.5 ms steps within ±20 ms
 * at which the click times best match the jumps in the sound's energy.
 * @returns [{ from, n, ms }]
 */
function segmentAlignment(samples, events, start = 0, rate = 48000) {
  const bin = rate / 2000;   // 0.5 ms
  const E = new Float64Array(Math.floor(samples.length / bin));
  for (let k = 0; k < E.length; k++) { let e = 0; for (let j = k * bin; j < (k + 1) * bin; j++) e += samples[j] * samples[j]; E[k] = e; }
  const groups = new Map();
  for (const e of events) { const g = Math.floor(e.t / 4) * 4; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e.t); }
  const out = [];
  for (const [from, ts] of groups) {
    let best = -Infinity, bestMs = 0;
    for (let d = -40; d <= 40; d++) {
      let score = 0;
      for (const t of ts) {
        const k = Math.round((t - start) * 2000 + d);
        if (k >= 4 && k < E.length - 4) score += E[k] + E[k + 1] + E[k + 2] + E[k + 3] - E[k - 4] - E[k - 3] - E[k - 2] - E[k - 1];
      }
      if (score > best) { best = score; bestMs = d / 2; }
    }
    out.push({ from, n: ts.length, ms: bestMs });
  }
  return out;
}

/** Decodes the audio track as AVFoundation does (AVAssetReader), mono 48 kHz floats. */
const AVF_SWIFT = String.raw`
import AVFoundation
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
let sem = DispatchSemaphore(value: 0)
var code: Int32 = 0
func firstPTS(_ track: AVAssetTrack, _ settings: [String: Any]?) throws -> (AVAssetReader, AVAssetReaderTrackOutput) {
  let reader = try AVAssetReader(asset: asset)
  let out = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
  reader.add(out); reader.startReading()
  return (reader, out)
}
Task {
  do {
    let v = try await asset.loadTracks(withMediaType: .video).first!
    let (vr, vo) = try firstPTS(v, nil)
    var videoStart = 0.0
    while let sb = vo.copyNextSampleBuffer() { if CMSampleBufferGetNumSamples(sb) > 0 { videoStart = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)); break } }
    vr.cancelReading()
    let a = try await asset.loadTracks(withMediaType: .audio).first!
    let (_, ao) = try firstPTS(a, [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
      AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1])
    var audioStart = -1.0
    while let sb = ao.copyNextSampleBuffer() {
      if audioStart < 0 { audioStart = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)) }
      guard let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
      let len = CMBlockBufferGetDataLength(bb)
      var data = Data(count: len)
      _ = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: $0.baseAddress!) }
      FileHandle.standardOutput.write(data)
    }
    FileHandle.standardError.write("{\"videoStart\":\(videoStart),\"audioStart\":\(audioStart)}\n".data(using: .utf8)!)
  } catch { FileHandle.standardError.write("\(error)\n".data(using: .utf8)!); code = 1 }
  sem.signal()
}
sem.wait()
exit(code)
`;
function decodeWithAVFoundation(path) {
  if (process.platform !== 'darwin') return { skipped: 'not macOS' };
  const bin = resolve(tmpdir(), `rosette-avf-${createHash('sha1').update(AVF_SWIFT).digest('hex').slice(0, 10)}`);
  try {
    if (!existsSync(bin)) {
      writeFileSync(bin + '.swift', AVF_SWIFT);
      execFileSync('swiftc', ['-O', '-o', bin, bin + '.swift'], { stdio: 'pipe' });
    }
    const r = spawnSync(bin, [path], { maxBuffer: 1 << 30 });
    if (r.status !== 0) return { skipped: `helper failed: ${r.stderr}` };
    const info = JSON.parse(r.stderr.toString().trim().split('\n').pop());
    return { samples: new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4), ...info };
  } catch (err) {
    return { skipped: `no Swift compiler or AVFoundation (${err.message.split('\n')[0]})` };
  }
}

// --------------------------------------------------------------- measuring the file

const run = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 28 });
const probe = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
const vs = probe.streams.find(s => s.codec_type === 'video');
const as = probe.streams.filter(s => s.codec_type === 'audio');

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };

check('video stream', !!vs, vs ? `${vs.codec_name} ${vs.profile ?? ''}`.trim() : 'none');
if (container === 'mp4') {
  check('codec h264 High', vs?.codec_name === 'h264' && vs?.profile === 'High', `${vs?.codec_name} / ${vs?.profile}`);
} else {
  check('codec vp9', vs?.codec_name === 'vp9', `${vs?.codec_name} / ${vs?.profile}`);
}
check('pix_fmt yuv420p', vs?.pix_fmt === 'yuv420p', vs?.pix_fmt);
check(`size ${width}x${height}`, vs?.width === width && vs?.height === height, `${vs?.width}x${vs?.height}`);
check('avg_frame_rate 60/1', vs?.avg_frame_rate === '60/1', `avg ${vs?.avg_frame_rate}, r ${vs?.r_frame_rate}`);

// Presentation times of every video packet, in the stream's time base
const [tbNum, tbDen] = vs.time_base.split('/').map(Number);
const packets = JSON.parse(run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,dts,duration,flags', '-of', 'json', file])).packets;
const pts = packets.map(p => +p.pts).sort((a, b) => a - b);
check(`packets == ${plan.frames} (plan)`, pts.length === plan.frames, `${pts.length} packets`);
check('one key frame first', packets[0]?.flags?.startsWith('K'), packets[0]?.flags);

// Frame k must be presented at k/60 s: in ticks, k·tbDen/(60·tbNum)
const ticksPerFrame = tbDen / (FPS * tbNum);
const exactGrid = Number.isInteger(ticksPerFrame);
let worstOff = 0, worstAt = -1, dupPts = 0;
const deltas = new Map();
for (let k = 0; k < pts.length; k++) {
  const off = Math.abs(pts[k] - pts[0] - k * ticksPerFrame);
  if (off > worstOff) { worstOff = off; worstAt = k; }
  if (k > 0) {
    const d = pts[k] - pts[k - 1];
    if (d === 0) dupPts++;
    deltas.set(d, (deltas.get(d) ?? 0) + 1);
  }
}
const deltaText = [...deltas].map(([d, n]) => `${d}×${n}`).join(', ');
check('first frame at 0', pts[0] === 0, `pts ${pts[0]}`);
if (exactGrid) {
  check('every step exactly 1/60 s', deltas.size === 1 && deltas.has(ticksPerFrame),
    `time base ${vs.time_base}, ${ticksPerFrame} ticks per frame; steps: ${deltaText}`);
} else {
  // WebM stores milliseconds, so 1/60 s rounds to 16 or 17: each frame must still sit on the
  // nearest tick to k/60, with no repeats
  check('every frame on k/60 (to the nearest tick)', worstOff <= 0.5 + 1e-9 && dupPts === 0,
    `time base ${vs.time_base}; worst ${worstOff.toFixed(2)} ticks at frame ${worstAt}; steps: ${deltaText}`);
}

// Decode every frame once, with the overlay's rectangle blanked: a framemd5 of each full frame
// (count, exact duplicates) and a quarter-size grey copy streamed here (the flicker check)
const mask = overlayMask(width, height);
const FLICKER = { GRID_X: 8, LEVELS: 10 };
const qw = width / 4, qh = height / 4, qn = qw * qh;
const gridY = Math.round(FLICKER.GRID_X * qh / qw);
const tileOf = new Int32Array(qn), tileSize = new Float64Array(FLICKER.GRID_X * gridY);
for (let y = 0; y < qh; y++) for (let x = 0; x < qw; x++) {
  const t = Math.min(gridY - 1, Math.floor(y * gridY / qh)) * FLICKER.GRID_X + Math.min(FLICKER.GRID_X - 1, Math.floor(x * FLICKER.GRID_X / qw));
  tileOf[y * qw + x] = t; tileSize[t]++;
}
/** The worst tile's one-frame spike for the middle one of three grey frames (see the header). */
function spike(a, b, c) {
  const n = tileSize.length, s12 = new Float64Array(n), s23 = new Float64Array(n), s13 = new Float64Array(n);
  for (let i = 0; i < qn; i++) {
    const t = tileOf[i];
    s12[t] += Math.abs(b[i] - a[i]); s23[t] += Math.abs(c[i] - b[i]); s13[t] += Math.abs(c[i] - a[i]);
  }
  let worst = 0;
  for (let t = 0; t < n; t++) worst = Math.max(worst, (Math.min(s12[t], s23[t]) - s13[t]) / tileSize[t]);
  return worst;
}
const md5File = resolve(tmpdir(), `check-video-${process.pid}.framemd5`);
const spikes = [];   // spikes[k - 1] belongs to frame k
await new Promise((done, fail) => {
  const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-filter_complex',
    `[0:v:0]drawbox=x=${mask.x}:y=${mask.y}:w=${mask.w}:h=${mask.h}:color=black:t=fill,split=2[m][g];[g]scale=${qw}:${qh}:flags=area,format=gray[q]`,
    '-map', '[m]', '-f', 'framemd5', '-y', md5File, '-map', '[q]', '-f', 'rawvideo', 'pipe:1']);
  const last = [];
  let acc = Buffer.alloc(0), err = '';
  p.stdout.on('data', d => {
    acc = acc.length ? Buffer.concat([acc, d]) : d;
    while (acc.length >= qn) {
      last.push(Uint8Array.from(acc.subarray(0, qn)));
      acc = acc.subarray(qn);
      if (last.length === 3) { spikes.push(spike(...last)); last.shift(); }
    }
  });
  p.stderr.on('data', d => { err += d; });
  p.on('close', code => (code ? fail(new Error(`ffmpeg failed: ${err}`)) : done()));
});
const md5 = readFileSync(md5File, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').map(x => x.trim()));
rmSync(md5File, { force: true });
check(`decoded frames == ${plan.frames}`, md5.length === plan.frames, `${md5.length} decoded`);
const dupLaying = [], dupMoving = [], dupOther = [];
for (let k = 1; k < md5.length; k++) {
  if (md5[k][5] !== md5[k - 1][5]) continue;
  if (k <= plan.layEndFrame) { dupLaying.push(k); if (moving(k)) dupMoving.push(k); } else dupOther.push(k);
}
const movingFrames = Array.from({ length: plan.layEndFrame + 1 }, (_, k) => moving(k)).filter(Boolean).length;
check('no repeated frame while pieces move', dupMoving.length === 0,
  `${dupMoving.length} repeats in ${movingFrames} frames with pieces in the air (overlay blanked)` + (dupMoving.length ? ` (frames ${dupMoving.slice(0, 12).join(', ')})` : ''));
const flickers = spikes.map((v, i) => [i + 1, v]).filter(([, v]) => v > FLICKER.LEVELS);
const worstSpike = spikes.reduce((w, v, i) => (v > w[1] ? [i + 1, v] : w), [0, 0]);
check(`no one-frame flicker (spike ≤ ${FLICKER.LEVELS} levels)`, flickers.length === 0,
  `${flickers.length} frames over; worst ${worstSpike[1].toFixed(2)} at frame ${worstSpike[0]}`
  + (flickers.length ? ` (frames ${flickers.slice(0, 10).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(', ')})` : ''));

// Audio
if (sound) {
  const a = as[0];
  check('one audio stream', as.length === 1, `${as.length} audio streams`);
  const audioCodecs = container === 'mp4' ? ['aac', 'opus'] : ['opus'];
  check(`audio ${audioCodecs.join(' or ')} 48 kHz`, a && audioCodecs.includes(a.codec_name) && +a.sample_rate === 48000,
    a ? `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch` : 'none');
  const aDur = +(a?.duration ?? probe.format.duration);
  // AAC and Opus frames are 1024 / 960 samples (~21 / 20 ms), so the stream ends on a frame
  check('audio as long as the video (±50 ms)', a && Math.abs(aDur - plan.duration) <= 0.05, `${aDur.toFixed(3)} s vs ${plan.duration.toFixed(3)} s`);

  if (a) {
    // Sync: decode the audio as a player would (ffmpeg applies the MP4 edit list and Opus's
    // pre-skip) and compare every click with the frame its pieces land on
    const pcm = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 1 << 30 });
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    const events = clickEvents(landingFrames(schedule.t0, schedule.D, speed, FPS), { fps: FPS, rand: () => 0 });
    const iso = isolatedOnsets(samples, 0, events);
    const worstIso = iso.reduce((w, o) => Math.max(w, Math.abs(o.ms)), 0);
    check('isolated clicks in sync with the picture (±3 ms)', iso.length > 0 && worstIso <= 3,
      `${iso.length} isolated clicks measured from ${iso[0]?.t.toFixed(2)} s to ${iso.at(-1)?.t.toFixed(2)} s; worst ${worstIso.toFixed(2)} ms`);
    const segs = segmentAlignment(samples, events);
    const worstSeg = segs.reduce((w, s) => Math.max(w, Math.abs(s.ms)), 0);
    check('every 4 s of clicks in sync (±3 ms)', segs.length > 0 && worstSeg <= 3,
      `${segs.length} stretches; best offsets ${[...new Set(segs.map(s => s.ms))].sort((x, y) => x - y).map(o => (o >= 0 ? '+' : '') + o.toFixed(1)).join(', ')} ms`);

    // The same onsets as Apple's AVFoundation reads the file (macOS only)
    const avf = container === 'mp4' ? decodeWithAVFoundation(file) : { skipped: 'WebM: AVFoundation does not open it' };
    if (avf.samples) {
      const ao = isolatedOnsets(avf.samples, avf.audioStart - avf.videoStart, events);
      const worstAvf = ao.reduce((w, o) => Math.max(w, Math.abs(o.ms)), 0);
      const as4 = segmentAlignment(avf.samples, events, avf.audioStart - avf.videoStart);
      const worstAs4 = as4.reduce((w, s) => Math.max(w, Math.abs(s.ms)), 0);
      check('clicks in sync in AVFoundation (Safari, QuickTime, iOS) (±3 ms)', ao.length > 0 && worstAvf <= 3 && worstAs4 <= 3,
        `${ao.length} isolated clicks: first ${ao[0] ? (ao[0].ms >= 0 ? '+' : '') + ao[0].ms.toFixed(2) : '?'} ms, worst ${worstAvf.toFixed(2)} ms; `
        + `${as4.length} 4 s stretches: worst ${worstAs4.toFixed(1)} ms`);
    } else {
      console.log(`  info  AVFoundation sync not checked: ${avf.skipped}`);
    }
  }
} else {
  check('no audio stream (silent export)', as.length === 0, `${as.length} audio streams`);
}
const fDur = +probe.format.duration;
check('duration matches the plan', Math.abs(fDur - plan.duration) <= (sound ? 0.05 : 1 / FPS + 1e-6),
  `${fDur.toFixed(3)} s, plan ${plan.duration.toFixed(3)} s (${plan.frames} frames)`);

// --------------------------------------------------------------- stills to look at

const stills = {};
if (flag('frames')) {
  const outDir = resolve(ROOT, 'capture/video/frames');
  mkdirSync(outDir, { recursive: true });
  const at = t => Math.min(plan.frames - 1, Math.max(0, Math.round(t * FPS) - 1));   // frame showing time t
  const wanted = {
    '0.5s': at(0.5), '3s': at(3), '20s': at(20),
    'lay-end': plan.layEndFrame,
    'mid-sweep': at((plan.sweepStart + plan.sweepEnd) / 2),
    'last': plan.frames - 1,
  };
  const base = basename(file, extname(file));
  const tmp = resolve(outDir, `.tmp-${base}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const frames = [...new Set(Object.values(wanted))].sort((a, b) => a - b);
  // One decoding pass; select keeps the listed frame numbers, written in order
  run(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `select='${frames.map(n => `eq(n\\,${n})`).join('+')}'`,
    '-fps_mode', 'passthrough', resolve(tmp, '%03d.png')]);
  const written = readdirSync(tmp).sort();
  for (const [label, n] of Object.entries(wanted)) {
    // A file with fewer frames than the plan (a failed check above) has no still for the late ones
    if (!written[frames.indexOf(n)]) continue;
    const src = resolve(tmp, written[frames.indexOf(n)]);
    const dst = resolve(outDir, `${base}-${label}.png`);
    execFileSync('cp', [src, dst]);
    stills[label] = { frame: n, time: +(n / FPS).toFixed(3), file: dst };
  }
  rmSync(tmp, { recursive: true, force: true });
}

// --------------------------------------------------------------- report

const ok = checks.every(c => c.ok);
const report = {
  file, bytes: statSync(file).size, preset, speed, sound, container,
  plan: { frames: plan.frames, duration: plan.duration, layEndFrame: plan.layEndFrame, sweepStart: plan.sweepStart, sweepEnd: plan.sweepEnd },
  video: { codec: vs?.codec_name, profile: vs?.profile, pix_fmt: vs?.pix_fmt, bit_rate: +vs?.bit_rate || null, time_base: vs?.time_base },
  duplicates: { laying: dupLaying.length, whileMoving: dupMoving.length, afterLaying: dupOther.length, layingFrames: dupLaying.slice(0, 40) },
  stills, checks, ok,
};
writeFileSync(file.replace(/\.[^.]+$/, '.check.json'), JSON.stringify(report, null, 2));

console.log(`\n${basename(file)}  ${(report.bytes / 1e6).toFixed(1)} MB  ${report.video.bit_rate ? (report.video.bit_rate / 1e6).toFixed(1) + ' Mbit/s video' : ''}`);
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(42)} ${c.detail ?? ''}`);
console.log(`  info  repeated frames: ${dupLaying.length} during the laying (all with no piece in the air: ${dupMoving.length === 0}), ${dupOther.length} after it`);
for (const [label, s] of Object.entries(stills)) console.log(`  still ${label.padEnd(9)} frame ${s.frame} (${s.time}s) → ${s.file}`);
console.log(ok ? '  ALL CHECKS PASS' : '  SOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
