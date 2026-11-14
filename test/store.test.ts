import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Store, HttpError, TRIGGERS, maskUrl } from '../src/store.js';
import { Campaign, DEFAULT_DATA_DIR } from '../src/model.js';

// Pitchlane-compatible schema shape for template() below (was a captured research fixture).
const variableSchema = { website_0: { label: 'Page 1: Company Website', required: true, validator: { type: 'url', domain: null } }, website_4: { label: 'Page 5: Company Website', required: true, validator: { type: 'url', domain: null } } };
const fixture = { variableSchema, exampleVariableSchemaPayload: { website_0: 'https://example.com', website_4: 'https://example.com' },
  leadSchemaMapping: { website: 'capture_url', originalUid: 'originalUid' },
  exampleLeadSchemaMappingPayload: { capture_url: 'https://www.example.com', originalUid: 'exampleData' } };
function template(id = 'store-fixture-01'): Campaign {
  return { id, name: 'Test campaign', baseVideo: 'base.mp4', output: { width: 1920, height: 1080, fps: 30 }, bubble: { corner: 'bottom-right', diameterPct: 30, marginPct: 4 },
    pages: [{ start: 0, end: 17, type: 'website', variable: 'website_0', label: 'Page 1: Company Website' }, { start: 17, end: 29, type: 'image', src: 'page2.png' }, { start: 29, end: 43, type: 'image', src: 'page3.png' }, { start: 43, end: 87, type: 'url', url: 'https://example.invalid/' }, { start: 87, end: 110, type: 'website', variable: 'website_4', label: 'Page 5: Company Website' }],
    leadSchemaMapping: { website: 'capture_url', originalUid: 'originalUid' },
    landing: { title: 'Video für {{first_name}}', text: '', ctaLabel: 'Termin', ctaUrl: 'https://example.invalid/book', brandColor: '#111827', imprintUrl: 'https://example.invalid/imprint', privacyUrl: 'https://example.invalid/privacy' } };
}
const lead = { capture_url: 'https://example.invalid/', email: 'ada@example.invalid', 'E-Mail': 'Ada@example.invalid', first_name: 'Ada', last_name: 'Lovelace', company_name: 'Example', tag: 'tag-1', source_campaign: 'source-1', external_id: 'external-1', custom: 'untouched', originalUid: 'lead-1' };
function setup(t: any) {
  mkdirSync(join(DEFAULT_DATA_DIR, 'tests'), { recursive: true });
  const dataDir = mkdtempSync(join(DEFAULT_DATA_DIR, 'tests', 'store-')); let now = Date.parse('2026-10-15T10:00:00.000Z');
  let store = new Store({ dataDir, publicBaseUrl: 'http://localhost:4321', now: () => now });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  store.campaignPut(template(), 110);
  return { get store() { return store; }, advance(ms: number) { now += ms; }, restart() { store.close(); store = new Store({ dataDir, publicBaseUrl: 'http://localhost:4321', now: () => now }); }, id: template().id };
}
function imported(store: Store, id: string, row: Record<string, any> = lead) {
  store.importVideos(id, { videos: [row], importId: 'import-1', queueAllVideosForRender: true, duplicateIdentifierField: 'email' });
  const [job] = store.claim(1); return job;
}
function renderResult(job: any) { return { muxAssetId: 'asset-1', playbackId: 'playback-1', videoFileUrl: 'https://stream.mux.com/playback-1/highest.mp4', backgroundRecordedAt: '2026-10-15T09:59:00.000Z', durationSec: 110, leaseToken: job.leaseToken }; }
function complete(store: Store, job: any) { store.complete(job.id, renderResult(job)); }

test('campaign and schema API shapes match the Pitchlane-compatible fixture', t => {
  const { store, id } = setup(t);
  assert.deepEqual(store.schema(id), fixture);
  assert.deepEqual(store.schema(id, 'schema'), { variableSchema: fixture.variableSchema, examplePayload: fixture.exampleVariableSchemaPayload });
  assert.deepEqual(store.schema(id, 'lead-schema-mapping'), { leadSchemaMapping: fixture.leadSchemaMapping, examplePayload: fixture.exampleLeadSchemaMappingPayload });
  const campaign = store.campaigns()[0];
  assert.deepEqual(campaign.variableSchema, fixture.variableSchema); assert.deepEqual(campaign.examplePayload, fixture.exampleVariableSchemaPayload);
  assert.equal(campaign.id, id); assert.equal(typeof campaign.createdAt, 'string');
  const noMapping = template('without-mapping'); delete noMapping.leadSchemaMapping; store.campaignPut(noMapping, 110);
  assert.throws(() => store.schema(noMapping.id), (e: any) => e.status === 404);
  assert.throws(() => store.campaignPut({ ...template(), pages: [{ ...template().pages[0], start: 1 }] }, 110), (e: any) => e.status === 400);
});

