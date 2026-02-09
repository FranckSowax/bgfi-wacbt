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
      whatsapp: !!process.env.WHATSAPP_ACCESS_TOKEN,
      openai: !!process.env.OPENAI_API_KEY,
      supabase: !!process.env.SUPABASE_URL,
      redis: process.env.REDIS_ENABLED !== 'false' && !!process.env.REDIS_HOST
    }
  });
});

// Temporary: Test WhatsApp Cloud API connectivity
app.get('/api/debug/whatsapp-test', async (req, res) => {
  try {
    const axios = require('axios');
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

    // 1. Check token validity
    let tokenCheck = 'unknown';
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/debug_token?input_token=${token}&access_token=${token}`);
      tokenCheck = r.data?.data || r.data;
    } catch (e) { tokenCheck = e.response?.data?.error?.message || e.message; }

    // 2. Check phone number
    let phoneCheck = 'unknown';
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/${phoneId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      phoneCheck = r.data;
    } catch (e) { phoneCheck = e.response?.data?.error?.message || e.message; }

    // 3. Check WABA
    let wabaCheck = 'unknown';
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/${wabaId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      wabaCheck = r.data;
    } catch (e) { wabaCheck = e.response?.data?.error?.message || e.message; }

    res.json({
      config: {
        phoneNumberId: phoneId ? phoneId : '✗ missing',
        accessToken: token ? token.slice(0, 15) + '...' : '✗ missing',
        wabaId: wabaId ? wabaId : '✗ missing',
      },
      tokenInfo: tokenCheck,
      phoneNumberInfo: phoneCheck,
      wabaInfo: wabaCheck
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/debug/whatsapp-send', async (req, res) => {
  try {
    const whatsappService = require('../../backend/src/services/whatsapp');
    const { phone, message } = req.body;
    const result = await whatsappService.sendMessage(phone, message || 'Test depuis BGFI WhatsApp SaaS - WhatsApp Cloud API');
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Check System User's assigned assets + try register phone
app.get('/api/debug/whatsapp-assets', async (req, res) => {
  try {
    const axios = require('axios');
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    const userId = '122101446639248836'; // from token debug

    // 1. Check WABA phone numbers
    let wabaPhones = 'unknown';
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/${wabaId}/phone_numbers`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      wabaPhones = r.data;
    } catch (e) { wabaPhones = e.response?.data?.error || e.message; }

    // 2. Try to register phone for Cloud API messaging
    let registerResult = 'unknown';
    try {
      const r = await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/register`, {
        messaging_product: 'whatsapp',
        pin: '123456'
      }, { headers: { Authorization: `Bearer ${token}` } });
      registerResult = r.data;
    } catch (e) { registerResult = e.response?.data?.error || e.message; }

    // 3. Check System User's assigned WABAs
    let userAssets = 'unknown';
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/${userId}/assigned_business_asset_groups`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      userAssets = r.data;
    } catch (e) { userAssets = e.response?.data?.error || e.message; }

    res.json({ wabaPhones, registerResult, userAssets });
  } catch (error) {
    res.json({ error: error.message });
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
