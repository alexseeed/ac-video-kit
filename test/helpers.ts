import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DATA_DIR, type Campaign } from '../src/model.js';
export function testDir(prefix: string): string {
  const root = join(DEFAULT_DATA_DIR, 'tests'); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, `${prefix}-`));
}
export function campaignFixture(overrides: Partial<Campaign> = {}): Campaign {
  return { id: 'offline-fixture-01', name: 'Offline fixture', baseVideo: 'base.mp4', output: { width: 1920, height: 1080, fps: 30 },
    bubble: { corner: 'bottom-right', diameterPct: 30, marginPct: 4 }, pages: [
      { type: 'website', start: 0, end: 4, variable: 'website_0', label: 'Page 1: Company Website' },
      { type: 'image', start: 4, end: 8, src: 'page2.png' },
      { type: 'website', start: 8, end: 12, variable: 'website_4', label: 'Page 5: Company Website' }],
    leadSchemaMapping: { website: 'capture_url', originalUid: 'originalUid' },
    landing: { title: 'Video für {{first_name}}', text: 'Hallo {{company_name}}', ctaLabel: 'Termin buchen', ctaUrl: 'https://example.invalid/book', brandColor: '#111827', imprintUrl: 'https://example.invalid/impressum', privacyUrl: 'https://example.invalid/datenschutz' }, ...overrides };
}
