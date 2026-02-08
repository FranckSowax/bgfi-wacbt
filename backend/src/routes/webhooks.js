const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const whatsappService = require('../services/whatsapp');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// GET /webhooks/whatsapp - Vérification webhook Meta
// Meta envoie un GET avec hub.mode, hub.verify_token, hub.challenge
// ============================================
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const result = whatsappService.verifyWebhook(mode, token, challenge);

  if (result.valid) {
    logger.info('Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  logger.warn('Webhook verification failed', { mode, token });
  return res.sendStatus(403);
});

// ============================================
// POST /webhooks/whatsapp - Messages entrants WhatsApp Cloud API
// Format Meta: { object, entry: [{ changes: [{ value: { messages, statuses, contacts } }] }] }
// ============================================
router.post('/whatsapp', async (req, res) => {
  try {
    // Toujours répondre 200 immédiatement pour éviter les retries Meta
    res.status(200).json({ received: true });

    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        // Traiter les messages entrants
        if (value.messages) {
          for (const message of value.messages) {
            await handleIncomingMessage(message, value.contacts);
          }
        }

        // Traiter les mises à jour de statut
        if (value.statuses) {
          for (const status of value.statuses) {
            await handleStatusUpdate(status);
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error processing WhatsApp webhook', { error: error.message });
  }
});

// ============================================
// Gestionnaire: Message entrant
// ============================================
async function handleIncomingMessage(message, contacts) {
  try {
    const from = message.from; // numéro sans +
    const phone = '+' + from;
    const contactInfo = contacts?.find(c => c.wa_id === from);
    const contactName = contactInfo?.profile?.name;

    logger.info('Incoming WhatsApp message', {
      from: phone.replace(/\d(?=\d{4})/g, '*'),
      type: message.type
    });

    // Rechercher ou créer le contact
    let dbContact = await prisma.contact.findUnique({
      where: { phone }
    });

    if (!dbContact) {
      dbContact = await prisma.contact.create({
        data: {
          phone,
          name: contactName,
          whatsappId: from,
          optedIn: true,
          optedInAt: new Date()
        }
      });
      logger.info('New contact created from webhook', { contactId: dbContact.id });
    } else {
      await prisma.contact.update({
        where: { id: dbContact.id },
        data: { lastActivity: new Date() }
      });
    }

    // Si c'est un message texte, potentiellement l'envoyer au chatbot RAG
    if (message.type === 'text' && message.text?.body) {
      const text = message.text.body;

      const recentSession = await prisma.chatSession.findFirst({
        where: {
          contactId: dbContact.id,
          updatedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) }
        },
        orderBy: { updatedAt: 'desc' }
      });

      const chatbotKeywords = ['aide', 'help', 'assistant', 'bot', 'cassiopee', 'question'];
      const isChatbotRequest = chatbotKeywords.some(kw =>
        text.toLowerCase().includes(kw)
      );

      if (isChatbotRequest || recentSession) {
        const axios = require('axios');
        const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || 'http://localhost:8000';

        try {
          const ragResponse = await axios.post(`${RAG_SERVICE_URL}/chat`, {
            message: text,
            contact_id: dbContact.id
          });

          await whatsappService.sendMessage(phone, ragResponse.data.response);

          logger.info('Chatbot response sent', {
            contactId: dbContact.id,
            confidence: ragResponse.data.confidence
          });
        } catch (ragError) {
          logger.error('Error getting RAG response', { error: ragError.message });
          await whatsappService.sendMessage(
            phone,
            'Désolé, je ne peux pas traiter votre demande pour le moment. Veuillez contacter le service client au 0770 12 34 56.'
          );
        }
      }
    }
  } catch (error) {
    logger.error('Error handling incoming message', { error: error.message });
  }
}

// ============================================
// Gestionnaire: Mise à jour de statut WhatsApp
// statuses: sent, delivered, read, failed
// ============================================
async function handleStatusUpdate(status) {
  try {
    const externalId = status.id;
    const waStatus = status.status;

    const statusMap = {
      'sent': 'SENT',
      'delivered': 'DELIVERED',
      'read': 'READ',
      'failed': 'FAILED'
    };

    const dbStatus = statusMap[waStatus];
    if (!dbStatus) return;

    const dbMessage = await prisma.message.findFirst({
      where: { externalId }
    });

    if (!dbMessage) return;

    const updateData = { status: dbStatus };
    if (dbStatus === 'DELIVERED') updateData.deliveredAt = new Date();
    if (dbStatus === 'READ') updateData.readAt = new Date();
    if (dbStatus === 'FAILED') {
      updateData.failedAt = new Date();
      updateData.error = status.errors?.[0]?.message || 'Unknown error';
    }

    await prisma.message.update({
      where: { id: dbMessage.id },
      data: updateData
    });

    // Mettre à jour les statistiques de la campagne
    if (dbMessage.campaignId) {
      const campaignUpdate = {};
      if (dbStatus === 'DELIVERED') campaignUpdate.delivered = { increment: 1 };
      if (dbStatus === 'READ') campaignUpdate.read = { increment: 1 };
      if (dbStatus === 'FAILED') campaignUpdate.failed = { increment: 1 };

      if (Object.keys(campaignUpdate).length > 0) {
        await prisma.campaign.update({
          where: { id: dbMessage.campaignId },
          data: campaignUpdate
        });
      }
    }

    logger.info('Message status updated', { externalId, status: dbStatus });
  } catch (error) {
    logger.error('Error updating message status', { error: error.message });
  }
}

// ============================================
// GET /webhooks/health - Health check
// ============================================
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'webhooks',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
