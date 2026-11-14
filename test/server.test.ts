import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, dispatchOutbox, maskUrl } from '../src/server.js';
import { MUX_PLAYER_URL, MUX_PLAYER_VERSION } from '../src/landing.js';
import { campaignFixture, testDir } from './helpers.js';

const apiKey = 'offline-fixture-api'; const workerToken = 'offline-fixture-worker';
async function setup(t: any) {
  let time = Date.now();
  const options = { dataDir: testDir('http'), publicBaseUrl: 'http://localhost', apiKeys: [apiKey], workerToken, internalViewToken: 'offline-internal', previewSecret: 'offline-preview-secret', now: () => time, dispatch: false };
  const app = createApp(options); app.store.campaignPut(campaignFixture(), 12);
  await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
  const address = app.server.address() as any;
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());
  const request = (path: string, init: RequestInit = {}) => new Promise<Response>((done, reject) => {
    const request = http.request(base + path, { method: init.method ?? 'GET', headers: { host: 'localhost', ...init.headers as any } }, async response => {
      const chunks: Buffer[] = []; for await (const chunk of response) chunks.push(chunk);
      done(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers as any }));
    }); request.on('error', reject); request.end(init.body ?? undefined);
  });
  const ready = () => {
    const video = app.store.upsertVideo(campaignFixture().id, { variables: { website_0: 'http://localhost', website_4: 'http://localhost', first_name: '<script>alert("x")</script>', company_name: '<img src=x onerror=alert(1)>', email: 'fixture@example.invalid' } });
    const job = app.store.claim(1)[0]; app.store.complete(job.id, { muxAssetId: 'asset-local', playbackId: 'playback-local', videoFileUrl: 'https://stream.mux.com/playback-local/highest.mp4', backgroundRecordedAt: '2026-10-15T00:00:00.000Z', durationSec: 12, leaseToken: job.leaseToken });
    return video;
  };
  return { ...app, request, ready, advance: (n: number) => time += n };
}
function beacon(html: string) { const match = html.match(/const shortId=(".*?"), token=(".*?");/)!; return { shortId: JSON.parse(match[1]), token: JSON.parse(match[2]) }; }

test('HTTP API auth, shapes, headers, invalid JSON and authenticated webhook disclosure', async t => {
  const app = await setup(t); const id = campaignFixture().id;
  const health = await app.request('/healthz'); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await app.request('/api/public/v1/campaigns')).status, 401);
  const auth = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' };
  const campaigns = await (await app.request('/api/public/v1/campaigns', { headers: auth })).json(); assert.equal(campaigns[0].id, id);
  const schema = await (await app.request(`/api/public/v1/campaigns/${id}/schemas`, { headers: auth })).json(); assert.equal(schema.variableSchema.website_0.validator.type, 'url');
  const input = { webhookUrl: 'http://localhost/hooks?token=private-fixture', trigger: 'VIDEO_VIEWED' };
  const created = await app.request('/api/public/v1/webhooks', { method: 'POST', headers: auth, body: JSON.stringify(input) });
  assert.equal(created.status, 200); assert.doesNotMatch(await created.text(), /private-fixture/);
  const list = await (await app.request('/api/public/v1/webhooks', { headers: auth })).json(); assert.equal(list[0].webhookUrl, input.webhookUrl);
  assert.equal((await app.request('/api/public/v1/webhooks', { method: 'POST', headers: auth, body: '{' })).status, 400);
  assert.equal((await app.request('/worker/claim', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await app.request('/worker/claim', { method: 'POST', headers: { authorization: workerToken }, body: '{}' })).status, 401);
  assert.equal((await app.request(`/admin/campaigns/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${workerToken}` }, body: '{}' })).status, 400);
  const imported = await (await app.request(`/api/public/v1/campaigns/${id}/videos/import/v2`, { method: 'POST', headers: auth, body: JSON.stringify({ importId: 'http-fixture', videos: [{ capture_url: 'http://localhost', email: 'offline@example.invalid', tag: 'fixture-binding' }], queueAllVideosForRender: true, duplicateIdentifierField: 'email' }) })).json();
  assert.deepEqual(imported, { importId: 'http-fixture', inserted: 1, upserted: 0, duplicates: 0, invalidRows: 0, variableIssues: null, testVideoQueued: false });
  const listed = await (await app.request(`/api/public/v1/campaigns/${id}/videos?limit=100&offset=0`, { headers: auth })).json(); assert.equal(listed.count, 1); assert.equal(listed.videos[0].originalRow.tag, 'fixture-binding');
  assert.equal((await app.request(`/admin/campaigns/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${workerToken}` }, body: JSON.stringify({ campaign: {}, durationSec: 12 }) })).status, 400);
  const response = await app.request('/api/public/v1/webhooks?webhookUrl=' + encodeURIComponent(input.webhookUrl) + '&trigger=VIDEO_VIEWED', { method: 'DELETE', headers: auth }); assert.equal(response.status, 204);
});

