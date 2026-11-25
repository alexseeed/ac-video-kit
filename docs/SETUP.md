# Setup: Mux, Hosting, Worker

## Mux-Konto

1. Konto unter [mux.com](https://www.mux.com) anlegen, in den Einstellungen ein Access Token mit **Video**-Rechten erzeugen (`MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`).
2. Der Worker lädt per Direct Upload hoch (`video_quality: basic`, 1080p, öffentliche Playback-ID, statische MP4-Rendition). Kosten fallen pro gespeicherter Minute an; aktuelle Preise in der Mux-Preisliste prüfen.
3. Alte Assets nicht von Hand löschen: `deploy/video-kit-retention.py` (täglich per `deploy/video-kit-retention.timer`) löscht Videos älter als `--days` (Standard 90) bei Mux, entfernt ihre GIFs und markiert sie in der DB als `expired`. Nur Assets aus der eigenen DB werden angerührt, fremde Assets im selben Konto bleiben unangetastet. Die 90-Tage-Frist betrifft nur Medien (Mux-Asset, GIF); Lead-Daten (`originalRow`, Variablen) bleiben in der DB, eine eigene Löschregel für personenbezogene Daten muss der Betreiber festlegen. Vor dem ersten scharfen Lauf: `python3 deploy/video-kit-retention.py --dry-run` und `--self-test`. Skript nach `/usr/local/sbin/video-kit-retention` kopieren (`chmod 755`), Units nach `/etc/systemd/system/`, Mux-Zugang in die eigene Datei `/etc/video-kit-retention.env` (`MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `chmod 600`, nur für die Retention-Unit lesbar, nicht die Server-`.env`), dann `systemctl daemon-reload && systemctl enable --now video-kit-retention.timer`. Das Skript erwartet die Daten unter `/opt/video-kit/data` (SQLite, GIFs); dazu das Repo nach `/opt/video-kit` klonen, damit der Compose-Bind-Mount `./data` dort landet.

## Hosting (Server)

Linux-Server mit Docker, Compose-Datei `compose.yml`:

1. `.env` aus `.env.example` anlegen: `PUBLIC_HOST` (eigene Domain, siehe unten), `VIDEO_KIT_IMAGE_TAG`, zufällige `API_KEYS`, `WORKER_TOKEN`, `INTERNAL_VIEW_TOKEN`, `PREVIEW_SECRET` (jeweils eigene Zufallswerte, z. B. `openssl rand -hex 32`).
2. Repo nach `/opt/video-kit` klonen, dann `docker compose -f compose.yml up -d --build`: baut das Image und startet den Server. Die Daten liegen per Bind-Mount in `./data` (auf dem Host `/opt/video-kit/data`, im Container `/opt/video-kit/data`), sodass die Retention-Unit auf dem Host dieselbe SQLite-Datei und dieselben GIFs sieht. Der Container läuft als Nutzer `node` (uid 1000): vor dem ersten Start `mkdir -p data && chown 1000:1000 data`, sonst kann der Server nicht schreiben. Startet der Container immer wieder neu (`docker compose ps` zeigt `Restarting`), steht der Grund in `docker logs video-kit`, meist ein Platzhalter- oder zu kurzes Secret in `.env`.
3. Der Container lauscht nur auf `127.0.0.1:3000` (`HOST_PORT` änderbar). Davor einen eigenen Reverse-Proxy mit TLS betreiben (z. B. Caddy, nginx, Traefik), der die öffentliche Domain auf `127.0.0.1:3000` weitergibt. `PUBLIC_BASE_URL` muss die öffentliche `https`-URL sein, sonst stimmen Landing-Links und Tracking nicht. Landingpages und Vorschaubilder antworten nur unter `PUBLIC_HOST` bzw. der Kampagnen-`domain`; ein direkter Aufruf über `127.0.0.1:3000` liefert deshalb „Video nicht gefunden“. Zum Testen ohne Proxy den Host mitgeben: `curl -H "Host: <PUBLIC_HOST>" http://127.0.0.1:3000/video/<shortId>`.

## Domain und DNS

Eigene Subdomain verwenden, z. B. `video.example.com`:

1. A/AAAA-Record der Subdomain auf den Server zeigen lassen.
2. TLS-Zertifikat am Reverse-Proxy einrichten (z. B. automatisch per Caddy/Let's Encrypt).
3. Dieselbe Domain als `PUBLIC_HOST` in `.env`. Kampagnen können zusätzlich eine eigene `domain` tragen; dann wird ihre Landingpage nur unter diesem Host ausgeliefert.

## Worker auf einem Mac (LaunchAgent)

1. Repo klonen, `npm ci`, `npx playwright install chromium`, `ffmpeg` per Homebrew installieren (`h264_videotoolbox` ist auf dem Mac der Standard-Encoder).
2. `deploy/worker-env.example` nach `~/.config/video-kit/worker.env` kopieren, Werte eintragen, `chmod 600 ~/.config/video-kit/worker.env`.
3. `deploy/worker-launch.sh` startet den Worker (`worker run`) mit `caffeinate -i`, damit der Rechner während Renders nicht schläft.
4. `deploy/launchd/video-kit-worker.plist`: Pfade anpassen, Label bei Bedarf umbenennen, nach `~/Library/LaunchAgents/` kopieren, laden mit `launchctl load ~/Library/LaunchAgents/<label>.plist`. Logs unter `$DATA_DIR/logs/`.

## Worker auf Linux (systemd)

Voraussetzungen: Node.js ≥ 22.23.0 (wie `engines` in `package.json`), Repo klonen, `npm ci` inklusive Dev-Abhängigkeiten (`tsx` wird zur Laufzeit gebraucht, also kein `--omit=dev`), `ffmpeg` mit `libx264` (`VIDEO_ENCODER` steht auf Linux automatisch auf `libx264`), Chromium für Playwright (`npx playwright install --with-deps chromium` oder `CHROMIUM_EXECUTABLE` auf ein System-Chromium zeigen lassen).

Beispiel-Unit `/etc/systemd/system/video-kit-worker.service` (Pfade anpassen):

```ini
[Unit]
Description=video-kit render worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=video-kit
EnvironmentFile=/opt/video-kit/worker.env
WorkingDirectory=/opt/video-kit/app
ExecStart=/usr/local/bin/node --import tsx src/cli.ts worker run
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`/opt/video-kit/worker.env` nach `deploy/worker-env.example` befüllen (`chmod 600`, Besitzer `video-kit`), dann `systemctl daemon-reload && systemctl enable --now video-kit-worker`. `DATA_DIR` muss innerhalb von `DATA_ROOT_DIR` liegen, sonst verweigert der Worker den Start.

## Sicherheit

Der Worker öffnet importierte Websites mit Chromium, um Screenshots aufzunehmen. Den Worker nicht im selben Netz wie interne Dienste betreiben; die Egress-Firewall so setzen, dass nur 80/443 ins Internet offen sind und keine privaten Netze erreichbar sind.

## Sicherung

Server: Alle Zustände liegen in `$DATA_DIR/ac-video.sqlite` (dazu WAL-Dateien und `gifs/`). Sichern per Online-Backup `sqlite3 "$DATA_DIR/ac-video.sqlite" ".backup '$ZIEL'"` (SQLite inkl. WAL) plus Kopie von `gifs/`; das Compose-Datenverzeichnis (`/opt/video-kit/data`) in die Server-Sicherung aufnehmen. Worker: `CAMPAIGNS_DIR` sichern (Vorlagen, Basisvideos, Bilder). Wiederherstellung: Server stoppen, SQLite-Backup und `gifs/` zurückkopieren, `CAMPAIGNS_DIR` auf dem Worker zurückkopieren, Server und Worker starten.
