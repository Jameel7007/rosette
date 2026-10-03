// The Export video button and its panel. The markup lives in index.html (#export, #xp); this
// module wires it up and runs one export at a time through export/record.js.
//
// Three states, one visible at a time:
//   form  preset, speed, overlay, sound, the encoder that will be used, Start / Close; and the
//         last finished video, still downloadable, until a new export starts
//   run   progress (frames done / total, elapsed, time left) and Cancel; the HUD is hidden and
//         the frames being encoded are shown letterboxed to the window (#xp-frame), or, with
//         reduced motion, a still of the page as it was (#xp-still)
//   done  Download (a blob URL; the download is the viewer's own click) with the file's size,
//         and Close
// Escape closes the panel from the form and done states, never mid-export (Cancel is explicit).
// Closing never throws the finished file away: the form offers it again.

import { PRESETS, planExport } from '../export/plan.js';
import { chooseEncoding, recordVideo } from '../export/record.js';
import { createEta } from './eta.js';

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');

/** 61 → "1:01" */
function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** Bytes → "84.2 MB" */
const megabytes = bytes => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * @param o.host         the exporter's host (main.js): { T_END, count, schedule, canvas, begin, step,
 *                       redraw, contextLost, end, snapshot }
 * @param o.soundOn      () → the HUD's Sound toggle (the sound option's first default)
 * @param o.reduceMotion the viewer asked for reduced motion: the preview shows a still
 * @returns {{ ready(), unavailable() }}  ready(): the pieces are built, exports may start;
 *   unavailable(): this build cannot export (the prototype build)
 */
