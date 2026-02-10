const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');

const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');
const ragService = require('../services/rag');

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
    } else if (['txt', 'csv', 'md'].includes(fileType)) {
      content = file.buffer.toString('utf-8');
    } else if (['doc', 'docx', 'xls', 'xlsx'].includes(fileType)) {
      // Pour les formats Office, extraire le texte brut du buffer
      // Simplification: lire comme texte (fonctionne partiellement pour .doc)
      content = file.buffer.toString('utf-8').replace(/[^\x20-\x7E\xC0-\xFF\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
      if (content.length < 50) {
        return res.status(400).json({
          error: 'Format non supporte. Veuillez convertir en PDF ou TXT avant upload.'
        });
      }
    } else {
      return res.status(400).json({ error: 'Format non supporte. Formats acceptes: PDF, TXT, CSV, MD' });
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
      systemPromptPreview: (config.systemPrompt || "Tu es Cassiopee, l'assistant virtuel de BGFI Bank Gabon...").substring(0, 150) + '...',
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
// GET /api/chatbot/sessions - Sessions de chat
// ============================================
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [sessions, total] = await Promise.all([
      prisma.chatSession.findMany({
        include: {
          contact: {
            select: {
              id: true,
              name: true,
              phone: true
            }
          }
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.chatSession.count()
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
