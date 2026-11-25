import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, dispatchOutbox, webhookAddressBlocked, type WebhookLookup } from '../src/server.js';
import { Store } from '../src/store.js';
import { campaignFixture, testDir } from './helpers.js';

function setup(t: any) {
  const store = new Store({ dataDir: testDir('webhook-ssrf'), publicBaseUrl: 'http://localhost' });
  t.after(() => store.close());
  store.campaignPut(campaignFixture(), 12);
  return store;
}
function queue(store: Store, webhookUrl: string) {
  store.webhookPut({ trigger: 'VIDEO_CREATED', webhookUrl });
  store.upsertVideo(campaignFixture().id, { variables: { website_0: 'http://localhost', website_4: 'http://localhost' } });
}
async function sink(t: any) {
  let calls = 0;
  const server = http.createServer(async (request, response) => { calls++; for await (const _ of request) { /* Drain. */ } response.writeHead(204); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook?token=private-fixture`, calls: () => calls };
}

test('dispatch blocks IPv4 loopback without sending and stores only the error code', async t => {
  const store = setup(t), target = await sink(t);
  queue(store, target.url);
  await dispatchOutbox(store);
  assert.equal(target.calls(), 0);
  const row: any = store.db.prepare('SELECT * FROM outbox').get();
  assert.equal(row.state, 'pending'); assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'blocked_private_target');
  assert.equal((store.db.prepare('SELECT last_error_code FROM webhooks').get() as any).last_error_code, 'blocked_private_target');
  assert.equal(store.platformWebhooks()[0].delivery.lastErrorCode, 'blocked_private_target');
});

test('dispatch blocks IPv6 loopback, mapped IPv4 and private IPv4 literals without sending', async t => {
  for (const webhookUrl of ['http://[::1]/hook', 'http://[::ffff:10.0.0.1]/hook', 'http://10.0.0.1/hook']) {
    const store = setup(t);
    queue(store, webhookUrl);
    await dispatchOutbox(store);
    assert.equal((store.db.prepare('SELECT last_error FROM outbox').get() as any).last_error, 'blocked_private_target', webhookUrl);
  }
});

test('dispatch blocks documentation, benchmark, broadcast and unspecified literals without sending', async t => {
  for (const ip of ['192.0.0.1', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '255.255.255.255']) {
    const store = setup(t);
    queue(store, `http://${ip}/hook`);
    await dispatchOutbox(store);
    assert.equal((store.db.prepare('SELECT last_error FROM outbox').get() as any).last_error, 'blocked_private_target', ip);
  }
});

test('dispatch connects to the resolved address, not a re-resolved one (spoofed lookup)', async t => {
  const store = setup(t), target = await sink(t);
  const port = new URL(target.url).port;
  queue(store, `http://webhook-fixture.invalid:${port}/hook?token=private-fixture`);
  let resolved = false;
  const lookup: WebhookLookup = async () => { resolved = true; return [{ address: '127.0.0.1', family: 4 }]; };
  const before = process.env.ALLOW_PRIVATE_WEBHOOKS;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    await dispatchOutbox(store, { lookup });
  } finally {
    if (before === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    else process.env.ALLOW_PRIVATE_WEBHOOKS = before;
  }
  assert.equal(resolved, true);
  assert.equal(target.calls(), 1);
  assert.equal((store.db.prepare('SELECT state FROM outbox').get() as any).state, 'delivered');
});

test('dispatch blocks when any resolved address is private', async t => {
  const store = setup(t), target = await sink(t);
  const port = new URL(target.url).port;
  queue(store, `http://webhook-fixture.invalid:${port}/hook?token=private-fixture`);
  let resolved = false;
  const lookup: WebhookLookup = async () => { resolved = true; return [{ address: '93.184.216.34', family: 4 }, { address: '203.0.113.7', family: 4 }]; };
  await dispatchOutbox(store, { lookup });
  assert.equal(resolved, true);
  assert.equal(target.calls(), 0);
  assert.equal((store.db.prepare('SELECT last_error FROM outbox').get() as any).last_error, 'blocked_private_target');
});

test('failed lookup fails closed without sending', async t => {
  const store = setup(t), target = await sink(t);
  const port = new URL(target.url).port;
  queue(store, `http://localhost:${port}/hook?token=private-fixture`);
  const lookup: WebhookLookup = async () => { throw Object.assign(Error('fixture_dns_failure'), { code: 'ENOTFOUND' }); };
  await dispatchOutbox(store, { lookup });
  assert.equal(target.calls(), 0);
  const row: any = store.db.prepare('SELECT state,attempts,last_error FROM outbox').get();
  assert.deepEqual(row, { state: 'pending', attempts: 1, last_error: 'delivery_failed' });
});

test('ALLOW_PRIVATE_WEBHOOKS=1 delivers to loopback for local tests', async t => {
  const store = setup(t), target = await sink(t);
  queue(store, target.url);
  const before = process.env.ALLOW_PRIVATE_WEBHOOKS;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    await dispatchOutbox(store);
  } finally {
    if (before === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    else process.env.ALLOW_PRIVATE_WEBHOOKS = before;
  }
  assert.equal(target.calls(), 1);
  assert.equal((store.db.prepare('SELECT state FROM outbox').get() as any).state, 'delivered');
});

