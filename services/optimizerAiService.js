// services/optimizerAiService.js
//
// Multi-provider LLM verifier for the Entity Optimizer.
//
// Supported providers (via OPTIMIZER_AI_PROVIDER env var, falls back to AI_PROVIDER):
//   - openai       (uses OPENAI_API_KEY, OPTIMIZER_OPENAI_MODEL, default gpt-4o-mini)
//   - anthropic    (uses ANTHROPIC_API_KEY, OPTIMIZER_ANTHROPIC_MODEL, default claude-3-5-sonnet-latest)
//   - gemini       (uses GEMINI_API_KEY, OPTIMIZER_GEMINI_MODEL, default gemini-1.5-pro)
//   - perplexity   (uses PERPLEXITY_API_KEY, OPTIMIZER_PERPLEXITY_MODEL, default sonar)
//   - azure        (reuses AZURE_* config)
//   - ollama       (reuses OLLAMA_* config)
//   - custom       (reuses CUSTOM_* config - OpenAI-compatible endpoint)
//
// All providers return the same normalized JSON:
//   { merge: boolean, canonical: string, confidence: number (0..1), reason: string }

const axios = require('axios');
const OpenAI = require('openai');
const config = require('../config/config');

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Du bist ein Assistent für die Konsolidierung von Dokumenten-Metadaten in Paperless-NGX.
Deine Aufgabe: Entscheide, ob eine Gruppe von Namen dieselbe Entität bzw. denselben thematischen Begriff beschreibt.

Regeln für Korrespondenten:
- Schreibvarianten, Rechtsformen (GmbH, AG, Aktiengesellschaft, SE, KG, Ltd, Inc, SARL, S.A., etc.), TLDs (.de, .com) und regionale Zusätze (DE, EU, Deutschland) sind KEIN Unterschied.
- Unterschiedliche Tochtergesellschaften, Filialen oder regionale Einheiten (z.B. "Sparkasse Köln" vs "Sparkasse Bonn", "Amazon Web Services" vs "Amazon.de") sind UNTERSCHIEDLICHE Entitäten und dürfen NICHT gemerged werden.

Regeln für Tags:
- Singular/Plural-Varianten, Groß-/Kleinschreibung, Bindestriche vs. Leerzeichen, Deutsch/Englisch-Duplikate (z.B. "Rechnung" / "Invoice") sind identisch und SOLLTEN gemerged werden.
- Verschiedene Kategorien, auch wenn verwandt (z.B. "Werbungskosten 2024" vs "Werbungskosten 2025", "Kita" vs "Schule"), sind UNTERSCHIEDLICHE Tags und dürfen NICHT gemerged werden.
- Steuertags mit identischem Jahr und Kategorie dürfen zusammengeführt werden (z.B. "Werbungskosten 2024" und "werbungskosten2024").

Allgemein:
- Wenn du unsicher bist, setze merge=false und gib confidence unter 0.7 an.
- Der kanonische Name soll die sauberste, kürzeste Form ohne überflüssige Suffixe sein. Für Tags bevorzuge die Form, die bereits in der Liste der existierenden Einträge am häufigsten oder mit den meisten Dokumenten verwendet wird.

Antworte AUSSCHLIESSLICH als JSON-Objekt in diesem Schema:
{
  "merge": true | false,
  "canonical": "string (vorgeschlagener Zielname)",
  "confidence": 0.0 bis 1.0,
  "reason": "kurze Begründung auf Deutsch"
}`;

function buildUserPrompt(entityType, members) {
  const label = entityType === 'correspondent' ? 'Korrespondenten' : (entityType === 'tag' ? 'Tags' : 'Einheiten');
  const lines = members.map((m, i) => {
    const docInfo = (m.document_count != null) ? ` (${m.document_count} Dokumente)` : '';
    const sample = (m.sample_titles && m.sample_titles.length) ? `  Beispieltitel: ${m.sample_titles.slice(0, 3).join(' | ')}` : '';
    return `${i + 1}. "${m.name}"${docInfo}${sample ? '\n' + sample : ''}`;
  }).join('\n');

  return `Sind diese ${label} dieselbe Entität?\n\n${lines}\n\nAntwort als JSON.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProviderName() {
  return (process.env.OPTIMIZER_AI_PROVIDER || config.aiProvider || 'openai').toLowerCase();
}

function safeParseJson(text) {
  if (!text) throw new Error('Empty response from LLM');
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  // Fallback: extract first { ... } block
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0]);
  }
  throw new Error('Could not parse JSON from LLM response');
}

function normalizeResult(raw, fallbackCanonical) {
  const merge = !!raw.merge;
  const canonical = (raw.canonical && typeof raw.canonical === 'string' && raw.canonical.trim())
    ? raw.canonical.trim()
    : fallbackCanonical;
  let confidence = parseFloat(raw.confidence);
  if (!isFinite(confidence)) confidence = merge ? 0.75 : 0.3;
  confidence = Math.max(0, Math.min(1, confidence));
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  return { merge, canonical, confidence, reason };
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function callOpenAI(userPrompt, { baseURL, apiKey, model, useResponseFormat = true }) {
  const client = new OpenAI({ baseURL, apiKey });
  const request = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.1,
  };
  if (useResponseFormat) {
    request.response_format = { type: 'json_object' };
  }
  const resp = await client.chat.completions.create(request);
  return resp.choices?.[0]?.message?.content || '';
}

