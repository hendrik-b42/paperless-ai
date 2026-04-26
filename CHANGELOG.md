# Changelog — Entity Optimizer & Infrastructure Hardening

Paperless-AI Fork · Feature set built on top of upstream v3.0.9

This document describes all changes made against the upstream
`clusterzx/paperless-ai` baseline. It is structured for review / PR submission.

## Summary

A single, coherent feature set: a new "Entity Optimizer" module that finds and
consolidates duplicates in Paperless-NGX metadata (correspondents, tags,
document types) via a hybrid pipeline (deterministic normalization + fuzzy
clustering + LLM verification). Plus a maintenance module, a periodic sync
check, improved prompt injection, and several upstream bugfixes.

Design principles:

- **Minimal dependency footprint.** The original Optimizer feature shipped
  on the existing stack (axios, openai, better-sqlite3, node-cron, express,
  ejs). The later AI-Service consolidation deliberately added three official
  provider SDKs (`@anthropic-ai/sdk`, `@google/genai`, `ollama`) — see the
  "AI-Service Konsolidierung" section below for the rationale.
- **Backwards compatible.** DB changes use `CREATE TABLE IF NOT EXISTS`;
  existing users need no migration.
- **JWT-protected API.** All destructive endpoints require authentication.
- **Generic entity abstraction.** Same code path handles correspondents, tags
  and document types via adapter pattern.
- **Safe by default.** Dry-run for all merges, full backup to server log on
  destructive operations, rollback capability.

## New features

### Entity Optimizer

A three-stage consolidation pipeline for Paperless-NGX metadata, exposed via a
new sidebar menu item "Optimizer" and a set of JWT-protected API endpoints.

- **Stage 1 — Normalization.** Strips legal forms (GmbH, AG, SARL, …), TLDs
  (`.de`, `.com`, …), regional qualifiers (Deutschland, EU, …), folds umlauts,
  normalizes punctuation. Identical normalized keys form safe clusters without
  LLM involvement.
- **Stage 2 — Fuzzy clustering.** Union-Find over Levenshtein-ratio and
  token-set-ratio above a configurable threshold (default 0.85).
- **Stage 3 — LLM verification.** Per cluster, one structured JSON call that
  decides merge/no-merge and chooses a canonical name. Context (document
  counts, sample titles) is passed in so the LLM can disambiguate similar
  names like "Sparkasse Köln" vs "Sparkasse Bonn".

Additional functionality:

- **Review UI** with three tabs (Analyse / Verlauf / Ignorier-Liste /
  Wartung). Per-cluster: editable canonical name, per-member merge checkbox,
  dry-run, execute, permanently ignore.
- **Merge execution** uses Paperless-NGX `/documents/bulk_edit/` where
  available, falls back to per-document PATCH. Rollback is supported —
  deleted entities are recreated with their original names and affected
  documents are re-reassigned.
- **Ignore list** stores entity-pair tuples permanently so a cluster cannot
  resurface in future runs.
- **Generic entity abstraction** via `ADAPTERS` object in
  `entityOptimizerService.js`. Three entity types supported:
  `correspondent` (single-ref), `tag` (multi-ref, uses `modify_tags`),
  `document_type` (single-ref).

### Multi-provider LLM verifier

`services/optimizerAiService.js` — a provider-agnostic wrapper for the
Entity Optimizer's LLM calls. Supports:

- OpenAI (default, reuses existing `OPENAI_API_KEY`)
- Anthropic Claude (new: `ANTHROPIC_API_KEY`)
- Google Gemini (new: `GEMINI_API_KEY`)
- Perplexity (new: `PERPLEXITY_API_KEY`)
- Azure OpenAI (reuses existing `AZURE_*` config)
- Ollama (reuses existing `OLLAMA_*` config)
- Custom OpenAI-compatible (reuses existing `CUSTOM_*` config)

