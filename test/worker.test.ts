import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { errors, type Browser } from 'playwright';
import { campaignFixture, testDir } from './helpers.js';
import { MuxClient, Worker, type UploadSlot } from '../src/worker.js';
import { dataDirectory, localAsset, mediaCommand, probe, RenderError, Screenshotter, Semaphore, segmentArguments, segmentFrames, videoEncoder } from '../src/render.js';
import { createApp } from '../src/server.js';
import { main } from '../src/cli.js';

const recordedAt = '2026-10-15T12:00:00.000Z';
const staticRenditions = { files: [{ resolution: 'highest', status: 'ready', name: 'highest.mp4', ext: 'mp4' }] };
const mp4 = (playback: string) => `https://stream.mux.com/${playback}/highest.mp4`;

async function localServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(error => { response.statusCode = 500; response.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
async function body(request: IncomingMessage) { let value = ''; for await (const bytes of request) value += bytes; return JSON.parse(value); }
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function captureBrowser(screenshots: Screenshotter, overrides: Record<string, unknown> = {}) {
  let contextCloses = 0;
  const page = {
    async goto() { return { status: () => 200 }; },
    async addStyleTag() {}, async evaluate() { return 0; },
    async waitForTimeout() {}, async waitForLoadState() {}, async screenshot() { return Buffer.alloc(0); },
    ...overrides
  };
  const browser = { async newContext() { return { async newPage() { return page; }, async close() { contextCloses++; } }; }, async close() {} };
  // Exercise capture's deadline/error handling without browser startup or host load.
  (screenshots as unknown as { browser: Promise<Browser> }).browser = Promise.resolve(browser as unknown as Browser);
  return { contextCloses: () => contextCloses };
}

test('encoder and frame boundaries are identical for cached and personalized segments', () => {
  const campaign = campaignFixture();
  const personal = segmentArguments(campaign, 0, 'website.png', 'base.mp4', 'mask.png', 'a.mp4');
  const fixed = segmentArguments(campaign, 1, 'page2.png', 'base.mp4', 'mask.png', 'b.mp4');
  for (const option of ['-c:v', '-allow_sw', '-b:v', '-pix_fmt', '-profile:v', '-level:v', '-g', '-bf', '-force_key_frames', '-video_track_timescale', '-r']) assert.equal(personal[personal.indexOf(option) + 1], fixed[fixed.indexOf(option) + 1]);
  assert.equal(personal[personal.indexOf('-an')], '-an');
  assert.equal(personal[personal.indexOf('-frames:v') + 1], '120');
  assert.equal(segmentFrames(0, 4, 30) + segmentFrames(4, 8, 30) + segmentFrames(8, 12, 30), 360);
  assert.match(personal[personal.indexOf('-filter_complex') + 1], /alphamerge/);
});

test('segment encoder follows VIDEO_ENCODER with platform default and rejects invalid values', () => {
  const campaign = campaignFixture(), before = process.env.VIDEO_ENCODER;
  const args = () => segmentArguments(campaign, 0, 'bg.png', 'base.mp4', 'mask.png', 'out.mp4');
  try {
    delete process.env.VIDEO_ENCODER;
    const fallback = args();
    assert.equal(fallback[fallback.indexOf('-c:v') + 1], process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264');
    process.env.VIDEO_ENCODER = 'h264_videotoolbox';
    const hw = args();
    assert.equal(hw[hw.indexOf('-c:v') + 1], 'h264_videotoolbox');
    assert.equal(hw[hw.indexOf('-allow_sw') + 1], '0');
    assert.equal(hw.includes('-preset'), false);
    process.env.VIDEO_ENCODER = 'libx264';
    const sw = args();
    assert.equal(sw[sw.indexOf('-c:v') + 1], 'libx264');
    assert.equal(sw.includes('-allow_sw'), false);
    assert.equal(sw[sw.indexOf('-preset') + 1], 'veryfast');
    for (const option of ['-b:v', '-pix_fmt', '-profile:v', '-level:v', '-g']) assert.equal(sw[sw.indexOf(option) + 1], hw[hw.indexOf(option) + 1]);
    process.env.VIDEO_ENCODER = 'bogus';
    assert.throws(args, /VIDEO_ENCODER/);
  } finally {
    if (before === undefined) delete process.env.VIDEO_ENCODER;
    else process.env.VIDEO_ENCODER = before;
  }
});

test('segment bitrate defaults to 4500k and follows the campaign output field', () => {
  const campaign = campaignFixture();
  const fallback = segmentArguments(campaign, 0, 'website.png', 'base.mp4', 'mask.png', 'a.mp4');
  assert.equal(fallback[fallback.indexOf('-b:v') + 1], '4500k');
  campaign.output.videoBitrateKbps = 500;
  for (const page of [0, 1]) {
    const args = segmentArguments(campaign, page, 'bg.png', 'base.mp4', 'mask.png', 'out.mp4');
    assert.equal(args[args.indexOf('-b:v') + 1], '500k');
  }
});

test('semaphore bounds concurrency and one failed task leaves other tasks runnable', async () => {
  const semaphore = new Semaphore(2); let active = 0, peak = 0;
  const results = await Promise.allSettled(Array.from({ length: 9 }, (_, index) => semaphore.run(async () => { active++; peak = Math.max(active, peak); try { await new Promise(resolve => setTimeout(resolve, 3)); if (index === 2) throw new Error('expected'); return index; } finally { active--; } })));
  assert.equal(peak, 2); assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
  assert.throws(() => new Semaphore(0));
});

test('asset paths and output data root prevent directory and symlink escapes', async () => {
  const dir = testDir('asset'), sibling = testDir('sibling');
  await writeFile(path.join(dir, 'image.png'), 'fixture');
  await writeFile(path.join(sibling, 'other.png'), 'fixture');
  await symlink(path.join(sibling, 'other.png'), path.join(dir, 'escape.png'));
  assert.equal(await localAsset(dir, 'image.png'), path.join(dir, 'image.png'));
  await assert.rejects(localAsset(dir, '../other.png'));
  await assert.rejects(localAsset(dir, 'escape.png'), /escapes/);
  await assert.rejects(localAsset(dir, '.env'), /relative local files/);
  await assert.rejects(dataDirectory(path.resolve(import.meta.dirname, '..')), /DATA_DIR/);
});

test('website capture has one deadline across navigation and screenshot work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const dataDir = testDir('capture-timeout'), screenshots = new Screenshotter(dataDir, 1, 45_000);
  const screenshotStarted = gate(), timeouts: number[] = [];
  const browser = captureBrowser(screenshots, {
    async goto(_url: string, options: { timeout: number }) { timeouts.push(options.timeout); t.mock.timers.tick(20_000); return { status: () => 200 }; },
    async screenshot(options: { timeout: number }) { timeouts.push(options.timeout); screenshotStarted.release(); return await new Promise<never>(() => {}); }
  });
  let settled = false;
  const capture = screenshots.capture('http://capture.invalid', path.join(dataDir, 'never.png'));
  void capture.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(capture, (error: unknown) => error instanceof RenderError && error.reason === 'render_failed');
  try {
    await screenshotStarted.promise;
    assert.deepEqual(timeouts, [45_000, 25_000], 'screenshot receives only the navigation deadline remainder');
    t.mock.timers.tick(24_999); await Promise.resolve(); assert.equal(settled, false);
    t.mock.timers.tick(1); await rejected;
    assert.ok(browser.contextCloses() >= 1, 'expiration closes its browser context');
  } finally { await screenshots.close(); }
});

test('website capture distinguishes unreachable websites from timeouts and capture failures', async t => {
  const cases = [
    { name: 'DNS failure', navigationError: new Error('page.goto: net::ERR_NAME_NOT_RESOLVED'), reason: 'website_unreachable' },
    { name: 'connection failure', navigationError: new Error('page.goto: net::ERR_CONNECTION_REFUSED'), reason: 'website_unreachable' },
    { name: 'missing response', response: null, reason: 'website_unreachable' },
    { name: 'HTTP 404', response: { status: () => 404 }, reason: 'website_unreachable' },
    { name: 'HTTP 503', response: { status: () => 503 }, reason: 'website_unreachable' },
    { name: 'navigation timeout', navigationError: new errors.TimeoutError('page.goto: Timeout exceeded'), reason: 'render_failed' },
    { name: 'screenshot timeout after HTTP success', captureError: new errors.TimeoutError('page.screenshot: Timeout exceeded'), reason: 'render_failed' },
    { name: 'capture failure after HTTP success', captureError: new Error('page.screenshot: Target closed'), reason: 'render_failed' }
  ];
  for (const fixture of cases) await t.test(fixture.name, async () => {
    const dataDir = testDir('capture-classification'), screenshots = new Screenshotter(dataDir);
    const browser = captureBrowser(screenshots, {
      async goto() { if (fixture.navigationError) throw fixture.navigationError; return 'response' in fixture ? fixture.response : { status: () => 200 }; },
      async screenshot() { throw fixture.captureError || new Error('must reject before taking a screenshot'); }
    });
    try {
      await assert.rejects(screenshots.capture('http://capture.invalid', path.join(dataDir, 'capture.png')), (error: unknown) => error instanceof RenderError && error.reason === fixture.reason);
      assert.equal(browser.contextCloses(), 1);
    } finally { await screenshots.close(); }
  });
});

test('screenshot timeout defaults to 45 seconds and accepts only positive integer environment values', async t => {
  t.mock.method(Date, 'now', () => 1000);
  const previous = process.env.SCREENSHOT_TIMEOUT_MS;
  t.after(() => { if (previous === undefined) delete process.env.SCREENSHOT_TIMEOUT_MS; else process.env.SCREENSHOT_TIMEOUT_MS = previous; });
  const dataDir = testDir('capture-config');
  async function navigationTimeout() {
    const screenshots = new Screenshotter(dataDir); let timeout = 0;
    captureBrowser(screenshots, { async goto(_url: string, options: { timeout: number }) { timeout = options.timeout; throw new errors.TimeoutError('fixture timeout'); } });
    try { await assert.rejects(screenshots.capture('http://capture.invalid', path.join(dataDir, 'capture.png')), /render_failed/); return timeout; }
    finally { await screenshots.close(); }
  }
  delete process.env.SCREENSHOT_TIMEOUT_MS;
  assert.equal(await navigationTimeout(), 45_000);
  process.env.SCREENSHOT_TIMEOUT_MS = '90000';
  assert.equal(await navigationTimeout(), 90_000);
  for (const invalid of ['0', '-1', '1.5', 'no-timeout', 'Infinity', '2147483648']) {
    process.env.SCREENSHOT_TIMEOUT_MS = invalid;
    assert.throws(() => new Screenshotter(dataDir), /SCREENSHOT_TIMEOUT_MS/);
  }
});

test('website capture includes full body scroll height and caps the image at 8000 pixels', { timeout: 180_000 }, async () => {
  const dataDir = testDir('capture-full-height'), output = path.join(dataDir, 'full.png');
  const server = await localServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><style>body{margin:0}main{height:9500px;background:linear-gradient(white,blue)}.band{position:absolute;left:100px;top:7900px;width:200px;height:1600px;background:#000}</style><main>Long local website</main><div class="band"></div>'); });
  const screenshots = new Screenshotter(dataDir, 1, 120_000);
  try { await screenshots.capture(server.url, output); const image = (await probe(output)).streams[0]; assert.equal(image.width, 1920); assert.equal(image.height, 8000); }
  finally { await screenshots.close(); await server.close(); }
});

test('fake Mux direct upload uses basic/public/passthrough and restart reuses ready asset', async () => {
  const dataDir = testDir('mux'), file = path.join(dataDir, 'video.mp4'); await writeFile(file, 'fake-local-video');
  let created = 0, puts = 0, reads = 0, base = '';
  const server = await localServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('fake-id:fake-secret').toString('base64'));
      const value = await body(request); assert.deepEqual(value.new_asset_settings, { video_quality: 'basic', playback_policies: ['public'], max_resolution_tier: '1080p', passthrough: 'test-video', static_renditions: [{ resolution: 'highest' }] });
      created++; response.end(JSON.stringify({ data: { id: 'upload-1', url: base + '/bytes' } }));
    } else if (request.method === 'PUT') { let bytes = ''; for await (const chunk of request) bytes += chunk; assert.equal(bytes, 'fake-local-video'); puts++; response.end('{}'); }
    else if (request.url?.startsWith('/video/v1/uploads/upload-1')) response.end(JSON.stringify({ data: puts ? { id: 'upload-1', status: 'asset_created', asset_id: 'asset-1' } : { id: 'upload-1', status: 'waiting', url: base + '/bytes' } }));
    else { reads++; response.end(JSON.stringify({ data: { id: 'asset-1', status: reads === 1 ? 'preparing' : 'ready', static_renditions: { files: [{ resolution: 'highest', status: reads < 3 ? 'preparing' : 'ready', name: 'highest.mp4', ext: 'mp4' }] }, duration: 12, passthrough: 'test-video', playback_ids: [{ id: 'public-1', policy: 'public' }] } })); }
  }); base = server.url;
  try {
    const options = { baseUrl: base, dataDir, tokenId: 'fake-id', tokenSecret: 'fake-secret', pollMs: 0 };
    const result = await new MuxClient(options).upload('test-video', file);
    assert.deepEqual(result, { muxAssetId: 'asset-1', playbackId: 'public-1', durationSec: 12, videoFileUrl: mp4('public-1') });
    assert.deepEqual(await new MuxClient(options).resume('test-video'), result);
    assert.deepEqual(await new MuxClient(options).upload('test-video', file), result);
    assert.equal(created, 1); assert.equal(puts, 1); assert.equal(reads, 3, 'asset ready alone does not complete before the MP4 is ready');
    const ledger = await readFile(path.join(dataDir, 'mux-ledger', 'test-video.json'), 'utf8');
    assert.doesNotMatch(ledger, /fake-secret|\/bytes|Basic/);
  } finally { await server.close(); }
});

