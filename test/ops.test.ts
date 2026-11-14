import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, dispatchOutbox } from '../src/server.js';
import { Store } from '../src/store.js';
import { campaignFixture, testDir } from './helpers.js';

const campaignId = campaignFixture().id;
const key = 'ops-fixture-api-key', workerToken = 'ops-fixture-worker';
const start = '2026-10-15T12:00:00.000Z';
const result = { muxAssetId: 'asset', playbackId: 'playback', durationSec: 12,
  videoFileUrl: 'https://stream.mux.com/playback/highest.mp4', backgroundRecordedAt: start };
async function setup(t: any) {
  let time = Date.parse(start);
  const dataDir = testDir('ops');
  const app = createApp({ dataDir, publicBaseUrl: 'http://localhost', apiKeys: [key], workerToken,
    internalViewToken: 'ops-internal-token', previewSecret: 'ops-preview-secret', dispatch: false, now: () => time });
  app.store.campaignPut(campaignFixture(), 12); app.store.campaignPut(campaignFixture({ id: 'other' }), 12);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (route: string, method = 'GET', input?: unknown, headers: Record<string, string> = { 'x-api-key': key }) => fetch(base + route,
    { method, headers: { 'content-type': 'application/json', ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const create = (queueForRender = true) => app.store.upsertVideo(campaignId, { variables: { capture_url: 'http://localhost' }, queueForRender });
  return { ...app, dataDir, request, create, advance(ms: number) { time += ms; } };
}
const videoRoute = (id: string) => `/api/platform/v1/campaigns/${campaignId}/videos/${id}`;

test('cancel is authenticated, idempotent, silent, restricted to unleased created/queued and counted separately', async t => {
  const app = await setup(t), created = app.create(false), queued = app.create();
  const before = (app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n;
  assert.equal((await app.request(videoRoute(created.id) + '/cancel', 'POST', {}, {})).status, 401);
  assert.equal((await app.request(`/api/platform/v1/campaigns/other/videos/${created.id}/cancel`, 'POST')).status, 404);
  for (const video of [created, queued]) {
    const route = videoRoute(video.id) + '/cancel';
    assert.deepEqual(await (await app.request(route, 'POST')).json(), { id: video.id, status: 'cancelled' });
    assert.deepEqual(await (await app.request(route, 'POST')).json(), { id: video.id, status: 'cancelled' });
    assert.equal((await app.request(videoRoute(video.id) + '/retry', 'POST')).status, 409);
  }
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n, before);
  assert.deepEqual(app.store.claim(), []);
  const filtered = await (await app.request(`/api/platform/v1/campaigns/${campaignId}/videos?status=cancelled`)).json();
  assert.equal(filtered.count, 2); assert.ok(filtered.videos.every((video: any) => video.status === 'cancelled'));
  assert.equal(app.store.platformCampaign(campaignId).counts.cancelled, 2); assert.equal(app.store.platformCampaign(campaignId).counts.failed, 0);
  assert.equal(app.store.platformStats(campaignId).videos.cancelled, 2); assert.equal(app.store.listVideos(campaignId).cancelledCount, 2);
  const active = app.create(), job = app.store.claim()[0];
  assert.equal((await app.request(videoRoute(active.id) + '/cancel', 'POST')).status, 409);
  app.advance(30 * 60_000);
  assert.equal((await app.request(videoRoute(active.id) + '/cancel', 'POST')).status, 409, 'expired rendering must first be recovered by claim');
  const recovered = app.store.claim()[0]; app.store.complete(active.id, { ...result, leaseToken: recovered.leaseToken });
  assert.equal((await app.request(videoRoute(active.id) + '/cancel', 'POST')).status, 409);
  const anomalous = app.create(); app.store.db.prepare('UPDATE videos SET lease_until=? WHERE id=?').run(Date.now() + 1e12, anomalous.id);
  assert.equal((await app.request(videoRoute(anomalous.id) + '/cancel', 'POST')).status, 409);
  assert.equal((await app.request(videoRoute('missing') + '/cancel', 'POST')).status, 404);
  assert.equal(app.store.video(job.id).attempts, 2);
});

test('worker release returns an environment-failed claim to queued without consuming attempts or emitting events', async t => {
  const app = await setup(t), video = app.create(), job = app.store.claim()[0];
  const route = `/worker/${video.id}/release`, auth = { authorization: `Bearer ${workerToken}` };
  assert.equal((await app.request(route, 'POST', { leaseToken: job.leaseToken }, {})).status, 401);
  assert.equal((await app.request(route, 'POST', { leaseToken: 'wrong' }, auth)).status, 409);
  assert.deepEqual(await (await app.request(route, 'POST', { leaseToken: job.leaseToken }, auth)).json(), { success: true, status: 'queued' });
  assert.equal(app.store.video(video.id).attempts, 0); assert.equal(app.store.video(video.id).status, 'queued');
  const row: any = app.store.db.prepare('SELECT lease_until,lease_token FROM videos WHERE id=?').get(video.id);
  assert.deepEqual(row, { lease_until: null, lease_token: null });
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n, 1);
  const replacement = app.store.claim()[0]; assert.equal(replacement.attempts, 1);
  assert.equal((await app.request(route, 'POST', { leaseToken: job.leaseToken }, auth)).status, 409);
  assert.equal(app.store.video(video.id).attempts, 1);
});

test('ops exposes durable queue/worker/outbox metrics, oldest timestamps and dispatch state without targets or payloads', async t => {
  const app = await setup(t);
  assert.equal((await app.request('/api/platform/v1/ops', 'GET', undefined, {})).status, 401);
  assert.deepEqual(await (await app.request('/api/platform/v1/ops')).json(), {
    queue: { created: 0, queued: 0, rendering: 0, failed: 0, cancelled: 0, deferred: 0, expired: 0, oldestCreatedAt: null, oldestQueuedAt: null, oldestDeferredAt: null },
    worker: { lastClaimAt: null, lastCompleteAt: null }, outbox: { pending: 0, dead: 0, rejected: 0, oldestPendingAt: null }, dispatchEnabled: true,
  });
  app.create(false); app.advance(1000); const ready = app.create();
  app.store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'http://localhost/private?token=sensitive' });
  const job = app.store.claim()[0]; app.advance(1000); app.store.complete(ready.id, { ...result, leaseToken: job.leaseToken });
  const cancelled = app.create(false); app.store.cancelVideo(campaignId, cancelled.id);
  app.advance(1000); app.create(); const active = app.create();
  const activeJob = app.store.claim()[0]; assert.ok([active.id, app.store.platformVideos(campaignId, { status: 'rendering' }).videos[0].id].includes(activeJob.id));
  const failed = app.create(false); app.store.db.prepare("UPDATE videos SET status='failed' WHERE id=?").run(failed.id);
  const response = await app.request('/api/platform/v1/ops'); assert.equal(response.headers.get('cache-control'), 'no-store');
  const ops = await response.json();
  assert.deepEqual(ops.queue, { created: 1, queued: 1, rendering: 1, failed: 1, cancelled: 1, deferred: 0, expired: 0, oldestCreatedAt: start, oldestQueuedAt: '2026-10-15T12:00:03.000Z', oldestDeferredAt: null });
  assert.deepEqual(ops.worker, { lastClaimAt: '2026-10-15T12:00:03.000Z', lastCompleteAt: '2026-10-15T12:00:02.000Z' });
  assert.deepEqual(ops.outbox, { pending: 1, dead: 0, rejected: 0, oldestPendingAt: '2026-10-15T12:00:02.000Z' });
  assert.doesNotMatch(JSON.stringify(ops), /sensitive|token|private|payload|target|webhookUrl|originalRow/);
  const reopened = new Store({ dataDir: app.dataDir, publicBaseUrl: 'http://localhost' });
  try { assert.deepEqual(reopened.platformOps().worker, ops.worker); } finally { reopened.close(); }
  app.store.outboxFailure(app.store.dueOutbox()[0].id, 'http_422');
  assert.deepEqual(app.store.platformOps().outbox, { pending: 0, dead: 0, rejected: 1, oldestPendingAt: null });
});