test('single video POST separates row metadata from variables and deduplicates by originalUid', async t => {
  const app = await setup(t); const id = campaignFixture().id;
  const path = `/api/public/v1/campaigns/${id}/videos`;
  const headers = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' };
  const schemaVariables = { website_0: 'https://x.example', website_4: 'https://x.example' };
  const originalRow = { capture_url: 'https://x.example', originalUid: 'u1' };
  const variables = { ...schemaVariables, originalUid: 'u1', originalRow: JSON.stringify(originalRow), originalRowIndex: 3 };
  const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ variables }) });
  assert.equal(response.status, 200); const created = await response.json();
  const stored = app.store.video(created.id);
  assert.deepEqual(stored.variables, schemaVariables); assert.deepEqual(stored.explicitVariables, schemaVariables);
  assert.deepEqual(stored.originalRow, originalRow); assert.equal(stored.originalRowIndex, 3); assert.equal(stored.originalUid, 'u1');
  const event = JSON.parse((app.store.db.prepare("SELECT payload FROM events WHERE video_id=? AND trigger='VIDEO_CREATED'").get(created.id) as any).payload);
  assert.deepEqual(event.video.originalRow, originalRow);
  assert.deepEqual(event.rawVideo.variables, schemaVariables); assert.deepEqual(event.rawVideo._backupVariables, schemaVariables);
  for (const trigger of ['VIDEO_RENDERED', 'VIDEO_VIEWED'] as const) {
    const payload = app.store.payload(stored, trigger);
    const raw = payload.rawVideo ?? payload.video;
    assert.deepEqual(raw.variables, schemaVariables); assert.deepEqual(raw._backupVariables, schemaVariables);
    assert.deepEqual(raw.originalRow, originalRow); assert.equal(raw.originalRowIndex, 3);
  }
  const listResponse = await app.request(path, { headers }); assert.equal(listResponse.status, 200);
  const list = await listResponse.json(); assert.equal(list.count, 1);
  assert.deepEqual(list.videos[0].variables, schemaVariables); assert.deepEqual(list.videos[0]._backupVariables, schemaVariables);
  assert.deepEqual(list.videos[0].originalRow, originalRow); assert.equal(list.videos[0].originalRowIndex, 3);
  const duplicate = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ variables: { ...variables, originalRow: '{invalid json', originalRowIndex: '3' } }) });
  assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), created);
  const updated = app.store.video(created.id);
  assert.equal(updated.originalRow, '{invalid json'); assert.equal(updated.originalRowIndex, null);
  assert.deepEqual(updated.variables, schemaVariables); assert.deepEqual(updated.explicitVariables, schemaVariables);
  assert.equal(app.store.listVideos(id).count, 1);
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM events WHERE video_id=?').get(created.id) as any).n, 1);
});

