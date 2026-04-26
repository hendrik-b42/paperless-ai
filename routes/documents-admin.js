const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const AIServiceFactory = require('../services/aiServiceFactory');
const config = require('../config/config.js');

let runningTask = false;
const documentQueue = [];
let isProcessing = false;

function extractDocumentId(url) {
  const match = url.match(/\/documents\/(\d+)\//);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  throw new Error('Could not extract document ID from URL');
}

async function processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId, customPrompt = null) {
  const isProcessed = await documentModel.isDocumentProcessed(doc.id);
  if (isProcessed) return null;
  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  const documentEditable = await paperlessService.getPermissionOfDocument(doc.id);
  if (!documentEditable) {
    console.log(`[DEBUG] Document belongs to: ${documentEditable}, skipping analysis`);
    console.log(`[DEBUG] Document ${doc.id} Not Editable by Paper-Ai User, skipping analysis`);
    return null;
  } else {
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

  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes',
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes'
  };

  if (config.externalApiConfig.enabled === 'yes') {
    try {
      const externalApiService = require('../services/externalApiService');
      const externalData = await externalApiService.fetchData();
      if (externalData) {
        options.externalApiData = externalData;
        console.log('[DEBUG] Retrieved external API data for prompt enrichment');
      }
    } catch (error) {
      console.error('[ERROR] Failed to fetch external API data:', error.message);
    }
  }

  const aiService = AIServiceFactory.getService();
  let analysis;
  if (customPrompt) {
    console.log('[DEBUG] Starting document analysis with custom prompt');
    analysis = await aiService.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id, customPrompt, options);
  } else {
    analysis = await aiService.analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, doc.id, null, options);
  }
  console.log('Repsonse from AI service:', analysis);
  if (analysis.error) {
    throw new Error(`[ERROR] Document analysis failed: ${analysis.error}`);
  }
  await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
  return { analysis, originalData };
}