test('restart after create/ledger crash locates passthrough without another upload POST', async () => {
  const dataDir = testDir('mux-recover'); await mkdir(path.join(dataDir, 'mux-ledger'));
  await writeFile(path.join(dataDir, 'mux-ledger', 'crashed-video.json'), JSON.stringify({ creating: true }));
  let creates = 0;
  const server = await localServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') { creates++; response.end('{}'); }
    else if (request.url?.includes('/assets?')) response.end(JSON.stringify({ data: [{ id: 'found', status: 'ready', passthrough: 'crashed-video' }] }));
    else response.end(JSON.stringify({ data: { id: 'found', status: 'ready', static_renditions: staticRenditions, duration: 12, playback_ids: [{ id: 'playback', policy: 'public' }] } }));
  });
  try {
    const mux = new MuxClient({ baseUrl: server.url, dataDir, tokenId: 'fake', tokenSecret: 'fake' });
    assert.equal((await mux.resume('crashed-video'))?.muxAssetId, 'found');
    const ledger = path.join(dataDir, 'mux-ledger', 'crashed-video.json'), legacy = JSON.parse(await readFile(ledger, 'utf8'));
    delete legacy.result.videoFileUrl; await writeFile(ledger, JSON.stringify(legacy));
    assert.equal((await mux.resume('crashed-video'))?.videoFileUrl, mp4('playback'), 'a legacy ledger result is upgraded rather than returned without a ready MP4');
    assert.equal(creates, 0);
  }
  finally { await server.close(); }
});

