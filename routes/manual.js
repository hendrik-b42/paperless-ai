// routes/manual.js
//
// Manual-review tab endpoints (document preview, tags, documents, analyze,
// playground, update). Split out of routes/setup.js; mounted as a sub-router
// from setup.js so the top-of-file auth + setup-guard middleware still runs.

const express = require('express');
const router = express.Router();
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const AIServiceFactory = require('../services/aiServiceFactory');
const configFile = require('../config/config.js');
const manualService = require('../services/manualService.js');
const documentsService = require('../services/documentsService.js');

/**
 * @swagger
 * /manual/preview/{id}:
 *   get:
 *     summary: Document preview
 *     description: |
 *       Fetches and returns the content of a specific document from Paperless-ngx 
 *       for preview in the manual document review interface.
 *       
 *       This endpoint retrieves document details including content, title, ID, and tags,
 *       allowing users to view the document text before applying changes or processing
 *       it with AI tools. The document content is retrieved directly from Paperless-ngx
 *       using the system's configured API credentials.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The document ID from Paperless-ngx
 *         example: 123
 *     responses:
 *       200:
 *         description: Document content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 content:
 *                   type: string
 *                   description: The document content
 *                   example: "Invoice from ACME Corp. Amount: $1,234.56"
 *                 title:
 *                   type: string
 *                   description: The document title
 *                   example: "ACME Corp Invoice #12345"
 *                 id:
 *                   type: integer
 *                   description: The document ID
 *                   example: 123
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of tag names assigned to the document
 *                   example: ["Invoice", "ACME Corp", "2023"]
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       404:
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/preview/:id', async (req, res) => {
  try {
    const documentId = req.params.id;
    console.log('Fetching content for document:', documentId);
    
    const response = await fetch(
      `${process.env.PAPERLESS_API_URL}/documents/${documentId}/`,
      {
        headers: {
          'Authorization': `Token ${process.env.PAPERLESS_API_TOKEN}`
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch document content: ${response.status} ${response.statusText}`);
    }

    const document = await response.json();
    //map the tags to their names
    document.tags = await Promise.all(document.tags.map(async tag => {
      const tagName = await paperlessService.getTagTextFromId(tag);
      return tagName;
    }
    ));
    console.log('Document Data:', document);
    res.json({ content: document.content, title: document.title, id: document.id, tags: document.tags });
  } catch (error) {
    console.error('Content fetch error:', error);
    res.status(500).json({ error: `Error fetching document content: ${error.message}` });
  }
});

/**
 * @swagger
 * /manual:
 *   get:
 *     summary: Document review page
 *     description: |
 *       Renders the manual document review page that allows users to browse, 
 *       view and manually process documents from Paperless-ngx.
 *       
 *       This interface enables users to review documents, view their content, and 
 *       manage tags, correspondents, and document metadata without AI assistance.
 *       Users can apply manual changes to documents based on their own judgment,
 *       which is particularly useful for correction or verification of AI-processed documents.
 *     tags:
 *       - Navigation
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Manual document review page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the manual document review interface
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
router.get('/manual', async (req, res) => {
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  res.render('manual', {
    title: 'Document Review',
    error: null,
    success: null,
    version,
    paperlessUrl: process.env.PAPERLESS_API_URL,
    paperlessToken: process.env.PAPERLESS_API_TOKEN,
    config: {}
  });
});

/**
 * @swagger
 * /manual/tags:
 *   get:
 *     summary: Get all tags
 *     description: |
 *       Retrieves all tags from Paperless-ngx for use in the manual document review interface.
 *       
 *       This endpoint returns a complete list of all available tags that can be applied to documents,
 *       including their IDs, names, and colors. The tags are retrieved directly from Paperless-ngx
 *       and used for tag selection in the UI when manually updating document metadata.
 *     tags:
 *       - Documents
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Tags retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Tag'
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/tags', async (req, res) => {
  const getTags = await paperlessService.getTags();
  res.json(getTags);
});

/**
 * @swagger
 * /manual/documents:
 *   get:
 *     summary: Get all documents
 *     description: |
 *       Retrieves all documents from Paperless-ngx for display in the manual document review interface.
 *       
 *       This endpoint returns a list of all available documents that can be manually reviewed,
 *       including their basic metadata such as ID, title, and creation date. The documents are
 *       retrieved directly from Paperless-ngx and presented in the UI for selection and processing.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Documents retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Document'
 *       401:
 *         description: Unauthorized - user not authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *       500:
 *         description: Server error or Paperless connection error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/manual/documents', async (req, res) => {
  const getDocuments = await paperlessService.getDocuments();
  res.json(getDocuments);
});

/**
 * @swagger
 * /manual/analyze:
 *   post:
 *     summary: Analyze document content manually
 *     description: |
 *       Analyzes document content using the configured AI provider and returns structured metadata.
 *       This endpoint processes the document text to extract relevant information such as tags,
 *       correspondent, and document type based on content analysis.
 *       
 *       The analysis is performed using the AI provider configured in the application settings.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: The document text content to analyze
 *                 example: "Invoice from Acme Corp. Total amount: $125.00, Due date: 2023-08-15"
 *               existingTags:
 *                 type: array
 *                 description: List of existing tags in the system to help with tag matching
 *                 items:
 *                   type: string
 *                 example: ["Invoice", "Finance", "Acme Corp"]
 *               id:
 *                 type: string
 *                 description: Optional document ID for tracking metrics
 *                 example: "doc_123"
 *     responses:
 *       200:
 *         description: Document analysis results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 correspondent:
 *                   type: string
 *                   description: Detected correspondent name
 *                   example: "Acme Corp"
 *                 title:
 *                   type: string
 *                   description: Suggested document title
 *                   example: "Acme Corp Invoice - August 2023"
 *                 tags:
 *                   type: array
 *                   description: Suggested tags for the document
 *                   items:
 *                     type: string
 *                   example: ["Invoice", "Finance"]
 *                 documentType:
 *                   type: string
 *                   description: Detected document type
 *                   example: "Invoice"
 *                 metrics:
 *                   type: object
 *                   description: Token usage metrics (when using OpenAI)
 *                   properties:
 *                     promptTokens:
 *                       type: number
 *                       example: 350
 *                     completionTokens:
 *                       type: number
 *                       example: 120
 *                     totalTokens:
 *                       type: number
 *                       example: 470
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or AI provider not configured
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/manual/analyze', express.json(), async (req, res) => {
  try {
    const { content, existingTags, id } = req.body;

    // Lade Taxonomie mit Counts — identisch zum automatisierten Pfad,
    // damit Fix B (strukturierte Liste mit Häufigkeit) auch hier greift.
    const [tagObjects, correspondentObjects, documentTypeObjects] = await Promise.all([
      paperlessService.listTagsWithCount(),
      paperlessService.listCorrespondentsNames(),
      paperlessService.listDocumentTypesWithCount(),
    ]);

    const existingTagsList = tagObjects.map(t => t.name);
    const existingCorrespondentList = correspondentObjects.map(c => c.name);
    const existingDocumentTypesList = documentTypeObjects.map(dt => dt.name);

    const taxonomyOptions = {
      existingTagsWithCounts: tagObjects,
      existingCorrespondentsWithCounts: correspondentObjects,
      existingDocumentTypesWithCounts: documentTypeObjects,
    };

    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res.status(400).json({ error: 'Valid content string is required' });
    }

    const aiService = AIServiceFactory.getService();
    const analyzeDocument = await aiService.analyzeDocument(
      content, existingTagsList, existingCorrespondentList, existingDocumentTypesList,
      id || [], null, taxonomyOptions
    );
    if (analyzeDocument.metrics) {
      await documentModel.addOpenAIMetrics(
        id,
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      );
    }
    return res.json(analyzeDocument);
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /manual/playground:
 *   post:
 *     summary: Process document using a custom prompt in playground mode
 *     description: |
 *       Analyzes document content using a custom user-provided prompt.
 *       This endpoint is primarily used for testing and experimenting with different prompts
 *       without affecting the actual document processing workflow.
 *       
 *       The analysis is performed using the AI provider configured in the application settings,
 *       but with a custom prompt that overrides the default system prompt.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: The document text content to analyze
 *                 example: "Invoice from Acme Corp. Total amount: $125.00, Due date: 2023-08-15"
 *               prompt:
 *                 type: string
 *                 description: Custom prompt to use for analysis
 *                 example: "Extract the company name, invoice amount, and due date from this document."
 *               documentId:
 *                 type: string
 *                 description: Optional document ID for tracking metrics
 *                 example: "doc_123"
 *     responses:
 *       200:
 *         description: Document analysis results using the custom prompt
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 result:
 *                   type: string
 *                   description: The raw AI response using the custom prompt
 *                   example: "Company: Acme Corp\nAmount: $125.00\nDue Date: 2023-08-15"
 *                 metrics:
 *                   type: object
 *                   description: Token usage metrics (when using OpenAI)
 *                   properties:
 *                     promptTokens:
 *                       type: number
 *                       example: 350
 *                     completionTokens:
 *                       type: number
 *                       example: 120
 *                     totalTokens:
 *                       type: number
 *                       example: 470
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or AI provider not configured
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/manual/playground', express.json(), async (req, res) => {
  try {
    const { content, existingTags, prompt, documentId } = req.body;
    
    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res.status(400).json({ error: 'Valid content string is required' });
    }

    const aiService = AIServiceFactory.getService();
    const analyzeDocument = await aiService.analyzePlayground(content, prompt);
    if (analyzeDocument.metrics) {
      await documentModel.addOpenAIMetrics(
        documentId,
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      );
    }
    return res.json(analyzeDocument);
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /manual/updateDocument:
 *   post:
 *     summary: Update document metadata in Paperless-ngx
 *     description: |
 *       Updates document metadata such as tags, correspondent and title in the Paperless-ngx system.
 *       This endpoint handles the translation between tag names and IDs, and manages the creation of
 *       new tags or correspondents if they don't exist in the system.
 *       
 *       The endpoint also removes any unused tags from the document to keep the metadata clean.
 *     tags:
 *       - Documents
 *       - API
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - documentId
 *             properties:
 *               documentId:
 *                 type: number
 *                 description: ID of the document to update in Paperless-ngx
 *                 example: 123
 *               tags:
 *                 type: array
 *                 description: List of tags to apply (can be tag IDs or names)
 *                 items:
 *                   oneOf:
 *                     - type: number
 *                     - type: string
 *                 example: ["Invoice", 42, "Finance"]
 *               correspondent:
 *                 type: string
 *                 description: Correspondent name to assign to the document
 *                 example: "Acme Corp"
 *               title:
 *                 type: string
 *                 description: New title for the document
 *                 example: "Acme Corp Invoice - August 2023"
 *     responses:
 *       200:
 *         description: Document successfully updated
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
 *                   example: "Document updated successfully"
 *       400:
 *         description: Invalid request parameters or tag processing errors
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["Failed to create tag: Invalid tag name"]
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/manual/updateDocument', express.json(), async (req, res) => {
  try {
    var { documentId, tags, correspondent, title } = req.body;
    console.log("TITLE: ", title);
    // Convert all tags to names if they are IDs
    tags = await Promise.all(tags.map(async tag => {
      console.log('Processing tag:', tag);
      if (!isNaN(tag)) {
        const tagName = await paperlessService.getTagTextFromId(Number(tag));
        console.log('Converted tag ID:', tag, 'to name:', tagName);
        return tagName;
      }
      return tag;
    }));

    // Filter out any null or undefined tags
    tags = tags.filter(tag => tag != null);

    // Process new tags to get their IDs
    const { tagIds, errors } = await paperlessService.processTags(tags);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    // Process correspondent if provided
    const correspondentData = correspondent ? await paperlessService.getOrCreateCorrespondent(correspondent) : null;


    await paperlessService.removeUnusedTagsFromDocument(documentId, tagIds);
    
    // Then update with new tags (this will only add new ones since we already removed unused ones)
    const updateData = {
      tags: tagIds,
      correspondent: correspondentData ? correspondentData.id : null,
      title: title ? title : null
    };

    if(updateData.tags === null && updateData.correspondent === null && updateData.title === null) {
      return res.status(400).json({ error: 'No changes provided' });
    }
    const updateDocument = await paperlessService.updateDocument(documentId, updateData);
    
    // Mark document as processed
    await documentModel.addProcessedDocument(documentId, updateData.title);

    res.json(updateDocument);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
