// services/optimizerAiService.js
//
// LLM-Verifier für den Entity Optimizer. Cluster-Vorschläge werden via
// Provider-Adapter (services/providers/*) bestätigt oder verworfen.
//
// Provider-Auswahl: OPTIMIZER_AI_PROVIDER (Fallback: AI_PROVIDER), siehe
// services/providers/index.js:resolveOptimizerProvider. Modell-Override
// pro Provider via OPTIMIZER_*_MODEL.
//
// Antwort-Schema (provider-unabhängig):
//   { merge: boolean, canonical: string, confidence: number (0..1),
//     reason: string, provider: string, model: string, error?: boolean }

const providers = require('./providers');

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

function safeParseJson(text) {
  if (!text) throw new Error('Empty response from LLM');
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Verifiziert einen Cluster-Vorschlag per LLM.
 *
 * @param {'correspondent'|'tag'|'document_type'} entityType
 * @param {Array<{id:number,name:string,document_count?:number,sample_titles?:string[]}>} members
 * @returns {Promise<{merge:boolean,canonical:string,confidence:number,reason:string,provider:string,model:string,error?:boolean}>}
 */
async function verifyCluster(entityType, members) {
  const userPrompt = buildUserPrompt(entityType, members);
  const fallbackCanonical = members.reduce(
    (best, m) => (!best || m.name.length < best.length ? m.name : best),
    null
  );

  let provider;
  let providerName = 'unknown';
  let usedModel = 'unknown';

  try {
    provider = providers.resolveProvider({ role: 'optimizer' });
    ({ provider: providerName, model: usedModel } = provider.describe());
  } catch (error) {
    console.error('[optimizerAi] Provider resolution failed:', error.message);
    return {
      merge: false,
      canonical: fallbackCanonical,
      confidence: 0,
      reason: `Optimizer-Provider nicht verfügbar: ${error.message}`,
      provider: providerName,
      model: usedModel,
      error: true,
    };
  }

  let rawText = '';
  try {
    // Ollama / Custom-OpenAI-compatible endpoints können response_format
    // nicht zuverlässig — für die zwei lassen wir den JSON-Hinweis weg
    // und vertrauen auf den safeParseJson-Fallback.
    const useStructured = !['ollama', 'custom'].includes(providerName);

    const response = await provider.chat({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.1,
      responseFormat: useStructured ? 'json_object' : undefined,
    });
    rawText = response.text;
  } catch (error) {
    console.error(`[optimizerAi] Provider ${providerName} call failed:`, error.message);
    // Conservative fallback: refuse merge if the LLM is unreachable.
    return {
      merge: false,
      canonical: fallbackCanonical,
      confidence: 0,
      reason: `LLM-Anfrage fehlgeschlagen: ${error.message}`,
      provider: providerName,
      model: usedModel,
      error: true,
    };
  }

  try {
    const parsed = safeParseJson(rawText);
    return { ...normalizeResult(parsed, fallbackCanonical), provider: providerName, model: usedModel };
  } catch (error) {
    console.error('[optimizerAi] Failed to parse LLM JSON:', error.message, 'raw:', rawText);
    return {
      merge: false,
      canonical: fallbackCanonical,
      confidence: 0,
      reason: `LLM-Antwort nicht parsbar: ${error.message}`,
      provider: providerName,
      model: usedModel,
      error: true,
    };
  }
}

function describeProvider() {
  try {
    const provider = providers.resolveProvider({ role: 'optimizer' });
    return provider.describe();
  } catch (error) {
    return { provider: 'unknown', model: 'unknown', error: error.message };
  }
}

module.exports = {
  verifyCluster,
  describeProvider,
};