test('imports preserve open lead fields, map URLs, are idempotent and deduplicate across imports', t => {
  const state = setup(t); const { store, id } = state;
  const request = { videos: [lead, { ...lead, originalUid: 'lead-2' }, { email: 'bad@example.invalid', capture_url: 'javascript:alert(1)' }], importId: 'import-a', queueAllVideosForRender: true, duplicateIdentifierField: 'email' };
  const response = store.importVideos(id, request);
  assert.deepEqual(response, { importId: 'import-a', inserted: 1, upserted: 0, duplicates: 1, invalidRows: 1, variableIssues: {
    website_0: { affectedRows: [{ index: 2, value: 'javascript:alert(1)', errors: ['Invalid URL for website_0'] }] }, website_4: { affectedRows: [{ index: 2, value: 'javascript:alert(1)', errors: ['Invalid URL for website_4'] }] } }, testVideoQueued: false });
  assert.deepEqual(store.importVideos(id, { ...request, videos: [{ ...lead, email: 'different@example.invalid' }] }), response);
  assert.equal(store.listVideos(id).count, 1);
  assert.equal(store.importVideos(id, { ...request, importId: 'import-b', videos: [lead] }).duplicates, 1);
  const video = store.claim(1)[0];
  assert.match(video.id, /^[A-Za-z0-9_-]{21}$/); assert.match(video.shortId, /^[A-Za-z0-9]{12}$/);
  assert.deepEqual(video.originalRow, lead); assert.equal(video.variables.website_0, lead.capture_url); assert.equal(video.variables.website_4, lead.capture_url);
  for (const key of Object.keys(lead)) assert.deepEqual(video.variables[key], lead[key as keyof typeof lead]);
  assert.equal(store.claim(1).length, 0);
  state.restart(); assert.deepEqual(state.store.importVideos(id, request), response);
});

test('single video validates variables and updates a duplicate without rerendering it', t => {
  const { store, id } = setup(t);
  assert.throws(() => store.upsertVideo(id, { variables: {} }), (e: any) => e.status === 400 && Array.isArray(e.body.errors));
  const created = store.upsertVideo(id, { variables: lead, duplicateIdentifierField: 'email' });
  assert.equal(store.video(created.id).importId, 'API import'); assert.equal(store.video(created.id).importSource, 'API');
  const job = store.claim(1)[0]; complete(store, job);
  assert.deepEqual(store.upsertVideo(id, { variables: { ...lead, first_name: 'Grace' }, duplicateIdentifierField: 'email' }), created);
  assert.equal(store.getVideo(created.shortId)?.variables.first_name, 'Grace'); assert.equal(store.claim(1).length, 0);
  assert.throws(() => store.importVideos(id, { videos: [], queueAllVideosForRender: 'yes' }), (e: any) => e.status === 400);
});

test('queue flags are explicit and queueAllVideosForRender has priority over renderTestVideo', t => {
  const { store, id } = setup(t);
  store.importVideos(id, { videos: [{ ...lead, originalUid: 'a' }], importId: 'no-queue' }); assert.equal(store.claim(1).length, 0);
  const first = store.importVideos(id, { videos: [{ ...lead, originalUid: 'b' }, { ...lead, originalUid: 'c' }], importId: 'test-only', renderTestVideo: true });
  assert.equal(first.testVideoQueued, true); assert.equal(store.claim(10).length, 1);
  const all = store.importVideos(id, { videos: [{ ...lead, originalUid: 'd' }, { ...lead, originalUid: 'e' }], importId: 'all', renderTestVideo: true, queueAllVideosForRender: true });
  assert.equal(all.testVideoQueued, false); assert.equal(store.claim(10).length, 2);
});

test('claim prefers higher campaign priority and keeps age order within equal priority', t => {
  const state = setup(t); const { id } = state;
  const prioritized = template('priority-campaign'); prioritized.priority = 1; state.store.campaignPut(prioritized, 110);
  state.store.importVideos(id, { videos: [{ ...lead, originalUid: 'old-plain' }], importId: 'old', queueAllVideosForRender: true });
  state.advance(1);
  state.store.importVideos(prioritized.id, { videos: [{ ...lead, originalUid: 'new-priority' }], importId: 'new', queueAllVideosForRender: true });
  state.advance(1);
  state.store.importVideos(prioritized.id, { videos: [{ ...lead, originalUid: 'newer-priority' }], importId: 'newer', queueAllVideosForRender: true });
  assert.deepEqual(state.store.claim(3).map(job => job.originalUid), ['new-priority', 'newer-priority', 'old-plain']);
});

