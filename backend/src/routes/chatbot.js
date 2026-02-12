const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');

const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');
const ragService = require('../services/rag');
const enrichmentService = require('../services/enrichment');

const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

// ============================================
// POST /api/chatbot/message - Chat avec le RAG
// ============================================
router.post('/message', async (req, res) => {
  try {
    const { message, sessionId, contactId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message requis' });
    }

    // Appeler le service RAG interne
    const result = await ragService.chat(message, contactId);

    // Sauvegarder la session
    let newSessionId = sessionId;
    try {
      const session = await prisma.chatSession.create({
        data: {
          contactId: contactId || null,
          source: 'web',
          messages: [
            { role: 'user', content: message, timestamp: new Date() },
            { role: 'bot', content: result.response, timestamp: new Date() }
          ]
        }
      });
      newSessionId = session.id;
    } catch (err) {
      logger.warn('Failed to save chat session', { error: err.message });
    }

    res.json({
      response: result.response,
      sources: result.sources,
      chunks_used: result.chunks_used,
      sessionId: newSessionId
    });
  } catch (error) {
    logger.error('Error in chatbot message', {
      error: error.message,
      message: req.body.message?.substring(0, 50)
    });

    res.status(500).json({
      error: 'Erreur lors du traitement du message',
      response: 'Desole, une erreur est survenue. Veuillez reessayer ou contacter le service client au 011 76 32 29.'
    });
  }
});

// ============================================
// GET /api/chatbot/knowledge - Lister les documents
// ============================================
router.get('/knowledge', authenticate, async (req, res) => {
  try {
    const docs = await ragService.listDocuments();

    // Formater pour le frontend (attend: { documents: [{ id, name, type, uploadedAt }] })
    res.json({
      documents: docs.map(d => ({
        id: d.id,
        name: d.title,
        type: d.type,
        chunkCount: d.chunk_count,
        uploadedAt: d.created_at
      }))
    });
  } catch (error) {
    logger.error('Error fetching knowledge documents', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation des documents', documents: [] });
  }
});

// ============================================
// POST /api/chatbot/knowledge/upload - Uploader un document
// ============================================
router.post('/knowledge/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier requis' });
    }

    const file = req.file;
    const fileName = file.originalname;
    const fileType = fileName.split('.').pop().toLowerCase();
    let content = '';

    // Extraire le texte selon le type de fichier
    if (fileType === 'pdf') {
      try {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(file.buffer);
        content = pdfData.text;
      } catch (err) {
        logger.error('PDF parsing error', { error: err.message });
        return res.status(400).json({ error: 'Impossible de lire le PDF: ' + err.message });
      }
    } else if (fileType === 'docx') {
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        content = result.value;
        logger.info('DOCX extracted', { chars: content.length });
      } catch (err) {
        logger.error('DOCX parsing error', { error: err.message });
        return res.status(400).json({ error: 'Impossible de lire le DOCX: ' + err.message });
      }
    } else if (['txt', 'csv', 'md'].includes(fileType)) {
      content = file.buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Format non supporte. Formats acceptes: PDF, DOCX, TXT, CSV, MD' });
    }

    if (!content || content.trim().length < 10) {
      return res.status(400).json({ error: 'Le document ne contient pas de texte extractible' });
    }

    // Ajouter au RAG
    const doc = await ragService.addDocument(
      fileName,
      content,
      fileType,
      { originalName: fileName, size: file.size, mimeType: file.mimetype }
    );

    logger.info('Document uploaded to RAG', {
      id: doc.id,
      name: fileName,
      type: fileType,
      chunks: doc.chunk_count,
      userId: req.user.id
    });

    res.json({
      success: true,
      message: `Document "${fileName}" indexe avec ${doc.chunk_count} chunks`,
      document: {
        id: doc.id,
        name: fileName,
        type: fileType,
        chunkCount: doc.chunk_count
      }
    });
  } catch (error) {
    logger.error('Error uploading document', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de l\'upload: ' + error.message });
  }
});

