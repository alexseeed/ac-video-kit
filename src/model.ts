import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface Campaign {
  id: string; name: string; domain?: string | null; baseVideo: string;
  output: { width: number; height: number; fps: number; videoBitrateKbps?: number };
  bubble: { corner: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'; diameterPct: number; marginPct: number; shadowBlurPx?: number; shadowOpacity?: number };
  // Movements use page-local seconds and signed pixels; an empty list keeps the page static.
  pages: ({ start: number; end: number; scroll?: [number, number, number][] } & (
    { type: 'website'; variable: string; label?: string } |
    { type: 'image'; src: string; header?: string } | { type: 'url'; url: string }
  ))[];
  leadSchemaMapping?: Record<string, string | null>;
  landing: { title: string; text: string; ctaLabel: string; ctaUrl: string;
    calendlyEmbedUrl?: string | null; logoUrl?: string | null; brandColor: string; imprintUrl: string; privacyUrl: string;
    backgroundColor?: string; textColor?: string; ctaColor?: string; ctaTextColor?: string; creatorNameColor?: string; creatorName?: string; headHtml?: string };
  createdAt?: string; archived?: boolean; titleTemplate?: string; priority?: number;
}
export function defaultDataRoot(): string {
  return path.resolve(import.meta.dirname, '../data');
}
export const DEFAULT_DATA_DIR = path.resolve(process.env.DATA_ROOT_DIR || defaultDataRoot());
export function ensureDataDirectory(value = DEFAULT_DATA_DIR): string {
  const requested = path.resolve(value);
  if (requested !== DEFAULT_DATA_DIR && !requested.startsWith(DEFAULT_DATA_DIR + path.sep)) throw Error('DATA_DIR must be inside DATA_ROOT_DIR');
  mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  const root = realpathSync(DEFAULT_DATA_DIR);
  let ancestor = requested;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actualAncestor = realpathSync(ancestor);
  if (actualAncestor !== root && !actualAncestor.startsWith(root + path.sep)) throw Error('DATA_DIR symlink escapes phase1 data directory');
  mkdirSync(requested, { recursive: true });
  const actual = realpathSync(requested);
  if (actual !== root && !actual.startsWith(root + path.sep)) throw Error('DATA_DIR symlink escapes phase1 data directory');
  return actual;
}
export function randomId(length = 21, alphabet = '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'): string {
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
}
export function assertDeploySecret(name: string, value: string): void {
  if (value.trim() === 'change-me' || value.trim().length < 16) throw new Error(`${name} must be a unique value of at least 16 characters, not the placeholder (generate with: openssl rand -hex 32)`);
}
export function safeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
export function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => String(variables[key] ?? ''));
}
export function deriveSchema(campaign: Campaign) {
  return Object.fromEntries(campaign.pages.flatMap((page, i) => page.type === 'website'
    ? [[page.variable, { label: page.label ?? `Page ${i + 1}: Company Website`, required: true, validator: { type: 'url', domain: null } }]] : []));
}
export function videoBaseUrl(campaign: Campaign, publicBaseUrl: string): string {
  return campaign.domain ? `https://${campaign.domain}` : publicBaseUrl.replace(/\/$/, '');
}
export function validateCampaign(value: unknown, durationSec: number): asserts value is Campaign {
  const c = value as Campaign;
  function require(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Invalid campaign: ${message}`); }
  require(c && typeof c === 'object' && !Array.isArray(c), 'object required');
  require(typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(c.id), 'invalid id');
  require(typeof c.name === 'string' && c.name.trim(), 'name required');
  require(c.titleTemplate === undefined || typeof c.titleTemplate === 'string', 'titleTemplate must be a string');
  require(c.archived === undefined || typeof c.archived === 'boolean', 'archived must be boolean');
  require(c.priority === undefined || (Number.isInteger(c.priority) && c.priority >= 0 && c.priority <= 10), 'priority must be an integer between 0 and 10');
  const asset = (p: unknown) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.split(/[\\/]/).some(s => s === '..' || s === '.') && !p.includes('\0');
  require(asset(c.baseVideo), 'relative baseVideo required');
  require(!c.domain || (typeof c.domain === 'string' && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(c.domain) && !c.domain.includes('..')), 'invalid domain');
  require(c.output && [c.output.width, c.output.height].every(n => Number.isInteger(n) && n >= 2 && n <= 4096 && n % 2 === 0), 'even output dimensions required');
  require(Number.isInteger(c.output.fps) && c.output.fps > 0 && c.output.fps <= 60, 'invalid fps');
  require(c.output.videoBitrateKbps === undefined || (Number.isInteger(c.output.videoBitrateKbps) && c.output.videoBitrateKbps >= 500 && c.output.videoBitrateKbps <= 8000), 'invalid video bitrate');
  require(c.bubble && ['bottom-left', 'bottom-right', 'top-left', 'top-right'].includes(c.bubble.corner), 'invalid bubble corner');
  require(Number.isFinite(c.bubble.diameterPct) && c.bubble.diameterPct > 0 && c.bubble.diameterPct <= 80 && Number.isFinite(c.bubble.marginPct) && c.bubble.marginPct >= 0 && c.bubble.marginPct <= 20 && c.bubble.diameterPct + 2 * c.bubble.marginPct <= 100, 'invalid bubble dimensions');
  require(c.bubble.shadowBlurPx === undefined || (Number.isFinite(c.bubble.shadowBlurPx) && c.bubble.shadowBlurPx >= 0 && c.bubble.shadowBlurPx <= 30), 'invalid bubble shadow blur');
  require(c.bubble.shadowOpacity === undefined || (Number.isFinite(c.bubble.shadowOpacity) && c.bubble.shadowOpacity >= 0 && c.bubble.shadowOpacity <= 1), 'invalid bubble shadow opacity');
  require(Number.isFinite(durationSec) && durationSec > 0 && Array.isArray(c.pages) && c.pages.length > 0, 'duration and pages required');
  let end = 0;
  for (const page of c.pages) {
    require(page && Number.isFinite(page.start) && Number.isFinite(page.end) && Math.abs(page.start - end) < 1e-6 && page.end > page.start, 'pages must be contiguous and increasing from zero');
    require(Math.abs(page.start * c.output.fps - Math.round(page.start * c.output.fps)) < 1e-5 && Math.abs(page.end * c.output.fps - Math.round(page.end * c.output.fps)) < 1e-5, 'page boundaries must align to frames');
    if (page.scroll !== undefined) {
      require(Array.isArray(page.scroll) && page.scroll.length <= 100, 'scroll must be a movement list');
      let previous = 0;
      for (const movement of page.scroll) {
        require(Array.isArray(movement) && movement.length === 3 && movement.every(Number.isFinite), 'invalid scroll movement');
        const [start, end, delta] = movement;
        require(start >= previous && end > start && end <= page.end - page.start + 1e-6 && Math.abs(delta) <= 8000, 'scroll movements must be ordered inside the page');
        previous = end;
      }
    }
    if (page.type === 'website') { require(page.label === undefined || typeof page.label === 'string', 'website label must be a string'); require(typeof page.variable === 'string' && page.variable.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(page.variable), 'website variable required'); }
    else if (page.type === 'image') { require(asset(page.src), 'relative image src required'); require(page.header === undefined || asset(page.header), 'relative image header required'); }
    else if (page.type === 'url') require(safeHttpUrl(page.url), 'valid page URL required');
    else throw new Error('Invalid campaign: unknown page type');
    end = page.end;
  }
  require(Math.abs(end - durationSec) <= 0.1, 'pages must cover base video duration');
  require(!c.leadSchemaMapping || (typeof c.leadSchemaMapping === 'object' && !Array.isArray(c.leadSchemaMapping) && Object.values(c.leadSchemaMapping).every(v => v === null || typeof v === 'string')), 'invalid leadSchemaMapping');
  require(c.landing && ['title', 'text', 'ctaLabel'].every(k => typeof (c.landing as any)[k] === 'string'), 'landing text required');
  require(/^#[a-f0-9]{6}$/i.test(c.landing.brandColor), 'brandColor must be hex');
  for (const key of ['backgroundColor', 'textColor', 'ctaColor', 'ctaTextColor', 'creatorNameColor'] as const) require(c.landing[key] === undefined || /^#[a-f0-9]{6}$/i.test(c.landing[key]!), `${key} must be hex`);
  require(c.landing.creatorName === undefined || typeof c.landing.creatorName === 'string', 'creatorName must be a string');
  require(c.landing.headHtml === undefined || (typeof c.landing.headHtml === 'string' && c.landing.headHtml.length <= 20000), 'headHtml must be a string up to 20000 characters');
  for (const key of ['ctaUrl', 'imprintUrl', 'privacyUrl', 'logoUrl', 'calendlyEmbedUrl'] as const) {
    const url = c.landing[key]; require(!url || safeHttpUrl(url), `invalid landing ${key}`);
  }
  if (c.landing.calendlyEmbedUrl) require(new URL(c.landing.calendlyEmbedUrl).hostname === 'calendly.com' || new URL(c.landing.calendlyEmbedUrl).hostname.endsWith('.calendly.com'), 'Calendly URL required');
}