test('fake Mux retries throttle independently and rejects redirects', async () => {
  const dataDir = testDir('mux-retry'); await mkdir(path.join(dataDir, 'mux-ledger')); await writeFile(path.join(dataDir, 'mux-ledger', 'retry.json'), JSON.stringify({ assetId: 'retry' }));
  let requests = 0; const waits: number[] = [];
  const server = await localServer((_request, response) => {
    requests++; response.setHeader('content-type', 'application/json');
    if (requests === 1) { response.statusCode = 429; response.setHeader('retry-after', '1'); response.end('{}'); }
    else if (requests === 2) response.end(JSON.stringify({ data: { id: 'retry', status: 'ready', static_renditions: staticRenditions, duration: 12, playback_ids: [{ id: 'playback', policy: 'public' }] } }));
    else { response.statusCode = 302; response.setHeader('location', 'https://example.invalid/forbidden'); response.end('{}'); }
  });
  try { const mux = new MuxClient({ baseUrl: server.url, dataDir, tokenId: 'fake', tokenSecret: 'fake', sleep: async ms => { waits.push(ms); } }); assert.equal((await mux.resume('retry'))?.playbackId, 'playback'); assert.deepEqual(waits, [1000]); await writeFile(path.join(dataDir, 'mux-ledger', 'redirect.json'), JSON.stringify({ assetId: 'redirect' })); await assert.rejects(mux.resume('redirect'), /mux_http_302/); }
  finally { await server.close(); }
});

