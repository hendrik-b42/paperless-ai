// Anthropic Claude Provider-Adapter (offizielles SDK).
//
// Anthropic-Spezifika:
//   - System-Prompt ist ein eigener Top-Level-Parameter (NICHT in messages[])
//   - max_tokens ist erforderlich
//   - kein response_format-Parameter — JSON-Ausgabe wird per System-Prompt
//     erzwungen (analog zum Optimizer-Use heute)
//   - Token-Metering via usage.input_tokens / usage.output_tokens

const Anthropic = require('@anthropic-ai/sdk');

function create(opts) {
  const client = new Anthropic.Anthropic({ apiKey: opts.apiKey });
  const model = opts.model;
  const maxTokens = opts.maxTokens || 4096;

  return {
    async chat({ system, messages = [], temperature } = {}) {
      // Anthropic erlaubt keine system-Rolle in messages[]; wenn Caller das
      // tut, ziehen wir sie raus.
      const filteredMessages = messages.filter(m => m.role !== 'system');
      const systemFromMessages = messages
        .filter(m => m.role === 'system')
        .map(m => m.content)
        .join('\n\n');
      const finalSystem = [system, systemFromMessages].filter(Boolean).join('\n\n');

      const request = {
        model,
        max_tokens: maxTokens,
        messages: filteredMessages,
      };
      if (finalSystem) request.system = finalSystem;
      if (temperature !== undefined) request.temperature = temperature;

      const response = await client.messages.create(request);
      const text = (response.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('');
      const usage = response.usage || {};
      const promptTokens = usage.input_tokens || 0;
      const completionTokens = usage.output_tokens || 0;
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
      return { provider: 'anthropic', model };
    },

    async checkStatus() {
      try {
        // Cheapest possible probe: 1-token completion against the cheapest
        // current model. Auth-failures and quota-issues surface here.
        await client.messages.create({
          model: 'claude-3-5-haiku-latest',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  };
}

module.exports = { create };
