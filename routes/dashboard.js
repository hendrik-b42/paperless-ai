const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const documentsService = require('../services/documentsService.js');
const configFile = require('../config/config.js');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

const protectApiRoute = (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

/**
 * @swagger
 * /playground:
 *   get:
 *     summary: AI playground testing environment
 *     description: |
 *       Renders the AI playground page for experimenting with document analysis.
 *
 *       This interactive environment allows users to test different AI providers and prompts
 *       on document content without affecting the actual document processing workflow.
 *       Users can paste document text, customize prompts, and see raw AI responses
 *       to better understand how the AI models analyze document content.
 *
 *       The playground is useful for fine-tuning prompts and testing AI capabilities
 *       before applying them to actual document processing.
 *     tags:
 *       - Navigation
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Playground page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the AI playground interface
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
router.get('/playground', protectApiRoute, async (req, res) => {
  try {
    const {
      documents,
      tagNames,
      correspondentNames,
      paperlessUrl
    } = await documentsService.getDocumentsWithMetadata();

    documents.length = 16;

    res.render('playground', {
      documents,
      tagNames,
      correspondentNames,
      paperlessUrl,
      version: configFile.PAPERLESS_AI_VERSION || ' '
    });
  } catch (error) {
    console.error('[ERRO] loading documents view:', error);
    res.status(500).send('Error loading documents');
  }
});

/**
 * @swagger
 * /dashboard:
 *   get:
 *     summary: Main dashboard page
 *     description: |
 *       Renders the main dashboard page of the application with summary statistics and visualizations.
 *       The dashboard provides an overview of processed documents, system metrics, and important statistics
 *       about document processing including tag counts, correspondent counts, and token usage.
 *
 *       The page displays visualizations for document processing status, token distribution,
 *       processing time statistics, and document type categorization to help administrators
 *       understand system performance and document processing patterns.
 *     tags:
 *       - Navigation
 *       - System
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Dashboard page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the dashboard page
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
router.get('/dashboard', async (req, res) => {
  const tagCount = await paperlessService.getTagCount();
  const correspondentCount = await paperlessService.getCorrespondentCount();
  const documentCount = await paperlessService.getDocumentCount();
  const processedDocumentCount = await documentModel.getProcessedDocumentsCount();
  const metrics = await documentModel.getMetrics();
  const processingTimeStats = await documentModel.getProcessingTimeStats();
  const tokenDistribution = await documentModel.getTokenDistribution();
  const documentTypes = await documentModel.getDocumentTypeStats();

  const averagePromptTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.promptTokens, 0) / metrics.length) : 0;
  const averageCompletionTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.completionTokens, 0) / metrics.length) : 0;
  const averageTotalTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.totalTokens, 0) / metrics.length) : 0;
  const tokensOverall = metrics.length > 0 ? metrics.reduce((acc, cur) => acc + cur.totalTokens, 0) : 0;

  const version = configFile.PAPERLESS_AI_VERSION || ' ';

  res.render('dashboard', {
    paperless_data: {
      tagCount,
      correspondentCount,
      documentCount,
      processedDocumentCount,
      processingTimeStats,
      tokenDistribution,
      documentTypes
    },
    openai_data: {
      averagePromptTokens,
      averageCompletionTokens,
      averageTotalTokens,
      tokensOverall
    },
    version
  });
});

router.get('/dashboard/doc/:id', async (req, res) => {
  const docId = req.params.id;
  if (!docId) {
    return res.status(400).json({ error: 'Document ID is required' });
  }
  try {
    const paperlessUrl = process.env.PAPERLESS_API_URL;
    const paperlessUrlWithoutApi = paperlessUrl.replace('/api', '');
    const redirectUrl = `${paperlessUrlWithoutApi}/documents/${docId}/details`;
    console.log('Redirecting to Paperless-ngx URL:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

module.exports = router;
