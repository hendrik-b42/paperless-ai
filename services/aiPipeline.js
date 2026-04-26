// Provider-agnostische Document-Analyse-Pipeline.
//
// Übernimmt aus dem alten openaiService.js die "Master"-Implementierung
// inklusive aller Fork-Features:
//   - Thumbnail-Caching
//   - Strukturierte Taxonomy-Injection (Fix B aus CHANGELOG)
//   - Empty-Tags-Retry-Mechanismus
//   - RestrictionPromptService-Integration
// Provider-Calls laufen über services/providers/* — die Pipeline
// kennt den konkreten Anbieter nicht, nur den Adapter-Vertrag
// chat() / describe() / checkStatus().

const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  writePromptToFile
} = require('./serviceUtils');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const RestrictionPromptService = require('./restrictionPromptService');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const coerceWithCount = (arr) => (arr || []).map(e =>
  typeof e === 'string'
    ? { name: e, document_count: 0 }
    : { name: e.name, document_count: e.document_count || 0 }
);

function formatEntityList(arr, { maxItems = 80 } = {}) {
  if (!arr || arr.length === 0) return '(none)';
  const sorted = arr.slice().sort((a, b) =>
    (b.document_count || 0) - (a.document_count || 0)
    || (a.name || '').localeCompare(b.name || '')
  );
  const visible = sorted.slice(0, maxItems);
  const hasAnyCount = sorted.some(e => (e.document_count || 0) > 0);
  const lines = visible.map(e =>
    hasAnyCount && e.document_count
      ? `  - ${e.name} (${e.document_count})`
      : `  - ${e.name}`
  );
  const rest = sorted.length - visible.length;
  if (rest > 0) {
    lines.push(`  - ... und ${rest} weitere seltener verwendete (hier ausgelassen — Top-${maxItems} gezeigt)`);
  }
  return lines.join('\n');
}

function buildTaxonomyBlock(tags, corrs, dts) {
  return `
=== EXISTING TAXONOMY (use these EXACT names when a concept matches — do not invent variations) ===
Numbers in parentheses = how many documents currently use that name. Prefer high-frequency names.

Existing tags (sorted by frequency):
${formatEntityList(tags, { maxItems: 100 })}

Existing correspondents (sorted by frequency):
${formatEntityList(corrs, { maxItems: 60 })}

Existing document types (sorted by frequency):
${formatEntityList(dts, { maxItems: 40 })}
=== END TAXONOMY ===
`;
}