test('leases expire after 30 minutes, reject stale workers and stop after three attempts', t => {
  const state = setup(t); const first = imported(state.store, state.id);
  assert.equal(first.attempts, 1); assert.equal(state.store.claim(1).length, 0);
  state.advance(30 * 60_000); const second = state.store.claim(1)[0]; assert.equal(second.id, first.id); assert.equal(second.attempts, 2); assert.notEqual(second.leaseToken, first.leaseToken);
  assert.throws(() => complete(state.store, first), (e: any) => e.status === 409);
  assert.equal(state.store.fail(second.id, 'unexpected', second.leaseToken).status, 'queued');
  state.restart(); const third = state.store.claim(1)[0]; assert.equal(third.attempts, 3);
  state.advance(30 * 60_000); assert.equal(state.store.claim(1).length, 0); assert.equal(state.store.video(third.id).status, 'failed');
});

test('render failures retry exactly three times without emitting VIDEO_UNRENDERABLE', t => {
  const state = setup(t); let job = imported(state.store, state.id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(job.attempts, attempt);
    assert.equal(state.store.fail(job.id, 'render_failed', job.leaseToken).status, attempt < 3 ? 'queued' : 'failed');
    assert.equal(state.store.video(job.id).failureReason, 'render_failed');
    assert.equal((state.store.db.prepare("SELECT count(*) AS n FROM events WHERE video_id=? AND trigger='VIDEO_UNRENDERABLE'").get(job.id) as any).n, 0);
    state.restart();
    const jobs = state.store.claim(1);
    if (attempt < 3) { assert.equal(jobs.length, 1); assert.equal(jobs[0].id, job.id); job = jobs[0]; }
    else assert.deepEqual(jobs, []);
  }
  assert.equal(state.store.video(job.id).status, 'failed');
  assert.equal(state.store.video(job.id).attempts, 3);
});

test('an unreachable website retains its failure reason and emits VIDEO_UNRENDERABLE once across retries', t => {
  const state = setup(t); let job = imported(state.store, state.id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    state.store.fail(job.id, 'website_unreachable', job.leaseToken);
    assert.equal(state.store.video(job.id).failureReason, 'website_unreachable');
    assert.equal((state.store.db.prepare("SELECT count(*) AS n FROM events WHERE video_id=? AND trigger='VIDEO_UNRENDERABLE'").get(job.id) as any).n, 1);
    if (attempt < 3) { state.restart(); job = state.store.claim(1)[0]; }
  }
  assert.equal(state.store.video(job.id).status, 'failed');
  assert.deepEqual(state.store.claim(1), []);
});

test('completion is durable and idempotent for an acknowledged lease', t => {
  const state = setup(t); const job = imported(state.store, state.id); complete(state.store, job); state.restart(); complete(state.store, job);
  const events: any = state.store.db.prepare("SELECT count(*) AS n FROM events WHERE trigger='VIDEO_RENDERED'").get(); assert.equal(events.n, 1);
  assert.equal(state.store.getVideo(job.shortId)?.playbackId, 'playback-1');
  assert.throws(() => state.store.complete(job.id, { ...renderResult(job), muxAssetId: 'other' }), (e: any) => e.status === 409);
  assert.throws(() => state.store.complete(job.id, { ...renderResult(job), backgroundRecordedAt: '2026-10-15T09:58:00.000Z' }), (e: any) => e.status === 409);
});

