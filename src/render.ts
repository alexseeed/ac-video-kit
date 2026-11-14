import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { type Campaign, defaultDataRoot, ensureDataDirectory, safeHttpUrl, validateCampaign } from './model.js';

const DEFAULT_DATA = process.env.DATA_ROOT_DIR || defaultDataRoot();
const FFMPEG = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'warning'];
export type VideoEncoder = 'h264_videotoolbox' | 'libx264';
export function videoEncoder(): VideoEncoder {
  const value = process.env.VIDEO_ENCODER || (process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264');
  if (value !== 'h264_videotoolbox' && value !== 'libx264') throw new Error(`Invalid VIDEO_ENCODER "${value}": expected h264_videotoolbox or libx264`);
  return value;
}
export class RenderError extends Error {
  constructor(public reason: string) { super(reason); }
}

export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(public readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Parallelism must be a positive integer');
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await task(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}

export async function dataDirectory(value = process.env.DATA_DIR || DEFAULT_DATA): Promise<string> {
  return ensureDataDirectory(value);
}

export async function mediaCommand(args: string[], binary = 'ffmpeg'): Promise<string> {
  const dataDir = await dataDirectory();
  const temp = path.join(dataDir, 'tmp');
  ensureDataDirectory(temp);
  return await new Promise<string>((resolve, reject) => {
    const process = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...globalThis.process.env, TMPDIR: temp } });
    let out = '', error = '';
    const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new RenderError('media_timeout')); }, 20 * 60_000);
    process.stdout.on('data', chunk => { out += chunk; });
    process.stderr.on('data', chunk => { error = (error + chunk).slice(-10_000); });
    process.on('error', cause => { clearTimeout(timer); reject(cause); });
    process.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${binary} failed (${code}): ${error}`)); });
  });
}

export async function probe(file: string): Promise<any> {
  return JSON.parse(await mediaCommand(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], 'ffprobe'));
}

export async function renderMailGif(video: string, output: string): Promise<void> {
  const overlay = fileURLToPath(new URL('./gif-play.png', import.meta.url));
  await mediaCommand([...FFMPEG, '-t', '10', '-i', video, '-i', overlay, '-filter_complex',
    '[0:v]fps=1,scale=448:252:flags=lanczos,setpts=N/2/TB[v];[v][1:v]overlay=0:0:format=auto,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-r', '2', '-frames:v', '10', '-loop', '0', output]);
}

export async function localAsset(dir: string, relative: string): Promise<string> {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /(^|[\/])\.env/i.test(relative)) throw new Error('Assets must be relative local files');
  const root = await realpath(dir), asset = await realpath(path.resolve(root, relative));
  if (!asset.startsWith(root + path.sep) || !(await stat(asset)).isFile()) throw new Error('Asset escapes campaign directory');
  return asset;
}

export async function loadCampaign(dir: string): Promise<{ campaign: Campaign; durationSec: number; dir: string }> {
  const actual = await realpath(dir);
  const candidate = JSON.parse(await readFile(path.join(actual, 'campaign.json'), 'utf8'));
  const base = await localAsset(actual, candidate.baseVideo);
  const info = await probe(base);
  const durationSec = Number(info.format.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || info.streams.filter((s: any) => s.codec_type === 'video').length !== 1 || info.streams.filter((s: any) => s.codec_type === 'audio').length !== 1) throw new Error('Base video needs one video and one audio stream');
  validateCampaign(candidate, durationSec);
  for (const page of candidate.pages) if (page.type === 'image') { await localAsset(actual, page.src); if (page.header !== undefined) await localAsset(actual, page.header); }
  return { campaign: candidate, durationSec, dir: actual };
}

async function fileHash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

export async function campaignCacheKey(campaign: Campaign, dir: string): Promise<string> {
  const digest = createHash('sha256').update('ac-video-render-v6-frosted-header\n').update(JSON.stringify(campaign));
  for (const relative of [campaign.baseVideo, ...campaign.pages.flatMap(page => page.type === 'image' ? [page.src, ...(page.header ? [page.header] : [])] : [])]) digest.update(relative).update(await fileHash(await localAsset(dir, relative)));
  return digest.digest('hex');
}

// These selectors only hide known consent layers; no consent is granted and no button is clicked.
// Visible body overflow keeps height:100% pages painting below the fold instead of trapping them in a viewport-high scroll box.
// shortcut: pages with their own inner scroll area under body overflow:hidden stay a still frame; revisit when samples show it.
export const CMP_CSS = `#usercentrics-root,#usercentrics-cmp-ui,#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay,#BorlabsCookieBox,.borlabs-cookie,#onetrust-consent-sdk,#onetrust-banner-sdk,.onetrust-pc-dark-filter,.cmplz-cookiebanner,.cmplz-popup-overlay,.rcb-banner,.rcb-consent,.cky-consent-container,.cky-overlay,#cookie-law-info-bar,.cli-modal-backdrop,[data-cookiebanner],#CookiebotWidget{display:none!important;visibility:hidden!important}html{overflow:auto!important;scroll-behavior:auto!important}body{overflow:visible!important;scroll-behavior:auto!important}`;