Provider is selectable per-optimizer via `OPTIMIZER_AI_PROVIDER`, falls back
to the global `AI_PROVIDER`. All providers return the same normalized JSON
(`{ merge, canonical, confidence, reason }`). Conservative fallback: if the
LLM is unreachable, the cluster is left as `pending` and the user decides
manually.

### Periodic sync check

A background cron job (default every 12h, configurable via
`OPTIMIZER_SYNC_CRON`) that runs the full analysis pipeline for
correspondents, tags, and document types, and stores pending suggestions in
SQLite. A small badge on the Optimizer sidebar link shows the count of open
clusters, so users know when consolidation work is waiting without having to
manually open the page. Can be triggered on-demand from the Wartung tab.

### Maintenance module

A fourth tab "Wartung" inside the Optimizer page providing operational
maintenance actions that were previously only possible by hand-editing the
SQLite database or running bulk operations in Paperless-NGX directly.

- **Status dashboard.** Shows Paperless-NGX document / correspondent / tag
  counts vs. the internal `processed_documents` count with diff — surfaces
  tracking drift (e.g. negative `unprocessed` values caused by deleted
  Paperless documents).
- **Orphan cleanup.** Removes entries from the internal tracking tables for
  documents no longer present in Paperless-NGX. Non-destructive on the
  Paperless side.
- **Tracking reset.** Clears `processed_documents` and `processing_status`;
  the next Paperless-AI scan will treat every document as unprocessed and
  re-analyze it with the current custom prompt. History and original data are
  preserved. Intended for prompt rollouts.
- **Tag statistics + orphan delete + full wipe.** View a distribution of
  tag usage (0 / 1-2 / 3-10 / 11+ documents), delete tags without document
  assignments, or wipe all tag-to-document relations (optionally deleting the
  tag definitions themselves, with a configurable preserve list e.g.
  `ai-processed`). Full JSON backup of all removed relations is dumped to the
  container log.
- **Document-type statistics + orphan delete + full wipe.** Analogous to the
  tag functions for document_type. Uses `document_type = null` on documents
  during wipe (single-ref field).
- **Saved-Views automation.** Creates nine Saved Views in Paperless-NGX for
  a given tax year (Werbungskosten, Betriebsausgabe, Sonderausgabe, Haushaltsnah,
  AussergewoehnlicheBelastung, Kapitaleinkuenfte, Kinderbetreuung, Schulgeld,
  plus a combined "Alle"-view). Idempotent — skips views that already exist
  and categories whose tags don't exist yet. Uses Paperless-NGX's
  `/api/saved_views/` endpoint with `rule_type: 6` (any of these tags).

### Improved existing-taxonomy injection into AI prompts

`services/openaiService.js` — the way existing tags / correspondents /
document types were passed to the LLM has been rewritten.

Before (upstream):

```
Pre-existing tags: <comma-separated names>
Pre-existing correspondents: <comma-separated names>
Pre-existing document types: <comma-separated names>
<SYSTEM_PROMPT>
<mustHave JSON schema>
```

with three problems:

1. Injected **before** the system prompt, so the LLM reads a long list
   before it sees the rules that govern how to use it.
2. No frequency / document count signal — the LLM treats a one-off typo tag
   the same as a core concept tag.
3. Conditionally injected only when
   `useExistingData=yes && restrictToExistingTags=no &&
   restrictToExistingCorrespondents=no`. When a user enabled the restriction
   flags, the taxonomy list disappeared from the prompt entirely —
   counterproductive because restrictions need the list to be useful.

After:

```
<SYSTEM_PROMPT>
=== EXISTING TAXONOMY (use these EXACT names ...) ===
Numbers in parentheses = how many documents currently use that name.

Existing tags (sorted by frequency):
  - ai-processed (3064)
  - Rechnung (203)
  - Werbungskosten 2024 (147)
  ...
  - ... und X weitere seltener verwendete (Top-100 shown)

Existing correspondents (sorted by frequency):
  ...

Existing document types (sorted by frequency):
  ...
=== END TAXONOMY ===
<mustHave JSON schema>
```

