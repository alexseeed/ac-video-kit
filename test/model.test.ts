import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultDataRoot, deriveSchema, escapeHtml, randomId, safeHttpUrl, validateCampaign } from '../src/model.js';
import { campaignFixture, testDir } from './helpers.js';

test('campaign schema matches the Pitchlane-compatible shape exactly; invalid timeline, asset, URL and CSS rejected', () => {
  const c = campaignFixture(); validateCampaign(c, 12);
  assert.deepEqual(deriveSchema(c), { website_0: { label: 'Page 1: Company Website', required: true, validator: { type: 'url', domain: null } },
    website_4: { label: 'Page 5: Company Website', required: true, validator: { type: 'url', domain: null } } });
  for (const mutate of [
    (v: any) => v.pages[0].start = 1, (v: any) => v.pages[1].start = 5,
    (v: any) => v.pages[2].end = 11, (v: any) => v.pages[0].type = 'unknown',
    (v: any) => v.baseVideo = '../base.mp4', (v: any) => v.landing.ctaUrl = 'javascript:alert(1)',
    (v: any) => v.landing.brandColor = 'red;display:none', (v: any) => v.output.width = 1919,
    (v: any) => v.bubble.diameterPct = Infinity, (v: any) => v.titleTemplate = 42, (v: any) => v.pages[0].label = 42,
    (v: any) => v.pages[0].scroll = [[0, 2, 9000]], (v: any) => v.pages[0].scroll = [[1, 3, 200], [2, 4, 200]],
    (v: any) => v.pages[0].scroll = [[0, 5, 200]], (v: any) => v.pages[1].header = '../evil.png', (v: any) => v.landing.ctaColor = 'red',
    (v: any) => v.landing.creatorName = 42, (v: any) => v.bubble.shadowOpacity = 2,
  ]) { const bad = structuredClone(c); mutate(bad); assert.throws(() => validateCampaign(bad, 12)); }
});
test('campaign video bitrate is optional and bounded to whole kilobits between 500 and 8000', () => {
  const base = campaignFixture(); validateCampaign(base, 12);
  for (const videoBitrateKbps of [500, 4500, 8000]) validateCampaign(campaignFixture({ output: { width: 1920, height: 1080, fps: 30, videoBitrateKbps } }), 12);
  for (const videoBitrateKbps of [0, 499, 8001, 4500.5, NaN, '4500', null]) {
    const bad = structuredClone(base); (bad.output as any).videoBitrateKbps = videoBitrateKbps;
    assert.throws(() => validateCampaign(bad, 12));
  }
});
test('campaign head HTML and priority are optional and bounded', () => {
  const base = campaignFixture(); validateCampaign(base, 12);
  validateCampaign(campaignFixture({ priority: 0 }), 12);
  validateCampaign(campaignFixture({ priority: 10 }), 12);
  const headed = campaignFixture(); headed.landing.headHtml = '<script>fbq()</script><noscript></noscript>';
  validateCampaign(headed, 12);
  const maxed = campaignFixture(); maxed.landing.headHtml = 'x'.repeat(20000);
  validateCampaign(maxed, 12);
  for (const mutate of [
    (v: any) => v.priority = -1, (v: any) => v.priority = 11, (v: any) => v.priority = 1.5,
    (v: any) => v.priority = '1', (v: any) => v.priority = NaN, (v: any) => v.priority = null,
    (v: any) => v.landing.headHtml = 'x'.repeat(20001),
    (v: any) => v.landing.headHtml = 42, (v: any) => v.landing.headHtml = null, (v: any) => v.landing.headHtml = {},
  ]) { const bad = structuredClone(base); mutate(bad); assert.throws(() => validateCampaign(bad, 12)); }
});
test('default DATA_ROOT_DIR is the repository data directory for model and render', () => {
  const expected = join(import.meta.dirname, '..', 'data');
  assert.equal(defaultDataRoot(), expected);
  const existed = existsSync(expected);
  try {
    const env = { ...process.env };
    delete env.DATA_ROOT_DIR; delete env.DATA_DIR;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { realpathSync } from 'node:fs';
    const { DEFAULT_DATA_DIR } = await import(process.argv[2]);
    assert.equal(DEFAULT_DATA_DIR, process.argv[1]);
    const { dataDirectory } = await import(process.argv[3]);
    assert.equal(await dataDirectory(), realpathSync(process.argv[1]));
  `, expected, new URL('../src/model.ts', import.meta.url).href, new URL('../src/render.ts', import.meta.url).href], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    if (!existed) rmSync(expected, { recursive: true, force: true });
  }
});

test('IDs are cryptographic alphabet-safe; HTTP validation and escaping preserve boundaries', () => {
  const ids = new Set(Array.from({ length: 500 }, () => randomId())); assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{21}$/);
  assert.equal(safeHttpUrl('https://example.invalid/a?b=1'), true);
  for (const url of ['javascript:1', 'file:///tmp/x', 'http://user:pass@example.invalid', {}, null]) assert.equal(safeHttpUrl(url), false);
  assert.equal(escapeHtml('<img src="x">&\''), '&lt;img src=&quot;x&quot;&gt;&amp;&#39;');
});

test('configured DATA_ROOT_DIR is the default mount and rejects directory or symlink escapes', t => {
  const fixture = testDir('configured-root'), root = join(fixture, 'mounted-data'), sibling = root + '-sibling';
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(root); mkdirSync(sibling); symlinkSync(sibling, join(root, 'linked-out'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { existsSync, realpathSync } from 'node:fs';
    import { join } from 'node:path';
    const { DEFAULT_DATA_DIR, ensureDataDirectory } = await import(process.argv[1]);
    const root = process.env.DATA_ROOT_DIR;
    assert.equal(DEFAULT_DATA_DIR, root);
    assert.equal(ensureDataDirectory(), realpathSync(root));
    assert.equal(ensureDataDirectory(join(root, 'worker', 'output')), realpathSync(join(root, 'worker', 'output')));
    assert.throws(() => ensureDataDirectory(root + '-sibling/escaped'), /inside DATA_ROOT_DIR/);
    assert.throws(() => ensureDataDirectory(join(root, 'linked-out', 'escaped')), /symlink escapes/);
    assert.equal(existsSync(root + '-sibling/escaped'), false);
  `, new URL('../src/model.ts', import.meta.url).href], { env: { ...process.env, DATA_ROOT_DIR: root }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'worker', 'output')), true);
  assert.equal(existsSync(join(sibling, 'escaped')), false);
});
