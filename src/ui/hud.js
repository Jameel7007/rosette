// The HUD: tile counter, stage name, progress bar, and the control buttons. The markup lives
// in index.html; this module only wires it up and keeps the text current. It also chooses the
// stage label for the zellige pieces (createStageLabel).

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');

/** How the stage label is chosen (createStageLabel). */
export const LABEL = {
  WINDOW: 1.5,   // sim seconds: "what is being laid now" looks at pieces started this recently
  HOLD: 1.3,     // a new stage must cover 1.3× the current one's area in that window to take over
};

/** Signed area of a polygon [[x, y], ...] (the shoelace formula). */
function polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * The stage label for the zellige pieces: the stage covering the most AREA among the pieces
 * that started in the last LABEL.WINDOW seconds, with a little hysteresis.
 *
 * Why not simply "the stage of the latest piece" (the prototype's rule)? Zellige lays a
 * region's black strapwork together with the coloured pieces it outlines, so inside the
 * medallion the latest piece alternates kite, strap, strap, kite, ... and the label flickered
 * ~380 times over the run. Weighting by area names what the eye sees being laid: the thin
 * straps of a ring of petals cover less mortar than the petals. Measured on the default panel:
 * 12 label changes in 47 s, in laying order (Central 16-point star, Petal kites, Strapwork,
 * Petals, ..., Eight-point stars, Border).
 *
 * Cost per call: two binary searches plus one subtraction per stage (there are ~9), using
 * per-stage running totals built once here, so no loop over the pieces per frame.
 *
 * @param pieces  in laying order (schedule.pieces), each with { poly, stage }
 * @param t0      start time of each piece (schedule.t0), ascending
 * @returns at(sim) → label or null (nothing started yet)
 */
export function createStageLabel(pieces, t0, { window = LABEL.WINDOW, hold = LABEL.HOLD } = {}) {
  const N = pieces.length;
  const stages = [...new Set(pieces.map(p => p.stage))];
  const index = new Map(stages.map((s, k) => [s, k]));
  // area[k][i] = total area of stage-k pieces among the first i pieces
  const area = stages.map(() => new Float64Array(N + 1));
  for (let i = 0; i < N; i++) {
    const k = index.get(pieces[i].stage), a = Math.abs(polyArea(pieces[i].poly));
    for (let s = 0; s < stages.length; s++) area[s][i + 1] = area[s][i] + (s === k ? a : 0);
  }
  /** Pieces with t0 ≤ sim (t0 is sorted, so binary search). */
  const startedBy = sim => {
    let lo = 0, hi = N;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (t0[mid] <= sim) lo = mid + 1; else hi = mid; }
    return lo;
  };

  let current = -1, lastSim = -Infinity;
  return function at(sim) {
    if (sim < lastSim) current = -1;   // Replay or a seek back: start fresh
    lastSim = sim;
    const b = startedBy(sim), a = startedBy(sim - window);
    if (b === 0) return null;
    // Stage with the most area among pieces a .. b-1 (the latest one, if the window is empty)
    let best = index.get(pieces[b - 1].stage), bestArea = 0;
    for (let s = 0; s < stages.length; s++) {
      const v = area[s][b] - area[s][a];
      if (v > bestArea) { bestArea = v; best = s; }
    }
    const currentArea = current >= 0 ? area[current][b] - area[current][a] : 0;
    if (current < 0 || bestArea > currentArea * hold) current = best;
    return stages[current];
  };
}

/**
 * @param handlers {
 *   replay(), finish(), sweep(),
 *   speed() → the new speed (number),
 *   sound() → the new on/off state (boolean),
 * }
 */
export function createHud(handlers) {
  $('replay').onclick = () => handlers.replay();
  $('finish').onclick = () => handlers.finish();
  $('sweep').onclick = () => handlers.sweep();
  $('speed').onclick = () => { $('speed').textContent = 'Speed ' + handlers.speed() + '×'; };
  $('sound').onclick = () => {
    const on = handlers.sound();
    $('sound').setAttribute('aria-pressed', String(on));
    $('sound').textContent = on ? 'Sound on' : 'Sound off';
  };

  let lastLanded = -1;
  let sweeping = false;

  return {
    /**
     * Lights the Sweep light button (gold, "Sweeping…") while a sweep runs, the automatic one
     * after the last piece included, so pressing it visibly does something at once.
     */
    setSweeping(on) {
      if (on === sweeping) return;
      sweeping = on;
      $('sweep').setAttribute('aria-pressed', String(on));
      $('sweep').textContent = on ? 'Sweeping…' : 'Sweep light';
    },

    /** "of 10,209 tesserae" */
    setTotal(total) { $('of').textContent = 'of ' + fmt.format(total) + ' tesserae'; },

    /** The line under the title (the legacy build names its own pattern). */
    setSubtitle(text) { $('sub').textContent = text; },

    /** Replaces the stage line (e.g. to say the panel could not be built). */
    setStage(text) { $('stage').textContent = text; },

    /**
     * Refreshes the counter, bar and stage label, only when the landed count changes (as in
     * the prototype: the stage label moves on when a tile of the new stage lands).
     * @param s { landed, started, total, stage }
     */
    update({ landed, started, total, stage }) {
      if (landed === lastLanded) return;
      lastLanded = landed;
      $('n').textContent = fmt.format(landed);
      $('bar').style.width = (landed / total * 100).toFixed(2) + '%';
      $('stage').textContent = landed >= total ? 'Complete' : (started === 0 ? 'Preparing the bed' : stage);
    },
  };
}