// ============================================
// DELETE /api/chatbot/knowledge/:id - Supprimer un document
// ============================================
router.delete('/knowledge/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    await ragService.deleteDocument(id);

    logger.info('Knowledge document deleted', { docId: id, userId: req.user.id });

    res.json({ success: true, message: 'Document supprime' });
  } catch (error) {
    logger.error('Error deleting document', { error: error.message, docId: req.params.id });
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// ============================================
// GET /api/chatbot/status - Statut du chatbot (env vars + RAG)
// ============================================
router.get('/status', authenticate, async (req, res) => {
  try {
    const autoReply = process.env.CHATBOT_AUTO_REPLY !== 'false';
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4';

    // Verifier si le RAG est initialise
    let ragReady = false;
    let docCount = 0;
    try {
      const stats = await ragService.getStats();
      ragReady = true;
      docCount = stats.documents;
    } catch {
      ragReady = false;
    }

    const config = await ragService.getConfig().catch(() => ({}));

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSessions = await prisma.chatSession.count({
      where: { createdAt: { gte: oneDayAgo } }
    }).catch(() => 0);

    res.json({
      enabled: autoReply,
      ragService: {
        configured: ragReady,
        status: ragReady ? 'connected' : 'not_initialized',
        documents: docCount
      },
      openai: {
        configured: !!openaiKey,
        model
      },
      systemPromptPreview: (config.systemPrompt || "Tu es Stella, l'assistant virtuel de BGFI Bank Gabon...").substring(0, 150) + '...',
      fallbackMessage: process.env.CHATBOT_FALLBACK_MESSAGE ||
        'Merci pour votre message. Un conseiller BGFI Bank vous repondra dans les plus brefs delais. Service client : 011 76 32 29',
      recentSessions
    });
  } catch (error) {
    logger.error('Error fetching chatbot status', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation du statut' });
  }
});

// ============================================
// GET /api/chatbot/config - Configuration RAG
// ============================================
router.get('/config', authenticate, async (req, res) => {
  try {
    const config = await ragService.getConfig();
    res.json(config);
  } catch (error) {
    logger.error('Error fetching RAG config', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation de la configuration' });
  }
});

// ============================================
// POST /api/chatbot/config - Mettre a jour la config RAG
// ============================================
router.post('/config', authenticate, async (req, res) => {
  try {
    const config = req.body;
    const updated = await ragService.updateConfig(config);

    logger.info('RAG config updated', { userId: req.user.id });

    res.json(updated);
  } catch (error) {
    logger.error('Error updating RAG config', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la mise a jour' });
  }
});

// ============================================
// GET /api/chatbot/stats - Statistiques RAG
// ============================================
router.get('/stats', authenticate, async (req, res) => {
  try {
    const stats = await ragService.getStats();
    res.json(stats);
  } catch (error) {
    logger.error('Error fetching RAG stats', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation des statistiques' });
  }
});

// ============================================
// GET /api/chatbot/token-usage - Consommation de tokens OpenAI
// ============================================
router.get('/token-usage', authenticate, async (req, res) => {
  try {
    const stats = await ragService.getTokenStats();
    res.json(stats);
  } catch (error) {
    logger.error('Error fetching token usage', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation de la consommation de tokens' });
  }
});

// ============================================
// GET /api/chatbot/sessions - Sessions de chat avec filtres d'enrichissement
// ============================================
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const {
      page = 1, limit = 20,
      sentiment, intentCategory, urgencyLevel, resolutionStatus,
      actionRequired, enriched, source,
      startDate, endDate, search
    } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (sentiment) where.sentiment = sentiment;
    if (intentCategory) where.intentCategory = intentCategory;
    if (urgencyLevel) where.urgencyLevel = urgencyLevel;
    if (resolutionStatus) where.resolutionStatus = resolutionStatus;
    if (actionRequired === 'true') where.actionRequired = true;
    if (enriched === 'true') where.enriched = true;
    if (enriched === 'false') where.enriched = false;
    if (source) where.source = source;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    if (search) {
      where.customerNeedSummary = { contains: search, mode: 'insensitive' };
    }

    const [sessions, total] = await Promise.all([
      prisma.chatSession.findMany({
        where,
        include: {
          contact: {
            select: { id: true, name: true, phone: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.chatSession.count({ where })
    ]);

    res.json({
      data: sessions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching chat sessions', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation des sessions' });
  }
});

// ============================================
// GET /api/chatbot/sessions/enrichment-stats - Stats d'enrichissement agregees
// ============================================
router.get('/sessions/enrichment-stats', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const where = { enriched: true };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const sessions = await prisma.chatSession.findMany({
      where,
      select: {
        intentCategory: true,
        productMentioned: true,
        sentiment: true,
        urgencyLevel: true,
        resolutionStatus: true,
        satisfactionScore: true,
        actionRequired: true,
        source: true
      }
    });

    const totalEnriched = sessions.length;

    // Sentiment breakdown
    const sentimentBreakdown = {};
    sessions.forEach(s => {
      if (s.sentiment) sentimentBreakdown[s.sentiment] = (sentimentBreakdown[s.sentiment] || 0) + 1;
    });

    // Intent breakdown
    const intentBreakdown = {};
    sessions.forEach(s => {
      if (s.intentCategory) intentBreakdown[s.intentCategory] = (intentBreakdown[s.intentCategory] || 0) + 1;
    });

    // Product breakdown
    const productBreakdown = {};
    sessions.forEach(s => {
      if (s.productMentioned && s.productMentioned !== 'NONE') {
        productBreakdown[s.productMentioned] = (productBreakdown[s.productMentioned] || 0) + 1;
      }
    });

    // Urgency breakdown
    const urgencyBreakdown = {};
    sessions.forEach(s => {
      if (s.urgencyLevel) urgencyBreakdown[s.urgencyLevel] = (urgencyBreakdown[s.urgencyLevel] || 0) + 1;
    });

    // Resolution breakdown
    const resolutionBreakdown = {};
    sessions.forEach(s => {
      if (s.resolutionStatus) resolutionBreakdown[s.resolutionStatus] = (resolutionBreakdown[s.resolutionStatus] || 0) + 1;
    });

    // Average satisfaction
    const scores = sessions.filter(s => s.satisfactionScore != null).map(s => s.satisfactionScore);
    const avgSatisfaction = scores.length > 0
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
      : null;

    const actionRequiredCount = sessions.filter(s => s.actionRequired).length;

    res.json({
      totalEnriched,
      avgSatisfaction,
      actionRequiredCount,
      actionRequiredPercent: totalEnriched > 0 ? Math.round(actionRequiredCount / totalEnriched * 100) : 0,
      resolvedPercent: totalEnriched > 0 ? Math.round((resolutionBreakdown.RESOLVED || 0) / totalEnriched * 100) : 0,
      sentimentBreakdown,
      intentBreakdown,
      productBreakdown,
      urgencyBreakdown,
      resolutionBreakdown
    });
  } catch (error) {
    logger.error('Error fetching enrichment stats', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation des statistiques' });
  }
});

// ============================================
// GET /api/chatbot/sessions/:id - Detail d'une session
// ============================================
router.get('/sessions/:id', authenticate, async (req, res) => {
  try {
    const session = await prisma.chatSession.findUnique({
      where: { id: req.params.id },
      include: {
        contact: {
          select: { id: true, name: true, phone: true, category: true, city: true, accountType: true }
        }
      }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session non trouvee' });
    }

    res.json(session);
  } catch (error) {
    logger.error('Error fetching session detail', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation de la session' });
  }
});

// ============================================
// POST /api/chatbot/sessions/:id/enrich - Re-enrichir une session
// ============================================
router.post('/sessions/:id/enrich', authenticate, async (req, res) => {
  try {
    // Reset enrichment flag to force re-processing
    await prisma.chatSession.update({
      where: { id: req.params.id },
      data: { enriched: false }
    });

    const result = await enrichmentService.enrichConversation(req.params.id);
    if (!result) {
      return res.status(500).json({ error: 'Echec de l\'enrichissement' });
    }

    res.json({ success: true, session: result });
  } catch (error) {
    logger.error('Error enriching session', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de l\'enrichissement' });
  }
});

// ============================================
// POST /api/chatbot/sessions/enrich-batch - Enrichir les sessions non-enrichies
// ============================================
router.post('/sessions/enrich-batch', authenticate, async (req, res) => {
  try {
    const { limit = 50 } = req.body;
    const result = await enrichmentService.enrichBatch(parseInt(limit));
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Error in batch enrichment', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de l\'enrichissement batch' });
  }
});

// ============================================
// POST /api/chatbot/reports/generate - Generer un rapport quotidien
// ============================================
router.post('/reports/generate', authenticate, async (req, res) => {
  try {
    const { date } = req.body;
    const report = await enrichmentService.generateDailyReport(date);
    res.json({ success: true, report });
  } catch (error) {
    logger.error('Error generating report', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la generation du rapport' });
  }
});

// ============================================
// GET /api/chatbot/reports - Lister les rapports quotidiens
// ============================================
router.get('/reports', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 30, startDate, endDate } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(endDate);
    }

    const [reports, total] = await Promise.all([
      prisma.dailyReport.findMany({
        where,
        orderBy: { date: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.dailyReport.count({ where })
    ]);

    res.json({
      data: reports,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching reports', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation des rapports' });
  }
});

// ============================================
// GET /api/chatbot/reports/:id - Detail d'un rapport
// ============================================
router.get('/reports/:id', authenticate, async (req, res) => {
  try {
    const report = await prisma.dailyReport.findUnique({
      where: { id: req.params.id }
    });

    if (!report) {
      return res.status(404).json({ error: 'Rapport non trouve' });
    }

    res.json(report);
  } catch (error) {
    logger.error('Error fetching report detail', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de la recuperation du rapport' });
  }
});

// ============================================
// POST /api/chatbot/reports/feed-to-rag - Alimenter la base RAG avec un rapport
// ============================================
router.post('/reports/feed-to-rag', authenticate, async (req, res) => {
  try {
    const { reportId } = req.body;
    if (!reportId) {
      return res.status(400).json({ error: 'reportId requis' });
    }

    const doc = await enrichmentService.feedReportToRag(reportId);
    res.json({
      success: true,
      message: 'Rapport ajoute a la base de connaissances',
      document: { id: doc.id, title: doc.title, chunks: doc.chunk_count }
    });
  } catch (error) {
    logger.error('Error feeding report to RAG', { error: error.message });
    res.status(500).json({ error: 'Erreur: ' + error.message });
  }
});

// ============================================
// POST /api/chatbot/segment-from-sessions - Creer un segment depuis des contacts de conversation
// ============================================
router.post('/segment-from-sessions', authenticate, async (req, res) => {
  try {
    const { contactIds, sessionIds, segmentName, description } = req.body;

    if (!segmentName?.trim()) {
      return res.status(400).json({ error: 'Nom du segment requis' });
    }

    // Collecter les IDs de contacts
    let cids = contactIds || [];
    if (sessionIds?.length) {
      const sessions = await prisma.chatSession.findMany({
        where: { id: { in: sessionIds } },
        select: { contactId: true }
      });
      cids = [...new Set([...cids, ...sessions.map(s => s.contactId).filter(Boolean)])];
    }

    if (cids.length === 0) {
      return res.status(400).json({ error: 'Aucun contact selectionne' });
    }

    // Generer un tag unique pour ce segment
    const tagName = 'seg_' + segmentName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

    // Tagger tous les contacts selectionnes
    for (const cid of cids) {
      const contact = await prisma.contact.findUnique({ where: { id: cid }, select: { tags: true } });
      if (contact && !contact.tags.includes(tagName)) {
        await prisma.contact.update({
          where: { id: cid },
          data: { tags: { push: tagName } }
        });
      }
    }

    // Creer le segment avec critere sur le tag
    const segment = await prisma.segment.create({
      data: {
        name: segmentName.toLowerCase().replace(/\s+/g, '_'),
        description: description || `Segment cree depuis ${cids.length} conversations`,
        type: 'STATIC',
        criteria: {
          operator: 'AND',
          rules: [{ field: 'tags', op: 'has', value: tagName }]
        },
        contactCount: cids.length,
        lastEvaluatedAt: new Date(),
        createdBy: req.user.id
      }
    });

    logger.info('Segment created from conversations', { segmentId: segment.id, contactCount: cids.length });
    res.json({ success: true, segment, taggedContacts: cids.length });
  } catch (error) {
    logger.error('Error creating segment from sessions', { error: error.message });
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Un segment avec ce nom existe deja' });
    }
    res.status(500).json({ error: error.message || 'Erreur lors de la creation du segment' });
  }
});

// ============================================
// POST /api/chatbot/add-to-segment - Ajouter des contacts a un segment existant
// ============================================
router.post('/add-to-segment', authenticate, async (req, res) => {
  try {
    const { contactIds, segmentId } = req.body;
    if (!contactIds?.length || !segmentId) {
      return res.status(400).json({ error: 'contactIds et segmentId requis' });
    }

    const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
    if (!segment) {
      return res.status(404).json({ error: 'Segment non trouve' });
    }

    // Trouver le tag du segment
    const tagRule = segment.criteria?.rules?.find(r => r.field === 'tags');
    const tagName = tagRule?.value || 'seg_' + segment.name;

    // Tagger les contacts
    let tagged = 0;
    for (const cid of contactIds) {
      const contact = await prisma.contact.findUnique({ where: { id: cid }, select: { tags: true } });
      if (contact && !contact.tags.includes(tagName)) {
        await prisma.contact.update({
          where: { id: cid },
          data: { tags: { push: tagName } }
        });
        tagged++;
      }
    }

    // Re-evaluer le nombre de contacts
    const newCount = await prisma.contact.count({
      where: { tags: { has: tagName } }
    });

    await prisma.segment.update({
      where: { id: segmentId },
      data: { contactCount: newCount, lastEvaluatedAt: new Date() }
    });

    logger.info('Contacts added to segment', { segmentId, tagged, newCount });
    res.json({ success: true, tagged, newCount });
  } catch (error) {
    logger.error('Error adding contacts to segment', { error: error.message });
    res.status(500).json({ error: 'Erreur lors de l\'ajout au segment' });
  }
});

// ============================================
// POST /api/chatbot/setup - Initialiser les tables RAG
// ============================================
router.post('/setup', authenticate, async (req, res) => {
  try {
    const result = await ragService.initialize();
    res.json({
      success: result,
      message: result ? 'Tables RAG initialisees avec succes' : 'Echec de l\'initialisation'
    });
  } catch (error) {
    logger.error('Error setting up RAG', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
