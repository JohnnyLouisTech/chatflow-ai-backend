require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: '1.0.0' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port ' + PORT);
});