function stripJsonFences(text) {
  return (text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

async function ensureThumbnailCached(id) {
  const cachePath = path.join('./public/images', `${id}.png`);
  try {
    await fs.access(cachePath);
    return;
  } catch (_) {
    // not cached
  }
  const data = await paperlessService.getThumbnailImage(id);
  if (!data) {
    console.warn('Thumbnail nicht gefunden');
    return;
  }
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, data);
}

async function validateAndTruncateExternalApiData(apiData, model, maxTokens = 500) {
  if (!apiData) return null;
  const dataString = typeof apiData === 'object'
    ? JSON.stringify(apiData, null, 2)
    : String(apiData);
  const tokens = await calculateTokens(dataString, model);
  if (tokens > maxTokens) {
    console.warn(`[WARNING] External API data (${tokens} tokens) exceeds limit (${maxTokens}), truncating`);
    return await truncateToTokenLimit(dataString, maxTokens, model);
  }
  console.log(`[DEBUG] External API data validated: ${tokens} tokens`);
  return dataString;
}

function buildSystemPrompt({ taxonomyBlock, customPrompt, externalApiData }) {
  // Fix B: Reihenfolge — Custom/ENV-Prompt → Taxonomy → mustHavePrompt
  let customFieldsObj;
  try {
    customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
  } catch (_) {
    customFieldsObj = { custom_fields: [] };
  }
  const customFieldsTemplate = {};
  customFieldsObj.custom_fields.forEach((field, index) => {
    customFieldsTemplate[index] = {
      field_name: field.value,
      value: 'Fill in the value based on your analysis'
    };
  });
  const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
    .split('\n')
    .map(line => '    ' + line)
    .join('\n');

  const mustHave = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);

  let prompt;
  if (customPrompt) {
    // Fix B: WebHook-Aufrufe bekommen ebenfalls die Taxonomy
    prompt = customPrompt + '\n\n' + taxonomyBlock + '\n\n' + config.mustHavePrompt;
  } else if (process.env.USE_PROMPT_TAGS === 'yes') {
    prompt = `\n        Take these tags and try to match one or more to the document content.\n\n        ` + config.specialPromptPreDefinedTags;
  } else {
    const customOrEnv = process.env.SYSTEM_PROMPT || '';
    prompt = customOrEnv + '\n\n' + taxonomyBlock + '\n\n' + mustHave;
  }

  if (externalApiData) {
    prompt += `\n\nAdditional context from external API:\n${externalApiData}`;
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Pipeline (provider-agnostic)
// ---------------------------------------------------------------------------

function bindProvider(provider) {
  if (!provider) {
    throw new Error('aiPipeline.bindProvider: provider adapter required');
  }

  async function analyzeDocument(
    content,
    existingTags = [],
    existingCorrespondentList = [],
    existingDocumentTypesList = [],
    id,
    customPrompt = null,
    options = {}
  ) {
    try {
      await ensureThumbnailCached(id);

      const tagsWithCounts = Array.isArray(options.existingTagsWithCounts)
        ? options.existingTagsWithCounts
        : coerceWithCount(existingTags);
      const corrsWithCounts = Array.isArray(options.existingCorrespondentsWithCounts)
        ? options.existingCorrespondentsWithCounts
        : coerceWithCount(existingCorrespondentList);
      const dtsWithCounts = Array.isArray(options.existingDocumentTypesWithCounts)
        ? options.existingDocumentTypesWithCounts
        : coerceWithCount(existingDocumentTypesList);

      const taxonomyBlock = buildTaxonomyBlock(tagsWithCounts, corrsWithCounts, dtsWithCounts);

      const { model } = provider.describe();

      const validatedExternalApiData = options.externalApiData
        ? await validateAndTruncateExternalApiData(options.externalApiData, model)
        : null;

      let systemPrompt = buildSystemPrompt({
        taxonomyBlock,
        customPrompt,
        externalApiData: validatedExternalApiData
      });

      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        config
      );

      const promptTags = process.env.USE_PROMPT_TAGS === 'yes' ? process.env.PROMPT_TAGS : null;
      const totalPromptTokens = await calculateTotalPromptTokens(
        systemPrompt,
        promptTags ? [promptTags] : [],
        model
      );

      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;
      if (availableTokens <= 0) {
        console.warn(`[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`);
        throw new Error('Token limit exceeded: prompt too large for available token limit');
      }

      console.log(`[DEBUG] Token calculation - Prompt: ${totalPromptTokens}, Reserved: ${reservedTokens}, Available: ${availableTokens}`);
      console.log(`[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`);
      console.log(`[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`);

      const truncatedContent = await truncateToTokenLimit(content, availableTokens, model);
      await writePromptToFile(systemPrompt, truncatedContent);

      const userMessages = [{ role: 'user', content: truncatedContent }];

      const response = await provider.chat({
        system: systemPrompt,
        messages: userMessages,
        responseFormat: 'json_object',
      });

      if (!response?.text) {
        throw new Error('Invalid API response structure');
      }

      const timestamp = new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      console.log(`[DEBUG] [${timestamp}] ${provider.describe().provider} request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.totalTokens}`);

      const mappedUsage = {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      };

      let jsonContent = stripJsonFences(response.text);
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
        fsSync.appendFile('./logs/response.txt', jsonContent, () => {});
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      // ------------------------------------------------------------------
      // Empty-Tags-Retry-Mechanismus (war zuvor nur in openaiService).
      // Multi-turn follow-up — nutzt prompt-caching wo der Provider es
      // hat (OpenAI), funktioniert aber für jeden Adapter.
      // ------------------------------------------------------------------
      const retryEnabled = (process.env.AI_EMPTY_TAGS_RETRY || 'yes').toLowerCase() === 'yes';
      if (retryEnabled && parsedResponse.tags.length === 0) {
        console.warn(`[WARN] LLM returned empty tags array for document ${id} — retrying with correction prompt...`);
        try {
          const correctionMessage =
            'Your previous response contained an empty "tags" array. ' +
            'This violates the rule "Hard minimum: 1 topical tag per document". ' +
            'Please return a corrected JSON object (same schema as before) with AT LEAST ONE meaningful topical tag. ' +
            'Guidance: use an existing tag from the provided taxonomy if one semantically fits; otherwise create a new short German tag that describes the document category (e.g. "KFZ" / "Auto" for vehicle documents, "Versicherung" for insurance, "Gesundheit" for medical, "Finanzen" for banking, "Schule" for school documents, etc.). ' +
            'Tax-tags may also be added if any trigger applies. ' +
            'Return the corrected JSON object only, no preamble, no markdown.';

          const retryResponse = await provider.chat({
            system: systemPrompt,
            messages: [
              { role: 'user', content: truncatedContent },
              { role: 'assistant', content: jsonContent },
              { role: 'user', content: correctionMessage },
            ],
            temperature: 0.1,
            responseFormat: 'json_object',
          });

          if (retryResponse?.text) {
            mappedUsage.promptTokens += retryResponse.usage.promptTokens;
            mappedUsage.completionTokens += retryResponse.usage.completionTokens;
            mappedUsage.totalTokens += retryResponse.usage.totalTokens;
            console.log(`[DEBUG] Retry consumed ${retryResponse.usage.totalTokens} tokens (cumulative: ${mappedUsage.totalTokens})`);

            const retryJson = stripJsonFences(retryResponse.text);
            let retryParsed;
            try {
              retryParsed = JSON.parse(retryJson);
            } catch (_) {
              console.error('[ERROR] Retry response not parsable as JSON — keeping original empty-tags response');
              retryParsed = null;
            }

            if (retryParsed && Array.isArray(retryParsed.tags) && retryParsed.tags.length > 0) {
              console.log(`[INFO] Retry successful: ${retryParsed.tags.length} tag(s) returned — [${retryParsed.tags.join(', ')}]`);
              parsedResponse = retryParsed;
              fsSync.appendFile('./logs/response.txt', '\n[RETRY]\n' + retryJson, () => {});
            } else {
              console.warn('[WARN] Retry also returned empty/invalid tags — accepting empty-tags result.');
            }
          }
        } catch (retryError) {
          console.error('[ERROR] Retry call failed:', retryError.message, '— keeping original empty-tags response');
        }
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length,
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message,
      };
    }
  }

  async function analyzePlayground(content, prompt) {
    const musthavePrompt = `
    Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`;

    try {
      const { model } = provider.describe();
      const systemPrompt = prompt + musthavePrompt;
      const totalPromptTokens = await calculateTotalPromptTokens(systemPrompt, [], model);
      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      const truncatedContent = await truncateToTokenLimit(content, availableTokens, model);

      const response = await provider.chat({
        system: systemPrompt,
        messages: [{ role: 'user', content: truncatedContent }],
        responseFormat: 'json_object',
      });

      if (!response?.text) {
        throw new Error('Invalid API response structure');
      }

      const mappedUsage = {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      };

      const jsonContent = stripJsonFences(response.text);
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length,
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message,
      };
    }
  }

  async function generateText(prompt) {
    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });
    if (!response?.text) {
      throw new Error('Invalid API response structure');
    }
    return response.text;
  }

  async function checkStatus() {
    try {
      const result = await provider.checkStatus();
      const { provider: name, model } = provider.describe();
      if (result.ok) {
        return { status: 'ok', model, provider: name };
      }
      return { status: 'error', error: result.error, model, provider: name };
    } catch (error) {
      return { status: 'error', error: error.message };
    }
  }

  return {
    analyzeDocument,
    analyzePlayground,
    generateText,
    checkStatus,
  };
}

module.exports = { bindProvider };
