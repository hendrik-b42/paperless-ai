const express = require('express');
const router = express.Router();
const paperlessService = require('../services/paperlessService.js');
const documentModel = require('../models/document.js');
const configFile = require('../config/config.js');

/**
 * @swagger
 * /history:
 *   get:
 *     summary: Document history page
 *     description: |
 *       Renders the document history page with filtering options.
 *       This page displays a list of all documents that have been processed by Paperless-AI,
 *       showing the changes made to the documents through AI processing.
 *
 *       The page includes filtering capabilities by correspondent, tag, and free text search,
 *       allowing users to easily find specific documents or categories of processed documents.
 *       Each entry includes links to the original document in Paperless-ngx.
 *     tags:
 *       - History
 *       - Navigation
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: History page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the history page with filtering controls and document list
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
router.get('/history', async (req, res) => {
  try {
    const allTags = await paperlessService.getTags();

    const historyDocuments = await documentModel.getAllHistory();
    const allCorrespondents = [...new Set(historyDocuments.map(doc => doc.correspondent))]
      .filter(Boolean).sort();

    res.render('history', {
      version: configFile.PAPERLESS_AI_VERSION,
      filters: {
        allTags: allTags,
        allCorrespondents: allCorrespondents
      }
    });
  } catch (error) {
    console.error('[ERROR] loading history page:', error);
    res.status(500).send('Error loading history page');
  }
});

/**
 * @swagger
 * /api/history:
 *   get:
 *     summary: Get processed document history
 *     description: |
 *       Returns a paginated list of documents that have been processed by Paperless-AI.
 *       Supports filtering by tag, correspondent, and search term.
 *       Designed for integration with DataTables jQuery plugin.
 *
 *       This endpoint provides comprehensive information about each processed document,
 *       including its metadata before and after AI processing, allowing users to track
 *       changes made by the system.
 *     tags:
 *       - History
 *       - API
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: draw
 *         schema:
 *           type: integer
 *         description: Draw counter for DataTables (prevents XSS)
 *         example: 1
 *       - in: query
 *         name: start
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Starting record index for pagination
 *         example: 0
 *       - in: query
 *         name: length
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of records to return per page
 *         example: 10
 *       - in: query
 *         name: search[value]
 *         schema:
 *           type: string
 *         description: Global search term (searches title, correspondent and tags)
 *         example: "invoice"
 *       - in: query
 *         name: tag
 *         schema:
 *           type: string
 *         description: Filter by tag ID
 *         example: "5"
 *       - in: query
 *         name: correspondent
 *         schema:
 *           type: string
 *         description: Filter by correspondent name
 *         example: "Acme Corp"
 *       - in: query
 *         name: order[0][column]
 *         schema:
 *           type: integer
 *         description: Index of column to sort by (0=document_id, 1=title, etc.)
 *         example: 1
 *       - in: query
 *         name: order[0][dir]
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort direction (ascending or descending)
 *         example: "desc"
 *     responses:
 *       200:
 *         description: Document history returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 draw:
 *                   type: integer
 *                   description: Echo of the draw parameter
 *                   example: 1
 *                 recordsTotal:
 *                   type: integer
 *                   description: Total number of records in the database
 *                   example: 100
 *                 recordsFiltered:
 *                   type: integer
 *                   description: Number of records after filtering
 *                   example: 20
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       document_id:
 *                         type: integer
 *                         description: Document ID
 *                         example: 123
 *                       title:
 *                         type: string
 *                         description: Document title
 *                         example: "Invoice #12345"
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         description: Date and time when the processing occurred
 *                         example: "2023-07-15T14:30:45Z"
 *                       tags:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: integer
 *                               example: 5
 *                             name:
 *                               type: string
 *                               example: "Invoice"
 *                             color:
 *                               type: string
 *                               example: "#FF5733"
 *                       correspondent:
 *                         type: string
 *                         description: Document correspondent name
 *                         example: "Acme Corp"
 *                       link:
 *                         type: string
 *                         description: Link to the document in Paperless-ngx
 *                         example: "http://paperless.example.com/documents/123/"
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
 *                   example: "Error loading history data"
 */
router.get('/api/history', async (req, res) => {
  try {
    const draw = parseInt(req.query.draw);
    const start = parseInt(req.query.start) || 0;
    const length = parseInt(req.query.length) || 10;
    const search = req.query.search?.value || '';
    const tagFilter = req.query.tag || '';
    const correspondentFilter = req.query.correspondent || '';

    const allDocs = await documentModel.getAllHistory();
    const allTags = await paperlessService.getTags();
    const tagMap = new Map(allTags.map(tag => [tag.id, tag]));

    let filteredDocs = allDocs.map(doc => {
      const tagIds = doc.tags === '[]' ? [] : JSON.parse(doc.tags || '[]');
      const resolvedTags = tagIds.map(id => tagMap.get(parseInt(id))).filter(Boolean);
      const baseURL = process.env.PAPERLESS_API_URL.replace(/\/api$/, '');

      resolvedTags.sort((a, b) => a.name.localeCompare(b.name));

      return {
        document_id: doc.document_id,
        title: doc.title || 'Modified: Invalid Date',
        created_at: doc.created_at,
        tags: resolvedTags,
        correspondent: doc.correspondent || 'Not assigned',
        link: `${baseURL}/documents/${doc.document_id}/`
      };
    }).filter(doc => {
      const matchesSearch = !search ||
        doc.title.toLowerCase().includes(search.toLowerCase()) ||
        doc.correspondent.toLowerCase().includes(search.toLowerCase()) ||
        doc.tags.some(tag => tag.name.toLowerCase().includes(search.toLowerCase()));

      const matchesTag = !tagFilter || doc.tags.some(tag => tag.id === parseInt(tagFilter));
      const matchesCorrespondent = !correspondentFilter || doc.correspondent === correspondentFilter;

      return matchesSearch && matchesTag && matchesCorrespondent;
    });

    if (req.query.order) {
      const order = req.query.order[0];
      const column = req.query.columns[order.column].data;
      const dir = order.dir === 'asc' ? 1 : -1;

      filteredDocs.sort((a, b) => {
        if (a[column] == null) return 1;
        if (b[column] == null) return -1;
        if (column === 'created_at') {
          return dir * (new Date(a[column]) - new Date(b[column]));
        }
        if (column === 'document_id') {
          return dir * (a[column] - b[column]);
        }
        if (column === 'tags') {
          let min_len = (a[column].length < b[column].length) ? a[column].length : b[column].length;
          for (let i = 0; i < min_len; i += 1) {
            let cmp = a[column][i].name.localeCompare(b[column][i].name);
            if (cmp !== 0) return dir * cmp;
          }
          return dir * (a[column].length - b[column].length);
        }
        return dir * a[column].localeCompare(b[column]);
      });
    }

    res.json({
      draw: draw,
      recordsTotal: allDocs.length,
      recordsFiltered: filteredDocs.length,
      data: filteredDocs.slice(start, start + length)
    });
  } catch (error) {
    console.error('[ERROR] loading history data:', error);
    res.status(500).json({ error: 'Error loading history data' });
  }
});

module.exports = router;
