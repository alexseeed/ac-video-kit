import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { campaignFixture, testDir } from './helpers.js';

test('public video list restores rendered media including PNG without changing pending rows or event documents', async t => {
  const options = { dataDir: testDir('media-list'), publicBaseUrl: 'http://localhost', apiKeys: ['fixture-api-key-01'], workerToken: 'fixture-worker-token', internalViewToken: 'fixture-internal', previewSecret: 'fixture-preview-secret', dispatch: false };
  const app = createApp(options);
  app.store.campaignPut(campaignFixture(), 12);
  await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const lead = { capture_url: 'http://localhost', email: 'ready@example.invalid', first_name: '<Ada & Grace>' };
  const ready = app.store.upsertVideo(campaignFixture().id, { variables: lead });
  const job = app.store.claim(1)[0];
  app.store.complete(job.id, { muxAssetId: 'fixture-asset', playbackId: 'fixture-playback', videoFileUrl: 'https://stream.mux.com/fixture-playback/highest.mp4', backgroundRecordedAt: '2026-10-15T00:00:00.000Z', durationSec: 12, leaseToken: job.leaseToken });
  const pending = app.store.upsertVideo(campaignFixture().id, { variables: { ...lead, email: 'pending@example.invalid' }, queueForRender: false });
  const endpoint = `${base}/api/public/v1/campaigns/${campaignFixture().id}/videos`;
  assert.equal((await fetch(endpoint)).status, 401);
  const response = await fetch(endpoint, { headers: { 'X-Api-Key': 'fixture-api-key-01' } }); // gitleaks:allow (Test-Fixture)
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const list = await response.json();
  assert.equal(list.count, 2);
  assert.equal(list.renderedCount, 1);
  const video = list.videos.find((row: any) => row._id === ready.id);
  const media = {
    videoUrl: `http://localhost/video/${ready.shortId}`,
    videoFileUrl: 'https://stream.mux.com/fixture-playback/highest.mp4',
    thumbnailUrl: `http://localhost/thumbnail/${ready.shortId}.gif`,
    thumbnailStorageUrl: 'https://image.mux.com/fixture-playback/animated.gif?start=0&end=5&width=448&fps=2',
    thumbnailUrlPNG: `http://localhost/thumbnail/${ready.shortId}.png`,
    thumbnailStorageUrlPNG: 'https://image.mux.com/fixture-playback/thumbnail.png?time=0&width=600',
  };
  for (const [key, value] of Object.entries(media)) assert.equal(video[key], value, key);
  for (const [embed, url] of [['thumbnailEmbed', media.thumbnailUrl], ['thumbnailStorageEmbed', media.thumbnailStorageUrl], ['thumbnailEmbedPNG', media.thumbnailUrlPNG], ['thumbnailStorageEmbedPNG', media.thumbnailStorageUrlPNG]]) {
    assert.ok(video[embed].includes(`href="${media.videoUrl}"`));
    assert.ok(video[embed].includes(`src="${url.replaceAll('&', '&amp;')}"`));
    assert.ok(video[embed].includes('alt="Video für &lt;Ada &amp; Grace&gt;"'));
  }
  const pendingRow = list.videos.find((row: any) => row._id === pending.id);
  for (const key of [...Object.keys(media), 'thumbnailEmbed', 'thumbnailStorageEmbed', 'thumbnailEmbedPNG', 'thumbnailStorageEmbedPNG']) assert.equal(key in pendingRow, false, key);
  assert.deepEqual(video.originalRow, lead);
  const event = app.store.payload(app.store.video(ready.id), 'VIDEO_RENDERED');
  assert.equal('thumbnailUrlPNG' in event.video, true);
  assert.equal(event.video.videoUrl, video.videoUrl);
  const png = await new Promise<http.IncomingMessage>((done, reject) => {
    http.get(`${base}/thumbnail/${ready.shortId}.png?time=99&width=1`, { headers: { host: 'localhost' } }, response => { response.resume(); done(response); }).on('error', reject);
  });
  assert.equal(png.statusCode, 302);
  assert.equal(png.headers.location, media.thumbnailStorageUrlPNG);
});
