#!/usr/bin/env node
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

process.env.TSX_DISABLE_CACHE = '1';
await import('tsx/esm');
const { chromiumExecutable } = await import('../src/render.ts');
const { DEFAULT_DATA_DIR, ensureDataDirectory, safeHttpUrl } = await import('../src/model.ts');

export async function smokePlayback(landingUrl, { outputDir, timeoutMs = 45_000 } = {}) {
  if (!safeHttpUrl(landingUrl)) throw new Error('A valid HTTP(S) landing URL is required');
  outputDir = ensureDataDirectory(outputDir ?? await mkdtemp(path.join(ensureDataDirectory(path.join(DEFAULT_DATA_DIR, 'phase2b')), 'playback-smoke-')));
  const temp = ensureDataDirectory(path.join(outputDir, 'tmp'));
  process.env.TMPDIR = temp;
  const report = { passed: true, outputDir, viewports: [] };
  const browser = await chromium.launch({ headless: true, executablePath: await chromiumExecutable(), timeout: Math.max(timeoutMs, 45_000),
    artifactsDir: temp, downloadsPath: temp, env: { ...process.env, TMPDIR: temp } });
  try {
    for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: name === 'mobile', serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      await page.addInitScript(() => {
        window.__playbackCsp = [];
        document.addEventListener('securitypolicyviolation', event => {
          let blocked = event.blockedURI;
          try { blocked = new URL(blocked).origin; } catch {}
          window.__playbackCsp.push({ directive: event.effectiveDirective, blocked });
        });
      });
      const result = { name, currentTime: null, duration: null, playedSeconds: 0, cspErrors: [], screenshot: path.join(outputDir, `${name}.png`) };
      try {
        const response = await page.goto(landingUrl, { waitUntil: 'load', timeout: Math.max(timeoutMs, 45_000) });
        if (!response || response.status() >= 400) throw new Error('Landing page returned no successful response');
        await page.waitForFunction(() => customElements.get('mux-player') && document.querySelector('mux-player'));
        const start = await page.evaluate(() => {
          const player = document.querySelector('mux-player');
          player.muted = true; player.setAttribute('muted', ''); player.playbackRate = 1;
          window.__playbackError = '';
          Promise.resolve().then(() => player.play()).catch(() => { window.__playbackError = 'Player rejected play()'; });
          return Number(player.currentTime) || 0;
        });
        await page.waitForFunction(initial => {
          if (window.__playbackError) throw new Error(window.__playbackError);
          return document.querySelector('mux-player').currentTime > initial;
        }, start);
        const playingStart = await page.evaluate(() => document.querySelector('mux-player').currentTime);
        await page.waitForTimeout(8000);
        // Media clocks can lag wall time by a frame; require eight seconds of actual playback too.
        await page.waitForFunction(initial => document.querySelector('mux-player').currentTime - initial >= 8, playingStart);
        const state = await page.evaluate(() => {
          const player = document.querySelector('mux-player');
          const state = { currentTime: Number(player.currentTime), duration: Number(player.duration), paused: player.paused, ended: player.ended };
          player.pause();
          return state;
        });
        result.currentTime = state.currentTime; result.duration = state.duration;
        result.playedSeconds = state.currentTime - playingStart;
        if (!Number.isFinite(state.duration) || state.duration <= 0 || !Number.isFinite(result.playedSeconds) || result.playedSeconds < 7.5 || (state.paused && !state.ended)) {
          throw new Error('Player did not play continuously for eight seconds');
        }
      } catch (error) {
        report.passed = false;
        // Playwright errors may contain the internal-preview query token; report the failed stage without URL details.
        result.error = error.name === 'TimeoutError' ? 'Player loading or playback timed out' : (error.message.startsWith('Player ') || error.message.startsWith('Landing page ') ? error.message : 'Player loading or playback failed');
      } finally {
        const state = await page.evaluate(() => {
          const player = document.querySelector('mux-player');
          return { currentTime: Number(player?.currentTime), duration: Number(player?.duration), cspErrors: window.__playbackCsp ?? [] };
        }).catch(() => ({ currentTime: NaN, duration: NaN, cspErrors: [] }));
        result.currentTime = Number.isFinite(state.currentTime) ? state.currentTime : null;
        result.duration = Number.isFinite(state.duration) ? state.duration : null;
        result.cspErrors = state.cspErrors;
        try { await page.screenshot({ path: result.screenshot, fullPage: true, timeout: Math.max(timeoutMs, 45_000) }); }
        catch { result.screenshot = null; result.error ??= 'Screenshot failed'; report.passed = false; }
        report.viewports.push(result);
        await context.close();
      }
    }
  } finally { await browser.close(); }
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('Usage: node scripts/smoke-playback.mjs <landingUrl>'); process.exitCode = 1; }
  else {
    try {
      const report = await smokePlayback(process.argv[2]);
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    } catch { console.error('Playback smoke failed before capture; check Chromium/CHROMIUM_EXECUTABLE, the landing URL and the data directory.'); process.exitCode = 1; }
  }
}
