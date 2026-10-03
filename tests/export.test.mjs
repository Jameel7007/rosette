// Video export: the timeline plan (frame counts per preset and speed, the sweep's timing), the
// encoder fallback, the H.264 settings, the offline click track (throttle, gains, determinism for
// a seed), the overlay's placement and mask, the MP4 fix-up for Apple's players (the AAC roll
// group), the time-left estimate, the camera's depth range, and the export camera's fit (the
// whole finished panel and its curb in frame for each aspect, eased in without a jump).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { planExport, PRESETS, FPS, TIMELINE, EXPORT_SPEEDS, exportFileName, pickEncoding, videoBitrate, VIDEO_QUALITY } from '../src/export/plan.js';
import { landingFrames, clickEvents } from '../src/export/audio.js';
import { overlayLayout, overlayMask } from '../src/export/overlay.js';
import { withAacRollGroup } from '../src/export/mp4.js';
import { createEta } from '../src/ui/eta.js';
import { BED } from '../src/scene/bed.js';
import { CLICK } from '../src/audio/clicks.js';
import { stream } from '../src/util/rand.js';
import { createCameraRig, fitDistance, EXPORT_FIT, FRAMING, ORBIT } from '../src/anim/camera.js';
import { SUN } from '../src/anim/light.js';
import { composePanel } from '../src/pattern/compose.js';
import { makeSchedule } from '../src/anim/schedule.js';
import { TIMING, PANEL } from '../src/config.js';

const schedule = makeSchedule(composePanel().pieces, TIMING);
const fakeCanvas = () => ({ addEventListener() {}, removeEventListener() {}, setPointerCapture() {} });

// ---------- the timeline plan ----------

test('plan: the finale timings are the live app\'s', () => {
  assert.equal(TIMELINE.SWEEP_SECONDS, SUN.SWEEP_SECONDS);
  assert.equal(TIMELINE.SWEEP_DELAY, 1.2);   // main.js SWEEP_DELAY
  assert.equal(FPS, 60);
  assert.deepEqual(EXPORT_SPEEDS, [1, 2]);
});

test('plan: frame counts for the real panel at 1× and 2× (same for every preset)', () => {
  // T_END = 47.448 s: the last piece lands on frame ceil(47.448·60) − 1 = 2846 at 1×
  const p1 = planExport({ T_END: schedule.T_END, speed: 1 });
  assert.equal(p1.layEndFrame, 2846);
  assert.equal(p1.frames, 2847 + 72 + 660 + 90);   // laying + 1.2 s pause + 11 s sweep + 1.5 s hold
  assert.equal(p1.frames, 3669);
  assert.ok(Math.abs(p1.duration - 61.15) < 1e-9);
  const p2 = planExport({ T_END: schedule.T_END, speed: 2 });
  assert.equal(p2.layEndFrame, 1423);
  assert.equal(p2.frames, 2246);
  // The laying halves; the pause, sweep and hold keep their real length
  assert.equal(p1.frames - p1.layEndFrame, p2.frames - p2.layEndFrame);
});

test('plan: frame k shows laying time (k+1)·speed/60; the last piece lands exactly on layEndFrame', () => {
  for (const speed of [1, 2]) {
    const p = planExport({ T_END: schedule.T_END, speed });
    assert.ok(p.simAt(p.layEndFrame) >= schedule.T_END, 'landed on layEndFrame');
    assert.ok(p.simAt(p.layEndFrame - 1) < schedule.T_END, 'not yet on the frame before');
    assert.equal(schedule.landedAt(p.simAt(p.layEndFrame)), schedule.N);
    assert.ok(schedule.landedAt(p.simAt(p.layEndFrame - 1)) < schedule.N);
    // The same float sum the live loop makes (sim += dt·speed per step) lands on the same frame
    let sim = 0, k = -1;
    while (sim < schedule.T_END) { sim += (1 / 60) * speed; k++; }
    assert.equal(k, p.layEndFrame);
  }
});