test('ambiguous upload create is never repeated when passthrough has no visible match', async () => {
  const dataDir = testDir('mux-ambiguous'), file = path.join(dataDir, 'video.mp4'); await writeFile(file, 'fixture');
  let creates = 0;
  const server = await localServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') { creates++; response.statusCode = 500; response.end('{}'); }
    else response.end(JSON.stringify({ data: [] }));
  });
  try {
    const options = { baseUrl: server.url, dataDir, tokenId: 'fake', tokenSecret: 'fake', pollMs: 0 };
    await assert.rejects(new MuxClient(options).upload('ambiguous', file), /mux_http_500/);
    await assert.rejects(new MuxClient(options).resume('ambiguous'), /mux_create_ambiguous/);
    await assert.rejects(new MuxClient(options).upload('ambiguous', file), /mux_create_ambiguous/);
    assert.equal(creates, 1);
  } finally { await server.close(); }
});

test('terminal Mux upload ledger is reset so next worker attempt can create a replacement', async () => {
  const dataDir = testDir('mux-terminal'); await mkdir(path.join(dataDir, 'mux-ledger')); await writeFile(path.join(dataDir, 'mux-ledger', 'terminal.json'), JSON.stringify({ uploadId: 'expired' }));
  const server = await localServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: { id: 'expired', status: 'timed_out' } })); });
  try {
    const mux = new MuxClient({ baseUrl: server.url, dataDir, tokenId: 'fake', tokenSecret: 'fake' });
    await assert.rejects(mux.resume('terminal'), /mux_upload_failed/);
    await assert.rejects(readFile(path.join(dataDir, 'mux-ledger', 'terminal.json')), { code: 'ENOENT' });
    assert.equal(await mux.resume('terminal'), undefined);
  } finally { await server.close(); }
});

test('Mux MP4 backfill CLI reconciles an ambiguous create and delayed file, then persists through the worker endpoint once', async t => {
  const dataDir = testDir('mux-backfill');
  let created = 0, reads = 0, lists = 0, updates = 0;
  const muxServer = await localServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('fake:fake').toString('base64'));
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      assert.equal(request.url, '/video/v1/assets/old-asset/static-renditions');
      assert.deepEqual(await body(request), { resolution: 'highest' }); created++;
      // The provider accepted the request but the response failed before our acknowledgement.
      response.statusCode = 500; response.end('{}');
    } else {
      assert.equal(request.url, '/video/v1/assets/old-asset'); reads++;
      const files = created && reads > 2 ? [{ resolution: 'highest', status: reads < 4 ? 'preparing' : 'ready', name: 'highest.mp4', ext: 'mp4' }] : [];
      response.end(JSON.stringify({ data: { id: 'old-asset', status: 'ready', duration: 12, playback_ids: [{ id: 'old-playback', policy: 'public' }], static_renditions: { files } } }));
    }
  });
  const app = createApp({ dataDir: path.join(dataDir, 'server'), publicBaseUrl: 'http://127.0.0.1', apiKeys: ['fake-api-key-0001'], workerToken: 'fake-worker-token-1', internalViewToken: 'fake-internal-token', previewSecret: 'fake-preview-secret', dispatch: false });
  const campaign = campaignFixture(); app.store.campaignPut(campaign, 12);
  const video = app.store.upsertVideo(campaign.id, { variables: { website_0: 'http://example.invalid', website_4: 'http://example.invalid' } });
  const legacy = { ...app.store.video(video.id), status: 'rendered', muxAssetId: 'old-asset', playbackId: 'old-playback', durationSec: 12, videoFileUrl: 'https://stream.mux.com/old-playback.m3u8' };
  app.store.db.prepare("UPDATE videos SET status='rendered',data=? WHERE id=?").run(JSON.stringify(legacy), video.id);
  const eventsBefore = (app.store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n;
  app.server.on('request', request => {
    if (request.url === '/worker/missing-mp4?limit=100') lists++;
    if (request.url === `/worker/${video.id}/mp4`) updates++;
  });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const overrides = { DATA_DIR: dataDir, SERVER_URL: serverUrl, WORKER_TOKEN: 'fake-worker-token-1', MUX_TOKEN_ID: 'fake', MUX_TOKEN_SECRET: 'fake', MUX_BASE_URL: muxServer.url };
  for (const [key, value] of Object.entries(overrides)) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  try {
    await main(['mux', 'backfill-mp4']);
    assert.equal(app.store.getVideo(video.shortId)?.videoFileUrl, mp4('old-playback'));
    assert.equal(created, 1); assert.equal(reads, 4); assert.equal(lists, 2); assert.equal(updates, 1);
    assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n, eventsBefore, 'backfill emits no duplicate render events');
    await main(['mux', 'backfill-mp4']); assert.equal(created, 1, 'a repeated command leaves already backfilled assets alone');
  } finally { await app.close(); await muxServer.close(); }
});

test('missing campaign releases jobs without consuming attempts and pauses claims for 60 seconds', async t => {
  const dataDir = testDir('worker-missing-campaign');
  let now = Date.now(), claims = 0;
  t.mock.method(Date, 'now', () => now);
  const app = createApp({ dataDir: path.join(dataDir, 'server'), publicBaseUrl: 'http://127.0.0.1', apiKeys: ['fake-api-key-0001'], workerToken: 'fake-worker-token-1', internalViewToken: 'fake-internal-token', previewSecret: 'fake-preview-secret', dispatch: false });
  const campaign = campaignFixture(); app.store.campaignPut(campaign, 12);
  const video = app.store.upsertVideo(campaign.id, { variables: { website_0: 'http://example.invalid', website_4: 'http://example.invalid' } });
  app.server.on('request', request => { if (request.url === '/worker/claim') claims++; });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const logs: string[] = [];
  const worker = new Worker({ dataDir, campaignsDir: path.join(dataDir, 'missing'), serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, workerToken: 'fake-worker-token-1', log: message => logs.push(message), mux: { async resume() { return undefined; }, async upload() { throw new Error('must not upload'); } }, renderer: { async render() { throw new Error('must not render'); } } });
  try {
    assert.equal(await worker.once(), 1);
    assert.equal(app.store.getVideo(video.shortId)?.status, 'queued');
    assert.deepEqual(app.store.db.prepare('SELECT attempts,lease_token,lease_until FROM videos WHERE id=?').get(video.id), { attempts: 0, lease_token: null, lease_until: null });
    assert.ok(logs.some(message => message.includes('claims paused 60s')));
    assert.equal(await worker.once(), 0); now += 59_999; assert.equal(await worker.once(), 0); assert.equal(claims, 1);
    now++; assert.equal(await worker.once(), 1); assert.equal(claims, 2);
    assert.equal((app.store.db.prepare('SELECT attempts FROM videos WHERE id=?').get(video.id) as any).attempts, 0);
  } finally { await worker.close(); await app.close(); }
});

