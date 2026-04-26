const express = require('express');
const router = express.Router();
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const configFile = require('../config/config.js');

const normalizeArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').filter(Boolean).map(item => item.trim());
  return [];
};

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Application settings page
 *     description: |
 *       Renders the application settings page where users can modify configuration
 *       after initial setup.
 *
 *       This page allows administrators to update connections to Paperless-ngx,
 *       AI provider settings, processing parameters, feature toggles, and custom fields.
 *       The interface provides validation for connection settings and displays the current
 *       configuration values.
 *
 *       Changes made on this page require application restart to take full effect.
 *     tags:
 *       - Navigation
 *       - Setup
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Settings page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the application settings page
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/settings', async (req, res) => {
  let showErrorCheckSettings = false;
  const isConfigured = await setupService.isConfigured();
  if (!isConfigured && process.env.PAPERLESS_AI_INITIAL_SETUP === 'yes') {
    showErrorCheckSettings = true;
  }
  let config = {
    PAPERLESS_API_URL: (process.env.PAPERLESS_API_URL || 'http://localhost:8000').replace(/\/api$/, ''),
    PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
    PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
    AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    OLLAMA_API_URL: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2',
    SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
    SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
    PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',

    TOKEN_LIMIT: process.env.TOKEN_LIMIT || 128000,
    RESPONSE_TOKENS: process.env.RESPONSE_TOKENS || 1000,
    TAGS: normalizeArray(process.env.TAGS),
    ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
    AI_PROCESSED_TAG_NAME: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
    USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
    PROMPT_TAGS: normalizeArray(process.env.PROMPT_TAGS),
    PAPERLESS_AI_VERSION: configFile.PAPERLESS_AI_VERSION || ' ',
    PROCESS_ONLY_NEW_DOCUMENTS: process.env.PROCESS_ONLY_NEW_DOCUMENTS || ' ',
    USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
    CUSTOM_API_KEY: process.env.CUSTOM_API_KEY || '',
    CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL || '',
    CUSTOM_MODEL: process.env.CUSTOM_MODEL || '',
    AZURE_ENDPOINT: process.env.AZURE_ENDPOINT || '',
    AZURE_API_KEY: process.env.AZURE_API_KEY || '',
    AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
    AZURE_API_VERSION: process.env.AZURE_API_VERSION || '',
    RESTRICT_TO_EXISTING_TAGS: process.env.RESTRICT_TO_EXISTING_TAGS || 'no',
    RESTRICT_TO_EXISTING_CORRESPONDENTS: process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS || 'no',
    RESTRICT_TO_EXISTING_DOCUMENT_TYPES: process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES || 'no',
    EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED || 'no',
    EXTERNAL_API_URL: process.env.EXTERNAL_API_URL || '',
    EXTERNAL_API_METHOD: process.env.EXTERNAL_API_METHOD || 'GET',
    EXTERNAL_API_HEADERS: process.env.EXTERNAL_API_HEADERS || '{}',
    EXTERNAL_API_BODY: process.env.EXTERNAL_API_BODY || '{}',
    EXTERNAL_API_TIMEOUT: process.env.EXTERNAL_API_TIMEOUT || '5000',
    EXTERNAL_API_TRANSFORM: process.env.EXTERNAL_API_TRANSFORM || ''
  };

  if (isConfigured) {
    const savedConfig = await setupService.loadConfig();
    if (savedConfig.PAPERLESS_API_URL) {
      savedConfig.PAPERLESS_API_URL = savedConfig.PAPERLESS_API_URL.replace(/\/api$/, '');
    }

    savedConfig.TAGS = normalizeArray(savedConfig.TAGS);
    savedConfig.PROMPT_TAGS = normalizeArray(savedConfig.PROMPT_TAGS);

    config = { ...config, ...savedConfig };
  }

  console.log('Current config TAGS:', config.TAGS);
  console.log('Current config PROMPT_TAGS:', config.PROMPT_TAGS);
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  res.render('settings', {
    version,
    config,
    success: isConfigured ? 'The application is already configured. You can update the configuration below.' : undefined,
    settingsError: showErrorCheckSettings ? 'Please check your settings. Something is not working correctly.' : undefined
  });
});