test('plan: the sweep starts 1.2 s after the landing frame and the file ends 1.5 s after it', () => {
  for (const speed of [1, 2]) {
    const p = planExport({ T_END: schedule.T_END, speed });
    assert.ok(Math.abs(p.sweepStart - (p.clockAt(p.layEndFrame) + 1.2)) < 1e-9);
    assert.ok(Math.abs(p.sweepEnd - p.sweepStart - 11) < 1e-9);
    assert.ok(Math.abs(p.clockAt(p.frames - 1) - (p.sweepEnd + 1.5)) < 1e-9, 'the last frame shows the end of the hold');
  }
  // An exact multiple of a frame still lands where the float loop would
  const exact = planExport({ T_END: 10, speed: 1 });
  assert.equal(exact.layEndFrame, 599);
  assert.throws(() => planExport({ T_END: 0 }));
});

test('plan: presets, file names, bitrate fallback', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ['landscape', 'square', 'vertical']);
  for (const { width, height } of Object.values(PRESETS)) assert.ok(width % 2 === 0 && height % 2 === 0, '4:2:0 needs even sizes');
  assert.equal(exportFileName('vertical', 1, 'mp4'), 'rosette-1080x1920-1x.mp4');
  assert.equal(exportFileName('square', 2, 'webm'), 'rosette-1080x1080-2x.webm');
  assert.equal(videoBitrate(1080, 1920, 'avc'), 37_300_000);   // H.264 without a quantizer (Safari)
  assert.equal(videoBitrate(1080, 1920, 'vp9'), 24_900_000);
});

test('encoder choice: MP4 H.264 + AAC first, then H.264 + Opus in MP4, WebM VP9, then MediaRecorder', () => {
  const all = { webcodecs: true, avc: true, aac: true, vp9: true, opus: true, recorderMime: 'video/webm;codecs=vp9,opus' };
  assert.equal(pickEncoding(all, true).container, 'mp4');
  assert.equal(pickEncoding(all, true).audio, 'aac');
  assert.equal(pickEncoding(all, true).caution, '');
  assert.equal(pickEncoding(all, false).audio, null);
  // Firefox: H.264 but no AAC encoder → still MP4 and the fast H.264 encoder, with Opus sound,
  // and the panel says so (it used to fall back to WebM/VP9, ~7× slower there)
  const firefox = { ...all, aac: false };
  const ff = pickEncoding(firefox, true);
  assert.deepEqual([ff.container, ff.video, ff.audio, ff.label], ['mp4', 'avc', 'opus', 'MP4 · H.264 + Opus']);
  assert.match(ff.caution, /Opus/);
  assert.equal(pickEncoding(firefox, false).label, 'MP4 · H.264');
  // No H.264 at all: WebM, with the warning that Instagram needs MP4
  const webm = pickEncoding({ ...all, avc: false }, true);
  assert.deepEqual([webm.container, webm.video, webm.audio], ['webm', 'vp9', 'opus']);
  assert.match(webm.caution, /Instagram needs MP4/);
  // No WebCodecs: real-time recording, flagged as such
  const old = pickEncoding({ webcodecs: false, recorderMime: 'video/webm' }, true);
  assert.equal(old.kind, 'mediarecorder');
  assert.equal(old.realtime, true);
  assert.match(old.caution, /frames may be dropped/);
  assert.doesNotMatch(old.caution, /slow machine/);
  assert.equal(pickEncoding({ webcodecs: false, recorderMime: null }, false), null);
});

test('H.264 settings: one quantizer for every preset, and the codec level the frame rate needs', () => {
  assert.equal(VIDEO_QUALITY.AVC_QUANTIZER, 22);
  // 'avc1.64002a': High profile (0x64), level 4.2 (0x2a = 42)
  assert.match(VIDEO_QUALITY.AVC_CODEC, /^avc1\.64..2a$/i);
  for (const { width, height } of Object.values(PRESETS)) {
    const mbPerSecond = Math.ceil(width / 16) * Math.ceil(height / 16) * FPS;
    assert.ok(mbPerSecond > 245_760, 'more than level 4.1 allows');
    assert.ok(mbPerSecond <= 522_240, 'within level 4.2');
    assert.ok(Math.ceil(width / 16) * Math.ceil(height / 16) <= 8_704, 'frame size within level 4.2');
  }
});

// ---------- the offline click track ----------

