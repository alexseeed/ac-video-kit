import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDataDirectory } from '../src/model.js';
import { dataDirectory, loadCampaign, localAsset } from '../src/render.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function command(args: string[], env: NodeJS.ProcessEnv, log: number): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env, stdio: ['ignore', log, log] });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Local CLI failed; inspect e2e.log')));
  });
}
async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode) return;
  const ended = new Promise<void>(resolve => { server.once('exit', () => resolve()); server.once('error', () => resolve()); });
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 5000);
  try { await ended; } finally { clearTimeout(force); }
}
async function main(): Promise<void> {
  if (process.argv.slice(2).length) throw new Error('Usage: scripts/e2e-local.sh (no arguments; Fake-Mux is configured only by the offline test environment)');
  if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) throw new Error('MUX_TOKEN_ID and MUX_TOKEN_SECRET must be supplied in the process environment');
  if (process.env.MUX_BASE_URL && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.MUX_BASE_URL).hostname)) throw new Error('MUX_BASE_URL overrides are restricted to local Fake-Mux');
  const root = await dataDirectory();
  const campaignDir = process.env.E2E_CAMPAIGN_DIR || path.resolve(import.meta.dirname, '../examples/demo-kampagne');
  const { campaign } = await loadCampaign(campaignDir);
  // Screenshots need a reachable page; local runs serve a fixture and point E2E_WEBSITE_URL at it.
  const website = process.env.E2E_WEBSITE_URL;
  if (!website) throw new Error('E2E_WEBSITE_URL must point at a local fixture page (see README quickstart)');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(website).hostname)) throw new Error('E2E_WEBSITE_URL is restricted to a local fixture');
  const port = Number(process.env.E2E_PORT || 3012);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid E2E_PORT');
  const serverUrl = `http://127.0.0.1:${port}`;
  const e2eRoot = ensureDataDirectory(path.join(root, 'e2e-local'));
  const runDir = await mkdtemp(path.join(e2eRoot, 'run-'));
  const serverData = ensureDataDirectory(path.join(runDir, 'server'));
  const localCampaigns = ensureDataDirectory(path.join(runDir, 'campaigns'));
  const localCampaignDir = ensureDataDirectory(path.join(localCampaigns, campaign.id));
  // A localhost-only copy makes its landing page usable without changing the deploy campaign/domain.
  for (const asset of new Set([campaign.baseVideo, ...campaign.pages.flatMap(page => page.type === 'image' ? [page.src] : [])])) {
    const destination = path.join(localCampaignDir, asset);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(await localAsset(campaignDir, asset), destination);
  }
  await writeFile(path.join(localCampaignDir, 'campaign.json'), JSON.stringify({ ...campaign, domain: null }, null, 2) + '\n', { mode: 0o600 });
  const token = () => randomBytes(24).toString('hex');
  const apiKey = token(), workerToken = token(), internalToken = token();
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: serverUrl, SERVER_URL: serverUrl,
    DATA_DIR: serverData, CAMPAIGNS_DIR: localCampaigns, API_KEYS: apiKey, WORKER_TOKEN: workerToken, INTERNAL_VIEW_TOKEN: internalToken, PREVIEW_SECRET: token() };
  const log = await open(path.join(runDir, 'e2e.log'), 'a', 0o600);
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  let serverError: Error | undefined;
  server.once('error', error => { serverError = error; });
  let success = false;
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (serverError || server.exitCode !== null) throw new Error('Local server did not start');
      try {
        const response = await fetch(serverUrl + '/healthz', { signal: AbortSignal.timeout(1000), redirect: 'manual' });
        if (response.ok) break;
      } catch { /* Server may still be starting. */ }
      if (Date.now() > deadline) throw new Error('Local server startup timeout');
      await pause(100);
    }
    await command(['campaign', 'push', localCampaignDir], env, log.fd);
    const request = async (route: string, payload?: unknown) => {
      const response = await fetch(serverUrl + '/api/public/v1' + route, { method: payload ? 'POST' : 'GET', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Local API returned HTTP ${response.status}`);
      return await response.json() as any;
    };
    const importId = 'e2e-local-' + Date.now();
    const imported = await request(`/campaigns/${encodeURIComponent(campaign.id)}/videos/import/v2`, {
      importId, videos: [{ website_0: website, website_4: website, email: 'e2e-local@example.com', first_name: 'Lokaler Test' }],
      queueAllVideosForRender: true, duplicateIdentifierField: 'email'
    });
    if (imported.inserted !== 1 || imported.invalidRows) throw new Error('E2E import did not create exactly one valid video');
    // Local templates/assets remain in place; only worker state uses the fresh, hook-free test data.
    await command(['worker', 'once'], env, log.fd);
    const renderedDeadline = Date.now() + 30_000;
    let video: any;
    for (;;) {
      const listing = await request(`/campaigns/${encodeURIComponent(campaign.id)}/videos`);
      video = listing.videos.find((item: any) => item.importId === importId);
      if (video?.renderingStatus === 'RENDERED') break;
      if (video?.renderingStatus === 'FAILED' || Date.now() > renderedDeadline) throw new Error('Test video did not reach rendered status; inspect e2e.log');
      await pause(250);
    }
    const shortId = video.shortId;
    const manifest = { runDir, serverPid: server.pid, landingUrl: `${serverUrl}/video/${shortId}?internal=${internalToken}`, gifUrl: `${serverUrl}/thumbnail/${shortId}.gif`, serverRunning: process.env.E2E_STOP_SERVER !== '1' };
    await writeFile(path.join(runDir, 'result.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(manifest, null, 2));
    success = true;
  } finally {
    if (!success || process.env.E2E_STOP_SERVER === '1') await stop(server);
    else server.unref();
    await log.close();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Local E2E failed'); process.exitCode = 1; });