- Injected **after** the system prompt, so the LLM has the rules fresh in
  context when it scans the list.
- Sorted by frequency and annotated with document counts — LLM picks
  high-frequency names first, avoiding fragmentation into near-duplicates.
- Top-N per category (Tags: 100, Correspondents: 60, Document types: 40) with
  a "... und X weitere" marker. Keeps prompt size bounded.
- Injected **regardless** of restriction flags (fixes the counterproductive
  conditional above).
- Backwards-compatible: falls back to legacy string arrays if the
  new `options.existingTagsWithCounts` / `-CorrespondentsWithCounts` /
  `-DocumentTypesWithCounts` aren't provided by the caller.

### AI-Service Konsolidierung

The four parallel main-pipeline services (`openaiService`, `customService`,
`azureService`, `ollamaService`) and the Optimizer's inline multi-provider
dispatcher (`optimizerAiService`) shared 380–680 lines of duplicated
boilerplate per file. Bugfixes and feature work landed only in
`openaiService` (e.g. empty-tags retry, structured taxonomy injection)
and silently drifted out of sync with the clones.

The refactor extracts a thin **provider-adapter layer** under
`services/providers/` (one adapter per provider family, all conforming to
`{ chat, describe, checkStatus }`) and a single provider-agnostic
**document-analysis pipeline** (`services/aiPipeline.js`). Both the
main scan and the Optimizer's `verifyCluster` now go through the same
adapter layer, but the two pipelines (`aiPipeline` vs. Optimizer's
cluster-verify flow) stay separate — respecting the original CLAUDE.md
rule "Two independent AI pipelines, each with its own factory".

Concrete changes:

- **New**: `services/providers/{openaiCompatible,ollama,anthropic,gemini,
  perplexity,index}.js` — provider adapters and resolver
- **New**: `services/aiPipeline.js` — document-analysis orchestrator
  (thumbnail caching, structured taxonomy block, `RestrictionPromptService`
  integration, token budgeting, empty-tags retry, response parsing). All
  fork features from `openaiService` are now active for **every** provider.
- **Rewritten**: `services/aiServiceFactory.js` — thin dispatcher that
  binds the resolved adapter to the pipeline. Backward-compatible API.
- **Rewritten**: `services/optimizerAiService.js` — same JSON schema as
  before (`{ merge, canonical, confidence, reason }`), but the inline
  axios calls for OpenAI/Anthropic/Gemini/Perplexity/Azure/Ollama/Custom
  are gone. All seven providers now go through `services/providers/*`.
- **Updated**: `routes/manual.js` — removed the 4-way `if/else` over
  `process.env.AI_PROVIDER` for `/manual/analyze` and `/manual/playground`;
  both now go through the factory like the main scan.
- **Deleted**: `services/{openaiService,customService,azureService,
  ollamaService}.js`.
- **New**: Anthropic Claude as a 5th main-pipeline provider
  (`AI_PROVIDER=anthropic`). UI option in setup wizard and settings page;
  `setupService.validateAnthropicConfig()` mirrors the existing OpenAI/
  Azure validators.
- **New**: GUI for Optimizer-provider configuration. The settings page now
  has an "Optimizer (Erweitert)" section where the optimizer's provider
  and per-provider model can be overridden without editing `data/.env`.
  Default is "Wie Hauptpipeline" (i.e. `OPTIMIZER_AI_PROVIDER` is left
  empty and the optimizer falls back to `AI_PROVIDER`).
- **New env vars**: `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL`
  (model overrides for the main pipeline; the Optimizer overrides
  `OPTIMIZER_*_MODEL` already existed).
- **Three new npm dependencies**: `@anthropic-ai/sdk`, `@google/genai`,
  `ollama`. The earlier "no new npm dependencies" rule has been
  deliberately relaxed — official SDKs give us prompt caching, auto-retries,
  proper API-version headers and type safety. Perplexity reuses the
  existing `openai` SDK (its API is OpenAI-compatible).

