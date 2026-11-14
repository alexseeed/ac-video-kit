import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalRenderer, RenderError, Screenshotter, bubbleMaskFilter, campaignCacheKey, mediaCommand, probe, renderMailGif, scrollExpression, segmentArguments, videoEncoder } from '../src/render.js';
import { campaignFixture, testDir } from './helpers.js';

async function samplePixels(file: string, points: [number, number][], output: string, prep: string, channels: number): Promise<number[]> {
  const [[x, y]] = points;
  const graph = points.length === 1 ? `[0:v]${prep},crop=1:1:${x}:${y}[pixels]` : [`[0:v]${prep},split=${points.length}${points.map((_point, index) => `[p${index}]`).join('')}`,
    ...points.map(([px, py], index) => `[p${index}]crop=1:1:${px}:${py}[s${index}]`),
    `${points.map((_point, index) => `[s${index}]`).join('')}hstack=inputs=${points.length}[pixels]`].join(';');
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', file, '-filter_complex', graph, '-map', '[pixels]', '-frames:v', '1', '-update', '1', output]);
  const bytes = await readFile(output), pixels = bytes.subarray(bytes.indexOf(Buffer.from('\n255\n')) + 5);
  assert.equal(pixels.length, points.length * channels);
  return [...pixels];
}

async function captureSamples(file: string, points: [number, number][], output: string): Promise<number[]> {
  return samplePixels(file, points, output, 'format=gray', 1);
}

async function captureAlpha(file: string, points: [number, number][], output: string): Promise<number[]> {
  return samplePixels(file, points, output, 'format=rgba,alphaextract', 1);
}

async function captureRGB(file: string, points: [number, number][], output: string): Promise<number[]> {
  return samplePixels(file, points, output, 'format=rgb24', 3);
}