test('resumed MP4 without local capture metadata releases its lease without attempts or events', async () => {
  const dataDir = testDir('worker-missing-capture');
  const app = createApp({ dataDir: path.join(dataDir, 'server'), publicBaseUrl: 'http://127.0.0.1', apiKeys: ['fake-api-key-0001'], workerToken: 'fake-worker-token-1', internalViewToken: 'fake-internal-token', previewSecret: 'fake-preview-secret', dispatch: false });
  const campaign = campaignFixture(); app.store.campaignPut(campaign, 12);
  const video = app.store.upsertVideo(campaign.id, { variables: { website_0: 'http://example.invalid', website_4: 'http://example.invalid' } });
  const eventsBefore = (app.store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n;
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const logs: string[] = [];
  const worker = new Worker({ dataDir, campaignsDir: path.join(dataDir, 'unused'), serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, workerToken: 'fake-worker-token-1', log: message => logs.push(message), mux: {
    async resume() { return { muxAssetId: 'asset', playbackId: 'playback', durationSec: 12, videoFileUrl: mp4('playback') }; },
    async upload() { throw new Error('must not upload'); }
  }, renderer: { async render() { throw new Error('must not render'); } } });
  try {
    assert.equal(await worker.once(), 1);
    assert.equal(app.store.getVideo(video.shortId)?.status, 'queued');
    assert.deepEqual(app.store.db.prepare('SELECT attempts,lease_token,lease_until FROM videos WHERE id=?').get(video.id), { attempts: 0, lease_token: null, lease_until: null });
    assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n, eventsBefore);
    assert.ok(logs.some(message => message.includes('worker_missing_capture_time') && message.includes('claims paused 60s')));
  } finally { await worker.close(); await app.close(); }
});

test('worker once keeps other jobs alive, passes lease token, resumes before rendering', async () => {
  const finished: any[] = [], failed: any[] = [], dataDir = testDir('worker');
  const server = await localServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fake-worker-token-1'); response.setHeader('content-type', 'application/json');
    const value = await body(request);
    if (request.url === '/worker/claim') response.end(JSON.stringify({ jobs: ['good', 'bad'].map(id => ({ id, campaignId: 'fixture', variables: {}, campaign: campaignFixture(), leaseToken: `${id}-lease` })) }));
    else { if (request.url?.endsWith('/complete')) finished.push(value); else failed.push(value); response.end('{}'); }
  });
  await mkdir(path.join(dataDir, 'worker-output'), { recursive: true });
  await writeFile(path.join(dataDir, 'worker-output', 'good.mp4.capture.json'), JSON.stringify({ backgroundRecordedAt: recordedAt }));
  const worker = new Worker({ serverUrl: server.url, workerToken: 'fake-worker-token-1', campaignsDir: dataDir, dataDir, mux: { async resume(id) { if (id === 'bad') throw new Error('mux_asset_errored'); return { muxAssetId: 'asset', playbackId: 'playback', durationSec: 12, videoFileUrl: mp4('playback') }; }, async upload() { throw new Error('must not upload'); } }, renderer: { async render() { throw new Error('must not render'); } } });
  try { assert.equal(await worker.once(), 2); assert.equal(finished.length, 1); assert.equal(finished[0].leaseToken, 'good-lease'); assert.equal(finished[0].backgroundRecordedAt, recordedAt); assert.equal(finished[0].videoFileUrl, mp4('playback')); assert.equal(failed[0].reason, 'mux_asset_errored'); assert.equal(failed[0].leaseToken, 'bad-lease'); }
  finally { await worker.close(); await server.close(); }
});