async function buildUpdateData(analysis, doc) {
  const updateData = {};

  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes' ? true : false,
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes' ? true : false
  };

  console.log(`[DEBUG] Building update data with restrictions: tags=${options.restrictToExistingTags}, correspondents=${options.restrictToExistingCorrespondents}`);

  if (config.limitFunctions?.activateTagging !== 'no') {
    const { tagIds, errors } = await paperlessService.processTags(analysis.document.tags, options);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
  } else if (config.limitFunctions?.activateTagging === 'no' && config.addAIProcessedTag === 'yes') {
    console.log('[DEBUG] Tagging is deactivated but AI processed tag will be added');
    const tags = config.addAIProcessedTags.split(',');
    const { tagIds, errors } = await paperlessService.processTags(tags, options);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
    console.log('[DEBUG] Tagging is deactivated');
  }

  if (config.limitFunctions?.activateTitle !== 'no') {
    updateData.title = analysis.document.title || doc.title;
  }

  updateData.created = analysis.document.document_date || doc.created;

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

  if (config.limitFunctions?.activateCustomFields !== 'no' && analysis.document.custom_fields) {
    const customFields = analysis.document.custom_fields;
    const processedFields = [];

    const existingFields = await paperlessService.getExistingCustomFields(doc.id);
    console.log(`[DEBUG] Found existing fields:`, existingFields);

    const processedFieldIds = new Set();

    for (const key in customFields) {
      const customField = customFields[key];

      if (!customField.field_name || !customField.value?.trim()) {
        console.log(`[DEBUG] Skipping empty/invalid custom field`);
        continue;
      }

      const fieldDetails = await paperlessService.findExistingCustomField(customField.field_name);
      if (fieldDetails?.id) {
        processedFields.push({
          field: fieldDetails.id,
          value: customField.value.trim()
        });
        processedFieldIds.add(fieldDetails.id);
      }
    }

    for (const existingField of existingFields) {
      if (!processedFieldIds.has(existingField.field)) {
        processedFields.push(existingField);
      }
    }

    if (processedFields.length > 0) {
      updateData.custom_fields = processedFields;
    }
  }

  if (config.limitFunctions?.activateCorrespondents !== 'no' && analysis.document.correspondent) {
    try {
      const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent, options);
      if (correspondent) {
        updateData.correspondent = correspondent.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing correspondent:`, error);
    }
  }

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

async function processQueue(customPrompt) {
  if (customPrompt) {
    console.log('Using custom prompt:', customPrompt);
  }

  if (isProcessing || documentQueue.length === 0) return;

  isProcessing = true;

  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log(`Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`);
      return;
    }

    const userId = await paperlessService.getOwnUserID();
    if (!userId) {
      console.error('Failed to get own user ID. Abort scanning.');
      return;
    }

    const [existingTags, existingCorrespondentList, existingDocumentTypes, ownUserId] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesNames(),
      paperlessService.getOwnUserID()
    ]);

    const existingDocumentTypesList = existingDocumentTypes.map(docType => docType.name);

    while (documentQueue.length > 0) {
      const doc = documentQueue.shift();

      try {
        const result = await processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId, customPrompt);
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
      } catch (error) {
        console.error(`[ERROR] Failed to process document ${doc.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[ERROR] Error during queue processing:', error);
  } finally {
    isProcessing = false;

    if (documentQueue.length > 0) {
      processQueue();
    }
  }
}

/**
 * @swagger
 * /sampleData/{id}:
 *   get:
 *     summary: Get sample data for a document
 *     description: |
 *       Retrieves sample data extracted from a document, including processed text content
 *       and any metadata that has been extracted or processed by the AI.
 *
 *       This endpoint is commonly used for previewing document data in the UI before
 *       completing document processing or updating metadata.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Document ID to retrieve sample data for
 *         example: 123
 *     responses:
 *       200:
 *         description: Document sample data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 content:
 *                   type: string
 *                   description: Extracted text content from the document
 *                   example: "Invoice from Acme Corp. Total amount: $125.00, Due date: 2023-08-15"
 *                 metadata:
 *                   type: object
 *                   description: Any metadata that has been extracted from the document
 *                   properties:
 *                     title:
 *                       type: string
 *                       example: "Acme Corp Invoice - August 2023"
 *                     tags:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["Invoice", "Finance"]
 *                     correspondent:
 *                       type: string
 *                       example: "Acme Corp"
 *       404:
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Document not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/sampleData/:id', async (req, res) => {
  try {
    const document = await paperlessService.getDocument(req.params.id);
    const correspondents = await paperlessService.getCorrespondentsFromDocument(document.id);
  } catch (error) {
    console.error('[ERRO] loading sample data:', error);
    res.status(500).json({ error: 'Error loading sample data' });
  }
});

/**
 * @swagger
 * /thumb/{documentId}:
 *   get:
 *     summary: Get document thumbnail
 *     description: |
 *       Retrieves the thumbnail image for a specific document from the Paperless-ngx system.
 *       This endpoint proxies the request to the Paperless-ngx API and returns the thumbnail
 *       image for display in the UI.
 *
 *       The thumbnail is returned as an image file in the format provided by Paperless-ngx,
 *       typically JPEG or PNG.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID of the document to retrieve thumbnail for
 *         example: 123
 *     responses:
 *       200:
 *         description: Thumbnail retrieved successfully
 *         content:
 *           image/*:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Document or thumbnail not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Thumbnail not found"
 *       500:
 *         description: Server error or Paperless-ngx connection failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/thumb/:documentId', async (req, res) => {
  const cachePath = path.join('./public/images', `${req.params.documentId}.png`);

  try {
    try {
      await fs.access(cachePath);
      console.log('Serving cached thumbnail');

      res.setHeader('Content-Type', 'image/png');
      return res.sendFile(path.resolve(cachePath));

    } catch (err) {
      console.log('Thumbnail not cached, fetching from Paperless');

      const thumbnailData = await paperlessService.getThumbnailImage(req.params.documentId);

      if (!thumbnailData) {
        return res.status(404).send('Thumbnail nicht gefunden');
      }

      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, thumbnailData);

      res.setHeader('Content-Type', 'image/png');
      res.send(thumbnailData);
    }

  } catch (error) {
    console.error('Fehler beim Abrufen des Thumbnails:', error);
    res.status(500).send('Fehler beim Laden des Thumbnails');
  }
});

/**
 * @swagger
 * /api/reset-all-documents:
 *   post:
 *     summary: Reset all processed documents
 *     description: |
 *       Deletes all processing records from the database, allowing documents to be processed again.
 *       This doesn't delete the actual documents from Paperless-ngx, only their processing status in Paperless-AI.
 *
 *       This operation can be useful when changing AI models or prompts, as it allows reprocessing
 *       all documents with the updated configuration.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: All documents successfully reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error resetting documents"
 */
router.post('/api/reset-all-documents', async (req, res) => {
  try {
    await documentModel.deleteAllDocuments();
    res.json({ success: true });
  } catch (error) {
    console.error('[ERROR] resetting documents:', error);
    res.status(500).json({ error: 'Error resetting documents' });
  }
});

/**
 * @swagger
 * /api/reset-documents:
 *   post:
 *     summary: Reset specific documents
 *     description: |
 *       Deletes processing records for specific documents, allowing them to be processed again.
 *       This doesn't delete the actual documents from Paperless-ngx, only their processing status in Paperless-AI.
 *
 *       This operation is useful when you want to reprocess only selected documents after changes to
 *       the AI model, prompt, or document metadata configuration.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ids
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of document IDs to reset
 *                 example: [123, 456, 789]
 *     responses:
 *       200:
 *         description: Documents successfully reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid document IDs"
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error resetting documents"
 */
router.post('/api/reset-documents', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: 'Invalid document IDs' });
    }

    await documentModel.deleteDocumentsIdList(ids);
    res.json({ success: true });
  } catch (error) {
    console.error('[ERROR] resetting documents:', error);
    res.status(500).json({ error: 'Error resetting documents' });
  }
});

