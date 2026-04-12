const OpenAI = require('openai');
const { pool } = require('../models/db');
const embeddingService = require('./embeddingService');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class ChatService {
  
  async chat(websiteId, message, sessionId, conversationHistory = []) {
    // Get website info
    const websiteResult = await pool.query(
      `SELECT w.*, u.plan, u.messages_used_this_month, u.messages_reset_at
       FROM websites w
       JOIN users u ON w.user_id = u.id
       WHERE w.id = $1`,
      [websiteId]
    );

    if (!websiteResult.rows.length) {
      throw new Error('Website not found');
    }

    const website = websiteResult.rows[0];

    if (website.status !== 'trained') {
      return {
        message: "I'm still being trained. Please check back shortly!",
        sessionId
      };
    }

    // Check message limits
    await this.checkAndResetMonthlyMessages(website);
    const limits = this.getPlanLimits(website.plan);
    
    if (website.messages_used_this_month >= limits.messages) {
      return {
        message: "I've reached my monthly message limit. Please contact the site owner.",
        sessionId,
        limitReached: true
      };
    }

    // Search for relevant context
    const relevantChunks = await embeddingService.searchSimilar(websiteId, message, 5);
    
    let context = '';
    if (relevantChunks.length > 0) {
      context = relevantChunks
        .map(chunk => `[From: ${chunk.title || chunk.url}]\n${chunk.content}`)
        .join('\n\n---\n\n');
    }

    // Build system prompt
    const systemPrompt = `You are ${website.widget_bot_name || 'an AI assistant'} for ${website.name || website.url}.
    
Your job is to help visitors by answering their questions based ONLY on the information provided below.

RULES:
- Answer ONLY based on the provided context
- If you don't find the answer in the context, say: "I don't have information about that. Please contact us directly for help."
- Be concise, friendly, and helpful
- Do not make up information
- If asked about prices, hours, or specific details not in context, direct them to contact the business
- Keep responses under 150 words unless complex technical explanation is needed
${website.lead_capture ? '- If the user seems interested in a product/service, politely ask for their email for follow-up' : ''}

CONTEXT FROM WEBSITE:
${context || 'No specific content found for this query. Use general helpfulness.'}`;

    // Build messages array
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-6), // Last 3 exchanges for context
      { role: 'user', content: message }
    ];

    // Call OpenAI
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 300,
      temperature: 0.3,
    });

    const assistantMessage = response.choices[0].message.content;
    const tokensUsed = response.usage.total_tokens;

    // Save messages to DB
    let activeSessionId = sessionId;
    
    if (!activeSessionId) {
      const sessionResult = await pool.query(
        'INSERT INTO chat_sessions (website_id) VALUES ($1) RETURNING id',
        [websiteId]
      );
      activeSessionId = sessionResult.rows[0].id;
    }

    // Save user message
    await pool.query(
      'INSERT INTO chat_messages (session_id, website_id, role, content) VALUES ($1, $2, $3, $4)',
      [activeSessionId, websiteId, 'user', message]
    );

    // Save assistant message
    await pool.query(
      'INSERT INTO chat_messages (session_id, website_id, role, content, tokens_used) VALUES ($1, $2, $3, $4, $5)',
      [activeSessionId, websiteId, 'assistant', assistantMessage, tokensUsed]
    );

    // Update session
    await pool.query(
      `UPDATE chat_sessions SET messages_count = messages_count + 2, last_message_at = NOW() WHERE id = $1`,
      [activeSessionId]
    );

    // Increment user message count
    await pool.query(
      'UPDATE users SET messages_used_this_month = messages_used_this_month + 1 WHERE id = $1',
      [website.user_id]
    );

    return {
      message: assistantMessage,
      sessionId: activeSessionId,
      sources: relevantChunks.slice(0, 2).map(c => ({ url: c.url, title: c.title }))
    };
  }

  async checkAndResetMonthlyMessages(website) {
    const resetAt = new Date(website.messages_reset_at);
    const now = new Date();
    const daysDiff = (now - resetAt) / (1000 * 60 * 60 * 24);
    
    if (daysDiff >= 30) {
      await pool.query(
        'UPDATE users SET messages_used_this_month = 0, messages_reset_at = NOW() WHERE id = $1',
        [website.user_id]
      );
    }
  }

  getPlanLimits(plan) {
    const limits = {
      free: { messages: 100 },
      pro: { messages: 2000 },
      business: { messages: 10000 }
    };
    return limits[plan] || limits.free;
  }
}

module.exports = new ChatService();
