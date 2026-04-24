const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  writePromptToFile
} = require('./serviceUtils');
const OpenAI = require('openai');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');
const { model } = require('./ollamaService');
const RestrictionPromptService = require('./restrictionPromptService');

class OpenAIService {
  constructor() {
    this.client = null;
  }

  initialize() {
    if (!this.client && config.aiProvider === 'ollama') {
      this.client = new OpenAI({
        baseURL: config.ollama.apiUrl + '/v1',
        apiKey: 'ollama'
      });
    } else if (!this.client && config.aiProvider === 'custom') {
      this.client = new OpenAI({
        baseURL: config.custom.apiUrl,
        apiKey: config.custom.apiKey
      });
    } else if (!this.client && config.aiProvider === 'openai') {
      if (!this.client && config.openai.apiKey) {
        this.client = new OpenAI({
          apiKey: config.openai.apiKey
        });
      }
    }
  }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], existingDocumentTypesList = [], id, customPrompt = null, options = {}) {
    const cachePath = path.join('./public/images', `${id}.png`);
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.client) {
        throw new Error('OpenAI client not initialized');
      }

      // Handle thumbnail caching
      try {
        await fs.access(cachePath);
        console.log('[DEBUG] Thumbnail already cached');
      } catch (err) {
        console.log('Thumbnail not cached, fetching from Paperless');

        const thumbnailData = await paperlessService.getThumbnailImage(id);

        if (!thumbnailData) {
          console.warn('Thumbnail nicht gefunden');
        }

        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, thumbnailData);
      }

      // ------------------------------------------------------------------
      // Fix B: Build a structured taxonomy block.
      // Accepts either legacy string arrays (existingTags) OR the new
      // options.existingTagsWithCounts etc. with { name, document_count }.
      // The structured block is ALWAYS injected (regardless of restriction
      // flags), sorted by frequency, and limited to a Top-N per entity.
      // ------------------------------------------------------------------
      const coerceWithCount = (arr) => (arr || []).map(e =>
        typeof e === 'string' ? { name: e, document_count: 0 } : { name: e.name, document_count: e.document_count || 0 }
      );
      const tagsWithCounts = Array.isArray(options.existingTagsWithCounts)
        ? options.existingTagsWithCounts
        : coerceWithCount(existingTags);
      const corrsWithCounts = Array.isArray(options.existingCorrespondentsWithCounts)
        ? options.existingCorrespondentsWithCounts
        : coerceWithCount(existingCorrespondentList);
      const dtsWithCounts = Array.isArray(options.existingDocumentTypesWithCounts)
        ? options.existingDocumentTypesWithCounts
        : coerceWithCount(existingDocumentTypesList);

      function formatEntityList(arr, { maxItems = 80 } = {}) {
        if (!arr || arr.length === 0) return '(none)';
        const sorted = arr.slice().sort((a, b) =>
          (b.document_count || 0) - (a.document_count || 0) || (a.name || '').localeCompare(b.name || '')
        );
        const visible = sorted.slice(0, maxItems);
        const hasAnyCount = sorted.some(e => (e.document_count || 0) > 0);
        const lines = visible.map(e => hasAnyCount && e.document_count
          ? `  - ${e.name} (${e.document_count})`
          : `  - ${e.name}`
        );
        const rest = sorted.length - visible.length;
        if (rest > 0) lines.push(`  - ... und ${rest} weitere seltener verwendete (hier ausgelassen — Top-${maxItems} gezeigt)`);
        return lines.join('\n');
      }

      const taxonomyBlock = `
=== EXISTING TAXONOMY (use these EXACT names when a concept matches — do not invent variations) ===
Numbers in parentheses = how many documents currently use that name. Prefer high-frequency names.

Existing tags (sorted by frequency):
${formatEntityList(tagsWithCounts, { maxItems: 100 })}

Existing correspondents (sorted by frequency):
${formatEntityList(corrsWithCounts, { maxItems: 60 })}

Existing document types (sorted by frequency):
${formatEntityList(dtsWithCounts, { maxItems: 40 })}
=== END TAXONOMY ===
`;

      // Kommagetrennte Version als Fallback für Legacy-Placeholder behalten.
      let existingTagsList = tagsWithCounts.map(t => t.name).join(', ');

      // Get external API data if available and validate it
      let externalApiData = options.externalApiData || null;
      let validatedExternalApiData = null;

      if (externalApiData) {
        try {
          validatedExternalApiData = await this._validateAndTruncateExternalApiData(externalApiData);
          console.log('[DEBUG] External API data validated and included');
        } catch (error) {
          console.warn('[WARNING] External API data validation failed:', error.message);
          validatedExternalApiData = null;
        }
      }

      let systemPrompt = '';
      let promptTags = '';
      const model = process.env.OPENAI_MODEL;

      // Parse CUSTOM_FIELDS from environment variable
      let customFieldsObj;
      try {
        customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
      } catch (error) {
        console.error('Failed to parse CUSTOM_FIELDS:', error);
        customFieldsObj = { custom_fields: [] };
      }

      // Generate custom fields template for the prompt
      const customFieldsTemplate = {};

      customFieldsObj.custom_fields.forEach((field, index) => {
        customFieldsTemplate[index] = {
          field_name: field.value,
          value: "Fill in the value based on your analysis"
        };
      });

      // Convert template to string for replacement and wrap in custom_fields
      const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
        .split('\n')
        .map(line => '    ' + line)  // Add proper indentation
        .join('\n');

      // Fix B: Build system prompt with correct ordering and always-injected taxonomy.
      // Order:
      //   1. Custom / ENV system prompt (rules come first so the LLM sees them before scanning lists)
      //   2. Structured taxonomy block with counts (always injected — fixes the restriction-mode bug)
      //   3. mustHavePrompt (JSON schema contract)
      const mustHave = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
      const customOrEnv = process.env.SYSTEM_PROMPT || '';
      systemPrompt = customOrEnv + '\n\n' + taxonomyBlock + '\n\n' + mustHave;
      promptTags = '';

      // Process placeholder replacements in system prompt
      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        config
      );

      // Include validated external API data if available
      if (validatedExternalApiData) {
        systemPrompt += `\n\nAdditional context from external API:\n${validatedExternalApiData}`;
      }

      if (process.env.USE_PROMPT_TAGS === 'yes') {
        promptTags = process.env.PROMPT_TAGS;
        systemPrompt = `
        Take these tags and try to match one or more to the document content.\n\n
        ` + config.specialPromptPreDefinedTags;
      }

      if (customPrompt) {
        console.log('[DEBUG] Replace system prompt with custom prompt via WebHook');
        // Fix B: auch hier die Taxonomy mitgeben, damit WebHook-Aufrufe konsistente Tags nutzen
        systemPrompt = customPrompt + '\n\n' + taxonomyBlock + '\n\n' + config.mustHavePrompt;
      }

      // Calculate tokens AFTER all prompt modifications are complete
      const totalPromptTokens = await calculateTotalPromptTokens(
        systemPrompt,
        process.env.USE_PROMPT_TAGS === 'yes' ? [promptTags] : [],
        model
      );

      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens);
      const availableTokens = maxTokens - reservedTokens;

      // Validate that we have positive available tokens
      if (availableTokens <= 0) {
        console.warn(`[WARNING] No available tokens for content. Reserved: ${reservedTokens}, Max: ${maxTokens}`);
        throw new Error('Token limit exceeded: prompt too large for available token limit');
      }

      console.log(`[DEBUG] Token calculation - Prompt: ${totalPromptTokens}, Reserved: ${reservedTokens}, Available: ${availableTokens}`);
      console.log(`[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`);
      console.log(`[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`);

      const truncatedContent = await truncateToTokenLimit(content, availableTokens, model);

      await writePromptToFile(systemPrompt, truncatedContent);

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        ...(model !== 'o3-mini' && config.aiTemperature !== '' && { temperature: parseFloat(config.aiTemperature) }),
      });

      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
        //write to file and append to the file (txt)
        fs.appendFile('./logs/response.txt', jsonContent, (err) => {
          if (err) throw err;
        });
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      // ------------------------------------------------------------------
      // Empty-Tags-Retry-Mechanismus
      // ------------------------------------------------------------------
      // Wenn das LLM tags:[] liefert, senden wir einen Korrektur-Call als
      // conversational follow-up (nutzt OpenAIs prompt caching, spart Tokens
      // gegenüber einem komplett neuen Call). Max. 1 Retry. Abschaltbar via
      // AI_EMPTY_TAGS_RETRY=no.
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

          const retryResponse = await this.client.chat.completions.create({
            model: model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: truncatedContent },
              { role: "assistant", content: jsonContent },
              { role: "user", content: correctionMessage },
            ],
            ...(model !== 'o3-mini' && { temperature: 0.1 }),
          });

          if (retryResponse?.choices?.[0]?.message?.content) {
            const retryUsage = retryResponse.usage;
            mappedUsage.promptTokens += retryUsage.prompt_tokens;
            mappedUsage.completionTokens += retryUsage.completion_tokens;
            mappedUsage.totalTokens += retryUsage.total_tokens;
            console.log(`[DEBUG] Retry consumed ${retryUsage.total_tokens} tokens (cumulative: ${mappedUsage.totalTokens})`);

            let retryJson = retryResponse.choices[0].message.content;
            retryJson = retryJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            let retryParsed;
            try {
              retryParsed = JSON.parse(retryJson);
            } catch (e) {
              console.error('[ERROR] Retry response not parsable as JSON — keeping original empty-tags response');
              retryParsed = null;
            }

            if (retryParsed && Array.isArray(retryParsed.tags) && retryParsed.tags.length > 0) {
              console.log(`[INFO] Retry successful: ${retryParsed.tags.length} tag(s) returned — [${retryParsed.tags.join(', ')}]`);
              parsedResponse = retryParsed;
              fs.appendFile('./logs/response.txt', '\n[RETRY]\n' + retryJson, () => {});
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
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message
      };
    }
  }

  /**
   * Validate and truncate external API data to prevent token overflow
   * @param {any} apiData - The external API data to validate
   * @param {number} maxTokens - Maximum tokens allowed for external data (default: 500)
   * @returns {string} - Validated and potentially truncated data string
   */
  async _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
    if (!apiData) {
      return null;
    }

    const dataString = typeof apiData === 'object'
      ? JSON.stringify(apiData, null, 2)
      : String(apiData);

    // Calculate tokens for the data
    const dataTokens = await calculateTokens(dataString, process.env.OPENAI_MODEL);

    if (dataTokens > maxTokens) {
      console.warn(`[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`);
      return await truncateToTokenLimit(dataString, maxTokens, process.env.OPENAI_MODEL);
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  async analyzePlayground(content, prompt) {
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
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }

      // Calculate total prompt tokens including musthavePrompt
      const totalPromptTokens = await calculateTotalPromptTokens(
        prompt + musthavePrompt // Combined system prompt
      );

      // Calculate available tokens
      const maxTokens = Number(config.tokenLimit);
      const reservedTokens = totalPromptTokens + Number(config.responseTokens); // Reserve for response
      const availableTokens = maxTokens - reservedTokens;

      // Truncate content if necessary
      const truncatedContent = await truncateToTokenLimit(content, availableTokens);
      const model = process.env.OPENAI_MODEL;
      // Make API request
      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: prompt + musthavePrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        ...(model !== 'o3-mini' && config.aiTemperature !== '' && { temperature: parseFloat(config.aiTemperature) }),
      });

      // Handle response
      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      // Log token usage
      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);

      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      // Validate response structure
      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      return {
        document: parsedResponse,
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return {
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message
      };
    }
  }

  /**
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt) {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }

      const model = process.env.OPENAI_MODEL || config.openai.model;

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7
      });

      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      return response.choices[0].message.content;
    } catch (error) {
      console.error('Error generating text with OpenAI:', error);
      throw error;
    }
  }

  async checkStatus() {
    // send test request to OpenAI API and respond with 'ok' or 'error'
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }
      const response = await this.client.chat.completions.create({
        model: process.env.OPENAI_MODEL,
        messages: [
          {
            role: "user",
            content: "Test"
          }
        ],
        temperature: 0.7
      });
      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }
      return { status: 'ok', model: process.env.OPENAI_MODEL };
    } catch (error) {
      console.error('Error checking OpenAI status:', error);
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new OpenAIService();