test('hanging DNS lookup times out as transport error and dispatch stays usable', async t => {
  const store = setup(t), target = await sink(t);
  const port = new URL(target.url).port;
  queue(store, `http://example.com:${port}/hook?token=private-fixture`);
  const hanging: WebhookLookup = () => new Promise(() => {});
  const beforeTimeout = process.env.WEBHOOK_DNS_TIMEOUT_MS;
  const beforeAllow = process.env.ALLOW_PRIVATE_WEBHOOKS;
  process.env.WEBHOOK_DNS_TIMEOUT_MS = '200';
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  try {
    const started = Date.now();
    await dispatchOutbox(store, { lookup: hanging });
    assert.ok(Date.now() - started < 2000, 'dispatchOutbox ends in under 2 seconds');
  } finally {
    if (beforeTimeout === undefined) delete process.env.WEBHOOK_DNS_TIMEOUT_MS;
    else process.env.WEBHOOK_DNS_TIMEOUT_MS = beforeTimeout;
    if (beforeAllow === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    else process.env.ALLOW_PRIVATE_WEBHOOKS = beforeAllow;
  }
  assert.equal(target.calls(), 0);
  // Transport errors are stored as delivery_failed, like the failed-lookup test above.
  const row: any = store.db.prepare('SELECT state,attempts,last_error FROM outbox').get();
  assert.deepEqual(row, { state: 'pending', attempts: 1, last_error: 'delivery_failed' });
  store.db.prepare('UPDATE outbox SET next_at=?').run(0);
  const resolving: WebhookLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    await dispatchOutbox(store, { lookup: resolving });
  } finally {
    if (beforeAllow === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    else process.env.ALLOW_PRIVATE_WEBHOOKS = beforeAllow;
  }
  assert.equal(target.calls(), 1);
  assert.equal((store.db.prepare('SELECT state FROM outbox').get() as any).state, 'delivered');
});

test('late DNS answer after the timeout is ignored without send or crash', async t => {
  const store = setup(t), target = await sink(t);
  const port = new URL(target.url).port;
  queue(store, `http://example.com:${port}/hook?token=private-fixture`);
  let answers = 0;
  const late: WebhookLookup = () => new Promise(resolve => setTimeout(() => { answers++; resolve([{ address: '127.0.0.1', family: 4 }]); }, 400));
  const before = process.env.WEBHOOK_DNS_TIMEOUT_MS;
  process.env.WEBHOOK_DNS_TIMEOUT_MS = '200';
  try {
    await dispatchOutbox(store, { lookup: late });
  } finally {
    if (before === undefined) delete process.env.WEBHOOK_DNS_TIMEOUT_MS;
    else process.env.WEBHOOK_DNS_TIMEOUT_MS = before;
  }
  assert.equal(target.calls(), 0);
  const row: any = store.db.prepare('SELECT state,attempts,last_error FROM outbox').get();
  assert.deepEqual(row, { state: 'pending', attempts: 1, last_error: 'delivery_failed' });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(answers, 1);
  assert.equal(target.calls(), 0);
  const again: any = store.db.prepare('SELECT state,attempts,last_error FROM outbox').get();
  assert.deepEqual(again, { state: 'pending', attempts: 1, last_error: 'delivery_failed' });
});

test('invalid WEBHOOK_DNS_TIMEOUT_MS rejects server start', async t => {
  const before = process.env.WEBHOOK_DNS_TIMEOUT_MS;
  t.after(() => {
    if (before === undefined) delete process.env.WEBHOOK_DNS_TIMEOUT_MS;
    else process.env.WEBHOOK_DNS_TIMEOUT_MS = before;
  });
  for (const value of ['abc', '50', '70000']) {
    process.env.WEBHOOK_DNS_TIMEOUT_MS = value;
    assert.throws(() => createApp({ dataDir: testDir('webhook-dns-timeout'), publicBaseUrl: 'http://localhost',
      apiKeys: ['offline-fixture-api-1'], workerToken: 'offline-fixture-worker', internalViewToken: 'offline-internal-1',
      previewSecret: 'offline-preview-secret', dispatch: false }), /WEBHOOK_DNS_TIMEOUT_MS/);
  }
  process.env.WEBHOOK_DNS_TIMEOUT_MS = '200';
  const app = createApp({ dataDir: testDir('webhook-dns-timeout'), publicBaseUrl: 'http://localhost',
    apiKeys: ['offline-fixture-api-1'], workerToken: 'offline-fixture-worker', internalViewToken: 'offline-internal-1',
    previewSecret: 'offline-preview-secret', dispatch: false });
  await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
});

test('address check covers loopback, private, link-local, CGNAT, multicast, documentation, benchmark and mapped ranges', () => {
  const blocked = ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '169.254.10.20', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '255.255.255.255',
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:192.0.2.1', '::ffff:a00:1', '2001:db8::1', 'not-an-address'];
  for (const address of blocked) assert.equal(webhookAddressBlocked(address), true, address);
  const allowed = ['8.8.8.8', '93.184.216.34', '100.128.0.1', '172.32.0.1', '192.0.3.1', '198.20.0.1', '198.51.101.1', '203.0.114.1', '2606:4700::1111', '::ffff:8.8.8.8'];
  for (const address of allowed) assert.equal(webhookAddressBlocked(address), false, address);
});