test('requeue selects terminal states by hook and inclusive event time and preserves persisted payload/time', async t => {
  const app = await setup(t), target = 'http://localhost/hook?token=sensitive';
  const hook = app.store.webhookPut({ trigger: 'VIDEO_CREATED', webhookUrl: target });
  app.store.webhookPut({ trigger: 'VIDEO_CREATED', webhookUrl: target + '2' });
  app.create(false); app.advance(1000); app.create(false);
  const rows = app.store.dueOutbox();
  for (const row of rows) app.store.outboxFailure(row.id, 'http_422');
  const selected = rows.find(row => row.webhook_id === hook.id)!;
  const second = rows.filter(row => row.webhook_id === hook.id)[1];
  for (let i = 0; i < 6; i++) app.store.outboxFailure(second.id, 'http_503');
  assert.equal((app.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(second.id) as any).state, 'dead');
  const route = `/api/platform/v1/webhooks/${hook.id}/requeue`;
  const body = { states: ['rejected', 'dead'], from: start, to: start };
  assert.equal((await app.request(route, 'POST', body, {})).status, 401);
  for (const invalid of [{ ...body, states: ['sending'] }, { ...body, states: [] }, { ...body, from: '2026-02-30T12:00:00Z' }, { ...body, to: '2026-10-14T00:00:00Z' }, { ...body, from: undefined }]) {
    assert.equal((await app.request(route, 'POST', invalid)).status, 400);
  }
  assert.equal((await app.request('/api/platform/v1/webhooks/missing/requeue', 'POST', body)).status, 404);
  assert.deepEqual(await (await app.request(route, 'POST', body)).json(), { count: 1 });
  assert.deepEqual(await (await app.request(route, 'POST', body)).json(), { count: 0 });
  const row: any = app.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(selected.id);
  assert.equal(row.attempts, 0); assert.equal(row.state, 'pending'); assert.equal(row.last_status, null); assert.equal(row.next_at, Date.parse(start) + 1000);
  assert.deepEqual(app.store.dueOutbox()[0].payload, selected.payload);
  assert.deepEqual(await (await app.request(route, 'POST', { ...body, from: '2026-10-15T12:00:01Z', to: '2026-10-15T12:00:01Z' })).json(), { count: 1 });
  assert.equal(app.store.platformWebhooks().find(item => item.id === hook.id)!.delivery.rejected, 0);
});

