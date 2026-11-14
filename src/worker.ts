import { createReadStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertDeploySecret, type Campaign, ensureDataDirectory, randomId } from './model.js';
import { dataDirectory, loadCampaign, LocalRenderer, RenderError, renderMailGif, Semaphore, videoEncoder, type RenderResult } from './render.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
interface MuxAsset { id: string; status: string; duration?: number; passthrough?: string; playback_ids?: { id: string; policy: string }[]; static_renditions?: { files?: { name?: string; ext?: string; resolution?: string; status?: string }[] } }
interface MuxUpload { id: string; url?: string; status?: string; asset_id?: string; new_asset_settings?: { passthrough?: string } }
interface UploadState { creating?: boolean; uploadId?: string; assetId?: string; staticRequested?: boolean; result?: MuxResult }
export interface MuxResult { muxAssetId: string; playbackId: string; durationSec: number; videoFileUrl: string }
export interface MuxUploadTiming { uploadSec: number; muxSec: number }
export type UploadSlot = <T>(operation: () => Promise<T>) => Promise<T>;

export class MuxClient {
  private auth: string;
  private ledger: string;
  constructor(private options: { baseUrl?: string; tokenId: string; tokenSecret: string; dataDir: string; pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }) {
    this.auth = 'Basic ' + Buffer.from(`${options.tokenId}:${options.tokenSecret}`).toString('base64');
    this.ledger = path.join(options.dataDir, 'mux-ledger');
  }
  private async request(route: string, init: RequestInit = {}): Promise<any> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(`${this.options.baseUrl || 'https://api.mux.com'}/video/v1${route}`, { ...init, headers: { authorization: this.auth, 'content-type': 'application/json', ...init.headers }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      // Ambiguous POST failures must be recovered by passthrough on the next attempt.
      if (response.status === 429 || (response.status >= 500 && init.method !== 'POST')) {
        if (attempt === 5) throw new Error(`mux_http_${response.status}`);
        const after = Number(response.headers.get('retry-after'));
        await (this.options.sleep || pause)(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : Math.min(1000 * 2 ** attempt, 30_000));
        continue;
      }
      if (!response.ok) throw new Error(`mux_http_${response.status}`);
      return await response.json();
    }
  }
  private stateFile(videoId: string): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) throw new Error('Invalid video ID');
    return path.join(this.ledger, `${videoId}.json`);
  }
  private async save(videoId: string, state: UploadState): Promise<void> {
    ensureDataDirectory(this.ledger);
    const file = this.stateFile(videoId), temporary = file + '.tmp';
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, file);
  }
  private async load(videoId: string): Promise<UploadState | undefined> {
    try { return JSON.parse(await readFile(this.stateFile(videoId), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  private async findExisting(videoId: string): Promise<UploadState | undefined> {
    for (const kind of ['assets', 'uploads']) {
      for (let page = 1; ; page++) {
        const rows = (await this.request(`/${kind}?limit=100&page=${page}`)).data;
        if (!Array.isArray(rows)) throw new Error('Invalid Mux list response');
        for (const row of rows) {
          if (kind === 'assets' && row.passthrough === videoId && row.status !== 'errored') return { assetId: row.id };
          if (kind === 'uploads' && row.new_asset_settings?.passthrough === videoId && !['cancelled', 'errored', 'timed_out'].includes(row.status)) return { uploadId: row.id, ...(row.asset_id ? { assetId: row.asset_id } : {}) };
        }
        if (rows.length < 100) break;
      }
    }
  }
  private async ready(state: UploadState, videoId: string): Promise<MuxResult | undefined> {
    if (state.result?.videoFileUrl) return state.result;
    if (!state.assetId) return;
    const asset: MuxAsset = (await this.request(`/assets/${encodeURIComponent(state.assetId)}`)).data;
    if (asset.status === 'errored') { await rm(this.stateFile(videoId), { force: true }); throw new Error('mux_asset_errored'); }
    if (asset.status !== 'ready') return;
    const playback = asset.playback_ids?.find(item => item.policy === 'public')?.id;
    if (!playback || !Number.isFinite(asset.duration) || Number(asset.duration) <= 0) throw new Error('mux_ready_asset_missing_playback');
    const rendition = asset.static_renditions?.files?.find(file => file.resolution === 'highest');
    if (!rendition) {
      if (!state.staticRequested) {
        state.staticRequested = true; await this.save(videoId, state);
        try { await this.request(`/assets/${encodeURIComponent(asset.id)}/static-renditions`, { method: 'POST', body: JSON.stringify({ resolution: 'highest' }) }); }
        catch (error) {
          const status = error instanceof Error ? Number(error.message.match(/^mux_http_(\d+)$/)?.[1]) : NaN;
          if (status >= 400 && status < 500 && status !== 408) {
            state.staticRequested = false; await this.save(videoId, state); throw error;
          }
          // shortcut: unresolved create intents await provider reconciliation; retry creation only after confirming no rendition exists.
        }
      }
      return;
    }
    if (['errored', 'skipped'].includes(rendition.status || '')) throw new Error('mux_mp4_failed');
    if (rendition.status !== 'ready') return;
    if (rendition.ext !== 'mp4' || !/^[A-Za-z0-9_-]+\.mp4$/.test(rendition.name || '')) throw new Error('mux_invalid_mp4_filename');
    const result = { muxAssetId: asset.id, playbackId: playback, durationSec: Number(asset.duration), videoFileUrl: `https://stream.mux.com/${playback}/${rendition.name}` };
    await this.save(videoId, { ...state, result });
    return result;
  }
  async resume(videoId: string): Promise<MuxResult | undefined> {
    let state = await this.load(videoId);
    if (!state) return;
    if (state.creating && !state.uploadId && !state.assetId) {
      const found = await this.findExisting(videoId);
      if (!found) throw new Error('mux_create_ambiguous');
      state = found; await this.save(videoId, found);
    }
    if (!state.assetId && state.uploadId) {
      const upload: MuxUpload = (await this.request(`/uploads/${encodeURIComponent(state.uploadId)}`)).data;
      if (['cancelled', 'errored', 'timed_out'].includes(upload.status || '')) { await rm(this.stateFile(videoId), { force: true }); throw new Error('mux_upload_failed'); }
      if (upload.asset_id) { state.assetId = upload.asset_id; await this.save(videoId, state); }
    }
    if (!state.assetId) return;
    const started = Date.now();
    for (;;) {
      const result = await this.ready(state, videoId);
      if (result) return result;
      if (Date.now() - started > (this.options.timeoutMs ?? 20 * 60_000)) throw new Error('mux_ready_timeout');
      await (this.options.sleep || pause)(this.options.pollMs ?? 2000);
    }
  }
  async backfill(videoId: string, assetId: string, playbackId: string): Promise<MuxResult> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(assetId)) throw new Error('mux_invalid_asset_id');
    const saved = await this.load(videoId);
    const state: UploadState = { assetId, ...(saved?.assetId === assetId && saved.staticRequested ? { staticRequested: true } : {}) };
    const started = Date.now();
    for (;;) {
      const result = await this.ready(state, videoId);
      if (result) {
        if (result.playbackId !== playbackId) throw new Error('mux_playback_mismatch');
        return result;
      }
      if (Date.now() - started > (this.options.timeoutMs ?? 20 * 60_000)) throw new Error('mux_ready_timeout');
      await (this.options.sleep || pause)(this.options.pollMs ?? 2000);
    }
  }
  async upload(videoId: string, file: string, withUploadSlot: UploadSlot = operation => operation(), timing?: MuxUploadTiming): Promise<MuxResult> {
    const wallStart = performance.now();
    let putMs = 0, putEnd = 0;
    let state = await this.load(videoId);
    if (state?.creating && !state.uploadId && !state.assetId) {
      // shortcut: unmatched ambiguous Mux creates are held for manual reconciliation; replace only with documented provider idempotency support.
      const found = await this.findExisting(videoId);
      if (!found) throw new Error('mux_create_ambiguous');
      state = found;
    }
    if (!state?.uploadId && !state?.assetId) {
      state = await withUploadSlot(async () => {
        await this.save(videoId, { creating: true });
        // A persisted intent lets a restart recover the POST/ledger boundary by passthrough.
        const response = await this.request('/uploads', { method: 'POST', body: JSON.stringify({ new_asset_settings: { video_quality: 'basic', playback_policies: ['public'], max_resolution_tier: '1080p', passthrough: videoId, static_renditions: [{ resolution: 'highest' }] }, timeout: 3600 }) });
        const created = { uploadId: response.data.id, staticRequested: true };
        if (!created.uploadId) throw new Error('mux_upload_missing_id');
        await this.save(videoId, created);
        return created;
      });
    }
    const started = Date.now();
    let sent = false;
    for (;;) {
      const result = await this.ready(state, videoId);
      if (result) {
        if (timing) {
          const now = performance.now();
          timing.uploadSec = putMs / 1000;
          timing.muxSec = (now - (putEnd || wallStart)) / 1000;
        }
        return result;
      }
      if (!state.assetId) {
        const upload: MuxUpload = (await this.request(`/uploads/${encodeURIComponent(state.uploadId!)}`)).data;
        if (upload.asset_id) { state.assetId = upload.asset_id; await this.save(videoId, state); continue; }
        if (['cancelled', 'errored', 'timed_out'].includes(upload.status || '')) { await rm(this.stateFile(videoId), { force: true }); throw new Error('mux_upload_failed'); }
        if (upload.url && !sent) {
          const url = new URL(upload.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('mux_invalid_upload_url');
          await withUploadSlot(async () => {
            const putStart = performance.now();
            const response = await fetch(url, { method: 'PUT', body: createReadStream(file) as unknown as BodyInit, duplex: 'half', redirect: 'manual', signal: AbortSignal.timeout(20 * 60_000) } as RequestInit);
            await response.body?.cancel();
            putMs += performance.now() - putStart; putEnd = performance.now();
            if (!response.ok) throw new Error(`mux_upload_http_${response.status}`);
          });
          sent = true;
        }
      }
      if (Date.now() - started > (this.options.timeoutMs ?? 20 * 60_000)) throw new Error('mux_ready_timeout');
      await (this.options.sleep || pause)(this.options.pollMs ?? 2000);
    }
  }
}

export interface WorkerJob { id: string; campaignId: string; variables: Record<string, unknown>; campaign: Campaign; leaseToken: string }
interface Renderer { render(options: { campaignDir: string; variables: Record<string, unknown>; outputPath?: string }): Promise<RenderResult>; close?(): Promise<void> }
export interface WorkerOptions { serverUrl: string; workerToken: string; campaignsDir: string; dataDir: string; renderParallel?: number; screenshotParallel?: number; uploadParallel?: number; batchSize?: number; keepOutput?: boolean; mux: Pick<MuxClient, 'resume' | 'upload'>; renderer?: Renderer; log?: (message: string) => void }
class WorkerEnvironmentError extends Error {}

export class Worker {
  private renderer: Renderer;
  private uploads: Semaphore;
  private claimsPausedUntil = 0;
  constructor(private options: WorkerOptions) {
    ensureDataDirectory(options.dataDir); ensureDataDirectory(path.join(options.dataDir, 'worker-output'));
    this.renderer = options.renderer || new LocalRenderer(options.dataDir, options.renderParallel ?? 2, options.screenshotParallel ?? 3);
    this.uploads = new Semaphore(options.uploadParallel ?? 3);
  }
  private async server(route: string, body: unknown): Promise<any> {
    const response = await fetch(this.options.serverUrl.replace(/\/$/, '') + route, { method: 'POST', headers: { authorization: `Bearer ${this.options.workerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'manual' });
    if (!response.ok) throw new Error(`worker_http_${response.status}`);
    return await response.json();
  }
  private async process(job: WorkerJob): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(job.id)) { this.options.log?.('invalid job id'); return; }
    const started = performance.now();
    let output = path.join(this.options.dataDir, 'worker-output', `${job.id}.mp4`);
    const captureFile = output + '.capture.json';
    let captureSec: number | null = null, encodeSec: number | null = null, uploadSec: number | null = null, muxSec: number | null = null, fileBytes: number | null = null;
    try {
      try {
        ensureDataDirectory(this.options.dataDir); ensureDataDirectory(path.dirname(output));
        const writable = output + '.' + randomId(8) + '.writable';
        await writeFile(writable, '', { flag: 'wx', mode: 0o600 }); await rm(writable);
      } catch { throw new WorkerEnvironmentError('worker_data_unavailable'); }
      let result = await this.options.mux.resume(job.id);
      let backgroundRecordedAt: string;
      if (!result) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(job.campaignId)) throw new Error('invalid_campaign_id');
        const campaignDir = path.join(this.options.campaignsDir, job.campaignId);
        let campaign: Campaign;
        try {
          ({ campaign } = await loadCampaign(campaignDir));
        } catch { throw new WorkerEnvironmentError('worker_environment_unavailable'); }
        // Ignore server timestamps while refusing to render stale local campaign assets/settings.
        const { createdAt: _localDate, archived: _localArchived, ...local } = campaign;
        const { createdAt: _remoteDate, archived: _remoteArchived, durationSec: _remoteDuration, ...remote } = job.campaign as Campaign & { durationSec?: number };
        if (!isDeepStrictEqual(local, remote)) throw new WorkerEnvironmentError('campaign_template_mismatch');
        const rendered = await this.renderer.render({ campaignDir, variables: job.variables, outputPath: output });
        output = rendered.path;
        backgroundRecordedAt = rendered.backgroundRecordedAt;
        captureSec = rendered.captureSec; encodeSec = rendered.encodeSec;
        fileBytes = (await stat(rendered.path)).size;
        await writeFile(captureFile + '.tmp', JSON.stringify({ backgroundRecordedAt }), { mode: 0o600 });
        await rename(captureFile + '.tmp', captureFile);
        const gifPath = rendered.path + '.gif';
        try {
          await renderMailGif(rendered.path, gifPath);
          await this.server(`/worker/${encodeURIComponent(job.id)}/gif`, { gif: (await readFile(gifPath)).toString('base64'), leaseToken: job.leaseToken });
        } catch {
          this.options.log?.(JSON.stringify({ event: 'gif_failed', id: job.id }));
        } finally {
          await rm(gifPath, { force: true });
        }
        const timing: MuxUploadTiming = { uploadSec: 0, muxSec: 0 };
        result = await this.options.mux.upload(job.id, rendered.path, operation => this.uploads.run(operation), timing);
        uploadSec = timing.uploadSec; muxSec = timing.muxSec;
      } else {
        // shortcut: uploads predating capture metadata need manual reconciliation; never invent their recording time.
        try { ({ backgroundRecordedAt } = JSON.parse(await readFile(captureFile, 'utf8'))); }
        catch { throw new WorkerEnvironmentError('worker_missing_capture_time'); }
      }
      if (typeof backgroundRecordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(backgroundRecordedAt) || !Number.isFinite(Date.parse(backgroundRecordedAt)) || new Date(backgroundRecordedAt).toISOString() !== backgroundRecordedAt) throw new WorkerEnvironmentError('worker_missing_capture_time');
      await this.server(`/worker/${encodeURIComponent(job.id)}/complete`, { ...result, backgroundRecordedAt, leaseToken: job.leaseToken });
      await rm(captureFile, { force: true });
      if (output && !this.options.keepOutput) await rm(output, { force: true });
      this.options.log?.(JSON.stringify({ event: 'video_completed', id: job.id, campaignId: job.campaignId, captureSec, encodeSec, uploadSec, muxSec, totalSec: (performance.now() - started) / 1000, fileBytes }));
    } catch (error) {
      if (error instanceof WorkerEnvironmentError) {
        this.claimsPausedUntil = Date.now() + 60_000;
        try { await this.server(`/worker/${encodeURIComponent(job.id)}/release`, { leaseToken: job.leaseToken }); }
        catch { this.options.log?.(`lease release deferred ${job.id}`); }
        this.options.log?.(`environment unavailable ${job.id}: ${error.message}; claims paused 60s`);
        return;
      }
      const reason = error instanceof RenderError ? error.reason : error instanceof Error && /^[a-z_]+(?:_[0-9]+)?$/.test(error.message) ? error.message : 'worker_error';
      try { await this.server(`/worker/${encodeURIComponent(job.id)}/fail`, { reason, leaseToken: job.leaseToken }); }
      catch { this.options.log?.(`lease completion deferred ${job.id}`); }
      this.options.log?.(JSON.stringify({ event: 'video_failed', id: job.id, campaignId: job.campaignId, reason, totalSec: (performance.now() - started) / 1000 }));
      if (!this.options.keepOutput) await rm(output, { force: true });
    }
  }
  private async claim(limit: number): Promise<WorkerJob[]> {
    if (Date.now() < this.claimsPausedUntil) return [];
    const response = await this.server('/worker/claim', { limit });
    const jobs: WorkerJob[] = Array.isArray(response) ? response : response.jobs;
    if (!Array.isArray(jobs) || jobs.length > limit) throw new Error('invalid_claim_response');
    return jobs;
  }
  async once(): Promise<number> {
    const jobs = await this.claim(this.options.batchSize ?? 8);
    await Promise.allSettled(jobs.map(job => this.process(job)));
    return jobs.length;
  }
  async run(signal?: AbortSignal): Promise<void> {
    const active = new Set<Promise<void>>(), limit = this.options.batchSize ?? 8;
    const wait = (ms: number) => new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      for (const job of active) void job.then(done, done);
      if (signal?.aborted) done();
    });
    try {
      while (!signal?.aborted) {
        try {
          if (active.size < limit) {
            const jobs = await this.claim(limit - active.size);
            for (const job of jobs) {
              const pending = this.process(job).catch(() => { this.options.log?.(`job cleanup deferred ${job.id}`); }).finally(() => { active.delete(pending); });
              active.add(pending);
            }
            if (jobs.length && active.size < limit) continue;
          }
          // Any completion opens capacity immediately, including while other assets still process.
          await wait(3000);
        } catch { this.options.log?.('claim unavailable; retrying'); await wait(5000); }
      }
    } finally {
      await Promise.allSettled(active);
    }
  }
  async close(): Promise<void> { await this.renderer.close?.(); }
}

export async function workerFromEnvironment(): Promise<Worker> {
  videoEncoder();
  const dataDir = await dataDirectory();
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
  const number = (name: string, fallback: number) => { const value = Number(process.env[name] || fallback); if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error(`Invalid ${name}`); return value; };
  const workerToken = required('WORKER_TOKEN'); assertDeploySecret('WORKER_TOKEN', workerToken);
  return new Worker({ dataDir, serverUrl: required('SERVER_URL'), workerToken, campaignsDir: required('CAMPAIGNS_DIR'), renderParallel: number('RENDER_PARALLEL', 2), screenshotParallel: number('SCREENSHOT_PARALLEL', 3), uploadParallel: number('UPLOAD_PARALLEL', 3), batchSize: number('WORKER_BATCH_SIZE', 8), keepOutput: process.env.KEEP_OUTPUT === '1', mux: new MuxClient({ dataDir, tokenId: required('MUX_TOKEN_ID'), tokenSecret: required('MUX_TOKEN_SECRET'), baseUrl: process.env.MUX_BASE_URL }), log: console.log });
}
