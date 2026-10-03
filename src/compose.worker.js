// The panel composition, run off the main thread.
//
// composePanel() is pure JavaScript (no three.js, no DOM) and takes ~0.4–0.6 s on a fast
// laptop, ~1 s at half that speed and ~2 s at a quarter (measured with Chrome's CPU throttle,
// scripts/verify-app.mjs). Run on the main thread, that is a frozen page right after the bed
// appears. In a worker the page stays responsive (drag, wheel, the HUD) while the polygons are
// cut, and the main thread only builds the meshes.
//
// main.js imports this file with `?worker&inline`, so Vite bundles it (and the pattern code it
// needs) into a string inside the main bundle: the single-file build stays one file.
//
// Message in:  composePanel options ({} for the default panel)
// Message out: { pieces, sinopia, stats, ms } (structured-cloned: plain arrays and objects)
import { composePanel } from './pattern/compose.js';

self.onmessage = e => {
  const t = performance.now();
  try {
    const { pieces, sinopia, stats } = composePanel(e.data ?? {});
    self.postMessage({ pieces, sinopia, stats, ms: Math.round(performance.now() - t) });
  } catch (err) {
    self.postMessage({ error: String(err && err.stack || err) });
  }
};
