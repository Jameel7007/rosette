// The burned-in overlay of an export: the title and the live counter in one smoked-glass pill,
// drawn like the HUD (Marcellus for the title, Spline Sans Mono for the count; style.css).
//
// It is drawn with a 2D canvas over each rendered frame, because the HUD itself is HTML and is
// not part of the WebGL picture. Where it goes (overlayLayout) is pure, so the tests can check it
// keeps out of the panel's centre and out of the areas Reels and TikTok cover with their own UI.

const fmt = new Intl.NumberFormat('en-US');

/** The title burned into the video. */
const TITLE = 'Rosette in Tesserae';

/** The HUD's look (style.css :root), so the video matches the page. */
const STYLE = {
  INK: '#f3ece0',
  INK_DIM: '#cfc5b4',
  GLASS: 'rgba(28,24,20,.58)',
  LINE: 'rgba(243,236,224,.16)',
  DISPLAY: '"Marcellus", "Trajan Pro", Georgia, serif',
  MONO: '"Spline Sans Mono", ui-monospace, Menlo, Consolas, monospace',
  // The same stacks without the web fonts: used for a whole export when the web fonts are not
  // ready at its start, so a font arriving mid-export cannot change the typeface between frames
  DISPLAY_FALLBACK: '"Trajan Pro", Georgia, serif',
  MONO_FALLBACK: 'ui-monospace, Menlo, Consolas, monospace',
};

/** Sizes at a 1080-pixel short side; everything scales with the frame. */
const SIZE = {
  TITLE: 44, COUNT: 30, UNIT: 22,   // font sizes (px)
  PAD_X: 26, PAD_Y: 20, GAP: 10, RADIUS: 14, BLUR: 12,
  MARGIN: 56,                       // from the frame's left/top edge
  // Vertical (Reels/TikTok): the top ~9% carries the app's own header, the bottom ~20% the
  // caption and the right edge the like/comment/share column. The pill starts below the
  // header, at the left, and is far from both.
  TOP_VERTICAL: 0.1,
};

/**
 * Where the pill goes in a width × height frame.
 * @param {boolean} [webFonts=true]  false: the fallback font stacks (see STYLE)
 * @returns {{ x, y, scale, font: { title, count, unit } }}  top-left corner and the scale
 */
export function overlayLayout(width, height, webFonts = true) {
  const scale = Math.min(width, height) / 1080;
  const vertical = height > width * 1.2;
  const display = webFonts ? STYLE.DISPLAY : STYLE.DISPLAY_FALLBACK;
  const mono = webFonts ? STYLE.MONO : STYLE.MONO_FALLBACK;
  return {
    x: Math.round(SIZE.MARGIN * scale),
    y: Math.round(vertical ? height * SIZE.TOP_VERTICAL : SIZE.MARGIN * scale),
    scale,
    font: {
      title: `${Math.round(SIZE.TITLE * scale)}px ${display}`,
      count: `500 ${Math.round(SIZE.COUNT * scale)}px ${mono}`,
      unit: `400 ${Math.round(SIZE.UNIT * scale)}px ${mono}`,
    },
  };
}

/**
 * A rectangle that holds the pill whatever font it is drawn in (the title at up to 0.8 em per
 * glyph, the monospaced count at 0.62 em), plus its hairline. scripts/check-video.mjs blanks it
 * before comparing frames, so the counter, which changes every frame, cannot hide a frozen
 * picture behind it.
 * @returns {{ x, y, w, h }} in pixels
 */
export function overlayMask(width, height, { title = TITLE, total = 99999 } = {}) {
  const { x, y, scale: s } = overlayLayout(width, height);
  const count = fmt.format(total), unit = ` of ${count} tesserae`;
  const textW = Math.max(title.length * 0.8 * SIZE.TITLE, 0.62 * (count.length * SIZE.COUNT + unit.length * SIZE.UNIT));
  const pad = 4;   // the hairline and antialiasing
  return {
    x: Math.max(0, x - pad), y: Math.max(0, y - pad),
    w: Math.ceil((textW + 2 * SIZE.PAD_X) * s) + 2 * pad,
    h: Math.ceil((2 * SIZE.PAD_Y + SIZE.TITLE + SIZE.GAP + SIZE.COUNT) * s) + 2 * pad,
  };
}

/** The faces the overlay draws with (family, CSS font shorthand at any size). */
const OVERLAY_FACES = [
  { family: 'Marcellus', font: '44px Marcellus' },
  { family: 'Spline Sans Mono', font: '500 30px "Spline Sans Mono"' },
  { family: 'Spline Sans Mono', font: '400 22px "Spline Sans Mono"' },
];
/** Every character the overlay draws, so the right unicode-range subsets load. */
const OVERLAY_TEXT = `${TITLE} 0123456789, of tesserae`;

