const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');

const normalizeArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
};

/**
 * @swagger
 * /setup:
 *   get:
 *     summary: Application setup page
 *     description: |
 *       Renders the application setup page for initial configuration.
 *
 *       This page allows configuring the connection to Paperless-ngx, AI services,
 *       and other application settings. It loads existing configuration if available
 *       and redirects to dashboard if setup is already complete.
 *
 *       The setup page is the entry point for new installations and guides users through
 *       the process of connecting to Paperless-ngx, configuring AI providers, and setting up
 *       admin credentials.
 *     tags:
 *       - Navigation
 *       - Setup
 *       - System
 *     responses:
 *       200:
 *         description: Setup page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the application setup page
 *       302:
 *         description: Redirects to dashboard if setup is already complete
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/dashboard"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/setup', async (req, res) => {
  try {
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
      PROCESS_ONLY_NEW_DOCUMENTS: process.env.PROCESS_ONLY_NEW_DOCUMENTS || 'yes',
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
      DISABLE_AUTOMATIC_PROCESSING: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
      AZURE_ENDPOINT: process.env.AZURE_ENDPOINT || '',
      AZURE_API_KEY: process.env.AZURE_API_KEY || '',
      AZURE_DEPLOYMENT_NAME: process.env.AZURE_DEPLOYMENT_NAME || '',
      AZURE_API_VERSION: process.env.AZURE_API_VERSION || ''
    };

    const [isEnvConfigured, users] = await Promise.all([
      setupService.isConfigured(),
      documentModel.getUsers()
    ]);

    if (isEnvConfigured) {
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

    const hasUsers = Array.isArray(users) && users.length > 0;
    const isFullyConfigured = isEnvConfigured && hasUsers;

    let successMessage;
    if (isEnvConfigured && !hasUsers) {
      successMessage = 'Environment is configured, but no users exist. Please create at least one user.';
    } else if (isEnvConfigured) {
      successMessage = 'The application is already configured. You can update the configuration below.';
    }

    if (isFullyConfigured) {
      return res.redirect('/dashboard');
    }

    res.render('setup', {
      config,
      success: successMessage
    });
  } catch (error) {
    console.error('Setup route error:', error);
    res.status(500).render('setup', {
      config: {},
      error: 'An error occurred while loading the setup page.'
    });
  }
});

/**
 * @swagger
 * /setup:
 *   post:
 *     summary: Submit initial application setup configuration
 *     description: |
 *       Configures the initial setup of the Paperless-AI application, including connections
 *       to Paperless-ngx, AI provider settings, processing parameters, and user authentication.
 *
 *       This endpoint is primarily used during the first-time setup of the application and
 *       creates the necessary configuration files and database tables.
 *     tags:
 *       - System
 *       - Setup
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - paperlessUrl
 *               - paperlessToken
 *               - aiProvider
 *               - username
 *               - password
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
 *               username:
 *                 type: string
 *                 description: Admin username for Paperless-AI
 *                 example: "admin"
 *               password:
 *                 type: string
 *                 description: Admin password for Paperless-AI
 *                 example: "securepassword"
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
 *     responses:
 *       200:
 *         description: Setup completed successfully
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
 *                   example: "Configuration saved successfully"
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
 *                   example: "Missing required configuration parameters"
 *       500:
 *         description: Server error during setup
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
 *                   example: "Failed to save configuration: Database error"
 */
