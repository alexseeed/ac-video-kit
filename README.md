# Video-Kit

Selbst betriebenes Tool für personalisierte Prospecting-Videos: Pro Lead wird eine Website per Screenshot aufgenommen, mit einer runden Facecam-Bubble aus einer Basisaufnahme kombiniert und als MP4 gerendert. Die öffentliche API und die Webhook-Payloads sind Pitchlane-kompatibel, sodass bestehende Aufrufer nur Basis-URL und API-Key umstellen.

Lizenz: noch nicht festgelegt, Weitergabe nur nach Absprache.

## Architektur

- **Server** (`src/server.ts`, Docker-Image): Pitchlane-kompatible API (`/api/public/v1`), Lese-API (`/api/platform/v1`), Landingpages (`/video/{shortId}`), Tracking-Beacon (`POST /e`), Webhook-Outbox, SQLite-Datei. Start: `npm start` oder per `compose.yml`.
- **Worker** (`src/worker.ts`, eigener Rechner): holt Jobs per `POST /worker/claim`, rendert lokal (Playwright/Chromium + ffmpeg), lädt zu Mux hoch, meldet `complete`/`fail`. Betrieb siehe `docs/SETUP.md`.
- **Mux**: Hosting der fertigen MP4s (Direct Upload, `basic`-Qualität, öffentliche Playback-ID, statische MP4-Rendition). Der Worker braucht ein Mux-Token; lokal ersetzt `examples/fake-mux.mjs` den Dienst.
- **Vorlagen**: Kampagnen als `campaign.json`-Verzeichnis, per `bin/campaign push` auf den Server geladen, Assets bleiben beim Worker. Format: `docs/KAMPAGNEN.md`.

## Voraussetzungen

- Node.js ≥ 22, `ffmpeg`/`ffprobe` (mit `libx264`; auf macOS zusätzlich `h264_videotoolbox` nutzbar), Python 3 (nur für die Aufbewahrungs-Unit).
- Chromium für Playwright: `npx playwright install chromium` (einmalig).
- Für den Betrieb: Mux-Konto, Linux-Server mit Docker, eigene Subdomain (siehe `docs/SETUP.md`).

## Schnellstart (lokal, ohne Mux)

Aus einem frischen Klon (`npm ci` und `npx playwright install chromium` laden Pakete und Browser, der Rest läuft offline):

```sh
npm ci
npx playwright install chromium
./examples/make-demo-assets.sh
node examples/fake-mux.mjs 4100 &
E2E_WEBSITE_URL=http://127.0.0.1:4100/website \
MUX_BASE_URL=http://127.0.0.1:4100 \
MUX_TOKEN_ID=fake-demo MUX_TOKEN_SECRET=fake-demo-secret \
scripts/e2e-local.sh
```

Das Skript startet einen lokalen Server, importiert eine Testzeile (`e2e-local@example.com`), rendert das Demo-Video, lädt es zum Fake-Mux hoch und gibt `landingUrl` und `gifUrl` aus. Die Landing-URL enthält bereits das interne Vorschau-Token und lässt sich direkt im Browser öffnen. Der Server läuft danach weiter; stoppen mit `kill <serverPid>` (steht in der Ausgabe). Mit `E2E_STOP_SERVER=1` stoppt er automatisch.

Für eigene Deployments jeden Secret mit `openssl rand -hex 32` erzeugen: Server und Worker verweigern den Start mit `change-me` oder Werten unter 16 Zeichen. Webhook-Ziele im privaten Netz (z. B. `127.0.0.1`) blockt der SSRF-Schutz beim Senden; nur für lokale Tests `ALLOW_PRIVATE_WEBHOOKS=1` setzen.

Einzelnes Testvideo ohne Server und ohne Mux geht auch direkt:

```sh
bin/campaign render-test examples/demo-kampagne --website http://127.0.0.1:4100/website
```

## Konfiguration

