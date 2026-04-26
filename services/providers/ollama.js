// Ollama Provider-Adapter (offizielles ollama-Paket).
//
// Ollama-Spezifika:
//   - Lokal gehostete Modelle, OpenAI-kompatible chat-API via SDK
//   - Token-Metering ist unzuverlässig — wir liefern char/4-Estimation,
//     wie zuvor in ollamaService.js
//   - response_format: 'json_object' wird als `format: 'json'` an Ollama
//     gemappt (viele kleinere Modelle ignorieren es trotzdem — Pipeline
//     hat darum den text→regex→sanitize-Fallback im Response-Parser)

const { Ollama } = require('ollama');

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function create(opts) {
  const client = new Ollama({ host: opts.host });
  const model = opts.model;

  return {
    async chat({ system, messages = [], temperature, responseFormat } = {}) {
      const finalMessages = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;

      const request = {
        model,
        messages: finalMessages,
      };
      if (responseFormat === 'json' || responseFormat === 'json_object') {
        request.format = 'json';
      }
      const options = {};
      if (temperature !== undefined) options.temperature = temperature;
      if (Object.keys(options).length) request.options = options;

      const response = await client.chat(request);
      const text = response?.message?.content || '';

      // Ollama liefert prompt_eval_count + eval_count nur teilweise.
      // Fallback auf char/4-Estimation, kompatibel mit dem alten Service.
      const promptTokens =
        response?.prompt_eval_count ??
        estimateTokens(finalMessages.map(m => m.content).join(' '));
      const completionTokens = response?.eval_count ?? estimateTokens(text);

      return {
        text,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        raw: response,
      };
    },

    describe() {
      return { provider: 'ollama', model };
    },

    async checkStatus() {
      try {
        await client.list();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  };
}

module.exports = { create };
