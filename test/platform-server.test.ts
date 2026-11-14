import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { campaignFixture, testDir } from './helpers.js';

const campaignId = campaignFixture().id;
const auth = { 'X-Api-Key': 'platform-fixture-api', 'Content-Type': 'application/json' };
const lead = { capture_url: 'http://localhost/site', email: 'ada@example.invalid', first_name: 'Ada', company_name: 'Büro GmbH', sourceOnly: 'retained-variable' };
async function setup(t: any) {
  let time = Date.parse('2026-10-15T12:00:00Z');
  const app = createApp({ dataDir: testDir('platform-http'), publicBaseUrl: 'http://localhost', apiKeys: ['platform-fixture-api'],
    workerToken: 'fixture-worker-token', internalViewToken: 'fixture-internal', previewSecret: 'fixture-preview-secret', dispatch: false, now: () => time });
  app.store.campaignPut(campaignFixture(), 12);
  app.store.campaignPut(campaignFixture({ id: 'other-campaign' }), 12);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, method = 'GET', payload?: unknown, headers: Record<string, string> = auth) => new Promise<Response>((resolve, reject) => {
    const req = http.request(base + path, { method, headers: { host: 'localhost', ...headers } }, async res => {
      const chunks: Buffer[] = []; for await (const chunk of res) chunks.push(chunk);
      resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as any }));
    });
    req.on('error', reject); req.end(payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  const ready = () => {
    const created = app.store.upsertVideo(campaignId, { variables: lead });
    const job = app.store.claim(1)[0];
    app.store.complete(job.id, { muxAssetId: 'fixture-asset', playbackId: 'fixture-playback', videoFileUrl: 'https://stream.mux.com/fixture-playback/highest.mp4', backgroundRecordedAt: '2026-10-15T00:00:00.000Z', durationSec: 12, leaseToken: job.leaseToken });
    return created;
  };
  return { ...app, request, ready, advance: (ms: number) => { time += ms; } };
}
const route = (suffix = '') => `/api/platform/v1/campaigns/${campaignId}${suffix}`;

