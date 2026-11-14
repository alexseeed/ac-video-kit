import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDirectory, mediaCommand, videoEncoder } from '../src/render.js';
import { ensureDataDirectory } from '../src/model.js';

const dataDir = await dataDirectory(), fixture = path.join(dataDir, 'fixtures', 'render-acceptance');
ensureDataDirectory(fixture);
const encoder = videoEncoder();
await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast'] : ['-allow_sw', '0']), '-b:v', '4500k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(fixture, 'base.mp4')]);
await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-f', 'lavfi', '-i', 'color=c=0xffcc44:size=1920x1080,drawgrid=width=240:height=180:thickness=4:color=white', '-frames:v', '1', '-update', '1', path.join(fixture, 'page2.png')]);
await writeFile(path.join(fixture, 'campaign.json'), JSON.stringify({ id: 'render-acceptance', name: 'Offline 12 second render acceptance', baseVideo: 'base.mp4', output: { width: 1920, height: 1080, fps: 30 }, bubble: { corner: 'bottom-right', diameterPct: 30, marginPct: 4 }, pages: [{ start: 0, end: 4, type: 'website', variable: 'website_0' }, { start: 4, end: 8, type: 'image', src: 'page2.png' }, { start: 8, end: 12, type: 'website', variable: 'website_2' }], leadSchemaMapping: { website: 'website' }, landing: { title: 'Offline render', text: '', ctaLabel: 'Book', ctaUrl: 'https://example.invalid/book', brandColor: '#111827', imprintUrl: 'https://example.invalid/imprint', privacyUrl: 'https://example.invalid/privacy' } }, null, 2));
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<!doctype html><html><head><meta charset="utf-8"><title>Local render fixture</title><style>body{margin:0;font:48px sans-serif;background:#edf4ff;color:#17305a}header{padding:90px;background:#2463eb;color:white}section{height:1000px;padding:80px;border-bottom:8px solid #2463eb}#onetrust-banner-sdk{position:fixed;inset:0;background:red;z-index:9999}</style></head><body><header>Local website — offline render acceptance</header><section>First section<br>Visible circular facecam</section><section style="background:#f4edff">Second section — scrolling background</section><section>Third section</section><div id="onetrust-banner-sdk">Consent banner must be hidden</div></body></html>'); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const port = (server.address() as { port: number }).port;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(path.resolve(import.meta.dirname, '../bin/campaign'), ['render-test', fixture, '--website', `http://127.0.0.1:${port}`], { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; process.stdout.write(bytes); });
    child.stderr.on('data', bytes => { stderr += bytes; process.stderr.write(bytes); });
    child.on('error', reject);
    child.on('close', code => { if (code === 0) resolve(stdout); else reject(new Error(`campaign render-test exited ${code}: ${stderr}`)); });
  });
  await writeFile(path.join(dataDir, 'acceptance-cli.log'), output);
} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
