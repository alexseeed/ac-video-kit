# Umzug von Pitchlane

## Was kompatibel ist

Die öffentliche API unter `/api/public/v1` (Header `X-Api-Key`, empfohlen) deckt die Pitchlane-Operationen ab. Der Query-Fallback `apiKey` bleibt aus Kompatibilitätsgründen, kann aber in Proxy-Logs landen – Header bevorzugen:

- `GET /campaigns`, `GET /campaigns/{id}/schema`, `GET /campaigns/{id}/schemas`, `GET /campaigns/{id}/lead-schema-mapping`
- `POST /campaigns/{id}/videos` (Einzelvideo anlegen/aktualisieren)
- `GET /campaigns/{id}/videos` (Liste, `limit`/`offset`)
- `POST /campaigns/{id}/videos/import` und `.../import/v2` (Bulk: `videos[]`, `importId`, `renderTestVideo`, `queueAllVideosForRender`, `duplicateIdentifierField`; Antwort mit `inserted`, `upserted`, `duplicates`, `invalidRows`, `variableIssues`, `testVideoQueued`)
- `GET/POST/PUT/DELETE /webhooks` und `POST/DELETE /campaigns/{id}/webhooks` (kampagnengebunden)
- Alle zehn Trigger: `VIDEO_CREATED`, `VIDEO_RENDERED`, `VIDEO_RENDERED_FULLY` (direkt nach `VIDEO_RENDERED`), `VIDEO_UNRENDERABLE` (bei unerreichbarer Website), `VIDEO_VIEWED`, `VIDEO_FIRST_VIEWED`, `VIDEO_STARTED`, `VIDEO_FIRST_STARTED`, `VIDEO_FINISHED`, `VIDEO_FIRST_FINISHED`
- Webhook-Payloads mit `event`, `eventAt`, `video`/`rawVideo` (Render-Familie) bzw. `viewedAt`, `viewerUrl` (View-Familie), dazu `shortId`, `campaignId`, `variables`, `_backupVariables`, `originalRow`, `videoUrl`, `videoFileUrl`, `thumbnailUrl`, `thumbnailEmbed`.

Nicht nachgebaut sind Pitchlanes private App-Endpunkte. Die Lese-API `/api/platform/v1` und die Worker-Schnittstelle (`/worker/*`, `/admin/*`) sind kit-eigen.

## Schritte

1. **Basis-URL umstellen**: In euren Aufrufern die Pitchlane-Basis-URL auf die eigene Server-URL zeigen lassen, der Pfad `/api/public/v1` bleibt gleich. Als Key einen Wert aus `API_KEYS` verwenden.
2. **Webhooks übernehmen**: Bei Pitchlane `GET /webhooks` aufrufen und das Array als `hooks.json` speichern. Dann erst prüfen, dann anwenden (das Skript kontaktiert nie die Ziel-URLs, maskiert Tokens und ist idempotent):
   ```sh
   SERVER_URL=https://video.example.com API_KEY=<eigener-key> node --import tsx scripts/migrate-webhooks.ts hooks.json --dry-run
   SERVER_URL=https://video.example.com API_KEY=<eigener-key> node --import tsx scripts/migrate-webhooks.ts hooks.json --apply
   ```
   Die Hooks zeigen danach auf dieselben Ziel-URLs und feuern mit denselben Triggern; Empfänger müssen nicht geändert werden.
3. **Kampagnen nachbauen**: Jede Pitchlane-Kampagne als `campaign.json`-Verzeichnis anlegen (`docs/KAMPAGNEN.md`), mit `bin/campaign push` laden und per `bin/campaign render-test` gegenprüfen.
4. **Alte Links bleiben**: Bestehende Pitchlane-Videos und -Landing-URLs bleiben bei Pitchlane und werden nicht migriert. Neue Videos entstehen im Kit, alte laufen aus.
5. **Parallelbetrieb, dann Kündigung**: Beide Systeme eine Zeit lang parallel fahren, Importe, Renders und Webhook-Empfang im Kit prüfen – Pitchlane erst kündigen, wenn der Parallelbetrieb sauber läuft.