test('lazy images are activated by scrolling, and fixed headers have a reusable separate capture', async () => {
  const dir = testDir('lazy-screenshot');
  let imageFinishedAt = 0;
  const server = createServer((request, response) => {
    if (request.url === '/lazy.svg') {
      setTimeout(() => { response.setHeader('content-type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'); imageFinishedAt = Date.now(); }, 60);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><style>html{scroll-behavior:smooth}body{margin:0;height:4000px}header{position:fixed;top:0;width:100%;height:80px;background:blue}img{position:absolute;top:2300px}</style><header>Fixed</header><div style="position:absolute;left:500px;top:500px;width:100px;height:100px;background:#000"></div><img id="lazy" width="100" height="100"><script>new IntersectionObserver(([entry],observer)=>{if(entry.isIntersecting){entry.target.src="/lazy.svg";observer.disconnect()}}).observe(document.querySelector("#lazy"))</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const capture = await screenshotter.capture(`http://127.0.0.1:${(server.address() as {port:number}).port}`, path.join(dir, 'page.png'));
    assert.ok(imageFinishedAt > 0 && imageFinishedAt <= Date.now(), 'IntersectionObserver image finished before screenshot');
    assert.equal(capture.headerHeight, 80); assert.ok(capture.headerPath);
    assert.equal((await probe(capture.path)).streams[0].height, 2480);
    assert.equal((await probe(capture.headerPath!)).streams[0].height, 80);
    assert.deepEqual(JSON.parse(await readFile(capture.path + '.capture.json', 'utf8')), { headerHeight: 80, recordedAt: capture.recordedAt });
    assert.ok(Date.parse(capture.recordedAt!) >= imageFinishedAt);
    const samples = path.join(dir, 'pixels.pgm');
    await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', capture.path, '-i', capture.headerPath!, '-filter_complex',
      '[0:v]format=gray,split[top][lazy];[top]crop=1:1:50:50[a];[lazy]crop=1:1:50:2350[b];[1:v]format=gray,crop=1:1:50:20[c];[a][b][c]hstack=inputs=3[pixels]',
      '-map', '[pixels]', '-frames:v', '1', '-update', '1', samples]);
    const bytes = await readFile(samples), pixels = bytes.subarray(bytes.indexOf(Buffer.from('\n255\n')) + 5);
    assert.equal(pixels.length, 3);
    assert.ok(pixels[0] > 220, 'full-page background has no blue fixed header');
    assert.ok(pixels[1] >= 60 && pixels[1] < 110, 'lazy red image is painted in the saved full-page capture');
    assert.ok(pixels[2] < 60, 'separate header capture contains the blue header');
    const headerAlpha = await captureAlpha(capture.headerPath!, [[50, 20]], path.join(dir, 'header-alpha.pgm'));
    assert.ok(headerAlpha[0] > 250, 'a header with its own opaque background stays opaque');
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('scroll reveals are captured without exposing menus, dialogs, overlays or hidden content', async () => {
  const dir = testDir('scroll-reveals');
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><style>
      body{margin:0;height:4200px;background:#fff}
      .tile{position:absolute;width:100px;height:100px;background:#000}
      [data-aos]{opacity:0;visibility:hidden;transform:translateY(60px)}
      #observer{opacity:0;transform:translateY(60px);background:#fff;transition:opacity 100ms,transform 100ms}
      #observer.revealed{opacity:1;transform:none;background:#000}
      .concealed{opacity:0;transform:translateY(30px)}
      header{position:fixed;top:0;left:0;width:100%;height:80px;background:#fff}
      dialog{margin:0;padding:0;border:0}
      [hidden]{display:block}
    </style>
    <header><span class="tile concealed" style="left:1000px;top:0;height:80px">Dropdown</span></header>
    <main>
      <div class="tile" data-aos="fade-up" style="left:100px;top:350px"></div>
      <div class="tile" style="left:100px;top:1250px;opacity:0;transform:matrix(1,0,0,1,0,60)"></div>
      <div class="tile" id="observer" style="left:100px;top:2050px"></div>
      <div style="position:absolute;left:100px;top:2850px;width:100px;height:100px;opacity:0;transform:translateY(60px)"><div class="tile"></div><nav class="tile" style="left:200px"><span style="position:absolute;inset:0;background:#000;visibility:visible">Menu under reveal parent</span></nav></div>
      <div style="position:absolute;left:0;top:1500px;width:100%;height:1500px"><section style="position:sticky;top:0;width:100%;height:1080px"><div class="tile" style="left:1150px;top:100px;opacity:0;transform:translateY(60px)"></div></section></div>
      <div style="position:absolute;left:1400px;top:2300px"><div class="tile" style="position:relative;opacity:0;pointer-events:none;transform:translateY(60px)"></div></div>
      <section style="position:absolute;left:100px;top:3150px;width:100px;height:100px"><div class="tile" style="left:0;top:0;opacity:0;pointer-events:none"></div><div class="tile" style="left:0;top:0;opacity:0;pointer-events:none;background:#fff"><span style="position:absolute;inset:0;background:#fff;visibility:visible">Inactive carousel panel</span></div></section>
      <section style="position:absolute;left:300px;top:3150px;width:100px;height:100px"><div class="tile" style="left:0;top:0"></div><div class="tile" style="left:0;top:0;opacity:0;pointer-events:none;background:#fff"><span style="position:absolute;inset:0;background:#fff;visibility:visible">Inactive carousel panel</span></div></section>
      <nav style="position:absolute;left:400px;top:3650px;width:100px;height:100px"><div class="tile concealed">Dropdown</div></nav>
      <dialog open class="tile concealed" style="left:600px;top:3650px">Dialog</dialog>
      <div role="dialog" class="tile concealed" style="left:800px;top:3650px">Dialog</div>
      <div aria-hidden="true" style="position:absolute;left:1000px;top:3650px;width:100px;height:100px"><div class="tile concealed"></div></div>
      <div hidden class="tile concealed" style="left:1200px;top:3650px"></div>
      <div class="tile concealed cookie-banner" style="left:1400px;top:3650px">Cookie consent</div>
      <div id="onetrust-banner-sdk" class="tile concealed" style="left:1600px;top:3650px">Cookie consent</div>
      <div class="tile concealed" style="left:1800px;top:3650px;pointer-events:none"><span style="position:absolute;inset:0;background:#000;visibility:visible">Inactive carousel panel</span></div>
      <aside class="tile concealed" style="position:fixed;left:600px;top:500px">Overlay</aside>
      <aside class="concealed" style="position:sticky;top:650px;margin-left:800px;width:100px;height:100px;background:#000">Sticky overlay</aside>
    </main>
    <script>
      new IntersectionObserver(([entry], observer) => {
        if (entry.isIntersecting) {
          setTimeout(() => entry.target.classList.add('revealed'), 75);
          observer.disconnect();
        }
      }).observe(document.querySelector('#observer'));
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const capture = await screenshotter.capture(`http://127.0.0.1:${(server.address() as { port: number }).port}`, path.join(dir, 'page.png'));
    const points: [number, number][] = [[150, 400], [150, 1300], [150, 2100], [150, 2900], [1200, 1650], [1450, 2350], [150, 3200], [350, 3200],
      [450, 3700], [650, 3700], [850, 3700], [1050, 3700], [1250, 3700], [1450, 3700], [1650, 3700], [650, 550], [850, 700], [350, 2900], [1850, 3700]];
    const pixels = await captureSamples(capture.path, points, path.join(dir, 'page-pixels.pgm'));
    for (const [index, name] of ['AOS class', 'Webflow inline style', 'IntersectionObserver reveal', 'nested reveal', 'tall sticky content reveal', 'non-absolute pointer-events:none content', 'first panel of an all-hidden carousel', 'existing active carousel panel'].entries()) {
      assert.ok(pixels[index] < 10, `${name} paints at its original content position`);
    }
    for (const [index, name] of ['nav dropdown', 'native dialog', 'ARIA dialog', 'aria-hidden descendant', 'hidden attribute', 'cookie banner', 'known CMP', 'fixed overlay', 'sticky overlay', 'menu under reveal parent', 'inactive absolute carousel panel'].entries()) {
      assert.ok(pixels[index + 8] > 245, `${name} stays hidden`);
    }
    assert.ok(capture.headerPath);
    const headerPixels = await captureSamples(capture.headerPath!, [[1050, 40], [50, 40]], path.join(dir, 'header-pixels.pgm'));
    assert.ok(headerPixels.every(pixel => pixel > 245), 'the hidden header dropdown stays hidden in the separate header capture');
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('transparent backdrop headers are isolated from the page while preserving their own content', async () => {
  const dir = testDir('isolated-header');
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><style>
      body{margin:0;height:3000px;background:#fff}
      main{position:absolute;inset:0;height:3000px}
      header{position:fixed;top:0;width:100%;height:80px;background:rgba(255,255,255,.4);backdrop-filter:blur(12px)}
      .mark{position:absolute;left:1800px;top:20px;width:60px;height:40px;background:#000}
    </style><main style="visibility:visible!important;background:${request.url === '/dark' ? '#000' : '#fff'}!important"></main><div style="position:absolute;left:500px;top:500px;width:100px;height:100px;background:${request.url === '/dark' ? '#fff' : '#000'}"></div><header><svg width="0" height="0" aria-hidden="true"></svg><span class="mark"></span></header>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const captures = [];
    for (const background of ['dark', 'light']) {
      const capture = await screenshotter.capture(`${url}/${background}`, path.join(dir, `${background}.png`));
      assert.equal(capture.headerHeight, 80); assert.ok(capture.headerPath);
      const headerPixels = await captureSamples(capture.headerPath!, [[1830, 40]], path.join(dir, `${background}-header-pixels.pgm`));
      assert.ok(headerPixels[0] < 10, 'the header keeps its visible mark');
      const headerAlpha = await captureAlpha(capture.headerPath!, [[50, 40], [1830, 40]], path.join(dir, `${background}-header-alpha.pgm`));
      assert.ok(headerAlpha[0] > 0 && headerAlpha[0] < 255, 'the translucent header keeps alpha so the page shows through in the video');
      assert.ok(headerAlpha[1] > 250, 'the header mark stays opaque');
      const pagePixels = await captureSamples(capture.path, [[50, 40], [50, 150]], path.join(dir, `${background}-page-pixels.pgm`));
      assert.ok(pagePixels.every(pixel => background === 'dark' ? pixel < 10 : pixel > 245), 'the full-page capture retains the original page background');
      captures.push(headerAlpha);
    }
    assert.deepEqual(captures[0], captures[1], 'different page content cannot bleed into the reusable header');
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('a pill header composites transparently over the scrolling page', async () => {
  const dir = testDir('pill-header');
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><style>
      body{margin:0;height:3000px;background:#fff}
      .banner{position:absolute;top:0;left:0;width:100%;height:1080px;background:#ff0000}
      header{position:fixed;top:0;left:0;width:100%;height:80px;background:transparent}
      .pill{margin:10px auto;width:600px;height:60px;border-radius:30px;background:#0000ff}
    </style><div class="banner"></div><div style="position:absolute;left:500px;top:500px;width:100px;height:100px;background:#fff"></div><header><svg width="0" height="0" aria-hidden="true"></svg><div class="pill"></div></header>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const capture = await screenshotter.capture(`http://127.0.0.1:${(server.address() as { port: number }).port}`, path.join(dir, 'page.png'));
    assert.equal(capture.headerHeight, 80); assert.ok(capture.headerPath);
    const headerAlpha = await captureAlpha(capture.headerPath!, [[100, 40], [960, 40]], path.join(dir, 'header-alpha.pgm'));
    assert.ok(headerAlpha[0] < 10, 'beside the pill the header capture is transparent');
    assert.ok(headerAlpha[1] > 245, 'the pill itself stays opaque');
    const campaign = campaignFixture({ pages: [{ type: 'website', start: 0, end: 1, variable: 'website_0' }] });
    const diameter = Math.max(2, 2 * Math.round(campaign.output.width * campaign.bubble.diameterPct / 200));
    await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', bubbleMaskFilter(diameter), '-frames:v', '1', '-update', '1', path.join(dir, 'mask.png')]);
    await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '2', '-c:v', videoEncoder(), path.join(dir, 'base.mp4')]);
    const segment = path.join(dir, 'segment-0.mp4');
    await mediaCommand(segmentArguments(campaign, 0, capture.path, path.join(dir, 'base.mp4'), path.join(dir, 'mask.png'), segment, capture));
    await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', segment, '-frames:v', '1', '-update', '1', path.join(dir, 'frame.png')]);
    const rgb = await captureRGB(path.join(dir, 'frame.png'), [[960, 40], [100, 40], [100, 200]], path.join(dir, 'frame.ppm'));
    const [pr, pg, pb] = rgb.slice(0, 3), [sr, sg, sb] = rgb.slice(3, 6), [br, bg, bb] = rgb.slice(6, 9);
    assert.ok(pb > 200 && pr < 80 && pg < 80, 'the pill paints its own color');
    assert.ok(sr > 200 && sg < 80 && sb < 80, 'page content shows through beside the pill');
    assert.ok(br > 200 && bg < 80 && bb < 80, 'page content shows below the header');
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('frosted headers turn almost opaque while plain translucent headers stay see-through', async () => {
  const dir = testDir('frosted-header');
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    const headerBackground = request.url === '/frosted' ? 'background:rgba(255,255,255,.4);backdrop-filter:blur(12px)'
      : request.url === '/pseudo' ? 'background:transparent' : 'background:rgba(255,255,255,.4)';
    const pseudo = request.url === '/pseudo' ? 'header::before{content:"";position:absolute;inset:0;background:rgba(255,255,255,.4);backdrop-filter:blur(12px)}' : '';
    response.end(`<!doctype html><style>body{margin:0;height:3000px;background:#fff}header{position:fixed;top:0;width:100%;height:80px;${headerBackground}}${pseudo}</style><div style="position:absolute;left:500px;top:500px;width:100px;height:100px;background:#000"></div><header><svg width="0" height="0" aria-hidden="true"></svg></header>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const [route, opaque] of [['/frosted', true], ['/pseudo', true], ['/plain', false]] as const) {
      const capture = await screenshotter.capture(`${url}${route}`, path.join(dir, `${route.slice(1)}.png`));
      assert.equal(capture.headerHeight, 80); assert.ok(capture.headerPath);
      const alpha = await captureAlpha(capture.headerPath!, [[960, 40]], path.join(dir, `${route.slice(1)}-alpha.pgm`));
      if (opaque) assert.ok(alpha[0] >= 229, `${route} header is almost opaque without its blur (alpha ${alpha[0]})`);
      else assert.ok(alpha[0] > 0 && alpha[0] < 200, `plain header stays translucent (alpha ${alpha[0]})`);
    }
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('blank websites fail while image-only and late-loading pages capture', async () => {
  const dir = testDir('blank-website');
  const server = createServer((request, response) => {
    if (request.url === '/dot.svg') {
      response.setHeader('content-type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');
      return;
    }
    response.setHeader('content-type', 'text/html');
    if (request.url === '/empty') { response.end(''); return; }
    if (request.url === '/image-only') { response.end('<!doctype html><style>body{margin:0}</style><img src="/dot.svg" width="100" height="100">'); return; }
    response.end('<!doctype html><div id="app"></div><script>setTimeout(() => { document.getElementById("app").textContent = "Late SPA content"; }, 500)</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await assert.rejects(screenshotter.capture(`${url}/empty`, path.join(dir, 'empty.png')),
      (error: unknown) => error instanceof RenderError && error.reason === 'website_blank');
    assert.ok((await screenshotter.capture(`${url}/image-only`, path.join(dir, 'image.png'))).recordedAt);
    assert.ok((await screenshotter.capture(`${url}/late-text`, path.join(dir, 'late.png'))).recordedAt);
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('slow assets are captured while 404 and unfinished HTML still fail', async () => {
  const dir = testDir('slow-page');
  const hanging: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/hang') { response.writeHead(200, { 'content-type': 'image/png' }); hanging.push(response); return; }
    if (request.url === '/unfinished') { response.writeHead(200, { 'content-type': 'text/html' }); response.write('<!doctype html><div>Partial'); hanging.push(response); return; }
    response.setHeader('content-type', 'text/html');
    if (request.url === '/missing') { response.statusCode = 404; response.end('<!doctype html><h1>Not found</h1>'); return; }
    response.end('<!doctype html><style>body{margin:0;background:#fff;color:#000}</style><h1>Slow page</h1><div style="width:100px;height:100px;background:#000"></div><img src="/hang" width="100" height="100">');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 8000);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.ok((await screenshotter.capture(url, path.join(dir, 'slow.png'))).recordedAt);
    await assert.rejects(screenshotter.capture(`${url}/missing`, path.join(dir, 'missing.png')),
      (error: unknown) => error instanceof RenderError && error.reason === 'website_unreachable');
    await assert.rejects(screenshotter.capture(`${url}/unfinished`, path.join(dir, 'unfinished.png')),
      (error: unknown) => error instanceof RenderError && error.reason === 'render_failed');
  } finally { await screenshotter.close(); for (const response of hanging) response.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('a single-color first screen fails while a normal page with text and image captures', async () => {
  const dir = testDir('blank-first-screen');
  const server = createServer((request, response) => {
    if (request.url === '/dot.svg') {
      response.setHeader('content-type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');
      return;
    }
    response.setHeader('content-type', 'text/html');
    if (request.url === '/below-fold') { response.end('<!doctype html><style>body{margin:0;height:2000px;background:#fff}</style><div style="position:absolute;top:1200px">Content below the first screen</div>'); return; }
    if (request.url === '/dark') { response.end('<!doctype html><style>body{margin:0;height:2000px;background:#111;color:#111}</style><div>Dark single-color content</div>'); return; }
    response.end('<!doctype html><style>body{margin:0}</style><h1>Hello</h1><img src="/dot.svg" width="100" height="100">');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await assert.rejects(screenshotter.capture(`${url}/below-fold`, path.join(dir, 'below.png')),
      (error: unknown) => error instanceof RenderError && error.reason === 'website_blank');
    await assert.rejects(screenshotter.capture(`${url}/dark`, path.join(dir, 'dark.png')),
      (error: unknown) => error instanceof RenderError && error.reason === 'website_blank');
    assert.ok((await screenshotter.capture(url, path.join(dir, 'normal.png'))).recordedAt);
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('height:100% pages paint content far below the fold', async () => {
  const dir = testDir('full-height-page');
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><style>html,body{height:100%;margin:0;background:#fff;color:#000}h1{position:absolute;left:8px;top:8px;margin:0}.gap{height:2400px}.band{width:100px;height:100px;background:#000;margin-left:100px}</style><h1>Full height content</h1><div class="gap"></div><div class="band"></div>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const capture = await screenshotter.capture(`http://127.0.0.1:${(server.address() as { port: number }).port}`, path.join(dir, 'page.png'));
    assert.equal((await probe(capture.path)).streams[0].height, 2500);
    const pixels = await captureSamples(capture.path, [[150, 2450]], path.join(dir, 'pixels.pgm'));
    assert.ok(pixels[0] < 10, 'content well below 1080 px is painted');
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('captures end at content plus 80 px, within 1080 px and full height', async () => {
  const dir = testDir('trimmed-footer');
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/short') { response.end('<!doctype html><style>body{margin:0;background:#fff;color:#000}</style><h1>Short page</h1><div style="width:100px;height:100px;background:#000"></div>'); return; }
    if (request.url === '/full-bleed') { response.end('<!doctype html><style>body{margin:0;height:3000px;background:#fff;color:#000}.band{position:absolute;left:100px;top:2900px;width:100px;height:100px;background:#000}h1{margin:0}</style><h1>Full bleed content</h1><div class="band"></div>'); return; }
    response.end('<!doctype html><style>body{margin:0;height:3000px;background:#fff;color:#000}.block{position:absolute;left:100px;top:200px;width:300px;height:1300px;background:#000}h1{position:absolute;left:500px;top:300px;margin:0}</style><h1>Top content</h1><div class="block"></div>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotter = new Screenshotter(dir, 1, 120_000);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await probe((await screenshotter.capture(url, path.join(dir, 'trailing.png'))).path)).streams[0].height, 1580);
    assert.equal((await probe((await screenshotter.capture(`${url}/short`, path.join(dir, 'short.png'))).path)).streams[0].height, 1080);
    assert.equal((await probe((await screenshotter.capture(`${url}/full-bleed`, path.join(dir, 'bleed.png'))).path)).streams[0].height, 3000);
    assert.deepEqual((await readdir(dir)).filter(file => file.endsWith('.rows.bin') || file.endsWith('.trim.png')), [], 'trim temp files are removed');
  } finally { await screenshotter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('explicit scroll preserves pauses and signed eased moves; omitted scroll retains phase1 behavior', () => {
  const campaign = campaignFixture(), page = campaign.pages[0];
  assert.equal(scrollExpression(page, 4), '(ih-oh)*min(t/4,1)');
  page.scroll = []; assert.equal(scrollExpression(page, 4), 'max(0,min(ih-oh,0))');
  page.scroll = [[0, 1, 800], [2, 3, -200]];
  const expression = scrollExpression(page, 4);
  // Evaluate the same ffmpeg expression at movement starts, midpoint, pauses and page end.
  const evaluate = new Function('t', 'ih', 'oh', `const min=Math.min,max=Math.max;return ${expression};`) as (t:number, ih:number, oh:number)=>number;
  assert.deepEqual([0, .5, 1, 1.5, 2, 2.5, 3, 4].map(t => evaluate(t, 4000, 1080)), [0,400,800,800,800,700,600,600]);
  const args = segmentArguments(campaign, 0, 'bg.png', 'base.webm', 'mask.png', 'out.mp4', {path:'bg.png',headerPath:'header.png',headerHeight:80});
  assert.ok(args.includes('header.png')); assert.match(args[args.indexOf('-filter_complex') + 1], /\[background\]\[header\]overlay=0:0/);
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[3:v\]scale=1920:-1,format=rgba\[header\]/);
});

test('mail GIF is a 448x252 timelapse with 10 frames over 5 seconds', async () => {
  const dir = testDir('mail-gif');
  try {
    const video = path.join(dir, 'video.mp4'), gif = path.join(dir, 'mail.gif');
    await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-t', '10', '-c:v', videoEncoder(), video]);
    await renderMailGif(video, gif);
    const info = await probe(gif);
    assert.equal(info.streams[0].width, 448);
    assert.equal(info.streams[0].height, 252);
    assert.equal(Number(info.streams[0].nb_frames), 10);
    assert.ok(Math.abs(Number(info.format.duration) - 5) < 0.1, `GIF duration is 5 seconds, got ${info.format.duration}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bubble alpha has intermediate coverage within a two-pixel circumference', async () => {
  const dir = testDir('soft-mask'), mask = path.join(dir, 'mask.pgm');
  try {
    await mediaCommand(['-hide_banner','-nostdin','-y','-loglevel','error','-f','lavfi','-i',bubbleMaskFilter(100),'-frames:v','1','-update','1',mask]);
    const bytes = await readFile(mask), header = bytes.indexOf(Buffer.from('\n255\n')) + 5;
    const pixels = bytes.subarray(header);
    assert.equal(pixels.length, 10000); assert.equal(pixels[50 * 100 + 50], 255); assert.equal(pixels[0], 0);
    assert.ok(pixels.some(value => value > 0 && value < 255));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('image pages keep a fixed header above the scrolling image; header edits change the cache key', async () => {
  const dir = testDir('image-header');
  const campaign = campaignFixture({ output: { width: 64, height: 64, fps: 30 }, pages: [{ type: 'image', start: 0, end: 1, src: 'still.png', header: 'header.png' }] });
  await writeFile(path.join(dir, 'campaign.json'), JSON.stringify(campaign));
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', videoEncoder(), '-c:a', 'aac', path.join(dir, 'base.mp4')]);
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:size=64x128', '-frames:v', '1', '-update', '1', path.join(dir, 'still.png')]);
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=blue:size=64x16', '-frames:v', '1', '-update', '1', path.join(dir, 'header.png')]);
  const renderer = new LocalRenderer(dir);
  try {
    const before = await campaignCacheKey(campaign, dir);
    const result = await renderer.render({ campaignDir: dir, variables: {} });
    await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', result.path, '-frames:v', '1', '-update', '1', path.join(dir, 'frame.png')]);
    const rgb = await captureRGB(path.join(dir, 'frame.png'), [[8, 8], [8, 40]], path.join(dir, 'frame.ppm'));
    const [hr, hg, hb] = rgb.slice(0, 3), [br, bg, bb] = rgb.slice(3, 6);
    assert.ok(hb > 200 && hr < 80 && hg < 80, 'the fixed header paints the top of the frame');
    assert.ok(br > 200 && bg < 80 && bb < 80, 'the scrolling image paints below the header');
    await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=green:size=64x16', '-frames:v', '1', '-update', '1', path.join(dir, 'header.png')]);
    assert.notEqual(await campaignCacheKey(campaign, dir), before, 'header content changes the cache key');
  } finally { await renderer.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a cached website background preserves its capture completion time after renderer restart', async t => {
  const dir = testDir('capture-cache-time'), recordedAt = '2026-10-15T12:34:56.789Z';
  const campaign = campaignFixture({ output: { width: 64, height: 64, fps: 30 }, pages: [{ type: 'url', start: 0, end: .5, url: 'http://capture.invalid' }, { type: 'image', start: .5, end: 1, src: 'still.png' }] });
  await writeFile(path.join(dir, 'campaign.json'), JSON.stringify(campaign));
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', videoEncoder(), '-c:a', 'aac', path.join(dir, 'base.mp4')]);
  await mediaCommand(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=white:size=64x64', '-frames:v', '1', '-update', '1', path.join(dir, 'still.png')]);
  const first = new LocalRenderer(dir), second = new LocalRenderer(dir);
  let captures = 0;
  t.mock.method(first.screenshots, 'capture', async (_url: string, output: string) => {
    captures++;
    await copyFile(path.join(dir, 'still.png'), output);
    return { path: output, recordedAt };
  });
  t.mock.method(second.screenshots, 'capture', async () => { throw new Error('cache must reuse the captured background'); });
  try {
    const result = await first.render({ campaignDir: dir, variables: {} });
    assert.equal(result.backgroundRecordedAt, recordedAt);
    const reused = await second.render({ campaignDir: dir, variables: {} });
    assert.equal(reused.backgroundRecordedAt, recordedAt); assert.equal(reused.cacheKey, result.cacheKey); assert.equal(captures, 1);
    campaign.pages[0] = { type: 'website', start: 0, end: .5, variable: 'website_0' };
    await writeFile(path.join(dir, 'campaign.json'), JSON.stringify(campaign));
    await writeFile(path.join(dir, 'still.png.capture.json'), JSON.stringify({ recordedAt }));
    const frozen = await second.render({ campaignDir: dir, variables: { website_0: 'http://capture.invalid' }, screenshots: { 'http://capture.invalid': path.join(dir, 'still.png') } });
    assert.equal(frozen.backgroundRecordedAt, recordedAt, 'a recently prepared image never overrides the frozen website capture time');
  } finally { await first.close(); await second.close(); await rm(dir, { recursive: true, force: true }); }
});