test('real server claimed campaign metadata remains compatible with local assets and Worker completion', async () => {
  const dataDir = testDir('worker-app'), campaignsDir = path.join(dataDir, 'campaigns');
  const campaign = campaignFixture({ pages: [{ start: 0, end: 1, type: 'website', variable: 'website_0' }] });
  const campaignDir = path.join(campaignsDir, campaign.id); await mkdir(campaignDir, { recursive: true });
  await writeFile(path.join(campaignDir, 'campaign.json'), JSON.stringify(campaign));
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', videoEncoder(), '-c:a', 'aac', path.join(campaignDir, 'base.mp4')]);
  const app = createApp({ dataDir: path.join(dataDir, 'server'), publicBaseUrl: 'http://127.0.0.1', apiKeys: ['fake-api-key-0001'], workerToken: 'fake-worker-token-1', internalViewToken: 'fake-internal-token', previewSecret: 'fake-preview-secret', dispatch: false });
  app.store.campaignPut(campaign, 1);
  const video = app.store.upsertVideo(campaign.id, { variables: { website_0: 'http://example.invalid' } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const output = path.join(dataDir, 'output.mp4'); let renders = 0, uploads = 0;
  const worker = new Worker({ dataDir, campaignsDir, serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, workerToken: 'fake-worker-token-1', mux: { async resume() { return undefined; }, async upload(id) { uploads++; assert.equal(id, video.id); return { muxAssetId: 'fake-asset', playbackId: 'fake-playback', durationSec: 1, videoFileUrl: mp4('fake-playback') }; } }, renderer: { async render() { renders++; await writeFile(output, 'fake-render'); return { path: output, durationSec: 1, elapsedSec: 0, captureSec: 0, encodeSec: 0, cacheKey: 'fake', backgroundRecordedAt: recordedAt }; } } });
  try { assert.equal(await worker.once(), 1); assert.equal(renders, 1); assert.equal(uploads, 1); assert.equal(app.store.getVideo(video.shortId)?.status, 'rendered'); assert.equal(app.store.getVideo(video.shortId)?.backgroundRecordedAt, recordedAt); assert.equal(app.store.getVideo(video.shortId)?.videoFileUrl, mp4('fake-playback')); await assert.rejects(readFile(output), { code: 'ENOENT' }); }
  finally { await worker.close(); await app.close(); }
});

test('worker refills six jobs while Fake-Mux processing is blocked without holding upload slots', { timeout: 180_000 }, async t => {
  const dataDir = testDir('worker-throughput'), campaignsDir = path.join(dataDir, 'campaigns');
  const campaign = campaignFixture({ pages: [{ start: 0, end: 1, type: 'website', variable: 'website_0' }] });
  const campaignDir = path.join(campaignsDir, campaign.id); await mkdir(campaignDir, { recursive: true });
  await writeFile(path.join(campaignDir, 'campaign.json'), JSON.stringify(campaign));
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', videoEncoder(), '-c:a', 'aac', path.join(campaignDir, 'base.mp4')]);
  const abort = new AbortController(), slotById = new Set<string>(), sent = new Set<string>(), processing = new Set<string>();
  const firstPuts = gate(), putsStarted = new Set<string>();
  const ready = new Map(Array.from({ length: 6 }, (_, index) => [`job-${index}`, gate()]));
  let base = '', activeSlots = 0, peakSlots = 0, claimed = 0, completed = 0, refilledWhileActive = false;
  const muxServer = await localServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      const input = await body(request), id = input.new_asset_settings.passthrough;
      response.end(JSON.stringify({ data: { id, url: `${base}/bytes/${id}` } }));
    } else if (request.method === 'PUT') {
      const id = request.url!.split('/').at(-1)!;
      for await (const _chunk of request) { /* consume fake video */ }
      putsStarted.add(id);
      if (putsStarted.size >= 2) firstPuts.release();
      await firstPuts.promise;
      sent.add(id); response.end('{}');
    } else {
      const id = request.url!.split('/').at(-1)!;
      if (request.url!.includes('/uploads/')) response.end(JSON.stringify({ data: sent.has(id) ? { id, asset_id: id } : { id, url: `${base}/bytes/${id}` } }));
      else {
        assert.equal(slotById.has(id), false, 'asset-ready polling must run outside its upload slot');
        processing.add(id);
        // Release one initial job only after all three reach processing. The other
        // two remain blocked until the worker refills the vacant job slot.
        if (['job-0', 'job-1', 'job-2'].every(job => processing.has(job))) ready.get('job-0')!.release();
        if (id === 'job-3') for (const pending of ready.values()) pending.release();
        await ready.get(id)!.promise;
        processing.delete(id);
        response.end(JSON.stringify({ data: { id, status: 'ready', static_renditions: staticRenditions, duration: 1, playback_ids: [{ id: `playback-${id}`, policy: 'public' }] } }));
      }
    }
  }); base = muxServer.url;
  const server = await localServer(async (request, response) => {
    const input = await body(request); response.setHeader('content-type', 'application/json');
    if (request.url === '/worker/claim') {
      if (claimed === 3 && completed === 1 && processing.has('job-1') && processing.has('job-2')) refilledWhileActive = true;
      const jobs = Array.from({ length: Math.min(input.limit, 6 - claimed) }, () => {
        const id = `job-${claimed++}`; return { id, campaignId: campaign.id, campaign, variables: {}, leaseToken: id };
      });
      response.end(JSON.stringify({ jobs }));
    } else {
      assert.ok(request.url!.endsWith('/complete'), 'all six jobs should complete');
      completed++; response.end('{}'); if (completed === 6) abort.abort();
    }
  });
  const mux = new MuxClient({ baseUrl: base, dataDir, tokenId: 'fake', tokenSecret: 'fake', pollMs: 0 });
  const worker = new Worker({ serverUrl: server.url, workerToken: 'fake', campaignsDir, dataDir, batchSize: 3, uploadParallel: 2,
    mux: { resume: id => mux.resume(id), upload: (id, file, withSlot: UploadSlot = operation => operation()) => mux.upload(id, file, operation => withSlot(async () => {
      slotById.add(id); activeSlots++; peakSlots = Math.max(peakSlots, activeSlots);
      try { return await operation(); } finally { slotById.delete(id); activeSlots--; }
    })) },
    renderer: { async render({ outputPath }) {
      await writeFile(outputPath!, 'fake-video'); return { path: outputPath!, durationSec: 1, elapsedSec: 0, captureSec: 0, encodeSec: 0, cacheKey: 'fake', backgroundRecordedAt: recordedAt };
    } }
  });
  const watchdog = setTimeout(() => { abort.abort(); firstPuts.release(); for (const pending of ready.values()) pending.release(); }, 120_000);
  try {
    await worker.run(abort.signal);
    assert.equal(completed, 6); assert.equal(peakSlots, 2); assert.equal(activeSlots, 0);
    assert.equal(refilledWhileActive, true, 'a new claim must not wait for the previous batch');
    const metrics = { jobs: completed, processingGated: true, peakUploadSlots: peakSlots, uploadParallel: 2, slotsHeldDuringReady: false, refilledWhileActive };
    await writeFile(path.join(dataDir, 'throughput.json'), JSON.stringify(metrics, null, 2) + '\n');
    t.diagnostic(JSON.stringify({ ...metrics, metricsPath: path.join(dataDir, 'throughput.json') }));
  } finally { clearTimeout(watchdog); await worker.close(); await server.close(); await muxServer.close(); }
});