test('every platform operation requires a header key and returns no-store JSON; legacy query auth remains compatible', async t => {
  const app = await setup(t), video = app.ready();
  const operations: [string, string][] = [
    ['/api/platform/v1/campaigns', 'GET'], [route(), 'GET'], [route('/videos'), 'GET'], [route(`/videos/${video.id}`), 'GET'],
    [route('/stats'), 'GET'], [route(`/videos/${video.id}/preview-ticket`), 'POST'], [route(`/videos/${video.id}/retry`), 'POST'],
    [route('/import'), 'POST'], [route('/deferred/release'), 'POST'], ['/api/platform/v1/webhooks', 'GET'], ['/api/platform/v1/webhooks', 'POST'], ['/api/platform/v1/webhooks?id=fixture', 'DELETE'],
  ];
  for (const [path, method] of operations) {
    for (const headers of [{}, { 'X-Api-Key': 'wrong-key' }] as Record<string, string>[]) {
      const response = await app.request(path, method, undefined, headers);
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-type')!, /application\/json/);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
    assert.equal((await app.request(path + (path.includes('?') ? '&' : '?') + 'apiKey=platform-fixture-api', method, undefined, {})).status, 401);
  }
  assert.equal((await app.request('/api/public/v1/campaigns?apiKey=platform-fixture-api', 'GET', undefined, {})).status, 200);
  assert.equal((await app.request('/api/platform/v1/campaigns/missing')).status, 404);
  assert.equal((await app.request(route('/stats/not-a-video'))).status, 404);
  assert.equal((await app.request(route('/unknown-action'))).status, 404);
  assert.equal((await app.request(route('/videos'), 'PUT')).status, 404);
});

test('campaign/video endpoints project safe contract fields, filter and paginate, and enforce campaign ownership', async t => {
  const app = await setup(t), video = app.ready();
  app.store.upsertVideo(campaignId, { variables: { ...lead, email: 'second@example.invalid', first_name: 'Grace', company_name: 'Other' }, queueForRender: false });
  // Raw rows and operational paths may contain sensitive data; only variables are lead sources.
  const stored = app.store.video(video.id); assert.ok(typeof stored.originalRow === 'object'); stored.originalRow.email = 'raw-only@example.invalid'; stored.localPath = '/private/worker/recording.mp4';
  app.store.db.prepare('UPDATE videos SET data=? WHERE id=?').run(JSON.stringify(stored), video.id);
  const list = await (await app.request('/api/platform/v1/campaigns')).json();
  const campaign = list.find((c: any) => c.id === campaignId);
  assert.deepEqual(campaign.counts, { total: 2, created: 1, queued: 0, rendering: 0, rendered: 1, failed: 0, cancelled: 0, deferred: 0, expired: 0 });
  assert.equal(campaign.pageCount, 3); assert.equal(campaign.durationSec, 12);
  assert.equal(campaign.domain, null);
  assert.doesNotMatch(JSON.stringify(list), /base\.mp4|page2\.png|private/);
  const detail = await (await app.request(route())).json();
  assert.deepEqual(detail.variableSchema.website_0.validator, { type: 'url', domain: null });
  assert.equal(detail.leadSchemaMapping.website, 'capture_url'); assert.equal(detail.landing.ctaLabel, 'Termin buchen');
  const videos = await (await app.request(route('/videos?q=B%C3%9CRO&status=rendered&limit=1&offset=0'))).json();
  assert.equal(videos.count, 1); assert.equal(videos.videos.length, 1);
  const row = videos.videos[0];
  assert.equal(row.id, video.id); assert.equal(row.email, lead.email); assert.equal(row.firstName, 'Ada'); assert.equal(row.companyName, lead.company_name);
  assert.equal(row.website, lead.capture_url); assert.equal(row.status, 'rendered'); assert.equal(row.renderingStatus, 'RENDERED');
  assert.equal(row.attempts, 1); assert.equal(row.failureReason, null); assert.match(row.videoUrl, /\/video\//); assert.match(row.thumbnailEmbed, /<img/);
  assert.deepEqual(row.stats, { views: 0, starts: 0, finishes: 0, firstViewedAt: null, lastViewedAt: null });
  assert.equal(row.variables, undefined); assert.equal(row.originalRow, undefined); assert.equal(row.localPath, undefined);
  const single = await (await app.request(route(`/videos/${video.id}`))).json();
  assert.equal(single.variables.sourceOnly, lead.sourceOnly); assert.ok(Array.isArray(single.events));
  assert.ok(single.events.every((e: any) => Object.keys(e).sort().join(',') === 'at,trigger'));
  assert.equal((await app.request(`/api/platform/v1/campaigns/other-campaign/videos/${video.id}`)).status, 404);
  for (const query of ['limit=201', 'limit=0', 'offset=-1', 'offset=1e30', 'offset=9007199254740992', 'limit=no', 'status=unknown']) assert.equal((await app.request(route('/videos?' + query))).status, 400, query);
  const empty = await (await app.request(route('/videos?limit=1&offset=2'))).json(); assert.equal(empty.count, 2); assert.deepEqual(empty.videos, []);
});

test('stats use UTC calendar dates, event session dedupe, campaign joins and unique videos', async t => {
  const app = await setup(t), video = app.ready();
  for (const type of ['VIEWED', 'STARTED', 'FINISHED']) {
    assert.equal(app.store.track(video.shortId, type, 'same-session').accepted, true);
    assert.equal(app.store.track(video.shortId, type, 'same-session').accepted, false);
  }
  const response = await app.request(route('/stats?from=2026-10-15&to=2026-10-15'));
  assert.equal(response.status, 200); const stats = await response.json();
  assert.deepEqual(stats.videos, { total: 1, rendered: 1, cancelled: 0, deferred: 0 });
  assert.deepEqual(stats.events, { VIDEO_VIEWED: 1, VIDEO_STARTED: 1, VIDEO_FINISHED: 1 });
  assert.deepEqual(stats.uniqueVideos, { viewed: 1, started: 1, finished: 1 });
  assert.deepEqual(stats.daily, [{ date: '2026-10-15', views: 1, starts: 1, finishes: 1 }]);
  const defaults = await (await app.request(route('/stats'))).json();
  assert.equal(defaults.from, '2026-09-16'); assert.equal(defaults.to, '2026-10-15'); assert.equal(defaults.daily.length, 30);
  for (const query of ['from=invalid', 'from=2026-02-30', 'from=2026-10-16&to=2026-10-15', 'from=2025-01-01&to=2026-10-15']) assert.equal((await app.request(route('/stats?' + query))).status, 400);
  const other = await (await app.request('/api/platform/v1/campaigns/other-campaign/stats?from=2026-10-15&to=2026-10-15')).json();
  assert.equal(other.events.VIDEO_VIEWED, 0);
});

test('preview tickets expire, reject other videos, never set cookies or emit tracking and preserve ordinary tracking', async t => {
  const app = await setup(t), video = app.ready();
  const before = (app.store.db.prepare('SELECT count(*) AS n FROM events').get() as any).n;
  assert.equal((await app.request(`/api/platform/v1/campaigns/other-campaign/videos/${video.id}/preview-ticket`, 'POST')).status, 404);
  const issued = await (await app.request(route(`/videos/${video.id}/preview-ticket`), 'POST')).json();
  assert.equal(issued.expiresAt, '2026-10-15T12:10:00.000Z');
  const url = new URL(issued.url); assert.equal(url.origin, 'http://localhost'); assert.equal(url.pathname, `/video/${video.shortId}`);
  const preview = await app.request(url.pathname + url.search); const html = await preview.text();
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('set-cookie'), null);
  assert.match(html, /Vorschau · Tracking deaktiviert/); assert.doesNotMatch(html, /sendBeacon|const shortId=/);
  assert.equal(preview.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((app.store.db.prepare('SELECT count(*) AS n FROM events').get() as any).n, before);
  const another = app.ready();
  assert.equal((await app.request(`/video/${another.shortId}${url.search}`)).status, 403);
  assert.equal((await app.request(url.pathname + '?preview=tampered')).status, 403);
  assert.equal((await app.request(url.pathname + '?preview=')).status, 403);
  const ordinary = await app.request(url.pathname); assert.match(await ordinary.text(), /sendBeacon/); assert.match(ordinary.headers.get('set-cookie')!, /ac_session=/);
  const normalCookie = ordinary.headers.get('set-cookie')!.split(';')[0];
  const existingSessionPreview = await app.request(url.pathname + url.search, 'GET', undefined, { cookie: normalCookie });
  assert.equal(existingSessionPreview.headers.get('set-cookie'), null); assert.doesNotMatch(await existingSessionPreview.text(), /sendBeacon/);
  const operational = await app.request(url.pathname + '?internal=fixture-internal');
  const internalCookie = operational.headers.get('set-cookie')!.split(';')[0];
  const internalPreview = await app.request(url.pathname + url.search, 'GET', undefined, { cookie: internalCookie });
  assert.equal(internalPreview.headers.get('set-cookie'), null); assert.match(await internalPreview.text(), /Vorschau · Tracking deaktiviert/);
  app.advance(600_000);
  const expired = await app.request(url.pathname + url.search);
  assert.equal(expired.status, 403); assert.equal(expired.headers.get('set-cookie'), null); assert.doesNotMatch(await expired.text(), /sendBeacon/);
  assert.equal((await app.request(url.pathname, 'GET', undefined, { host: 'wrong.invalid' })).status, 404);
});

test('retry is idempotent for queued work, permits failed/unqueued created videos and respects leases', async t => {
  const app = await setup(t);
  const created = app.store.upsertVideo(campaignId, { variables: lead, queueForRender: false });
  const path = route(`/videos/${created.id}/retry`);
  assert.equal((await app.request(`/api/platform/v1/campaigns/other-campaign/videos/${created.id}/retry`, 'POST')).status, 404);
  const queued = await (await app.request(path, 'POST')).json();
  assert.equal(queued.status, 'queued'); assert.equal(queued.attempts, 0);
  assert.deepEqual(await (await app.request(path, 'POST')).json(), queued);
  const job = app.store.claim(1)[0]; assert.equal((await app.request(path, 'POST')).status, 409);
  app.store.fail(job.id, 'render_failed', job.leaseToken);
  for (let i = 0; i < 2; i++) { const retry = app.store.claim(1)[0]; app.store.fail(retry.id, 'render_failed', retry.leaseToken); }
  const retried = await (await app.request(path, 'POST')).json(); assert.equal(retried.status, 'queued'); assert.equal(retried.attempts, 0);
  const resumed = app.store.claim(1)[0];
  app.store.complete(resumed.id, { muxAssetId: 'asset', playbackId: 'playback', videoFileUrl: 'https://stream.mux.com/playback/highest.mp4', backgroundRecordedAt: '2026-10-15T00:00:00.000Z', durationSec: 12, leaseToken: resumed.leaseToken });
  assert.equal((await app.request(path, 'POST')).status, 409);
});

test('platform import shares v2 dedupe/idempotency and dry-run validation without writes', async t => {
  const app = await setup(t);
  const payload = { importId: 'platform-import', duplicateIdentifierField: 'email', queueAllVideosForRender: true,
    videos: [lead, lead, { email: 'invalid@example.invalid' }] };
  const dry = await (await app.request(route('/import'), 'POST', { ...payload, dryRun: true })).json();
  assert.equal(dry.inserted, 1); assert.equal(dry.duplicates, 1); assert.equal(dry.invalidRows, 1);
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM videos').get() as any).n, 0);
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM imports').get() as any).n, 0);
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n, 0);
  const imported = await (await app.request(route('/import'), 'POST', payload)).json(); assert.deepEqual(imported, dry);
  assert.deepEqual(await (await app.request(route('/import'), 'POST', payload)).json(), imported);
  const legacy = await (await app.request(`/api/public/v1/campaigns/${campaignId}/videos/import/v2`, 'POST', payload)).json(); assert.deepEqual(legacy, imported);
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM videos').get() as any).n, 1);
  for (const bad of [{ videos: Array(2001).fill(lead) }, { videos: [lead], dryRun: 'true' }, { videos: 'invalid' }, { videos: [lead], queueAllVideosForRender: 'true' }]) {
    assert.equal((await app.request(route('/import'), 'POST', bad)).status, 400);
  }
  assert.equal((await app.request(route('/import'), 'POST', '{')).status, 400);
  assert.equal((await app.request(route('/import'), 'POST', { videos: [], padding: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
});

test('webhook CRUD masks target queries and returns delivery summaries without payloads', async t => {
  const app = await setup(t);
  const payload = { trigger: 'VIDEO_RENDERED', campaignId, webhookUrl: 'http://localhost/hook?token=private-fixture#fragment' };
  const response = await app.request('/api/platform/v1/webhooks', 'POST', payload); assert.equal(response.status, 200);
  const hook = await response.json(); assert.equal(typeof hook.id, 'string'); assert.doesNotMatch(JSON.stringify(hook), /private-fixture|fragment|webhookUrl/);
  const video = app.ready();
  const due = app.store.dueOutbox(); app.store.outboxFailure(due[0].id, 'http_503');
  const list = await (await app.request('/api/platform/v1/webhooks')).json();
  assert.equal(list.length, 1); assert.equal(list[0].target, 'http://localhost/hook?***'); assert.equal(list[0].campaignName, 'Offline fixture');
  assert.deepEqual({ pending: list[0].delivery.pending, delivered: list[0].delivery.delivered, dead: list[0].delivery.dead }, { pending: 1, delivered: 0, dead: 0 });
  assert.equal(typeof list[0].delivery.lastErrorAt, 'string'); assert.equal(typeof list[0].delivery.lastErrorCode, 'string');
  assert.doesNotMatch(JSON.stringify(list), /private-fixture|fragment|originalRow|playbackId|webhookUrl/);
  for (const bad of [{ ...payload, webhookUrl: 'file:///private/file' }, { ...payload, trigger: 'INVALID' }, { ...payload, campaignId: 4 }]) assert.equal((await app.request('/api/platform/v1/webhooks', 'POST', bad)).status, 400);
  assert.equal((await app.request('/api/platform/v1/webhooks', 'POST', { ...payload, campaignId: 'missing' })).status, 404);
  assert.equal((await app.request('/api/platform/v1/webhooks', 'DELETE')).status, 400);
  assert.equal((await app.request('/api/platform/v1/webhooks?id=missing', 'DELETE')).status, 404);
  assert.equal((await app.request('/api/platform/v1/webhooks?id=' + hook.id, 'DELETE')).status, 204);
  assert.deepEqual(await (await app.request('/api/platform/v1/webhooks')).json(), []);
  assert.equal(app.store.video(video.id).status, 'rendered');
});

test('server requires an independent preview secret before creating storage', () => {
  assert.throws(() => createApp({ publicBaseUrl: 'http://localhost', apiKeys: [], workerToken: '', internalViewToken: '', previewSecret: '' }), /PREVIEW_SECRET is required/);
});

test('platform answers never exceed 2 MiB and return explicit JSON instead of truncated fields', async t => {
  const app = await setup(t), video = app.ready();
  const stored = app.store.video(video.id); stored.title = 'ä'.repeat(600_000);
  app.store.db.prepare('UPDATE videos SET data=? WHERE id=?').run(JSON.stringify(stored), video.id);
  const response = await app.request(route('/videos'));
  assert.equal(response.status, 413); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'response_too_large' });
});