async function callAnthropic(userPrompt, { apiKey, model }) {
  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );
  const blocks = resp.data?.content || [];
  return blocks.map(b => b.text || '').join('');
}

async function callGemini(userPrompt, { apiKey, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await axios.post(
    url,
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    },
    { timeout: 30000 }
  );
  const parts = resp.data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('');
}

async function callPerplexity(userPrompt, { apiKey, model }) {
  const resp = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );
  return resp.data?.choices?.[0]?.message?.content || '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verifiziert einen Cluster-Vorschlag per LLM.
 *
 * @param {'correspondent'|'tag'|'document_type'} entityType
 * @param {Array<{id:number,name:string,document_count?:number,sample_titles?:string[]}>} members
 * @returns {Promise<{merge:boolean,canonical:string,confidence:number,reason:string,provider:string,model:string}>}
 */
async function verifyCluster(entityType, members) {
  const provider = getProviderName();
  const userPrompt = buildUserPrompt(entityType, members);
  const fallbackCanonical = members.reduce((best, m) => (!best || m.name.length < best.length ? m.name : best), null);

  let rawText = '';
  let usedModel = '';

  try {
    if (provider === 'openai') {
      usedModel = process.env.OPTIMIZER_OPENAI_MODEL || 'gpt-4o-mini';
      if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY missing');
      rawText = await callOpenAI(userPrompt, {
        apiKey: config.openai.apiKey,
        model: usedModel,
      });
    } else if (provider === 'anthropic') {
      usedModel = process.env.OPTIMIZER_ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
      rawText = await callAnthropic(userPrompt, {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: usedModel,
      });
    } else if (provider === 'gemini') {
      usedModel = process.env.OPTIMIZER_GEMINI_MODEL || 'gemini-1.5-pro';
      if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
      rawText = await callGemini(userPrompt, {
        apiKey: process.env.GEMINI_API_KEY,
        model: usedModel,
      });
    } else if (provider === 'perplexity') {
      usedModel = process.env.OPTIMIZER_PERPLEXITY_MODEL || 'sonar';
      if (!process.env.PERPLEXITY_API_KEY) throw new Error('PERPLEXITY_API_KEY missing');
      rawText = await callPerplexity(userPrompt, {
        apiKey: process.env.PERPLEXITY_API_KEY,
        model: usedModel,
      });
    } else if (provider === 'azure') {
      usedModel = config.azure.deploymentName;
      if (!config.azure.apiKey || !config.azure.endpoint) throw new Error('Azure config missing');
      const baseURL = `${config.azure.endpoint.replace(/\/$/, '')}/openai/deployments/${config.azure.deploymentName}`;
      const client = new OpenAI({
        apiKey: config.azure.apiKey,
        baseURL,
        defaultQuery: { 'api-version': config.azure.apiVersion },
        defaultHeaders: { 'api-key': config.azure.apiKey },
      });
      const resp = await client.chat.completions.create({
        model: config.azure.deploymentName,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      rawText = resp.choices?.[0]?.message?.content || '';
    } else if (provider === 'ollama') {
      usedModel = config.ollama.model;
      rawText = await callOpenAI(userPrompt, {
        baseURL: config.ollama.apiUrl + '/v1',
        apiKey: 'ollama',
        model: usedModel,
        useResponseFormat: false, // many ollama models don't support it cleanly
      });
    } else if (provider === 'custom') {
      usedModel = config.custom.model;
      rawText = await callOpenAI(userPrompt, {
        baseURL: config.custom.apiUrl,
        apiKey: config.custom.apiKey,
        model: usedModel,
        useResponseFormat: false,
      });
    } else {
      throw new Error(`Unknown optimizer provider: ${provider}`);
    }
  } catch (error) {
    console.error(`[optimizerAi] Provider ${provider} call failed:`, error.message);
    // Conservative fallback: refuse merge if the LLM is unreachable.
    return {
      merge: false,
      canonical: fallbackCanonical,
      confidence: 0,
      reason: `LLM-Anfrage fehlgeschlagen: ${error.message}`,
      provider,
      model: usedModel,
      error: true,
    };
  }

  try {
    const parsed = safeParseJson(rawText);
    return { ...normalizeResult(parsed, fallbackCanonical), provider, model: usedModel };
  } catch (error) {
    console.error('[optimizerAi] Failed to parse LLM JSON:', error.message, 'raw:', rawText);
    return {
      merge: false,
      canonical: fallbackCanonical,
      confidence: 0,
      reason: `LLM-Antwort nicht parsbar: ${error.message}`,
      provider,
      model: usedModel,
      error: true,
    };
  }
}

function describeProvider() {
  const provider = getProviderName();
  const models = {
    openai: process.env.OPTIMIZER_OPENAI_MODEL || 'gpt-4o-mini',
    anthropic: process.env.OPTIMIZER_ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
    gemini: process.env.OPTIMIZER_GEMINI_MODEL || 'gemini-1.5-pro',
    perplexity: process.env.OPTIMIZER_PERPLEXITY_MODEL || 'sonar',
    azure: config.azure.deploymentName || '(not configured)',
    ollama: config.ollama.model,
    custom: config.custom.model,
  };
  return { provider, model: models[provider] || 'unknown' };
}

module.exports = {
  verifyCluster,
  describeProvider,
};
