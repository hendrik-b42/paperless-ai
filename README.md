# Paperless-AI (hendrik-b42 fork)

> **This is a community fork of [clusterzx/paperless-ai](https://github.com/clusterzx/paperless-ai).**
>
> It is **not affiliated with or endorsed by the upstream project.** All
> original source code and documentation remain under their original MIT
> License; see `LICENSE` for details. This fork adds features and fixes, is
> provided as-is, and is independently maintained.

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Upstream](https://img.shields.io/badge/upstream-clusterzx%2Fpaperless--ai-lightgrey)](https://github.com/clusterzx/paperless-ai)

---

## What's different in this fork

- **Entity Optimizer**: finds and consolidates duplicate correspondents, tags
  and document types in Paperless-NGX. Deterministic normalization + fuzzy
  clustering + optional LLM verification. Merge with dry-run and rollback.
  Ignore list for permanent false positives.
- **Maintenance module**: orphan tracking cleanup, full reset, tag/document-
  type wipe with preserve list, tag statistics, saved-view automation for
  tax years.
- **Improved prompt injection**: existing taxonomy now passed to the LLM as
  a structured, frequency-sorted list positioned after the system prompt.
  Always injected regardless of restriction flags (upstream conditionally
  omitted it). See `CHANGELOG.md` → "Improved existing-taxonomy injection".
- **Multi-provider LLM for optimizer**: OpenAI, Anthropic, Gemini,
  Perplexity, Azure, Ollama, Custom. Independently configurable via
  `OPTIMIZER_AI_PROVIDER`.
- **Sync check**: periodic background analysis with sidebar badge showing
  pending cluster count.
- **Several upstream bug fixes**: Docker build (`npm ci` → `npm install`),
  `start-services.sh` now honors `RAG_SERVICE_ENABLED`, axios client has a
  configurable timeout to prevent silent deadlocks on slow Paperless-NGX,
  Manual-tab now uses the same prompt pipeline as the automated scan,
  empty-tags LLM responses trigger an auto-retry.

Full list: see [`CHANGELOG.md`](CHANGELOG.md).

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md) — complete list of changes against
  upstream v3.0.9
- [`OPTIMIZER.md`](OPTIMIZER.md) — end-user guide to the Entity Optimizer
- [`CUSTOM_PROMPT_TEMPLATE.md`](CUSTOM_PROMPT_TEMPLATE.md) — reference
  template for the custom system prompt (strict taxonomy + German tax
  categorization rules)
- [`docker-compose.example.yml`](docker-compose.example.yml) — example
  compose file for self-building this fork

## Quick start (self-building Docker image)

```bash
git clone https://github.com/hendrik-b42/paperless-ai.git
cd paperless-ai
cp docker-compose.example.yml docker-compose.yml
cp .env.portainer.example .env
# edit .env: PAPERLESS_API_URL, PAPERLESS_API_TOKEN, OPENAI_API_KEY, JWT_SECRET
docker compose up -d --build
```

Then open `http://<your-host>:3000/` and follow the setup wizard.

## Requirements

Node.js 22 LTS (matches the Dockerfile base image), Paperless-NGX ≥ 2.0,
one LLM provider (OpenAI / Anthropic / Gemini / Perplexity / Azure / Ollama
/ any OpenAI-compatible endpoint).

## Upstream

Original project maintained by [@clusterzx](https://github.com/clusterzx)
until November 2025. See the upstream README for the original feature list
and broader context. This fork builds on v3.0.9.

**Do not open upstream issues from this fork.** Use
[this fork's issue tracker](https://github.com/hendrik-b42/paperless-ai/issues)
for problems or feature requests that only apply here. For upstream-only
issues, please report them at
[clusterzx/paperless-ai](https://github.com/clusterzx/paperless-ai).

## License

MIT — see [`LICENSE`](LICENSE). Original copyright © 2024 clusterzx.
Modifications © 2026 hendrik-b42.

---

## Contributing

PRs welcome, especially for upstream-independent improvements. Before
submitting:

1. Run `node --check` on any changed JS file.
2. Follow the existing code style (no formatter is enforced; match
   surrounding code).
3. Describe the change and link any related upstream issue in the PR.
