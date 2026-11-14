import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { workerFromEnvironment } from '../src/worker.js';
import { testDir } from './helpers.js';

const valid = { publicBaseUrl: 'http://localhost', apiKeys: ['offline-fixture-api-1'], workerToken: 'offline-fixture-worker', internalViewToken: 'offline-internal-1', previewSecret: 'offline-preview-secret', dispatch: false };

test('server start rejects placeholder and short secrets with a clear message', async t => {
  const cases = [
    [{ ...valid, apiKeys: ['change-me'] }, /API_KEYS/],
    [{ ...valid, apiKeys: ['short'] }, /API_KEYS/],
    [{ ...valid, apiKeys: ['offline-fixture-api-1', 'x'] }, /API_KEYS/],
    [{ ...valid, workerToken: 'change-me' }, /WORKER_TOKEN/],
    [{ ...valid, workerToken: 'short' }, /WORKER_TOKEN/],
    [{ ...valid, internalViewToken: 'change-me' }, /INTERNAL_VIEW_TOKEN/],
    [{ ...valid, internalViewToken: 'short' }, /INTERNAL_VIEW_TOKEN/],
    [{ ...valid, previewSecret: 'change-me' }, /PREVIEW_SECRET/],
    [{ ...valid, previewSecret: 'short' }, /PREVIEW_SECRET/],
  ] as Array<[typeof valid, RegExp]>;
  for (const [options, pattern] of cases) {
    assert.throws(() => createApp({ ...options, dataDir: testDir('secret-start') }), (error: unknown) => {
      assert.match((error as Error).message, pattern);
      assert.match((error as Error).message, /16 characters/);
      return true;
    });
  }
  const app = createApp({ ...valid, dataDir: testDir('secret-start-valid') });
  await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
});

test('worker start rejects placeholder and short WORKER_TOKEN', async t => {
  const dataDir = testDir('secret-worker');
  const env = { DATA_DIR: dataDir, SERVER_URL: 'http://127.0.0.1:9', CAMPAIGNS_DIR: dataDir, MUX_TOKEN_ID: 'fake', MUX_TOKEN_SECRET: 'fake' };
  const before = new Map(Object.keys({ ...env, WORKER_TOKEN: '' }).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, env);
  for (const token of ['change-me', 'short']) {
    process.env.WORKER_TOKEN = token;
    await assert.rejects(workerFromEnvironment(), /WORKER_TOKEN.*16 characters/);
  }
  process.env.WORKER_TOKEN = 'offline-fixture-worker';
  const worker = await workerFromEnvironment();
  await worker.close();
});
