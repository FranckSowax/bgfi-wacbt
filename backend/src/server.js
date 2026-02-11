const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const logger = require('./utils/logger');
const { apiLimiter } = require('./middleware/rateLimit');
const { errorHandler } = require('./middleware/errorHandler');

// Routes
const authRoutes = require('./routes/auth');
const campaignRoutes = require('./routes/campaigns');
const contactRoutes = require('./routes/contacts');
const templateRoutes = require('./routes/templates');
const segmentRoutes = require('./routes/segments');
const billingRoutes = require('./routes/billing');
const chatbotRoutes = require('./routes/chatbot');
const analyticsRoutes = require('./routes/analytics');
const webhookRoutes = require('./routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (required behind Railway/load balancers for express-rate-limit)
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
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// Rate limiting
app.use('/api/', apiLimiter);

// Fichiers statiques (frontend SPA)
const rootDir = path.join(__dirname, '../../');
app.use(express.static(rootDir, {
  index: 'index.html',
  extensions: ['html']
}));

// Health check (lightweight - no DB connection to avoid Railway SIGTERM)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: 'railway',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    services: {
      whatsapp: !!process.env.WHATSAPP_ACCESS_TOKEN,
      openai: !!process.env.OPENAI_API_KEY,
      supabase: !!process.env.SUPABASE_URL,
      chatbot: process.env.CHATBOT_AUTO_REPLY !== 'false' && !!process.env.OPENAI_API_KEY
    }
  });
});

// Deep health check (with DB - for manual diagnostics only)
app.get('/api/health/deep', async (req, res) => {
  let dbStatus = 'unknown';
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'connected';
    await prisma.$disconnect();
  } catch (e) {
    dbStatus = 'error: ' + e.message;
  }
  res.json({ status: 'ok', database: dbStatus, timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/segments', segmentRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/webhooks', webhookRoutes);

// Error handling
app.use(errorHandler);

// SPA fallback : routes non-API renvoient index.html
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route non trouvee', path: req.path });
  }
  res.sendFile(path.join(rootDir, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
  logger.info(`Health: http://localhost:${PORT}/api/health`);
});

// === Tache planifiee : Rapport quotidien a 8h00 (Libreville UTC+1) ===
const enrichmentService = require('./services/enrichment');

let lastScheduledReportDate = null;
setInterval(async () => {
  try {
    const now = new Date();
    const librevilleHour = (now.getUTCHours() + 1) % 24;
    const todayStr = new Date(now.getTime() + 3600000).toISOString().split('T')[0];

    if (librevilleHour === 8 && lastScheduledReportDate !== todayStr) {
      lastScheduledReportDate = todayStr;
      logger.info('[CRON] Debut generation rapport quotidien 8h00 Libreville');

      // 1. Enrichir les sessions non-analysees
      const batchResult = await enrichmentService.enrichBatch(100);
      logger.info('[CRON] Enrichissement batch termine', batchResult);

      // 2. Generer le rapport de la veille
      const report = await enrichmentService.generateDailyReport();
      logger.info('[CRON] Rapport quotidien genere', { reportId: report.id, date: report.date });

      // 3. Alimenter la base RAG automatiquement
      try {
        await enrichmentService.feedReportToRag(report.id);
        logger.info('[CRON] Rapport ajoute a la base RAG');
      } catch (ragErr) {
        logger.warn('[CRON] Erreur ajout RAG', { error: ragErr.message });
      }
    }
  } catch (err) {
    logger.error('[CRON] Erreur tache planifiee', { error: err.message });
  }
}, 60 * 1000);

logger.info('Tache planifiee configuree: rapport quotidien a 8h00 (Libreville/UTC+1)');

module.exports = app;