test('worker uploads the mail GIF before completing and sends none on resume', async () => {
  const dataDir = testDir('worker-gif'), campaignsDir = path.join(dataDir, 'campaigns');
  const campaign = campaignFixture({ pages: [{ start: 0, end: 1, type: 'website', variable: 'website_0' }] });
  const campaignDir = path.join(campaignsDir, campaign.id); await mkdir(campaignDir, { recursive: true });
  await writeFile(path.join(campaignDir, 'campaign.json'), JSON.stringify(campaign));
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', videoEncoder(), '-c:a', 'aac', path.join(campaignDir, 'base.mp4')]);
  const jobs = [
    { id: 'fresh-gif', campaignId: campaign.id, variables: {}, campaign, leaseToken: 'fresh-gif-lease' },
    { id: 'resumed-gif', campaignId: campaign.id, variables: {}, campaign, leaseToken: 'resumed-gif-lease' },
  ];
  const calls: string[] = []; let gifBody: any;
  const server = await localServer(async (request, response) => {
    const value = await body(request); response.setHeader('content-type', 'application/json');
    if (request.url === '/worker/claim') response.end(JSON.stringify({ jobs }));
    else { calls.push(request.url!); if (request.url!.endsWith('/gif')) gifBody = value; response.end('{}'); }
  });
  await mkdir(path.join(dataDir, 'worker-output'), { recursive: true });
  await writeFile(path.join(dataDir, 'worker-output', 'resumed-gif.mp4.capture.json'), JSON.stringify({ backgroundRecordedAt: recordedAt }));
  const muxResult = { muxAssetId: 'asset', playbackId: 'playback', durationSec: 1, videoFileUrl: mp4('playback') };
  const worker = new Worker({ serverUrl: server.url, workerToken: 'fake-worker-token-1', campaignsDir, dataDir,
    mux: { async resume(id) { return id === 'resumed-gif' ? muxResult : undefined; }, async upload() { return muxResult; } },
    renderer: { async render({ outputPath }) {
      await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-t', '1', '-c:v', videoEncoder(), outputPath!]);
      return { path: outputPath!, durationSec: 1, elapsedSec: 0, captureSec: 0, encodeSec: 0, cacheKey: 'fake', backgroundRecordedAt: recordedAt };
    } } });
  try {
    assert.equal(await worker.once(), 2);
    assert.ok(calls.includes('/worker/fresh-gif/complete') && calls.includes('/worker/resumed-gif/complete'));
    assert.equal(calls.filter(call => call.endsWith('/gif')).length, 1);
    assert.ok(calls.indexOf('/worker/fresh-gif/gif') < calls.indexOf('/worker/fresh-gif/complete'));
    assert.equal(gifBody.leaseToken, 'fresh-gif-lease');
    assert.match(Buffer.from(gifBody.gif, 'base64').subarray(0, 6).toString('ascii'), /^GIF8[79]a$/);
    await assert.rejects(readFile(path.join(dataDir, 'worker-output', 'fresh-gif.mp4.gif')), { code: 'ENOENT' });
  } finally { await worker.close(); await server.close(); }
});

test('mail GIF failures never fail the video', async () => {
  const dataDir = testDir('worker-gif-failure'), campaignsDir = path.join(dataDir, 'campaigns');
  const campaign = campaignFixture({ pages: [{ start: 0, end: 1, type: 'website', variable: 'website_0' }] });
  const campaignDir = path.join(campaignsDir, campaign.id); await mkdir(campaignDir, { recursive: true });
  await writeFile(path.join(campaignDir, 'campaign.json'), JSON.stringify(campaign));
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', videoEncoder(), '-c:a', 'aac', path.join(campaignDir, 'base.mp4')]);
  const jobs = [
    { id: 'ffmpeg-fails', campaignId: campaign.id, variables: {}, campaign, leaseToken: 'ffmpeg-fails-lease' },
    { id: 'upload-fails', campaignId: campaign.id, variables: {}, campaign, leaseToken: 'upload-fails-lease' },
  ];
  const calls: string[] = [];
  const server = await localServer(async (request, response) => {
    const value = await body(request); response.setHeader('content-type', 'application/json');
    if (request.url === '/worker/claim') { response.end(JSON.stringify({ jobs })); return; }
    calls.push(request.url!);
    if (request.url === '/worker/upload-fails/gif') { response.statusCode = 500; response.end('{}'); return; }
    response.end('{}');
  });
  const logs: string[] = [];
  const muxResult = { muxAssetId: 'asset', playbackId: 'playback', durationSec: 1, videoFileUrl: mp4('playback') };
  const worker = new Worker({ serverUrl: server.url, workerToken: 'fake-worker-token-1', campaignsDir, dataDir, log: message => logs.push(message),
    mux: { async resume() { return undefined; }, async upload() { return muxResult; } },
    renderer: { async render({ outputPath }) {
      // A text file is no renderable video, so the GIF build fails before any upload.
      if (outputPath!.includes('ffmpeg-fails')) await writeFile(outputPath!, 'not-a-video');
      else await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-t', '1', '-c:v', videoEncoder(), outputPath!]);
      return { path: outputPath!, durationSec: 1, elapsedSec: 0, captureSec: 0, encodeSec: 0, cacheKey: 'fake', backgroundRecordedAt: recordedAt };
    } } });
  try {
    assert.equal(await worker.once(), 2);
    assert.ok(calls.includes('/worker/ffmpeg-fails/complete') && calls.includes('/worker/upload-fails/complete'));
    assert.equal(calls.includes('/worker/ffmpeg-fails/gif'), false);
    assert.deepEqual(logs.filter(line => line.includes('gif_failed')).map(line => JSON.parse(line)).sort((a, b) => a.id < b.id ? -1 : 1),
      [{ event: 'gif_failed', id: 'ffmpeg-fails' }, { event: 'gif_failed', id: 'upload-fails' }]);
    for (const id of ['ffmpeg-fails', 'upload-fails']) await assert.rejects(readFile(path.join(dataDir, 'worker-output', `${id}.mp4.gif`)), { code: 'ENOENT' });
  } finally { await worker.close(); await server.close(); }
});

