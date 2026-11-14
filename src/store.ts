import Database from 'better-sqlite3';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Campaign, deriveSchema, ensureDataDirectory, escapeHtml, interpolate, randomId, safeHttpUrl, validateCampaign, videoBaseUrl } from './model.js';

export const TRIGGERS = ['VIDEO_CREATED', 'VIDEO_RENDERED', 'VIDEO_RENDERED_FULLY', 'VIDEO_UNRENDERABLE', 'VIDEO_VIEWED', 'VIDEO_FIRST_VIEWED', 'VIDEO_STARTED', 'VIDEO_FIRST_STARTED', 'VIDEO_FINISHED', 'VIDEO_FIRST_FINISHED'] as const;
export type Trigger = typeof TRIGGERS[number];
export class HttpError extends Error {
  constructor(public status: number, public body: any) { super(body.message ?? body.error ?? 'Invalid request'); }
}
export type StoredVideo = Record<string, any> & { id: string; shortId: string; campaignId: string; variables: Record<string, any>; originalRow: Record<string, any> | string; status: string };
const LEASE_MS = 30 * 60_000;
const RETENTION_MS = 90 * 24 * 60 * 60_000;
const RETRIES = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
const VIDEO_STATUSES = ['created', 'queued', 'rendering', 'rendered', 'failed', 'cancelled', 'deferred'];
export const dispatchEnabled = () => process.env.DISPATCH_ENABLED !== '0';
export const deferredRetryCampaigns = () => new Set((process.env.DEFERRED_RETRY_CAMPAIGNS ?? '').split(',').map(id => id.trim()).filter(Boolean));
const DAY_MS = 24 * 60 * 60_000;
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const VIDEO_METADATA = ['originalData', 'originalRow', 'originalRowIndex', 'originalUid'];
const withoutVideoMetadata = (variables: Record<string, any>) => Object.fromEntries(Object.entries(variables).filter(([key]) => !VIDEO_METADATA.includes(key)));
export function maskUrl(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = url.search ? '?REDACTED' : ''; url.hash = ''; return url.toString(); }
  catch { return '[invalid URL]'; }
}

export const MUX_GIF_PARAMS = 'animated.gif?start=0&end=5&width=448&fps=2';

