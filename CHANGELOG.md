# Changelog

## 2026-11-25

- **Neu:** Die DNS-Abfrage beim Webhook-Versand hat jetzt ein eigenes, über `WEBHOOK_DNS_TIMEOUT_MS` einstellbares Timeout (Standard 5000 ms, erlaubt 100 bis 60000 ms; ungültige Werte verhindern den Serverstart), sodass hängende Abfragen den gesamten Webhook-Versand nicht mehr bis zum Serverneustart blockieren und Timeouts als normale Zustellfehler behandelt und später erneut versucht werden.
- **Geprüft:** Schnellstart, Tests und Betrieb per Docker Compose laufen unter Linux (getestet auf arm64 mit Debian 12, Node 22 und ffmpeg 5.1).
- **Dokumentation (`docs/SETUP.md`):** Das Datenverzeichnis `data` muss dem Nutzer mit UID 1000 gehören (`chown 1000:1000 data`).
- **Dokumentation:** Startet der Container wiederholt neu, steht die Ursache in `docker logs video-kit` (meist ein Platzhalter-Secret).
- **Dokumentation:** Landingpages antworten nur unter der eigenen Domain (`PUBLIC_HOST`), weshalb zum Testen ohne Proxy der `Host`-Header mitgegeben werden muss.