/**
 * @swagger
 * /settings:
 *   post:
 *     summary: Update application settings
 *     description: |
 *       Updates the configuration settings of the Paperless-AI application after initial setup.
 *       This endpoint allows administrators to modify connections to Paperless-ngx,
 *       AI provider settings, processing parameters, and feature toggles.
 *
 *       Changes made through this endpoint are applied immediately and affect all future
 *       document processing operations.
 *     tags:
 *       - System
 *       - Setup
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paperlessUrl:
 *                 type: string
 *                 description: URL of the Paperless-ngx instance
 *                 example: "https://paperless.example.com"
 *               paperlessToken:
 *                 type: string
 *                 description: API token for Paperless-ngx access
 *                 example: "abc123def456"
 *               paperlessUsername:
 *                 type: string
 *                 description: Username for Paperless-ngx (alternative to token authentication)
 *                 example: "admin"
 *               aiProvider:
 *                 type: string
 *                 description: Selected AI provider for document analysis
 *                 enum: ["openai", "ollama", "custom", "azure"]
 *                 example: "openai"
 *               openaiKey:
 *                 type: string
 *                 description: API key for OpenAI (required when aiProvider is 'openai')
 *                 example: "sk-abc123def456"
 *               openaiModel:
 *                 type: string
 *                 description: OpenAI model to use for analysis
 *                 example: "gpt-4"
 *               ollamaUrl:
 *                 type: string
 *                 description: URL for Ollama API (required when aiProvider is 'ollama')
 *                 example: "http://localhost:11434"
 *               ollamaModel:
 *                 type: string
 *                 description: Ollama model to use for analysis
 *                 example: "llama2"
 *               customApiKey:
 *                 type: string
 *                 description: API key for custom LLM provider
 *                 example: "api-key-123"
 *               customBaseUrl:
 *                 type: string
 *                 description: Base URL for custom LLM provider
 *                 example: "https://api.customllm.com"
 *               customModel:
 *                 type: string
 *                 description: Model name for custom LLM provider
 *                 example: "custom-model"
 *               scanInterval:
 *                 type: number
 *                 description: Interval in minutes for scanning new documents
 *                 example: 15
 *               systemPrompt:
 *                 type: string
 *                 description: Custom system prompt for document analysis
 *                 example: "Extract key information from the following document..."
 *               showTags:
 *                 type: boolean
 *                 description: Whether to show tags in the UI
 *                 example: true
 *               tokenLimit:
 *                 type: integer
 *                 description: The maximum number of tokens th AI can handle
 *                 example: 128000
 *               responseTokens:
 *                 type: integer
 *                 description: The approx. amount of tokens required for the response
 *                 example: 1000
 *               tags:
 *                 type: string
 *                 description: Comma-separated list of tags to use for filtering
 *                 example: "Invoice,Receipt,Contract"
 *               aiProcessedTag:
 *                 type: boolean
 *                 description: Whether to add a tag for AI-processed documents
 *                 example: true
 *               aiTagName:
 *                 type: string
 *                 description: Tag name to use for AI-processed documents
 *                 example: "AI-Processed"
 *               usePromptTags:
 *                 type: boolean
 *                 description: Whether to use tags in prompts
 *                 example: true
 *               promptTags:
 *                 type: string
 *                 description: Comma-separated list of tags to use in prompts
 *                 example: "Invoice,Receipt"
 *               useExistingData:
 *                 type: boolean
 *                 description: Whether to use existing data from a previous setup
 *                 example: false
 *               activateTagging:
 *                 type: boolean
 *                 description: Enable AI-based tag suggestions
 *                 example: true
 *               activateCorrespondents:
 *                 type: boolean
 *                 description: Enable AI-based correspondent suggestions
 *                 example: true
 *               activateDocumentType:
 *                 type: boolean
 *                 description: Enable AI-based document type suggestions
 *                 example: true
 *               activateTitle:
 *                 type: boolean
 *                 description: Enable AI-based title suggestions
 *                 example: true
 *               activateCustomFields:
 *                 type: boolean
 *                 description: Enable AI-based custom field extraction
 *                 example: false
 *               customFields:
 *                 type: string
 *                 description: JSON string defining custom fields to extract
 *                 example: '{"invoice_number":{"type":"string"},"total_amount":{"type":"number"}}'
 *               disableAutomaticProcessing:
 *                 type: boolean
 *                 description: Disable automatic document processing
 *                 example: false
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ["success"]
 *                   example: "success"
 *                 message:
 *                   type: string
 *                   example: "Settings updated successfully"
 *       400:
 *         description: Invalid configuration parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ["error"]
 *                   example: "error"
 *                 message:
 *                   type: string
 *                   example: "Invalid settings: AI provider required when automatic processing is enabled"
 *       500:
 *         description: Server error while updating settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: ["error"]
 *                   example: "error"
 *                 message:
 *                   type: string
 *                   example: "Failed to update settings: Database error"
 */
