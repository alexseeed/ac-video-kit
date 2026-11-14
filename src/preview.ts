import { secureEqual, sign } from './landing.js';

const lifetime = 10 * 60_000;
const validId = (value: string) => /^[A-Za-z0-9_-]{1,100}$/.test(value);

export function issuePreviewTicket(videoId: string, secret: string, now: number): { ticket: string; expiresAt: string } {
  if (!secret.trim()) throw Error('PREVIEW_SECRET is required');
  if (!validId(videoId) || !Number.isSafeInteger(now) || now < 0) throw Error('Invalid preview ticket input');
  const expires = now + lifetime;
  const expiresAt = new Date(expires).toISOString();
  return { ticket: `${expires}.${sign(`preview:${videoId}:${expires}`, secret)}`, expiresAt };
}

export function validPreviewTicket(ticket: string, videoId: string, secret: string, now: number): boolean {
  if (!secret.trim() || !validId(videoId) || !Number.isSafeInteger(now) || now < 0 || ticket.length > 80) return false;
  const match = ticket.match(/^([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return false;
  const expires = Number(match[1]);
  return Number.isSafeInteger(expires) && expires > now && expires <= now + lifetime
    && secureEqual(match[2], sign(`preview:${videoId}:${match[1]}`, secret));
}