test('Landing HTML escapes variables, enforces host, redirects fixed thumbnails; GET never tracks', async t => {
  const app = await setup(t); const video = app.ready();
  const before = (app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n;
  const page = await app.request(`/video/${video.shortId}`); const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /name="robots" content="noindex/); assert.match(html, /aria-label=/);
  const playerScripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.match(MUX_PLAYER_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(playerScripts, [MUX_PLAYER_URL]);
  assert.equal(MUX_PLAYER_URL, `https://cdn.jsdelivr.net/npm/@mux/mux-player@${MUX_PLAYER_VERSION}/dist/mux-player.js`);
  assert.ok(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n, before);
  assert.equal((await app.request(`/video/${video.shortId}`, { headers: { host: 'wrong.invalid' } })).status, 404);
  assert.equal((await app.request('/video/UnknownVideo')).status, 404);
  const gif = await app.request(`/thumbnail/${video.shortId}.gif?width=1&fps=30`);
  assert.equal(gif.status, 302); assert.equal(gif.headers.get('location'), 'https://image.mux.com/playback-local/animated.gif?start=0&end=5&width=448&fps=2');
  assert.equal(gif.headers.get('cache-control'), 'public, max-age=3600');
  const gifHead = await app.request(`/thumbnail/${video.shortId}.gif`, { method: 'HEAD' });
  assert.equal(gifHead.status, 302); assert.equal(gifHead.headers.get('location'), gif.headers.get('location'));
  const pngHead = await app.request(`/thumbnail/${video.shortId}.png`, { method: 'HEAD' });
  assert.equal(pngHead.status, 302); assert.equal(pngHead.headers.get('location'), 'https://image.mux.com/playback-local/thumbnail.png?time=0&width=600');
  const jpgHead = await app.request(`/thumbnail/${video.shortId}.jpg`, { method: 'HEAD' });
  assert.equal(jpgHead.status, 302); assert.equal(jpgHead.headers.get('location'), 'https://image.mux.com/playback-local/thumbnail.jpg?time=0&width=600');
  const eventsBeforeHead = (app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n;
  const head = await app.request(`/video/${video.shortId}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(head.headers.get('set-cookie'), null);
  assert.equal(await head.text(), '');
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n, eventsBeforeHead);
  const unknownHead = await app.request('/video/UnknownVideo', { method: 'HEAD' });
  assert.equal(unknownHead.status, 404); assert.equal(await unknownHead.text(), '');
  const wrongHostHead = await app.request(`/video/${video.shortId}`, { method: 'HEAD', headers: { host: 'wrong.invalid' } });
  assert.equal(wrongHostHead.status, 404); assert.equal(await wrongHostHead.text(), '');
  const internalHead = await app.request(`/video/${video.shortId}?internal=offline-internal`, { method: 'HEAD' });
  assert.equal(internalHead.status, 200); assert.equal(internalHead.headers.get('set-cookie'), null);
});

test('worker GIF upload validates lease and content; stored GIF is served for GET and HEAD', async t => {
  const app = await setup(t); const id = campaignFixture().id;
  const video = app.store.upsertVideo(id, { variables: { website_0: 'http://localhost', website_4: 'http://localhost' } });
  const job = app.store.claim(1)[0];
  const gif = Buffer.from('R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
  const route = `/worker/${job.id}/gif`;
  const auth = { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' };
  const send = (payload: any, headers: any = auth) => app.request(route, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal((await app.request(route, { method: 'POST', body: JSON.stringify({ gif: gif.toString('base64'), leaseToken: job.leaseToken }) })).status, 401);
  assert.equal((await send({ gif: gif.toString('base64'), leaseToken: 'wrong-lease' })).status, 409);
  assert.equal((await send({ leaseToken: job.leaseToken })).status, 400);
  assert.equal((await send({ gif: Buffer.from('not-a-gif').toString('base64'), leaseToken: job.leaseToken })).status, 400);
  const oversized = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(1_000_000)]);
  assert.equal((await send({ gif: oversized.toString('base64'), leaseToken: job.leaseToken })).status, 400);
  assert.equal((await send({ gif: gif.toString('base64'), leaseToken: job.leaseToken })).status, 200);
  app.store.complete(job.id, { muxAssetId: 'asset-local', playbackId: 'playback-local', videoFileUrl: 'https://stream.mux.com/playback-local/highest.mp4', backgroundRecordedAt: '2026-10-15T00:00:00.000Z', durationSec: 12, leaseToken: job.leaseToken });
  const get = await app.request(`/thumbnail/${video.shortId}.gif`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/gif');
  assert.equal(get.headers.get('content-length'), String(gif.length));
  assert.equal(get.headers.get('cache-control'), 'public, max-age=2592000');
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), gif);
  const head = await app.request(`/thumbnail/${video.shortId}.gif`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/gif');
  assert.equal(head.headers.get('content-length'), String(gif.length));
  assert.equal(await head.text(), '');
});

test('Landing applies campaign colors and escapes creator, with title below player and adjacent calendar', async t => {
  const app = await setup(t), campaign = campaignFixture();
  campaign.landing = { ...campaign.landing, backgroundColor: '#111827', textColor: '#FFFFFF', ctaColor: '#007aff', ctaTextColor: '#FFFFFF', creatorNameColor: '#9CA3AF', creatorName: '{{first_name}}', calendlyEmbedUrl: 'https://calendly.com/example/meeting' };
  app.store.campaignPut(campaign, 12);
  const video = app.ready(), response = await app.request(`/video/${video.shortId}`), html = await response.text();
  assert.match(html, /background:#111827;color:#FFFFFF/);
  assert.match(html, /background:#007aff;color:#FFFFFF/);
  assert.match(html, /Created by &lt;script&gt;/);
  assert.ok(html.indexOf('<mux-player') < html.indexOf('<h1'));
  assert.match(html, /class="calendar" aria-label="Termin buchen"/);
  assert.match(html, /iframe title="Termin über Calendly buchen"/);
  assert.match(html, /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(html, /a:focus-visible/);
  assert.ok(response.headers.get('content-security-policy')?.includes('frame-src https://calendly.com'));
});

test('Landing head HTML runs only on the public page with matching nonce and Facebook CSP', async t => {
  const app = await setup(t); const id = campaignFixture().id;
  const video = app.ready();
  const expected = (nonce: string, facebook: boolean) => `default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net${facebook ? ' https://connect.facebook.net' : ''}; style-src 'unsafe-inline'; img-src https: data:; media-src https://stream.mux.com https://image.mux.com blob:; connect-src 'self' https://*.mux.com https://*.litix.io${facebook ? ' https://www.facebook.com https://connect.facebook.net' : ''}; frame-src https://calendly.com https://*.calendly.com; font-src https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const nonceOf = (csp: string) => csp.match(/script-src 'nonce-([^']+)'/)![1];
  const plain = await app.request(`/video/${video.shortId}`);
  assert.equal(plain.headers.get('content-security-policy'), expected(nonceOf(plain.headers.get('content-security-policy')!), false));
  const campaign = campaignFixture();
  campaign.landing.headHtml = '<script>window.__fbqInit=true</script><noscript><img src="https://www.facebook.com/tr"></noscript>';
  app.store.campaignPut(campaign, 12);
  const page = await app.request(`/video/${video.shortId}`);
  const html = await page.text(); const csp = page.headers.get('content-security-policy')!;
  const nonce = nonceOf(csp);
  assert.ok(html.includes(`</title><script nonce="${nonce}">window.__fbqInit=true</script>`));
  assert.ok(html.includes('<noscript><img src="https://www.facebook.com/tr"></noscript>'));
  assert.equal(csp, expected(nonce, true));
  const issued = await (await app.request(`/api/platform/v1/campaigns/${id}/videos/${video.id}/preview-ticket`, { method: 'POST', headers: { 'X-Api-Key': apiKey } })).json();
  const previewUrl = new URL(issued.url);
  const preview = await app.request(previewUrl.pathname + previewUrl.search);
  assert.doesNotMatch(await preview.text(), /__fbqInit|facebook\.com\/tr/);
  assert.equal(preview.headers.get('content-security-policy'), expected(nonceOf(preview.headers.get('content-security-policy')!), false));
  const redirect = await app.request(`/video/${video.shortId}?internal=offline-internal`);
  const internalCookie = redirect.headers.get('set-cookie')!.split(';')[0];
  const internal = await app.request(`/video/${video.shortId}`, { headers: { cookie: internalCookie } });
  assert.doesNotMatch(await internal.text(), /__fbqInit|facebook\.com\/tr/);
  assert.equal(internal.headers.get('content-security-policy'), expected(nonceOf(internal.headers.get('content-security-policy')!), false));
});

test('Only valid human beacons track, FIRST once; dedupe 30m and internal cookie', async t => {
  const app = await setup(t); const video = app.ready(); const path = `/video/${video.shortId}`;
  const page = await app.request(path); const cookie = page.headers.get('set-cookie')!.split(';')[0]; const data = beacon(await page.text());
  const send = (payload: any, extra: any = {}) => app.request('/e', { method: 'POST', headers: { cookie, 'user-agent': 'Mozilla/5.0 HumanBrowser', ...extra }, body: JSON.stringify(payload) });
  assert.equal((await (await send({ shortId: video.shortId, type: 'VIEWED' })).json()).accepted, false);
  assert.equal((await (await send({ ...data, type: 'VIEWED' }, { 'user-agent': 'Googlebot' })).json()).accepted, false);
  assert.equal((await (await send({ ...data, type: 'VIEWED' })).json()).accepted, true);
  assert.equal((await (await send({ ...data, type: 'VIEWED' })).json()).accepted, false);
  assert.equal((await (await send({ ...data, type: 'STARTED' })).json()).accepted, true);
  assert.equal((await (await send({ ...data, type: 'FINISHED', progress: .5 })).json()).accepted, false);
  assert.equal((await (await send({ ...data, type: 'FINISHED', progress: .95 })).json()).accepted, true);
  assert.equal((app.store.db.prepare("SELECT count(*) n FROM events WHERE trigger='VIDEO_FIRST_VIEWED'").get() as any).n, 1);
  app.advance(30 * 60_000 + 1);
  const reload = await app.request(path, { headers: { cookie } }); const fresh = beacon(await reload.text());
  assert.equal((await (await send({ ...fresh, type: 'VIEWED' })).json()).accepted, true);
  assert.equal((app.store.db.prepare("SELECT count(*) n FROM events WHERE trigger='VIDEO_FIRST_VIEWED'").get() as any).n, 1);
  const preview = await app.request(path + '?internal=offline-internal'); assert.equal(preview.status, 302);
  const internalCookie = preview.headers.get('set-cookie')!.split(';')[0];
  const internalPage = await app.request(path, { headers: { cookie: internalCookie } }); assert.doesNotMatch(await internalPage.text(), /sendBeacon/);
  assert.equal((await (await send({ ...fresh, type: 'VIEWED' }, { cookie: `${cookie}; ${internalCookie}` })).json()).accepted, false);
});

test('Expired videos answer 410 on the page, 404 for thumbnails, and reject retry/cancel', async t => {
  const app = await setup(t); const id = campaignFixture().id;
  const video = app.ready();
  const stored = app.store.video(video.id);
  delete stored.playbackId; delete stored.muxAssetId; delete stored.videoFileUrl;
  stored.status = 'expired'; stored.expiredAt = '2026-10-15T00:00:00.000Z';
  app.store.db.prepare("UPDATE videos SET status='expired',data=?,lease_until=NULL,lease_token=NULL WHERE id=?").run(JSON.stringify(stored), video.id);
  const before = (app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n;
  const page = await app.request(`/video/${video.shortId}`);
  assert.equal(page.status, 410);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('set-cookie'), null);
  assert.match(await page.text(), /Dieses Video ist nicht mehr verfügbar/);
  const head = await app.request(`/video/${video.shortId}`, { method: 'HEAD' });
  assert.equal(head.status, 410); assert.equal(await head.text(), '');
  for (const ext of ['gif', 'jpg', 'png']) assert.equal((await app.request(`/thumbnail/${video.shortId}.${ext}`)).status, 404);
  assert.equal((await app.request(`/thumbnail/${video.shortId}.gif`, { method: 'HEAD' })).status, 404);
  assert.equal((await app.request(`/video/${video.shortId}`, { headers: { host: 'wrong.invalid' } })).status, 404);
  assert.equal((app.store.db.prepare('SELECT count(*) n FROM events').get() as any).n, before);
  assert.throws(() => app.store.retryVideo(id, video.id), (error: any) => error.status === 409);
  assert.throws(() => app.store.cancelVideo(id, video.id), (error: any) => error.status === 409);
  assert.equal(app.store.platformCampaign(id).counts.expired, 1);
  assert.equal(app.store.platformOps().queue.expired, 1);
});

test('Outbox sends persisted JSON, rejects redirects, retries without exposing token', async t => {
  const app = await setup(t); let received: any; let calls = 0;
  const sink = http.createServer(async (req, res) => { calls++; const chunks = []; for await (const c of req) chunks.push(c); received = JSON.parse(Buffer.concat(chunks).toString()); res.writeHead(calls === 1 ? 302 : 204, { location: 'http://127.0.0.1:1/never-follow' }); res.end(); });
  await new Promise<void>(done => sink.listen(0, '127.0.0.1', done)); t.after(() => new Promise<void>(done => sink.close(() => done())));
  const target = `http://127.0.0.1:${(sink.address() as any).port}/hook?token=private-fixture`;
  app.store.webhookPut({ trigger: 'VIDEO_RENDERED', webhookUrl: target }); app.ready();
  const allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOKS;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  t.after(() => { if (allowPrivate === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS; else process.env.ALLOW_PRIVATE_WEBHOOKS = allowPrivate; });
  await dispatchOutbox(app.store); assert.equal(calls, 1); assert.equal(received.event, 'VIDEO_RENDERED');
  let row = app.store.db.prepare('SELECT * FROM outbox').get() as any; assert.equal(row.state, 'pending'); assert.equal(row.attempts, 1); assert.doesNotMatch(row.last_error, /private-fixture/);
  app.advance(60_000); await dispatchOutbox(app.store); assert.equal(calls, 2);
  row = app.store.db.prepare('SELECT * FROM outbox').get() as any; assert.equal(row.state, 'delivered');
  assert.equal(maskUrl(target).includes('private-fixture'), false);
});
