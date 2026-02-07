// Charger les variables d'environnement
require('dotenv').config();

// Forcer le mode serverless (pas de Redis)
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const serverless = require('serverless-http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

// Import routes
const authRoutes = require('../../backend/src/routes/auth');
const campaignRoutes = require('../../backend/src/routes/campaigns');
const contactRoutes = require('../../backend/src/routes/contacts');
const templateRoutes = require('../../backend/src/routes/templates');
const chatbotRoutes = require('../../backend/src/routes/chatbot');
const analyticsRoutes = require('../../backend/src/routes/analytics');
const webhookRoutes = require('../../backend/src/routes/webhooks');
const { errorHandler } = require('../../backend/src/middleware/errorHandler');
const { apiLimiter } = require('../../backend/src/middleware/rateLimit');

const app = express();

// Trust proxy (required behind Netlify CDN for express-rate-limit)
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
app.use('/api/', apiLimiter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: 'netlify-functions',
    version: '1.0.0',
    services: {
      database: !!process.env.DATABASE_URL,
      respondio: !!process.env.RESPOND_IO_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      supabase: !!process.env.SUPABASE_URL,
      redis: process.env.REDIS_ENABLED !== 'false' && !!process.env.REDIS_HOST
    }
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/webhooks', webhookRoutes);

// Error handling
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée', path: req.path });
});

// Export for Netlify Functions
module.exports.handler = serverless(app, {
  basePath: '/.netlify/functions/api'
});