test('all ten triggers preserve native event envelopes and untouched custom routing data', t => {
  const { store, id } = setup(t); const job = imported(store, id); complete(store, job);
  store.track(job.shortId, 'VIEWED', 'session-1'); store.track(job.shortId, 'STARTED', 'session-1'); store.track(job.shortId, 'FINISHED', 'session-1');
  store.importVideos(id, { videos: [{ ...lead, originalUid: 'failing', email: 'bad@example.invalid' }], queueAllVideosForRender: true });
  const failure = store.claim(1)[0]; store.fail(failure.id, 'website_unreachable', failure.leaseToken);
  const events = store.db.prepare('SELECT trigger,payload FROM events').all() as any[];
  assert.deepEqual([...new Set(events.map(e => e.trigger))].sort(), [...TRIGGERS].sort());
  for (const row of events) {
    const payload = JSON.parse(row.payload); const video = payload.rawVideo ?? payload.video;
    assert.equal(payload.event, row.trigger); assert.match(payload.eventAt, /^2026-10-15T/);
    assert.match(video._id, /^[A-Za-z0-9_-]{21}$/); assert.equal(video.shortId.length, 12); assert.equal(video.campaignId, id);
    assert.equal('variables' in video, false);
    assert.deepEqual(video._backupVariables, { website_0: lead.capture_url, website_4: lead.capture_url });
    assert.equal(video.originalRow.tag, 'tag-1'); assert.equal(video.originalRow.source_campaign, 'source-1'); assert.equal(video.originalRow.external_id, 'external-1');
    assert.deepEqual(video.overrideRow, { capture_url: lead.capture_url });
    if (payload.rawVideo) {
      assert.deepEqual(Object.keys(payload).sort(), ['event', 'eventAt', 'rawVideo', 'video']);
      assert.equal(payload.video.id, video._id); assert.equal('_id' in payload.video, false); assert.equal('triggeredWebhooks' in video, false);
      for (const key of ['thumbnailUrl', 'thumbnailStorageUrl', 'thumbnailUrlPNG', 'thumbnailStorageUrlPNG', 'thumbnailEmbed', 'thumbnailStorageEmbed', 'thumbnailEmbedPNG', 'thumbnailStorageEmbedPNG', 'videoFileUrl', 'videoUrl']) {
        assert.equal(typeof payload.video[key], row.trigger === 'VIDEO_CREATED' ? 'object' : 'string');
        if (row.trigger === 'VIDEO_CREATED') assert.equal(payload.video[key], null);
      }
    } else {
      assert.equal('id' in video, false); assert.equal('thumbnailUrlPNG' in video, false);
      if (/VIEWED|STARTED|FINISHED/.test(row.trigger)) {
        assert.deepEqual(Object.keys(payload).sort(), ['event', 'eventAt', 'video', 'viewedAt', 'viewerUrl']);
        assert.equal(payload.viewedAt, payload.eventAt); assert.equal(payload.viewerUrl, `http://localhost:4321/video/${job.shortId}`);
      }
    }
    if (row.trigger === 'VIDEO_RENDERED') {
      assert.equal(payload.video.videoFileUrl, 'https://stream.mux.com/playback-1/highest.mp4');
      assert.equal(payload.video.thumbnailEmbed, `<div><a target="_blank" href="${payload.video.videoUrl}"><img style="margin:0px;box-sizing:border-box;padding:0px;width:100%;max-width:300px;height:auto" src="http://localhost:4321/thumbnail/${job.shortId}.gif" alt="Video für Ada"></a><br /></div>`);
      assert.equal(video.finalVideoDurationMS, 110000);
      assert.equal(video.backgroundRecordedAt, '2026-10-15T09:59:00.000Z');
      assert.equal(video.queuedForRenderingAt, job.queuedAt);
      assert.match(video.storagePaths.thumbnail_png, /\.png$/);
      assert.equal(video.storagePaths.video_mp4, payload.video.videoFileUrl);
      assert.equal(video.renderingState.stage, 'notifying-dashboard');
    }
  }
});

// Only foreign render-engine internals may differ; every other path and type is native.
const ENGINE_PATHS = ['temporalRunId', 'temporalWorkflowId', 'recordingOutputs', 'renderingState.workflowId', 'renderingState.runId'];
function payloadTypes(payload: any) {
  const paths: Record<string, string> = {};
  function visit(value: any, path: string) {
    if (ENGINE_PATHS.some(engine => path === `video.${engine}` || path === `rawVideo.${engine}`)) return;
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    paths[path] = type;
    if (Array.isArray(value)) for (const item of value) visit(item, `${path}[]`);
    else if (type === 'object') for (const key of Object.keys(value).sort()) visit(value[key], path ? `${path}.${key}` : key);
  }
  visit(payload, ''); return paths;
}
// The native Pitchlane captures are not part of the kit; the fixture locks our emitted envelope shapes instead.
test('emitted event envelopes keep exact key, nesting and value types', t => {
  const { store, id } = setup(t);
  store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/render' });
  store.webhookPut({ trigger: 'VIDEO_FIRST_VIEWED', webhookUrl: 'https://hooks.example.invalid/first' });
  const leadRow = { capture_url: 'https://www.example.com/', originalUid: 'snapshot-lead' };
  const job = imported(store, id, leadRow);
  complete(store, job);
  store.track(job.shortId, 'VIEWED', 'snapshot-session'); store.track(job.shortId, 'STARTED', 'snapshot-session');
  const emitted = Object.fromEntries((store.db.prepare('SELECT trigger,payload FROM events WHERE video_id=?').all(job.id) as any[]).map(row => [row.trigger, JSON.parse(row.payload)]));
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/event-envelope-types.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(emitted).sort(), Object.keys(snapshot).sort());
  for (const [trigger, payload] of Object.entries(emitted) as [string, any][]) {
    assert.deepEqual(payloadTypes(payload), snapshot[trigger].types, trigger);
    assert.deepEqual(payload.video.triggeredWebhooks ?? null, snapshot[trigger].triggeredWebhooks, trigger);
  }
});