router.post('/setup', express.json(), async (req, res) => {
  try {
    const {
      paperlessUrl,
      paperlessToken,
      paperlessUsername,
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
      username,
      password,
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

    const sensitiveKeys = ['paperlessToken', 'openaiKey', 'customApiKey', 'password', 'confirmPassword'];
    const redactedBody = Object.fromEntries(
      Object.entries(req.body).map(([key, value]) => [
        key,
        sensitiveKeys.includes(key) ? '******' : value
      ])
    );
    console.log('Setup request received:', redactedBody);


    const paperlessApiUrl = paperlessUrl + '/api';
    const initSuccess = await paperlessService.initializeWithCredentials(paperlessApiUrl, paperlessToken);

    if (!initSuccess) {
      return res.status(400).json({
        error: 'Failed to initialize connection to Paperless-ngx. Please check URL and Token.'
      });
    }

    const isPaperlessValid = await setupService.validatePaperlessConfig(paperlessUrl, paperlessToken);
    if (!isPaperlessValid) {
      return res.status(400).json({
        error: 'Paperless-ngx connection failed. Please check URL and Token.'
      });
    }

    const isPermissionValid = await setupService.validateApiPermissions(paperlessUrl, paperlessToken);
    if (!isPermissionValid.success) {
      return res.status(400).json({
        error: 'Paperless-ngx API permissions are insufficient. Error: ' + isPermissionValid.message
      });
    }

    let processedCustomFields = [];
    if (customFields && activateCustomFields) {
      try {
        const parsedFields = typeof customFields === 'string'
          ? JSON.parse(customFields)
          : customFields;

        for (const field of parsedFields.custom_fields) {
          try {
            const createdField = await paperlessService.createCustomFieldSafely(
              field.value,
              field.data_type,
              field.currency
            );

            if (createdField) {
              processedCustomFields.push({
                value: field.value,
                data_type: field.data_type,
                ...(field.currency && { currency: field.currency })
              });
              console.log(`[SUCCESS] Created/found custom field: ${field.value}`);
            }
          } catch (fieldError) {
            console.error(`[WARNING] Error creating custom field ${field.value}:`, fieldError);
          }
        }
      } catch (error) {
        console.error('[ERROR] Error processing custom fields:', error);
      }
    }

    const apiToken = process.env.API_KEY || require('crypto').randomBytes(64).toString('hex');
    const jwtToken = process.env.JWT_SECRET || require('crypto').randomBytes(64).toString('hex');

    const processedPrompt = systemPrompt
      ? systemPrompt.replace(/\r\n/g, '\n').replace(/\n/g, '\\n').replace(/=/g, '')
      : '';

    const config = {
      PAPERLESS_API_URL: paperlessApiUrl,
      PAPERLESS_API_TOKEN: paperlessToken,
      PAPERLESS_USERNAME: paperlessUsername,
      AI_PROVIDER: aiProvider,
      SCAN_INTERVAL: scanInterval || '*/30 * * * *',
      SYSTEM_PROMPT: processedPrompt,
      PROCESS_PREDEFINED_DOCUMENTS: showTags || 'no',
      TOKEN_LIMIT: tokenLimit || 128000,
      RESPONSE_TOKENS: responseTokens || 1000,
      TAGS: normalizeArray(tags),
      ADD_AI_PROCESSED_TAG: aiProcessedTag || 'no',
      AI_PROCESSED_TAG_NAME: aiTagName || 'ai-processed',
      USE_PROMPT_TAGS: usePromptTags || 'no',
      PROMPT_TAGS: normalizeArray(promptTags),
      USE_EXISTING_DATA: useExistingData || 'no',
      API_KEY: apiToken,
      JWT_SECRET: jwtToken,
      CUSTOM_API_KEY: customApiKey || '',
      CUSTOM_BASE_URL: customBaseUrl || '',
      CUSTOM_MODEL: customModel || '',
      PAPERLESS_AI_INITIAL_SETUP: 'yes',
      ACTIVATE_TAGGING: activateTagging ? 'yes' : 'no',
      ACTIVATE_CORRESPONDENTS: activateCorrespondents ? 'yes' : 'no',
      ACTIVATE_DOCUMENT_TYPE: activateDocumentType ? 'yes' : 'no',
      ACTIVATE_TITLE: activateTitle ? 'yes' : 'no',
      ACTIVATE_CUSTOM_FIELDS: activateCustomFields ? 'yes' : 'no',
      CUSTOM_FIELDS: processedCustomFields.length > 0
        ? JSON.stringify({ custom_fields: processedCustomFields })
        : '{"custom_fields":[]}',
      DISABLE_AUTOMATIC_PROCESSING: disableAutomaticProcessing ? 'yes' : 'no',
      AZURE_ENDPOINT: azureEndpoint || '',
      AZURE_API_KEY: azureApiKey || '',
      AZURE_DEPLOYMENT_NAME: azureDeploymentName || '',
      AZURE_API_VERSION: azureApiVersion || ''
    };

    if (aiProvider === 'openai') {
      const isOpenAIValid = await setupService.validateOpenAIConfig(openaiKey);
      if (!isOpenAIValid) {
        return res.status(400).json({
          error: 'OpenAI API Key is not valid. Please check the key.'
        });
      }
      config.OPENAI_API_KEY = openaiKey;
      config.OPENAI_MODEL = openaiModel || 'gpt-4o-mini';
    } else if (aiProvider === 'ollama') {
      const isOllamaValid = await setupService.validateOllamaConfig(ollamaUrl, ollamaModel);
      if (!isOllamaValid) {
        return res.status(400).json({
          error: 'Ollama connection failed. Please check URL and Model.'
        });
      }
      config.OLLAMA_API_URL = ollamaUrl || 'http://localhost:11434';
      config.OLLAMA_MODEL = ollamaModel || 'llama3.2';
    } else if (aiProvider === 'custom') {
      const isCustomValid = await setupService.validateCustomConfig(customBaseUrl, customApiKey, customModel);
      if (!isCustomValid) {
        return res.status(400).json({
          error: 'Custom connection failed. Please check URL, API Key and Model.'
        });
      }
      config.CUSTOM_BASE_URL = customBaseUrl;
      config.CUSTOM_API_KEY = customApiKey;
      config.CUSTOM_MODEL = customModel;
    } else if (aiProvider === 'azure') {
      const isAzureValid = await setupService.validateAzureConfig(azureApiKey, azureEndpoint, azureDeploymentName, azureApiVersion);
      if (!isAzureValid) {
        return res.status(400).json({
          error: 'Azure connection failed. Please check URL, API Key, Deployment Name and API Version.'
        });
      }
    }

    await setupService.saveConfig(config);
    const hashedPassword = await bcrypt.hash(password, 15);
    await documentModel.addUser(username, hashedPassword);

    res.json({
      success: true,
      message: 'Configuration saved successfully.',
      restart: true
    });

    setTimeout(() => {
      process.exit(0);
    }, 5000);

  } catch (error) {
    console.error('[ERROR] Setup error:', error);
    res.status(500).json({
      error: 'An error occurred: ' + error.message
    });
  }
});

module.exports = router;