test('MP4 backfill endpoints require worker auth, match completed assets, validate URLs and emit no event', async t => {
  const app = await setup(t), video = app.create(), job = app.store.claim()[0];
  app.store.complete(video.id, { ...result, leaseToken: job.leaseToken });
  const stored = app.store.video(video.id); delete stored.videoFileUrl;
  app.store.db.prepare('UPDATE videos SET data=? WHERE id=?').run(JSON.stringify(stored), video.id);
  const auth = { authorization: `Bearer ${workerToken}` }, route = `/worker/${video.id}/mp4`;
  assert.equal((await app.request('/worker/missing-mp4')).status, 401);
  assert.equal((await app.request(route, 'POST', result)).status, 401);
  assert.deepEqual(await (await app.request('/worker/missing-mp4?limit=1', 'GET', undefined, auth)).json(), { videos: [{ id: video.id, muxAssetId: result.muxAssetId, playbackId: result.playbackId }] });
  assert.equal((await app.request('/worker/missing-mp4?limit=101', 'GET', undefined, auth)).status, 400);
  for (const videoFileUrl of ['https://stream.mux.com/playback.m3u8', 'https://evil.invalid/playback/highest.mp4', 'https://stream.mux.com/playback/../highest.mp4', 'https://stream.mux.com/playback/highest.mp4?token=sensitive']) {
    assert.equal((await app.request(route, 'POST', { ...result, videoFileUrl }, auth)).status, 400);
  }
  assert.equal((await app.request(route, 'POST', { ...result, muxAssetId: 'wrong' }, auth)).status, 409);
  const events = (app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n;
  for (let i = 0; i < 2; i++) assert.deepEqual(await (await app.request(route, 'POST', result, auth)).json(), { success: true });
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n, events);
  assert.deepEqual(await (await app.request('/worker/missing-mp4', 'GET', undefined, auth)).json(), { videos: [] });
});

