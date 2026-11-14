# Kampagnen: `campaign.json`

Eine Kampagne ist ein Verzeichnis mit `campaign.json` plus Assets (Basisvideo, Bilder). Der Worker erwartet es unter `CAMPAIGNS_DIR/<campaign-id>/`. Beispiel als Ausgangspunkt: `examples/demo-kampagne/campaign.json`.

```json
{
  "id": "demo-kampagne",
  "name": "Demo-Kampagne",
  "domain": null,
  "baseVideo": "base.mp4",
  "output": { "width": 1280, "height": 720, "fps": 24 },
  "bubble": { "corner": "bottom-right", "diameterPct": 30, "marginPct": 4 },
  "pages": [
    { "start": 0, "end": 4, "type": "website", "variable": "website_0", "label": "Demo-Website" }
  ],
  "leadSchemaMapping": { "website": "capture_url", "originalUid": "originalUid" },
  "landing": {
    "title": "Video für {{first_name}}",
    "text": "Hallo {{company_name}}!",
    "ctaLabel": "Termin buchen",
    "ctaUrl": "https://example.invalid/termin",
    "brandColor": "#111827",
    "imprintUrl": "https://example.invalid/impressum",
    "privacyUrl": "https://example.invalid/datenschutz"
  }
}
```

## Felder

- **Basisvideo** (`baseVideo`, relativer Pfad im Kampagnenverzeichnis): genau ein Video- und ein Audiostream. Seine Länge bestimmt die Gesamtdauer; die Pages müssen sie auf ±0,1 s abdecken.
- **Seiten** (`pages`): lückenlos und aufsteigend ab 0, jede Grenze muss auf ein Frame fallen (`fps`-teiler). Typen:
  - `website`: personalisiert, `variable` (z. B. `website_0`) nimmt pro Lead eine URL auf; Screenshot 1920 px breit, max. 8000 px hoch. Optionales `label` erscheint im Variablenschema.
  - `image`: statisches Bild (`src`, optional fixierte Kopfzeile `header`), einmalig gerendert und für alle Leads wiederverwendet.
  - `url`: feste URL, einmalig aufgenommen.
  - Optionales `scroll`: Liste `[start, ende, pixel]` (seitenlokale Sekunden, vorzeichenbehaftete Pixel, max. 100, geordnet, mit weicher Beschleunigung). Ohne Angabe scrollt die Seite gleichmäßig durch.
- **Bubble**: runde Facecam aus dem zeitlich passenden Ausschnitt der Basisaufnahme. `corner` (4 Ecken), `diameterPct` (0–80), `marginPct` (0–20, `diameter + 2*margin ≤ 100`), optional `shadowBlurPx` (0–30) und `shadowOpacity` (0–1).
- **Ausgabe** (`output`): gerade Breite/Höhe 2–4096, `fps` 1–60, optionale `videoBitrateKbps` 500–8000 (Standard 4500).
- **Variablen**: Aus den `website`-Pages wird das Variablenschema abgeleitet (`label`, `required: true`, URL-Prüfung). Beim Import übergebene Lead-Felder landen in `variables`; `leadSchemaMapping` ordnet sie Pitchlane-kompatibel zu (`website` → `capture_url`, `originalUid`).
- **Landingpage** (`landing`): `title`/`text`/`ctaLabel` mit `{{variable}}`-Platzhaltern (HTML-escaped), Farben als `#rrggbb`, optionales `logoUrl`, `creatorName`, Calendly-Einbettung (`calendlyEmbedUrl`, nur `calendly.com`-Hosts). `imprintUrl` und `privacyUrl` (Footer-Links, Format http(s) ohne Zugangsdaten) sind technisch optional, rechtlich in DE nötig. `headHtml` (max. 20000 Zeichen) wird nur auf der öffentlichen Seite mit passender Nonce ausgespielt.
- **`priority`** (0–10, Standard 0): höhere Kampagnen werden beim Claim bevorzugt.
- **`domain`** (optional): Host, unter dem die Landingpages dieser Kampagne ausgeliefert werden; sonst gilt `PUBLIC_BASE_URL`.

## Befehle

- `bin/campaign push <verzeichnis>`: validiert die Vorlage und lädt sie auf den Server (`SERVER_URL`, `WORKER_TOKEN`). Die Kampagnen-ID im Pfad muss beim Worker unter `CAMPAIGNS_DIR/<id>/` liegen.
- `bin/campaign render-test <verzeichnis> --website <url> [--screenshot <pfad>]`: rendert lokal ein Testvideo ohne Server und ohne Mux. Ergebnis unter `data/render-tests/<id>-<zeit>/`: `video.mp4`, ein Kontrollbild je Segment, `render-test.json` mit Zeiten und Cache-Key.
