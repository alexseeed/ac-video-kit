import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Campaign, DEFAULT_DATA_DIR } from '../src/model.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { campaignFixture, testDir } from './helpers.js';

function campaign(id: string): Campaign {
  return { id, name: `Campaign ${id}`, baseVideo: 'base.mp4',
    output: { width: 1920, height: 1080, fps: 30 }, bubble: { corner: 'bottom-right', diameterPct: 30, marginPct: 4 },
    pages: [{ type: 'website', variable: 'website_0', start: 0, end: 1 }], leadSchemaMapping: { website: 'capture_url' },
    landing: { title: 'Video', text: '', ctaLabel: 'Termin', ctaUrl: 'https://example.invalid/book', brandColor: '#123456', imprintUrl: '', privacyUrl: '' } };
}
function setup(t: any) {
  const directory = join(DEFAULT_DATA_DIR, 'phase3', 'tests'); mkdirSync(directory, { recursive: true });
  const dataDir = mkdtempSync(join(directory, 'deferred-')); let now = Date.parse('2026-11-06T10:00:00.000Z');
  const store = new Store({ dataDir, publicBaseUrl: 'http://localhost:4321', now: () => now });
  store.campaignPut(campaign('fallback'), 1); store.campaignPut(campaign('other'), 1);
  const before = process.env.DEFERRED_RETRY_CAMPAIGNS;
  process.env.DEFERRED_RETRY_CAMPAIGNS = 'fallback';
  t.after(() => {
    if (before === undefined) delete process.env.DEFERRED_RETRY_CAMPAIGNS; else process.env.DEFERRED_RETRY_CAMPAIGNS = before;
    store.close(); rmSync(dataDir, { recursive: true, force: true });
  });
  return { store, advance(ms: number) { now += ms; } };
}
type State = ReturnType<typeof setup>;
const lead = (uid: string) => ({ capture_url: 'https://example.invalid/', originalUid: uid });
function failAll(state: State, id: string, reason: string): string {
  let status = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = state.store.claim(1)[0]; assert.equal(job.id, id);
    status = state.store.fail(job.id, reason, job.leaseToken).status;
  }
  return status;
}
function httpStatus(status: number) { return (error: any) => error.status === status; }

test('listed campaign defers after three render failures and still looks waiting outside', t => {
  const state = setup(t); const { store } = state;
  const video = store.upsertVideo('fallback', { variables: lead('defer-1') });
  assert.equal(failAll(state, video.id, 'render_failed'), 'deferred');
  const stored = store.video(video.id);
  assert.equal(stored.status, 'deferred'); assert.equal(stored.failureReason, 'render_failed');
  assert.match(stored.deferredAt, /^2026-11-06T/);
  assert.deepEqual(store.claim(1), []);
  const listed = store.listVideos('fallback').videos.find((row: any) => row._id === video.id)!;
  assert.equal(listed.renderingStatus, 'QUEUED');
  assert.deepEqual(store.db.prepare("SELECT count(*) n FROM events WHERE video_id=? AND trigger='VIDEO_UNRENDERABLE'").get(video.id), { n: 0 });
  assert.deepEqual(store.db.prepare('SELECT count(*) n FROM events WHERE video_id=?').get(video.id), { n: 1 });
  assert.equal(store.platformVideo('fallback', video.id).status, 'deferred');
  assert.equal(store.platformVideos('fallback', { status: 'deferred' }).videos[0].id, video.id);
  assert.deepEqual(store.platformCampaign('fallback').counts, { total: 1, created: 0, queued: 0, rendering: 0, rendered: 0, failed: 0, cancelled: 0, deferred: 1, expired: 0 });
  assert.equal(store.platformStats('fallback').videos.deferred, 1);
  assert.deepEqual(store.platformOps().queue.deferred, 1);
  assert.equal(store.platformOps().queue.oldestDeferredAt, stored.deferredAt);
});

test('website_unreachable still fails finally and unlisted campaigns behave as before', t => {
  const state = setup(t); const { store } = state;
  const unreachable = store.upsertVideo('fallback', { variables: lead('unreachable-1') });
  assert.equal(failAll(state, unreachable.id, 'website_unreachable'), 'failed');
  assert.equal(store.video(unreachable.id).failureReason, 'website_unreachable');
  assert.deepEqual(store.db.prepare("SELECT count(*) n FROM events WHERE video_id=? AND trigger='VIDEO_UNRENDERABLE'").get(unreachable.id), { n: 1 });
  const plain = store.upsertVideo('other', { variables: lead('plain-1') });
  assert.equal(failAll(state, plain.id, 'render_failed'), 'failed');
  assert.equal('deferredAt' in store.video(plain.id), false);
  assert.deepEqual(store.platformCampaign('other').counts.deferred, 0);
});

test('lease expiry on the last attempt defers instead of failing', t => {
  const state = setup(t); const { store } = state;
  const video = store.upsertVideo('fallback', { variables: lead('lease-1') });
  const first = store.claim(1)[0]; state.advance(30 * 60_000);
  const second = store.claim(1)[0]; assert.equal(second.attempts, 2); state.advance(30 * 60_000);
  const third = store.claim(1)[0]; assert.equal(third.attempts, 3); state.advance(30 * 60_000);
  assert.deepEqual(store.claim(1), []);
  const stored = store.video(video.id);
  assert.equal(stored.status, 'deferred'); assert.equal(stored.failureReason, 'render_failed');
  assert.match(stored.deferredAt, /^2026-11-06T/);
  assert.equal(first.id, video.id);
});

