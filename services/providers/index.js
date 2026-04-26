// Provider-Resolver für die Hauptpipeline (role='main') und den
// Entity Optimizer (role='optimizer').
//
// Beide Pipelines nutzen dieselbe Adapter-Schicht — getrennt sind nur
// Provider-Auswahl und Modell-Override (CLAUDE.md: "Two independent AI
// pipelines"). Optimizer fällt auf den Hauptpipeline-Provider zurück,
// wenn OPTIMIZER_AI_PROVIDER nicht gesetzt ist.

const config = require('../../config/config');
const openaiCompatible = require('./openaiCompatible');
const ollama = require('./ollama');
const anthropic = require('./anthropic');
const gemini = require('./gemini');
const perplexity = require('./perplexity');

const SUPPORTED_MAIN = ['openai', 'ollama', 'custom', 'azure', 'anthropic'];
const SUPPORTED_OPTIMIZER = [
  'openai', 'ollama', 'custom', 'azure', 'anthropic', 'gemini', 'perplexity'
];

function resolveMainProvider(name) {
  return (name || config.aiProvider || 'openai').toLowerCase();
}

function resolveOptimizerProvider() {
  const explicit = (process.env.OPTIMIZER_AI_PROVIDER || '').toLowerCase();
  if (explicit) return explicit;
  return resolveMainProvider();
}

function modelFor(provider, role) {
  if (role === 'optimizer') {
    switch (provider) {
      case 'openai':     return process.env.OPTIMIZER_OPENAI_MODEL     || config.openai.model;
      case 'anthropic':  return process.env.OPTIMIZER_ANTHROPIC_MODEL  || config.anthropic.model;
      case 'gemini':     return process.env.OPTIMIZER_GEMINI_MODEL     || config.gemini.model;
      case 'perplexity': return process.env.OPTIMIZER_PERPLEXITY_MODEL || config.perplexity.model;
      default:           return null; // ollama/custom/azure share with main
    }
  }
  return null;
}

function build(provider, role) {
  const optimizerOverride = modelFor(provider, role);
  switch (provider) {
    case 'openai':
      if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY missing');
      return openaiCompatible.create({
        provider: 'openai',
        apiKey: config.openai.apiKey,
        model: optimizerOverride || config.openai.model,
      });

    case 'custom':
      if (!config.custom.apiUrl) throw new Error('CUSTOM_BASE_URL missing');
      return openaiCompatible.create({
        provider: 'custom',
        apiKey: config.custom.apiKey,
        baseURL: config.custom.apiUrl,
        model: config.custom.model,
      });

    case 'azure':
      if (!config.azure.apiKey || !config.azure.endpoint) {
        throw new Error('Azure config missing (AZURE_API_KEY / AZURE_ENDPOINT)');
      }
      return openaiCompatible.create({
        provider: 'azure',
        isAzure: true,
        apiKey: config.azure.apiKey,
        endpoint: config.azure.endpoint,
        deploymentName: config.azure.deploymentName,
        apiVersion: config.azure.apiVersion,
      });

    case 'ollama':
      return ollama.create({
        host: config.ollama.apiUrl,
        model: config.ollama.model,
      });

    case 'anthropic':
      if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY missing');
      return anthropic.create({
        apiKey: config.anthropic.apiKey,
        model: optimizerOverride || config.anthropic.model,
      });

    case 'gemini':
      if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY missing');
      return gemini.create({
        apiKey: config.gemini.apiKey,
        model: optimizerOverride || config.gemini.model,
      });

    case 'perplexity':
      if (!config.perplexity.apiKey) throw new Error('PERPLEXITY_API_KEY missing');
      return perplexity.create({
        apiKey: config.perplexity.apiKey,
        model: optimizerOverride || config.perplexity.model,
      });

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

function resolveProvider({ provider, role = 'main' } = {}) {
  const supported = role === 'optimizer' ? SUPPORTED_OPTIMIZER : SUPPORTED_MAIN;
  const resolved = role === 'optimizer'
    ? (provider || resolveOptimizerProvider())
    : resolveMainProvider(provider);

  if (!supported.includes(resolved)) {
    throw new Error(`Provider '${resolved}' not supported for role '${role}'. Supported: ${supported.join(', ')}`);
  }
  return build(resolved, role);
}

module.exports = {
  resolveProvider,
  SUPPORTED_MAIN,
  SUPPORTED_OPTIMIZER,
};