test('clicks: landing frames follow the plan (frame k shows laying time (k+1)·speed/60)', () => {
  for (const speed of [1, 2]) {
    const frames = landingFrames(schedule.t0, schedule.D, speed, FPS);
    const p = planExport({ T_END: schedule.T_END, speed });
    assert.equal(frames[frames.length - 1], p.layEndFrame, 'the last landing is on the plan\'s landing frame');
    for (const i of [0, 1, 100, 5000, schedule.N - 1]) {
      const k = frames[i];
      assert.ok(schedule.t0[i] + schedule.D <= p.simAt(k) + 1e-9, `piece ${i} landed on frame ${k}`);
      if (k > 0) assert.ok(schedule.t0[i] + schedule.D > p.simAt(k - 1), `piece ${i} not landed the frame before`);
    }
  }
});

test('clicks: the live rule: one per frame with landings, ≥ 40 ms apart, louder with more pieces, fading with the count', () => {
  const frames = landingFrames(schedule.t0, schedule.D, 1, FPS);
  const events = clickEvents(frames, { fps: FPS, rand: stream('audio') });
  assert.ok(events.length > 100);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].t - events[i - 1].t >= CLICK.MIN_GAP - 1e-9, 'throttled');
  for (const e of events) {
    const want = Math.min(CLICK.GAIN_MAX, CLICK.GAIN + CLICK.GAIN_PER_TILE * e.k) / (1 + Math.max(0, e.landed - CLICK.FADE_AFTER) / CLICK.FADE_OVER);
    assert.ok(Math.abs(e.gain - want) < 1e-12);
    assert.ok(e.freq >= CLICK.FREQ && e.freq < CLICK.FREQ + CLICK.FREQ_SPREAD);
    assert.ok(Number.isInteger(Math.round(e.t * FPS)) && Math.abs(e.t * FPS - Math.round(e.t * FPS)) < 1e-9, 'on a frame');
  }
  // The first click is the khatam landing, alone and at full early gain
  assert.equal(events[0].k, 1);
  assert.equal(events[0].landed, 1);
  assert.ok(Math.abs(events[0].gain - (CLICK.GAIN + CLICK.GAIN_PER_TILE)) < 1e-12);
  assert.ok(Math.abs(events[0].t - frames[0] / FPS) < 1e-12);
  // The count reaches every piece; the last click is no later than the last landing
  assert.ok(events.at(-1).landed <= schedule.N);
  assert.ok(events.at(-1).t <= frames.at(-1) / FPS + 1e-9);
});

test('clicks: a hand-made case for the throttle and the per-frame grouping', () => {
  // 3 pieces on frame 0, 1 on frame 1 (16.7 ms later: skipped), 2 on frame 3 (50 ms: kept)
  const events = clickEvents(Int32Array.from([0, 0, 0, 1, 3, 3]), { fps: 60, rand: () => 0.5 });
  assert.deepEqual(events.map(e => [Math.round(e.t * 60), e.k, e.landed]), [[0, 3, 3], [3, 2, 6]]);
  assert.ok(Math.abs(events[0].gain - Math.min(CLICK.GAIN_MAX, CLICK.GAIN + 3 * CLICK.GAIN_PER_TILE)) < 1e-12);
  assert.equal(events[0].freq, CLICK.FREQ + 0.5 * CLICK.FREQ_SPREAD);
});

test('clicks: deterministic for a seed, different for another; 2× has its own track', () => {
  const frames = landingFrames(schedule.t0, schedule.D, 1, FPS);
  const a = clickEvents(frames, { fps: FPS, rand: stream('audio') });
  const b = clickEvents(frames, { fps: FPS, rand: stream('audio') });
  assert.deepEqual(a, b);
  const c = clickEvents(frames, { fps: FPS, rand: stream('audio', 12345) });
  assert.equal(c.length, a.length, 'the seed only changes pitches');
  assert.notDeepEqual(c.map(e => e.freq), a.map(e => e.freq));
  const fast = clickEvents(landingFrames(schedule.t0, schedule.D, 2, FPS), { fps: FPS, rand: stream('audio') });
  assert.ok(fast.at(-1).t < a.at(-1).t / 1.9, 'at 2× the clicks finish in about half the time');
});

// ---------- the overlay ----------