| Variable | Wo | Standard | Wozu |
|---|---|---|---|
| `PUBLIC_BASE_URL` | Server | Pflicht | Öffentliche Basis-URL, Fallback für Landing-Links |
| `API_KEYS` | Server | Pflicht | Komma-Liste API-Keys (`X-Api-Key`) |
| `WORKER_TOKEN` | Server, Worker | Pflicht | Bearer-Token Worker ↔ Server |
| `INTERNAL_VIEW_TOKEN` | Server | Pflicht | Token für interne Landing-Vorschau ohne Tracking |
| `PREVIEW_SECRET` | Server | Pflicht | Eigenes HMAC-Secret für Vorschau-Tickets |
| `DATA_ROOT_DIR` | beide | `./data` im Repo | Wurzel aller Daten (SQLite, Caches, Uploads) |
| `DATA_DIR` | beide | wie `DATA_ROOT_DIR` | Arbeitsverzeichnis, muss darin liegen |
| `DISPATCH_ENABLED` | Server | `1` | Webhook-Versand (`0` schaltet ab) |
| `ALLOW_PRIVATE_WEBHOOKS` | Server | leer | Nur lokal: `1` erlaubt Webhook-Ziele im privaten Netz (SSRF-Schutz aus) |
| `DEFERRED_RETRY_CAMPAIGNS` | Server | leer | Komma-Liste Kampagnen-IDs mit zurückgestellten Retries |
| `SERVER_URL` | Worker | Pflicht | Server-Basis-URL |
| `CAMPAIGNS_DIR` | Worker | Pflicht | Verzeichnis mit `campaign.json`-Ordnern je Kampagne |
| `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET` | Worker | Pflicht | Mux-Token mit Video-Rechten |
| `MUX_BASE_URL` | Worker | `https://api.mux.com` | Nur für lokalen Fake-Mux überschreiben |
| `VIDEO_ENCODER` | Worker | `h264_videotoolbox` (macOS), sonst `libx264` | Segment-Encoder; ungültige Werte brechen den Start ab |
| `RENDER_PARALLEL` / `SCREENSHOT_PARALLEL` / `UPLOAD_PARALLEL` | Worker | `2` / `3` / `3` | Parallelität |
| `SCREENSHOT_TIMEOUT_MS` | Worker | `45000` | Timeout je Website-Screenshot |
| `WORKER_BATCH_SIZE` | Worker | `8` | Jobs je Claim |
| `KEEP_OUTPUT` | Worker | `0` | `1` behält lokale MP4s nach dem Upload |
| `CHROMIUM_EXECUTABLE` | Worker | Playwright-Standard | Eigener Chromium-Pfad |

Env-Beispiele ohne Werte: `.env.example` (Server), `deploy/worker-env.example` (Worker).

## Betrieb und Umzug

- `docs/SETUP.md`: Mux-Konto, Hosting mit Docker Compose, Domain/DNS, Worker auf Mac (LaunchAgent) oder Linux (systemd), Sicherung der SQLite-Datei. Die 90-Tage-Aufbewahrung betrifft nur Medien (Mux-Asset, GIF); Lead-Daten (`originalRow`, Variablen) bleiben in der DB, eine eigene Löschregel für personenbezogene Daten muss der Betreiber festlegen.
- `docs/KAMPAGNEN.md`: `campaign.json`-Format, `campaign push`, `render-test`.
- `docs/PITCHLANE-UMZUG.md`: kompatible API-Aufrufe, Basis-URL umstellen, Webhooks übernehmen, Kampagnen nachbauen.

## Entwickeln

```sh
npm run check   # Typecheck
npm test        # Suite, offline (Mux/Webhook-Ziele als lokale Fake-Server)
```

`DATA_ROOT_DIR` zeigt ohne Env auf `./data` im Repo und wird bei Bedarf angelegt; für Testläufe ein temporäres Verzeichnis setzen.