Side effect: Empty-tags-retry and the structured taxonomy block are now
active for **all** providers. Previously they were OpenAI-only — Custom
and Azure (which were 95 % copies of `openaiService`) had silently drifted
out of sync. The consolidation propagates the fix.

### Custom-provider presets in the UI

Both the setup wizard and the settings page now offer a preset dropdown
inside the "Custom" provider block. Picking a preset auto-fills Base URL
and Model; the user only needs to paste their API key. Auto-detect on
load: when the saved Base URL matches a known preset, the dropdown
pre-selects it.

Presets:
- **Perplexity** — `https://api.perplexity.ai` / `sonar`
- **DeepSeek** — `https://api.deepseek.com/v1` / `deepseek-chat`
- **Moonshot / Kimi** — `https://api.moonshot.cn/v1` / `moonshot-v1-128k`
- **Manual configuration** (default — leaves the fields untouched)

Pure UI helper; the saved state is the same `CUSTOM_BASE_URL` +
`CUSTOM_MODEL` env vars as before. No backend changes. Perplexity stays
available as a dedicated Optimizer provider as well
(`OPTIMIZER_AI_PROVIDER=perplexity`) — the two paths are independent.

## Bugfixes

### Dockerfile: `npm ci` fails because no valid lockfile

The upstream `Dockerfile` uses `RUN npm ci --only=production`, but the repo
ships with `package-lock.json.bak` rather than a current `package-lock.json`.
`npm ci` fails on every build.

Replaced with `npm install --omit=dev --no-audit --no-fund`, which works
without a lockfile and also updates the deprecated `--only=production` flag.

### `start-services.sh`: RAG_SERVICE_ENABLED is ignored

The upstream script unconditionally starts the Python RAG service and
overwrites the user's `RAG_SERVICE_ENABLED` setting on line 18
(`export RAG_SERVICE_ENABLED="true"`). This causes:

- Hugging Face model downloads on every container start (~560 MB:
  `paraphrase-multilingual-MiniLM-L12-v2` + `cross-encoder/ms-marco-MiniLM-L-6-v2`)
- ~1-2 GB extra RAM consumption permanently
- Unexpected outbound requests to `huggingface.co`

Rewritten: the script now honors `RAG_SERVICE_ENABLED` from the env. If
disabled, Python is not started, no models downloaded, log message emitted.
The unconditional env override was removed.

### Manual-Tab bypassed the improved prompt injection

The `/manual/analyze` endpoint in `routes/setup.js` — used by the "Analyze with
AI" button in the Manual tab — called `analyzeDocument` with only 5 arguments,
omitting the `options` parameter that carries the new
`existingTagsWithCounts` / `-CorrespondentsWithCounts` /
`-DocumentTypesWithCounts` structured taxonomy (Fix B). This meant manual
analyses used the legacy comma-separated string path with no frequency signal,
while the automated scan used the new structured path. Testing an individual
document in the Manual tab therefore did not reflect what the automated
scan would produce.

Fixed by loading the same `WithCount` variants used in `server.js` and passing
the full `taxonomyOptions` object through to all four AI provider adapters
(`openaiService`, `ollamaService`, `customService`, `azureService`). The
Manual-tab path is now byte-identical to the automated path in terms of what
the LLM sees.

### Empty-tags LLM response left undetected in logs

When the LLM returned `tags: []` (too-conservative prompt, empty taxonomy,
etc.), Paperless-AI silently stored zero tags on the document without any
warning. Added a `[WARN] LLM returned ZERO tags for document "..."` log line
in `buildUpdateData` so this condition is visible for prompt-tuning.

### Auto-retry for empty-tags LLM responses (openaiService)

On top of the warning above, `openaiService.analyzeDocument` now detects an
empty `tags` array in the LLM response and issues exactly one conversational
follow-up with a correction message, asking the model to comply with the
"Hard minimum: 1 topical tag" rule. The follow-up is sent as an
`assistant` + `user` turn appended to the original conversation, so OpenAI's
prompt caching kicks in and the retry is roughly 15–20% the cost of a fresh
call. Token metrics are cumulative. The retry is on by default and can be
disabled with `AI_EMPTY_TAGS_RETRY=no`.