export function createExportPanel({ host, soundOn, reduceMotion = false }) {
  const button = $('export'), panel = $('xp'), form = $('xp-form');
  const views = { form, run: $('xp-run'), done: $('xp-done') };
  const preview = $('xp-frame'), still = $('xp-still');
  let state = 'closed';          // 'closed' | 'form' | 'run' | 'done'
  let controller = null;         // AbortController of the running export
  let last = null;               // the last finished video: { url, fileName, bytes, downloaded }
  let choice = null;             // the encoder the current options will use
  let probeId = 0;
  let opened = false;            // the sound option takes the HUD's state on the first open only
  const eta = createEta();

  const options = () => ({
    preset: form.elements.preset.value,
    speed: +form.elements.speed.value,
    overlay: form.elements.overlay.checked,
    sound: form.elements.sound.checked,
  });

  function show(view) {
    for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  }

  /** Asks the browser which encoder these options get, and says so under the options. */
  async function probe() {
    const id = ++probeId;
    const { preset, sound } = options();
    $('xp-start').disabled = true;
    $('xp-note').textContent = 'Checking this browser’s video encoders…';
    let enc = null;
    try { enc = await chooseEncoding(preset, sound); } catch (err) { console.warn('encoder check failed:', err); }
    if (id !== probeId) return;   // the options changed meanwhile
    choice = enc;
    $('xp-start').disabled = !enc;
    const { width, height } = PRESETS[preset];
    $('xp-note').textContent = !enc
      ? 'This browser cannot encode video.'
      : `${width}×${height} · 60 fps · ${enc.label}` + (enc.caution ? `. ${enc.caution}` : '');
  }

  /** The last finished video, offered in the form until a new export starts. */
  function showLast() {
    const row = $('xp-last');
    row.hidden = !last;
    if (!last) return;
    const link = $('xp-last-link');
    link.href = last.url;
    link.download = last.fileName;
    link.textContent = `Download last video (${megabytes(last.bytes)})`;
  }

  /** Releases the last video's memory (a new export is about to make another). */
  function dropLast() {
    if (!last) return;
    const old = last.url;
    last = null;
    // Give a download the viewer just started time to read the file before it is released
    setTimeout(() => URL.revokeObjectURL(old), 60_000);
    showLast();
  }

  function open() {
    if (state !== 'closed') return;
    state = 'form';
    // Lengths of the two speeds, from the timeline plan
    for (const speed of [1, 2]) $(`xp-len-${speed}`).textContent = `${clock(planExport({ T_END: host.T_END, speed }).duration)}`;
    if (!opened) form.elements.sound.checked = soundOn();
    opened = true;
    show('form');
    showLast();
    panel.hidden = false;
    document.body.classList.add('xp-open');
    button.setAttribute('aria-expanded', 'true');
    form.querySelector('input[name="preset"]:checked').focus();
    probe();
  }

  function close() {
    if (state === 'run' || state === 'closed') return;
    state = 'closed';
    panel.hidden = true;
    document.body.classList.remove('xp-open');
    button.setAttribute('aria-expanded', 'false');
    button.focus();
  }

  /** Progress from the recorder: frames done / total, elapsed and time left. */
  function onProgress({ phase, done, total, elapsedMs }) {
    const status = {
      prepare: 'Preparing', sound: 'Rendering the sound', encode: 'Rendering and encoding',
      gpu: 'Waiting for the graphics card', finish: 'Finishing the file',
    }[phase];
    if ($('xp-status').textContent !== status) $('xp-status').textContent = status;
    const pct = total ? (done / total) * 100 : 0;
    $('xp-bar').firstElementChild.style.width = pct.toFixed(2) + '%';
    $('xp-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
    $('xp-frames').textContent = `${fmt.format(done)} / ${fmt.format(total)} frames`;
    const left = phase === 'encode' ? eta.update(performance.now(), done, total) : NaN;
    $('xp-time').textContent = `${clock(elapsedMs / 1000)} elapsed` + (Number.isFinite(left) ? ` · about ${clock(left)} left` : '');
  }

  /** Behind the panel while recording: the frames as they are encoded, or a still (reduced motion). */
  function showPreview() {
    if (!reduceMotion) { preview.hidden = false; return; }
    // The encoded frames flash past at several times real speed; with reduced motion the
    // viewer sees the page as it was instead (the live panel is a still then anyway)
    still.width = host.canvas.width;
    still.height = host.canvas.height;
    host.snapshot(still.getContext('2d'));
    still.hidden = false;
  }

  async function start() {
    if (state !== 'form' || !choice) return;
    const opts = options();
    const encoding = choice;
    dropLast();
    state = 'run';
    controller = new AbortController();
    eta.reset();
    onProgress({ phase: 'prepare', done: 0, total: planExport({ T_END: host.T_END, speed: opts.speed }).frames, elapsedMs: 0 });
    $('xp-run-note').hidden = !encoding.realtime;
    $('xp-run-note').textContent = encoding.realtime ? 'Recording in real time: keep this tab in front.' : '';
    showPreview();
    show('run');
    document.body.classList.add('exporting');
    $('xp-cancel').focus();
    try {
      const result = await recordVideo({ host, ...opts, encoding, frameCanvas: preview, signal: controller.signal, onProgress });
      last = { url: URL.createObjectURL(result.blob), fileName: result.fileName, bytes: result.bytes, downloaded: false };
      const link = $('xp-download');
      link.href = last.url;
      link.download = result.fileName;
      link.textContent = `Download (${megabytes(result.bytes)})`;
      $('xp-result').textContent = `${result.fileName} · ${clock(result.frames / 60)} · made in ${clock(result.ms / 1000)}`;
      const notes = [];
      // Real-time recording can lose frames that no counter here sees (the recorder drops them
      // itself), so it always says so
      if (encoding.realtime) {
        notes.push('Recorded in real time: some frames may be missing'
          + (result.lateFrames > 0 ? ` (${fmt.format(result.lateFrames)} were drawn late).` : '.'));
      }
      if (result.gpuResets) notes.push('The graphics card was reset during the export; the frames it touched were drawn again.');
      if (!result.webFonts) notes.push('The title fonts had not loaded, so the video uses the fallback fonts.');
      const note = $('xp-done-note');
      note.hidden = !notes.length;
      note.textContent = notes.join(' ');
      state = 'done';
      show('done');
      link.focus();
    } catch (err) {
      state = 'form';
      show('form');
      $('xp-note').textContent = err?.name === 'AbortError' ? 'Export cancelled.' : `The export failed: ${err?.message ?? err}`;
      if (err?.name !== 'AbortError') console.error('export failed:', err);
      $('xp-start').focus();
    } finally {
      controller = null;
      preview.hidden = true;
      still.hidden = true;
      document.body.classList.remove('exporting');
    }
  }

  const markDownloaded = () => { if (last) last.downloaded = true; };
  button.addEventListener('click', () => (state === 'closed' ? open() : close()));
  form.addEventListener('submit', e => { e.preventDefault(); start(); });
  form.addEventListener('change', e => { if (e.target.name === 'preset' || e.target.name === 'sound') probe(); });
  $('xp-close').addEventListener('click', close);
  $('xp-finish').addEventListener('click', close);
  $('xp-download').addEventListener('click', markDownloaded);
  $('xp-last-link').addEventListener('click', markDownloaded);
  $('xp-cancel').addEventListener('click', () => controller?.abort());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (state === 'form' || state === 'done')) { e.preventDefault(); close(); }
  });
  // Leaving the page loses a running export or a video not yet downloaded: ask first
  window.addEventListener('beforeunload', e => {
    if (state === 'run' || (last && !last.downloaded)) { e.preventDefault(); e.returnValue = ''; }
  });

  return {
    ready() { button.disabled = false; },
    unavailable() { button.hidden = true; },
  };
}