test('overlay: top left, clear of the centre, of the bottom 20% and of the right edge on vertical', () => {
  // Upper bound of the pill's size at a 1080 short side: the title (19 Marcellus glyphs at
  // 44 px, under 0.62 em each) and padding; two lines of text
  const maxW = 19 * 44 * 0.62 + 2 * 26, maxH = 20 + 44 + 10 + 30 + 20;
  for (const [name, { width, height }] of Object.entries(PRESETS)) {
    const L = overlayLayout(width, height);
    const s = L.scale;
    const box = { x0: L.x, y0: L.y, x1: L.x + maxW * s, y1: L.y + maxH * s };
    assert.ok(box.x1 < width / 2 - 20 || box.y1 < height / 2 - 0.2 * height, `${name}: the pill stays off the centre`);
    assert.ok(box.x0 >= 40 * s && box.y0 >= 40 * s, `${name}: inside a margin`);
    if (name === 'vertical') {
      assert.ok(box.y0 >= 0.09 * height, 'below the app header');
      assert.ok(box.y1 < 0.8 * height, 'above the bottom 20% (caption)');
      assert.ok(box.x1 < 0.8 * width, 'clear of the right-hand button column');
    }
  }
});

test('overlay mask: holds the pill whatever its font, and the frame stays mostly unmasked', () => {
  for (const [name, { width, height }] of Object.entries(PRESETS)) {
    const L = overlayLayout(width, height), m = overlayMask(width, height, { total: 10209 });
    const s = L.scale;
    assert.ok(m.x <= L.x && m.y <= L.y, `${name}: starts at or before the pill`);
    // The widest title a real font gives (Georgia, Marcellus: under 0.62 em a glyph) and the
    // two text lines of the pill fit inside
    assert.ok(m.x + m.w >= L.x + (19 * 44 * 0.62 + 2 * 26) * s, `${name}: wide enough`);
    assert.ok(m.y + m.h >= L.y + (20 + 44 + 10 + 30 + 20) * s, `${name}: tall enough`);
    assert.ok(m.w * m.h < 0.12 * width * height, `${name}: masks under 12% of the frame`);
    assert.ok(m.x + m.w < 0.8 * width, `${name}: clear of the right-hand fifth`);
  }
  // The fallback stacks leave the web fonts out, so a late web font cannot switch the typeface
  const fallback = overlayLayout(1080, 1920, false).font;
  assert.doesNotMatch(fallback.title, /Marcellus/);
  assert.doesNotMatch(fallback.count + fallback.unit, /Spline/);
  assert.match(overlayLayout(1080, 1920).font.title, /Marcellus/);
});

// ---------- the MP4 fix-up (AAC roll group) ----------

/** A minimal MP4: ftyp, moov (a video and an audio track with stsd/stsz/stco), mdat. */
function tinyMp4({ audioCodec = 'mp4a', withSgpd = false } = {}) {
  const enc = new TextEncoder();
  const box = (type, ...parts) => {
    const body = parts.flatMap(p => [...p]);
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(enc.encode(type), 4);
    out.set(body, 8);
    return out;
  };
  const u32 = (...xs) => { const b = new Uint8Array(4 * xs.length); xs.forEach((x, i) => new DataView(b.buffer).setUint32(4 * i, x)); return b; };
  const hdlr = t => box('hdlr', u32(0, 0), enc.encode(t), u32(0, 0, 0), new Uint8Array([0]));
  const stco = offsets => box('stco', u32(0, offsets.length, ...offsets));
  const trak = (handler, entry, offsets, extra = []) => box('trak', box('mdia', hdlr(handler), box('minf', box('stbl',
    box('stsd', u32(0, 1), box(entry, new Uint8Array(28))),
    box('stsz', u32(0, 0, 3, 10, 10, 10)),
    stco(offsets), ...extra))));
  const ftyp = box('ftyp', enc.encode('isom'), u32(0));
  const sgpd = withSgpd ? [box('sgpd', u32(0x01000000), enc.encode('roll'), u32(2, 1), new Uint8Array([0xff, 0xff]))] : [];
  // Offsets are filled in once the moov size is known
  const build = offs => {
    const moov = box('moov', trak('vide', 'avc1', offs.v), trak('soun', audioCodec, offs.a, sgpd));
    return { moov, mdatStart: ftyp.length + moov.length };
  };
  const { mdatStart } = build({ v: [0, 0], a: [0] });   // same entry counts: same moov size
  const offs = { v: [mdatStart + 8, mdatStart + 18], a: [mdatStart + 28] };
  const { moov } = build(offs);
  const mdat = box('mdat', new Uint8Array(40).map((_, i) => i));
  const file = new Uint8Array(ftyp.length + moov.length + mdat.length);
  file.set(ftyp); file.set(moov, ftyp.length); file.set(mdat, ftyp.length + moov.length);
  return { file, offs };
}
const join = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
/** Every box path → { start, size }, walking the containers. */
function boxTree(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
  const walk = (a, b, path) => {
    for (let p = a; p < b;) {
      const size = v.getUint32(p), type = new TextDecoder().decode(bytes.subarray(p + 4, p + 8));
      out.push({ path: path + '/' + type, start: p, size });
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(p + 8, p + size, path + '/' + type);
      p += size;
    }
  };
  walk(0, bytes.length, '');
  return { out, v };
}

