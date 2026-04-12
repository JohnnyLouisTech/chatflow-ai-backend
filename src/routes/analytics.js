const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');

router.get('/overview', async (req, res, next) => {
  try {
    const userId = req.user.id;

    const [websites, messages, sessions, monthlyMessages] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM websites WHERE user_id = $1', [userId]),
      pool.query(
        `SELECT COUNT(*) FROM chat_messages cm 
         JOIN websites w ON cm.website_id = w.id 
         WHERE w.user_id = $1`, [userId]
      ),
      pool.query(
        `SELECT COUNT(*) FROM chat_sessions cs 
         JOIN websites w ON cs.website_id = w.id 
         WHERE w.user_id = $1`, [userId]
      ),
      pool.query(
        `SELECT COUNT(*) FROM chat_messages cm 
         JOIN websites w ON cm.website_id = w.id 
         WHERE w.user_id = $1 AND cm.created_at > NOW() - INTERVAL '30 days'`, [userId]
      )
    ]);

    // Daily messages for chart (last 30 days)
    const dailyMessages = await pool.query(
      `SELECT DATE(cm.created_at) as date, COUNT(*) as count
       FROM chat_messages cm
       JOIN websites w ON cm.website_id = w.id
       WHERE w.user_id = $1 
       AND cm.created_at > NOW() - INTERVAL '30 days'
       AND cm.role = 'user'
       GROUP BY DATE(cm.created_at)
       ORDER BY date ASC`,
      [userId]
    );

    res.json({
      overview: {
        totalWebsites: parseInt(websites.rows[0].count),
        totalMessages: parseInt(messages.rows[0].count),
        totalSessions: parseInt(sessions.rows[0].count),
        monthlyMessages: parseInt(monthlyMessages.rows[0].count)
      },
      dailyMessages: dailyMessages.rows
    });
  } catch (err) {
    next(err);
  }
});

router.get('/website/:websiteId', async (req, res, next) => {
  try {
    // Verify ownership
    const owned = await pool.query(
      'SELECT id FROM websites WHERE id = $1 AND user_id = $2',
      [req.params.websiteId, req.user.id]
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Website not found' });

    const [sessions, messages, leads] = await Promise.all([
      pool.query(
        'SELECT COUNT(*) FROM chat_sessions WHERE website_id = $1', 
        [req.params.websiteId]
      ),
      pool.query(
        'SELECT COUNT(*) FROM chat_messages WHERE website_id = $1 AND role = $2',
        [req.params.websiteId, 'user']
      ),
      pool.query(
        'SELECT COUNT(*) FROM chat_sessions WHERE website_id = $1 AND visitor_email IS NOT NULL',
        [req.params.websiteId]
      )
    ]);

    res.json({
      sessions: parseInt(sessions.rows[0].count),
      messages: parseInt(messages.rows[0].count),
      leads: parseInt(leads.rows[0].count)
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
