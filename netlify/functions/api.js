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

// Debug endpoint - temporary for Respond.io testing
app.get('/api/debug/message-status/:messageId', async (req, res) => {
  try {
    const axios = require('axios');
    const resp = await axios.get(`https://api.respond.io/v2/message/${req.params.messageId}`, {
      headers: { 'Authorization': `Bearer ${process.env.RESPOND_IO_API_KEY}` },
      timeout: 10000
    });
    res.json({ success: true, data: resp.data });
  } catch (error) {
    res.json({ success: false, status: error.response?.status, data: error.response?.data, error: error.message });
  }
});

app.post('/api/debug/send-whatsapp', async (req, res) => {
  try {
    const axios = require('axios');
    const { phone, message, useTemplate, templateName } = req.body;
    const chId = parseInt(process.env.RESPOND_IO_CHANNEL_ID) || 0;
    const identifier = 'phone:' + encodeURIComponent(phone);

    let payload;
    if (useTemplate && templateName) {
      // Try sending as WhatsApp template (for outside 24h window)
      payload = {
        channelId: chId,
        message: {
          type: 'whatsapp_template',
          template: {
            name: templateName,
            languageCode: 'fr',
            components: []
          }
        }
      };
    } else {
      payload = { channelId: chId, message: { type: 'text', text: message } };
    }

    const resp = await axios.post(`https://api.respond.io/v2/contact/${identifier}/message`, payload, {
      headers: {
        'Authorization': `Bearer ${process.env.RESPOND_IO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    res.json({ success: true, payload, response: resp.data });
  } catch (error) {
    res.json({ success: false, payload: req.body, status: error.response?.status, data: error.response?.data, error: error.message });
  }
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
