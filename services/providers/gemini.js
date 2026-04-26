// Google Gemini Provider-Adapter (@google/genai SDK).
//
// Gemini-Spezifika:
//   - Nutzt `contents` statt `messages` (parts-basiertes Format)
//   - System-Prompt via `config.systemInstruction`
//   - JSON-Output via `config.responseMimeType: 'application/json'`
//   - Token-Metering via response.usageMetadata

const { GoogleGenAI } = require('@google/genai');

function rolesToContents(messages) {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

function create(opts) {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model;

  return {
    async chat({ system, messages = [], temperature, responseFormat } = {}) {
      const contents = rolesToContents(messages);
      const systemFromMessages = messages
        .filter(m => m.role === 'system')
        .map(m => m.content)
        .join('\n\n');
      const finalSystem = [system, systemFromMessages].filter(Boolean).join('\n\n');

      const config = {};
      if (finalSystem) config.systemInstruction = finalSystem;
      if (temperature !== undefined) config.temperature = temperature;
      if (responseFormat === 'json' || responseFormat === 'json_object') {
        config.responseMimeType = 'application/json';
      }

      const response = await client.models.generateContent({
        model,
        contents,
        config: Object.keys(config).length ? config : undefined,
      });

      const text = response.text || '';
      const usage = response.usageMetadata || {};
      return {
        text,
        usage: {
          promptTokens: usage.promptTokenCount || 0,
          completionTokens: usage.candidatesTokenCount || 0,
          totalTokens: usage.totalTokenCount || 0,
        },
        raw: response,
      };
    },

    describe() {
      return { provider: 'gemini', model };
    },

    async checkStatus() {
      try {
        await client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          config: { maxOutputTokens: 5 },
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  };
}

module.exports = { create };
