// Factory: returns an aiPipeline configured with the active provider.
//
// Backward-compatible: callers (server.js, routes/documents-admin.js,
// routes/manual.js) keep using `getService().analyzeDocument(...)` etc.
// What used to be four singleton service classes is now one pipeline
// orchestrator + one provider adapter — chosen by AI_PROVIDER.

const aiPipeline = require('./aiPipeline');
const providers = require('./providers');

class AIServiceFactory {
  static getService() {
    const provider = providers.resolveProvider({ role: 'main' });
    return aiPipeline.bindProvider(provider);
  }
}

module.exports = AIServiceFactory;