export class Store {
  public db: Database.Database;
  private now: () => number;
  private dataDir: string;
  private publicBaseUrl: string;
  constructor({ dataDir, publicBaseUrl, now = Date.now }: { dataDir: string; publicBaseUrl: string; now?: () => number }) {
    dataDir = ensureDataDirectory(dataDir);
    this.dataDir = dataDir;
    this.db = new Database(join(dataDir, 'ac-video.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.function('platform_lower', { deterministic: true }, (value: unknown) => typeof value === 'string' ? value.toLowerCase() : '');
    this.now = now;
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, data TEXT NOT NULL, duration_sec REAL NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, short_id TEXT UNIQUE NOT NULL, campaign_id TEXT NOT NULL REFERENCES campaigns(id), data TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, lease_token TEXT, created_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS videos_queue ON videos(status, created_ms);
      CREATE TABLE IF NOT EXISTS video_identifiers (campaign_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, video_id TEXT NOT NULL REFERENCES videos(id), PRIMARY KEY(campaign_id, field, value));
      CREATE INDEX IF NOT EXISTS identifiers_video ON video_identifiers(video_id);
      CREATE TABLE IF NOT EXISTS imports (campaign_id TEXT NOT NULL REFERENCES campaigns(id), import_id TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(campaign_id, import_id));
      CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, trigger TEXT NOT NULL, target_url TEXT NOT NULL, campaign_id TEXT REFERENCES campaigns(id), created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS unique_hooks ON webhooks(trigger, target_url, coalesce(campaign_id, ''));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), trigger TEXT NOT NULL, event_at INTEGER NOT NULL, session TEXT, payload TEXT);
      CREATE INDEX IF NOT EXISTS events_tracking ON events(video_id, trigger, session, event_at);
      CREATE INDEX IF NOT EXISTS events_retention ON events(event_at);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), webhook_id TEXT NOT NULL, target_url TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, locked_until INTEGER, last_error TEXT, UNIQUE(event_id, webhook_id));
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state, next_at);
      CREATE INDEX IF NOT EXISTS outbox_event ON outbox(event_id);
      CREATE TABLE IF NOT EXISTS worker_activity (id INTEGER PRIMARY KEY CHECK(id=1), last_claim_at TEXT, last_complete_at TEXT);
      INSERT OR IGNORE INTO worker_activity(id) VALUES(1);
    `);
    const legacyOutbox = (this.db.pragma('table_info(outbox)') as any[]).some(column => column.name === 'payload');
    const outboxHasStatus = (this.db.pragma('table_info(outbox)') as any[]).some(column => column.name === 'last_status');
    const legacyEvents = (this.db.pragma('table_info(events)') as any[]).some(column => column.name === 'payload' && column.notnull);
    if (legacyOutbox || legacyEvents) {
      try {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE events_migrating (id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), trigger TEXT NOT NULL, event_at INTEGER NOT NULL, session TEXT, payload TEXT);
            INSERT INTO events_migrating SELECT id,video_id,trigger,event_at,session,${legacyOutbox ? "coalesce(nullif(payload,''),(SELECT nullif(o.payload,'') FROM outbox o WHERE o.event_id=events.id AND o.payload<>'' LIMIT 1))" : 'payload'} FROM events;
            CREATE TABLE outbox_migrating (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events_migrating(id), webhook_id TEXT NOT NULL, target_url TEXT NOT NULL,
              state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, locked_until INTEGER, last_error TEXT, last_status INTEGER, UNIQUE(event_id, webhook_id));
            INSERT INTO outbox_migrating SELECT id,event_id,webhook_id,target_url,state,attempts,next_at,locked_until,last_error,${outboxHasStatus ? 'last_status' : 'NULL'} FROM outbox;
          `);
          if (this.db.prepare("SELECT 1 FROM outbox_migrating o JOIN events_migrating e ON e.id=o.event_id WHERE o.state IN ('pending','sending') AND (e.payload IS NULL OR e.payload='') LIMIT 1").get()) throw Error('Pending webhook payload is missing; migration cancelled');
          this.db.exec(`
            DROP TABLE outbox;
            DROP TABLE events;
            ALTER TABLE events_migrating RENAME TO events;
            ALTER TABLE outbox_migrating RENAME TO outbox;
            CREATE INDEX events_tracking ON events(video_id, trigger, session, event_at);
            CREATE INDEX events_retention ON events(event_at);
            CREATE INDEX outbox_due ON outbox(state, next_at);
            CREATE INDEX outbox_event ON outbox(event_id);
          `);
        })();
      } catch (error) { this.db.close(); throw error; }
    }
    if (!(this.db.pragma('table_info(outbox)') as any[]).some(column => column.name === 'last_status')) this.db.exec('ALTER TABLE outbox ADD COLUMN last_status INTEGER');
    if (!(this.db.pragma('table_info(webhooks)') as any[]).some(column => column.name === 'last_error_at')) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE webhooks ADD COLUMN last_error_at INTEGER; ALTER TABLE webhooks ADD COLUMN last_error_code TEXT;');
        // Existing delivery timestamps are recoverable from the persisted retry schedule.
        const errors = this.db.prepare('SELECT webhook_id,attempts,next_at FROM outbox WHERE last_error IS NOT NULL AND attempts>0').all() as any[];
        const update = this.db.prepare("UPDATE webhooks SET last_error_at=?,last_error_code='delivery_failed' WHERE id=? AND (last_error_at IS NULL OR last_error_at<?)");
        for (const row of errors) { const at = row.next_at - (RETRIES[row.attempts - 1] ?? 0); update.run(at, row.webhook_id, at); }
      })();
    }
  }
  close() { this.db.close(); }
  campaignPut(template: Campaign, durationSec: number): Campaign {
    try { validateCampaign(template, durationSec); }
    catch (error) { throw new HttpError(400, { errors: [(error as Error).message] }); }
    const existing: any = this.db.prepare('SELECT created_at FROM campaigns WHERE id=?').get(template.id);
    const campaign = { ...clone(template), createdAt: existing?.created_at ?? template.createdAt ?? new Date(this.now()).toISOString(), durationSec };
    this.db.prepare('INSERT INTO campaigns(id,data,duration_sec,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,duration_sec=excluded.duration_sec')
      .run(campaign.id, JSON.stringify(campaign), durationSec, campaign.createdAt);
    return campaign;
  }
  campaign(id: string): Campaign & { durationSec: number } {
    const row: any = this.db.prepare('SELECT data FROM campaigns WHERE id=?').get(id);
    if (!row) throw new HttpError(404, { message: 'Campaign not found' });
    return JSON.parse(row.data);
  }
  campaigns() {
    return (this.db.prepare('SELECT data FROM campaigns ORDER BY created_at,id').all() as any[]).map(row => {
      const c = JSON.parse(row.data); const variableSchema = deriveSchema(c);
      return { id: c.id, name: c.name, createdAt: c.createdAt, variableSchema, examplePayload: this.examples(variableSchema) };
    });
  }
  private platformCampaignRow(campaign: Campaign & { durationSec: number }) {
    const counts: any = this.db.prepare(`SELECT count(*) total,coalesce(sum(status='created'),0) created,coalesce(sum(status='queued'),0) queued,
      coalesce(sum(status='rendering'),0) rendering,coalesce(sum(status='rendered'),0) rendered,coalesce(sum(status='failed'),0) failed,
      coalesce(sum(status='cancelled'),0) cancelled,coalesce(sum(status='deferred'),0) deferred,coalesce(sum(status='expired'),0) expired FROM videos WHERE campaign_id=?`).get(campaign.id);
    return { id: campaign.id, name: campaign.name, createdAt: campaign.createdAt, domain: campaign.domain ?? null, durationSec: campaign.durationSec, pageCount: campaign.pages.length, counts };
  }
  platformCampaigns() {
    return (this.db.prepare('SELECT data FROM campaigns ORDER BY created_at,id').all() as any[]).map(row => this.platformCampaignRow(JSON.parse(row.data)));
  }
  platformCampaign(id: string) {
    const campaign = this.campaign(id);
    const landing = Object.fromEntries(['title', 'text', 'ctaLabel', 'ctaUrl', 'calendlyEmbedUrl', 'logoUrl', 'brandColor', 'imprintUrl', 'privacyUrl',
      'backgroundColor', 'textColor', 'ctaColor', 'ctaTextColor', 'creatorNameColor', 'creatorName'].filter(key => key in campaign.landing).map(key => [key, (campaign.landing as any)[key]]));
    for (const key of ['ctaUrl', 'calendlyEmbedUrl', 'logoUrl', 'imprintUrl', 'privacyUrl']) if (landing[key]) {
      const url = new URL(landing[key]); url.search = ''; url.hash = ''; landing[key] = url.toString();
    }
    return { ...this.platformCampaignRow(campaign), variableSchema: deriveSchema(campaign), leadSchemaMapping: clone(campaign.leadSchemaMapping ?? {}), landing };
  }
  private examples(schema: Record<string, any>) {
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, value.validator?.type === 'url' ? 'https://example.com' : 'exampledata']));
  }
  schema(id: string, kind: 'schema' | 'schemas' | 'lead-schema-mapping' = 'schemas') {
    const c = this.campaign(id); const variableSchema = deriveSchema(c); const example = this.examples(variableSchema);
    if (kind === 'schema') return { variableSchema, examplePayload: example };
    if (!object(c.leadSchemaMapping)) throw new HttpError(404, { message: 'Lead schema not found' });
    const leadSchemaMapping = c.leadSchemaMapping;
    const exampleLeadSchemaMappingPayload: Record<string, string> = {};
    for (const [key, source] of Object.entries(leadSchemaMapping)) {
      // Preserve Pitchlane's literal "null" example key for explicitly unmapped fields.
      exampleLeadSchemaMappingPayload[String(source)] = /website|linkedin/i.test(key) ? 'https://www.example.com' : key === 'email' ? 'example@example.com' : /name/i.test(key) ? 'Name' : 'exampleData';
    }
    if (kind === 'lead-schema-mapping') return { leadSchemaMapping, examplePayload: exampleLeadSchemaMappingPayload };
    return { variableSchema, exampleVariableSchemaPayload: example, leadSchemaMapping, exampleLeadSchemaMappingPayload };
  }
  private rowVideo(row: any): StoredVideo | undefined {
    if (!row) return undefined;
    return { ...JSON.parse(row.data), status: row.status, attempts: row.attempts };
  }
  getVideo(shortId: string): StoredVideo | undefined { return this.rowVideo(this.db.prepare('SELECT * FROM videos WHERE short_id=?').get(shortId)); }
  video(id: string): StoredVideo {
    const video = this.rowVideo(this.db.prepare('SELECT * FROM videos WHERE id=?').get(id));
    if (!video) throw new HttpError(404, { message: 'Video not found' });
    return video;
  }
  private platformVideoRow(video: StoredVideo) {
    const document = this.publicVideo(video, true);
    const row: any = this.db.prepare(`SELECT coalesce(sum(trigger='VIDEO_VIEWED'),0) views,coalesce(sum(trigger='VIDEO_STARTED'),0) starts,
      coalesce(sum(trigger='VIDEO_FINISHED'),0) finishes,min(CASE WHEN trigger='VIDEO_VIEWED' THEN event_at END) firstViewedAt,
      max(CASE WHEN trigger='VIDEO_VIEWED' THEN event_at END) lastViewedAt FROM events WHERE video_id=?`).get(video.id);
    const text = (...keys: string[]) => { for (const key of keys) if (typeof video.variables[key] === 'string') return video.variables[key]; return null; };
    return { id: video.id, shortId: video.shortId, title: video.title, status: video.status, renderingStatus: document.renderingStatus, attempts: video.attempts,
      failureReason: video.status !== 'rendered' && ['website_unreachable', 'render_failed'].includes(video.failureReason) ? video.failureReason : null,
      createdAt: video.createdAt, queuedAt: video.queuedAt ?? null, renderedAt: video.renderedAt ?? null,
      email: text('email'), firstName: text('first_name', 'firstName'), companyName: text('company_name', 'companyName'), website: text('website'),
      videoUrl: document.videoUrl, thumbnailUrl: document.thumbnailUrl, thumbnailEmbed: document.thumbnailEmbed,
      stats: { views: row.views, starts: row.starts, finishes: row.finishes, firstViewedAt: row.firstViewedAt === null ? null : new Date(row.firstViewedAt).toISOString(), lastViewedAt: row.lastViewedAt === null ? null : new Date(row.lastViewedAt).toISOString() } };
  }
  platformVideos(campaignId: string, { limit = 100, offset = 0, status, q }: { limit?: number; offset?: number; status?: string; q?: string } = {}) {
    this.campaign(campaignId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || (status !== undefined && !VIDEO_STATUSES.includes(status)) || (q !== undefined && typeof q !== 'string')) throw new HttpError(400, { errors: ['Invalid video filter or pagination'] });
    const clauses = ['campaign_id=?']; const values: any[] = [campaignId];
    if (status !== undefined) { clauses.push('status=?'); values.push(status); }
    if (q) {
      clauses.push(`(${['email', 'company_name', 'companyName', 'first_name', 'firstName', 'last_name', 'lastName', 'name'].map(key => `instr(platform_lower(json_extract(data,'$.variables.${key}')),?)>0`).join(' OR ')})`);
      values.push(...Array(8).fill(q.toLowerCase()));
    }
    const where = clauses.join(' AND ');
    const count = (this.db.prepare(`SELECT count(*) n FROM videos WHERE ${where}`).get(...values) as any).n;
    const rows = this.db.prepare(`SELECT * FROM videos WHERE ${where} ORDER BY created_ms,id LIMIT ? OFFSET ?`).all(...values, limit, offset) as any[];
    return { count, videos: rows.map(row => this.platformVideoRow(this.rowVideo(row)!)) };
  }
  platformVideo(campaignId: string, videoId: string) {
    this.campaign(campaignId); const video = this.video(videoId);
    if (video.campaignId !== campaignId) throw new HttpError(404, { message: 'Video not found' });
    const events = (this.db.prepare('SELECT trigger,event_at FROM events WHERE video_id=? ORDER BY event_at DESC,rowid DESC LIMIT 50').all(video.id) as any[])
      .map(row => ({ trigger: row.trigger, at: new Date(row.event_at).toISOString() }));
    return { ...this.platformVideoRow(video), variables: clone(video.variables), events };
  }
  platformStats(campaignId: string, { from, to }: { from?: string; to?: string } = {}) {
    this.campaign(campaignId);
    const day = (value: string | undefined, fallback: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, { errors: ['Statistics dates must use YYYY-MM-DD'] });
      const timestamp = Date.parse(`${value}T00:00:00.000Z`);
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new HttpError(400, { errors: ['Invalid statistics date'] });
      return timestamp;
    };
    const end = day(to, Math.floor(this.now() / DAY_MS) * DAY_MS); const start = day(from, end - 29 * DAY_MS);
    if (start > end || (end - start) / DAY_MS + 1 > 366) throw new HttpError(400, { errors: ['Statistics window must contain 1 to 366 UTC days'] });
    const videos: any = this.db.prepare("SELECT count(*) total,coalesce(sum(status='rendered'),0) rendered,coalesce(sum(status='cancelled'),0) cancelled,coalesce(sum(status='deferred'),0) deferred FROM videos WHERE campaign_id=?").get(campaignId);
    const rows = this.db.prepare(`SELECT e.trigger,strftime('%Y-%m-%d',e.event_at / 1000,'unixepoch') date,count(*) n
      FROM events e JOIN videos v ON v.id=e.video_id WHERE v.campaign_id=? AND e.event_at>=? AND e.event_at<?
      AND e.trigger IN ('VIDEO_VIEWED','VIDEO_STARTED','VIDEO_FINISHED') GROUP BY e.trigger,date ORDER BY date`).all(campaignId, start, end + DAY_MS) as any[];
    const unique: any = this.db.prepare(`SELECT count(DISTINCT CASE WHEN e.trigger='VIDEO_VIEWED' THEN e.video_id END) viewed,
      count(DISTINCT CASE WHEN e.trigger='VIDEO_STARTED' THEN e.video_id END) started,count(DISTINCT CASE WHEN e.trigger='VIDEO_FINISHED' THEN e.video_id END) finished
      FROM events e JOIN videos v ON v.id=e.video_id WHERE v.campaign_id=? AND e.event_at>=? AND e.event_at<?`).get(campaignId, start, end + DAY_MS);
    const events = { VIDEO_VIEWED: 0, VIDEO_STARTED: 0, VIDEO_FINISHED: 0 };
    const daily = Array.from({ length: (end - start) / DAY_MS + 1 }, (_, index) => ({ date: new Date(start + index * DAY_MS).toISOString().slice(0, 10), views: 0, starts: 0, finishes: 0 }));
    const days = new Map(daily.map(row => [row.date, row]));
    for (const row of rows) { events[row.trigger as keyof typeof events] += row.n; const target = days.get(row.date)!; target[row.trigger === 'VIDEO_VIEWED' ? 'views' : row.trigger === 'VIDEO_STARTED' ? 'starts' : 'finishes'] += row.n; }
    return { from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10), videos, events, uniqueVideos: unique, daily };
  }
  retryVideo(campaignId: string, videoId: string) {
    this.campaign(campaignId);
    return this.db.transaction(() => {
      const row: any = this.db.prepare('SELECT * FROM videos WHERE id=? AND campaign_id=?').get(videoId, campaignId);
      if (!row) throw new HttpError(404, { message: 'Video not found' });
      const video = this.rowVideo(row)!;
      if (row.lease_until > this.now()) throw new HttpError(409, { message: 'Video has an active lease' });
      if (row.status !== 'queued') {
        if (row.status !== 'failed' && row.status !== 'deferred' && !(row.status === 'created' && !video.queuedAt)) throw new HttpError(409, { message: 'Only failed, deferred or unqueued created videos can be retried' });
        const at = new Date(this.now()).toISOString();
        Object.assign(video, { status: 'queued', attempts: 0, queuedAt: at, queuedForRenderingAt: at, failureReason: null });
        delete video.deferredAt;
        this.db.prepare("UPDATE videos SET status='queued',attempts=0,lease_until=NULL,lease_token=NULL,data=? WHERE id=?").run(JSON.stringify(video), video.id);
      }
      return { id: video.id, status: video.status, attempts: video.attempts, queuedAt: video.queuedAt ?? null };
    })();
  }
  cancelVideo(campaignId: string, videoId: string) {
    this.campaign(campaignId);
    return this.db.transaction(() => {
      const row: any = this.db.prepare('SELECT * FROM videos WHERE id=? AND campaign_id=?').get(videoId, campaignId);
      if (!row) throw new HttpError(404, { message: 'Video not found' });
      if (row.lease_until > this.now()) throw new HttpError(409, { message: 'Video has an active lease' });
      if (!['created', 'queued', 'deferred', 'cancelled'].includes(row.status)) throw new HttpError(409, { message: 'Only created, queued or deferred videos can be cancelled' });
      if (row.status !== 'cancelled') {
        const video = this.rowVideo(row)!; video.status = 'cancelled';
        this.db.prepare("UPDATE videos SET status='cancelled',data=?,lease_until=NULL,lease_token=NULL WHERE id=?").run(JSON.stringify(video), videoId);
      }
      return { id: videoId, status: 'cancelled' };
    })();
  }
  releaseDeferredVideos(campaignId: string, limit: number) {
    this.campaign(campaignId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, { errors: ['limit must be between 1 and 50'] });
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM videos WHERE campaign_id=? AND status='deferred' ORDER BY json_extract(data,'$.deferredAt'),created_ms,id LIMIT ?").all(campaignId, limit) as any[];
      const at = new Date(this.now()).toISOString();
      const update = this.db.prepare("UPDATE videos SET status='queued',attempts=2,lease_until=NULL,lease_token=NULL,data=? WHERE id=?");
      for (const row of rows) {
        const video = this.rowVideo(row)!;
        Object.assign(video, { status: 'queued', attempts: 2, queuedAt: at, queuedForRenderingAt: at, deferredRetryAt: at });
        update.run(JSON.stringify(video), row.id);
      }
      const remaining = (this.db.prepare("SELECT count(*) n FROM videos WHERE campaign_id=? AND status='deferred'").get(campaignId) as any).n;
      return { released: rows.length, remaining };
    })();
  }
  private shouldDefer(video: StoredVideo, reason: string): boolean {
    return reason !== 'website_unreachable' && !video.deferredRetryAt && deferredRetryCampaigns().has(video.campaignId);
  }
  platformOps() {
    const queue: any = this.db.prepare(`SELECT coalesce(sum(status='created'),0) created,coalesce(sum(status='queued'),0) queued,
      coalesce(sum(status='rendering'),0) rendering,coalesce(sum(status='failed'),0) failed,coalesce(sum(status='cancelled'),0) cancelled,
      coalesce(sum(status='deferred'),0) deferred,coalesce(sum(status='expired'),0) expired,
      min(CASE WHEN status='created' THEN json_extract(data,'$.createdAt') END) oldestCreatedAt,
      min(CASE WHEN status='queued' THEN json_extract(data,'$.queuedAt') END) oldestQueuedAt,
      min(CASE WHEN status='deferred' THEN json_extract(data,'$.deferredAt') END) oldestDeferredAt FROM videos`).get();
    const activity: any = this.db.prepare('SELECT last_claim_at lastClaimAt,last_complete_at lastCompleteAt FROM worker_activity WHERE id=1').get();
    const outbox: any = this.db.prepare(`SELECT coalesce(sum(o.state IN ('pending','sending')),0) pending,coalesce(sum(o.state='dead'),0) dead,
      coalesce(sum(o.state='rejected'),0) rejected,min(CASE WHEN o.state IN ('pending','sending') THEN e.event_at END) oldestPendingAt
      FROM outbox o JOIN events e ON e.id=o.event_id`).get();
    if (outbox.oldestPendingAt !== null) outbox.oldestPendingAt = new Date(outbox.oldestPendingAt).toISOString();
    return { queue, worker: activity, outbox, dispatchEnabled: dispatchEnabled() };
  }
  listVideos(campaignId: string, limit = 100, offset = 0) {
    this.campaign(campaignId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) throw new HttpError(400, { errors: ['Invalid pagination'] });
    const counts: any = this.db.prepare("SELECT count(*) AS count, coalesce(sum(status='rendered'),0) AS renderedCount, coalesce(sum(status='cancelled'),0) AS cancelledCount FROM videos WHERE campaign_id=?").get(campaignId);
    const videos = (this.db.prepare('SELECT * FROM videos WHERE campaign_id=? ORDER BY created_ms,id LIMIT ? OFFSET ?').all(campaignId, limit, offset) as any[]).map(row => {
      const video = this.rowVideo(row)!;
      return this.publicVideo(video, video.status === 'rendered', true);
    });
    return { ...counts, videos };
  }
  private variables(campaign: Campaign, row: Record<string, any>) {
    const variables = clone(row);
    for (const [key, source] of Object.entries(campaign.leadSchemaMapping ?? {})) {
      if (typeof source === 'string' && variables[key] == null && row[source] != null) variables[key] = row[source];
    }
    for (const page of campaign.pages) if (page.type === 'website' && variables[page.variable] == null && variables.website != null) variables[page.variable] = variables.website;
    return variables;
  }
  private issues(campaign: Campaign, variables: Record<string, any>) {
    const errors: Record<string, string[]> = {};
    for (const [field, definition] of Object.entries(deriveSchema(campaign))) {
      if (definition.required && (variables[field] == null || variables[field] === '')) errors[field] = [`${field} is required`];
      else if (definition.validator?.type === 'url' && !safeHttpUrl(variables[field])) errors[field] = [`Invalid URL for ${field}`];
    }
    return errors;
  }
  private duplicate(campaignId: string, field: string | undefined, variables: Record<string, any>): StoredVideo | undefined {
    if (!field || variables[field] == null || variables[field] === '' || typeof variables[field] === 'object') return;
    const row: any = this.db.prepare('SELECT videos.* FROM video_identifiers JOIN videos ON videos.id=video_identifiers.video_id WHERE video_identifiers.campaign_id=? AND field=? AND value=?').get(campaignId, field, String(variables[field]));
    return this.rowVideo(row);
  }
  private index(video: StoredVideo) {
    this.db.prepare('DELETE FROM video_identifiers WHERE video_id=?').run(video.id);
    const insert = this.db.prepare('INSERT OR IGNORE INTO video_identifiers(campaign_id,field,value,video_id) VALUES(?,?,?,?)');
    for (const [field, value] of Object.entries({ ...video.variables, originalUid: video.originalUid })) if (value !== null && value !== '' && ['string', 'number', 'boolean'].includes(typeof value)) insert.run(video.campaignId, field, String(value), video.id);
  }
  private insert(campaign: Campaign, row: StoredVideo['originalRow'], variables: Record<string, any>, importId: string | null, title: string, queue: boolean, explicitVariables?: Record<string, any>, metadata?: { originalUid: any; originalRowIndex: number | null }): StoredVideo {
    const at = new Date(this.now()).toISOString();
    const video: StoredVideo = { id: randomId(), shortId: randomId(12, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), campaignId: campaign.id,
      variables, ...(explicitVariables ? { explicitVariables: clone(explicitVariables) } : {}), originalRow: clone(row), importId, title, createdAt: at, queuedAt: queue ? at : null, queuedForRenderingAt: queue ? at : null,
      originalRowIndex: object(row) ? row.originalRowIndex ?? null : null, originalUid: variables.originalUid ?? null, ...metadata, importSource: importId ? 'API' : 'MANUAL', status: queue ? 'queued' : 'created' };
    this.db.prepare('INSERT INTO videos(id,short_id,campaign_id,data,status,created_ms) VALUES(?,?,?,?,?,?)').run(video.id, video.shortId, campaign.id, JSON.stringify(video), video.status, this.now());
    this.index(video);
    this.emit(video, 'VIDEO_CREATED');
    return video;
  }
  platformImport(campaignId: string, body: any) {
    if (!object(body) || !Array.isArray(body.videos) || body.videos.length > 2000 || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')) throw new HttpError(400, { error: 'Invalid import request', variableIssues: null, duplicates: 0 });
    return this.importVideos(campaignId, body, { dryRun: body.dryRun === true });
  }
  importVideos(campaignId: string, body: any, options?: { legacy?: boolean; dryRun?: boolean }) {
    const campaign = this.campaign(campaignId);
    if (!object(body) || !Array.isArray(body.videos) || body.videos.length > 10_000 || (body.importId != null && (typeof body.importId !== 'string' || !body.importId.trim())) || (body.duplicateIdentifierField != null && typeof body.duplicateIdentifierField !== 'string') || (body.titleTemplate != null && typeof body.titleTemplate !== 'string') || ['queueAllVideosForRender', 'renderTestVideo'].some(key => body[key] != null && typeof body[key] !== 'boolean')) {
      throw new HttpError(400, { error: 'Invalid import request', variableIssues: null, duplicates: 0 });
    }
    const importId = body.importId ?? randomId();
    return this.db.transaction(() => {
      const prior: any = this.db.prepare('SELECT response FROM imports WHERE campaign_id=? AND import_id=?').get(campaignId, importId);
      if (prior) return JSON.parse(prior.response);
      const result = { importId, inserted: 0, upserted: 0, duplicates: 0, invalidRows: 0, variableIssues: null as any, testVideoQueued: false };
      const variableIssues: Record<string, any> = {};
      const field = body.duplicateIdentifierField ?? (campaign as any).duplicateIdentifierField ?? 'originalUid';
      const accepted = new Set<string>();
      for (const [index, row] of body.videos.entries()) {
        const variables = object(row) ? this.variables(campaign, row) : {};
        const issues = object(row) ? this.issues(campaign, variables) : { videos: ['Row must be an object'] };
        if (Object.keys(issues).length) {
          result.invalidRows++;
          for (const [key, errors] of Object.entries(issues)) (variableIssues[key] ??= { affectedRows: [] }).affectedRows.push({ index, value: String(variables[key] ?? ''), errors });
          continue;
        }
        const value = variables[field];
        const identifier = field && value != null && value !== '' && ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : null;
        if (this.duplicate(campaignId, field, variables) || (identifier !== null && accepted.has(identifier))) { result.duplicates++; continue; }
        const test = body.renderTestVideo === true && !result.testVideoQueued && !body.queueAllVideosForRender;
        const title = interpolate(body.titleTemplate ?? (typeof row.title === 'string' ? row.title : typeof row.titel === 'string' ? row.titel : null) ?? campaign.titleTemplate ?? campaign.landing.title ?? campaign.name, variables);
        if (!options?.dryRun) this.insert(campaign, row, variables, importId, title, body.queueAllVideosForRender === true || test);
        if (identifier !== null) accepted.add(identifier);
        result.inserted++; result.testVideoQueued ||= test;
      }
      result.variableIssues = Object.keys(variableIssues).length ? variableIssues : null;
      if (!options?.dryRun) this.db.prepare('INSERT INTO imports(campaign_id,import_id,response) VALUES(?,?,?)').run(campaignId, importId, JSON.stringify(result));
      return result;
    })();
  }
  upsertVideo(campaignId: string, body: any) {
    const campaign = this.campaign(campaignId);
    if (!object(body) || !object(body.variables) || (body.queueForRender != null && typeof body.queueForRender !== 'boolean') || (body.title != null && typeof body.title !== 'string') || (body.duplicateIdentifierField != null && typeof body.duplicateIdentifierField !== 'string')) throw new HttpError(400, { errors: ['variables must be an object; invalid video request'] });
    const mappedVariables = this.variables(campaign, body.variables);
    const variables = withoutVideoMetadata(mappedVariables); const explicitVariables = withoutVideoMetadata(body.variables);
    const metadata = { originalUid: mappedVariables.originalUid ?? null, originalRowIndex: Number.isInteger(body.variables.originalRowIndex) ? body.variables.originalRowIndex : null };
    let originalRow = body.variables.originalRow ?? body.variables.originalData ?? body.variables;
    if (typeof originalRow === 'string') {
      try { const parsed = JSON.parse(originalRow); if (object(parsed)) originalRow = parsed; }
      catch { /* Preserve the original string when it is not JSON. */ }
    }
    const issues = this.issues(campaign, variables);
    if (Object.keys(issues).length) throw new HttpError(400, { errors: Object.values(issues).flat() });
    return this.db.transaction(() => {
      const existing = this.duplicate(campaignId, body.duplicateIdentifierField ?? (campaign as any).duplicateIdentifierField ?? 'originalUid', { ...variables, originalUid: metadata.originalUid });
      const title = interpolate(body.title ?? campaign.titleTemplate ?? campaign.landing.title ?? campaign.name, variables);
      if (existing) {
        existing.variables = variables; existing.explicitVariables = clone(explicitVariables); existing.originalRow = clone(originalRow); existing.originalUid = metadata.originalUid ?? existing.originalUid; existing.originalRowIndex = metadata.originalRowIndex; existing.title = title;
        if (existing.status === 'created' && body.queueForRender !== false) { existing.status = 'queued'; existing.queuedAt = new Date(this.now()).toISOString(); existing.queuedForRenderingAt = existing.queuedAt; }
        this.db.prepare('UPDATE videos SET data=?,status=? WHERE id=?').run(JSON.stringify(existing), existing.status, existing.id);
        this.index(existing);
        return { id: existing.id, shortId: existing.shortId };
      }
      const video = this.insert(campaign, originalRow, variables, 'API import', title, body.queueForRender !== false, explicitVariables, metadata);
      return { id: video.id, shortId: video.shortId };
    })();
  }
  webhooks(campaignId?: string) {
    const rows = (campaignId ? this.db.prepare('SELECT * FROM webhooks WHERE campaign_id=? ORDER BY created_at,id').all(campaignId) : this.db.prepare('SELECT * FROM webhooks ORDER BY created_at,id').all()) as any[];
    return rows.map(row => ({ id: row.id, trigger: row.trigger, webhookUrl: row.target_url, userId: 'ac-video', createdAt: row.created_at, campaignId: row.campaign_id,
      ...(row.campaign_id ? { campaign: { _id: row.campaign_id, name: this.campaign(row.campaign_id).name } } : {}) }));
  }
  platformWebhooks() {
    const rows = this.db.prepare(`SELECT w.*,c.data campaign_data,
      (SELECT count(*) FROM outbox o WHERE o.webhook_id=w.id AND o.state IN ('pending','sending')) pending,
      (SELECT count(*) FROM outbox o WHERE o.webhook_id=w.id AND o.state='delivered') delivered,
      (SELECT count(*) FROM outbox o WHERE o.webhook_id=w.id AND o.state='dead') dead,
      (SELECT count(*) FROM outbox o WHERE o.webhook_id=w.id AND o.state='rejected') rejected
      FROM webhooks w LEFT JOIN campaigns c ON c.id=w.campaign_id ORDER BY w.created_at,w.id`).all() as any[];
    return rows.map(row => {
      const url = new URL(row.target_url);
      return { id: row.id, trigger: row.trigger, campaignId: row.campaign_id, campaignName: row.campaign_data ? JSON.parse(row.campaign_data).name : null,
        target: `${url.origin}${url.pathname}${url.search ? '?***' : ''}`, createdAt: row.created_at,
        delivery: { pending: row.pending, delivered: row.delivered, dead: row.dead, rejected: row.rejected,
          lastErrorAt: row.last_error_at === null ? null : new Date(row.last_error_at).toISOString(),
          lastErrorCode: ['delivery_failed', 'blocked_private_target'].includes(row.last_error_code) || /^http_4\d{2}$/.test(row.last_error_code ?? '') ? row.last_error_code : null } };
    });
  }
  platformWebhookPut(body: any) {
    if (!object(body)) this.validateHook(body);
    const input = { trigger: body.trigger, webhookUrl: body.webhookUrl, campaignId: body.campaignId };
    const hook = this.webhookPut(input);
    return this.platformWebhooks().find(row => row.id === hook.id)!;
  }
  platformWebhookDelete(id: string) {
    if (typeof id !== 'string' || !id) throw new HttpError(400, { errors: ['Webhook id is required'] });
    if (!this.db.prepare('DELETE FROM webhooks WHERE id=?').run(id).changes) throw new HttpError(404, { message: 'Webhook not found' });
    return { success: true };
  }
  requeueWebhook(id: string, body: any) {
    if (!this.db.prepare('SELECT 1 FROM webhooks WHERE id=?').get(id)) throw new HttpError(404, { message: 'Webhook not found' });
    const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value))
      && new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19);
    if (!object(body) || !Array.isArray(body.states) || !body.states.length || body.states.length > 2 || body.states.some((state: unknown) => !['dead', 'rejected'].includes(state as string))
      || !timestamp(body.from) || !timestamp(body.to) || Date.parse(body.from) > Date.parse(body.to)) throw new HttpError(400, { errors: ['states must contain dead/rejected and from/to must be ordered UTC timestamps'] });
    const result = this.db.prepare(`UPDATE outbox SET state='pending',attempts=0,next_at=?,locked_until=NULL,last_error=NULL,last_status=NULL
      WHERE webhook_id=? AND state IN (${body.states.map(() => '?').join(',')}) AND event_id IN (SELECT id FROM events WHERE event_at>=? AND event_at<=?)`)
      .run(this.now(), id, ...body.states, Date.parse(body.from), Date.parse(body.to));
    return { count: result.changes };
  }
  private validateHook(body: any) {
    const errors: any[] = [];
    if (!object(body) || !safeHttpUrl(body.webhookUrl)) errors.push({ validation: 'url', code: 'invalid_string', message: 'Invalid url', path: 'webhookUrl' });
    if (!object(body) || !TRIGGERS.includes(body.trigger)) errors.push({ received: typeof body?.trigger === 'string' ? body.trigger : null, code: 'invalid_enum_value', message: 'Invalid trigger', path: 'trigger', options: TRIGGERS });
    if (errors.length) throw new HttpError(400, { errors });
  }
  webhookPut(body: any, campaignId?: string) {
    this.validateHook(body);
    const scoped = campaignId ?? body.campaignId ?? null;
    if (scoped !== null) { if (typeof scoped !== 'string') throw new HttpError(400, { errors: [{ code: 'invalid_type', message: 'Invalid campaignId', path: 'campaignId' }] }); this.campaign(scoped); }
    const existing: any = body.id ? this.db.prepare('SELECT * FROM webhooks WHERE id=?').get(body.id) : this.db.prepare('SELECT * FROM webhooks WHERE trigger=? AND target_url=? AND campaign_id IS ?').get(body.trigger, body.webhookUrl, scoped);
    if (body.id && !existing) throw new HttpError(404, { message: 'Webhook not found' });
    const id = existing?.id ?? randomId(); const createdAt = existing?.created_at ?? new Date(this.now()).toISOString();
    try { this.db.prepare('INSERT INTO webhooks(id,trigger,target_url,campaign_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET trigger=excluded.trigger,target_url=excluded.target_url,campaign_id=excluded.campaign_id').run(id, body.trigger, body.webhookUrl, scoped, createdAt); }
    catch (error: any) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, { message: 'Webhook already exists' }); throw error; }
    // Query-token targets are disclosed only by authenticated GET /webhooks.
    return { id, trigger: body.trigger, userId: 'ac-video', createdAt, ...(scoped ? { campaignId: scoped } : {}) };
  }
  webhookDelete(webhookUrl: string | null, trigger: string | null, campaignId?: string) {
    this.validateHook({ webhookUrl, trigger }); if (campaignId) this.campaign(campaignId);
    const result = this.db.prepare('DELETE FROM webhooks WHERE target_url=? AND trigger=? AND campaign_id IS ?').run(webhookUrl, trigger, campaignId ?? null);
    if (!result.changes) throw new HttpError(404, { message: 'Webhook not found' });
    return { success: true };
  }
  private triggeredWebhooks(video: StoredVideo): Trigger[] {
    const saved = video.triggeredWebhooks ?? [];
    if (saved.every((value: any) => TRIGGERS.includes(value))) return clone(saved);
    // shortcut: legacy hook IDs without retained delivery history cannot prove past triggers; recover only from audited delivery records.
    const history = this.db.prepare(`SELECT DISTINCT e.trigger FROM events e WHERE e.video_id=?
      AND e.trigger NOT IN ('VIDEO_VIEWED','VIDEO_STARTED','VIDEO_FINISHED')
      AND EXISTS (SELECT 1 FROM outbox o WHERE o.event_id=e.id) ORDER BY e.event_at,e.rowid`).all(video.id) as { trigger: Trigger }[];
    return [...new Set<Trigger>([...saved.filter((value: any) => TRIGGERS.includes(value)), ...history.map(row => row.trigger)])];
  }
  private publicVideo(video: StoredVideo, includeMedia = false, includePng = false) {
    const campaign = this.campaign(video.campaignId); const ready = video.status === 'rendered' && Boolean(video.playbackId);
    const base = videoBaseUrl(campaign, this.publicBaseUrl);
    const videoUrl = ready ? `${base}/video/${video.shortId}` : null;
    const thumbnailUrl = ready ? `${base}/thumbnail/${video.shortId}.gif` : null;
    const thumbnailStorageUrl = ready ? `https://image.mux.com/${video.playbackId}/${MUX_GIF_PARAMS}` : null;
    const thumbnailUrlPNG = ready ? `${base}/thumbnail/${video.shortId}.png` : null;
    const thumbnailStorageUrlPNG = ready ? `https://image.mux.com/${video.playbackId}/thumbnail.png?time=0&width=600` : null;
    const embed = (url: string | null) => videoUrl && url ? `<div><a target="_blank" href="${escapeHtml(videoUrl)}"><img style="margin:0px;box-sizing:border-box;padding:0px;width:100%;max-width:300px;height:auto" src="${escapeHtml(url)}" alt="${escapeHtml(video.title)}"></a><br /></div>` : null;
    const renderingStatus = ({ created: 'CREATED', queued: 'QUEUED', rendering: 'RENDERING', rendered: 'RENDERED', failed: 'FAILED', cancelled: 'CANCELLED', deferred: 'QUEUED' } as any)[video.status];
    // shortcut: legacy rows do not record explicit input provenance; expose schema fields until an audited migration can recover it.
    const backupVariables = withoutVideoMetadata(object(video.explicitVariables) ? clone(video.explicitVariables) : Object.fromEntries(Object.keys(deriveSchema(campaign)).filter(key => video.variables[key] !== undefined).map(key => [key, clone(video.variables[key])])));
    const overrideRow = Object.fromEntries(Object.entries(campaign.leadSchemaMapping ?? {})
      .filter(([key, source]) => !VIDEO_METADATA.includes(key) && typeof source === 'string' && object(video.originalRow) && Object.hasOwn(video.originalRow, source) && video.variables[key] !== undefined)
      .map(([key, source]) => [source!, clone(video.variables[key])]));
    return { _id: video.id, shortId: video.shortId, title: video.title, campaignId: video.campaignId, campaignName: campaign.name,
      userId: 'ac-video', meta: {}, importId: video.importId, importSource: video.importSource, originalRowIndex: video.originalRowIndex,
      createdAt: video.createdAt, queuedAt: video.queuedAt, queuedForRenderingAt: video.queuedForRenderingAt ?? null, startedProcessingAt: video.startedProcessingAt ?? null, startedRenderingAt: video.startedRenderingAt ?? null,
      backgroundRecordedAt: video.backgroundRecordedAt ?? null, renderedAt: video.renderedAt ?? null,
      finalVideoDurationMS: video.durationSec ? Math.round(video.durationSec * 1000) : null, triggeredWebhooks: this.triggeredWebhooks(video),
      ...(object(video.explicitVariables) ? { variables: clone(backupVariables) } : {}), _backupVariables: backupVariables, originalRow: clone(video.originalRow), overrideRow, renderingStatus,
      storagePaths: ready ? { video: video.videoFileUrl ?? null, video_mp4: video.videoFileUrl ?? null, thumbnail: thumbnailUrl, thumbnail_png: thumbnailUrlPNG } : {},
      ...(includeMedia ? { videoUrl, videoFileUrl: ready ? video.videoFileUrl ?? null : null,
        thumbnailUrl, thumbnailStorageUrl, thumbnailEmbed: embed(thumbnailUrl), thumbnailStorageEmbed: embed(thumbnailStorageUrl),
        ...(includePng ? { thumbnailUrlPNG, thumbnailStorageUrlPNG, thumbnailEmbedPNG: embed(thumbnailUrlPNG), thumbnailStorageEmbedPNG: embed(thumbnailStorageUrlPNG) } : {}) } : {}) };
  }
  payload(video: StoredVideo, event: Trigger, at = new Date(this.now()).toISOString()): { video: Record<string, any>; rawVideo?: Record<string, any>; event: Trigger; eventAt: string; viewedAt?: string; viewerUrl?: string | null } {
    if (!TRIGGERS.includes(event)) throw new HttpError(400, { errors: ['Unknown trigger'] });
    const created = event === 'VIDEO_CREATED';
    const rendered = event === 'VIDEO_RENDERED' || event === 'VIDEO_RENDERED_FULLY';
    const source = created ? { ...video, status: 'created' } : video;
    const document = this.publicVideo(source, true, true);
    const raw: Record<string, any> = Object.fromEntries(['_id', 'shortId', 'title', 'campaignId', 'meta', 'storagePaths', 'importId', 'createdAt', 'userId', 'originalRow', 'overrideRow', 'importSource', '_backupVariables', 'variables']
      .filter(key => key in document).map(key => [key, (document as any)[key]]));
    if (!created) Object.assign(raw, Object.fromEntries(['originalRowIndex', 'queuedAt', 'renderingStatus', 'startedProcessingAt', 'backgroundRecordedAt', 'queuedForRenderingAt', 'startedRenderingAt', 'finalVideoDurationMS', 'renderedAt'].map(key => [key, (document as any)[key]])), {
      renderingState: clone(video.renderingState ?? { executionStatus: video.status === 'rendered' ? 'COMPLETED' : video.status === 'failed' ? 'FAILED' : 'RUNNING', stage: video.status === 'rendered' ? 'completed' : video.status, lastError: video.failureReason ?? null, updatedAt: video.renderedAt ?? video.queuedAt ?? video.createdAt }),
    });
    if (created || rendered) {
      const fields = ['shortId', 'title', 'createdAt', 'meta', 'importId', 'campaignId', 'campaignName', 'thumbnailUrl', 'thumbnailStorageUrl', 'thumbnailUrlPNG', 'thumbnailStorageUrlPNG', 'thumbnailEmbed', 'thumbnailStorageEmbed', 'thumbnailEmbedPNG', 'thumbnailStorageEmbedPNG', 'videoFileUrl', 'videoUrl', 'originalRow', 'overrideRow',
        ...(rendered ? ['queuedAt', 'startedProcessingAt', 'startedRenderingAt', 'backgroundRecordedAt', 'renderedAt', 'originalRowIndex', 'renderingStatus'] : [])];
      return { video: { id: video.id, ...Object.fromEntries(fields.map(key => [key, (document as any)[key]])) }, rawVideo: raw, event, eventAt: at };
    }
    Object.assign(raw, { triggeredWebhooks: document.triggeredWebhooks, campaignName: document.campaignName });
    const viewerUrl = video.status === 'rendered' && video.playbackId ? `${videoBaseUrl(this.campaign(video.campaignId), this.publicBaseUrl)}/video/${video.shortId}` : null;
    return { video: raw, eventAt: at, event, viewerUrl, ...(/VIEWED|STARTED|FINISHED/.test(event) ? { viewedAt: at } : {}) };
  }
  private emit(video: StoredVideo, event: Trigger, session: string | null = null) {
    const targets = this.db.prepare('SELECT * FROM webhooks WHERE trigger=? AND (campaign_id IS NULL OR campaign_id=?)').all(event, video.campaignId) as any[];
    video.triggeredWebhooks = this.triggeredWebhooks(video);
    const id = randomId(); const payload = this.payload(video, event); const json = JSON.stringify(payload);
    this.db.prepare('INSERT INTO events(id,video_id,trigger,event_at,session,payload) VALUES(?,?,?,?,?,?)').run(id, video.id, event, this.now(), session, json);
    const insert = this.db.prepare('INSERT INTO outbox(id,event_id,webhook_id,target_url,next_at) VALUES(?,?,?,?,?)');
    for (const target of targets) insert.run(randomId(), id, target.id, target.target_url, this.now());
    // Native snapshots precede the current one-shot trigger; recurring viewer events are not recorded here.
    if (targets.length && !['VIDEO_VIEWED', 'VIDEO_STARTED', 'VIDEO_FINISHED'].includes(event)) video.triggeredWebhooks = [...new Set([...video.triggeredWebhooks, event])];
    this.db.prepare('UPDATE videos SET data=? WHERE id=?').run(JSON.stringify(video), video.id);
    return payload;
  }
  claim(limit = 1): (StoredVideo & { attempts: number; campaign: Campaign & { durationSec: number }; leaseToken: string; leaseExpiresAt: string })[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, { errors: ['limit must be between 1 and 100'] });
    return this.db.transaction(() => {
      const now = this.now();
      for (const row of this.db.prepare("SELECT * FROM videos WHERE status='rendering' AND lease_until<=? AND attempts>=3").all(now) as any[]) {
        const expired = this.rowVideo(row)!;
        if (this.shouldDefer(expired, 'render_failed')) {
          Object.assign(expired, { status: 'deferred', failureReason: 'render_failed', deferredAt: new Date(now).toISOString() });
          this.db.prepare("UPDATE videos SET status='deferred',lease_until=NULL,lease_token=NULL,data=? WHERE id=?").run(JSON.stringify(expired), row.id);
        }
      }
      this.db.prepare("UPDATE videos SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,lease_until=NULL,lease_token=NULL WHERE status='rendering' AND lease_until<=?").run(now);
      const rows = this.db.prepare("SELECT v.* FROM videos v JOIN campaigns c ON c.id=v.campaign_id WHERE v.status='queued' AND v.attempts<3 ORDER BY coalesce(json_extract(c.data,'$.priority'),0) DESC,json_extract(v.data,'$.deferredRetryAt') IS NOT NULL,v.created_ms,v.id LIMIT ?").all(limit) as any[];
      if (rows.length) this.db.prepare('UPDATE worker_activity SET last_claim_at=? WHERE id=1').run(new Date(now).toISOString());
      return rows.map(row => {
        const video = this.rowVideo(row)!; const token = randomId(32); const at = new Date(now).toISOString();
        video.startedProcessingAt ??= at; video.startedRenderingAt = at;
        this.db.prepare("UPDATE videos SET status='rendering',attempts=attempts+1,lease_until=?,lease_token=?,data=? WHERE id=?").run(now + LEASE_MS, token, JSON.stringify(video), video.id);
        return { ...video, status: 'rendering', attempts: row.attempts + 1, campaign: this.campaign(video.campaignId), leaseToken: token, leaseExpiresAt: new Date(now + LEASE_MS).toISOString() };
      });
    })();
  }
  private leased(id: string, token: any, allowCompleted = false): any {
    const row: any = this.db.prepare('SELECT * FROM videos WHERE id=?').get(id);
    if (!row) throw new HttpError(404, { message: 'Video not found' });
    if (typeof token !== 'string' || !token || token !== row.lease_token || (row.status !== 'rendering' && !(allowCompleted && row.status === 'rendered')) || (row.status === 'rendering' && row.lease_until <= this.now())) throw new HttpError(409, { message: 'Lease expired or replaced' });
    return row;
  }
  release(id: string, body: any) {
    if (!object(body)) throw new HttpError(400, { errors: ['Invalid release request'] });
    return this.db.transaction(() => {
      const row = this.leased(id, body.leaseToken); const video = this.rowVideo(row)!;
      video.status = 'queued'; video.attempts = Math.max(0, row.attempts - 1);
      this.db.prepare("UPDATE videos SET status='queued',attempts=?,lease_until=NULL,lease_token=NULL,data=? WHERE id=?").run(video.attempts, JSON.stringify(video), id);
      return { success: true, status: 'queued' };
    })();
  }
  missingMp4(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, { errors: ['limit must be between 1 and 100'] });
    const rows = this.db.prepare(`SELECT id,json_extract(data,'$.muxAssetId') muxAssetId,json_extract(data,'$.playbackId') playbackId
      FROM videos WHERE status='rendered' AND json_extract(data,'$.muxAssetId') IS NOT NULL AND json_extract(data,'$.playbackId') IS NOT NULL
      AND (json_extract(data,'$.videoFileUrl') IS NULL OR json_extract(data,'$.videoFileUrl') NOT LIKE 'https://stream.mux.com/%.mp4')
      ORDER BY created_ms,id LIMIT ?`).all(limit);
    return { videos: rows };
  }
  backfillMp4(id: string, body: any) {
    if (!object(body) || typeof body.playbackId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.playbackId)
      || typeof body.videoFileUrl !== 'string' || !body.videoFileUrl.startsWith(`https://stream.mux.com/${body.playbackId}/`)
      || !/^[A-Za-z0-9_-]+\.mp4$/.test(body.videoFileUrl.slice(`https://stream.mux.com/${body.playbackId}/`.length))) throw new HttpError(400, { errors: ['Invalid MP4 result'] });
    return this.db.transaction(() => {
      const video = this.video(id);
      if (video.status !== 'rendered' || body.muxAssetId !== video.muxAssetId || body.playbackId !== video.playbackId) throw new HttpError(409, { message: 'Completed asset does not match' });
      if (video.videoFileUrl !== body.videoFileUrl) {
        video.videoFileUrl = body.videoFileUrl;
        this.db.prepare('UPDATE videos SET data=? WHERE id=?').run(JSON.stringify(video), id);
      }
      return { success: true };
    })();
  }
  gifPath(shortId: string): string {
    if (!/^[A-Za-z0-9]{12}$/.test(shortId)) throw new HttpError(404, { error: 'not_found' });
    return join(this.dataDir, 'gifs', `${shortId}.gif`);
  }
  // shortcut: GIFs bleiben dauerhaft auf der Platte, rund 200 KB je Video; aufräumen, wenn der Platz knapp wird.
  async saveGif(id: string, body: any) {
    const gif = object(body) && typeof body.gif === 'string' ? Buffer.from(body.gif, 'base64') : Buffer.alloc(0);
    const magic = gif.subarray(0, 6).toString('ascii');
    if (gif.length > 1_000_000 || (magic !== 'GIF87a' && magic !== 'GIF89a')) throw new HttpError(400, { errors: ['Invalid GIF'] });
    const shortId = this.db.transaction(() => {
      const video = this.rowVideo(this.leased(id, body.leaseToken))!;
      if (!/^[A-Za-z0-9]{12}$/.test(video.shortId)) throw new HttpError(400, { errors: ['Invalid video'] });
      return video.shortId;
    })();
    ensureDataDirectory(join(this.dataDir, 'gifs'));
    const file = this.gifPath(shortId), temporary = file + '.tmp';
    await writeFile(temporary, gif, { mode: 0o644 });
    await rename(temporary, file);
    return { success: true };
  }
  complete(id: string, body: any) {
    if (!object(body) || ![body.muxAssetId, body.playbackId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)) || typeof body.durationSec !== 'number' || !Number.isFinite(body.durationSec) || body.durationSec <= 0
      || typeof body.videoFileUrl !== 'string' || !body.videoFileUrl.startsWith(`https://stream.mux.com/${body.playbackId}/`) || !/^[a-zA-Z0-9_-]+\.mp4$/.test(body.videoFileUrl.slice(`https://stream.mux.com/${body.playbackId}/`.length))
      || typeof body.backgroundRecordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.backgroundRecordedAt) || !Number.isFinite(Date.parse(body.backgroundRecordedAt)) || new Date(body.backgroundRecordedAt).toISOString() !== body.backgroundRecordedAt) throw new HttpError(400, { errors: ['Invalid render result'] });
    return this.db.transaction(() => {
      const row = this.leased(id, body.leaseToken, true); const video = this.rowVideo(row)!;
      if (row.status === 'rendered') {
        if (video.muxAssetId !== body.muxAssetId || video.playbackId !== body.playbackId || video.durationSec !== body.durationSec || video.videoFileUrl !== body.videoFileUrl || video.backgroundRecordedAt !== body.backgroundRecordedAt) throw new HttpError(409, { message: 'Video already completed with another result' });
        return { success: true };
      }
      if (Math.abs(body.durationSec - this.campaign(video.campaignId).durationSec) > 0.1 + Number.EPSILON) throw new HttpError(400, { errors: ['Rendered duration differs from campaign'] });
      const renderedAt = new Date(this.now()).toISOString();
      Object.assign(video, { muxAssetId: body.muxAssetId, playbackId: body.playbackId, videoFileUrl: body.videoFileUrl, backgroundRecordedAt: body.backgroundRecordedAt, durationSec: body.durationSec, renderedAt, status: 'rendered',
        renderingState: { executionStatus: 'RUNNING', stage: 'notifying-dashboard', lastError: null, updatedAt: renderedAt } });
      this.db.prepare("UPDATE videos SET status='rendered',data=?,lease_until=NULL WHERE id=?").run(JSON.stringify(video), id);
      this.db.prepare('UPDATE worker_activity SET last_complete_at=? WHERE id=1').run(renderedAt);
      this.emit(video, 'VIDEO_RENDERED');
      video.renderingState = { executionStatus: 'COMPLETED', stage: 'completed', lastError: null, updatedAt: renderedAt };
      this.emit(video, 'VIDEO_RENDERED_FULLY');
      return { success: true };
    })();
  }
  fail(id: string, reason: string, leaseToken?: string) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new HttpError(400, { errors: ['Invalid failure reason'] });
    return this.db.transaction(() => {
      const row = this.leased(id, leaseToken); const video = this.rowVideo(row)!;
      // Keep only reason codes: arbitrary worker errors can contain authenticated URLs.
      video.failureReason = reason === 'website_unreachable' ? reason : 'render_failed';
      let status = row.attempts >= 3 ? 'failed' : 'queued';
      if (status === 'failed' && this.shouldDefer(video, reason)) { status = 'deferred'; video.deferredAt = new Date(this.now()).toISOString(); }
      video.status = status;
      this.db.prepare('UPDATE videos SET status=?,data=?,lease_until=NULL,lease_token=NULL WHERE id=?').run(status, JSON.stringify(video), id);
      if (reason === 'website_unreachable' && !this.db.prepare("SELECT 1 FROM events WHERE video_id=? AND trigger='VIDEO_UNRENDERABLE'").get(id)) this.emit(video, 'VIDEO_UNRENDERABLE');
      return { success: true, status };
    })();
  }
  track(shortId: string, type: string, session: string) {
    const names: Record<string, Trigger> = { viewed: 'VIDEO_VIEWED', VIEWED: 'VIDEO_VIEWED', page_view: 'VIDEO_VIEWED', started: 'VIDEO_STARTED', STARTED: 'VIDEO_STARTED', play: 'VIDEO_STARTED', finished: 'VIDEO_FINISHED', FINISHED: 'VIDEO_FINISHED', VIDEO_VIEWED: 'VIDEO_VIEWED', VIDEO_STARTED: 'VIDEO_STARTED', VIDEO_FINISHED: 'VIDEO_FINISHED' };
    const event = names[type];
    if (!event || typeof session !== 'string' || !session || session.length > 200) throw new HttpError(400, { errors: ['Invalid tracking event'] });
    return this.db.transaction(() => {
      const video = this.getVideo(shortId);
      if (!video || video.status !== 'rendered') return { accepted: false };
      if (this.db.prepare('SELECT 1 FROM events WHERE video_id=? AND trigger=? AND session=? AND event_at>? LIMIT 1').get(video.id, event, session, this.now() - LEASE_MS)) return { accepted: false };
      this.emit(video, event, session);
      const first = event.replace('VIDEO_', 'VIDEO_FIRST_') as Trigger;
      if (!this.db.prepare('SELECT 1 FROM events WHERE video_id=? AND trigger=? LIMIT 1').get(video.id, first)) this.emit(video, first, session);
      return { accepted: true };
    })();
  }
  dueOutbox(limit = 20) {
    if (!dispatchEnabled()) return [];
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT o.*,e.payload FROM outbox o JOIN events e ON e.id=o.event_id WHERE (o.state='pending' AND o.next_at<=?) OR (o.state='sending' AND o.locked_until<=?) ORDER BY o.next_at,o.rowid LIMIT ?").all(this.now(), this.now(), limit) as any[];
      const lock = this.db.prepare("UPDATE outbox SET state='sending',locked_until=? WHERE id=?");
      for (const row of rows) lock.run(this.now() + 90_000, row.id);
      return rows.map(row => ({ ...row, webhookUrl: row.target_url, payload: JSON.parse(row.payload) }));
    })();
  }
  cleanup() {
    return this.db.transaction(() => {
      const cutoff = this.now() - RETENTION_MS;
      const outbox = this.db.prepare("DELETE FROM outbox WHERE state IN ('delivered','dead','rejected') AND event_id IN (SELECT id FROM events WHERE event_at<?)").run(cutoff).changes;
      // Keep undelivered payloads even after a long outage. Event identity/time remain for FIRST and dedupe.
      const payloads = this.db.prepare('UPDATE events SET payload=NULL WHERE event_at<? AND payload IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outbox WHERE event_id=events.id)').run(cutoff).changes;
      return { outbox, payloads };
    })();
  }
  outboxSuccess(id: string) { this.db.prepare("UPDATE outbox SET state='delivered',locked_until=NULL,last_error=NULL WHERE id=?").run(id); }
  outboxFailure(id: string, error?: string) {
    this.db.transaction(() => {
      const row: any = this.db.prepare('SELECT attempts,webhook_id FROM outbox WHERE id=?').get(id); if (!row) return;
      const delay = RETRIES[row.attempts];
      const status = /^http_([1-5]\d{2})$/.exec(error ?? '')?.[1];
      const rejected = status !== undefined && Number(status) >= 400 && Number(status) < 500 && !['408', '429'].includes(status);
      const code = error === 'blocked_private_target' ? error : rejected ? `http_${status}` : 'delivery_failed';
      this.db.prepare('UPDATE outbox SET attempts=attempts+1,state=?,next_at=?,locked_until=NULL,last_error=?,last_status=? WHERE id=?')
        .run(rejected ? 'rejected' : delay === undefined ? 'dead' : 'pending', this.now() + (delay ?? 0), code, status ? Number(status) : null, id);
      this.db.prepare('UPDATE webhooks SET last_error_at=?,last_error_code=? WHERE id=?').run(this.now(), code, row.webhook_id);
    })();
  }
}
