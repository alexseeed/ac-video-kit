import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Campaign, DEFAULT_DATA_DIR } from '../src/model.js';
import { Store } from '../src/store.js';

function campaign(id = 'platform'): Campaign {
  return { id, name: `Campaign ${id}`, baseVideo: 'private/base.mp4', domain: 'videos.example.invalid',
    output: { width: 1920, height: 1080, fps: 30 }, bubble: { corner: 'bottom-right', diameterPct: 30, marginPct: 4 },
    pages: [{ type: 'website', variable: 'website_0', start: 0, end: 1 }], leadSchemaMapping: { website: 'capture_url' },
    landing: { title: 'Für {{first_name}}', text: '', ctaLabel: 'Termin', ctaUrl: 'https://example.invalid/book', brandColor: '#123456', imprintUrl: '', privacyUrl: '' } };
}
function setup(t: any) {
  const directory = join(DEFAULT_DATA_DIR, 'phase3', 'tests'); mkdirSync(directory, { recursive: true });
  const dataDir = mkdtempSync(join(directory, 'platform-store-')); let now = Date.parse('2026-10-15T10:00:00.000Z');
  let store = new Store({ dataDir, publicBaseUrl: 'http://localhost:4321', now: () => now });
  store.campaignPut(campaign(), 1); store.campaignPut(campaign('other'), 1);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { get store() { return store; }, id: 'platform', advance(ms: number) { now += ms; }, setTime(at: string) { now = Date.parse(at); },
    restart() { store.close(); store = new Store({ dataDir, publicBaseUrl: 'http://localhost:4321', now: () => now }); } };
}
type State = ReturnType<typeof setup>;
function create(state: State, variables: Record<string, any> = {}, queue = false, campaignId = state.id) {
  return state.store.upsertVideo(campaignId, { variables: { capture_url: 'https://example.invalid/', ...variables }, queueForRender: queue });
}
function rendered(state: State, variables: Record<string, any> = {}, campaignId = state.id) {
  const video = create(state, variables, true, campaignId); const job = state.store.claim(1)[0]; assert.equal(job.id, video.id);
  state.store.complete(job.id, { muxAssetId: 'asset', playbackId: 'playback', videoFileUrl: 'https://stream.mux.com/playback/highest.mp4', backgroundRecordedAt: '2026-10-15T00:00:00.000Z', durationSec: 1, leaseToken: job.leaseToken });
  return video;
}
function httpStatus(status: number) { return (error: any) => error.status === status; }

test('platform campaign projections contain exact safe fields and all status counts', t => {
  const state = setup(t); const { store, id } = state;
  const template: any = campaign(); template.internalSecret = 'campaign-secret'; template.landing.internalSecret = 'landing-secret';
  template.landing.ctaUrl = 'https://example.invalid/book?token=private#private'; store.campaignPut(template, 1);
  create(state); create(state, { originalUid: 'queued' }, true); const processing = create(state, { originalUid: 'rendering' }, true);
  const ready = create(state, { originalUid: 'rendered' }, true); const failed = create(state, { originalUid: 'failed' }, true);
  store.db.prepare("UPDATE videos SET status='rendering' WHERE id=?").run(processing.id);
  store.db.prepare("UPDATE videos SET status='rendered' WHERE id=?").run(ready.id);
  store.db.prepare("UPDATE videos SET status='failed' WHERE id=?").run(failed.id);
  const summary = store.platformCampaigns().find(row => row.id === id)!;
  assert.deepEqual(Object.keys(summary).sort(), ['id', 'name', 'createdAt', 'domain', 'durationSec', 'pageCount', 'counts'].sort());
  assert.deepEqual(summary.counts, { total: 5, created: 1, queued: 1, rendering: 1, rendered: 1, failed: 1, cancelled: 0, deferred: 0, expired: 0 });
  assert.equal(summary.pageCount, 1); assert.equal(summary.domain, 'videos.example.invalid');
  const detail = store.platformCampaign(id); assert.deepEqual(detail.leadSchemaMapping, { website: 'capture_url' });
  assert.deepEqual(detail.variableSchema, store.schema(id, 'schema').variableSchema);
  assert.equal(detail.landing.title, template.landing.title);
  assert.equal(detail.landing.ctaUrl, 'https://example.invalid/book');
  assert.doesNotMatch(JSON.stringify(detail), /private\/base|internalSecret|campaign-secret|landing-secret/);
  assert.throws(() => store.platformCampaign('missing'), httpStatus(404));
});