router.post('/settings', express.json(), async (req, res) => {
  try {
    const {
      paperlessUrl,
      paperlessToken,
      aiProvider,
      openaiKey,
      openaiModel,
      ollamaUrl,
      ollamaModel,
      scanInterval,
      systemPrompt,
      showTags,
      tokenLimit,
      responseTokens,
      tags,
      aiProcessedTag,
      aiTagName,
      usePromptTags,
      promptTags,
      paperlessUsername,
      useExistingData,
      customApiKey,
      customBaseUrl,
      customModel,
      activateTagging,
      activateCorrespondents,
      activateDocumentType,
      activateTitle,
      activateCustomFields,
      customFields,
      disableAutomaticProcessing,
      azureEndpoint,
      azureApiKey,
      azureDeploymentName,
      azureApiVersion
    } = req.body;

    const processedPrompt = systemPrompt
      ? systemPrompt.replace(/\r\n/g, '\n').replace(/=/g, '')
      : '';


    const currentConfig = {
      PAPERLESS_API_URL: process.env.PAPERLESS_API_URL || '',
      PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
      PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
      AI_PROVIDER: process.env.AI_PROVIDER || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      OPENAI_MODEL: process.env.OPENAI_MODEL || '',
      OLLAMA_API_URL: process.env.OLLAMA_API_URL || '',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || '',
      SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
      SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
      PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
      TOKEN_LIMIT: process.env.TOKEN_LIMIT || 128000,
      RESPONSE_TOKENS: process.env.RESPONSE_TOKENS || 1000,
      TAGS: process.env.TAGS || '',
      ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
      AI_PROCESSED_TAG_NAME: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
      USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
      PROMPT_TAGS: process.env.PROMPT_TAGS || '',
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
      API_KEY: process.env.API_KEY || '',
      CUSTOM_API_KEY: process.env.CUSTOM_API_KEY || '',
      CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL || '',
      CUSTOM_MODEL: process.env.CUSTOM_MODEL || '',
      ACTIVATE_TAGGING: process.env.ACTIVATE_TAGGING || 'yes',
      ACTIVATE_CORRESPONDENTS: process.env.ACTIVATE_CORRESPONDENTS || 'yes',
      ACTIVATE_DOCUMENT_TYPE: process.env.ACTIVATE_DOCUMENT_TYPE || 'yes',
      ACTIVATE_TITLE: process.env.ACTIVATE_TITLE || 'yes',
      ACTIVATE_CUSTOM_FIELDS: process.env.ACTIVATE_CUSTOM_FIELDS || 'yes',
      CUSTOM_FIELDS: process.env.CUSTOM_FIELDS || '{"custom_fields":[]}',
      DISABLE_AUTOMATIC_PROCESSING: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
      AZURE_ENDPOINT: process.env.AZURE_ENDPOINT || '',
      AZURE_API_KEY: process.env.AZURE_API_KEY || '',
      AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
      AZURE_API_VERSION: process.env.AZURE_API_VERSION || '',
      RESTRICT_TO_EXISTING_TAGS: process.env.RESTRICT_TO_EXISTING_TAGS || 'no',
      RESTRICT_TO_EXISTING_CORRESPONDENTS: process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS || 'no',
      RESTRICT_TO_EXISTING_DOCUMENT_TYPES: process.env.RESTRICT_TO_EXISTING_DOCUMENT_TYPES || 'no',
      EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED || 'no',
      EXTERNAL_API_URL: process.env.EXTERNAL_API_URL || '',
      EXTERNAL_API_METHOD: process.env.EXTERNAL_API_METHOD || 'GET',
      EXTERNAL_API_HEADERS: process.env.EXTERNAL_API_HEADERS || '{}',
      EXTERNAL_API_BODY: process.env.EXTERNAL_API_BODY || '{}',
      EXTERNAL_API_TIMEOUT: process.env.EXTERNAL_API_TIMEOUT || '5000',
      EXTERNAL_API_TRANSFORM: process.env.EXTERNAL_API_TRANSFORM || ''
    };

    let processedCustomFields = [];
    if (customFields) {
      try {
        const parsedFields = typeof customFields === 'string'
          ? JSON.parse(customFields)
          : customFields;

        processedCustomFields = parsedFields.custom_fields.map(field => ({
          value: field.value,
          data_type: field.data_type,
          ...(field.currency && { currency: field.currency })
        }));
      } catch (error) {
        console.error('Error processing custom fields:', error);
        processedCustomFields = [];
      }
    }

    try {
      for (const field of processedCustomFields) {
        await paperlessService.createCustomFieldSafely(field.value, field.data_type, field.currency);
      }
    } catch (error) {
      console.log('[ERROR] Error creating custom fields:', error);
    }

    const restrictToExistingTags = req.body.restrictToExistingTags === 'on' || req.body.restrictToExistingTags === 'yes';
    const restrictToExistingCorrespondents = req.body.restrictToExistingCorrespondents === 'on' || req.body.restrictToExistingCorrespondents === 'yes';
    const restrictToExistingDocumentTypes = req.body.restrictToExistingDocumentTypes === 'on' || req.body.restrictToExistingDocumentTypes === 'yes';

    const externalApiEnabled = req.body.externalApiEnabled === 'on' || req.body.externalApiEnabled === 'yes';
    const externalApiUrl = req.body.externalApiUrl || '';
    const externalApiMethod = req.body.externalApiMethod || 'GET';
    const externalApiHeaders = req.body.externalApiHeaders || '{}';
    const externalApiBody = req.body.externalApiBody || '{}';
    const externalApiTimeout = req.body.externalApiTimeout || '5000';
    const externalApiTransform = req.body.externalApiTransform || '';

    if (paperlessUrl !== currentConfig.PAPERLESS_API_URL?.replace('/api', '') ||
      paperlessToken !== currentConfig.PAPERLESS_API_TOKEN) {
      const isPaperlessValid = await setupService.validatePaperlessConfig(paperlessUrl, paperlessToken);
      if (!isPaperlessValid) {
        return res.status(400).json({
          error: 'Paperless-ngx connection failed. Please check URL and Token.'
        });
      }
    }

    const updatedConfig = {};

    if (paperlessUrl) updatedConfig.PAPERLESS_API_URL = paperlessUrl + '/api';
    if (paperlessToken) updatedConfig.PAPERLESS_API_TOKEN = paperlessToken;
    if (paperlessUsername) updatedConfig.PAPERLESS_USERNAME = paperlessUsername;

    if (aiProvider) {
      updatedConfig.AI_PROVIDER = aiProvider;

      if (aiProvider === 'openai' && openaiKey) {
        const isOpenAIValid = await setupService.validateOpenAIConfig(openaiKey);
        if (!isOpenAIValid) {
          return res.status(400).json({
            error: 'OpenAI API Key is not valid. Please check the key.'
          });
        }
        updatedConfig.OPENAI_API_KEY = openaiKey;
        if (openaiModel) updatedConfig.OPENAI_MODEL = openaiModel;
      }
      else if (aiProvider === 'ollama' && (ollamaUrl || ollamaModel)) {
        const isOllamaValid = await setupService.validateOllamaConfig(
          ollamaUrl || currentConfig.OLLAMA_API_URL,
          ollamaModel || currentConfig.OLLAMA_MODEL
        );
        if (!isOllamaValid) {
          return res.status(400).json({
            error: 'Ollama connection failed. Please check URL and Model.'
          });
        }
        if (ollamaUrl) updatedConfig.OLLAMA_API_URL = ollamaUrl;
        if (ollamaModel) updatedConfig.OLLAMA_MODEL = ollamaModel;
      } else if (aiProvider === 'azure') {
        const isAzureValid = await setupService.validateAzureConfig(azureApiKey, azureEndpoint, azureDeploymentName, azureApiVersion);
        if (!isAzureValid) {
          return res.status(400).json({
            error: 'Azure connection failed. Please check URL, API Key, Deployment Name and API Version.'
          });
        }
        if (azureEndpoint) updatedConfig.AZURE_ENDPOINT = azureEndpoint;
        if (azureApiKey) updatedConfig.AZURE_API_KEY = azureApiKey;
        if (azureDeploymentName) updatedConfig.AZURE_DEPLOYMENT_NAME = azureDeploymentName;
        if (azureApiVersion) updatedConfig.AZURE_API_VERSION = azureApiVersion;
      }
    }

    if (scanInterval) updatedConfig.SCAN_INTERVAL = scanInterval;
    if (systemPrompt) updatedConfig.SYSTEM_PROMPT = processedPrompt.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
    if (showTags) updatedConfig.PROCESS_PREDEFINED_DOCUMENTS = showTags;
    if (tokenLimit) updatedConfig.TOKEN_LIMIT = tokenLimit;
    if (responseTokens) updatedConfig.RESPONSE_TOKENS = responseTokens;
    if (tags !== undefined) updatedConfig.TAGS = normalizeArray(tags);
    if (aiProcessedTag) updatedConfig.ADD_AI_PROCESSED_TAG = aiProcessedTag;
    if (aiTagName) updatedConfig.AI_PROCESSED_TAG_NAME = aiTagName;
    if (usePromptTags) updatedConfig.USE_PROMPT_TAGS = usePromptTags;
    if (promptTags) updatedConfig.PROMPT_TAGS = normalizeArray(promptTags);
    if (useExistingData) updatedConfig.USE_EXISTING_DATA = useExistingData;
    if (customApiKey) updatedConfig.CUSTOM_API_KEY = customApiKey;
    if (customBaseUrl) updatedConfig.CUSTOM_BASE_URL = customBaseUrl;
    if (customModel) updatedConfig.CUSTOM_MODEL = customModel;
    if (disableAutomaticProcessing) updatedConfig.DISABLE_AUTOMATIC_PROCESSING = disableAutomaticProcessing;

    if (processedCustomFields.length > 0 || customFields) {
      updatedConfig.CUSTOM_FIELDS = JSON.stringify({
        custom_fields: processedCustomFields
      });
    }

    updatedConfig.ACTIVATE_TAGGING = activateTagging ? 'yes' : 'no';
    updatedConfig.ACTIVATE_CORRESPONDENTS = activateCorrespondents ? 'yes' : 'no';
    updatedConfig.ACTIVATE_DOCUMENT_TYPE = activateDocumentType ? 'yes' : 'no';
    updatedConfig.ACTIVATE_TITLE = activateTitle ? 'yes' : 'no';
    updatedConfig.ACTIVATE_CUSTOM_FIELDS = activateCustomFields ? 'yes' : 'no';

    updatedConfig.RESTRICT_TO_EXISTING_TAGS = restrictToExistingTags ? 'yes' : 'no';
    updatedConfig.RESTRICT_TO_EXISTING_CORRESPONDENTS = restrictToExistingCorrespondents ? 'yes' : 'no';
    updatedConfig.RESTRICT_TO_EXISTING_DOCUMENT_TYPES = restrictToExistingDocumentTypes ? 'yes' : 'no';

    updatedConfig.EXTERNAL_API_ENABLED = externalApiEnabled ? 'yes' : 'no';
    updatedConfig.EXTERNAL_API_URL = externalApiUrl || '';
    updatedConfig.EXTERNAL_API_METHOD = externalApiMethod || 'GET';
    updatedConfig.EXTERNAL_API_HEADERS = externalApiHeaders || '{}';
    updatedConfig.EXTERNAL_API_BODY = externalApiBody || '{}';
    updatedConfig.EXTERNAL_API_TIMEOUT = externalApiTimeout || '5000';
    updatedConfig.EXTERNAL_API_TRANSFORM = externalApiTransform || '';

    let apiToken = process.env.API_KEY;
    if (!apiToken) {
      console.log('Generating new API key');
      apiToken = require('crypto').randomBytes(64).toString('hex');
      updatedConfig.API_KEY = apiToken;
    }

    const mergedConfig = {
      ...currentConfig,
      ...updatedConfig
    };

    await setupService.saveConfig(mergedConfig);
    try {
      for (const field of processedCustomFields) {
        await paperlessService.createCustomFieldSafely(field.value, field.data_type, field.currency);
      }
    } catch (error) {
      console.log('[ERROR] Error creating custom fields:', error);
    }

    res.json({
      success: true,
      message: 'Configuration saved successfully.',
      restart: true
    });

    setTimeout(() => {
      process.exit(0);
    }, 5000);

  } catch (error) {
    console.error('Settings update error:', error);
    res.status(500).json({
      error: 'An error occurred: ' + error.message
    });
  }
});

module.exports = router;