test('only explicit single-video variables are exposed and original row indices are never invented', t => {
  const { store, id } = setup(t);
  const rows = [lead, { ...lead, originalUid: 'row-number', originalRowIndex: 42 }, { ...lead, originalUid: 'row-uuid', originalRowIndex: '3d74b9ee-21b3-4af2-a1f4-668fed611010' }, { ...lead, originalUid: 'row-null', originalRowIndex: null }];
  store.importVideos(id, { videos: rows, queueAllVideosForRender: true });
  for (const job of store.claim(4)) {
    const expected = rows.find(row => row.originalUid === job.originalUid)!;
    assert.deepEqual(job.originalRow, expected);
    assert.equal(job.originalRowIndex, 'originalRowIndex' in expected ? expected.originalRowIndex : null);
    const payload = store.payload(job, 'VIDEO_VIEWED');
    assert.equal('variables' in payload.video, false);
    assert.deepEqual(payload.video._backupVariables, { website_0: lead.capture_url, website_4: lead.capture_url });
  }
  const explicit = { ...lead, originalUid: 'explicit' };
  const { originalUid, ...expectedVariables } = explicit;
  const created = store.upsertVideo(id, { variables: explicit, queueForRender: false });
  const raw = store.payload(store.video(created.id), 'VIDEO_CREATED').rawVideo!;
  assert.deepEqual(raw.variables, expectedVariables); assert.deepEqual(raw._backupVariables, expectedVariables);
  assert.deepEqual(raw.originalRow, explicit); assert.equal('website_0' in raw.variables, false);
  const legacy = { ...store.video(created.id), explicitVariables: { ...explicit, originalData: 'legacy data', originalRow: 'legacy row', originalRowIndex: 5 } };
  const projected = store.payload(legacy, 'VIDEO_VIEWED').video;
  assert.deepEqual(projected.variables, expectedVariables); assert.deepEqual(projected._backupVariables, expectedVariables);
});

test('single-video row metadata parses only JSON objects and preserves other strings', t => {
  const { store, id } = setup(t);
  const variables = { website_0: 'https://x.example', website_4: 'https://x.example' };
  const row = { capture_url: 'https://x.example', originalUid: 'u1' };
  const cases = [
    { metadata: { originalData: JSON.stringify(row), originalRowIndex: 0 }, row, index: 0 },
    { metadata: { originalRow: '{invalid json', originalData: JSON.stringify(row), originalRowIndex: '3' }, row: '{invalid json', index: null },
    { metadata: { originalData: '{invalid data', originalRowIndex: 1.5 }, row: '{invalid data', index: null },
    { metadata: { originalRow: '[1,2]', originalRowIndex: false }, row: '[1,2]', index: null },
    { metadata: { originalRow: 'null' }, row: 'null', index: null },
    { metadata: { originalRow: '"text"', originalRowIndex: null }, row: '"text"', index: null },
    { metadata: { originalRow: '', originalData: JSON.stringify(row), originalRowIndex: -1 }, row: '', index: -1 },
    { metadata: { originalRow: null, originalData: JSON.stringify(row) }, row, index: null },
  ];
  for (const [index, sample] of cases.entries()) {
    const created = store.upsertVideo(id, { variables: { ...variables, ...sample.metadata, originalUid: `row-${index}` }, queueForRender: false });
    const video = store.video(created.id);
    assert.deepEqual(video.variables, variables); assert.deepEqual(video.explicitVariables, variables);
    assert.deepEqual(video.originalRow, sample.row); assert.equal(video.originalRowIndex, sample.index);
    const listed = store.listVideos(id).videos.find((video: any) => video._id === created.id)!;
    assert.deepEqual(listed.originalRow, sample.row); assert.deepEqual(listed.overrideRow, {});
  }
});

