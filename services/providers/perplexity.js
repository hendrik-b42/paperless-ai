// Perplexity Provider-Adapter.
//
// Perplexity-API ist OpenAI-kompatibel (chat.completions.create). Wir
// reuse den openaiCompatible-Adapter mit fest verdrahteter baseURL.

const openaiCompatible = require('./openaiCompatible');

function create(opts) {
  return openaiCompatible.create({
    provider: 'perplexity',
    apiKey: opts.apiKey,
    baseURL: 'https://api.perplexity.ai',
    model: opts.model,
  });
}

module.exports = { create };