### #935 — Dashboard TypeError when `window.dashboardData` is missing

`public/js/dashboard.js` and `public/js/manual.js` destructured
`window.dashboardData` without a null-guard; during setup flow or race
conditions this threw `Cannot destructure property 'documentCount' of
undefined`. Added defensive default (`|| {}`) plus `Math.max(0, …)` around
the subtraction so a negative diff never renders as a bogus chart value.

### #925 — `Scan Now` fails with "Failed to get own user ID"

`paperlessService.getOwnUserID()` hard-required `PAPERLESS_USERNAME` to
match one of the returned users by exact string. If the env var was empty
or mismatched, the function returned `null` and all scan flows aborted.
Fixed by falling back to the first entry in the `current_user=true`
response (which is always the token's own user). Explicit username match
still works when set.

### #927 / #933 — Configurable AI temperature

The upstream code hardcoded `temperature: 0.3` in openai, azure and custom
services, which breaks non-OpenAI-compatible providers (Moonshot, Kimi).
Introduced `AI_TEMPERATURE` env variable (default `0.3`). Setting it to
empty string omits the parameter entirely, for providers that don't
support it.

### #937 / #931 — Custom fields crash on non-string + European decimals

`customField.value?.trim()` threw when the LLM returned a number instead of
a string, and monetary fields silently failed when the LLM used European
decimal notation (`1.234,56`). Added `normalizeNumericFieldValue()` helper
that accepts both `.` and `,` as decimal separator, strips currency symbols
and thousand separators, and handles the `monetary` / `integer` / `float`
data types correctly. Non-numeric coercion uses `String()` instead of `?.`.

### Paperless HTTP client: no timeout → deadlock on slow/unresponsive Paperless-NGX

`services/paperlessService.js` creates an `axios` client without a timeout.
Default axios behaviour is to wait forever. If Paperless-NGX becomes slow or
unresponsive mid-scan, the entire `processDocument`-loop deadlocks on the
PATCH call — no error, no retry, silent stall.

Added a configurable timeout (default 60000ms, tunable via
`PAPERLESS_HTTP_TIMEOUT_MS`). Plus detailed logging around the PATCH call
(duration in ms, error code, HTTP status, response body) so future issues
surface with actionable info instead of silent hangs.

## New SQLite schema

Three new tables added to `models/document.js`. All use `entity_type` columns
so the same schema serves `correspondent` / `tag` / `document_type` —
no migration needed when new entity types are added later.

```sql
CREATE TABLE IF NOT EXISTS optimizer_ignore (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id_a INTEGER NOT NULL,
  entity_id_b INTEGER NOT NULL,
  name_a TEXT,
  name_b TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_type, entity_id_a, entity_id_b)
);

CREATE TABLE IF NOT EXISTS optimizer_suggestions (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  canonical_name TEXT,
  canonical_id INTEGER,
  members_json TEXT NOT NULL,
  confidence REAL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_type, cluster_key)
);

CREATE TABLE IF NOT EXISTS optimizer_merge_log (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  canonical_id INTEGER,
  merged_entities_json TEXT NOT NULL,
  affected_documents_json TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  rolled_back_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## New API endpoints

All JWT-protected (cookie `jwt` or header `x-api-key` matching `API_KEY`).

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/optimizer` | Page route (uses `isAuthenticated`, redirects to `/login`) |
| POST   | `/api/optimizer/analyze` | Run analysis for `{ entityType, threshold, useLlm, minDocuments }` |
| GET    | `/api/optimizer/suggestions?entityType=...` | Cached pending suggestions |
| POST   | `/api/optimizer/merge` | Execute or dry-run a merge |
| POST   | `/api/optimizer/ignore` | Add cluster to ignore list |
| GET    | `/api/optimizer/ignore?entityType=...` | List ignored pairs |
| DELETE | `/api/optimizer/ignore/:id` | Remove ignore entry |
| GET    | `/api/optimizer/history?entityType=...` | Merge audit log |
| POST   | `/api/optimizer/rollback/:logId` | Roll back a merge |
| GET    | `/api/optimizer/provider` | Show current LLM provider + model |
| GET    | `/api/optimizer/sync-status` | Pending-count summary for badge |
| POST   | `/api/optimizer/sync-run` | Trigger async sync check immediately |
| GET    | `/api/optimizer/maintenance/status` | Paperless vs. internal counts |
| POST   | `/api/optimizer/maintenance/prune-orphans` | Remove tracking for deleted docs |
| POST   | `/api/optimizer/maintenance/reset-tracking` | Clear `processed_documents` |
| GET    | `/api/optimizer/maintenance/tag-stats` | Tag distribution |
| POST   | `/api/optimizer/maintenance/delete-orphan-tags` | Delete tags with 0 docs |
| POST   | `/api/optimizer/maintenance/wipe-all-tags` | Full tag wipe (with preserve list) |
| GET    | `/api/optimizer/maintenance/document-type-stats` | Doc-type distribution |
| POST   | `/api/optimizer/maintenance/delete-orphan-document-types` | Delete types with 0 docs |
| POST   | `/api/optimizer/maintenance/wipe-all-document-types` | Full document-type wipe |
| POST   | `/api/optimizer/maintenance/create-tax-views` | Auto-create tax-year Saved Views |

## New environment variables

All optional, documented in `.env.portainer.example` and `OPTIMIZER.md`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPTIMIZER_AI_PROVIDER` | `AI_PROVIDER` | Provider override for Optimizer only |
| `OPTIMIZER_OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model for cluster verification |
| `OPTIMIZER_ANTHROPIC_MODEL` | `claude-3-5-sonnet-latest` | Anthropic model |
| `OPTIMIZER_GEMINI_MODEL` | `gemini-1.5-pro` | Gemini model |
| `OPTIMIZER_PERPLEXITY_MODEL` | `sonar` | Perplexity model |
| `ANTHROPIC_API_KEY` | — | Required when provider=anthropic |
| `GEMINI_API_KEY` | — | Required when provider=gemini |
| `PERPLEXITY_API_KEY` | — | Required when provider=perplexity |
| `OPTIMIZER_SYNC_ENABLED` | `yes` | Enable periodic sync check |
| `OPTIMIZER_SYNC_CRON` | `0 */12 * * *` | Cron schedule for sync check |
| `OPTIMIZER_SYNC_ON_START` | `no` | Run sync check ~60s after container start |
| `PAPERLESS_HTTP_TIMEOUT_MS` | `60000` | Timeout for Paperless-NGX HTTP client |
| `AI_EMPTY_TAGS_RETRY` | `yes` | Auto-retry with correction prompt when LLM returns `tags: []` |
| `AI_TEMPERATURE` | `0.3` | LLM temperature; empty string omits the parameter entirely |

## File inventory

### New files

```
services/entityOptimizerService.js   Core pipeline: normalization, clustering,
                                     merge execution, rollback, ignore list,
                                     tag/doc-type wipes, saved-views automation
services/optimizerAiService.js       Multi-provider LLM wrapper for Optimizer
routes/optimizer.js                  All /api/optimizer/* and /optimizer routes
views/optimizer.ejs                  Optimizer page with 4 tabs
public/js/optimizer.js               Client-side logic for Optimizer UI
public/js/optimizer-badge.js         Sidebar badge fetcher, included in all
                                     sidebar-having views
OPTIMIZER.md                         End-user docs for the Optimizer
DEPLOY-PORTAINER.md                  Portainer-specific deployment guide
CHANGELOG.md                         This file
docker-compose.portainer.yml        Portainer-ready compose using local build
.env.portainer.example               Env template with new variables
```

### Modified files

```
Dockerfile                           npm ci → npm install (fix)
start-services.sh                    Honor RAG_SERVICE_ENABLED (fix)
server.js                            Mount optimizer routes, scheduled sync
                                     check, pass taxonomy-with-counts into
                                     processDocument/analyzeDocument
services/paperlessService.js         + listTagsWithCount, getDocumentIdsByTag,
                                     bulkModifyTags, modifyDocumentTags,
                                     renameTag, deleteTag, getOrCreateTag,
                                     listDocumentTypesWithCount,
                                     getDocumentIdsByDocumentType,
                                     setDocumentDocumentType,
                                     bulkSetDocumentType, renameDocumentType,
                                     deleteDocumentType, getOrCreateDocumentType,
                                     clearDocumentType, getDocumentIdsByCorrespondent,
                                     setDocumentCorrespondent, bulkSetCorrespondent,
                                     renameCorrespondent, deleteCorrespondent,
                                     getAllDocumentIds, listSavedViews,
                                     createSavedView, deleteSavedView
                                     + axios timeout, + PATCH diagnostics (fix)
services/openaiService.js            Restructured prompt injection (Fix B):
                                     structured taxonomy block with counts,
                                     always injected, positioned after custom
                                     prompt and before mustHave schema
routes/setup.js                      /manual/analyze now passes taxonomy
                                     options (Fix B parity with automated
                                     scan)
models/document.js                   + 3 optimizer tables + 14 helper methods
                                     + orphan-prune, reset-tracking
views/dashboard.ejs                  + Optimizer sidebar link, + badge script
views/manual.ejs                     + Optimizer sidebar link, + badge script
views/chat.ejs                       + Optimizer sidebar link, + badge script
views/playground.ejs                 + Optimizer sidebar link, + badge script
views/history.ejs                    + Optimizer sidebar link, + badge script
views/settings.ejs                   + Optimizer sidebar link, + badge script
```

## Dependencies

**No new npm packages required.** The implementation uses only packages already
present in upstream `package.json`: `axios`, `express`, `openai`,
`better-sqlite3`, `node-cron`, `ejs`, `jsonwebtoken`.

## Migration notes

Users upgrading from upstream v3.0.9 need to do nothing special. The new SQLite
tables are created on first boot via `CREATE TABLE IF NOT EXISTS`. Existing
processed documents, history, and settings are untouched.

Recommended post-upgrade steps:

1. Add `OPENAI_API_KEY` (or other provider key) to `.env` if not already
   present — the Optimizer needs LLM access for the verification stage.
2. Generate a proper `JWT_SECRET`: `openssl rand -hex 32`. The optimizer's
   destructive endpoints require valid JWT auth; the upstream default
   `your-secret-key` is insecure.
3. On first visit to `/optimizer`, the sidebar badge will show 0 until the
   first sync check completes (default: ~12h later, or manually via
   Wartung → Sync-Check jetzt ausführen).

## Screenshots

*(not included in this text changelog — see the rendered UI in `/optimizer`)*

## Tests

The normalization and clustering logic has isolated unit-testable pure
functions under `entityOptimizerService._internal`. A verification run against
sample inputs (Amazon / Baader Bank / Sparkasse branches / Deutsche Bank vs.
Deutsche Bahn) confirms correct behavior:

- `Amazon`, `Amazon.de`, `Amazon EU Sarl` → single cluster ✓
- `Amazon Web Services` → separate ✓ (correct: different legal entity)
- `Sparkasse Köln/Bonn`, `Sparkasse Köln`, `Sparkasse Bonn` → three separate
  clusters ✓ (correct: different branches)
- `Deutsche Bank` and `Deutsche Bank AG` → single cluster ✓
- `Deutsche Bahn` → separate ✓ (correct: different entity)

Tax-tag pattern detection was verified against 26 test cases (13 tax-tags in
both old and new schema, 13 non-tax tags): 26/26 passed.

## Attribution

Built against `clusterzx/paperless-ai` v3.0.9. Fork maintained at
[hendrik-b42/paperless-ai](https://github.com/hendrik-b42/paperless-ai),
April 2026.