test('single-video originalUid dedupe retains mapped identifiers and interoperates with bulk imports', t => {
  const { store, id } = setup(t);
  store.campaignPut({ ...template(), leadSchemaMapping: { website: 'capture_url', originalUid: 'external_id' } }, 110);
  const variables = { capture_url: 'https://x.example', external_id: 'mapped-uid' };
  const created = store.upsertVideo(id, { variables, queueForRender: false });
  assert.equal(store.video(created.id).originalUid, 'mapped-uid');
  assert.equal('originalUid' in store.video(created.id).variables, false);
  assert.deepEqual(store.upsertVideo(id, { variables, queueForRender: false }), created);
  assert.equal(store.importVideos(id, { videos: [variables] }).duplicates, 1);
  assert.equal(store.importVideos(id, { videos: [{ ...variables, external_id: 'bulk-uid' }] }).inserted, 1);
  const upserted = store.upsertVideo(id, { variables: { ...variables, external_id: 'bulk-uid' }, queueForRender: false });
  assert.equal(store.listVideos(id).count, 2); assert.equal(store.video(upserted.id).originalUid, 'bulk-uid');
});

test('completion rejects an HLS URL, another asset and invalid capture timestamps before emitting', t => {
  const { store, id } = setup(t); const job = imported(store, id); const result = renderResult(job);
  for (const invalid of [
    { videoFileUrl: undefined }, { videoFileUrl: 'https://stream.mux.com/playback-1.m3u8' },
    { videoFileUrl: 'https://stream.mux.com/other/highest.mp4' }, { videoFileUrl: 'https://stream.mux.com/playback-1/../highest.mp4' },
    { videoFileUrl: 'https://stream.mux.com/playback-1/highest.mp4?token=secret' },
    { backgroundRecordedAt: undefined }, { backgroundRecordedAt: '2026-02-30T09:59:00.000Z' }, { backgroundRecordedAt: 'not-a-date' },
  ]) assert.throws(() => store.complete(job.id, { ...result, ...invalid }), (error: any) => error.status === 400);
  assert.equal(store.video(job.id).status, 'rendering');
  assert.equal((store.db.prepare("SELECT count(*) n FROM events WHERE trigger='VIDEO_RENDERED'").get() as any).n, 0);
  complete(store, job);
});

test('tracking snapshots list prior one-shot trigger names and never hook IDs or recurring events', t => {
  const { store, id } = setup(t);
  const render = store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/render' });
  const view = store.webhookPut({ trigger: 'VIDEO_VIEWED', webhookUrl: 'https://hooks.example.invalid/view' });
  const first = store.webhookPut({ trigger: 'VIDEO_FIRST_VIEWED', webhookUrl: 'https://hooks.example.invalid/first' });
  const started = store.webhookPut({ trigger: 'VIDEO_STARTED', webhookUrl: 'https://hooks.example.invalid/started' });
  const job = imported(store, id); complete(store, job);
  store.track(job.shortId, 'VIEWED', 'session-1');
  const viewed = JSON.parse((store.db.prepare("SELECT payload FROM events WHERE trigger='VIDEO_VIEWED'").get() as any).payload);
  assert.deepEqual(viewed.video.triggeredWebhooks, ['VIDEO_RENDERED']);
  const firstViewed = JSON.parse((store.db.prepare("SELECT payload FROM events WHERE trigger='VIDEO_FIRST_VIEWED'").get() as any).payload);
  assert.deepEqual(firstViewed.video.triggeredWebhooks, ['VIDEO_RENDERED']);
  assert.deepEqual(store.video(job.id).triggeredWebhooks, ['VIDEO_RENDERED', 'VIDEO_FIRST_VIEWED']);
  store.track(job.shortId, 'STARTED', 'session-1');
  const start = JSON.parse((store.db.prepare("SELECT payload FROM events WHERE trigger='VIDEO_STARTED'").get() as any).payload);
  assert.deepEqual(start.video.triggeredWebhooks, ['VIDEO_RENDERED', 'VIDEO_FIRST_VIEWED']);
  assert.equal(firstViewed.video.triggeredWebhooks.includes(started.id), false);
  assert.deepEqual(firstViewed.video.renderingState, { executionStatus: 'COMPLETED', stage: 'completed', lastError: null, updatedAt: '2026-10-15T10:00:00.000Z' });
  const legacy = store.video(job.id); legacy.triggeredWebhooks = [render.id, view.id, first.id, started.id];
  store.db.prepare('UPDATE videos SET data=? WHERE id=?').run(JSON.stringify(legacy), job.id);
  assert.deepEqual(store.payload(legacy, 'VIDEO_VIEWED').video.triggeredWebhooks, ['VIDEO_RENDERED', 'VIDEO_FIRST_VIEWED']);
  store.track(job.shortId, 'VIEWED', 'session-2');
  assert.deepEqual(store.video(job.id).triggeredWebhooks, ['VIDEO_RENDERED', 'VIDEO_FIRST_VIEWED']);
});

