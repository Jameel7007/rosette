// Headless Chrome on the real GPU (Metal via ANGLE), for screenshots and fps checks.
// Uses the Chrome for Testing build already in the Playwright cache.
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { chromium } from 'playwright-core';

const cache = `${homedir()}/Library/Caches/ms-playwright`;
const found = existsSync(cache) && readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort().pop();
// Order: CHROME_PATH, the Playwright cache's Chrome for Testing, then the installed Google Chrome
// (the cache can be cleared by disk clean-up tools, which silently broke every script once).
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const executablePath = process.env.CHROME_PATH
  || (found && `${cache}/${found}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  || (existsSync(systemChrome) ? systemChrome : undefined);

export function launch(opts = {}) {
  return chromium.launch({
    executablePath,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    ...opts,
  });
}

/** Collect console errors/warnings and page errors from a page into an array. */
export function collectConsole(page) {
  const log = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') log.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));
  return log;
}