/**
 * @swagger
 * /api/scan/now:
 *   post:
 *     summary: Trigger immediate document scan
 *     description: |
 *       Initiates an immediate scan of documents in Paperless-ngx that haven't been processed yet.
 *       This endpoint can be used to manually trigger processing without waiting for the scheduled interval.
 *
 *       The scan will:
 *       - Connect to Paperless-ngx API
 *       - Fetch all unprocessed documents
 *       - Process each document with the configured AI service
 *       - Update documents in Paperless-ngx with generated metadata
 *
 *       The process respects the function limitations set in the configuration.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Scan initiated successfully
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: "Task completed"
 *       401:
 *         description: Unauthorized - authentication required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Authentication required"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error during document scan"
 */
router.post('/api/scan/now', async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log(`Setup not completed. Visit http://your-machine-ip:${process.env.PAPERLESS_AI_PORT || 3000}/setup to complete setup.`);
      return;
    }

    const userId = await paperlessService.getOwnUserID();
    if (!userId) {
      console.error('Failed to get own user ID. Abort scanning.');
      return;
    }

    try {
      let [existingTags, documents, ownUserId, existingCorrespondentList, existingDocumentTypes] = await Promise.all([
        paperlessService.getTags(),
        paperlessService.getAllDocuments(),
        paperlessService.getOwnUserID(),
        paperlessService.listCorrespondentsNames(),
        paperlessService.listDocumentTypesNames()
      ]);

      existingCorrespondentList = existingCorrespondentList.map(correspondent => correspondent.name);

      let existingDocumentTypesList = existingDocumentTypes.map(docType => docType.name);

      const existingTagNames = existingTags.map(tag => tag.name);

      for (const doc of documents) {
        try {
          const result = await processDocument(doc, existingTagNames, existingCorrespondentList, existingDocumentTypesList, ownUserId);
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
      res.send('Task completed');
    }
  } catch (error) {
    console.error('[ERROR] in startScanning:', error);
  }
});

/**
 * @swagger
 * /api/webhook/document:
 *   post:
 *     summary: Webhook for document updates
 *     description: |
 *       Processes incoming webhook notifications from Paperless-ngx about document
 *       changes, additions, or deletions. The webhook allows Paperless-AI to respond
 *       to document changes in real-time.
 *
 *       When a new document is added or updated in Paperless-ngx, this endpoint can
 *       trigger automatic AI processing for metadata extraction.
 *     tags:
 *       - Documents
 *       - API
 *       - System
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - event_type
 *               - document_id
 *             properties:
 *               event_type:
 *                 type: string
 *                 description: Type of event that occurred
 *                 enum: ["added", "updated", "deleted"]
 *                 example: "added"
 *               document_id:
 *                 type: integer
 *                 description: ID of the affected document
 *                 example: 123
 *               document_info:
 *                 type: object
 *                 description: Additional information about the document (optional)
 *                 properties:
 *                   title:
 *                     type: string
 *                     example: "Invoice"
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Document event processed"
 *                 processing_queued:
 *                   type: boolean
 *                   description: Whether AI processing was queued for this document
 *                   example: true
 *       400:
 *         description: Invalid webhook payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Missing required fields: event_type, document_id"
 *       401:
 *         description: Unauthorized - invalid or missing API key
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Unauthorized: Invalid API key"
 *       500:
 *         description: Server error processing webhook
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/api/webhook/document', async (req, res) => {
  try {
    const { url, prompt } = req.body;
    let usePrompt = false;
    if (!url) {
      return res.status(400).send('Missing document URL');
    }

    try {
      const documentId = extractDocumentId(url);
      const document = await paperlessService.getDocument(documentId);

      if (!document) {
        return res.status(404).send(`Document with ID ${documentId} not found`);
      }

      documentQueue.push(document);
      if (prompt) {
        usePrompt = true;
        console.log('[DEBUG] Using custom prompt:', prompt);
        await processQueue(prompt);
      } else {
        await processQueue();
      }


      res.status(202).send({
        message: 'Document accepted for processing',
        documentId: documentId,
        queuePosition: documentQueue.length
      });

    } catch (error) {
      console.error('[ERROR] Failed to extract document ID or fetch document:', error);
      return res.status(200).send('Invalid document URL format');
    }

  } catch (error) {
    console.error('[ERROR] Error in webhook endpoint:', error);
    res.status(200).send('Internal server error');
  }
});

module.exports = router;