test('tracking deduplicates viewed and started for 30 minutes and first triggers once per video', t => {
  const state = setup(t); const job = imported(state.store, state.id); complete(state.store, job);
  assert.equal(state.store.track(job.shortId, 'VIEWED', 's1').accepted, true); assert.equal(state.store.track(job.shortId, 'VIEWED', 's1').accepted, false);
  assert.equal(state.store.track(job.shortId, 'STARTED', 's1').accepted, true); assert.equal(state.store.track(job.shortId, 'STARTED', 's1').accepted, false);
  state.advance(30 * 60_000); state.restart(); assert.equal(state.store.track(job.shortId, 'VIEWED', 's1').accepted, true);
  assert.equal(state.store.track(job.shortId, 'VIEWED', 's2').accepted, true);
  assert.equal((state.store.db.prepare("SELECT count(*) AS n FROM events WHERE trigger='VIDEO_FIRST_VIEWED'").get() as any).n, 1);
  assert.equal((state.store.db.prepare("SELECT count(*) AS n FROM events WHERE trigger='VIDEO_VIEWED'").get() as any).n, 3);
  assert.equal(state.store.track('unknown', 'VIEWED', 's1').accepted, false);
});

test('webhook subscription shapes, scoped target selection, durable delivery lease and retry schedule', t => {
  const state = setup(t); const { store, id } = state; store.campaignPut(template('another'), 110);
  const global = store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/render?token=private' });
  assert.equal('webhookUrl' in global, false);
  const local = store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/local?secret=private' }, id);
  store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/other' }, 'another');
  assert.equal(store.webhooks().length, 3); assert.equal(store.webhooks()[0].userId, 'ac-video');
  assert.equal(store.webhooks(id)[0].campaign?._id, id);
  assert.equal(store.webhookPut({ id: local.id, trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/updated' }, id).id, local.id);
  assert.throws(() => store.webhookPut({ trigger: 'INVALID', webhookUrl: 'not-url' }), (e: any) => e.status === 400 && e.body.errors[0].path === 'webhookUrl');
  const job = imported(store, id); complete(store, job);
  const due = store.dueOutbox(); assert.equal(due.length, 2); assert.equal(store.dueOutbox().length, 0);
  state.advance(90_000); state.restart(); assert.equal(state.store.dueOutbox().length, 2);
  state.store.outboxSuccess(due[0].id); const retries = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
  for (const [index, delay] of retries.entries()) {
    state.store.outboxFailure(due[1].id, 'https://hooks.example.invalid/?token=private');
    const row: any = state.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(due[1].id);
    assert.equal(row.attempts, index + 1); assert.equal(row.last_error, 'delivery_failed'); assert.equal(row.state, 'pending');
    assert.equal(state.store.dueOutbox().length, 0); state.advance(delay); assert.equal(state.store.dueOutbox().length, 1);
  }
  state.store.outboxFailure(due[1].id); assert.equal((state.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(due[1].id) as any).state, 'dead');
  assert.equal(maskUrl('https://hooks.example.invalid/path?token=private#secret'), 'https://hooks.example.invalid/path?REDACTED');
  state.store.webhookDelete('https://hooks.example.invalid/render?token=private', 'VIDEO_RENDERED'); assert.equal(state.store.webhooks().length, 2);
  assert.throws(() => state.store.webhookDelete('https://hooks.example.invalid/missing', 'VIDEO_RENDERED'), (e: any) => e instanceof HttpError && e.status === 404);
});


test('non-string import titles use campaign text while the original value is preserved', t => {
  const { store, id } = setup(t);
  assert.equal(store.importVideos(id, { videos: [{ ...lead, title: 123 }], queueAllVideosForRender: true }).inserted, 1);
  const video = store.video(store.claim(1)[0].id); assert.equal(video.title, 'Video für Ada'); assert.ok(typeof video.originalRow === 'object'); assert.equal(video.originalRow.title, 123);
});

test('legacy outbox migration shares the durable event payload and recovers an empty event copy', t => {
  const state = setup(t); const { store, id } = state;
  store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/one' });
  store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/two' });
  const job = imported(store, id); complete(store, job);
  const before: any = store.db.prepare("SELECT payload FROM events WHERE trigger='VIDEO_RENDERED'").get();
  store.db.exec("ALTER TABLE outbox ADD COLUMN payload TEXT NOT NULL DEFAULT ''; UPDATE outbox SET payload=(SELECT payload FROM events WHERE id=event_id); UPDATE events SET payload='' WHERE trigger='VIDEO_RENDERED'");
  // Recreate the Phase-1 NOT NULL constraint as well as its copied outbox column.
  store.db.pragma('foreign_keys = OFF');
  store.db.exec(`CREATE TABLE events_legacy (id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), trigger TEXT NOT NULL, event_at INTEGER NOT NULL, session TEXT, payload TEXT NOT NULL);
    INSERT INTO events_legacy SELECT * FROM events; DROP TABLE events; ALTER TABLE events_legacy RENAME TO events;`);
  store.db.pragma('foreign_keys = ON');
  state.restart();
  assert.equal((state.store.db.pragma('table_info(outbox)') as any[]).some(column => column.name === 'payload'), false);
  const rows = state.store.dueOutbox(); assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(row.payload, JSON.parse(before.payload));
  assert.deepEqual(state.store.db.pragma('foreign_key_check'), []);
  const restored: any = state.store.db.prepare("SELECT payload FROM events WHERE trigger='VIDEO_RENDERED'").get();
  assert.equal(restored.payload, before.payload);
  state.advance(90_000); state.restart(); assert.equal(state.store.dueOutbox().length, 2);
});

test('migration rolls back if a pending delivery has no recoverable event payload', t => {
  const state = setup(t); const { store, id } = state;
  store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: 'https://hooks.example.invalid/pending' });
  const job = imported(store, id); complete(store, job);
  const before: any = store.db.prepare("SELECT payload FROM events WHERE trigger='VIDEO_RENDERED'").get();
  store.db.exec("ALTER TABLE outbox ADD COLUMN payload TEXT NOT NULL DEFAULT ''; UPDATE events SET payload='' WHERE trigger='VIDEO_RENDERED'");
  assert.throws(() => new Store({ dataDir: dirname(store.db.name), publicBaseUrl: 'http://localhost:4321' }), /Pending webhook payload is missing; migration cancelled/);
  assert.equal((store.db.pragma('table_info(outbox)') as any[]).some(column => column.name === 'payload'), true);
  assert.equal((store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('events_migrating','outbox_migrating')").get() as any).n, 0);
  store.db.prepare("UPDATE events SET payload=? WHERE trigger='VIDEO_RENDERED'").run(before.payload);
  state.restart(); assert.equal(state.store.dueOutbox().length, 1);
});

test('90-day cleanup removes terminal outbox copies and old payloads, retaining pending delivery and FIRST history', t => {
  const state = setup(t); const { store, id } = state;
  for (const name of ['delivered', 'dead', 'pending']) store.webhookPut({ trigger: 'VIDEO_VIEWED', webhookUrl: `https://hooks.example.invalid/${name}` });
  const job = imported(store, id); complete(store, job); store.track(job.shortId, 'VIEWED', 'old-session');
  const rows = store.dueOutbox(); assert.equal(rows.length, 3);
  store.outboxSuccess(rows[0].id);
  for (let i = 0; i < 6; i++) store.outboxFailure(rows[1].id);
  store.outboxFailure(rows[2].id);
  state.advance(90 * 24 * 60 * 60_000);
  assert.deepEqual(store.cleanup(), { outbox: 0, payloads: 0 });
  state.advance(1);
  const cleaned = store.cleanup(); assert.equal(cleaned.outbox, 2); assert.ok(cleaned.payloads >= 1);
  const pending: any = store.db.prepare('SELECT event_id FROM outbox WHERE id=?').get(rows[2].id);
  assert.ok(pending);
  assert.equal(typeof (store.db.prepare('SELECT payload FROM events WHERE id=?').get(pending.event_id) as any).payload, 'string');
  assert.equal((store.db.prepare("SELECT payload FROM events WHERE trigger='VIDEO_FIRST_VIEWED'").get() as any).payload, null);
  state.restart();
  assert.equal(state.store.dueOutbox()[0].id, rows[2].id);
  state.store.outboxSuccess(rows[2].id); assert.equal(state.store.cleanup().outbox, 1);
  assert.equal((state.store.db.prepare('SELECT payload FROM events WHERE id=?').get(pending.event_id) as any).payload, null);
  assert.equal(state.store.track(job.shortId, 'VIEWED', 'new-session').accepted, true);
  assert.equal((state.store.db.prepare("SELECT count(*) n FROM events WHERE trigger='VIDEO_FIRST_VIEWED'").get() as any).n, 1);
  assert.equal((state.store.db.prepare('SELECT count(*) n FROM events WHERE payload IS NULL').get() as any).n, 5);
});
