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

// Test Respond.io connectivity & send test message
app.post('/api/test/respondio', async (req, res) => {
  const axios = require('axios');
  const apiKey = process.env.RESPOND_IO_API_KEY;
  const channelId = process.env.RESPOND_IO_CHANNEL_ID;

  if (!apiKey) return res.status(500).json({ error: 'RESPOND_IO_API_KEY non configure' });
  if (!channelId) return res.status(500).json({ error: 'RESPOND_IO_CHANNEL_ID non configure' });

  const results = { channelId };
  const { phone, message } = req.body || {};

  // Try multiple API base URLs and endpoints
  const apis = [
    { name: 'v1', baseURL: 'https://api.respond.io/v1', sendPath: '/messages' },
    { name: 'v2', baseURL: 'https://api.respond.io/v2', sendPath: '/message/send' },
    { name: 'app-v1', baseURL: 'https://app.respond.io/api/v1', sendPath: '/message/sendContent' },
  ];

  for (const apiDef of apis) {
    const client = axios.create({
      baseURL: apiDef.baseURL,
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    // Test connectivity with simple GET
    try {
      const r = await client.get('/');
      results[apiDef.name + '_root'] = { status: r.status, data: typeof r.data === 'string' ? r.data.substring(0, 200) : r.data };
    } catch (err) {
      results[apiDef.name + '_root'] = err.response ? { status: err.response.status, msg: err.response.data?.message || JSON.stringify(err.response.data).substring(0, 200) } : err.message;
    }

    // Try send if phone provided
    if (phone) {
      const payloads = [
        { name: 'format1', data: { channelId: parseInt(channelId), contactId: phone, message: { type: 'text', text: message || 'Test BGFI WhatsApp - Connexion OK!' } } },
        { name: 'format2', data: { channelId: parseInt(channelId), recipient: { type: 'whatsapp', id: phone }, message: { type: 'text', text: message || 'Test BGFI WhatsApp - Connexion OK!' } } },
      ];

      for (const payload of payloads) {
        try {
          const r = await client.post(apiDef.sendPath, payload.data);
          results[apiDef.name + '_send_' + payload.name] = { success: true, data: r.data };
        } catch (err) {
          results[apiDef.name + '_send_' + payload.name] = err.response ? { status: err.response.status, data: err.response.data } : err.message;
        }
      }
    }
  }

  res.json(results);
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