test('MP4 fix-up: adds the AAC roll group to the audio track and moves every chunk offset with the data', () => {
  const { file } = tinyMp4();
  const fixed = join(withAacRollGroup(file));
  assert.equal(fixed.length, file.length + 54);
  const { out, v } = boxTree(fixed);
  // Sizes add up: the top-level boxes cover the file exactly
  assert.equal(out.filter(b => b.path.split('/').length === 2).reduce((n, b) => n + b.size, 0), fixed.length);
  const audioStbl = out.filter(b => b.path === '/moov/trak/mdia/minf/stbl')[1];
  const sgpd = out.find(b => b.path.endsWith('stbl/sgpd')), sbgp = out.find(b => b.path.endsWith('stbl/sbgp'));
  assert.ok(sgpd && sbgp && sgpd.start > audioStbl.start && sbgp.start + sbgp.size === audioStbl.start + audioStbl.size, 'in the audio stbl, last');
  assert.equal(new TextDecoder().decode(fixed.subarray(sgpd.start + 12, sgpd.start + 16)), 'roll');
  assert.equal(v.getInt16(sgpd.start + 24), -1, 'roll distance −1');
  assert.equal(v.getUint32(sbgp.start + 16), 1, 'one run ...');
  assert.equal(v.getUint32(sbgp.start + 20), 3, '... of all 3 samples');
  // The chunk offsets still point at the same bytes of media data
  const mdat = out.find(b => b.path === '/mdat');
  for (const stco of out.filter(b => b.path.endsWith('/stco'))) {
    for (let i = 0; i < v.getUint32(stco.start + 12); i++) {
      const off = v.getUint32(stco.start + 16 + 4 * i);
      assert.ok(off >= mdat.start + 8 && off < mdat.start + mdat.size, 'inside mdat');
      assert.equal(fixed[off], off - mdat.start - 8, 'the same byte as before');
    }
  }
  // Applying it again changes nothing; files with no AAC track are passed through untouched
  assert.equal(withAacRollGroup(fixed).length, 1);
  assert.equal(withAacRollGroup(tinyMp4({ audioCodec: 'Opus' }).file).length, 1);
  assert.equal(withAacRollGroup(tinyMp4({ withSgpd: true }).file).length, 1);
});

// ---------- the time-left estimate ----------

test('time left: waits for 2 s and 3% of the frames, then follows the recent rate', () => {
  const eta = createEta();
  // A slow start (setup), then 100 frames/s
  assert.ok(Number.isNaN(eta.update(0, 0, 3000)));
  assert.ok(Number.isNaN(eta.update(1500, 150, 3000)), 'not before 2 s');
  let left = NaN;
  for (let t = 1600; t <= 4000; t += 100) left = eta.update(t, 150 + (t - 1500) / 10, 3000);
  // At 4 s: 400 frames done at 100 frames/s → 26 s left
  assert.ok(Math.abs(left - 26) < 0.5, `left ${left}`);
  // The rate drops to 50 frames/s: within the window the estimate follows it
  let done = 400;
  for (let t = 4100; t <= 8000; t += 100) { done += 5; left = eta.update(t, done, 3000); }
  assert.ok(Math.abs(left - (3000 - done) / 50) < 1, `left ${left}`);
  const few = createEta();
  few.update(0, 0, 100000);
  assert.ok(Number.isNaN(few.update(3000, 2000, 100000)), 'not before 3% of the frames');
});

