const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { pool } = require('../models/db');
const crawlerService = require('../services/crawlerService');
const { PLAN_LIMITS } = require('../services/crawlerService');
const logger = require('../utils/logger');

// Get all websites for user
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT w.*, 
       (SELECT COUNT(*) FROM chat_sessions cs WHERE cs.website_id = w.id) as total_sessions,
       (SELECT COUNT(*) FROM chat_messages cm WHERE cm.website_id = w.id) as total_messages
       FROM websites w 
       WHERE w.user_id = $1 
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    res.json({ websites: result.rows });
  } catch (err) {
    next(err);
  }
});

// Get single website
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM websites WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Website not found' });
    }
    
    res.json({ website: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Create website
router.post('/', [
  body('url').isURL({ protocols: ['http', 'https'] }),
  body('name').notEmpty().trim()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check plan limits
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
    const plan = userResult.rows[0]?.plan || 'free';
    const limits = PLAN_LIMITS[plan];

    const existingCount = await pool.query(
      'SELECT COUNT(*) FROM websites WHERE user_id = $1',
      [req.user.id]
    );

    if (parseInt(existingCount.rows[0].count) >= limits.websites) {
      return res.status(403).json({ 
        error: `Your ${plan} plan allows up to ${limits.websites} website(s). Please upgrade to add more.` 
      });
    }

    const { url, name } = req.body;
    
    // Normalize URL
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http')) {
      normalizedUrl = 'https://' + normalizedUrl;
    }
    normalizedUrl = normalizedUrl.replace(/\/$/, '');

    const result = await pool.query(
      `INSERT INTO websites (user_id, name, url) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, name, normalizedUrl]
    );

    res.status(201).json({ website: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Update website settings
router.put('/:id', async (req, res, next) => {
  try {
    const { name, widget_color, widget_welcome_message, widget_bot_name, 
            widget_position, remove_branding, lead_capture } = req.body;

    // Check ownership
    const owned = await pool.query(
      'SELECT id FROM websites WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!owned.rows.length) {
      return res.status(404).json({ error: 'Website not found' });
    }

    const result = await pool.query(
      `UPDATE websites SET 
       name = COALESCE($1, name),
       widget_color = COALESCE($2, widget_color),
       widget_welcome_message = COALESCE($3, widget_welcome_message),
       widget_bot_name = COALESCE($4, widget_bot_name),
       widget_position = COALESCE($5, widget_position),
       remove_branding = COALESCE($6, remove_branding),
       lead_capture = COALESCE($7, lead_capture),
       updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [name, widget_color, widget_welcome_message, widget_bot_name, 
       widget_position, remove_branding, lead_capture, req.params.id]
    );

    res.json({ website: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Delete website
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM websites WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Website not found' });
    }
    
    res.json({ message: 'Website deleted' });
  } catch (err) {
    next(err);
  }
});

// Trigger training
router.post('/:id/train', async (req, res, next) => {
  try {
    // Check ownership and plan
    const result = await pool.query(
      `SELECT w.*, u.plan FROM websites w 
       JOIN users u ON w.user_id = u.id
       WHERE w.id = $1 AND w.user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Website not found' });
    }

    const website = result.rows[0];
    
    if (website.status === 'training') {
      return res.status(400).json({ error: 'Training already in progress' });
    }

    const limits = PLAN_LIMITS[website.plan || 'free'];

    // Start training asynchronously
    res.json({ message: 'Training started', websiteId: website.id });

    // Run in background
    crawlerService.crawlWebsite(website.id, req.user.id, limits.pages)
      .then(result => {
        logger.info(`Training completed: ${result.pagesCount} pages`);
      })
      .catch(err => {
        logger.error(`Training failed: ${err.message}`);
      });

  } catch (err) {
    next(err);
  }
});

// Get training status
router.get('/:id/training-status', async (req, res, next) => {
  try {
    const job = await pool.query(
      `SELECT * FROM training_jobs WHERE website_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );

    const website = await pool.query(
      'SELECT status, pages_crawled FROM websites WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    res.json({ 
      job: job.rows[0] || null,
      website: website.rows[0] || null
    });
  } catch (err) {
    next(err);
  }
});

// Get chat logs
router.get('/:id/chats', async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const sessions = await pool.query(
      `SELECT cs.*, 
       (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at LIMIT 1) as first_message
       FROM chat_sessions cs
       WHERE cs.website_id = $1
       ORDER BY cs.last_message_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    res.json({ sessions: sessions.rows });
  } catch (err) {
    next(err);
  }
});

// Get messages in a session
router.get('/:id/chats/:sessionId', async (req, res, next) => {
  try {
    const messages = await pool.query(
      `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [req.params.sessionId]
    );

    res.json({ messages: messages.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
