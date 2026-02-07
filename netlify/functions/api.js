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

  // Format 4: v2 create contact, get contact by phone, then send
  let contactNumericId = null;
  try {
    await axios.post('https://api.respond.io/v2/contact/create_or_update/phone:' + encodeURIComponent(phone), { firstName: 'Test BGFI' }, { headers, timeout });
    results.contact_created = true;
  } catch (e) { results.contact_created = e.response ? e.response.data : e.message; }

  // Try to get contact ID
  const getEndpoints = [
    '/v2/contact/get_by_field',
    '/v2/contact/phone:' + encodeURIComponent(phone),
    '/v2/contact/get_by_id/phone:' + encodeURIComponent(phone),
  ];
  for (const ep of getEndpoints) {
    try {
      const method = ep.includes('get_by_field') ? 'post' : 'get';
      const data = ep.includes('get_by_field') ? { field: 'phone', value: phone } : undefined;
      const r = method === 'post' ? await axios.post('https://api.respond.io' + ep, data, { headers, timeout }) : await axios.get('https://api.respond.io' + ep, { headers, timeout });
      results['get_' + ep.split('/').pop()] = r.data;
      contactNumericId = r.data?.id || r.data?.contact?.id || r.data?.data?.id;
      if (contactNumericId) break;
    } catch (e) { results['get_' + ep.split('/').pop()] = e.response ? { s: e.response.status, d: e.response.data } : e.message; }
  }

  // The endpoint POST /v2/contact/phone:{phone}/message EXISTS (returns 400 not 404)
  // Try different body formats
  const basePath = '/v2/contact/phone:' + encodeURIComponent(phone) + '/message';
  const bodyFormats = [
    { name: 'msg_obj', data: { message: { type: 'text', text } } },
    { name: 'msg_obj_ch', data: { message: { type: 'text', text }, channelId: chId } },
    { name: 'msg_str', data: { message: text } },
    { name: 'msg_str_ch', data: { message: text, channelId: chId } },
    { name: 'text_only', data: { text } },
    { name: 'text_ch', data: { text, channelId: chId } },
    { name: 'body_arr', data: { body: [{ type: 'text', text }] } },
    { name: 'body_arr_ch', data: { body: [{ type: 'text', text }], channelId: chId } },
    { name: 'type_text', data: { type: 'text', text, channelId: chId } },
    { name: 'content', data: { content: { type: 'text', text }, channelId: chId } },
    { name: 'msg_ch_str', data: { message: { type: 'text', text }, channelId: String(chId) } },
  ];
  for (const fmt of bodyFormats) {
    try {
      const r = await axios.post('https://api.respond.io' + basePath, fmt.data, { headers, timeout });
      results[fmt.name] = { ok: true, data: r.data };
      return res.json(results);
    } catch (e) {
      const errMsg = e.response ? e.response.data?.message || JSON.stringify(e.response.data) : e.message;
      results[fmt.name] = { s: e.response?.status, m: errMsg };
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