/** Resolves once the stylesheet `link` has loaded or failed (or at `deadline`, ms of page time). */
function stylesheetSettled(link, deadline) {
  // index.html loads the fonts stylesheet with media="print" and switches it to "all" on load
  // (so it never blocks the page). Until then its @font-face rules do not apply at all.
  if (!link || link.media === 'all') return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
    const done = () => { clearTimeout(timer); resolve(); };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
  });
}

/** Is a face of `family` known to the page and loaded? (Some browsers keep the quotes.) */
const faceLoaded = family => [...document.fonts].some(f => f.family.replace(/["']/g, '') === family && f.status === 'loaded');

/**
 * Loads the overlay's web fonts before an export starts. The page loads them without blocking,
 * so they may not be there yet.
 *
 * Why not just document.fonts.load() and check(): until the fonts stylesheet has arrived there
 * is no @font-face for Marcellus at all, and then load() resolves at once with nothing and
 * check() answers true (no face matches, so "nothing is left to load"). An export started then
 * measured the pill with Georgia and switched to Marcellus mid-file when the stylesheet came.
 * So this waits for the stylesheet, loads the faces, and only reports ready when a loaded face
 * of each family exists. Gives up after `timeoutMs`: the caller then draws the WHOLE export with
 * the fallback fonts (overlayLayout's webFonts = false), never a mix.
 * @returns {Promise<boolean>} true when every web font is ready
 */
export async function loadOverlayFonts(timeoutMs = 4000) {
  if (!document.fonts) return false;
  const deadline = performance.now() + timeoutMs;
  const sheet = document.querySelector('link[rel="stylesheet"][href*="fonts.googleapis.com"]');
  await stylesheetSettled(sheet, deadline);
  const loads = Promise.all(OVERLAY_FACES.map(f => document.fonts.load(f.font, OVERLAY_TEXT))).catch(() => {});
  await Promise.race([loads, new Promise(r => setTimeout(r, Math.max(0, deadline - performance.now())))]);
  return OVERLAY_FACES.every(f => faceLoaded(f.family) && document.fonts.check(f.font, OVERLAY_TEXT));
}

/**
 * An overlay painter for one export.
 * @param ctx      the 2D context of the frame canvas (export size)
 * @param total    pieces in the panel ("of 10,209 tesserae")
 * @param webFonts loadOverlayFonts() result: false draws with the fallback fonts throughout
 * @returns draw(source, landed): paints the pill over the frame already on `ctx`; `source` is
 *   the rendered WebGL canvas, blurred behind the pill like the HUD's backdrop-filter
 */
export function createOverlay(ctx, { width, height, total, title = TITLE, webFonts = true }) {
  const L = overlayLayout(width, height, webFonts);
  const s = L.scale;
  const unitText = ` of ${fmt.format(total)} tesserae`;

  // Measure once, for the widest count ("10,209"), so the pill never changes size
  ctx.save();
  ctx.font = L.font.title;
  const titleW = ctx.measureText(title).width;
  ctx.font = L.font.count;
  const countW = ctx.measureText(fmt.format(total)).width;
  ctx.font = L.font.unit;
  const unitW = ctx.measureText(unitText).width;
  ctx.restore();

  const padX = SIZE.PAD_X * s, padY = SIZE.PAD_Y * s, gap = SIZE.GAP * s;
  const titleH = SIZE.TITLE * s, countH = SIZE.COUNT * s;
  const w = Math.ceil(Math.max(titleW, countW + unitW) + 2 * padX);
  const h = Math.ceil(padY + titleH + gap + countH + padY);
  const { x, y } = L;
  const mask = overlayMask(width, height, { title, total });
  if (x + w > mask.x + mask.w) console.warn('overlay: the pill is wider than overlayMask allows; check-video would see the counter');

  return {
    box: { x, y, w, h },
    draw(source, landed) {
      ctx.save();
      // Smoked glass: the frame behind the pill, blurred, then the HUD's tint and hairline
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, SIZE.RADIUS * s);
      ctx.save();
      ctx.clip();
      if ('filter' in ctx) {
        ctx.filter = `blur(${Math.round(SIZE.BLUR * s)}px)`;
        const m = SIZE.BLUR * 2 * s;   // sample a little outside, so the blur has no dark rim
        ctx.drawImage(source, x - m, y - m, w + 2 * m, h + 2 * m, x - m, y - m, w + 2 * m, h + 2 * m);
        ctx.filter = 'none';
      }
      ctx.fillStyle = STYLE.GLASS;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeStyle = STYLE.LINE;
      ctx.stroke();

      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = STYLE.INK;
      ctx.font = L.font.title;
      ctx.fillText(title, x + padX, y + padY + titleH * 0.8);

      const baseline = y + padY + titleH + gap + countH * 0.8;
      const count = fmt.format(landed);
      ctx.font = L.font.count;
      ctx.fillText(count, x + padX, baseline);
      const cw = ctx.measureText(count).width;
      ctx.fillStyle = STYLE.INK_DIM;
      ctx.font = L.font.unit;
      ctx.fillText(unitText, x + padX + cw, baseline);
      ctx.restore();
    },
  };
}
