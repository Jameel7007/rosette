// Flat SVG previews of pattern pieces, and rendering them to PNG in headless Chrome.
// For looking at the pattern engine's output without the 3D scene.
import { writeFileSync } from 'fs';
import { PAL } from '../../src/pattern/palette.js';
import { launch } from './browser.mjs';

const fmt = v => (Math.round(v * 1e4) / 1e4).toString();

/**
 * Draw pieces as a flat SVG: mortar background, each piece filled with its palette colour
 * (gold 'A' with a subtle gradient so it reads as metal), an optional construction-line
 * overlay. The plane's y axis points up (math convention), so counter-clockwise polygons look
 * counter-clockwise.
 *
 * @param {{poly: number[][], key?: string, fill?: string}[]} pieces  `fill` overrides `key`
 * @param {object} [opts]
 * @param {[number, number, number, number]} [opts.view]  [x0, y0, x1, y1] in pattern units;
 *   default: the pieces' bounding box plus a small margin
 * @param {number} [opts.px=1600]       output width in pixels (height follows the aspect)
 * @param {string} [opts.mortar='#bdb3a3'] background (grout / mortar) colour
 * @param {number[][][] | {lines?: number[][][], circles?: number[]}} [opts.lines]
 *   construction lines: segments [[x, y], [x, y]], or a sinopia object {lines, circles}
 * @param {string} [opts.lineColor='#b0382f'] overlay colour (sinopia red)
 * @param {number} [opts.lineWidth=1.2]  overlay stroke width in pixels
 * @param {string} [opts.outline]       if set, stroke every piece outline in this colour
 * @param {number[][]} [opts.dots]      points to mark (debugging)
 * @returns {string} SVG markup
 */
export function piecesToSVG(pieces, opts = {}) {
  const { px = 1600, mortar = '#bdb3a3', lines = null, lineColor = '#b0382f', lineWidth = 1.2, outline = null, dots = null } = opts;
  let view = opts.view;
  if (!view) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pieces) for (const [x, y] of p.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const m = 0.03 * Math.max(x1 - x0, y1 - y0);
    view = [x0 - m, y0 - m, x1 + m, y1 + m];
  }
  const [x0, y0, x1, y1] = view;
  const w = x1 - x0, h = y1 - y0;
  const pxH = Math.round((px * h) / w);
  const unit = w / px; // pattern units per pixel
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${pxH}" viewBox="${fmt(x0)} ${fmt(-y1)} ${fmt(w)} ${fmt(h)}">`);
  parts.push(`<defs><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#f1d58e"/><stop offset="0.45" stop-color="${PAL.A}"/><stop offset="1" stop-color="#9c7330"/></linearGradient></defs>`);
  parts.push(`<rect x="${fmt(x0)}" y="${fmt(-y1)}" width="${fmt(w)}" height="${fmt(h)}" fill="${mortar}"/>`);
  parts.push(`<g transform="scale(1,-1)"${outline ? ` stroke="${outline}" stroke-width="${fmt(unit * 0.8)}" stroke-linejoin="round"` : ''}>`);
  for (const p of pieces) {
    // Skip pieces entirely outside the view (keeps big previews light).
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (const [x, y] of p.poly) { px0 = Math.min(px0, x); px1 = Math.max(px1, x); py0 = Math.min(py0, y); py1 = Math.max(py1, y); }
    if (px1 < x0 || px0 > x1 || py1 < y0 || py0 > y1) continue;
    const fill = p.fill ?? (p.key === 'A' ? 'url(#gold)' : PAL[p.key] ?? '#8a8a8a');
    parts.push(`<polygon points="${p.poly.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ')}" fill="${fill}"/>`);
  }
  if (lines) {
    const segs = Array.isArray(lines) ? lines : lines.lines ?? [];
    const circles = Array.isArray(lines) ? [] : lines.circles ?? [];
    parts.push(`<g fill="none" stroke="${lineColor}" stroke-width="${fmt(unit * lineWidth)}" stroke-linecap="round" opacity="0.85">`);
    for (const [[ax, ay], [bx, by]] of segs) parts.push(`<line x1="${fmt(ax)}" y1="${fmt(ay)}" x2="${fmt(bx)}" y2="${fmt(by)}"/>`);
    for (const r of circles) parts.push(`<circle cx="0" cy="0" r="${fmt(r)}"/>`);
    parts.push('</g>');
  }
  if (dots) {
    parts.push(`<g fill="#e0218a">`);
    for (const [x, y] of dots) parts.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(unit * 3)}"/>`);
    parts.push('</g>');
  }
  parts.push('</g></svg>');
  return parts.join('\n');
}

/**
 * Render SVG markup to a PNG with headless Chrome (page.setContent, then a screenshot of the
 * SVG element).
 * @param {string} svg
 * @param {string} outPng
 * @param {{w?: number, h?: number, svgOut?: string}} [opts] viewport size (defaults to the
 *   SVG's own size); `svgOut` also writes the markup to a file
 */
export async function renderSVG(svg, outPng, opts = {}) {
  const w = opts.w ?? +(/width="(\d+)"/.exec(svg)?.[1] ?? 1600);
  const h = opts.h ?? +(/height="(\d+)"/.exec(svg)?.[1] ?? 1600);
  if (opts.svgOut) writeFileSync(opts.svgOut, svg);
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
    await page.locator('svg').first().screenshot({ path: outPng });
  } finally {
    await browser.close();
  }
}
