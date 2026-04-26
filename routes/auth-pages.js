const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const documentModel = require('../models/document.js');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

/**
 * @swagger
 * /login:
 *   get:
 *     summary: Render login page or redirect to setup if no users exist
 *     description: |
 *       Serves the login page for user authentication to the Paperless-AI application.
 *       If no users exist in the database, the endpoint automatically redirects to the setup page
 *       to complete the initial application configuration.
 *
 *       This endpoint handles both new user sessions and returning users whose
 *       sessions have expired.
 *     tags:
 *       - Authentication
 *       - Navigation
 *     responses:
 *       200:
 *         description: Login page rendered successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               description: HTML content of the login page
 *       302:
 *         description: Redirect to setup page if no users exist, or to dashboard if already authenticated
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/setup"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/login', (req, res) => {
  documentModel.getUsers().then((users) => {
    if (users.length === 0) {
      res.redirect('setup');
    } else {
      res.render('login', { error: null });
    }
  });
});

/**
 * @swagger
 * /login:
 *   post:
 *     summary: Authenticate user with username and password
 *     description: |
 *       Authenticates a user using their username and password credentials.
 *       If authentication is successful, a JWT token is generated and stored in a secure HTTP-only
 *       cookie for subsequent requests.
 *
 *       Failed login attempts are logged for security purposes, and multiple failures
 *       may result in temporary account lockout depending on configuration.
 *     tags:
 *       - Authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 description: User's login name
 *                 example: "admin"
 *               password:
 *                 type: string
 *                 description: User's password
 *                 example: "securepassword"
 *               rememberMe:
 *                 type: boolean
 *                 description: Whether to extend the session lifetime
 *                 example: false
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 redirect:
 *                   type: string
 *                   description: URL to redirect to after successful login
 *                   example: "/dashboard"
 *         headers:
 *           Set-Cookie:
 *             schema:
 *               type: string
 *               description: HTTP-only cookie containing JWT token
 *       401:
 *         description: Authentication failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Invalid username or password"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    console.log('Login attempt for user:', username);
    const user = await documentModel.getUser(username);

    if (!user || !user.password) {
      console.log('[FAILED LOGIN] User not found or invalid data:', username);
      return res.render('login', { error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    console.log('Password validation result:', isValidPassword);

    if (isValidPassword) {
      const token = jwt.sign(
        {
          id: user.id,
          username: user.username
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      res.cookie('jwt', token, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000
      });

      return res.redirect('/dashboard');
    } else {
      return res.render('login', { error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { error: 'An error occurred during login' });
  }
});

/**
 * @swagger
 * /logout:
 *   get:
 *     summary: Log out user and clear JWT cookie
 *     description: |
 *       Terminates the current user session by invalidating and clearing the JWT authentication
 *       cookie. After logging out, the user is redirected to the login page.
 *
 *       This endpoint also clears any session-related data stored on the server side
 *       for the current user.
 *     tags:
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       302:
 *         description: Logout successful, redirected to login page
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "/login"
 *           Set-Cookie:
 *             schema:
 *               type: string
 *               description: HTTP-only cookie with cleared JWT token and immediate expiration
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/logout', (req, res) => {
  res.clearCookie('jwt');
  res.redirect('/login');
});

/**
 * @swagger
 * /api/key-regenerate:
 *   post:
 *     summary: Regenerate API key
 *     description: |
 *       Generates a new random API key for the application and updates the .env file.
 *       The previous API key will be invalidated immediately after generation.
 *
 *       This API key can be used for programmatic access to the API endpoints
 *       by sending it in the `x-api-key` header of subsequent requests.
 *
 *       **Security Notice**: This operation invalidates any existing API key.
 *       All systems using the previous key will need to be updated.
 *     tags:
 *       - System
 *       - Authentication
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: API key regenerated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: string
 *                   description: The newly generated API key
 *                   example: "3f7a8d6e2c1b5a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5"
 *       401:
 *         description: Unauthorized - JWT authentication required
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
 *                   example: "Error regenerating API key"
 */
router.post('/api/key-regenerate', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const dotenv = require('dotenv');
    const crypto = require('crypto');
    const envPath = path.join(__dirname, '../data/', '.env');
    const envConfig = dotenv.parse(fs.readFileSync(envPath));
    const apiKey = crypto.randomBytes(32).toString('hex');
    envConfig.API_KEY = apiKey;

    const envContent = Object.entries(envConfig)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(envPath, envContent);

    process.env.API_KEY = apiKey;

    res.json({ success: apiKey });
    console.log('API key regenerated:', apiKey);
  } catch (error) {
    console.error('API key regeneration error:', error);
    res.status(500).json({ error: 'Error regenerating API key' });
  }
});

module.exports = router;
