const express = require('express');
const router = express.Router();
const path = require('path');
const { pool } = require('../models/db');

// Serve the embeddable widget JavaScript
router.get('/widget.js', async (req, res) => {
  const websiteId = req.query['data-id'] || req.query.id;
  
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const apiBase = process.env.API_URL || 'https://api.chatflowai.com';
  
  // Return the widget bootstrap script
  const widgetScript = `
(function() {
  'use strict';
  
  var WEBSITE_ID = '${websiteId || ""}';
  var API_BASE = '${apiBase}';
  
  if (!WEBSITE_ID) {
    console.error('ChatFlow AI: No website ID provided');
    return;
  }
  
  // Load widget config then initialize
  fetch(API_BASE + '/api/chat/config/' + WEBSITE_ID)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.config) {
        initWidget(data.config);
      }
    })
    .catch(function(err) {
      console.error('ChatFlow AI: Failed to load config', err);
    });
  
  function initWidget(config) {
    if (document.getElementById('chatflow-ai-widget')) return;
    
    var color = config.widget_color || '#6366f1';
    var botName = config.widget_bot_name || 'AI Assistant';
    var welcomeMsg = config.widget_welcome_message || 'Hi! How can I help you today?';
    var position = config.widget_position || 'bottom-right';
    var removeBranding = config.remove_branding || false;
    
    var positionStyle = position === 'bottom-left' 
      ? 'bottom: 20px; left: 20px;' 
      : 'bottom: 20px; right: 20px;';
    
    var css = \`
      #chatflow-ai-widget * { box-sizing: border-box; font-family: -apple-system, sans-serif; }
      #chatflow-bubble { width: 60px; height: 60px; border-radius: 50%; background: \${color}; 
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2); transition: transform 0.2s; }
      #chatflow-bubble:hover { transform: scale(1.1); }
      #chatflow-panel { width: 380px; height: 550px; background: #fff; border-radius: 16px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.15); display: none; flex-direction: column;
        overflow: hidden; margin-bottom: 12px; }
      #chatflow-panel.open { display: flex; }
      #chatflow-header { background: \${color}; padding: 16px; color: white; }
      #chatflow-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
      #chatflow-header p { margin: 4px 0 0; font-size: 12px; opacity: 0.8; }
      #chatflow-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      .cf-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; }
      .cf-msg.user { background: \${color}; color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
      .cf-msg.bot { background: #f3f4f6; color: #111; align-self: flex-start; border-bottom-left-radius: 4px; }
      .cf-typing { display: flex; gap: 4px; align-items: center; padding: 10px 14px; background: #f3f4f6; border-radius: 12px; border-bottom-left-radius: 4px; align-self: flex-start; }
      .cf-dot { width: 6px; height: 6px; border-radius: 50%; background: #999; animation: cf-bounce 1.2s infinite; }
      .cf-dot:nth-child(2) { animation-delay: 0.2s; }
      .cf-dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes cf-bounce { 0%,80%,100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }
      #chatflow-input-area { padding: 12px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; }
      #chatflow-input { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; 
        font-size: 14px; outline: none; resize: none; max-height: 80px; }
      #chatflow-input:focus { border-color: \${color}; }
      #chatflow-send { background: \${color}; color: white; border: none; border-radius: 8px; 
        width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      #chatflow-branding { text-align: center; font-size: 11px; color: #9ca3af; padding: 6px; }
      #chatflow-branding a { color: #9ca3af; text-decoration: none; }
    \`;
    
    var div = document.createElement('div');
    div.id = 'chatflow-ai-widget';
    div.style.cssText = 'position: fixed; z-index: 99999; ' + positionStyle;
    div.innerHTML = \`
      <div id="chatflow-panel">
        <div id="chatflow-header">
          <h3>\${botName}</h3>
          <p>Online - Typically replies instantly</p>
        </div>
        <div id="chatflow-messages">
          <div class="cf-msg bot">\${welcomeMsg}</div>
        </div>
        \${!removeBranding ? '<div id="chatflow-branding">Powered by <a href="https://chatflowai.com" target="_blank">ChatFlow AI</a></div>' : ''}
        <div id="chatflow-input-area">
          <textarea id="chatflow-input" placeholder="Type your message..." rows="1"></textarea>
          <button id="chatflow-send">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>
      </div>
      <div id="chatflow-bubble">
        <svg id="cf-chat-icon" width="28" height="28" fill="none" stroke="white" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
        </svg>
      </div>
    \`;
    
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.appendChild(div);
    
    var sessionId = null;
    var conversationHistory = [];
    var panel = document.getElementById('chatflow-panel');
    var bubble = document.getElementById('chatflow-bubble');
    var input = document.getElementById('chatflow-input');
    var messages = document.getElementById('chatflow-messages');
    var sendBtn = document.getElementById('chatflow-send');
    
    bubble.addEventListener('click', function() {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        input.focus();
      }
    });
    
    function sendMessage() {
      var text = input.value.trim();
      if (!text) return;
      
      input.value = '';
      input.style.height = 'auto';
      
      addMessage('user', text);
      showTyping();
      
      conversationHistory.push({ role: 'user', content: text });
      
      fetch(API_BASE + '/api/chat/' + WEBSITE_ID, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: text, 
          sessionId: sessionId,
          conversationHistory: conversationHistory.slice(-6)
        })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        removeTyping();
        if (data.sessionId) sessionId = data.sessionId;
        var reply = data.message || 'Sorry, I had trouble with that.';
        addMessage('bot', reply);
        conversationHistory.push({ role: 'assistant', content: reply });
      })
      .catch(function() {
        removeTyping();
        addMessage('bot', 'Sorry, something went wrong. Please try again.');
      });
    }
    
    function addMessage(role, content) {
      var msg = document.createElement('div');
      msg.className = 'cf-msg ' + role;
      msg.textContent = content;
      messages.appendChild(msg);
      messages.scrollTop = messages.scrollHeight;
    }
    
    function showTyping() {
      var t = document.createElement('div');
      t.className = 'cf-typing';
      t.id = 'cf-typing';
      t.innerHTML = '<div class="cf-dot"></div><div class="cf-dot"></div><div class="cf-dot"></div>';
      messages.appendChild(t);
      messages.scrollTop = messages.scrollHeight;
    }
    
    function removeTyping() {
      var t = document.getElementById('cf-typing');
      if (t) t.remove();
    }
    
    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 80) + 'px';
    });
  }
})();
  `;

  res.send(widgetScript);
});

module.exports = router;
