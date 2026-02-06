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

// Database connection test
app.get('/api/debug/db', async (req, res) => {
  const dns = require('dns');
  const dbUrl = process.env.DATABASE_URL || '';
  const hostMatch = dbUrl.match(/@([^:\/]+)/);
  const host = hostMatch ? hostMatch[1] : 'unknown';
  const portMatch = dbUrl.match(/:(\d+)\//);
  const port = portMatch ? portMatch[1] : 'unknown';

  // DNS resolution test
  let dnsResult = {};
  try {
    const addresses4 = await new Promise((resolve, reject) => dns.resolve4(host, (err, a) => err ? reject(err) : resolve(a)));
    dnsResult.ipv4 = addresses4;
  } catch(e) { dnsResult.ipv4 = 'NONE: ' + e.code; }
  try {
    const addresses6 = await new Promise((resolve, reject) => dns.resolve6(host, (err, a) => err ? reject(err) : resolve(a)));
    dnsResult.ipv6 = addresses6;
  } catch(e) { dnsResult.ipv6 = 'NONE: ' + e.code; }

  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const userCount = await prisma.user.count();
    const contactCount = await prisma.contact.count();
    await prisma.$disconnect();
    res.json({ ok: true, users: userCount, contacts: contactCount, host, port, dns: dnsResult, jwtSecret: process.env.JWT_SECRET ? 'set' : 'NOT SET' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message.substring(0, 300), host, port, dns: dnsResult, jwtSecret: process.env.JWT_SECRET ? 'set' : 'NOT SET' });
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
