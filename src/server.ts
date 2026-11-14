import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, HttpError, MUX_GIF_PARAMS, maskUrl, dispatchEnabled } from './store.js';
export { maskUrl };
import { assertDeploySecret, ensureDataDirectory, randomId, safeHttpUrl, validateCampaign, videoBaseUrl } from './model.js';
import { cookies, isBot, landingPage, secureEqual, sign, statusPage } from './landing.js';
import { issuePreviewTicket, validPreviewTicket } from './preview.js';

export interface AppOptions {
  dataDir?: string; publicBaseUrl: string; apiKeys: string[]; workerToken: string; internalViewToken: string; previewSecret: string;
  now?: () => number; dispatch?: boolean;
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, { error: 'body_too_large' });
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    return data;
  } catch { throw new HttpError(400, { error: 'invalid_json' }); }
}
function json(res: ServerResponse, value: unknown, status = 200, maxBytes = /^\/api\/platform\/v1(?:[/?]|$)/.test(res.req.url ?? '') ? 2 * 1024 * 1024 : Infinity) {
  let serialized = status === 204 ? undefined : JSON.stringify(value);
  if (Buffer.byteLength(serialized ?? '') > maxBytes) { status = 413; serialized = JSON.stringify({ error: 'response_too_large' }); }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(serialized);
}
export type WebhookLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
const webhookBlockList = new net.BlockList();
for (const [address, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as [string, number][]) {
  webhookBlockList.addSubnet(address, bits, 'ipv4');
  webhookBlockList.addSubnet(`::ffff:${address}`, 96 + bits, 'ipv6');
}
webhookBlockList.addAddress('255.255.255.255', 'ipv4');
webhookBlockList.addAddress('::ffff:255.255.255.255', 'ipv6');
for (const [address, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]] as [string, number][]) webhookBlockList.addSubnet(address, bits, 'ipv6');
export function webhookAddressBlocked(address: string): boolean {
  const base = address.split('%')[0];
  if (net.isIPv4(base)) return webhookBlockList.check(base, 'ipv4');
  if (net.isIPv6(base)) return webhookBlockList.check(base, 'ipv6');
  return true;
}
const blockedError = () => Object.assign(Error('webhook target blocked'), { code: 'EBLOCKEDPRIVATE' });
function postWebhook(target: string, payload: string, resolveAll: WebhookLookup): Promise<number> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(target);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Error('unsupported webhook protocol');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (process.env.ALLOW_PRIVATE_WEBHOOKS !== '1' && net.isIP(host) !== 0 && webhookAddressBlocked(host)) throw blockedError();
    } catch (error) { reject(error); return; }
    const lookup: LookupFunction = (hostname, options, callback) => {
      resolveAll(hostname).then(
        records => {
          if (!records.length) { callback(Object.assign(Error('webhook lookup failed'), { code: 'ENOTFOUND' }), '', 0); return; }
          if (process.env.ALLOW_PRIVATE_WEBHOOKS !== '1' && records.some(record => webhookAddressBlocked(record.address))) { callback(blockedError(), '', 0); return; }
          if (options.all) callback(null, records);
          else callback(null, records[0].address, records[0].family);
        },
        error => callback(error, '', 0),
      );
    };
    const request = (url.protocol === 'https:' ? https : http).request(url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 60_000, lookup },
      response => { response.on('error', () => {}); response.destroy(); resolve(response.statusCode ?? 0); });
    request.on('timeout', () => request.destroy(Error('webhook timeout')));
    request.on('error', reject);
    request.end(payload);
  });
}
export async function dispatchOutbox(store: Store, options: { lookup?: WebhookLookup } = {}): Promise<void> {
  if (!dispatchEnabled()) return;
  const rows = store.dueOutbox(20);
  const resolveAll = options.lookup ?? (hostname => dnsLookup(hostname, { all: true }));
  await Promise.allSettled(rows.map(async (row: any) => {
    try {
      const status = await postWebhook(row.webhookUrl, typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload), resolveAll);
      if (status >= 200 && status < 300) store.outboxSuccess(row.id);
      else store.outboxFailure(row.id, `http_${status}`);
    } catch (error: any) { store.outboxFailure(row.id, error?.code === 'EBLOCKEDPRIVATE' ? 'blocked_private_target' : 'transport_error'); }
  }));
}
export function createApp(options: AppOptions) {
  if (!safeHttpUrl(options.publicBaseUrl)) throw Error('PUBLIC_BASE_URL must be an HTTP(S) URL without credentials');
  if (!options.previewSecret?.trim()) throw Error('PREVIEW_SECRET is required');
  for (const key of options.apiKeys) assertDeploySecret('API_KEYS', key);
  assertDeploySecret('WORKER_TOKEN', options.workerToken);
  assertDeploySecret('INTERNAL_VIEW_TOKEN', options.internalViewToken);
  assertDeploySecret('PREVIEW_SECRET', options.previewSecret);
  const dataDir = ensureDataDirectory(options.dataDir);
  const store = new Store({ dataDir, publicBaseUrl: options.publicBaseUrl, now: options.now });
  store.cleanup();
  const cleanupTimer = setInterval(() => {
    try { store.cleanup(); } catch { console.error('video-kit retention cleanup deferred'); }
  }, 24 * 60 * 60_000);
  cleanupTimer.unref();
  const now = options.now ?? Date.now;
  const beaconSecret = options.workerToken || randomBytes(32).toString('hex');
  const internalValue = sign('internal-preview', options.internalViewToken || beaconSecret);
  let dispatching = false;
  const timer = options.dispatch === false ? undefined : setInterval(() => {
    if (dispatching) return; dispatching = true;
    void dispatchOutbox(store).finally(() => { dispatching = false; });
  }, 1000);
  timer?.unref();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      const url = new URL(req.url ?? '/', options.publicBaseUrl);
      const path = url.pathname; const method = req.method;
      if (path === '/healthz' && method === 'GET') {
        store.db.prepare('SELECT 1').get();
        return json(res, { status: 'ok' });
      }
      const jar = cookies(req.headers.cookie);
      const internal = !!options.internalViewToken && !!jar.ac_internal && secureEqual(jar.ac_internal, internalValue);
      const authorizeWorker = () => {
        const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
        if (!options.workerToken || !secureEqual(token, options.workerToken)) throw new HttpError(401, { error: 'unauthorized' });
      };
      const hostMatches = (campaign: any) => (req.headers.host ?? '').toLowerCase() === (campaign.domain || new URL(options.publicBaseUrl).host).toLowerCase();
      if (path === '/api/platform/v1' || path.startsWith('/api/platform/v1/')) {
        const key = req.headers['x-api-key'];
        if (typeof key !== 'string' || !options.apiKeys.filter(Boolean).some(k => secureEqual(k, key))) throw new HttpError(401, { error: 'unauthorized' });
        const route = path.slice('/api/platform/v1'.length);
        const respond = (value: unknown, status = 200) => json(res, value, status, 2 * 1024 * 1024);
        if (route === '/ops' && method === 'GET') return respond(store.platformOps());
        const requeue = route.match(/^\/webhooks\/([A-Za-z0-9_-]+)\/requeue$/);
        if (requeue && method === 'POST') return respond(store.requeueWebhook(requeue[1], await body(req)));
        const release = route.match(/^\/campaigns\/([A-Za-z0-9_-]+)\/deferred\/release$/);
        if (release && method === 'POST') return respond(store.releaseDeferredVideos(release[1], (await body(req)).limit));
        if (route === '/campaigns' && method === 'GET') return respond(store.platformCampaigns());
        if (route === '/webhooks') {
          if (method === 'GET') return respond(store.platformWebhooks());
          if (method === 'POST') {
            const input = await body(req); delete input.id;
            return respond(store.platformWebhookPut(input));
          }
          if (method === 'DELETE') {
            const id = url.searchParams.get('id');
            if (!id) throw new HttpError(400, { error: 'id_required' });
            return respond(store.platformWebhookDelete(id), 204);
          }
        }
        const match = route.match(/^\/campaigns\/([A-Za-z0-9_-]+)(?:\/(videos|stats|import)(?:\/([A-Za-z0-9_-]+)(?:\/(preview-ticket|retry|cancel))?)?)?$/);
        if (match) {
          const [, campaignId, action, videoId, operation] = match;
          if (!action && method === 'GET') return respond(store.platformCampaign(campaignId));
          if (action === 'videos') {
            if (!videoId && method === 'GET') return respond(store.platformVideos(campaignId, {
              limit: Number(url.searchParams.get('limit') ?? 100), offset: Number(url.searchParams.get('offset') ?? 0),
              status: url.searchParams.get('status') ?? undefined, q: url.searchParams.get('q') ?? undefined,
            }));
            if (videoId && !operation && method === 'GET') return respond(store.platformVideo(campaignId, videoId));
            if (videoId && method === 'POST') {
              if (operation === 'retry') return respond(store.retryVideo(campaignId, videoId));
              if (operation === 'cancel') return respond(store.cancelVideo(campaignId, videoId));
              if (operation === 'preview-ticket') {
                store.platformVideo(campaignId, videoId);
                const video = store.video(videoId);
                const { ticket, expiresAt } = issuePreviewTicket(video.id, options.previewSecret, now());
                return respond({ url: `${videoBaseUrl(store.campaign(campaignId), options.publicBaseUrl)}/video/${video.shortId}?preview=${encodeURIComponent(ticket)}`, expiresAt });
              }
            }
          }
          if (!videoId && action === 'stats' && method === 'GET') return respond(store.platformStats(campaignId, {
            from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined,
          }));
          if (!videoId && action === 'import' && method === 'POST') return respond(store.platformImport(campaignId, await body(req)));
        }
        throw new HttpError(404, { error: 'not_found' });
      }
      if (path.startsWith('/api/public/v1')) {
        const key = String(req.headers['x-api-key'] ?? url.searchParams.get('apiKey') ?? '');
        if (!options.apiKeys.filter(Boolean).some(k => secureEqual(k, key))) throw new HttpError(401, { error: 'unauthorized' });
        const route = path.slice('/api/public/v1'.length);
        if (route === '/campaigns' && method === 'GET') return json(res, store.campaigns());
        if (route === '/webhooks') {
          if (method === 'GET') return json(res, store.webhooks(url.searchParams.get('campaignId') ?? undefined));
          if (method === 'POST' || method === 'PUT') {
            const input = await body(req);
            if (method === 'PUT' && typeof input.id !== 'string') throw new HttpError(400, { errors: [{ message: 'id required', path: 'id' }] });
            if (method === 'POST') delete input.id;
            return json(res, store.webhookPut(input));
          }
          if (method === 'DELETE') return json(res, store.webhookDelete(url.searchParams.get('webhookUrl'), url.searchParams.get('trigger')), 204);
        }
        const match = route.match(/^\/campaigns\/([^/]+)\/(schema|schemas|lead-schema-mapping|videos(?:\/import(?:\/v2)?)?|webhooks)$/);
        if (match) {
          const [, campaignId, action] = match;
          if (['schema', 'schemas', 'lead-schema-mapping'].includes(action) && method === 'GET') return json(res, store.schema(campaignId, action as any));
          if (action === 'videos') {
            if (method === 'POST') return json(res, store.upsertVideo(campaignId, await body(req)));
            if (method === 'GET') return json(res, store.listVideos(campaignId, Number(url.searchParams.get('limit') ?? 100), Number(url.searchParams.get('offset') ?? 0)));
          }
          if (action.startsWith('videos/import') && method === 'POST') return json(res, store.importVideos(campaignId, await body(req), { legacy: action === 'videos/import' }));
          if (action === 'webhooks') {
            if (method === 'POST') { const input = await body(req); delete input.id; return json(res, store.webhookPut(input, campaignId)); }
            if (method === 'DELETE') return json(res, store.webhookDelete(url.searchParams.get('webhookUrl'), url.searchParams.get('trigger'), campaignId), 204);
          }
        }
        throw new HttpError(404, { error: 'not_found' });
      }
      const admin = path.match(/^\/admin\/campaigns\/([A-Za-z0-9_-]+)$/);
      if (admin && method === 'PUT') {
        authorizeWorker(); const input = await body(req);
        try { validateCampaign(input.campaign, input.durationSec); } catch { throw new HttpError(400, { error: 'invalid_campaign' }); }
        if (input.campaign.id !== admin[1]) throw new HttpError(400, { error: 'campaign_id_mismatch' });
        store.campaignPut(input.campaign, input.durationSec);
        return json(res, { success: true, id: input.campaign.id });
      }
      if (path === '/worker/claim' && method === 'POST') { authorizeWorker(); return json(res, store.claim((await body(req)).limit ?? 2)); }
      if (path === '/worker/missing-mp4' && method === 'GET') { authorizeWorker(); return json(res, store.missingMp4(Number(url.searchParams.get('limit') ?? 100))); }
      const job = path.match(/^\/worker\/([A-Za-z0-9_-]+)\/(complete|fail|release|mp4|gif)$/);
      if (job && method === 'POST') {
        authorizeWorker(); const input = await body(req);
        if (job[2] === 'complete') return json(res, store.complete(job[1], input));
        if (job[2] === 'release') return json(res, store.release(job[1], input));
        if (job[2] === 'mp4') return json(res, store.backfillMp4(job[1], input));
        if (job[2] === 'gif') return json(res, await store.saveGif(job[1], input));
        return json(res, store.fail(job[1], input.reason, input.leaseToken));
      }
      const pageMatch = path.match(/^\/video\/([A-Za-z0-9]{12})$/);
      const thumbnailMatch = path.match(/^\/thumbnail\/([A-Za-z0-9]{12})\.(gif|jpg|png)$/);
      if ((pageMatch && (method === 'GET' || method === 'HEAD')) || (thumbnailMatch && (method === 'GET' || method === 'HEAD'))) {
        const shortId = (pageMatch || thumbnailMatch)![1];
        const video = store.getVideo(shortId);
        if (!video || !hostMatches(store.campaign(video.campaignId))) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(method === 'HEAD' ? undefined : statusPage('Video nicht gefunden'));
        }
        if (video.status === 'expired') {
          if (thumbnailMatch) throw new HttpError(404, { error: 'video_not_ready' });
          res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(method === 'HEAD' ? undefined : statusPage('Dieses Video ist nicht mehr verfügbar'));
        }
        if (pageMatch && method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end();
        }
        const campaign = store.campaign(video.campaignId);
        if (thumbnailMatch) {
          if (!video.playbackId) throw new HttpError(404, { error: 'video_not_ready' });
          if (thumbnailMatch[2] === 'gif') {
            try {
              const gif = await readFile(store.gifPath(video.shortId));
              res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': gif.length, 'Cache-Control': 'public, max-age=2592000' });
              return res.end(method === 'HEAD' ? undefined : gif);
            } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
            res.writeHead(302, { Location: `https://image.mux.com/${encodeURIComponent(video.playbackId)}/${MUX_GIF_PARAMS}`, 'Cache-Control': 'public, max-age=3600' }); return res.end();
          }
          const image = `thumbnail.${thumbnailMatch[2]}?time=0&width=600`;
          res.writeHead(302, { Location: `https://image.mux.com/${encodeURIComponent(video.playbackId)}/${image}`, 'Cache-Control': 'public, max-age=31536000, immutable' }); return res.end();
        }
        const preview = url.searchParams.has('preview');
        if (preview && !validPreviewTicket(url.searchParams.get('preview')!, video.id, options.previewSecret, now())) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(statusPage('Vorschau ungültig oder abgelaufen'));
        }
        if (!preview && options.internalViewToken && url.searchParams.has('internal') && secureEqual(url.searchParams.get('internal')!, options.internalViewToken)) {
          res.writeHead(302, { Location: `/video/${shortId}`, 'Set-Cookie': `ac_internal=${internalValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${new URL(options.publicBaseUrl).protocol === 'https:' ? '; Secure' : ''}`, 'Cache-Control': 'no-store' }); return res.end();
        }
        if (!video.playbackId) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(statusPage(preview ? 'Vorschau · Tracking deaktiviert' : video.status === 'failed' ? 'Video konnte noch nicht erstellt werden' : 'Video wird erstellt')); }
        let session = jar.ac_session || '';
        const [id, signature] = session.split('.');
        if (!preview && !internal && (!id || !/^[A-Za-z0-9_-]{21}$/.test(id) || !signature || !secureEqual(signature, sign(id, beaconSecret)))) {
          const fresh = randomId(); session = `${fresh}.${sign(fresh, beaconSecret)}`;
          res.setHeader('Set-Cookie', `ac_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800${new URL(options.publicBaseUrl).protocol === 'https:' ? '; Secure' : ''}`);
        }
        const expires = String(now() + 30 * 60_000);
        const token = preview || internal ? '' : `${expires}.${sign(`${shortId}:${session}:${expires}`, beaconSecret)}`;
        const nonce = randomBytes(18).toString('base64');
        // shortcut: the landing CSP only knows Facebook; extend it when head HTML needs further providers.
        const headDelivered = !preview && !internal && !!campaign.landing.headHtml;
        const scriptSrc = `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net${headDelivered ? ' https://connect.facebook.net' : ''}`;
        const connectSrc = `connect-src 'self' https://*.mux.com https://*.litix.io${headDelivered ? ' https://www.facebook.com https://connect.facebook.net' : ''}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; ${scriptSrc}; style-src 'unsafe-inline'; img-src https: data:; media-src https://stream.mux.com https://image.mux.com blob:; ${connectSrc}; frame-src https://calendly.com https://*.calendly.com; font-src https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        return res.end(landingPage(campaign, video, token, internal, preview).replaceAll('BEACON_NONCE', nonce));
      }
      if (path === '/e' && method === 'POST') {
        if (internal || isBot(req.headers['user-agent'] ?? '')) return json(res, { accepted: false }, 202);
        const input = await body(req);
        const video = typeof input.shortId === 'string' ? store.getVideo(input.shortId) : undefined;
        const session = jar.ac_session ?? '';
        const [sessionId, sessionSig] = session.split('.');
        const [expires, signature] = String(input.token ?? '').split('.');
        const origin = req.headers.origin;
        const campaign = video && store.campaign(video.campaignId);
        const expectedOrigin = campaign && `${new URL(options.publicBaseUrl).protocol}//${req.headers.host}`;
        if (!video?.playbackId || !campaign || !hostMatches(campaign) || !sessionId || !sessionSig || !secureEqual(sessionSig, sign(sessionId, beaconSecret)) || !signature || !Number.isFinite(Number(expires)) || Number(expires) < now() || Number(expires) > now() + 30 * 60_000 || !secureEqual(signature, sign(`${input.shortId}:${session}:${expires}`, beaconSecret)) || (origin && origin !== expectedOrigin) || !['VIEWED', 'STARTED', 'FINISHED'].includes(input.type) || (input.type === 'FINISHED' && !(Number.isFinite(input.progress) && input.progress >= .95 && input.progress <= 1.05))) return json(res, { accepted: false }, 202);
        return json(res, store.track(input.shortId, input.type, sessionId), 202);
      }
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(statusPage('Seite nicht gefunden'));
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return json(res, error.body, error.status);
      // Never include request bodies, target URLs, query strings or exception messages in responses/logs.
      json(res, { error: 'internal_error' }, 500);
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return { server, store, close: async () => { clearInterval(cleanupTimer); if (timer) clearInterval(timer); await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done())); store.db.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { DATA_DIR, PUBLIC_BASE_URL, API_KEYS, WORKER_TOKEN, INTERNAL_VIEW_TOKEN, PREVIEW_SECRET } = process.env;
  if (!PUBLIC_BASE_URL || !API_KEYS || !WORKER_TOKEN || !INTERNAL_VIEW_TOKEN || !PREVIEW_SECRET) throw Error('PUBLIC_BASE_URL, API_KEYS, WORKER_TOKEN, INTERNAL_VIEW_TOKEN and PREVIEW_SECRET are required');
  const app = createApp({ dataDir: DATA_DIR, publicBaseUrl: PUBLIC_BASE_URL, apiKeys: API_KEYS.split(',').map(k => k.trim()), workerToken: WORKER_TOKEN, internalViewToken: INTERNAL_VIEW_TOKEN, previewSecret: PREVIEW_SECRET });
  app.server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => console.log('video-kit server listening'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
