// The HUD: tile counter, stage name, progress bar, and the control buttons. The markup lives
// in index.html; this module only wires it up and keeps the text current.

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');

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

  return {
    /** "of 10,665 tesserae" */
    setTotal(total) { $('of').textContent = 'of ' + fmt.format(total) + ' tesserae'; },

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
