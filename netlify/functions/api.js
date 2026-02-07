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

  if (!phone) return res.json({ ...results, info: 'Ajoutez "phone" pour tester l envoi' });

  const text = message || 'Test BGFI WhatsApp SaaS - Connexion reussie!';
  const chId = parseInt(channelId);
  const headers = { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
  const timeout = 10000;

  // Format 1: v1 /messages with contactId
  try {
    const r = await axios.post('https://api.respond.io/v1/messages', { channelId: chId, contactId: phone, message: { type: 'text', text } }, { headers, timeout });
    results.v1_contactId = { ok: true, data: r.data };
    return res.json(results);
  } catch (e) { results.v1_contactId = e.response ? { s: e.response.status, d: e.response.data } : e.message; }

  // Format 2: v1 /messages with recipient
  try {
    const r = await axios.post('https://api.respond.io/v1/messages', { channelId: chId, recipient: { type: 'whatsapp', id: phone }, message: { type: 'text', text } }, { headers, timeout });
    results.v1_recipient = { ok: true, data: r.data };
    return res.json(results);
  } catch (e) { results.v1_recipient = e.response ? { s: e.response.status, d: e.response.data } : e.message; }

  // Format 3: v2 /message/send
  try {
    const r = await axios.post('https://api.respond.io/v2/message/send', { channelId: chId, contactId: phone, message: { type: 'text', text } }, { headers, timeout });
    results.v2_send = { ok: true, data: r.data };
    return res.json(results);
  } catch (e) { results.v2_send = e.response ? { s: e.response.status, d: e.response.data } : e.message; }

  // Format 4: v2 create contact then get ID then send
  try {
    await axios.post('https://api.respond.io/v2/contact/create_or_update/phone:' + encodeURIComponent(phone), { firstName: 'Test BGFI' }, { headers, timeout });
    // Get contact ID by phone
    const getR = await axios.get('https://api.respond.io/v2/contact/by_custom_field/phone/' + encodeURIComponent(phone), { headers, timeout });
    results.v2_getContact = { ok: true, data: getR.data };
    const contactId = getR.data?.id || getR.data?.contact?.id || getR.data?.data?.id;
    if (contactId) {
      const r2 = await axios.post('https://api.respond.io/v2/message/sendContent/' + contactId, { body: [{ type: 'text', text }] }, { headers, timeout });
      results.v2_sendContent = { ok: true, data: r2.data };
      return res.json(results);
    }
  } catch (e) { results.v2_flow = e.response ? { s: e.response.status, d: e.response.data } : e.message; }

  // Format 5: try sendContent with phone as contactId
  try {
    const r = await axios.post('https://api.respond.io/v2/message/sendContent/' + encodeURIComponent(phone), { body: [{ type: 'text', text }] }, { headers, timeout });
    results.v2_sendContent_phone = { ok: true, data: r.data };
    return res.json(results);
  } catch (e) { results.v2_sendContent_phone = e.response ? { s: e.response.status, d: e.response.data } : e.message; }

  // Format 6: v2 /message/send with channelId + phone as string contactId
  try {
    const r = await axios.post('https://api.respond.io/v2/message/sendContent', { channelId: chId, contactId: phone, body: [{ type: 'text', text }] }, { headers, timeout });
    results.v2_sendContent_body = { ok: true, data: r.data };
    return res.json(results);
  } catch (e) { results.v2_sendContent_body = e.response ? { s: e.response.status, d: e.response.data } : e.message; }

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