// ---------- the camera's depth range ----------

test('camera: the near plane follows the distance; nothing on screen is near it, and the depth step stays fine', () => {
  for (const aspect of [1080 / 1920, 1, 1920 / 1080, 390 / 844]) {
    for (const fit of [false, true]) {
      const camera = new THREE.PerspectiveCamera(32, aspect, 0.1, 1200);
      const rig = createCameraRig(camera, fakeCanvas(), { input: false, fit });
      let sim = 0;
      for (let k = 0; k < 3669; k++) {
        sim += 1 / 60;
        rig.update(1 / 60, schedule.rLaidAt(sim), sim);
        const d = camera.position.length();
        assert.ok(Math.abs(camera.near - d * FRAMING.NEAR_PER_DISTANCE) < 1e-9);
      }
      const d = camera.position.length();
      // The depth buffer's step at the panel (24-bit or float32 depth near 1: d² · 2⁻²⁴ / near)
      const step = d * d * 2 ** -24 / camera.near;
      assert.ok(step < 0.01, `aspect ${aspect.toFixed(2)} fit ${fit}: depth step ${step.toFixed(4)} at ${d.toFixed(0)} units`);
      assert.ok(camera.projectionMatrix.elements[10] !== new THREE.PerspectiveCamera(32, aspect, 0.1, 1200).projectionMatrix.elements[10], 'the projection was rebuilt');
    }
  }
  // The lowest view the viewer can turn to (EL_MIN) with the widest zoom-in: the bed's nearest
  // visible point is still far beyond the near plane
  const el = FRAMING.EL_MIN, halfFov = 16 * Math.PI / 180;
  const nearestGround = Math.sin(el) * Math.cos(halfFov) / Math.sin(el + halfFov);   // × distance
  assert.ok(nearestGround > 10 * FRAMING.NEAR_PER_DISTANCE, `nearest ground at ${nearestGround.toFixed(2)} × distance`);
  assert.ok(ORBIT.ZOOM_MIN > 0, 'zoom only scales the distance (the near plane scales with it)');
});

// ---------- the export camera ----------

/** Projects the panel's four corners with three's own camera; returns the largest |NDC| coordinate. */
function cornerReach(camera) {
  camera.updateMatrixWorld();
  let worst = 0;
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const p = new THREE.Vector3(x * PANEL.BORDER, 0, z * PANEL.BORDER).project(camera);
    worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
  }
  return worst;
}

/** As cornerReach, for the curb's outer top corners. */
function curbReach(camera) {
  camera.updateMatrixWorld();
  let worst = 0;
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const p = new THREE.Vector3(x * EXPORT_FIT.CURB_HALF, EXPORT_FIT.CURB_TOP, z * EXPORT_FIT.CURB_HALF).project(camera);
    worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
  }
  return worst;
}

test('export fit: the curb constants are the bed\'s', () => {
  assert.equal(EXPORT_FIT.CURB_HALF, PANEL.EXT / 2 + BED.CURB.thickness);
  assert.ok(Math.abs(EXPORT_FIT.CURB_TOP - (0.1 + BED.CURB.height / 2)) < 1e-12);   // bed.js: centred at y = 0.1
});

test('fitDistance matches three\'s projection: the corners land exactly on the margin', () => {
  for (const aspect of [1080 / 1920, 1, 1920 / 1080]) {
    for (const [el, az] of [[1.14, 0.9], [1.14, 1.3], [0.6, 0.2], [1.5, 2.5]]) {
      const camera = new THREE.PerspectiveCamera(32, aspect, 0.1, 5000);
      const d = fitDistance(el, az, 32, aspect);
      camera.position.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
      camera.lookAt(0, 0, 0);
      assert.ok(Math.abs(cornerReach(camera) - (1 - EXPORT_FIT.MARGIN)) < 1e-6, `aspect ${aspect.toFixed(2)} el ${el} az ${az}: ${cornerReach(camera)}`);
      // Raised corners (the curb's top)
      const dc = fitDistance(el, az, 32, aspect, { half: EXPORT_FIT.CURB_HALF, y: EXPORT_FIT.CURB_TOP, margin: EXPORT_FIT.CURB_MARGIN });
      camera.position.set(dc * Math.cos(el) * Math.sin(az), dc * Math.sin(el), dc * Math.cos(el) * Math.cos(az));
      camera.lookAt(0, 0, 0);
      assert.ok(Math.abs(curbReach(camera) - (1 - EXPORT_FIT.CURB_MARGIN)) < 1e-6, `curb: ${curbReach(camera)}`);
    }
  }
});