export async function chromiumExecutable(): Promise<string | undefined> {
  if (process.env.CHROMIUM_EXECUTABLE) return process.env.CHROMIUM_EXECUTABLE;
  try { await stat(chromium.executablePath()); return undefined; } catch {}
  if (process.platform === 'darwin') {
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const versions = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    for (const version of versions) {
      const executable = path.join(cache, version, `chrome-headless-shell-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'chrome-headless-shell');
      try { await stat(executable); return executable; } catch {}
    }
  }
  return undefined;
}

export interface ScreenshotCapture { path: string; headerPath?: string; headerHeight?: number; recordedAt?: string }
export class Screenshotter {
  private browser?: Promise<Browser>;
  private queue: Semaphore;
  constructor(private dataDir: string, parallel = 3, private timeoutMs = Number(process.env.SCREENSHOT_TIMEOUT_MS ?? 45_000)) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('SCREENSHOT_TIMEOUT_MS must be a positive timer-safe integer');
    this.dataDir = ensureDataDirectory(dataDir); this.queue = new Semaphore(parallel);
  }
  private async getBrowser(): Promise<Browser> {
    this.browser ??= (async () => {
      const temp = path.join(this.dataDir, 'tmp');
      ensureDataDirectory(temp);
      // Playwright itself creates its profile and artifacts with os.tmpdir().
      process.env.TMPDIR = temp;
      return await chromium.launch({ headless: true, timeout: this.timeoutMs, executablePath: await chromiumExecutable(), downloadsPath: temp, artifactsDir: temp, args: [`--disk-cache-dir=${path.join(temp, 'chromium-cache')}`], env: { ...process.env, TMPDIR: temp } });
    })();
    return this.browser;
  }
  async capture(url: string, output: string): Promise<ScreenshotCapture> {
    if (!safeHttpUrl(url)) throw new RenderError('website_unreachable');
    ensureDataDirectory(path.dirname(path.resolve(output)));
    return await this.queue.run(async () => {
      const browser = await this.getBrowser();
      // Some sites answer the default HeadlessChrome user agent with an empty body.
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'de-DE', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
      const deadline = Date.now() + this.timeoutMs;
      const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new RenderError('render_failed'); return ms; };
      let timer: ReturnType<typeof setTimeout>;
      const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new RenderError('render_failed')); void context.close().catch(() => {}); }, this.timeoutMs); });
      try {
        return await Promise.race([(async () => {
        const page = await context.newPage();
        // shortcut: kein Netzfilter im Renderer, Egress-Firewall nötig; verbessern, wenn Fremde Importe auslösen können.
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() }).catch((error: Error) => {
          // Navigation timeouts can be slow assets or CPU contention on an otherwise reachable page.
          if (/net::ERR_(NAME_NOT_RESOLVED|CONNECTION_\w+|ADDRESS_UNREACHABLE|NETWORK_UNREACHABLE|INTERNET_DISCONNECTED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE|INVALID_RESPONSE|SSL_\w+|CERT_\w+)\b/.test(error.message)) throw new RenderError('website_unreachable');
          throw new RenderError('render_failed');
        });
        if (!response || response.status() >= 400) throw new RenderError('website_unreachable');
        // Hanging trackers or huge images delay the load event for tens of seconds; capture anyway after a short grace period.
        // shortcut: images still loading after this wait are missing from the capture; adjust the limit when samples show it.
        try { await page.waitForLoadState('load', { timeout: Math.min(15_000, this.timeoutMs * 0.4, remaining()) }); } catch { remaining(); }
        await page.addStyleTag({ content: CMP_CSS });
        await page.evaluate(timeout => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, timeout))]), Math.min(1500, remaining()));
        // Blank pages answer HTTP 200 with an empty body; fail them instead of rendering a white video.
        const blank = () => document.body.innerText.trim() === '' && document.body.querySelector('img,svg,canvas,video,picture,iframe') === null;
        if (await page.evaluate(blank)) {
          // Late-loading SPAs get one grace period before the page counts as blank.
          await page.waitForTimeout(Math.min(1500, remaining()));
          if (await page.evaluate(blank)) throw new RenderError('website_blank');
        }
        // Trigger JS and native lazy images without spending the screenshot's reserved deadline.
        for (let y = 800; y < 8000 && remaining() > 2000; y += 800) {
          const bottom = await page.evaluate(y => { window.scrollTo({ left: 0, top: y, behavior: 'instant' }); return Math.min(8000, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)) - innerHeight; }, y);
          await page.waitForTimeout(Math.min(250, remaining()));
          if (y >= bottom) break;
        }
        // shortcut: preserve wide top headers up to 220 px; extend when a campaign needs sidebars or transformed header wrappers.
        const headerHeight = await page.evaluate(() => {
          let height = 0;
          for (const el of document.querySelectorAll<HTMLElement>('body *')) {
            const style = getComputedStyle(el), rect = el.getBoundingClientRect();
            if (!['fixed', 'sticky'].includes(style.position) || rect.width === 0 || rect.height === 0) continue;
            // shortcut: identify content stickies by viewport width/height; extend for narrow pinned content layouts.
            if (style.position === 'sticky' && rect.width >= innerWidth * .5 && rect.height > 220 && !el.closest('header,nav,aside,dialog,[role="banner"],[role="navigation"],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[aria-hidden="true"],[hidden],[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]')) {
              el.style.setProperty('position', 'relative', 'important');
              continue;
            }
            el.setAttribute('data-ac-video-fixed', '');
            if (style.visibility === 'visible' && Number(style.opacity) > 0 && rect.top >= -1 && rect.top < 10 && rect.width >= innerWidth * .5 && rect.height <= 220) {
              el.setAttribute('data-ac-video-header', '');
              height = Math.max(height, Math.ceil(rect.bottom));
            }
          }
          return height;
        });
        try { await page.waitForLoadState('networkidle', { timeout: Math.min(800, remaining()) }); } catch { remaining(); }
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}' });
        const capture: ScreenshotCapture = { path: output };
        if (headerHeight > 0) {
          capture.headerPath = output + '.header.png'; capture.headerHeight = headerHeight;
          await page.evaluate(() => {
            for (const el of document.querySelectorAll<HTMLElement>('html,body,body *')) {
              if (el.closest('[data-ac-video-header]')) continue;
              el.setAttribute('data-ac-video-header-original-style', el.getAttribute('style') ?? '');
              if (!el.hasAttribute('style')) el.setAttribute('data-ac-video-header-no-style', '');
              if (el.querySelector('[data-ac-video-header]')) {
                el.setAttribute('data-ac-video-header-ancestor', '');
                el.style.setProperty('background', 'none', 'important');
                el.style.setProperty('box-shadow', 'none', 'important');
                el.style.setProperty('backdrop-filter', 'none', 'important');
              } else {
                // Opacity also hides pseudo-elements and children with explicit visibility:visible.
                el.style.setProperty('opacity', '0', 'important');
              }
            }
            for (const el of [document.body, document.documentElement]) el.style.setProperty('background', 'transparent', 'important');
            // Frosted glass loses its blur in isolation, so give blurred header parts an almost opaque background.
            // No function definitions here: the transpiler would wrap them in a helper the browser cannot see.
            for (const el of document.querySelectorAll<HTMLElement>('[data-ac-video-header],[data-ac-video-header] *')) {
              for (let kind = 0; kind < 3; kind++) {
                const style = kind === 0 ? getComputedStyle(el) : getComputedStyle(el, kind === 1 ? '::before' : '::after');
                const plain = style.getPropertyValue('backdrop-filter'), webkit = style.getPropertyValue('-webkit-backdrop-filter');
                if ((plain === '' || plain === 'none') && (webkit === '' || webkit === 'none')) continue;
                const match = style.backgroundColor.match(/rgba?\(([^)]+)\)/);
                const parts = match ? match[1].split(',').map(part => parseFloat(part)) : null;
                const opaque = !parts || parts.length < 3 || (parts[3] ?? 1) === 0 ? 'rgba(255,255,255,0.92)' : `rgba(${parts[0]},${parts[1]},${parts[2]},0.92)`;
                if (!el.hasAttribute('data-ac-video-header-original-style')) {
                  el.setAttribute('data-ac-video-header-original-style', el.getAttribute('style') ?? '');
                  if (!el.hasAttribute('style')) el.setAttribute('data-ac-video-header-no-style', '');
                }
                if (kind === 0) el.style.setProperty('background-color', opaque, 'important');
                else if (kind === 1) { el.style.setProperty('--ac-video-frosted-before', opaque, 'important'); el.setAttribute('data-ac-video-frosted-before', ''); }
                else { el.style.setProperty('--ac-video-frosted-after', opaque, 'important'); el.setAttribute('data-ac-video-frosted-after', ''); }
              }
            }
          });
          // Keep layout and the header's own hidden menus, but remove every backdrop pixel from page content.
          const isolation = await page.addStyleTag({ content: '[data-ac-video-header-ancestor]::before,[data-ac-video-header-ancestor]::after{visibility:hidden!important}[data-ac-video-frosted-before]::before{background-color:var(--ac-video-frosted-before)!important}[data-ac-video-frosted-after]::after{background-color:var(--ac-video-frosted-after)!important}' });
          try { await page.screenshot({ path: capture.headerPath, clip: { x: 0, y: 0, width: 1920, height: headerHeight }, timeout: remaining(), omitBackground: true }); }
          finally { await isolation.evaluate(style => {
            style.parentNode?.removeChild(style);
            for (const el of document.querySelectorAll('[data-ac-video-header-original-style]')) {
              if (el.hasAttribute('data-ac-video-header-no-style')) el.removeAttribute('style');
              else el.setAttribute('style', el.getAttribute('data-ac-video-header-original-style')!);
              el.removeAttribute('data-ac-video-header-original-style'); el.removeAttribute('data-ac-video-header-no-style'); el.removeAttribute('data-ac-video-header-ancestor'); el.removeAttribute('data-ac-video-frosted-before'); el.removeAttribute('data-ac-video-frosted-after');
            }
          }); }
        }
        await page.addStyleTag({ content: '[data-ac-video-fixed]{visibility:hidden!important}' });
        await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
        await page.waitForTimeout(Math.min(50, remaining()));
        await page.evaluate(() => {
          const excluded = 'nav,header,dialog,[role="navigation"],[role="banner"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="menubar"],[aria-modal="true"],[aria-hidden="true"],[hidden],[popover],details:not([open]),[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],#usercentrics-root,#usercentrics-cmp-ui';
          const blocked = new Set<Element>(), transparent = new Set<Element>(), reveal: HTMLElement[] = [];
          for (const el of document.querySelectorAll<HTMLElement>('body *')) {
            const style = getComputedStyle(el), rect = el.getBoundingClientRect();
            const zeroOpacity = Number(style.opacity) === 0;
            if (zeroOpacity || transparent.has(el.parentElement!)) transparent.add(el);
            // shortcut: freeze overlapping absolute slide groups on their visible or first state; refine for other carousel layouts.
            let inactivePanel = zeroOpacity && style.position === 'absolute' && style.pointerEvents === 'none';
            if (inactivePanel) {
              const panels = [...el.parentElement!.children].filter(sibling => {
                const rect = sibling.getBoundingClientRect();
                return getComputedStyle(sibling).position === 'absolute' && rect.width > 0 && rect.height > 0;
              });
              inactivePanel = panels.length < 2 || panels[0] !== el || panels.some(panel => Number(getComputedStyle(panel).opacity) > 0);
            }
            if (blocked.has(el.parentElement!) || el.matches(excluded) || ['fixed', 'sticky'].includes(style.position) || inactivePanel) {
              // Preserve invisibility inherited from a reveal parent that will become visible below.
              if (!blocked.has(el.parentElement!)) {
                if (transparent.has(el)) el.style.setProperty('opacity', '0', 'important');
                if (style.visibility !== 'visible') el.style.setProperty('visibility', 'hidden', 'important');
              }
              blocked.add(el); continue;
            }
            if (rect.width <= 0 || rect.height <= 0) continue;
            const movedOffscreen = style.transform !== 'none' && (rect.right <= 0 || rect.left >= innerWidth || rect.bottom + scrollY <= 0);
            if (zeroOpacity || style.visibility !== 'visible' || movedOffscreen) reveal.push(el);
          }
          for (const el of reveal) {
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('transform', 'none', 'important');
          }
        });
        const height = await page.evaluate(() => Math.max(1080, Math.min(8000, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))));
        await page.screenshot({ path: output, fullPage: true, clip: { x: 0, y: 0, width: 1920, height }, timeout: remaining() });
        // A single-color first screen must never become a finished video; unreadable probe values count as OK.
        const stats = await mediaCommand([...FFMPEG, '-i', output, '-vf', 'crop=1920:1080:0:0,scale=256:-1,signalstats,metadata=print:file=-', '-f', 'null', '-']).catch(() => '');
        const ymin = Number(/YMIN=([0-9.]+)/.exec(stats)?.[1]), ymax = Number(/YMAX=([0-9.]+)/.exec(stats)?.[1]);
        if (Number.isFinite(ymin) && Number.isFinite(ymax) && ymax - ymin <= 12) throw new RenderError('website_blank');
        // A solid footer would scroll into emptiness; end the capture at the last content row plus a margin.
        await (async () => {
          const rowsFile = output + '.rows.bin', cropped = output + '.trim.png';
          try {
            await mediaCommand([...FFMPEG, '-i', output, '-vf', 'scale=64:ih:flags=area,format=gray', '-f', 'rawvideo', rowsFile]);
            const rows = await readFile(rowsFile), width = 64, full = Math.floor(rows.length / width);
            let last = -1;
            for (let y = 0; y < full; y++) {
              let min = 255, max = 0;
              for (let x = 0; x < width; x++) { const value = rows[y * width + x]; if (value < min) min = value; if (value > max) max = value; }
              if (max - min > 4) last = y;
            }
            const trimmed = Math.max(1080, Math.min(full, last + 81 + ((last + 81) & 1)));
            if (trimmed < full) {
              await mediaCommand([...FFMPEG, '-i', output, '-vf', `crop=iw:${trimmed}:0:0`, cropped]);
              await rename(cropped, output);
            }
          } finally {
            await rm(rowsFile, { force: true }); await rm(cropped, { force: true });
          }
        })().catch(() => {});
        capture.recordedAt = new Date().toISOString();
        await writeFile(output + '.capture.json', JSON.stringify({ ...(capture.headerHeight ? { headerHeight: capture.headerHeight } : {}), recordedAt: capture.recordedAt }));
        return capture;
        })(), expired]);
      } finally { clearTimeout(timer!); await context.close().catch(() => {}); }
    }).catch(error => { throw error instanceof RenderError ? error : new RenderError('render_failed'); });
  }
  async close(): Promise<void> { if (this.browser) await (await this.browser).close(); }
}

export function segmentFrames(start: number, end: number, fps: number): number { return Math.round(end * fps) - Math.round(start * fps); }

async function settle(tasks: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks), failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export function scrollExpression(page: Campaign['pages'][number], duration: number): string {
  if (page.scroll === undefined) return `(ih-oh)*min(t/${duration},1)`;
  return `max(0,min(ih-oh,${page.scroll.map(([start, end, delta]) => {
    const progress = `min(1,max(0,(t-${start})/${end - start}))`;
    return `${delta}*(${progress})*(${progress})*(3-2*(${progress}))`;
  }).join('+') || '0'}))`;
}

export function bubbleMaskFilter(diameter: number): string {
  // Two output pixels interpolate alpha at the circumference instead of a binary staircase.
  return `nullsrc=size=${diameter}x${diameter},format=gray,geq=lum='255*clip((${diameter}/2-sqrt((X-(W-1)/2)^2+(Y-(H-1)/2)^2))/2,0,1)'`;
}

export function segmentArguments(campaign: Campaign, pageIndex: number, background: string, base: string, mask: string, output: string, header?: ScreenshotCapture): string[] {
  const encoder = videoEncoder();
  const page = campaign.pages[pageIndex], { width, height, fps } = campaign.output;
  const frames = segmentFrames(page.start, page.end, fps), duration = frames / fps;
  const diameter = Math.max(2, 2 * Math.round(width * campaign.bubble.diameterPct / 200));
  const margin = Math.round(width * campaign.bubble.marginPct / 100);
  const left = campaign.bubble.corner.endsWith('left'), top = campaign.bubble.corner.startsWith('top');
  const fixed = header?.headerPath ? `[3:v]scale=${width}:-1,format=rgba[header];[background][header]overlay=0:0[bg]` : '[background]null[bg]';
  const shadow = (campaign.bubble.shadowBlurPx || 0) > 0 && (campaign.bubble.shadowOpacity ?? .25) > 0;
  const padding = Math.ceil((campaign.bubble.shadowBlurPx || 0) * 3), shadowSize = diameter + padding * 2;
  const shadowGraph = shadow ? `[2:v]split[alpha][rawshadow];[rawshadow]pad=${shadowSize}:${shadowSize}:${padding}:${padding}:color=black,gblur=sigma=${campaign.bubble.shadowBlurPx}[shadowalpha];color=black:size=${shadowSize}x${shadowSize}:r=${fps},format=rgba[black];[black][shadowalpha]alphamerge,colorchannelmixer=aa=${campaign.bubble.shadowOpacity ?? .25}[shadow];[bg][shadow]overlay=x=${left ? margin - padding : `W-w-${margin - padding}`}:y=${top ? margin - padding : `H-h-${margin - padding}`}[canvas]` : '[2:v]null[alpha];[bg]null[canvas]';
  const graph = `[0:v]scale=${width}:-2,pad=${width}:max(ih\\,${height}):0:0:color=white,format=yuv420p,loop=loop=-1:size=1:start=0,setpts=N/(${fps}*TB),crop=${width}:${height}:0:'${scrollExpression(page, duration)}'[background];${fixed};[1:v]setpts=PTS-STARTPTS,scale=${diameter}:${diameter}:force_original_aspect_ratio=increase,crop=${diameter}:${diameter}[small];${shadowGraph};[small][alpha]alphamerge,format=yuva420p[cam];[canvas][cam]overlay=x=${left ? margin : `W-w-${margin}`}:y=${top ? margin : `H-h-${margin}`}:format=yuv420:shortest=1[v]`;
  return [...FFMPEG, '-threads', '2', '-framerate', String(fps), '-i', background, '-ss', String(page.start), '-threads', '2', '-i', base, '-i', mask, ...(header?.headerPath ? ['-i', header.headerPath] : []), '-filter_complex_threads', '2', '-filter_complex', graph, '-map', '[v]', '-an', '-frames:v', String(frames), '-r', String(fps), '-fps_mode', 'cfr', '-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast'] : ['-allow_sw', '0']), '-b:v', `${campaign.output.videoBitrateKbps ?? 4500}k`, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level:v', '4.1', '-g', String(fps * 2), '-bf', '0', '-force_key_frames', '0', '-video_track_timescale', '90000', '-movflags', '+faststart', output];
}

export async function validateRender(file: string, campaign: Campaign, durationSec: number): Promise<any> {
  const info = await probe(file), video = info.streams.filter((s: any) => s.codec_type === 'video'), audio = info.streams.filter((s: any) => s.codec_type === 'audio');
  const expected = Math.round(durationSec * campaign.output.fps);
  if (video.length !== 1 || audio.length !== 1 || video[0].codec_name !== 'h264' || audio[0].codec_name !== 'aac' || video[0].width !== campaign.output.width || video[0].height !== campaign.output.height || Number(video[0].nb_frames) !== expected || video[0].r_frame_rate !== `${campaign.output.fps}/1` || Math.abs(Number(info.format.duration) - durationSec) > 0.1 || Math.abs(Number(audio[0].duration) - durationSec) > 0.1) throw new RenderError('render_validation_failed');
  const packets = JSON.parse(await mediaCommand(['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,flags', '-of', 'json', file], 'ffprobe')).packets;
  const times = packets.map((packet: any) => Number(packet.pts_time)).sort((a: number, b: number) => a - b);
  if (times.length !== expected || times.some((value: number, index: number) => Math.abs(value - index / campaign.output.fps) > 0.001)) throw new RenderError('render_frame_gap');
  for (const page of campaign.pages) {
    const start = Math.round(page.start * campaign.output.fps) / campaign.output.fps;
    if (!packets.some((packet: any) => Math.abs(Number(packet.pts_time) - start) < 0.001 && packet.flags.includes('K'))) throw new RenderError('segment_missing_idr');
  }
  const audioPackets = JSON.parse(await mediaCommand(['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', file], 'ffprobe')).packets;
  if (audioPackets.some((packet: any, index: number) => index > 0 && Math.abs(Number(packet.pts_time) - Number(audioPackets[index - 1].pts_time) - Number(audioPackets[index - 1].duration_time)) > 0.001)) throw new RenderError('render_audio_gap');
  return info;
}

export interface RenderResult { path: string; durationSec: number; elapsedSec: number; captureSec: number; encodeSec: number; cacheKey: string; backgroundRecordedAt: string }
export class LocalRenderer {
  readonly screenshots: Screenshotter;
  private encoders: Semaphore;
  private preparing = new Map<string, Promise<string>>();
  constructor(readonly dataDir: string, renderParallel = 2, screenshotParallel = 3) {
    videoEncoder();
    this.dataDir = ensureDataDirectory(dataDir);
    this.encoders = new Semaphore(renderParallel); this.screenshots = new Screenshotter(dataDir, screenshotParallel);
  }
  private async prepare(campaign: Campaign, dir: string, key: string): Promise<string> {
    if (this.preparing.has(key)) return this.preparing.get(key)!;
    const preparing = (async () => {
      const cache = path.join(this.dataDir, 'render-cache', key);
      ensureDataDirectory(cache);
      try { await stat(path.join(cache, 'ready.json')); return cache; } catch {}
      const base = await localAsset(dir, campaign.baseVideo);
      const diameter = Math.max(2, 2 * Math.round(campaign.output.width * campaign.bubble.diameterPct / 200));
      await mediaCommand([...FFMPEG, '-f', 'lavfi', '-i', bubbleMaskFilter(diameter), '-frames:v', '1', '-update', '1', path.join(cache, 'mask.png')]);
      await mediaCommand([...FFMPEG, '-i', base, '-vn', '-c:a', 'aac', '-b:a', '128k', path.join(cache, 'audio.m4a')]);
      const captures = new Map<string, Promise<ScreenshotCapture>>();
      const recordedTimes: string[] = [], imageTimes: string[] = [];
      await settle(campaign.pages.map(async (page, index) => {
        if (page.type === 'website') return;
        let background: string, capture: ScreenshotCapture | undefined;
        if (page.type === 'image') { background = await localAsset(dir, page.src); imageTimes.push((await stat(background)).mtime.toISOString()); if (page.header !== undefined) capture = { path: background, headerPath: await localAsset(dir, page.header) }; }
        else {
          if (!captures.has(page.url)) captures.set(page.url, (async () => {
            const screenshot = path.join(cache, `fixed-${index}.png`); return await this.screenshots.capture(page.url, screenshot);
          })());
          capture = await captures.get(page.url)!; background = capture.path;
          recordedTimes.push(capture.recordedAt!);
        }
        await this.encoders.run(() => mediaCommand(segmentArguments(campaign, index, background, base, path.join(cache, 'mask.png'), path.join(cache, `segment-${index}.mp4`), capture)));
      }));
      await writeFile(path.join(cache, 'ready.json'), JSON.stringify({ key, backgroundRecordedAt: recordedTimes.sort().at(-1) ?? null, imageSavedAt: imageTimes.sort().at(-1) ?? null }));
      return cache;
    })();
    this.preparing.set(key, preparing);
    try { return await preparing; } catch (error) { this.preparing.delete(key); throw error; }
  }
  async render(options: { campaignDir: string; variables: Record<string, unknown>; outputPath?: string; screenshots?: Record<string, string> }): Promise<RenderResult> {
    const started = performance.now(), { campaign, durationSec, dir } = await loadCampaign(options.campaignDir);
    const key = await campaignCacheKey(campaign, dir), cache = await this.prepare(campaign, dir, key);
    const cacheMetadata = JSON.parse(await readFile(path.join(cache, 'ready.json'), 'utf8'));
    const recordedTimes: string[] = cacheMetadata.backgroundRecordedAt ? [cacheMetadata.backgroundRecordedAt] : [];
    const runDir = path.join(this.dataDir, 'renders', `${Date.now()}-${createHash('sha256').update(JSON.stringify(options.variables)).update(String(Math.random())).digest('hex').slice(0, 12)}`);
    ensureDataDirectory(runDir);
    const output = options.outputPath ? path.resolve(options.outputPath) : path.join(runDir, 'video.mp4');
    if (!output.startsWith(this.dataDir + path.sep)) throw new Error('Render output must be inside DATA_DIR');
    ensureDataDirectory(path.dirname(output));
    let completed = false;
    // Per-video sums; fixed segments reused from the render cache keep their earlier build cost.
    let captureMs = 0, encodeMs = 0;
    try {
    const captures = new Map<string, Promise<ScreenshotCapture>>(), segments: string[] = [];
    await settle(campaign.pages.map(async (page, index) => {
      if (page.type !== 'website') { segments[index] = path.join(cache, `segment-${index}.mp4`); return; }
      const url = options.variables[page.variable];
      if (typeof url !== 'string' || !safeHttpUrl(url)) throw new RenderError('website_unreachable');
      if (!captures.has(url)) captures.set(url, (async () => {
        const captureStart = performance.now();
        try {
        const frozen = options.screenshots?.[url];
        if (frozen) {
          const file = await realpath(frozen);
          if (!file.startsWith(this.dataDir + path.sep) || !(await stat(file)).isFile()) throw new Error('Frozen screenshots must be inside DATA_DIR');
          // shortcut: frozen screenshots without capture metadata use file completion time; supply recordedAt when a source preserves capture metadata.
          const capture: ScreenshotCapture = { path: file, recordedAt: (await stat(file)).mtime.toISOString() };
          try {
            const meta = JSON.parse(await readFile(file + '.capture.json', 'utf8'));
            if (meta.recordedAt !== undefined) {
              if (typeof meta.recordedAt !== 'string' || !Number.isFinite(Date.parse(meta.recordedAt))) throw new Error('Invalid frozen capture time');
              capture.recordedAt = meta.recordedAt;
            }
            if (meta.headerHeight !== undefined) {
              const header = await realpath(file + '.header.png');
              if (!header.startsWith(this.dataDir + path.sep) || !Number.isFinite(meta.headerHeight) || meta.headerHeight <= 0 || meta.headerHeight > 220) throw new Error('Invalid frozen header');
              capture.headerPath = header; capture.headerHeight = meta.headerHeight;
            }
          } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
          return capture;
        }
        const screenshot = path.join(runDir, `website-${index}.png`); return await this.screenshots.capture(url, screenshot);
        } finally { captureMs += performance.now() - captureStart; }
      })());
      const capture = await captures.get(url)!, background = capture.path;
      recordedTimes.push(capture.recordedAt!);
      segments[index] = path.join(runDir, `segment-${index}.mp4`);
      const base = await localAsset(dir, campaign.baseVideo);
      const encodeStart = performance.now();
      await this.encoders.run(() => mediaCommand(segmentArguments(campaign, index, background, base, path.join(cache, 'mask.png'), segments[index], capture)));
      encodeMs += performance.now() - encodeStart;
    }));
    const list = path.join(runDir, 'concat.txt');
    await writeFile(list, segments.map(segment => `file '${segment.replaceAll("'", "'\\''")}'`).join('\n'));
    const partial = output + '.partial.mp4';
    const assemblyStart = performance.now();
    await mediaCommand([...FFMPEG, '-f', 'concat', '-safe', '0', '-i', list, '-i', path.join(cache, 'audio.m4a'), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-t', String(durationSec), '-movflags', '+faststart', partial]);
    await validateRender(partial, campaign, durationSec);
    encodeMs += performance.now() - assemblyStart;
    await rename(partial, output);
    completed = true;
    // Image-only campaigns have no website recording; preserve the saved background's time.
    return { path: output, durationSec, elapsedSec: (performance.now() - started) / 1000, captureSec: captureMs / 1000, encodeSec: encodeMs / 1000, cacheKey: key, backgroundRecordedAt: recordedTimes.sort().at(-1) ?? cacheMetadata.imageSavedAt };
    } finally {
      // Retain only the final bounded upload buffer; screenshots and intermediate segments are transient.
      await rm(output + '.partial.mp4', { force: true });
      for (const entry of await readdir(runDir)) {
        const file = path.join(runDir, entry);
        if (!(completed && file === output)) await rm(file, { recursive: true, force: true });
      }
      if (!output.startsWith(runDir + path.sep) || !completed) await rm(runDir, { recursive: true, force: true });
    }
  }
  async close(): Promise<void> { await this.screenshots.close(); }
}

export async function renderCampaign(options: { campaignDir: string; variables: Record<string, unknown>; dataDir?: string; outputPath?: string; screenshots?: Record<string, string> }): Promise<RenderResult> {
  const renderer = new LocalRenderer(await dataDirectory(options.dataDir));
  try { return await renderer.render(options); } finally { await renderer.close(); }
}
