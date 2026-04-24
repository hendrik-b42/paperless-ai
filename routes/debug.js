// routes/debug.js
//
// Debug endpoints, split out of routes/setup.js. Mounted as a sub-router
// from setup.js so the top-of-file auth + setup-guard middleware still runs.

const express = require('express');
const router = express.Router();
const debugService = require('../services/debugService.js');
const paperlessService = require('../services/paperlessService.js');
const configFile = require('../config/config.js');

/**
 * @swagger
 * /debug:
 *   get:
 *     summary: Debug interface
 *     description: |
 *       Renders a debug interface for testing and troubleshooting Paperless-ngx connections
 *       and API responses.
 *       
 *       This page provides a simple UI for executing API calls to Paperless-ngx endpoints
 *       and viewing the raw responses. It's primarily used for diagnosing connection issues
 *       and understanding the structure of data returned by the Paperless-ngx API.
 *       
 *       The debug interface should only be accessible to administrators and is not intended
 *       for regular use in production environments.
 *     tags:
 *       - Navigation
 *       - System
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Debug interface rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the debug interface
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
router.get('/debug', async (req, res) => {
  //const isConfigured = await setupService.isConfigured();
  //if (!isConfigured) {
  //   return res.status(503).json({ 
  //     status: 'not_configured',
  //     message: 'Application setup not completed'
  //   });
  // }
  res.render('debug');
});

// router.get('/test/:correspondent', async (req, res) => {
//   //create a const for the correspondent that is base64 encoded and decode it
//   const correspondentx = Buffer.from(req.params.correspondent, 'base64').toString('ascii');
//   const correspondent = await paperlessService.searchForExistingCorrespondent(correspondentx);
//   res.send(correspondent);
// });

/**
 * @swagger
 * /debug/tags:
 *   get:
 *     summary: Debug tags API
 *     description: |
 *       Returns the raw tags data from Paperless-ngx for debugging purposes.
 *       
 *       This endpoint performs a direct API call to the Paperless-ngx tags endpoint
 *       and returns the unmodified response. It's used for diagnosing tag-related issues
 *       and verifying proper connection to Paperless-ngx.
 *     tags:
 *       - System
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Tags data retrieved successfully from Paperless-ngx
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Raw response from Paperless-ngx tags API
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
router.get('/debug/tags', async (req, res) => {
  const tags = await debugService.getTags();
  res.json(tags);
});

/**
 * @swagger
 * /debug/documents:
 *   get:
 *     summary: Debug documents API
 *     description: |
 *       Returns the raw documents data from Paperless-ngx for debugging purposes.
 *       
 *       This endpoint performs a direct API call to the Paperless-ngx documents endpoint
 *       and returns the unmodified response. It's used for diagnosing document-related issues
 *       and verifying proper connection to Paperless-ngx.
 *     tags:
 *       - System
 *       - API
 *       - Documents
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Documents data retrieved successfully from Paperless-ngx
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Raw response from Paperless-ngx documents API
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
router.get('/debug/documents', async (req, res) => {
  const documents = await debugService.getDocuments();
  res.json(documents);
});

/**
 * @swagger
 * /debug/correspondents:
 *   get:
 *     summary: Debug correspondents API
 *     description: |
 *       Returns the raw correspondents data from Paperless-ngx for debugging purposes.
 *       
 *       This endpoint performs a direct API call to the Paperless-ngx correspondents endpoint
 *       and returns the unmodified response. It's used for diagnosing correspondent-related issues
 *       and verifying proper connection to Paperless-ngx.
 *     tags:
 *       - System
 *       - API
 *       - Metadata
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Correspondents data retrieved successfully from Paperless-ngx
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Raw response from Paperless-ngx correspondents API
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
router.get('/debug/correspondents', async (req, res) => {
  const correspondents = await debugService.getCorrespondents();
  res.json(correspondents);
});

module.exports = router;
