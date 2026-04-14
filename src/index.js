require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const websiteRoutes = require('./routes/websites');
const chatRoutes = require('./routes/chat');
const billingRoutes = require('./routes/billing');
const widgetRoutes = require('./routes/widget');
const analyticsRoutes = require('./routes/analytics');
const webhookRoutes = require('./routes/webhooks');

const { errorHandler } = require('./middleware/errorHandler');
const { authenticate } = require('./middleware/auth');
const logger = require('./utils/logger');
const { migrate } = require('./models/db');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true
}));

app.use(compression());
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Chat rate limit exceeded.' }
});
app.use('/api/', apiLimiter);
app.use('/api/chat', chatLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: '1.0.0', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/websites', authenticate, websiteRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/billing', authenticate, billingRoutes);
app.use('/api/widget', widgetRoutes);
app.use('/api/analytics', authenticate, analyticsRoutes);
app.use('/api/webhooks', webhookRoutes);

app.use(errorHandler);

migrate()
  .then(() => {
    logger.info('✅ Migrations complete');
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 ChatFlow AI Backend running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  })
  .catch(err => {
    logger.error('❌ Migration failed, server not started:', err);
    process.exit(1);
  });

module.exports = app;