import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { campaignFixture, testDir } from './helpers.js';
import { migrateWebhooks } from '../scripts/migrate-webhooks.js';
import { mediaCommand, videoEncoder } from '../src/render.js';

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const app = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => { response.statusCode = 500; response.end('{}'); }); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(app.address() as { port: number }).port}`, close: () => new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())) };
}
async function body(request: IncomingMessage) { let data = ''; for await (const chunk of request) data += chunk; return JSON.parse(data); }

test('webhook migration defaults to dry-run, applies idempotently, preserves scope and masks all target tokens', async () => {
  const dir = testDir('migrate'), file = path.join(dir, 'hooks.json'), logs: string[] = [];
  const source = [
    { id: 'native-global', trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/private-path-token?key=private-query-token', userId: 'native' },
    { id: 'native-scoped', trigger: 'VIDEO_VIEWED', webhookUrl: 'https://hooks.example.invalid/private-path-token?key=private-query-token', campaignId: 'campaign-1', campaign: { _id: 'campaign-1' } }
  ];
  await writeFile(file, JSON.stringify([...source, source[0]]));
  const existing: any[] = []; let writes = 0;
  const app = await server(async (request, response) => {
    assert.equal(request.headers['x-api-key'], 'fake-api'); response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') { assert.equal(request.url, '/api/public/v1/webhooks'); response.end(JSON.stringify(existing)); }
    else {
      writes++; const input = await body(request);
      const campaignId = request.url === '/api/public/v1/campaigns/campaign-1/webhooks' ? 'campaign-1' : null;
      assert.equal(request.url, campaignId ? '/api/public/v1/campaigns/campaign-1/webhooks' : '/api/public/v1/webhooks');
      assert.deepEqual(Object.keys(input).sort(), ['trigger', 'webhookUrl']);
      existing.push({ ...input, campaignId }); response.end(JSON.stringify({ id: `own-${writes}` }));
    }
  });
  const options = { file, serverUrl: app.url, apiKey: 'fake-api', log: (line: string) => logs.push(line) };
  try {
    assert.deepEqual(await migrateWebhooks(options), { dryRun: true, created: 0, present: 0, wouldCreate: 2 }); assert.equal(writes, 0);
    assert.deepEqual(await migrateWebhooks({ ...options, apply: true }), { dryRun: false, created: 2, present: 0, wouldCreate: 0 });
    assert.deepEqual(await migrateWebhooks({ ...options, apply: true }), { dryRun: false, created: 0, present: 2, wouldCreate: 0 }); assert.equal(writes, 2);
    assert.doesNotMatch(logs.join('\n'), /private-path-token|private-query-token|fake-api/); assert.match(logs[0], /masked/);
    await writeFile(file, JSON.stringify([source[0], { ...source[1], trigger: 'UNKNOWN' }]));
    await assert.rejects(migrateWebhooks({ ...options, apply: true }), /Invalid webhook/); assert.equal(writes, 2);
    await writeFile(file, '[]');
    await assert.rejects(migrateWebhooks({ ...options, serverUrl: 'https://app.pitchlane.com' }), /own server origin/);
    await assert.rejects(migrateWebhooks({ ...options, serverUrl: 'https://api.pitchlane.com.' }), /own server origin/);
  } finally { await app.close(); }
});

test('local E2E shell completes a real local render using Fake-Mux and no external requests', { timeout: 300_000 }, async () => {
  const dataDir = testDir('e2e-script'), campaign = campaignFixture({ domain: 'video.example.invalid', output: { width: 640, height: 360, fps: 24 }, pages: [{ start: 0, end: 1, type: 'website', variable: 'website_0' }] });
  const campaignsDir = path.join(dataDir, 'campaigns'), campaignDir = path.join(campaignsDir, campaign.id); await mkdir(campaignDir, { recursive: true });
  await writeFile(path.join(campaignDir, 'campaign.json'), JSON.stringify(campaign));
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', videoEncoder(), '-c:a', 'aac', path.join(campaignDir, 'base.mp4')]);
  let base = '', creates = 0, puts = 0;
  const fake = await server(async (request, response) => {
    if (request.url === '/website') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><style>body{margin:0;background:#ddeeff}main{height:1200px}</style><main>Local offline E2E website</main>'); return; }
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/video/v1/uploads') {
      assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('fake-e2e:fake-e2e-secret').toString('base64'));
      const input = await body(request); assert.match(input.new_asset_settings.passthrough, /^[A-Za-z0-9_-]{21}$/); assert.deepEqual(input.new_asset_settings.static_renditions, [{ resolution: 'highest' }]); creates++;
      response.end(JSON.stringify({ data: { id: 'upload-e2e', url: `${base}/bytes` } }));
    } else if (request.method === 'PUT' && request.url === '/bytes') {
      let length = 0; for await (const chunk of request) length += chunk.length; assert.ok(length > 1000); puts++; response.end('{}');
    } else if (request.url === '/video/v1/uploads/upload-e2e') response.end(JSON.stringify({ data: puts ? { id: 'upload-e2e', asset_id: 'asset-e2e' } : { id: 'upload-e2e', url: `${base}/bytes` } }));
    else if (request.url === '/video/v1/assets/asset-e2e') response.end(JSON.stringify({ data: { id: 'asset-e2e', status: 'ready', duration: 1, playback_ids: [{ id: 'fake-playback-e2e', policy: 'public' }], static_renditions: { files: [{ resolution: 'highest', status: 'ready', name: 'highest.mp4', ext: 'mp4' }] } } }));
    else { response.statusCode = 404; response.end('{}'); assert.fail(`Unexpected local Fake-Mux request: ${request.method} ${request.url}`); }
  }); base = fake.url;
  const reservation = await server((_request, response) => { response.end('reserved'); });
  const port = new URL(reservation.url).port; await reservation.close();
  const child = spawn('/bin/sh', ['scripts/e2e-local.sh'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env,
    DATA_DIR: dataDir, CAMPAIGNS_DIR: campaignsDir, E2E_CAMPAIGN_DIR: campaignDir, E2E_WEBSITE_URL: `${base}/website`, E2E_PORT: port, E2E_STOP_SERVER: '1',
    MUX_BASE_URL: base, MUX_TOKEN_ID: 'fake-e2e', MUX_TOKEN_SECRET: 'fake-e2e-secret', SCREENSHOT_TIMEOUT_MS: '120000'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout); assert.equal(result.serverRunning, false);
    assert.match(result.landingUrl, new RegExp(`^http://127\\.0\\.0\\.1:${port}/video/[A-Za-z0-9]{12}\\?internal=`));
    assert.match(result.gifUrl, /\/thumbnail\/[A-Za-z0-9]{12}\.gif$/); assert.equal(creates, 1); assert.equal(puts, 1);
    assert.equal(JSON.parse(await readFile(path.join(campaignDir, 'campaign.json'), 'utf8')).domain, 'video.example.invalid', 'original campaign stays unchanged');
    assert.doesNotMatch(stdout + stderr + await readFile(path.join(result.runDir, 'e2e.log'), 'utf8'), /fake-e2e-secret/);
  } finally { child.kill('SIGTERM'); await fake.close(); }
});
