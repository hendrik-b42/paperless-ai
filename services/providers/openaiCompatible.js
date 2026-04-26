// OpenAI-kompatibler Provider-Adapter.
// Wird von OpenAI, Custom (selbst-gehostete OpenAI-Forks), Azure und
// Perplexity (API ist OpenAI-kompatibel) wiederverwendet.
//
// Verträgt Token-Metering aus der `usage`-Antwort (alle drei verlinkten
// APIs liefern es analog), respektiert AI_TEMPERATURE='' (Parameter wird
// dann komplett ausgelassen — Moonshot/Kimi rejecten ihn) und kennt
// o3-mini (kein temperature-Parameter zulässig).

const OpenAI = require('openai');

function buildClient(opts) {
  if (opts.isAzure) {
    const baseURL = `${opts.endpoint.replace(/\/$/, '')}/openai/deployments/${opts.deploymentName}`;
    return new OpenAI({
      apiKey: opts.apiKey,
      baseURL,
      defaultQuery: { 'api-version': opts.apiVersion },
      defaultHeaders: { 'api-key': opts.apiKey },
    });
  }
  if (opts.baseURL) {
    return new OpenAI({ apiKey: opts.apiKey || 'placeholder', baseURL: opts.baseURL });
  }
  return new OpenAI({ apiKey: opts.apiKey });
}

function pickTemperature(model, requested) {
  if (model === 'o3-mini') return undefined;
  if (requested !== undefined) return requested;
  if (process.env.AI_TEMPERATURE === '') return undefined;
  if (process.env.AI_TEMPERATURE !== undefined) {
    const parsed = parseFloat(process.env.AI_TEMPERATURE);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return 0.3;
}

function create(opts) {
  const client = buildClient(opts);
  const provider = opts.provider || 'openai';
  const model = opts.isAzure ? opts.deploymentName : opts.model;

  return {
    async chat({ system, messages = [], temperature, responseFormat } = {}) {
      const finalMessages = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;

      const request = {
        model,
        messages: finalMessages,
      };
      const t = pickTemperature(model, temperature);
      if (t !== undefined) request.temperature = t;
      if (responseFormat === 'json' || responseFormat === 'json_object') {
        request.response_format = { type: 'json_object' };
      }

      const response = await client.chat.completions.create(request);
      const text = response?.choices?.[0]?.message?.content || '';
      const usage = response?.usage || {};
      return {
        text,
        usage: {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        },
        raw: response,
      };
    },

    describe() {
      return { provider, model };
    },

    async checkStatus() {
      try {
        await client.models.list();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    // Internal handle for callers that need the raw OpenAI client (e.g. for
    // multi-turn retries that re-send the conversation). The pipeline uses
    // this for the empty-tags-retry path.
    _client: client,
  };
}

module.exports = { create };
