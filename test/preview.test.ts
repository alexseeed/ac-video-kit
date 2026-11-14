import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuePreviewTicket, validPreviewTicket } from '../src/preview.js';
import { landingPage } from '../src/landing.js';
import { campaignFixture } from './helpers.js';

const videoId = 'offline-video';
const secret = 'offline-preview-fixture';
const now = Date.parse('2026-10-15T12:00:00.000Z');

test('Preview tickets last ten minutes and are bound to one video and secret', () => {
  const { ticket, expiresAt } = issuePreviewTicket(videoId, secret, now);
  assert.equal(expiresAt, '2026-10-15T12:10:00.000Z');
  assert.equal(validPreviewTicket(ticket, videoId, secret, now), true);
  assert.equal(validPreviewTicket(ticket, videoId, secret, now + 10 * 60_000 - 1), true);
  assert.equal(validPreviewTicket(ticket, videoId, secret, now + 10 * 60_000), false);
  assert.equal(validPreviewTicket(ticket, videoId, secret, now + 10 * 60_000 + 1), false);
  assert.equal(validPreviewTicket(ticket, 'other-video', secret, now), false);
  assert.equal(validPreviewTicket(ticket, videoId, 'different-fixture', now), false);
  assert.equal(validPreviewTicket(ticket, videoId, secret, now - 1), false);
});

test('Preview verification fails closed for altered, malformed and oversized tickets', () => {
  const { ticket } = issuePreviewTicket(videoId, secret, now);
  const [expires, signature] = ticket.split('.');
  const tampered = `${expires}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  for (const value of ['', 'malformed', tampered, `${Number(expires) + 1}.${signature}`, `${ticket}.extra`, `0${ticket}`, `${expires}.${signature}=`, 'x'.repeat(100_000)]) {
    assert.equal(validPreviewTicket(value, videoId, secret, now), false);
  }
  for (const value of [NaN, Infinity, -1, now + .5]) assert.equal(validPreviewTicket(ticket, videoId, secret, value), false);
  assert.equal(validPreviewTicket(ticket, '', secret, now), false);
  assert.equal(validPreviewTicket(ticket, videoId, '', now), false);
  assert.equal(validPreviewTicket(ticket, videoId, '  ', now), false);
  assert.throws(() => issuePreviewTicket(videoId, '', now), /PREVIEW_SECRET/);
  assert.throws(() => issuePreviewTicket(videoId, '  ', now), /PREVIEW_SECRET/);
  assert.throws(() => issuePreviewTicket('', secret, now), /Invalid/);
  assert.throws(() => issuePreviewTicket(videoId, secret, NaN), /Invalid/);
});

test('Ticket preview displays its notice and omits tracking; ordinary landing still tracks', () => {
  const campaign = campaignFixture();
  const video = { id: videoId, shortId: 'OfflineVid12', playbackId: 'offline-playback', variables: { first_name: 'Test', company_name: 'Fixture' } };
  const html = landingPage(campaign, video, 'unused-beacon', false, true);
  assert.match(html, /role="status">Vorschau · Tracking deaktiviert<\/p>/);
  assert.doesNotMatch(html, /sendBeacon|unused-beacon|document\.cookie/);
  assert.match(html, /<mux-player/);
  assert.match(landingPage(campaign, video, 'ordinary-beacon', false), /sendBeacon/);
  const internal = landingPage(campaign, video, 'unused-beacon', true);
  assert.match(internal, /Interne Vorschau · Tracking deaktiviert/);
  assert.doesNotMatch(internal, /sendBeacon/);
});
