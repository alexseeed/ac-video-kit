import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { DEFAULT_DATA_DIR, validateCampaign, type Campaign } from '../src/model.js';
import { chromiumExecutable } from '../src/render.js';
import { campaignFixture } from '../test/helpers.js';

const outputDir = path.join(DEFAULT_DATA_DIR, 'landing-phase2');
await mkdir(path.join(outputDir, 'tmp'), { recursive: true });
process.env.TMPDIR = path.join(outputDir, 'tmp');
const options = { dataDir: path.join(outputDir, 'db-' + Date.now()), publicBaseUrl: 'http://127.0.0.1', apiKeys: ['offline-api-key-01'], workerToken: 'offline-worker-token', internalViewToken: 'offline-internal', previewSecret: 'offline-preview-secret', dispatch: false };
const app = createApp(options);
await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
options.publicBaseUrl += ':' + (app.server.address() as any).port;
const pilotFile = path.join(DEFAULT_DATA_DIR, 'campaigns/demo-kampagne/campaign.json');
const campaign: Campaign = existsSync(pilotFile) ? JSON.parse(await readFile(pilotFile, 'utf8')) : campaignFixture();
// A custom campaign host is replaced only in this offline screenshot database.
delete campaign.domain;
const durationSec = campaign.pages.at(-1)!.end;
validateCampaign(campaign, durationSec); app.store.campaignPut(campaign, durationSec);
const video = app.store.upsertVideo(campaign.id, { variables: { website_0: 'http://127.0.0.1', website_4: 'http://127.0.0.1', first_name: 'Max', company_name: 'Beispiel GmbH', email: 'max@example.invalid' } });
const job = app.store.claim(1)[0]; app.store.complete(job.id, { muxAssetId: 'offline-asset', playbackId: 'offline-playback', videoFileUrl: 'https://stream.mux.com/offline-playback/highest.mp4', backgroundRecordedAt: '2026-10-15T00:00:00.000Z', durationSec, leaseToken: job.leaseToken });
const pilotPoster = path.join(DEFAULT_DATA_DIR, 'calibration/landing-poster.png');
let posterPath = pilotPoster;
if (!existsSync(posterPath)) {
  const renderDirs = (await readdir(path.join(DEFAULT_DATA_DIR, 'render-tests'))).filter(s => s.startsWith('render-acceptance-')).sort();
  assert.ok(renderDirs.length, 'Run the render acceptance first');
  posterPath = path.join(DEFAULT_DATA_DIR, 'render-tests', renderDirs.at(-1)!, 'segment-1.png');
}
const poster = await readFile(posterPath);
const browser = await chromium.launch({ headless: true, executablePath: await chromiumExecutable(), artifactsDir: process.env.TMPDIR, downloadsPath: process.env.TMPDIR, env: { ...process.env, TMPDIR: process.env.TMPDIR } });
const screenshots: string[] = [];
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, userAgent: 'Mozilla/5.0 OfflineAcceptance', serviceWorkers: 'block' });
    // Offline fake player supplies a native keyboard-accessible control surface; real Mux is never contacted.
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith(options.publicBaseUrl)) return route.continue();
      if (url.startsWith('https://image.mux.com/')) return route.fulfill({ contentType: 'image/png', body: poster });
      if (url.startsWith('https://cdn.jsdelivr.net/')) return route.fulfill({ contentType: 'application/javascript', body: `customElements.define('mux-player',class extends HTMLElement{connectedCallback(){const root=this.attachShadow({mode:'open'});root.innerHTML='<style>video{width:100%;height:100%;display:block}</style><video controls aria-label="Offline Testvideo"></video>';root.querySelector('video').poster=this.getAttribute('poster');}});` });
      if (url.startsWith('https://calendly.com/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="de"><meta charset="utf-8"><style>body{font:16px system-ui;color:#1a1a1a;padding:28px;line-height:1.6}h1{font-size:24px}.times{display:grid;gap:12px}button{padding:16px;border:1px solid #007aff;background:white;border-radius:8px;color:#005abd;font:inherit;text-align:left}</style><p>Beispiel GmbH</p><h1>Skalierungs-Call</h1><p>30 Minuten · Videokonferenz</p><hr><h2>Termin auswählen</h2><p>Lokale Kalendervorschau für die Layoutprüfung</p><div class="times"><button>Vormittag</button><button>Nachmittag</button></div></html>' });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.goto(options.publicBaseUrl + `/video/${video.shortId}`, { waitUntil: 'networkidle' });
    assert.ok(await page.locator('h1').textContent());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const cta = page.locator('a.cta'); await cta.focus(); assert.equal(await cta.evaluate(el => document.activeElement === el), true);
    const playerBox = (await page.locator('mux-player').boundingBox())!, titleBox = (await page.locator('h1').boundingBox())!;
    assert.ok(titleBox.y >= playerBox.y + playerBox.height, 'title is below player');
    if (campaign.landing.calendlyEmbedUrl) {
      const calendar = (await page.locator('section.calendar').boundingBox())!;
      if (width > 850) assert.ok(calendar.x >= playerBox.x + playerBox.width, 'desktop calendar beside player');
      else assert.ok(calendar.y >= titleBox.y + titleBox.height, 'mobile calendar below video details');
    }
    const background = campaign.landing.backgroundColor ?? '#111827';
    const channels = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), `rgb(${channels.join(', ')})`);
    const image = path.join(outputDir, `${name}.png`); await page.screenshot({ path: image, fullPage: true }); screenshots.push(image);
    await context.close();
  }
  const events = app.store.db.prepare("SELECT trigger,count(*) count FROM events GROUP BY trigger").all();
  assert.equal((events.find((row: any) => row.trigger === 'VIDEO_VIEWED') as any)?.count, 2);
  assert.equal((events.find((row: any) => row.trigger === 'VIDEO_FIRST_VIEWED') as any)?.count, 1);
  const preview = await browser.newContext({ serviceWorkers: 'block' });
  await preview.route('**/*', route => route.request().url().startsWith(options.publicBaseUrl) ? route.continue() : route.abort());
  const internalPage = await preview.newPage();
  await internalPage.goto(options.publicBaseUrl + `/video/${video.shortId}?internal=offline-internal`, { waitUntil: 'networkidle' });
  assert.equal(await internalPage.locator('.internal').textContent(), 'Interne Vorschau · Tracking deaktiviert');
  assert.equal((app.store.db.prepare("SELECT count(*) n FROM events WHERE trigger='VIDEO_VIEWED'").get() as any).n, 2);
  await preview.close();
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ screenshots, campaignId: campaign.id, pilotCampaign: existsSync(pilotFile), posterPath, viewportChecks: [1440, 390], fakeMuxPlayer: true, fakeCalendly: true, internalPreview: true, externalNetwork: false, events }, null, 2));
  console.log(JSON.stringify({ screenshots, status: 'PASS', fakeMuxPlayer: true }));
} finally { await browser.close(); await app.close(); }
