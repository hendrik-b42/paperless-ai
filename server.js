const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const config = require('./config/config');
const paperlessService = require('./services/paperlessService');
const AIServiceFactory = require('./services/aiServiceFactory');
const documentModel = require('./models/document');
const setupService = require('./services/setupService');
const setupRoutes = require('./routes/setup');

// Add environment variables for RAG service if not already set
process.env.RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || 'http://localhost:8000';
process.env.RAG_SERVICE_ENABLED = process.env.RAG_SERVICE_ENABLED || 'true';
const cors = require('cors');
const cookieParser = require('cookie-parser');
const Logger = require('./services/loggerService');
const { max } = require('date-fns');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');

const htmlLogger = new Logger({
  logFile: 'logs.html',
  format: 'html',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const txtLogger = new Logger({
  logFile: 'logs.txt',
  format: 'txt',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const app = express();
let runningTask = false;


const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'x-api-key',
    'Access-Control-Allow-Private-Network'
  ],
  credentials: false
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Access-Control-Allow-Private-Network');
  res.header('Access-Control-Allow-Private-Network', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// Swagger documentation route
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  swaggerOptions: {
    url: '/api-docs/openapi.json'
  }
}));

/**
 * @swagger
 * /api-docs/openapi.json:
 *   get:
 *     summary: Retrieve the OpenAPI specification
 *     description: |
 *       Returns the complete OpenAPI specification for the Paperless-AI API.
 *       This endpoint attempts to serve a static OpenAPI JSON file first, falling back
 *       to dynamically generating the specification if the file cannot be read.
 *       
 *       The OpenAPI specification document contains all API endpoints, parameters,
 *       request bodies, responses, and schemas for the entire application.
 *     tags: [API, System]
 *     responses:
 *       200:
 *         description: OpenAPI specification returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: The complete OpenAPI specification
 *       404:
 *         description: OpenAPI specification file not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error occurred while retrieving the OpenAPI specification
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/api-docs/openapi.json', (req, res) => {
  const openApiPath = path.join(process.cwd(), 'OPENAPI', 'openapi.json');
  res.setHeader('Content-Type', 'application/json');
  
  // Try to serve the static file first
  fs.readFile(openApiPath)
    .then(data => {
      res.send(JSON.parse(data));
    })
    .catch(err => {
      console.warn('Error reading OpenAPI file, generating dynamically:', err.message);
      // Fallback to generating the spec if file can't be read
      res.send(swaggerSpec);
    });
});

// Add a redirect for the old endpoint for backward compatibility
app.get('/api-docs.json', (req, res) => {
  res.redirect('/api-docs/openapi.json');
});

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// //Layout middleware
// app.use((req, res, next) => {
//   const originalRender = res.render;
//   res.render = function (view, locals = {}) {
//     originalRender.call(this, view, locals, (err, html) => {
//       if (err) return next(err);
//       originalRender.call(this, 'layout', { content: html, ...locals });
//     });
//   };
//   next();
// });


// Initialize data directory
async function initializeDataDirectory() {
  const dataDir = path.join(process.cwd(), 'data');
  try {
    await fs.access(dataDir);
  } catch {
    console.log('Creating data directory...');
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// Save OpenAPI specification to file
async function saveOpenApiSpec() {
  const openApiDir = path.join(process.cwd(), 'OPENAPI');
  const openApiPath = path.join(openApiDir, 'openapi.json');
  try {
    // Ensure the directory exists
    try {
      await fs.access(openApiDir);
    } catch {
      console.log('Creating OPENAPI directory...');
      await fs.mkdir(openApiDir, { recursive: true });
    }
    
    // Write the specification to file
    await fs.writeFile(openApiPath, JSON.stringify(swaggerSpec, null, 2));
    console.log(`OpenAPI specification saved to ${openApiPath}`);
    return true;
  } catch (error) {
    console.error('Failed to save OpenAPI specification:', error);
    return false;
  }
}

// Document processing functions
async function processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId, options = {}) {
  const isProcessed = await documentModel.isDocumentProcessed(doc.id);
  if (isProcessed) return null;
  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  //Check if the Document can be edited
  const documentEditable = await paperlessService.getPermissionOfDocument(doc.id);
  if (!documentEditable) {
    console.log(`[DEBUG] Document belongs to: ${documentEditable}, skipping analysis`);
    console.log(`[DEBUG] Document ${doc.id} Not Editable by Paper-Ai User, skipping analysis`);
    return null;
  }else {
    console.log(`[DEBUG] Document ${doc.id} rights for AI User - processed`);
  }

  let [content, originalData] = await Promise.all([
    paperlessService.getDocumentContent(doc.id),
    paperlessService.getDocument(doc.id)
  ]);

  if (!content || !content.length >= 10) {
    console.log(`[DEBUG] Document ${doc.id} has no content, skipping analysis`);
    return null;
  }

  if (content.length > 50000) {
    content = content.substring(0, 50000);
  }

  const aiService = AIServiceFactory.getService();
  const analysis = await aiService.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id, null, options);
  console.log('Repsonse from AI service:', analysis);
  if (analysis.error) {
    throw new Error(`[ERROR] Document analysis failed: ${analysis.error}`);
  }
  await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
  return { analysis, originalData };
}

// Fix #937: Normalize LLM-returned numeric values for custom fields.
// Accepts both "." and "," as decimal separator. Strips currency symbols,
// spaces and thousand separators. Returns null if no valid number found.
function normalizeNumericFieldValue(raw, dataType) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s.length === 0) return null;

  // Strip currency symbols and currency codes
  s = s.replace(/€|EUR|EURO|\$|USD|£|GBP|CHF|¥/gi, '').trim();
  // Strip whitespace inside the number
  s = s.replace(/\s+/g, '');
  // Strip +/- signs but remember them
  let sign = '';
  if (s.startsWith('-')) { sign = '-'; s = s.slice(1); }
  else if (s.startsWith('+')) { s = s.slice(1); }

  // Figure out which separator is the decimal one.
  // Heuristic: if both . and , exist, the RIGHTMOST one is decimal.
  // If only one exists and it has 1-3 digits after it AND the number is short, it's decimal.
  // Tausendertrenner-Pattern: 1.234,56 (DE) or 1,234.56 (US) or 1234,56 (DE simple) or 1234.56 (US simple)
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // German style: 1.234,56 — dot is thousand, comma is decimal
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US style: 1,234.56 — comma is thousand, dot is decimal
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Only comma: treat as decimal
    s = s.replace(',', '.');
  }
  // If only dot, leave as-is (standard US format already)

  const n = parseFloat(sign + s);
  if (!isFinite(n)) return null;

  // For integer fields, reject fractions (but round minor floats like 42.0)
  if (dataType === 'integer') {
    if (!Number.isInteger(n) && Math.abs(n - Math.round(n)) > 0.0001) return null;
    return String(Math.round(n));
  }
  // For monetary and float, return with dot-decimal
  return String(n);
}

async function buildUpdateData(analysis, doc) {
  const updateData = {};

  console.log('TEST: ', config.addAIProcessedTag)
  console.log('TEST 2: ', config.addAIProcessedTags)
  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    const proposedTags = Array.isArray(analysis.document.tags) ? analysis.document.tags : [];
    if (proposedTags.length === 0) {
      console.warn(`[WARN] LLM returned ZERO tags for document "${analysis.document.title || doc?.id}". This usually means the prompt is too conservative or the taxonomy is too empty. Consider tightening the Hard-Minimum rule in your custom prompt.`);
    }
    const { tagIds, errors } = await paperlessService.processTags(proposedTags);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
  } else if (config.limitFunctions?.activateTagging === 'no' && config.addAIProcessedTag === 'yes') {
    // Add AI processed tags to the document (processTags function awaits a tags array)
    // get tags from .env file and split them by comma and make an array
    console.log('[DEBUG] Tagging is deactivated but AI processed tag will be added');
    const tags = config.addAIProcessedTags.split(',');
    const { tagIds, errors } = await paperlessService.processTags(tags);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
    console.log('[DEBUG] Tagging is deactivated');
  }

  // Only process title if title generation is activated
  if (config.limitFunctions?.activateTitle !== 'no') {
    updateData.title = analysis.document.title || doc.title;
  }

  // Add created date regardless of settings as it's a core field
  updateData.created = analysis.document.document_date || doc.created;

  // Only process document type if document type classification is activated
  if (config.limitFunctions?.activateDocumentType !== 'no' && analysis.document.document_type) {
    try {
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type);
      if (documentType) {
        updateData.document_type = documentType.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing document type:`, error);
    }
  }
  
  // Only process custom fields if custom fields detection is activated
  if (config.limitFunctions?.activateCustomFields !== 'no' && analysis.document.custom_fields) {
    const customFields = analysis.document.custom_fields;
    const processedFields = [];

    // Get existing custom fields
    const existingFields = await paperlessService.getExistingCustomFields(doc.id);
    console.log(`[DEBUG] Found existing fields:`, existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const key in customFields) {
      const customField = customFields[key];

      // Fix #931: value might be a number, null, undefined — coerce to string
      // and do an empty check that doesn't crash on non-strings.
      if (!customField.field_name) {
        console.log(`[DEBUG] Skipping custom field with missing field_name`);
        continue;
      }
      const rawValue = customField.value;
      if (rawValue === null || rawValue === undefined) {
        console.log(`[DEBUG] Skipping custom field "${customField.field_name}" with null/undefined value`);
        continue;
      }
      let stringValue = String(rawValue).trim();
      if (stringValue.length === 0) {
        console.log(`[DEBUG] Skipping empty custom field "${customField.field_name}"`);
        continue;
      }

      const fieldDetails = await paperlessService.findExistingCustomField(customField.field_name);
      if (fieldDetails?.id) {
        // Fix #937: defensive number parsing for monetary / integer / float
        // fields. LLMs happily return "1.234,56" for EUR values; Paperless
        // rejects that format and skips the whole document silently.
        let normalizedValue = stringValue;
        const dataType = fieldDetails.data_type;
        if (['monetary', 'integer', 'float'].includes(dataType)) {
          normalizedValue = normalizeNumericFieldValue(stringValue, dataType);
          if (normalizedValue === null) {
            console.warn(`[WARN] Could not parse "${stringValue}" as ${dataType} for field "${customField.field_name}" — skipping this field.`);
            continue;
          }
        }
        processedFields.push({
          field: fieldDetails.id,
          value: normalizedValue,
        });
        processedFieldIds.add(fieldDetails.id);
      }
    }

    // Then add any existing fields that weren't updated
    for (const existingField of existingFields) {
      if (!processedFieldIds.has(existingField.field)) {
        processedFields.push(existingField);
      }
    }

    if (processedFields.length > 0) {
      updateData.custom_fields = processedFields;
    }
  }

  // Only process correspondent if correspondent detection is activated
  if (config.limitFunctions?.activateCorrespondents !== 'no' && analysis.document.correspondent) {
    try {
      const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent);
      if (correspondent) {
        updateData.correspondent = correspondent.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing correspondent:`, error);
    }
  }

  // Always include language if provided as it's a core field
  if (analysis.document.language) {
    updateData.language = analysis.document.language;
  }

  return updateData;
}

async function saveDocumentChanges(docId, updateData, analysis, originalData) {
  const { tags: originalTags, correspondent: originalCorrespondent, title: originalTitle } = originalData;
  
  await Promise.all([
    documentModel.saveOriginalData(docId, originalTags, originalCorrespondent, originalTitle),
    paperlessService.updateDocument(docId, updateData),
    documentModel.addProcessedDocument(docId, updateData.title),
    documentModel.addOpenAIMetrics(
      docId, 
      analysis.metrics.promptTokens,
      analysis.metrics.completionTokens,
      analysis.metrics.totalTokens
    ),
    documentModel.addToHistory(docId, updateData.tags, updateData.title, analysis.document.correspondent)
  ]);
}

// Main scanning functions
async function scanInitial() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log('[ERROR] Setup not completed. Skipping document scan.');
      return;
    }

    // Nutze WithCount-Varianten damit wir document_count für die Prompt-Sortierung haben.
    let [tagObjects, documents, ownUserId, correspondentObjects, documentTypeObjects] = await Promise.all([
      paperlessService.listTagsWithCount(),
      paperlessService.getAllDocuments(),
      paperlessService.getOwnUserID(),
      paperlessService.listCorrespondentsNames(),       // liefert schon {name, id, document_count}
      paperlessService.listDocumentTypesWithCount()
    ]);

    const existingTagNames = tagObjects.map(t => t.name);
    const existingCorrespondentNames = correspondentObjects.map(c => c.name);
    const existingDocumentTypeNames = documentTypeObjects.map(dt => dt.name);

    // Strukturierte Versionen für den AI-Prompt (siehe openaiService Fix B)
    const taxonomyOptions = {
      existingTagsWithCounts: tagObjects,
      existingCorrespondentsWithCounts: correspondentObjects,
      existingDocumentTypesWithCounts: documentTypeObjects,
    };

    for (const doc of documents) {
      try {
        const result = await processDocument(
          doc,
          existingTagNames,
          existingCorrespondentNames,
          existingDocumentTypeNames,
          ownUserId,
          taxonomyOptions
        );
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
      } catch (error) {
        console.error(`[ERROR] processing document ${doc.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[ERROR] during initial document scan:', error);
  }
}

async function scanDocuments() {
  if (runningTask) {
    console.log('[DEBUG] Task already running');
    return;
  }

  runningTask = true;
  try {
    let [tagObjects, documents, ownUserId, correspondentObjects, documentTypeObjects] = await Promise.all([
      paperlessService.listTagsWithCount(),
      paperlessService.getAllDocuments(),
      paperlessService.getOwnUserID(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesWithCount()
    ]);

    const existingTagNames = tagObjects.map(t => t.name);
    const existingCorrespondentNames = correspondentObjects.map(c => c.name);
    const existingDocumentTypeNames = documentTypeObjects.map(dt => dt.name);

    const taxonomyOptions = {
      existingTagsWithCounts: tagObjects,
      existingCorrespondentsWithCounts: correspondentObjects,
      existingDocumentTypesWithCounts: documentTypeObjects,
    };

    for (const doc of documents) {
      try {
        const result = await processDocument(
          doc,
          existingTagNames,
          existingCorrespondentNames,
          existingDocumentTypeNames,
          ownUserId,
          taxonomyOptions
        );
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
      } catch (error) {
        console.error(`[ERROR] processing document ${doc.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[ERROR]  during document scan:', error);
  } finally {
    runningTask = false;
    console.log('[INFO] Task completed');
  }
}

// Routes
app.use('/', setupRoutes);
const authRoutes = require('./routes/auth');
const ragRoutes = require('./routes/rag');
const optimizerRoutes = require('./routes/optimizer');
app.use('/', optimizerRoutes);

// Mount RAG routes if enabled
if (process.env.RAG_SERVICE_ENABLED === 'true') {
  app.use('/api/rag', ragRoutes);
  
  // RAG UI route
  app.get('/rag', async (req, res) => {
    try {
      res.render('rag', { 
        title: 'Dokumenten-Fragen'
      });
    } catch (error) {
      console.error('Error rendering RAG UI:', error);
      res.status(500).send('Error loading RAG interface');
    }
  });
}

/**
 * @swagger
 * /:
 *   get:
 *     summary: Root endpoint that redirects to the dashboard
 *     description: |
 *       This endpoint serves as the entry point for the application.
 *       When accessed, it automatically redirects the user to the dashboard page.
 *       No parameters or authentication are required for this redirection.
 *     tags: [Navigation, System]
 *     responses:
 *       302:
 *         description: Redirects to the dashboard page
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               example: "<html><body>Redirecting to dashboard...</body></html>"
 *       500:
 *         description: Server error occurred during redirection
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/', async (req, res) => {
  try {
    res.redirect('/dashboard');
  } catch (error) {
    console.error('[ERROR] in root route:', error);
    res.status(500).send('Error processing request');
  }
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: System health check endpoint
 *     description: |
 *       Checks if the application is properly configured and the database is reachable.
 *       This endpoint can be used by monitoring systems to verify service health.
 *       
 *       The endpoint returns a 200 status code with a "healthy" status if everything is 
 *       working correctly, or a 503 status code with error details if there are issues.
 *     tags: [System]
 *     responses:
 *       200:
 *         description: System is healthy and operational
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "healthy"
 *                   description: Health status indication
 *       503:
 *         description: System is not fully configured or database is unreachable
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [not_configured, error]
 *                   example: "not_configured"
 *                   description: Error status type
 *                 message:
 *                   type: string
 *                   example: "Application setup not completed"
 *                   description: Detailed error message
 */
app.get('/health', async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.status(503).json({ 
        status: 'not_configured',
        message: 'Application setup not completed'
      });
    }

    await documentModel.isDocumentProcessed(1);
    res.json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start scanning
async function startScanning() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log(`Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`);
    }

    const userId = await paperlessService.getOwnUserID();
    if (!userId) {
      console.error('Failed to get own user ID. Abort scanning.');
      return;
    }

    console.log('Configured scan interval:', config.scanInterval);
    console.log(`Starting initial scan at ${new Date().toISOString()}`);
    if(config.disableAutomaticProcessing != 'yes') {
      await scanInitial();

      cron.schedule(config.scanInterval, async () => {
        console.log(`Starting scheduled scan at ${new Date().toISOString()}`);
        await scanDocuments();
      });
    }

    // Entity Optimizer — periodic sync check
    // Runs analyze() for correspondents AND tags in the background and updates the
    // pending-suggestion cache in SQLite. The sidebar badge reads from the cache,
    // so the UI stays cheap. Default: every 12 hours. Override with OPTIMIZER_SYNC_CRON.
    if ((process.env.OPTIMIZER_SYNC_ENABLED || 'yes').toLowerCase() === 'yes') {
      const optimizerCron = process.env.OPTIMIZER_SYNC_CRON || '0 */12 * * *';
      const optimizerService = require('./services/entityOptimizerService');
      const runSyncCheck = async () => {
        try {
          console.log(`[optimizer.sync] Starting at ${new Date().toISOString()}`);
          const corr = await optimizerService.analyze('correspondent', { threshold: 0.85, useLlm: true, minDocuments: 0 });
          const tag = await optimizerService.analyze('tag', { threshold: 0.85, useLlm: true, minDocuments: 0 });
          const dt = await optimizerService.analyze('document_type', { threshold: 0.85, useLlm: true, minDocuments: 0 });
          console.log(`[optimizer.sync] Done. Correspondents: ${corr.clustersFound}. Tags: ${tag.clustersFound}. DocumentTypes: ${dt.clustersFound}.`);
        } catch (e) {
          console.error('[optimizer.sync] Failed:', e.message);
        }
      };
      cron.schedule(optimizerCron, runSyncCheck);
      console.log(`[optimizer.sync] Scheduled with cron "${optimizerCron}"`);
      // Optional: Laufe einmal kurz nach dem Start (verzögert, damit Paperless schon bereit ist)
      if ((process.env.OPTIMIZER_SYNC_ON_START || 'no').toLowerCase() === 'yes') {
        setTimeout(runSyncCheck, 60_000);
      }
    }
  } catch (error) {
    console.error('[ERROR] in startScanning:', error);
  }
}

// Error handlers
// process.on('SIGTERM', async () => {
//   console.log('Received SIGTERM. Starting graceful shutdown...');
//   try {
//     console.log('Closing database...');
//     await documentModel.closeDatabase(); // Jetzt warten wir wirklich auf den Close
//     console.log('Database closed successfully');
//     process.exit(0);
//   } catch (error) {
//     console.error('[ERROR] during shutdown:', error);
//     process.exit(1);
//   }
// });

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

async function gracefulShutdown(signal) {
  console.log(`[DEBUG] Received ${signal} signal. Starting graceful shutdown...`);
  try {
    console.log('[DEBUG] Closing database...');
    await documentModel.closeDatabase();
    console.log('[DEBUG] Database closed successfully');
    process.exit(0);
  } catch (error) {
    console.error(`[ERROR] during ${signal} shutdown:`, error);
    process.exit(1);
  }
}

// Handle both SIGTERM and SIGINT
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
async function startServer() {
  const port = process.env.PAPERLESS_AI_PORT || 3000;
  try {
    await initializeDataDirectory();
    await saveOpenApiSpec(); // Save OpenAPI specification on startup
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      startScanning();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
