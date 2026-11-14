#!/usr/bin/env node
// Minimaler lokaler Ersatz für Mux plus Test-Website für den Schnellstart.
// Nur für 127.0.0.1 gedacht, keine Authentifizierung, keine echten Daten.
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 4100);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  console.error('Usage: node examples/fake-mux.mjs [port]');
  process.exitCode = 1;
} else {
  let uploaded = false;
  const base = `http://127.0.0.1:${port}`;
  const server = createServer((request, response) => {
    if (request.url === '/website') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><style>body{margin:0;background:#ddeeff}main{height:1200px}</style><main>Local offline demo website</main>');
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/video/v1/uploads') {
      uploaded = false;
      response.end(JSON.stringify({ data: { id: 'upload-demo', url: `${base}/bytes` } }));
    } else if (request.method === 'PUT' && request.url === '/bytes') {
      let length = 0;
      request.on('data', chunk => { length += chunk.length; });
      request.on('end', () => { uploaded = length > 1000; response.end('{}'); });
    } else if (request.url === '/video/v1/uploads/upload-demo') {
      response.end(JSON.stringify({ data: uploaded ? { id: 'upload-demo', asset_id: 'asset-demo' } : { id: 'upload-demo', url: `${base}/bytes` } }));
    } else if (request.url === '/video/v1/assets/asset-demo') {
      response.end(JSON.stringify({ data: { id: 'asset-demo', status: 'ready', duration: 4,
        playback_ids: [{ id: 'demo-playback', policy: 'public' }],
        static_renditions: { files: [{ resolution: 'highest', status: 'ready', name: 'highest.mp4', ext: 'mp4' }] } } }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`FAKE_MUX_URL=${base}`));
}
