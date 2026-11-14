import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeHttpUrl } from '../src/model.js';
import { TRIGGERS, type Trigger } from '../src/store.js';

interface Hook { trigger: Trigger; webhookUrl: string; campaignId: string | null }
function hooks(value: unknown): Hook[] {
  if (!Array.isArray(value)) throw new Error('Expected the root array returned by GET /webhooks');
  const unique = new Map<string, Hook>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || !TRIGGERS.includes(item.trigger) || !safeHttpUrl(item.webhookUrl) ||
      (item.campaignId != null && (typeof item.campaignId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.campaignId)))) throw new Error('Invalid webhook record');
    const hook = { trigger: item.trigger, webhookUrl: item.webhookUrl, campaignId: item.campaignId ?? null };
    unique.set(identity(hook), hook);
  }
  return [...unique.values()];
}
function identity(hook: Hook): string { return JSON.stringify([hook.trigger, hook.webhookUrl, hook.campaignId]); }
function masked(hook: Hook) {
  const url = new URL(hook.webhookUrl);
  return { trigger: hook.trigger, campaignId: hook.campaignId, webhookUrl: `${url.origin}/[masked]${url.search ? '?[masked]' : ''}` };
}
export async function migrateWebhooks(options: { file: string; serverUrl: string; apiKey: string; apply?: boolean; log?: (message: string) => void }) {
  // Validate the entire source before any request or mutation. This script never contacts its target URLs.
  const source = hooks(JSON.parse(await readFile(options.file, 'utf8')));
  if (!safeHttpUrl(options.serverUrl) || !options.apiKey) throw new Error('SERVER_URL and API_KEY are required');
  const origin = new URL(options.serverUrl);
  if (origin.pathname !== '/' || origin.search || origin.hash || /(^|\.)pitchlane\.com$/i.test(origin.hostname.replace(/\.$/, ''))) throw new Error('SERVER_URL must be the own server origin');
  const request = async (route: string, payload?: Hook) => {
    const response = await fetch(`${origin.origin}/api/public/v1${route}`, {
      method: payload ? 'POST' : 'GET', headers: { 'x-api-key': options.apiKey, ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify({ trigger: payload.trigger, webhookUrl: payload.webhookUrl }) } : {}),
      redirect: 'manual', signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Own server returned HTTP ${response.status}`); }
    try { return await response.json(); } catch { throw new Error('Invalid own server response'); }
  };
  const existing = new Set(hooks(await request('/webhooks')).map(identity));
  const result = { dryRun: !options.apply, created: 0, present: 0, wouldCreate: 0 };
  for (const hook of source) {
    const key = identity(hook);
    let action: string;
    if (existing.has(key)) { result.present++; action = 'present'; }
    else if (options.apply) {
      await request(hook.campaignId ? `/campaigns/${encodeURIComponent(hook.campaignId)}/webhooks` : '/webhooks', hook);
      existing.add(key); result.created++; action = 'created';
    } else { result.wouldCreate++; action = 'would_create'; }
    options.log?.(JSON.stringify({ action, ...masked(hook) }));
  }
  return result;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const files = args.filter(arg => !arg.startsWith('--'));
  if (files.length !== 1 || args.some(arg => arg.startsWith('--') && !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) throw new Error('Usage: migrate-webhooks.ts <export.json> [--apply|--dry-run] (default: dry-run)');
  const result = await migrateWebhooks({ file: files[0], serverUrl: process.env.SERVER_URL || '', apiKey: process.env.API_KEY || process.env.API_KEYS?.split(',')[0]?.trim() || '', apply: args.includes('--apply'), log: console.log });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Webhook migration failed; check the export, own server, and credentials. No target URLs were requested.'); process.exitCode = 1; });
}