test('worker logs one JSON timing line per video with null stages on resume', async () => {
  const dataDir = testDir('worker-timing'), campaignsDir = path.join(dataDir, 'campaigns');
  const campaign = campaignFixture({ pages: [{ start: 0, end: 1, type: 'website', variable: 'website_0' }] });
  const campaignDir = path.join(campaignsDir, campaign.id); await mkdir(campaignDir, { recursive: true });
  await writeFile(path.join(campaignDir, 'campaign.json'), JSON.stringify(campaign));
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', videoEncoder(), '-c:a', 'aac', path.join(campaignDir, 'base.mp4')]);
  const variables = { website_0: 'http://person.invalid/acme' };
  let jobs: any[] = [];
  const server = await localServer(async (request, response) => {
    await body(request); response.setHeader('content-type', 'application/json');
    response.end(request.url === '/worker/claim' ? JSON.stringify({ jobs }) : '{}');
  });
  const muxResult = { muxAssetId: 'asset', playbackId: 'playback', durationSec: 1, videoFileUrl: mp4('playback') };
  try {
    // Fresh render: stage times and file size are reported, URLs stay out of the log.
    jobs = [{ id: 'fresh-1', campaignId: campaign.id, variables, campaign, leaseToken: 'fresh-1-lease' }];
    const freshLogs: string[] = [];
    const fresh = new Worker({ serverUrl: server.url, workerToken: 'fake-worker-token-1', campaignsDir, dataDir,
      log: message => freshLogs.push(message),
      mux: { async resume() { return undefined; }, async upload(_id, _file, _slot, timing) { if (timing) Object.assign(timing, { uploadSec: 5.6, muxSec: 7.8 }); return muxResult; } },
      renderer: { async render({ outputPath }) { await writeFile(outputPath!, '0123456789'); return { path: outputPath!, durationSec: 1, elapsedSec: 0, captureSec: 1.2, encodeSec: 3.4, cacheKey: 'fake', backgroundRecordedAt: recordedAt }; } } });
    try {
      assert.equal(await fresh.once(), 1);
      assert.equal(freshLogs.length, 2);
      assert.deepEqual(JSON.parse(freshLogs[0]), { event: 'gif_failed', id: 'fresh-1' });
      const line = JSON.parse(freshLogs[1]);
      assert.deepEqual({ ...line, totalSec: typeof line.totalSec }, { event: 'video_completed', id: 'fresh-1', campaignId: campaign.id, captureSec: 1.2, encodeSec: 3.4, uploadSec: 5.6, muxSec: 7.8, totalSec: 'number', fileBytes: 10 });
      assert.ok(line.totalSec >= 0);
      assert.doesNotMatch(freshLogs[0], /person\.invalid|acme/);
    } finally { await fresh.close(); }
    // Resume: no local work happened, so every stage value is null.
    jobs = [{ id: 'resumed-1', campaignId: campaign.id, variables, campaign, leaseToken: 'resumed-1-lease' }];
    await mkdir(path.join(dataDir, 'worker-output'), { recursive: true });
    await writeFile(path.join(dataDir, 'worker-output', 'resumed-1.mp4.capture.json'), JSON.stringify({ backgroundRecordedAt: recordedAt }));
    const resumedLogs: string[] = [];
    const resumed = new Worker({ serverUrl: server.url, workerToken: 'fake-worker-token-1', campaignsDir, dataDir,
      log: message => resumedLogs.push(message),
      mux: { async resume() { return muxResult; }, async upload() { throw new Error('must not upload'); } },
      renderer: { async render() { throw new Error('must not render'); } } });
    try {
      assert.equal(await resumed.once(), 1);
      assert.equal(resumedLogs.length, 1);
      const line = JSON.parse(resumedLogs[0]);
      assert.deepEqual({ ...line, totalSec: typeof line.totalSec }, { event: 'video_completed', id: 'resumed-1', campaignId: campaign.id, captureSec: null, encodeSec: null, uploadSec: null, muxSec: null, totalSec: 'number', fileBytes: null });
      assert.ok(line.totalSec >= 0);
    } finally { await resumed.close(); }
    // Failure: reason and total time without URLs or personal data.
    jobs = [{ id: 'failed-1', campaignId: campaign.id, variables, campaign, leaseToken: 'failed-1-lease' }];
    const failedLogs: string[] = [];
    const failing = new Worker({ serverUrl: server.url, workerToken: 'fake-worker-token-1', campaignsDir, dataDir,
      log: message => failedLogs.push(message),
      mux: { async resume() { return undefined; }, async upload() { throw new Error('must not upload'); } },
      renderer: { async render() { throw new RenderError('render_failed'); } } });
    try {
      assert.equal(await failing.once(), 1);
      assert.equal(failedLogs.length, 1);
      const line = JSON.parse(failedLogs[0]);
      assert.deepEqual({ ...line, totalSec: typeof line.totalSec }, { event: 'video_failed', id: 'failed-1', campaignId: campaign.id, reason: 'render_failed', totalSec: 'number' });
      assert.ok(line.totalSec >= 0);
      assert.doesNotMatch(failedLogs[0], /person\.invalid|acme/);
    } finally { await failing.close(); }
  } finally { await server.close(); }
});
