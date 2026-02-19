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

// ============================================
// Tracking redirect: GET /t/:trackingId
// Enregistre le clic puis redirige vers l'URL cible
// ============================================
app.get('/t/:trackingId', async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const { trackingId } = req.params;

    const message = await prisma.message.findFirst({
      where: { trackingId },
      include: { campaign: { select: { variables: true } } }
    });

    if (!message) {
      await prisma.$disconnect();
      return res.redirect(process.env.TRACKING_FALLBACK_URL || 'https://bgfixstudia.com/');
    }

    // Enregistrer le clic (une seule fois par message)
    if (!message.clickedAt) {
      await prisma.message.update({
        where: { id: message.id },
        data: { clickedAt: new Date() }
      });
      if (message.campaignId) {
        await prisma.campaign.update({
          where: { id: message.campaignId },
          data: { clicked: { increment: 1 } }
        });
      }
      logger.info('Click tracked', { trackingId, campaignId: message.campaignId });
    }

    // Rediriger vers l'URL cible
    const targetUrl = message.campaign?.variables?.buttonUrl || process.env.TRACKING_FALLBACK_URL || 'https://bgfixstudia.com/';
    await prisma.$disconnect();
    res.redirect(targetUrl);
  } catch (err) {
    logger.error('Tracking redirect error', { error: err.message, trackingId: req.params.trackingId });
    res.redirect(process.env.TRACKING_FALLBACK_URL || 'https://bgfixstudia.com/');
  }
});

// Error handling
app.use(errorHandler);

// SPA fallback : routes non-API renvoient index.html
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route non trouvee', path: req.path });
  }
  res.sendFile(path.join(rootDir, 'index.html'));
});

// Auto-migration: appliquer les colonnes manquantes au demarrage
async function runAutoMigrations() {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const migrations = [
      'ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "clickedAt" TIMESTAMP(3)',
      'ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "trackingId" TEXT',
      'CREATE UNIQUE INDEX IF NOT EXISTS "messages_trackingId_key" ON "messages"("trackingId")'
    ];
    for (const sql of migrations) {
      await prisma.$executeRawUnsafe(sql);
    }
    logger.info('Auto-migrations applied successfully');
    await prisma.$disconnect();
  } catch (err) {
    logger.warn('Auto-migration error (may be already applied)', { error: err.message });
  }
}

// Start server
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
  logger.info(`Health: http://localhost:${PORT}/api/health`);
  runAutoMigrations();
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
