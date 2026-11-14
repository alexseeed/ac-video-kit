import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { ensureDataDirectory } from './model.js';
import { dataDirectory, loadCampaign, mediaCommand, renderCampaign } from './render.js';
import { MuxClient, workerFromEnvironment } from './worker.js';

function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
async function request(route: string, init: RequestInit): Promise<any> {
  const response = await fetch(requiredEnv('SERVER_URL').replace(/\/$/, '') + route, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  return await response.json();
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [group, action, directory] = args;
  if (group === 'mux' && action === 'backfill-mp4') {
    const dataDir = await dataDirectory();
    const mux = new MuxClient({ dataDir, tokenId: requiredEnv('MUX_TOKEN_ID'), tokenSecret: requiredEnv('MUX_TOKEN_SECRET'), baseUrl: process.env.MUX_BASE_URL });
    const headers = { authorization: `Bearer ${requiredEnv('WORKER_TOKEN')}`, 'content-type': 'application/json' };
    let updated = 0;
    for (;;) {
      const result = await request('/worker/missing-mp4?limit=100', { method: 'GET', headers });
      if (!Array.isArray(result.videos) || result.videos.length > 100) throw new Error('Invalid MP4 backfill list');
      if (!result.videos.length) break;
      for (const video of result.videos) {
        if (typeof video.id !== 'string' || typeof video.muxAssetId !== 'string' || typeof video.playbackId !== 'string') throw new Error('Invalid MP4 backfill video');
        const ready = await mux.backfill(video.id, video.muxAssetId, video.playbackId);
        await request(`/worker/${encodeURIComponent(video.id)}/mp4`, { method: 'POST', headers, body: JSON.stringify({ muxAssetId: ready.muxAssetId, playbackId: ready.playbackId, videoFileUrl: ready.videoFileUrl }) });
        updated++;
      }
    }
    console.log(JSON.stringify({ updated })); return;
  }
  if (group === 'campaign' && action === 'push' && directory) {
    const { campaign, durationSec } = await loadCampaign(directory);
    const result = await request(`/admin/campaigns/${encodeURIComponent(campaign.id)}`, { method: 'PUT', headers: { authorization: `Bearer ${requiredEnv('WORKER_TOKEN')}`, 'content-type': 'application/json' }, body: JSON.stringify({ campaign, durationSec }) });
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (group === 'campaign' && action === 'render-test' && directory) {
    const websiteIndex = args.indexOf('--website'), website = websiteIndex >= 0 ? args[websiteIndex + 1] : undefined;
    if (!website) throw new Error('Usage: campaign render-test <dir> --website <url>');
    const screenshotIndex = args.indexOf('--screenshot'), screenshot = screenshotIndex >= 0 ? args[screenshotIndex + 1] : undefined;
    if (screenshotIndex >= 0 && !screenshot) throw new Error('--screenshot requires a frozen image path inside DATA_DIR');
    const { campaign } = await loadCampaign(directory), dataDir = await dataDirectory();
    const outputDir = path.join(dataDir, 'render-tests', `${campaign.id}-${Date.now()}`);
    ensureDataDirectory(outputDir);
    const variables = Object.fromEntries(campaign.pages.flatMap(page => page.type === 'website' ? [[page.variable, website]] : []));
    const result = await renderCampaign({ campaignDir: directory, variables, dataDir, outputPath: path.join(outputDir, 'video.mp4'), screenshots: screenshot ? { [website]: screenshot } : undefined });
    const screenshots: string[] = [];
    for (let i = 0; i < campaign.pages.length; i++) {
      const page = campaign.pages[i], image = path.join(outputDir, `segment-${i + 1}.png`);
      await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-ss', String((page.start + page.end) / 2), '-i', result.path, '-frames:v', '1', '-update', '1', image]);
      screenshots.push(image);
    }
    const manifest = { ...result, screenshots, outputDir };
    await writeFile(path.join(outputDir, 'render-test.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify(manifest, null, 2)); return;
  }
  if (group === 'worker' && ['run', 'once'].includes(action)) {
    const worker = await workerFromEnvironment(), abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try { if (action === 'once') console.log(JSON.stringify({ claimed: await worker.once() })); else await worker.run(abort.signal); }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); await worker.close(); }
    return;
  }
  if (group === 'webhooks' && action === 'list') {
    const result = await request('/api/public/v1/webhooks', { headers: { 'x-api-key': (process.env.API_KEY || requiredEnv('API_KEYS')).split(',')[0].trim() } });
    console.log(JSON.stringify(result.map((hook: any) => { const url = new URL(hook.webhookUrl); if (url.search) url.search = '?[masked]'; return { ...hook, webhookUrl: url.href }; }), null, 2)); return;
  }
  throw new Error('Usage: campaign push <dir> | campaign render-test <dir> --website <url> | worker run|once | webhooks list | mux backfill-mp4');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
}