test('dispatch stops without claims or attempts, uses 60s timeout and 90s lock, and classifies response codes', { timeout: 60_000 }, async t => {
  const app = await setup(t); let status = 422, calls = 0, delay = 0;
  const sink = http.createServer(async (req, res) => { calls++; for await (const _ of req) { /* Drain local fixture. */ }
    if (delay) await new Promise(resolve => setTimeout(resolve, delay)); res.writeHead(status); res.end(); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => sink.close(() => resolve())));
  const hook = app.store.webhookPut({ trigger: 'VIDEO_CREATED', webhookUrl: `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook` });
  app.create(false);
  const original = process.env.DISPATCH_ENABLED, allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOKS;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    process.env.DISPATCH_ENABLED = '0'; await dispatchOutbox(app.store);
    assert.equal(calls, 0); assert.equal(app.store.dueOutbox().length, 0); assert.equal(app.store.platformOps().dispatchEnabled, false);
    assert.equal((app.store.db.prepare('SELECT attempts FROM outbox').get() as any).attempts, 0);
    process.env.DISPATCH_ENABLED = '1';
    const locked = app.store.dueOutbox()[0]; app.advance(60_000); assert.equal(app.store.dueOutbox().length, 0);
    app.advance(30_000); assert.equal(app.store.dueOutbox()[0].id, locked.id);
    app.advance(90_000); await dispatchOutbox(app.store);
    let row: any = app.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(locked.id);
    assert.equal(row.state, 'rejected'); assert.equal(row.last_status, 422); assert.equal(row.attempts, 1);
    app.advance(1e9); await dispatchOutbox(app.store); assert.equal(calls, 1, '422 is never retried');
    for (const code of [400, 401, 404, 408, 429, 500, 503]) {
      status = code; app.create(false); await dispatchOutbox(app.store);
      row = app.store.db.prepare('SELECT * FROM outbox ORDER BY rowid DESC LIMIT 1').get();
      assert.equal(row.state, [408, 429, 500, 503].includes(code) ? 'pending' : 'rejected', String(code)); assert.equal(row.last_status, code);
    }
    status = 204; delay = 10_200; app.create(false); const before = calls; await dispatchOutbox(app.store);
    assert.equal(calls, before + 1); row = app.store.db.prepare('SELECT * FROM outbox ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(row.state, 'delivered', 'synchronous handlers beyond old 10s timeout succeed');
    assert.equal(app.store.platformWebhooks().find(item => item.id === hook.id)!.delivery.rejected, 4);
  } finally { if (original === undefined) delete process.env.DISPATCH_ENABLED; else process.env.DISPATCH_ENABLED = original; if (allowPrivate === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS; else process.env.ALLOW_PRIVATE_WEBHOOKS = allowPrivate; }
});

test('known 4xx stays rejected when the response body is truncated', async t => {
  const app = await setup(t);
  const sink = http.createServer((req, res) => { res.writeHead(422, { 'Content-Type': 'text/plain', 'Content-Length': '100' }); res.write('short', () => setTimeout(() => res.destroy(), 20)); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => sink.close(() => resolve())));
  app.store.webhookPut({ trigger: 'VIDEO_CREATED', webhookUrl: `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook` }); app.create(false);
  const allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOKS;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    await dispatchOutbox(app.store);
  } finally { if (allowPrivate === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS; else process.env.ALLOW_PRIVATE_WEBHOOKS = allowPrivate; }
  const row: any = app.store.db.prepare('SELECT state,last_status,attempts FROM outbox').get();
  assert.deepEqual(row, { state: 'rejected', last_status: 422, attempts: 1 });
});

test('legacy outbox migration preserves an existing rejected HTTP status', async t => {
  const app = await setup(t);
  app.store.webhookPut({ trigger: 'VIDEO_CREATED', webhookUrl: 'http://localhost/hook' }); app.create(false);
  app.store.outboxFailure(app.store.dueOutbox()[0].id, 'http_422');
  app.store.db.exec("ALTER TABLE outbox ADD COLUMN payload TEXT NOT NULL DEFAULT ''");
  const reopened = new Store({ dataDir: app.dataDir, publicBaseUrl: 'http://localhost' });
  try {
    assert.deepEqual(reopened.db.prepare('SELECT state,last_status,attempts FROM outbox').get(), { state: 'rejected', last_status: 422, attempts: 1 });
    assert.deepEqual(reopened.db.pragma('foreign_key_check'), []);
  } finally { reopened.close(); }
});