/** Runs a rig along an export's real timeline; returns the reach of the corners per frame and the distances. */
function runExportCamera(aspect, speed, fit) {
  const camera = new THREE.PerspectiveCamera(32, aspect, 0.1, 5000);
  const rig = createCameraRig(camera, fakeCanvas(), { input: false, fit });
  const p = planExport({ T_END: schedule.T_END, speed });
  const dist = [], reach = [];
  let sim = 0;
  for (let k = 0; k < p.frames; k++) {
    sim += speed / 60;
    rig.update(1 / 60, schedule.rLaidAt(sim), sim);
    dist.push(camera.position.length());
    if (k === p.layEndFrame || k >= p.frames - 2 || k % 120 === 0) reach.push({ k, r: cornerReach(camera), curb: curbReach(camera) });
  }
  return { p, dist, reach, rig };
}

test('export camera: the whole finished panel and its curb are in frame at the end of the laying and to the last frame, for every aspect', () => {
  for (const [name, { width, height }] of Object.entries(PRESETS)) {
    for (const speed of [1, 2]) {
      const { p, reach } = runExportCamera(width / height, speed, true);
      const end = reach.filter(({ k }) => k >= p.layEndFrame);
      for (const { k, r, curb } of end) {
        assert.ok(r <= 1 - EXPORT_FIT.MARGIN + 0.03, `${name} ${speed}×: corners at ${r.toFixed(3)} of the half-frame on frame ${k}`);
        assert.ok(curb < 1, `${name} ${speed}×: the curb's corners at ${curb.toFixed(3)} of the half-frame on frame ${k}`);
      }
      // ...whereas the live end view crops them (why the export fits at all)
      const live = runExportCamera(width / height, speed, false);
      assert.ok(live.reach.at(-1).r > 1, `${name}: the live end view crops the corners (${live.reach.at(-1).r.toFixed(2)})`);
    }
  }
});

test('export camera: identical to the live path in the opening; the fit eases in with no jump', () => {
  for (const { width, height } of Object.values(PRESETS)) {
    for (const speed of [1, 2]) {
      const ex = runExportCamera(width / height, speed, true), live = runExportCamera(width / height, speed, false);
      // Until the framed radius reaches EXPORT_FIT.FROM the two paths are the same camera
      const k0 = ex.dist.findIndex((d, k) => Math.abs(d / live.dist[k] - 1) > 1e-9);
      assert.ok(k0 > 60 * 10 / speed, `the export camera leaves the live path only after ${(k0 / 60).toFixed(1)} s`);
      // Its frame-to-frame change in distance never exceeds the live path's own largest change
      const maxStep = d => Math.max(...d.slice(1).map((x, k) => Math.abs(Math.log(x / d[k]))));
      const maxAccel = d => Math.max(...d.slice(2).map((x, k) => Math.abs(Math.log(x / d[k + 1]) - Math.log(d[k + 1] / d[k]))));
      assert.ok(maxStep(ex.dist) <= maxStep(live.dist) + 1e-12, 'no faster than the live pull-back');
      assert.ok(maxAccel(ex.dist) <= maxAccel(live.dist) + 1e-12, 'no sharper than the live pull-back');
    }
  }
});

test('export camera: the live camera is unchanged by the export additions (zoom stays the user zoom)', () => {
  const camera = new THREE.PerspectiveCamera(32, 1.6, 0.1, 1200);
  const rig = createCameraRig(camera, fakeCanvas());
  for (let i = 0; i < 600; i++) rig.update(1 / 60, 73.5, 50 + i / 60);
  assert.equal(rig.zoom, 1);
  const el = FRAMING.EL0 + FRAMING.EL_GAIN;   // the finished view's elevation
  assert.ok(Math.abs(Math.asin(camera.position.y / camera.position.length()) - el) < 1e-3);
});
