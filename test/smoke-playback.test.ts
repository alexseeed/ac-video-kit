import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_DATA_DIR } from '../src/model.js';
import { mediaCommand, videoEncoder } from '../src/render.js';
import { testDir } from './helpers.js';

const script = path.resolve(import.meta.dirname, '../scripts/smoke-playback.mjs');
const { smokePlayback } = await import(new URL('../scripts/smoke-playback.mjs', import.meta.url).href);

async function fixture(t: any, realVideo = false) {
  let video: Buffer | undefined;
  if (realVideo) {
    const file = path.join(testDir('smoke-media'), 'fixture.mp4');
    await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=64x64:rate=10', '-t', '20', '-c:v', videoEncoder(), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
    video = await readFile(file);
  }
  const server = createServer((request, response) => {
    const route = new URL(request.url!, 'http://127.0.0.1').pathname;
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${route === '/blocked' ? "'none'" : "'self'"}; style-src 'unsafe-inline'`);
    if (route === '/player.js' || route === '/stalled-player.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(video && route === '/player.js' ? `customElements.define('mux-player', class extends HTMLElement {
        connectedCallback() { this.video = document.createElement('video'); this.video.src = '/fixture.mp4'; this.video.playsInline = true; this.video.controls = true; this.video.style.cssText = 'width:100%;height:100%'; this.append(this.video); }
        get currentTime() { return this.video.currentTime; } get duration() { return this.video.duration; }
        get paused() { return this.video.paused; } get ended() { return this.video.ended; }
        get muted() { return this.video.muted; } set muted(value) { this.video.muted = value; }
        set playbackRate(value) { this.video.playbackRate = value; }
        play() { if (!this.muted) return Promise.reject(new Error('Smoke must mute playback')); return this.video.play(); }
        pause() { this.video.pause(); }
      });` : `customElements.define('mux-player', class extends HTMLElement {
        _start = null; _offset = 0; duration = 30; paused = true; ended = false;
        get currentTime() { return this._offset + (this._start === null ? 0 : (performance.now() - this._start) / 1000); }
        play() { if (!this.muted) return Promise.reject(new Error('Smoke must mute playback')); this.paused = false; ${route === '/player.js' ? 'this._start = performance.now();' : ''} return Promise.resolve(); }
        pause() { this._offset = this.currentTime; this._start = null; this.paused = true; }
      });`);
    } else if (route === '/fixture.mp4' && video) {
      response.setHeader('Content-Type', 'video/mp4'); response.setHeader('Content-Length', video.length); response.end(video);
    } else if (['/good', '/blocked', '/stalled'].includes(route)) {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lokaler Player-Fake</title><script defer src="${route === '/stalled' ? '/stalled-player.js' : '/player.js'}"></script><style>body{font:20px system-ui;background:#111827;color:white}mux-player{display:block;height:240px;background:#007aff}</style><h1>Offline Playback Smoke</h1><mux-player aria-label="Lokaler Player-Fake">Lokaler Player-Fake</mux-player></html>`);
    } else { response.statusCode = 404; response.end('Local fixture: no player'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function cli(url: string, t: any) {
  const child = spawn(process.execPath, [script, url], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
  t.after(() => { child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}

test('playback smoke CLI uses Chromium, samples eight muted seconds and saves desktop/mobile evidence', { timeout: 300_000 }, async t => {
  const base = await fixture(t, true), result = await cli(base + '/good', t);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.ok(report.outputDir.startsWith(path.join(DEFAULT_DATA_DIR, 'phase2b') + path.sep));
  assert.deepEqual(report.viewports.map((viewport: any) => viewport.name), ['desktop', 'mobile']);
  for (const viewport of report.viewports) {
    assert.ok(viewport.playedSeconds >= 7.5); assert.equal(viewport.duration, 20); assert.ok(viewport.currentTime >= 8);
    assert.deepEqual(viewport.cspErrors, []);
    const png = await readFile(viewport.screenshot); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(report.outputDir, 'report.json'), 'utf8')), report);
});

test('playback smoke detects missing definition with CSP evidence and a stalled player', { timeout: 300_000 }, async t => {
  const base = await fixture(t);
  for (const route of ['blocked', 'stalled']) {
    const report = await smokePlayback(`${base}/${route}?internal=offline-private-query`, { outputDir: testDir(`smoke-${route}`), timeoutMs: 2000 });
    assert.equal(report.passed, false);
    assert.doesNotMatch(JSON.stringify(report), /offline-private-query/);
    assert.ok(report.viewports.every((viewport: any) => viewport.error));
    if (route === 'blocked') assert.ok(report.viewports.every((viewport: any) => viewport.cspErrors.some((error: any) => error.directive === 'script-src-elem')));
    else assert.ok(report.viewports.every((viewport: any) => viewport.duration === 30 && viewport.currentTime === 0));
  }
});

test('playback smoke CLI exits one for a local page without a player', { timeout: 300_000 }, async t => {
  const base = await fixture(t), result = await cli(base + '/missing', t);
  assert.equal(result.code, 1, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).passed, false);
  await assert.rejects(smokePlayback('file:///not-a-landing'), /HTTP\(S\)/);
});
