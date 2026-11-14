import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { escapeHtml as h, interpolate, safeHttpUrl, type Campaign } from './model.js';

export const MUX_PLAYER_VERSION = '3.13.4';
export const MUX_PLAYER_URL = `https://cdn.jsdelivr.net/npm/@mux/mux-player@${MUX_PLAYER_VERSION}/dist/mux-player.js`;

const botWords = readFileSync(new URL('./bot-user-agents.txt', import.meta.url), 'utf8').trim().split(/\r?\n/).map(s => s.toLowerCase());
export const isBot = (ua: string) => !ua || botWords.some(word => ua.toLowerCase().includes(word));
export function secureEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHmac('sha256', 'ac-video-auth-compare').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}
export function sign(value: string, secret: string): string { return createHmac('sha256', secret).update(value).digest('base64url'); }
export function cookies(header = ''): Record<string, string> {
  return Object.fromEntries(header.split(';').map(p => p.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p.length === 2));
}
export function statusPage(message: string): string {
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${h(message)}</title><main style="font:1.2rem system-ui;max-width:50rem;margin:15vh auto;padding:2rem"><h1>${h(message)}</h1><p>Bitte versuche es später erneut.</p></main></html>`;
}
export function landingPage(campaign: Campaign, video: any, beacon: string, internal: boolean, preview = false): string {
  const vars = video.variables;
  const l = campaign.landing;
  const title = interpolate(l.title || video.title || campaign.name, vars);
  const text = interpolate(l.text, vars);
  const creator = interpolate(l.creatorName ?? '', vars);
  const background = l.backgroundColor ?? '#111827', foreground = l.textColor ?? '#FFFFFF';
  const ctaColor = l.ctaColor ?? l.brandColor, ctaText = l.ctaTextColor ?? '#FFFFFF', creatorColor = l.creatorNameColor ?? '#9CA3AF';
  const link = (value: string | null | undefined) => { const url = interpolate(value ?? '', vars); return safeHttpUrl(url) ? url : ''; };
  const ctaUrl = link(l.ctaUrl), logoUrl = link(l.logoUrl), calendlyUrl = link(l.calendlyEmbedUrl), imprintUrl = link(l.imprintUrl), privacyUrl = link(l.privacyUrl);
  const playback = encodeURIComponent(video.playbackId);
  const tracking = internal || preview ? '' : `<script nonce="BEACON_NONCE">(() => {
const shortId=${JSON.stringify(video.shortId)}, token=${JSON.stringify(beacon)};
function send(type,progress){navigator.sendBeacon('/e',new Blob([JSON.stringify({shortId,token,type,progress})],{type:'application/json'}));}
send('VIEWED');
const player=document.querySelector('mux-player');let finished=false;
player.addEventListener('play',()=>send('STARTED'));
player.addEventListener('timeupdate',()=>{if(!finished&&Number.isFinite(player.duration)&&player.duration>0&&player.currentTime/player.duration>=.95){finished=true;send('FINISHED',player.currentTime/player.duration);}});
})();</script>`;
  // Head HTML arrives only via the authenticated Admin API, so it is raw HTML by design and never escaped.
  const headHtml = internal || preview ? '' : (l.headHtml ?? '').replaceAll('<script', '<script nonce="BEACON_NONCE"');
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${h(title)}</title>${headHtml}
<script defer src="${MUX_PLAYER_URL}"></script>
<style nonce="BEACON_NONCE">*{box-sizing:border-box}body{margin:0;background:${h(background)};color:${h(foreground)};font-family:system-ui,sans-serif;line-height:1.6}main{max-width:1480px;margin:48px auto;padding:24px}.layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(340px,1fr);gap:32px;align-items:start}.layout.without-calendar{grid-template-columns:minmax(0,1fr);max-width:1000px;margin:auto}.video-panel,.calendar{min-width:0}h1{font-size:clamp(1.5rem,3vw,2rem);line-height:1.25;margin:0;overflow-wrap:anywhere}.logo{max-width:180px;max-height:70px;margin-bottom:24px}mux-player{display:block;aspect-ratio:16/9;width:100%;background:#000;border-radius:12px;overflow:hidden}.details{display:flex;gap:20px;justify-content:space-between;align-items:start;margin-top:24px}.heading{min-width:0}.creator{color:${h(creatorColor)};margin:8px 0 0;overflow-wrap:anywhere}.text{white-space:pre-wrap;overflow-wrap:anywhere}.cta{display:inline-block;flex-shrink:0;max-width:100%;padding:12px 20px;border:2px solid ${h(ctaColor)};border-radius:8px;background:${h(ctaColor)};color:${h(ctaText)};font-weight:700;text-align:center;text-decoration:none;overflow-wrap:anywhere}a{color:inherit}a:focus-visible,iframe:focus-visible{outline:3px solid currentColor;outline-offset:5px}.calendar{border-radius:12px;overflow:hidden}.calendar p{font-size:.875rem;margin:12px 0}footer{display:flex;gap:24px;flex-wrap:wrap;margin-top:40px;font-size:.875rem}iframe{display:block;width:100%;height:700px;border:0;border-radius:12px;background:#fff}.internal{font-size:.9rem;margin:0 0 16px}@media(max-width:850px){main{margin:12px auto;padding:16px}.layout{grid-template-columns:minmax(0,1fr);gap:28px}.details{flex-wrap:wrap}.cta{margin-left:auto}footer{gap:18px}iframe{height:650px}}</style></head>
<body><main>${logoUrl ? `<img class="logo" src="${h(logoUrl)}" alt="${h(campaign.name)}">` : ''}
${preview ? '<p class="internal" role="status">Vorschau · Tracking deaktiviert</p>' : internal ? '<p class="internal" role="status">Interne Vorschau · Tracking deaktiviert</p>' : ''}
<div class="layout${calendlyUrl ? '' : ' without-calendar'}"><section class="video-panel" aria-labelledby="video-title">
<mux-player playback-id="${h(video.playbackId)}" poster="https://image.mux.com/${playback}/thumbnail.jpg?time=0&amp;width=600" stream-type="on-demand" metadata-video-title="${h(title)}" aria-label="${h(title)}" accent-color="${h(l.brandColor)}"></mux-player>
<div class="details"><div class="heading"><h1 id="video-title">${h(title)}</h1>${creator ? `<p class="creator">Created by ${h(creator)}</p>` : ''}</div>
${ctaUrl && l.ctaLabel ? `<a class="cta" href="${h(ctaUrl)}" rel="noopener noreferrer">${h(interpolate(l.ctaLabel, vars))}</a>` : ''}</div>
${text ? `<p class="text">${h(text)}</p>` : ''}
</section>${calendlyUrl ? `<section class="calendar" aria-label="Termin buchen"><iframe title="Termin über Calendly buchen" src="${h(calendlyUrl)}" loading="lazy"></iframe><p><a href="${h(calendlyUrl)}" target="_blank" rel="noopener noreferrer">Kalender in einem eigenen Fenster öffnen</a></p></section>` : ''}</div>
<footer>${imprintUrl ? `<a href="${h(imprintUrl)}">Impressum</a>` : ''}${privacyUrl ? `<a href="${h(privacyUrl)}">Datenschutz</a>` : ''}</footer></main>${tracking}</body></html>`;
}