test('release frees oldest first, grants exactly one attempt and never defers twice', t => {
  const state = setup(t); const { store } = state;
  const ids = ['oldest', 'middle', 'newest'].map(uid => {
    const video = store.upsertVideo('fallback', { variables: lead(uid) });
    failAll(state, video.id, 'render_failed'); state.advance(1000);
    return video.id;
  });
  assert.deepEqual(store.releaseDeferredVideos('fallback', 2), { released: 2, remaining: 1 });
  assert.deepEqual(ids.slice(0, 2).map(id => store.video(id).status), ['queued', 'queued']);
  assert.equal(store.video(ids[2]).status, 'deferred');
  const released = store.video(ids[0]);
  assert.equal(released.attempts, 2); assert.match(released.deferredRetryAt, /^2026-11-06T/);
  const job = store.claim(1)[0]; assert.equal(job.attempts, 3);
  assert.equal(store.fail(job.id, 'render_failed', job.leaseToken).status, 'failed');
  assert.equal(store.video(job.id).status, 'failed');
  assert.deepEqual(store.releaseDeferredVideos('fallback', 50), { released: 1, remaining: 0 });
  const retry = store.claim(10).find(item => item.id === ids[2])!;
  store.complete(retry.id, { muxAssetId: 'asset', playbackId: 'playback', videoFileUrl: 'https://stream.mux.com/playback/highest.mp4', backgroundRecordedAt: '2026-11-06T00:00:00.000Z', durationSec: 1, leaseToken: retry.leaseToken });
  assert.equal(store.video(ids[2]).status, 'rendered');
  assert.equal(store.platformVideo('fallback', ids[2]).failureReason, null);
  assert.throws(() => store.releaseDeferredVideos('fallback', 0), httpStatus(400));
  assert.throws(() => store.releaseDeferredVideos('fallback', 51), httpStatus(400));
  assert.throws(() => store.releaseDeferredVideos('missing', 5), httpStatus(404));
});

test('claim prefers fresh videos over released retries at equal priority', t => {
  const state = setup(t); const { store } = state;
  const old = store.upsertVideo('fallback', { variables: lead('retry-first') });
  failAll(state, old.id, 'render_failed');
  store.releaseDeferredVideos('fallback', 10);
  state.advance(1000);
  const fresh = store.upsertVideo('fallback', { variables: lead('fresh-later') });
  assert.deepEqual(store.claim(2).map(job => job.id), [fresh.id, old.id]);
});

test('cancel stops deferred videos and retry requeues them', t => {
  const state = setup(t); const { store } = state;
  const cancelled = store.upsertVideo('fallback', { variables: lead('cancel-1') });
  failAll(state, cancelled.id, 'render_failed');
  assert.deepEqual(store.cancelVideo('fallback', cancelled.id), { id: cancelled.id, status: 'cancelled' });
  const retried = store.upsertVideo('fallback', { variables: lead('retry-1') });
  failAll(state, retried.id, 'render_failed');
  const queued = store.retryVideo('fallback', retried.id);
  assert.equal(queued.status, 'queued'); assert.equal(queued.attempts, 0);
  assert.equal(store.video(retried.id).failureReason, null);
});

test('release endpoint validates, frees and reports per campaign', async t => {
  const id = campaignFixture().id;
  const before = process.env.DEFERRED_RETRY_CAMPAIGNS;
  process.env.DEFERRED_RETRY_CAMPAIGNS = id;
  t.after(() => { if (before === undefined) delete process.env.DEFERRED_RETRY_CAMPAIGNS; else process.env.DEFERRED_RETRY_CAMPAIGNS = before; });
  let time = Date.parse('2026-11-06T10:00:00.000Z');
  const app = createApp({ dataDir: testDir('deferred-http'), publicBaseUrl: 'http://localhost', apiKeys: ['deferred-fixture'], workerToken: 'deferred-worker-token', internalViewToken: 'deferred-internal-token', previewSecret: 'deferred-preview-secret', dispatch: false, now: () => time });
  app.store.campaignPut(campaignFixture(), 12);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (route: string, method = 'GET', input?: unknown, key = 'deferred-fixture') => fetch(base + route,
    { method, headers: { 'content-type': 'application/json', 'x-api-key': key }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const route = `/api/platform/v1/campaigns/${id}/deferred/release`;
  assert.equal((await request(route, 'POST', { limit: 5 }, '')).status, 401);
  for (const input of [{}, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '5' }]) assert.equal((await request(route, 'POST', input)).status, 400);
  assert.equal((await request('/api/platform/v1/campaigns/missing/deferred/release', 'POST', { limit: 5 })).status, 404);
  assert.equal((await request(route, 'GET')).status, 404);
  const video = app.store.upsertVideo(id, { variables: { capture_url: 'http://localhost' } });
  for (let attempt = 1; attempt <= 3; attempt++) { const job = app.store.claim(1)[0]; app.store.fail(job.id, 'render_failed', job.leaseToken); time += 1000; }
  assert.equal(app.store.video(video.id).status, 'deferred');
  assert.deepEqual(await (await request(route, 'POST', { limit: 5 })).json(), { released: 1, remaining: 0 });
  assert.equal(app.store.video(video.id).status, 'queued');
});