test('platform video lists filter and paginate lead variables without leaking raw rows or worker internals', t => {
  const state = setup(t); const ready = rendered(state, { email: 'anne@example.invalid', first_name: 'Änne', last_name: 'Müller', company_name: '100% GmbH' });
  const created = create(state, { email: 'grace@example.invalid', firstName: 'Grace', companyName: 'Computing' }); create(state, {}, false, 'other');
  const raw = state.store.video(ready.id); assert.ok(typeof raw.originalRow === 'object'); raw.originalRow.rawOnly = 'not-for-platform'; raw.failureReason = 'https://secret.invalid/?token=secret';
  state.store.db.prepare('UPDATE videos SET data=? WHERE id=?').run(JSON.stringify(raw), ready.id);
  state.store.track(ready.shortId, 'VIEWED', 'session'); state.store.track(ready.shortId, 'STARTED', 'session');
  const all = state.store.platformVideos(state.id); assert.equal(all.count, 2); assert.equal(all.videos.length, 2);
  const row = all.videos.find(video => video.id === ready.id)!;
  assert.deepEqual(Object.keys(row).sort(), ['id', 'shortId', 'title', 'status', 'renderingStatus', 'attempts', 'failureReason', 'createdAt', 'queuedAt', 'renderedAt', 'email', 'firstName', 'companyName', 'website', 'videoUrl', 'thumbnailUrl', 'thumbnailEmbed', 'stats'].sort());
  assert.equal(row.firstName, 'Änne'); assert.equal(row.companyName, '100% GmbH'); assert.equal(row.website, 'https://example.invalid/');
  assert.equal(row.failureReason, null); assert.equal(row.videoUrl, `https://videos.example.invalid/video/${ready.shortId}`); assert.match(row.thumbnailEmbed!, /<img/);
  assert.deepEqual(row.stats, { views: 1, starts: 1, finishes: 0, firstViewedAt: '2026-10-15T10:00:00.000Z', lastViewedAt: '2026-10-15T10:00:00.000Z' });
  raw.failureReason = 'render_failed'; state.store.db.prepare('UPDATE videos SET data=? WHERE id=?').run(JSON.stringify(raw), ready.id);
  assert.equal(state.store.platformVideo(state.id, ready.id).failureReason, null, 'a later success hides the old failure reason');
  assert.doesNotMatch(JSON.stringify(all), /rawOnly|not-for-platform|originalRow|muxAssetId|playbackId|leaseToken|token=secret/);
  assert.equal(state.store.platformVideos(state.id, { q: 'änNE' }).videos[0].id, ready.id);
  assert.equal(state.store.platformVideos(state.id, { q: 'MÜLLER' }).count, 1);
  assert.equal(state.store.platformVideos(state.id, { q: '%' }).count, 1);
  assert.equal(state.store.platformVideos(state.id, { q: 'GRACE@' }).videos[0].id, created.id);
  assert.equal(state.store.platformVideos(state.id, { status: 'created' }).videos[0].videoUrl, null);
  assert.deepEqual(state.store.platformVideos(state.id, { status: 'rendered', offset: 1 }), { count: 1, videos: [] });
  assert.equal(state.store.platformVideos(state.id, { limit: 1, offset: 1 }).count, 2);
  for (const invalid of [{ limit: 201 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { status: 'RENDERED' }, { q: 123 }]) assert.throws(() => state.store.platformVideos(state.id, invalid as any), httpStatus(400));
  assert.throws(() => state.store.platformVideos('missing'), httpStatus(404));
});

test('platform video detail enforces campaign ownership and retains only the most recent 50 safe event records', t => {
  const state = setup(t); const video = rendered(state, { email: 'person@example.invalid', custom: 'retained' });
  for (let index = 0; index < 60; index++) { state.advance(1); state.store.track(video.shortId, 'VIEWED', `session-${index}`); }
  const detail = state.store.platformVideo(state.id, video.id);
  assert.equal(detail.variables.custom, 'retained'); assert.equal(detail.events.length, 50);
  assert.deepEqual(Object.keys(detail.events[0]).sort(), ['at', 'trigger']); assert.equal(detail.events[0].at, '2026-10-15T10:00:00.060Z');
  assert.equal(detail.events[49].at, '2026-10-15T10:00:00.011Z'); assert.equal(detail.stats.views, 60);
  assert.equal('campaignId' in detail, false); assert.equal('originalRow' in detail, false);
  assert.throws(() => state.store.platformVideo('other', video.id), httpStatus(404));
  assert.throws(() => state.store.platformVideo(state.id, 'missing'), httpStatus(404));
});

test('platform UTC statistics count accepted session events, unique videos and zero-filled inclusive days', t => {
  const state = setup(t); const one = rendered(state); const two = rendered(state, { originalUid: 'two' }); const foreign = rendered(state, {}, 'other'); create(state);
  state.setTime('2026-10-14T23:59:59.999Z'); state.store.track(one.shortId, 'VIEWED', 'before');
  state.setTime('2026-10-15T00:00:00.000Z');
  for (const type of ['VIEWED', 'STARTED', 'FINISHED']) {
    assert.equal(state.store.track(one.shortId, type, 'same').accepted, true);
    assert.equal(state.store.track(one.shortId, type, 'same').accepted, false);
  }
  state.advance(30 * 60_000); for (const type of ['VIEWED', 'STARTED', 'FINISHED']) assert.equal(state.store.track(one.shortId, type, 'same').accepted, true);
  state.store.track(two.shortId, 'VIEWED', 'second'); state.store.track(foreign.shortId, 'VIEWED', 'foreign');
  state.setTime('2026-10-16T00:00:00.000Z'); state.store.track(two.shortId, 'VIEWED', 'following-day');
  const oneDay = state.store.platformStats(state.id, { from: '2026-10-15', to: '2026-10-15' });
  assert.deepEqual(oneDay, { from: '2026-10-15', to: '2026-10-15', videos: { total: 3, rendered: 2, cancelled: 0, deferred: 0 },
    events: { VIDEO_VIEWED: 3, VIDEO_STARTED: 2, VIDEO_FINISHED: 2 }, uniqueVideos: { viewed: 2, started: 1, finished: 1 },
    daily: [{ date: '2026-10-15', views: 3, starts: 2, finishes: 2 }] });
  const range = state.store.platformStats(state.id, { from: '2026-10-15', to: '2026-10-17' });
  assert.deepEqual(range.daily[2], { date: '2026-10-17', views: 0, starts: 0, finishes: 0 }); assert.equal(range.events.VIDEO_VIEWED, 4); assert.equal(range.uniqueVideos.viewed, 2);
  const defaults = state.store.platformStats(state.id); assert.equal(defaults.from, '2026-09-17'); assert.equal(defaults.to, '2026-10-16'); assert.equal(defaults.daily.length, 30);
  assert.equal(state.store.platformStats(state.id, { from: '2025-10-16', to: '2026-10-16' }).daily.length, 366);
  for (const invalid of [{ from: '2026-02-30' }, { from: '2026-10-15T00:00:00Z' }, { from: '' }, { from: '2026-10-18', to: '2026-10-17' }, { from: '2025-10-15', to: '2026-10-16' }]) assert.throws(() => state.store.platformStats(state.id, invalid), httpStatus(400));
  assert.throws(() => state.store.platformStats('missing'), httpStatus(404));
  state.restart(); assert.deepEqual(state.store.platformStats(state.id, { from: '2026-10-15', to: '2026-10-15' }), oneDay);
});

test('platform retry preserves video identity, resets failed attempts and rejects unsafe states and leases', t => {
  const state = setup(t); const ready = rendered(state, { originalUid: 'ready' }); const created = create(state);
  const queued = state.store.retryVideo(state.id, created.id); assert.deepEqual(queued, { id: created.id, status: 'queued', attempts: 0, queuedAt: '2026-10-15T10:00:00.000Z' });
  state.advance(1000); assert.deepEqual(state.store.retryVideo(state.id, created.id), queued);
  let job = state.store.claim(1)[0]; assert.throws(() => state.store.retryVideo(state.id, job.id), httpStatus(409));
  for (let index = 1; index <= 3; index++) { state.store.fail(job.id, 'website_unreachable', job.leaseToken); if (index < 3) job = state.store.claim(1)[0]; }
  assert.equal(state.store.video(job.id).attempts, 3);
  state.restart(); const retried = state.store.retryVideo(state.id, job.id); assert.equal(retried.status, 'queued'); assert.equal(retried.attempts, 0);
  assert.equal(state.store.video(job.id).shortId, created.shortId); assert.equal(state.store.video(job.id).failureReason, null);
  assert.equal(state.store.claim(1)[0].attempts, 1);
  state.advance(30 * 60_000); assert.throws(() => state.store.retryVideo(state.id, job.id), httpStatus(409));
  assert.throws(() => state.store.retryVideo(state.id, ready.id), httpStatus(409));
  const anomalous = create(state); state.store.db.prepare("UPDATE videos SET status='queued',lease_until=? WHERE id=?").run(Date.parse('2027-01-01T00:00:00Z'), anomalous.id);
  assert.throws(() => state.store.retryVideo(state.id, anomalous.id), httpStatus(409));
  assert.throws(() => state.store.retryVideo('other', created.id), httpStatus(404)); assert.throws(() => state.store.retryVideo(state.id, 'missing'), httpStatus(404));
});

test('platform import dry run shares v2 validation/dedupe/idempotency and changes no database rows', t => {
  const state = setup(t); const { store, id } = state;
  create(state, { email: 'existing@example.invalid' }); store.webhookPut({ trigger: 'VIDEO_CREATED', webhookUrl: 'https://hooks.example.invalid/path?token=private' });
  const request = { importId: 'platform-import', duplicateIdentifierField: 'email', renderTestVideo: true,
    videos: [{ capture_url: 'https://example.invalid/', email: 'existing@example.invalid' }, { capture_url: 'https://example.invalid/', email: 'new@example.invalid' },
      { capture_url: 'https://example.invalid/', email: 'new@example.invalid' }, { capture_url: 'javascript:bad' }, null] };
  const changes = (store.db.prepare('SELECT total_changes() n').get() as any).n;
  const preview = store.platformImport(id, { ...request, dryRun: true });
  assert.deepEqual({ inserted: preview.inserted, duplicates: preview.duplicates, invalidRows: preview.invalidRows, testVideoQueued: preview.testVideoQueued }, { inserted: 1, duplicates: 2, invalidRows: 2, testVideoQueued: true });
  assert.equal((store.db.prepare('SELECT total_changes() n').get() as any).n, changes);
  assert.equal(store.platformVideos(id).count, 1); assert.deepEqual(store.claim(1), []); assert.equal(store.dueOutbox().length, 0);
  assert.deepEqual(store.platformImport(id, request), preview); assert.equal(store.platformVideos(id).count, 2); assert.equal(store.dueOutbox().length, 1);
  state.restart(); assert.deepEqual(state.store.platformImport(id, { ...request, videos: [], dryRun: true }), preview);
  assert.deepEqual(state.store.importVideos(id, { ...request, videos: [] }), preview);
  const scalarRows = [1, '1', true, 'true', false, 'false', '', '', {}, {}].map((key, index) => ({ capture_url: 'https://example.invalid/', key, originalUid: String(index) }));
  const scalarRequest = { importId: 'scalars', duplicateIdentifierField: 'key', videos: scalarRows };
  const scalarPreview = state.store.platformImport(id, { ...scalarRequest, dryRun: true }); assert.equal(scalarPreview.inserted, 7); assert.equal(scalarPreview.duplicates, 3);
  assert.deepEqual(state.store.platformImport(id, scalarRequest), scalarPreview);
  for (const invalid of [{ videos: Array(2001).fill({}) }, { videos: [], dryRun: 'yes' }, { videos: [], dryRun: null }, { videos: [], queueAllVideosForRender: 'yes' }, { videos: [], importId: '' }, { videos: [], duplicateIdentifierField: 1 }]) assert.throws(() => state.store.platformImport(id, invalid), httpStatus(400));
  assert.throws(() => state.store.platformImport('missing', { videos: [] }), httpStatus(404));
});

test('platform webhook projection masks credentials and keeps durable safe delivery history', t => {
  const state = setup(t); const { store, id } = state;
  const hook = store.platformWebhookPut({ campaignId: id, trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/path?token=private#private-fragment' });
  const global = store.platformWebhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/global' });
  assert.equal(hook.target, 'https://hooks.example.invalid/path?***'); assert.equal(hook.campaignName, 'Campaign platform'); assert.equal(global.campaignName, null); assert.equal(global.campaignId, null);
  assert.deepEqual(hook.delivery, { pending: 0, delivered: 0, dead: 0, rejected: 0, lastErrorAt: null, lastErrorCode: null });
  assert.doesNotMatch(JSON.stringify(store.platformWebhooks()), /token|private|webhookUrl|target_url/);
  const video = rendered(state); const deliveries = store.dueOutbox(); assert.equal(deliveries.length, 2);
  const local = deliveries.find(row => row.webhook_id === hook.id)!; const globalDelivery = deliveries.find(row => row.webhook_id === global.id)!;
  assert.equal(store.platformWebhooks().find(row => row.id === hook.id)!.delivery.pending, 1);
  store.outboxFailure(local.id, 'https://credentials.invalid/?secret=not-safe'); store.outboxSuccess(globalDelivery.id);
  let delivery = store.platformWebhooks().find(row => row.id === hook.id)!.delivery;
  assert.equal(delivery.lastErrorAt, '2026-10-15T10:00:00.000Z'); assert.equal(delivery.lastErrorCode, 'delivery_failed');
  for (let index = 0; index < 5; index++) { state.advance(1000); store.outboxFailure(local.id); }
  delivery = store.platformWebhooks().find(row => row.id === hook.id)!.delivery; assert.equal(delivery.dead, 1); assert.equal(delivery.pending, 0);
  assert.equal(store.platformWebhooks().find(row => row.id === global.id)!.delivery.delivered, 1);
  state.advance(91 * 24 * 60 * 60_000); store.cleanup(); state.restart();
  const retained = state.store.platformWebhooks().find(row => row.id === hook.id)!; assert.deepEqual(retained.delivery, { ...delivery, dead: 0 });
  assert.equal(state.store.platformVideo(id, video.id).events.some(event => event.trigger === 'VIDEO_RENDERED'), true);
  assert.deepEqual(state.store.platformWebhookDelete(hook.id), { success: true }); assert.throws(() => state.store.platformWebhookDelete(hook.id), httpStatus(404));
  assert.throws(() => state.store.platformWebhookDelete(''), httpStatus(400));
  for (const invalid of [null, { trigger: 'INVALID', webhookUrl: 'invalid' }, { trigger: 'VIDEO_RENDERED', webhookUrl: 'https://user:pass@hooks.example.invalid/' }, { trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/', campaignId: 1 }]) assert.throws(() => state.store.platformWebhookPut(invalid), httpStatus(400));
  assert.throws(() => state.store.platformWebhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/', campaignId: 'missing' }), httpStatus(404));
});

test('platform webhook migration recovers last failure from existing outbox retry timestamps', t => {
  const state = setup(t); const hook = state.store.platformWebhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/legacy' }); rendered(state);
  state.store.outboxFailure(state.store.dueOutbox()[0].id);
  state.store.db.exec('ALTER TABLE webhooks DROP COLUMN last_error_at; ALTER TABLE webhooks DROP COLUMN last_error_code;');
  state.advance(1000); state.restart();
  assert.equal(state.store.platformWebhooks()[0].id, hook.id);
  assert.equal(state.store.platformWebhooks()[0].delivery.lastErrorAt, '2026-10-15T10:00:00.000Z');
  assert.equal(state.store.platformWebhooks()[0].delivery.lastErrorCode, 'delivery_failed');
  assert.deepEqual(state.store.db.pragma('foreign_key_check'), []);
});
