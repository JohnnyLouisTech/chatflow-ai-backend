const express = require('express');
const router = express.Router();
const chatService = require('../services/chatService');
const { pool } = require('../models/db');
const logger = require('../utils/logger');

// Public chat endpoint for embedded widget
router.post('/:websiteId', async (req, res, next) => {
  try {
    const { websiteId } = req.params;
    const { message, sessionId, conversationHistory = [], visitorEmail, visitorName } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message too long' });
    }

    // Update session with lead info if provided
    if (sessionId && visitorEmail) {
      await pool.query(
        'UPDATE chat_sessions SET visitor_email = $1, visitor_name = $2 WHERE id = $3',
        [visitorEmail, visitorName, sessionId]
      );
    }

    const result = await chatService.chat(
      websiteId, 
      message.trim(), 
      sessionId,
      conversationHistory
    );

    res.json(result);
  } catch (err) {
    logger.error('Chat error:', err);
    
    if (err.message === 'Website not found') {
      return res.status(404).json({ error: 'Chatbot not found' });
    }
    
    // Don't expose internal errors to widget users
    res.json({ 
      message: "I'm having trouble right now. Please try again or contact us directly.",
      sessionId: req.body.sessionId 
    });
  }
});

// Get widget config (public)
router.get('/config/:websiteId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, widget_color, widget_welcome_message, widget_bot_name, 
       widget_position, remove_branding, status, lead_capture
       FROM websites WHERE id = $1`,
      [req.params.websiteId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Widget not found' });
    }

    res.json({ config: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
