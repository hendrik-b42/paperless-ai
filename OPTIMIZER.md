# Entity Optimizer

Findet doppelte / sehr ähnliche **Korrespondenten** in Paperless-NGX, verifiziert sie per LLM und mergt sie auf Wunsch. Phase 1 deckt Korrespondenten ab; die Architektur ist so gebaut, dass **Tags** und **Document Types** in Phase 2 ohne Refactoring hinzukommen.

## Aufrufen

Sidebar → **Optimizer**. Login per JWT ist erforderlich, weil alle Merge-Routes destruktiv sind.

## Pipeline

1. **Normalisierung** (kostenlos, deterministisch)
   - Umlaute entfalten (`Köln` → `koeln`)
   - Rechtsformen strippen (`GmbH`, `AG`, `Aktiengesellschaft`, `SARL`, `Ltd`, `Inc`, …)
   - TLDs strippen (`.de`, `.com`, …)
   - Regionale Zusätze (`EU`, `Deutschland`, …)
   - → Exakt gleiche normalisierte Schlüssel bilden sichere Cluster

2. **Fuzzy-Matching** (kostenlos)
   - Levenshtein-Ratio + Token-Set-Ratio
   - Standard-Schwelle 0.85 (in der UI einstellbar)

3. **LLM-Verifikation** (kostenpflichtig, pro Cluster ein Call)
   - Entscheidet final ob Merge sinnvoll ist
   - Schlägt kanonischen Ziel-Namen vor
   - Verhindert Fehlmerges wie `Sparkasse Köln` vs `Sparkasse Bonn`

## ENV-Variablen

Diese Variablen gehören in `data/.env` (wie alle bestehenden Paperless-AI-Settings):

| Variable | Default | Zweck |
|----------|---------|-------|
| `OPTIMIZER_AI_PROVIDER` | Wert von `AI_PROVIDER` | Provider nur für den Optimizer überschreiben. Mögliche Werte: `openai`, `anthropic`, `gemini`, `perplexity`, `azure`, `ollama`, `custom` |
| `OPTIMIZER_OPENAI_MODEL` | `gpt-4o-mini` | OpenAI-Modell für Cluster-Verifikation |
| `OPTIMIZER_ANTHROPIC_MODEL` | `claude-3-5-sonnet-latest` | Nur wenn Provider `anthropic` |
| `OPTIMIZER_GEMINI_MODEL` | `gemini-1.5-pro` | Nur wenn Provider `gemini` |
| `OPTIMIZER_PERPLEXITY_MODEL` | `sonar` | Nur wenn Provider `perplexity` |
| `ANTHROPIC_API_KEY` | – | Erforderlich für Anthropic |
| `GEMINI_API_KEY` | – | Erforderlich für Gemini |
| `PERPLEXITY_API_KEY` | – | Erforderlich für Perplexity |
| `OPENAI_API_KEY`, `AZURE_*`, `OLLAMA_*`, `CUSTOM_*` | – | Wie bisher, werden wiederverwendet |

Der Default ist: der Optimizer nutzt den gleichen Provider wie der Rest der App. Wenn du z.B. lokal Ollama für Dokumentenanalyse verwendest, aber für die Korrespondenten-Disambiguierung ein stärkeres Modell willst, setzt du `OPTIMIZER_AI_PROVIDER=openai` und ein Modell deiner Wahl.

## Sicherheit & Rollback

- **Dry-Run-Button** zeigt, wie viele Dokumente betroffen wären – verändert nichts in Paperless.
- **Merge-Log** wird für jede Aktion in SQLite protokolliert (`optimizer_merge_log`).
- **Rollback**: im Tab *Verlauf* kann jeder (nicht-Dry-Run) Merge zurückgerollt werden. Gelöschte Korrespondenten werden in Paperless neu angelegt und die betroffenen Dokumente werden auf die alten Zuordnungen zurückgesetzt. (Achtung: die neuen Korrespondenten-IDs in Paperless sind andere als vor dem Merge – die Zuordnung bleibt aber inhaltlich gleich.)
- **Ignorier-Liste**: pro Cluster kannst du "Dauerhaft ignorieren" klicken. Das Paar taucht in zukünftigen Analysen nie wieder auf.

## API (für Automatisierung / Scheduler)

Alle Endpunkte sind JWT-geschützt (Cookie `jwt` oder Header `x-api-key`).

- `POST /api/optimizer/analyze` – Analyse ausführen, Body: `{ entityType, threshold, useLlm, minDocuments }`
- `GET /api/optimizer/suggestions?entityType=correspondent` – gecachte Vorschläge
- `POST /api/optimizer/merge` – Body: `{ entityType, canonicalId, canonicalName, mergeIds, dryRun, suggestionId }`
- `POST /api/optimizer/ignore` – Body: `{ entityType, memberIds, memberNames, suggestionId }`
- `GET /api/optimizer/ignore` / `DELETE /api/optimizer/ignore/:id`
- `GET /api/optimizer/history`
- `POST /api/optimizer/rollback/:logId`
- `GET /api/optimizer/provider` – aktuell konfigurierter Provider/Modell

## DB-Schema (neu)

- `optimizer_suggestions` – Cache der Cluster aus der letzten Analyse
- `optimizer_ignore` – permanent ignorierte Paare (ungeordnet gespeichert, eindeutige Constraint)
- `optimizer_merge_log` – Audit-Trail für Rollback (enthält vorherige Entity-IDs pro Dokument)

Alle Tabellen haben eine `entity_type`-Spalte (`correspondent` / `tag` / `document_type`), sodass Phase 2 ohne Migration auskommt.

## Phase 2 (Roadmap)

- `services/entityOptimizerService.js` → `ADAPTERS.tag = { ... }` einsetzen (Methoden für tags sind in `paperlessService.js` bereits vorhanden: `getTags`, `processTags`)
- UI-Dropdown `entityType` für `tag` aktivieren
- Sonderbehandlung: Tags haben keine `document_count`-Feld-Antwort bei Paperless – zählen per Filter-Query.

## Phase 3 (Roadmap)

Scheduled analysis über `node-cron` (bereits in `package.json`). Wöchentliche Analyse, Ergebnis per Dashboard-Badge oder E-Mail.
